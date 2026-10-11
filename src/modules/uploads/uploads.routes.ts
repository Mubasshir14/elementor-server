import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ProjectRole, UploadStatus } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { storage } from "../../infrastructure/storage/local.js";
import { ScanSemaphore } from "../../infrastructure/storage/scan-semaphore.js";
import { HttpError } from "../../middleware/errors.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { inspectReactProjectZip } from "./react-project-inspection.js";
import { inspectFigmaFileJson } from "./figma-file-inspection.js";
import { parseNativeFigFile } from "./fig-native.js";
import { figmaSnapshotStorageKey } from "./figma-import.js";

export const uploadsRouter = Router();
const scanSemaphore = new ScanSemaphore(2);

const initSchema = z.object({
  sourceType: z.enum(["react-next-zip", "figma", "framer", "screenshot"]),
  fileName: z.string().trim().min(1).max(180),
  contentType: z.enum(["application/zip", "application/x-zip-compressed", "application/json", "application/octet-stream"]),
  sizeBytes: z.number().int().positive().max(env.UPLOAD_MAX_BYTES),
}).strict();
const extensionTypes: Record<string, string[]> = {
  zip: ["application/zip", "application/x-zip-compressed"],
  json: ["application/json"],
  fig: ["application/octet-stream", "application/json"],
};
const uploadableSourceTypes = new Set(["react-next-zip", "figma"]);

uploadsRouter.post("/projects/:projectId/uploads", async (req, res) => {
  const body = initSchema.parse(req.body);
  const projectId = z.string().cuid().parse(req.params.projectId);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, [ProjectRole.OWNER, ProjectRole.EDITOR]);
  if (!uploadableSourceTypes.has(body.sourceType)) {
    throw new HttpError(
      501,
      "SOURCE_IMPORT_UNAVAILABLE",
      "This source type cannot be uploaded yet because its validated import adapter is not implemented.",
    );
  }
  if (/[\\/]/.test(body.fileName) || body.fileName === "." || body.fileName === "..") {
    throw new HttpError(400, "INVALID_FILE_NAME", "File name must not contain a path");
  }
  const extension = body.fileName.split(".").pop()?.toLowerCase() ?? "";
  // Figma accepts native `.fig` or a REST API file JSON `.json` export; the ZIP
  // source accepts only `.zip`.
  const expectedExtensions = body.sourceType === "figma" ? ["fig", "json"] : ["zip"];
  if (!expectedExtensions.includes(extension) || !extensionTypes[extension]?.includes(body.contentType)) {
    throw new HttpError(400, "FILE_TYPE_MISMATCH", "File extension and content type do not match the selected source type");
  }
  const id = randomUUID();
  const storageKey = `uploads/${projectId}/${id}.${extension}`;
  const sourceType = body.sourceType === "figma" ? "FIGMA" : "REACT_NEXT_ZIP";
  const upload = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "Project" WHERE "id" = ${projectId} FOR UPDATE`;
    const aggregate = await tx.upload.aggregate({
      where: { projectId, status: { not: UploadStatus.DELETED } },
      _sum: { sizeBytes: true },
    });
    const usedBytes = aggregate._sum.sizeBytes ?? 0n;
    if (usedBytes + BigInt(body.sizeBytes) > BigInt(env.UPLOAD_QUOTA_BYTES)) {
      throw new HttpError(413, "UPLOAD_QUOTA_EXCEEDED", "Project upload quota would be exceeded");
    }
    return tx.upload.create({
      data: {
        id,
        projectId,
        createdById: userId,
        storageKey,
        fileName: body.fileName,
        contentType: body.contentType,
        sourceType,
        sizeBytes: BigInt(body.sizeBytes),
      },
      select: { id: true, fileName: true, contentType: true, sizeBytes: true, status: true },
    });
  });
  res.status(201).json({
    upload: { ...upload, sizeBytes: upload.sizeBytes.toString() },
    contentUrl: `/api/v1/uploads/${upload.id}/content`,
  });
});

uploadsRouter.put("/uploads/:uploadId/content", async (req, res) => {
  const id = z.string().uuid().parse(req.params.uploadId);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload was not found");
  await requireProjectRole(upload.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  if (upload.status !== UploadStatus.PENDING) {
    throw new HttpError(409, "UPLOAD_NOT_PENDING", "Upload is not awaiting content");
  }
  if (!req.is(upload.contentType)) {
    throw new HttpError(415, "UPLOAD_CONTENT_TYPE_MISMATCH", "Request content type does not match the upload reservation");
  }
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > env.UPLOAD_MAX_BYTES) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", "Upload exceeds the configured file size limit");
  }
  if (contentLength !== undefined && Number(contentLength) !== Number(upload.sizeBytes)) {
    throw new HttpError(400, "UPLOAD_SIZE_MISMATCH", "Request size does not match the upload reservation");
  }
  const stored = await storage.write(upload.storageKey, req, Number(upload.sizeBytes));
  if (stored.sizeBytes !== Number(upload.sizeBytes)) {
    await storage.delete(upload.storageKey);
    await prisma.upload.update({
      where: { id },
      data: { status: UploadStatus.REJECTED, rejection: "Uploaded size did not match its reservation" },
    });
    throw new HttpError(400, "UPLOAD_SIZE_MISMATCH", "Uploaded content does not match its reserved size");
  }
  res.status(204).end();
});

uploadsRouter.post("/uploads/:uploadId/complete", async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const id = z.string().uuid().parse(req.params.uploadId);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload was not found");
  await requireProjectRole(upload.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  if (upload.status !== UploadStatus.PENDING) {
    throw new HttpError(409, "UPLOAD_NOT_PENDING", "Upload is not awaiting completion");
  }
  const stored = await storage.stat(upload.storageKey);
  if (!stored) throw new HttpError(400, "UPLOAD_CONTENT_MISSING", "Upload content has not been received");
  if (stored.sizeBytes !== Number(upload.sizeBytes)) {
    await prisma.upload.update({
      where: { id },
      data: { status: UploadStatus.REJECTED, rejection: "Stored file size did not match its reservation" },
    });
    throw new HttpError(400, "UPLOAD_SIZE_MISMATCH", "Stored file does not match its reservation");
  }

  const releaseScan = scanSemaphore.acquire();
  if (!releaseScan) throw new HttpError(429, "UPLOAD_SCAN_BUSY", "Upload inspection capacity is temporarily full");
  try {
    const bytes = await storage.readFile(upload.storageKey);
    const extension = upload.fileName.split(".").pop()?.toLowerCase() ?? "";

    if (upload.sourceType === "FIGMA") {
      if (extension !== "json" && extension !== "fig") {
        await prisma.upload.update({
          where: { id },
          data: { status: UploadStatus.REJECTED, rejection: "Unsupported source type or file extension" },
        });
        throw new HttpError(400, "UNSUPPORTED_SOURCE_FORMAT", "This upload requires a native Figma .fig file or a Figma REST API file JSON export (.json).");
      }

      const isNative = extension === "fig";
      let sha256: string;
      let fileName: string;
      let summary: Record<string, unknown>;
      let structure: unknown;
      let format: string;
      let diagnostics: Array<{ code: string; message: string }>;
      let document: unknown = null;

      try {
        if (isNative) {
          const parsed = parseNativeFigFile(bytes, upload.fileName);
          sha256 = parsed.sha256;
          fileName = parsed.document.fileName;
          summary = {
            name: parsed.document.fileName,
            pageCount: parsed.document.pages.length,
            nodeCount: parsed.document.nodeCount,
            componentCount: parsed.document.componentCount,
            instanceCount: parsed.document.instanceCount,
            figVersion: parsed.document.version,
          };
          structure = parsed.document.pages;
          document = parsed.document;
          format = "figma-native-fig";
          diagnostics = [
            { code: "FIGMA_NATIVE_PARSED_LOCALLY", message: "The native .fig file was parsed locally from the embedded Kiwi schema and node tree. No Figma account, OAuth, or remote API was contacted." },
            ...parsed.document.diagnostics.map((d) => ({ code: d.code, message: d.message })),
          ];
        } else {
          const inspection = inspectFigmaFileJson(bytes);
          sha256 = inspection.sha256;
          fileName = inspection.summary.name || upload.fileName;
          summary = { ...inspection.summary };
          structure = inspection.structure;
          format = "figma-rest-file-json";
          diagnostics = [
            { code: "FIGMA_FILE_PARSED_LOCALLY", message: "The Figma design file was parsed locally from the uploaded REST API JSON export. No Figma account or remote API was contacted." },
          ];
        }
      } catch (error) {
        await prisma.upload.update({
          where: { id },
          data: {
            status: UploadStatus.REJECTED,
            rejection: error instanceof HttpError ? error.code : "Figma file could not be parsed",
          },
        });
        throw error;
      }

      const snapshotKey = figmaSnapshotStorageKey(upload.projectId, sha256);
      const snapshot = JSON.stringify({
        kind: "FIGMA_FILE",
        method: isNative ? "native-fig-upload" : "rest-json-upload",
        fileName: upload.fileName,
        importedAt: new Date().toISOString(),
        summary,
        structure,
        document,
      });
      await storage.write(snapshotKey, Readable.from([snapshot]), Buffer.byteLength(snapshot, "utf8"));
      const sourceImport = await prisma.sourceImport.create({
        data: {
          projectId: upload.projectId,
          createdById: upload.createdById,
          kind: "FIGMA_FILE",
          status: "READY",
          fileName,
          snapshotKey,
          summary: { ...summary, structure } as never,
          diagnostics: [...diagnostics, { code: "CONVERSION_UNAVAILABLE", message: "Conversion remains disabled until the approved DIR and Elementor compiler are available." }] as never,
        },
        select: { id: true, kind: true, status: true, fileName: true, summary: true, diagnostics: true, createdAt: true, updatedAt: true },
      });
      const completed = await prisma.upload.update({
        where: { id },
        data: {
          status: UploadStatus.READY,
          sha256,
          sourceImportId: sourceImport.id,
          validation: { format, ...summary } as never,
          completedAt: new Date(),
        },
        select: { id: true, sourceType: true, status: true, sha256: true, completedAt: true },
      });
      res.json({ upload: completed, sourceImport });
      return;
    }

    if (upload.sourceType !== "REACT_NEXT_ZIP" || extension !== "zip") {
      await prisma.upload.update({
        where: { id },
        data: { status: UploadStatus.REJECTED, rejection: "Unsupported source type or file extension" },
      });
      throw new HttpError(400, "UNSUPPORTED_SOURCE_FORMAT", "This upload requires a React or Next.js project ZIP.");
    }
    let inspection: Awaited<ReturnType<typeof inspectReactProjectZip>>;
    try {
      inspection = await inspectReactProjectZip(bytes);
    } catch (error) {
      await prisma.upload.update({
        where: { id },
        data: {
          status: UploadStatus.REJECTED,
          rejection: error instanceof HttpError ? error.code : "Project archive could not be inspected",
        },
      });
      throw error;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const completed = await prisma.upload.update({
      where: { id },
      data: {
        status: UploadStatus.READY,
        sha256,
        detectedFramework: inspection.detectedFramework,
        completedAt: new Date(),
      },
      select: { id: true, sourceType: true, detectedFramework: true, status: true, sha256: true, completedAt: true },
    });
    res.json({ upload: completed });
  } finally {
    releaseScan();
  }
});
