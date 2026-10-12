import { Readable } from "node:stream";
import { UploadStatus } from "../../generated/prisma/client.js";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { storage } from "../storage/storage.service.js";
import {
  detectNativeFigmaFile,
  figmaSnapshotStorageKey,
  inspectFigmaFileJson,
  parseNativeFigFile,
} from "./figma.parser.js";

export async function processFigmaUploadCompletion(params: {
  uploadId: string;
  projectId: string;
  createdById: string;
  fileName: string;
  contentType: string;
  bytes: Buffer;
}) {
  const extension = params.fileName.split(".").pop()?.toLowerCase() ?? "";
  if (extension !== "json" && extension !== "fig") {
    await prisma.upload.update({
      where: { id: params.uploadId },
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

  const signature = detectNativeFigmaFile(params.bytes);
  const reservedType = params.contentType ?? "";
  if (reservedType === "application/octet-stream" && signature !== "fig") {
    await prisma.upload.update({
      where: { id: params.uploadId },
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
      where: { id: params.uploadId },
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
      const parsed = parseNativeFigFile(params.bytes, params.fileName);
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
      const inspection = inspectFigmaFileJson(params.bytes);
      sha256 = inspection.sha256;
      fileName = inspection.summary.name || params.fileName;
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
      where: { id: params.uploadId },
      data: {
        status: UploadStatus.REJECTED,
        rejection: error instanceof HttpError ? error.code : "Figma file could not be parsed",
      },
    });
    throw error;
  }

  const snapshotKey = figmaSnapshotStorageKey(params.projectId, sha256);
  const snapshot = JSON.stringify({
    kind: "FIGMA_FILE",
    method: isNative ? "native-fig-upload" : "rest-json-upload",
    fileName: params.fileName,
    importedAt: new Date().toISOString(),
    summary,
    structure,
    document,
  });
  await storage.write(snapshotKey, Readable.from([snapshot]), Buffer.byteLength(snapshot, "utf8"));

  try {
    const sourceImport = await prisma.sourceImport.create({
      data: {
        projectId: params.projectId,
        createdById: params.createdById,
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
      where: { id: params.uploadId },
      data: {
        status: UploadStatus.READY,
        sha256,
        sourceImportId: sourceImport.id,
        validation: { format, ...summary } as never,
        completedAt: new Date(),
      },
      select: { id: true, sourceType: true, status: true, sha256: true, completedAt: true },
    });

    return { upload: completed, sourceImport };
  } catch (error) {
    await storage.deleteObject(snapshotKey).catch(() => undefined);
    throw error;
  }
}

export async function listFigmaImportsForProject(params: { projectId: string }) {
  return prisma.sourceImport.findMany({
    where: {
      projectId: params.projectId,
      kind: "FIGMA_FILE",
    },
    orderBy: { createdAt: "desc" },
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
}

export async function getFigmaImportDetail(params: { projectId: string; importId: string }) {
  const sourceImport = await prisma.sourceImport.findFirst({
    where: {
      id: params.importId,
      projectId: params.projectId,
      kind: "FIGMA_FILE",
    },
  });
  if (!sourceImport) {
    throw new HttpError(404, "SOURCE_IMPORT_NOT_FOUND", "Figma import was not found");
  }
  const parsedSnapshot = sourceImport.snapshotKey
    ? (JSON.parse((await storage.getObject(sourceImport.snapshotKey)).toString("utf8")) as unknown)
    : null;
  return {
    sourceImport: {
      id: sourceImport.id,
      kind: sourceImport.kind,
      status: sourceImport.status,
      fileName: sourceImport.fileName,
      summary: sourceImport.summary,
      diagnostics: sourceImport.diagnostics,
      createdAt: sourceImport.createdAt,
      updatedAt: sourceImport.updatedAt,
    },
    snapshot: parsedSnapshot,
  };
}

