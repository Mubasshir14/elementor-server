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
import {
  analyzeReactNextProjectZip,
  persistReactNextImport,
} from "./react-project-inspection.js";
import { inspectFigmaFileJson, detectNativeFigmaFile } from "./figma-file-inspection.js";
import { parseNativeFigFile } from "./fig-native.js";
import { figmaSnapshotStorageKey } from "./figma-import.js";

export const uploadsRouter = Router();
const scanSemaphore = new ScanSemaphore(2);

const MULTIPART_THRESHOLD_BYTES = 10 * 1024 * 1024;
const DEFAULT_PART_SIZE_BYTES = 8 * 1024 * 1024;
const MAX_PART_SIZE_BYTES = 64 * 1024 * 1024;
const UPLOAD_RESERVATION_TTL_MS = 2 * 60 * 60 * 1000;

const initSchema = z
  .object({
    sourceType: z.enum(["react-next-zip", "figma", "framer", "screenshot"]),
    fileName: z.string().trim().min(1).max(180),
    contentType: z.enum([
      "application/zip",
      "application/x-zip-compressed",
      "application/json",
      "application/octet-stream",
    ]),
    sizeBytes: z.number().int().positive().max(env.UPLOAD_MAX_BYTES),
  })
  .strict();

const multipartPartUrlSchema = z
  .object({
    partNumber: z.number().int().min(1).max(10_000),
    contentLength: z.number().int().positive().max(MAX_PART_SIZE_BYTES).optional(),
  })
  .strict();

const multipartCompleteSchema = z
  .object({
    parts: z
      .array(
        z
          .object({
            partNumber: z.number().int().min(1).max(10_000),
            etag: z.string().trim().min(1).max(256),
          })
          .strict(),
      )
      .min(1)
      .max(10_000),
  })
  .strict();

const extensionTypes: Record<string, string[]> = {
  zip: ["application/zip", "application/x-zip-compressed"],
  json: ["application/json"],
  fig: ["application/octet-stream"],
};
const uploadableSourceTypes = new Set(["react-next-zip", "figma"]);

export async function cleanupExpiredMultipartUploads(now = new Date()): Promise<number> {
  const expiredUploads = await prisma.upload.findMany({
    where: {
      status: UploadStatus.PENDING,
      expiresAt: { lt: now },
    },
    select: {
      id: true,
      storageKey: true,
      multipartUploadId: true,
    },
    take: 50,
  });

  let cleaned = 0;
  for (const exp of expiredUploads) {
    if (exp.multipartUploadId) {
      await storage.abortMultipartUpload(exp.storageKey, exp.multipartUploadId).catch(() => undefined);
    }
    await storage.deleteObject(exp.storageKey).catch(() => undefined);
    await prisma.upload
      .update({
        where: { id: exp.id },
        data: {
          status: UploadStatus.REJECTED,
          multipartUploadId: null,
          rejection: "Upload reservation expired before completion",
        },
      })
      .catch(() => undefined);
    cleaned += 1;
  }
  return cleaned;
}

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
  const expectedExtensions = body.sourceType === "figma" ? ["fig", "json"] : ["zip"];
  if (
    !expectedExtensions.includes(extension) ||
    !extensionTypes[extension]?.includes(body.contentType)
  ) {
    throw new HttpError(
      400,
      "FILE_TYPE_MISMATCH",
      "File extension and content type do not match the selected source type",
    );
  }
  const id = randomUUID();
  const storageKey = `uploads/${projectId}/${id}.${extension}`;
  const sourceType = body.sourceType === "figma" ? "FIGMA" : "REACT_NEXT_ZIP";
  const expiresAt = new Date(Date.now() + UPLOAD_RESERVATION_TTL_MS);

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
        expiresAt,
      },
      select: {
        id: true,
        sourceType: true,
        fileName: true,
        contentType: true,
        sizeBytes: true,
        status: true,
      },
    });
  });

  const uploadStrategy =
    body.sizeBytes > MULTIPART_THRESHOLD_BYTES ? "multipart" : "direct";

  let presignedPut: Awaited<ReturnType<typeof storage.createPresignedUploadUrl>> | null = null;
  if (uploadStrategy === "direct") {
    presignedPut = await storage
      .createPresignedUploadUrl(storageKey, {
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
      })
      .catch(() => null);
  }

  res.status(201).json({
    upload: { ...upload, sizeBytes: upload.sizeBytes.toString() },
    contentUrl: `/api/v1/uploads/${upload.id}/content`,
    uploadStrategy,
    multipartPartSizeBytes: DEFAULT_PART_SIZE_BYTES,
    ...(presignedPut ? { presignedPutUrl: presignedPut.url } : {}),
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
  if (Number(upload.sizeBytes) > MULTIPART_THRESHOLD_BYTES) {
    throw new HttpError(
      400,
      "MULTIPART_UPLOAD_REQUIRED",
      "Files larger than 10 MiB must be uploaded using the multipart upload workflow",
    );
  }
  if (!req.is(upload.contentType)) {
    throw new HttpError(
      415,
      "UPLOAD_CONTENT_TYPE_MISMATCH",
      "Request content type does not match the upload reservation",
    );
  }
  const contentLength = req.headers["content-length"];
  if (contentLength !== undefined && Number(contentLength) > env.UPLOAD_MAX_BYTES) {
    throw new HttpError(413, "UPLOAD_TOO_LARGE", "Upload exceeds the configured file size limit");
  }
  if (contentLength !== undefined && Number(contentLength) !== Number(upload.sizeBytes)) {
    throw new HttpError(
      400,
      "UPLOAD_SIZE_MISMATCH",
      "Request size does not match the upload reservation",
    );
  }
  const stored = await storage.write(upload.storageKey, req, Number(upload.sizeBytes));
  if (stored.sizeBytes !== Number(upload.sizeBytes)) {
    await storage.delete(upload.storageKey);
    await prisma.upload.update({
      where: { id },
      data: {
        status: UploadStatus.REJECTED,
        rejection: "Uploaded size did not match its reservation",
      },
    });
    throw new HttpError(
      400,
      "UPLOAD_SIZE_MISMATCH",
      "Uploaded content does not match its reserved size",
    );
  }
  res.status(204).end();
});

uploadsRouter.post("/uploads/:uploadId/multipart/init", async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
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

  if (upload.multipartUploadId) {
    res.status(200).json({
      uploadId: upload.id,
      multipartUploadId: upload.multipartUploadId,
      partSizeBytes: DEFAULT_PART_SIZE_BYTES,
    });
    return;
  }

  const created = await storage.createMultipartUpload(upload.storageKey, {
    contentType: upload.contentType,
  });

  await prisma.upload.update({
    where: { id: upload.id },
    data: {
      multipartUploadId: created.uploadId,
      expiresAt: new Date(Date.now() + UPLOAD_RESERVATION_TTL_MS),
    },
  });

  res.status(201).json({
    uploadId: upload.id,
    multipartUploadId: created.uploadId,
    partSizeBytes: DEFAULT_PART_SIZE_BYTES,
  });
});

uploadsRouter.post("/uploads/:uploadId/multipart/part-url", async (req, res) => {
  const body = multipartPartUrlSchema.parse(req.body ?? {});
  const id = z.string().uuid().parse(req.params.uploadId);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload was not found");
  await requireProjectRole(upload.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  if (upload.status !== UploadStatus.PENDING || !upload.multipartUploadId) {
    throw new HttpError(
      409,
      "MULTIPART_UPLOAD_NOT_INITIALIZED",
      "Multipart upload has not been initialized for this upload reservation",
    );
  }

  const presigned = await storage.createPresignedPartUpload(
    upload.storageKey,
    upload.multipartUploadId,
    body.partNumber,
    { contentLength: body.contentLength },
  );

  res.status(200).json({
    uploadId: upload.id,
    partNumber: presigned.partNumber,
    url: presigned.url,
    expiresInSeconds: presigned.expiresInSeconds,
    directPartPath: `/api/v1/uploads/${upload.id}/multipart/parts/${body.partNumber}`,
  });
});

uploadsRouter.put("/uploads/:uploadId/multipart/parts/:partNumber", async (req, res) => {
  const id = z.string().uuid().parse(req.params.uploadId);
  const partNumber = z.coerce.number().int().min(1).max(10_000).parse(req.params.partNumber);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload was not found");
  await requireProjectRole(upload.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  if (upload.status !== UploadStatus.PENDING || !upload.multipartUploadId) {
    throw new HttpError(
      409,
      "MULTIPART_UPLOAD_NOT_INITIALIZED",
      "Multipart upload has not been initialized for this upload reservation",
    );
  }
  if (storage.provider === "b2") {
    throw new HttpError(
      400,
      "DIRECT_PRESIGNED_UPLOAD_REQUIRED",
      "When Backblaze B2 storage is active, multipart parts must be uploaded directly to the presigned part URL rather than proxied through the API server",
    );
  }

  const maxPartBytes = Math.min(Number(upload.sizeBytes), MAX_PART_SIZE_BYTES);
  const uploadedPart = await storage.uploadPart(
    upload.storageKey,
    upload.multipartUploadId,
    partNumber,
    req,
    maxPartBytes,
  );

  res.setHeader("ETag", uploadedPart.etag);
  res.status(200).json({
    uploadId: upload.id,
    partNumber: uploadedPart.partNumber,
    etag: uploadedPart.etag,
    sizeBytes: uploadedPart.sizeBytes,
  });
});

uploadsRouter.post("/uploads/:uploadId/multipart/complete", async (req, res) => {
  const body = multipartCompleteSchema.parse(req.body ?? {});
  const id = z.string().uuid().parse(req.params.uploadId);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload was not found");
  await requireProjectRole(upload.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  if (upload.status !== UploadStatus.PENDING || !upload.multipartUploadId) {
    throw new HttpError(
      409,
      "MULTIPART_UPLOAD_NOT_INITIALIZED",
      "Multipart upload has not been initialized for this upload reservation",
    );
  }

  for (let i = 1; i < body.parts.length; i += 1) {
    if (body.parts[i]!.partNumber <= body.parts[i - 1]!.partNumber) {
      throw new HttpError(
        400,
        "MULTIPART_INVALID_PART_ORDER",
        "Multipart parts must be provided in strictly ascending partNumber order without duplicates",
      );
    }
  }

  try {
    const metadata = await storage.completeMultipartUpload(
      upload.storageKey,
      upload.multipartUploadId,
      body.parts,
    );
    if (metadata.sizeBytes !== Number(upload.sizeBytes)) {
      await storage.deleteObject(upload.storageKey).catch(() => undefined);
      await prisma.upload.update({
        where: { id: upload.id },
        data: {
          status: UploadStatus.REJECTED,
          multipartUploadId: null,
          rejection: "Assembled multipart size did not match its reservation",
        },
      });
      throw new HttpError(
        400,
        "UPLOAD_SIZE_MISMATCH",
        "Assembled multipart upload size does not match the reserved size",
      );
    }

    await prisma.upload.update({
      where: { id: upload.id },
      data: { multipartUploadId: null },
    });

    res.status(200).json({
      uploadId: upload.id,
      sizeBytes: metadata.sizeBytes,
      etag: metadata.etag,
    });
  } catch (error) {
    if (upload.multipartUploadId) {
      await storage
        .abortMultipartUpload(upload.storageKey, upload.multipartUploadId)
        .catch(() => undefined);
    }
    throw error;
  }
});

uploadsRouter.post("/uploads/:uploadId/multipart/abort", async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const id = z.string().uuid().parse(req.params.uploadId);
  const upload = await prisma.upload.findUnique({ where: { id } });
  if (!upload) throw new HttpError(404, "UPLOAD_NOT_FOUND", "Upload was not found");
  await requireProjectRole(upload.projectId, authenticatedUserId(req), [
    ProjectRole.OWNER,
    ProjectRole.EDITOR,
  ]);
  if (upload.status !== UploadStatus.PENDING) {
    throw new HttpError(409, "UPLOAD_NOT_PENDING", "Upload can no longer be aborted");
  }

  if (upload.multipartUploadId) {
    await storage
      .abortMultipartUpload(upload.storageKey, upload.multipartUploadId)
      .catch(() => undefined);
  }
  await storage.deleteObject(upload.storageKey).catch(() => undefined);

  await prisma.upload.update({
    where: { id: upload.id },
    data: {
      status: UploadStatus.REJECTED,
      multipartUploadId: null,
      rejection: "Upload aborted by user",
    },
  });

  res.status(200).json({ uploadId: upload.id, status: "ABORTED" });
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
    await storage.deleteObject(upload.storageKey).catch(() => undefined);
    await prisma.upload.update({
      where: { id },
      data: {
        status: UploadStatus.REJECTED,
        rejection: "Stored file size did not match its reservation",
      },
    });
    throw new HttpError(400, "UPLOAD_SIZE_MISMATCH", "Stored file does not match its reservation");
  }

  const releaseScan = scanSemaphore.acquire();
  if (!releaseScan) {
    throw new HttpError(429, "UPLOAD_SCAN_BUSY", "Upload inspection capacity is temporarily full");
  }
  try {
    const bytes = await storage.readFile(upload.storageKey);
    const extension = upload.fileName.split(".").pop()?.toLowerCase() ?? "";

    if (upload.sourceType === "FIGMA") {
      if (extension !== "json" && extension !== "fig") {
        await prisma.upload.update({
          where: { id },
          data: {
            status: UploadStatus.REJECTED,
            rejection: "Unsupported source type or file extension",
          },
        });
        throw new HttpError(
          400,
          "UNSUPPORTED_SOURCE_FORMAT",
          "This upload requires a native Figma .fig file or a Figma REST API file JSON export (.json).",
        );
      }

      const signature = detectNativeFigmaFile(bytes);
      const reservedType = upload.contentType ?? "";
      if (reservedType === "application/octet-stream" && signature !== "fig") {
        await prisma.upload.update({
          where: { id },
          data: {
            status: UploadStatus.REJECTED,
            rejection: "Uploaded bytes are not a native .fig archive",
          },
        });
        throw new HttpError(
          415,
          "FIG_NATIVE_SIGNATURE_MISMATCH",
          "The uploaded bytes do not have a native .fig file signature (ZIP with canvas.fig or Kiwi binary). Upload an actual native .fig file exported from Figma (File → Save local copy).",
        );
      }
      if (reservedType === "application/json" && signature === "fig") {
        await prisma.upload.update({
          where: { id },
          data: {
            status: UploadStatus.REJECTED,
            rejection: "Native .fig bytes reserved as JSON",
          },
        });
        throw new HttpError(
          415,
          "FIGMA_NATIVE_FILE_UNSUPPORTED",
          "That looks like a native .fig file reserved with a .json name. Reserve the upload with the .fig filename and the binary content type so it goes through the native Figma parser.",
        );
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
            {
              code: "FIGMA_NATIVE_PARSED_LOCALLY",
              message:
                "The native .fig file was parsed locally from the embedded Kiwi schema and node tree. No Figma account, OAuth, or remote API was contacted.",
            },
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
            {
              code: "FIGMA_FILE_PARSED_LOCALLY",
              message:
                "The Figma design file was parsed locally from the uploaded REST API JSON export. No Figma account or remote API was contacted.",
            },
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
      await storage.write(
        snapshotKey,
        Readable.from([snapshot]),
        Buffer.byteLength(snapshot, "utf8"),
      );
      try {
        const sourceImport = await prisma.sourceImport.create({
          data: {
            projectId: upload.projectId,
            createdById: upload.createdById,
            kind: "FIGMA_FILE",
            status: "READY",
            fileName,
            snapshotKey,
            summary: { ...summary, structure } as never,
            diagnostics: diagnostics as never,
          },
          select: {
            id: true,
            kind: true,
            status: true,
            fileName: true,
            summary: true,
            diagnostics: true,
            createdAt: true,
            updatedAt: true,
          },
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
          select: {
            id: true,
            sourceType: true,
            sourceImportId: true,
            status: true,
            sha256: true,
            completedAt: true,
          },
        });
        res.json({ upload: completed, sourceImport });
        return;
      } catch (error) {
        await storage.deleteObject(snapshotKey).catch(() => undefined);
        throw error;
      }
    }

    if (upload.sourceType !== "REACT_NEXT_ZIP" || extension !== "zip") {
      await prisma.upload.update({
        where: { id },
        data: {
          status: UploadStatus.REJECTED,
          rejection: "Unsupported source type or file extension",
        },
      });
      throw new HttpError(
        400,
        "UNSUPPORTED_SOURCE_FORMAT",
        "This upload requires a React or Next.js project ZIP.",
      );
    }

    let analysis: Awaited<ReturnType<typeof analyzeReactNextProjectZip>>;
    try {
      analysis = await analyzeReactNextProjectZip(bytes);
    } catch (error) {
      await prisma.upload.update({
        where: { id },
        data: {
          status: UploadStatus.REJECTED,
          rejection:
            error instanceof HttpError ? error.code : "Project archive could not be inspected",
        },
      });
      throw error;
    }

    const sha256 = createHash("sha256").update(bytes).digest("hex");
    let sourceImport:
      | Awaited<ReturnType<typeof persistReactNextImport>>["sourceImport"]
      | undefined;
    try {
      const persisted = await persistReactNextImport({
        projectId: upload.projectId,
        userId: upload.createdById ?? authenticatedUserId(req),
        uploadId: upload.id,
        fileName: upload.fileName,
        snapshot: analysis.snapshot,
      });
      sourceImport = persisted.sourceImport;
    } catch {
      sourceImport = undefined;
    }

    const completed = await prisma.upload.update({
      where: { id },
      data: {
        status: UploadStatus.READY,
        sha256,
        detectedFramework: analysis.inspection.detectedFramework,
        ...(sourceImport ? { sourceImportId: sourceImport.id } : {}),
        validation: {
          detectedFramework: analysis.inspection.detectedFramework,
          routerConvention: analysis.snapshot.routerConvention,
          packageRoot: analysis.inspection.packageRoot,
          packageName: analysis.snapshot.packageInfo.name,
          sourceFileCount: analysis.inspection.sourceFileCount,
          routeCount: analysis.snapshot.stats.routeCount,
          componentCount: analysis.snapshot.stats.componentCount,
          styleFileCount: analysis.snapshot.stats.styleFileCount,
          assetCount: analysis.snapshot.stats.assetCount,
        } as never,
        completedAt: new Date(),
      },
      select: {
        id: true,
        sourceType: true,
        detectedFramework: true,
        sourceImportId: true,
        validation: true,
        status: true,
        sha256: true,
        completedAt: true,
      },
    });
    res.json({ upload: completed, ...(sourceImport ? { sourceImport } : {}) });
  } finally {
    releaseScan();
  }
});
