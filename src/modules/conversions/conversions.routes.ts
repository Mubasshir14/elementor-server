import { Prisma, ProjectRole, StageStatus, UploadStatus } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { conversionSettingsBaseSchema } from "../capabilities/capabilities.schema.js";

export const conversionsRouter = Router();

const createSchema = conversionSettingsBaseSchema.extend({
  uploadId: z.string().uuid().optional(),
  idempotencyKey: z.string().trim().min(8).max(128),
}).strict().superRefine((value, context) => {
  if (value.sourceType === "react-next-zip" && !value.uploadId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["uploadId"],
      message: "React/Next.js conversions require a validated upload reference",
    });
  }
});
const conversionIdSchema = z.string().cuid();

async function authorizedConversion(id: string, userId: string) {
  const conversion = await prisma.conversionJob.findUnique({
    where: { id },
    include: {
      ruleVersions: {
        select: {
          ruleVersion: { select: { fileName: true, version: true, sha256: true } },
        },
      },
    },
  });
  if (!conversion) throw new HttpError(404, "CONVERSION_NOT_FOUND", "Conversion was not found");
  await requireProjectRole(conversion.projectId, userId, Object.values(ProjectRole));
  return conversion;
}

conversionsRouter.post("/projects/:projectId/conversions", async (req, res) => {
  const body = createSchema.parse(req.body);
  const projectId = z.string().cuid().parse(req.params.projectId);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, [ProjectRole.OWNER, ProjectRole.EDITOR]);
  if (body.sourceType === "react-next-zip") {
    if (!body.uploadId) {
      throw new HttpError(400, "UPLOAD_NOT_READY", "Conversion requires a ready upload in this project");
    }
    const upload = await prisma.upload.findFirst({
      where: { id: body.uploadId, projectId, status: UploadStatus.READY },
      select: { id: true, sourceType: true, detectedFramework: true },
    });
    if (!upload) throw new HttpError(400, "UPLOAD_NOT_READY", "Conversion requires a ready upload in this project");
    if (
      upload.sourceType.toLowerCase().replaceAll("_", "-") !== body.sourceType ||
      body.detectedFramework !== upload.detectedFramework
    ) {
      throw new HttpError(400, "UPLOAD_SOURCE_MISMATCH", "Conversion source settings must match the validated upload.");
    }
  } else {
    if (!body.sourceImportId) {
      throw new HttpError(400, "SOURCE_IMPORT_REQUIRED", "Figma and Framer conversions require a validated source import reference");
    }
    const sourceImport = await prisma.sourceImport.findFirst({
      where: { id: body.sourceImportId, projectId, status: "READY" },
      select: { id: true, kind: true },
    });
    if (!sourceImport) {
      throw new HttpError(400, "SOURCE_IMPORT_NOT_READY", "Conversion requires a ready Figma or Framer import in this project");
    }
    const expectedKind = body.sourceType === "figma" ? "FIGMA_FILE" : "FRAMER_SITE";
    if (sourceImport.kind !== expectedKind) {
      throw new HttpError(400, "SOURCE_IMPORT_MISMATCH", "Conversion source settings must match the validated import.");
    }
    if (body.uploadId) {
      const upload = await prisma.upload.findFirst({
        where: { id: body.uploadId, projectId, sourceImportId: sourceImport.id, status: UploadStatus.READY },
        select: { id: true },
      });
      if (!upload) {
        throw new HttpError(400, "UPLOAD_SOURCE_MISMATCH", "The upload reference must belong to the validated source import.");
      }
    }
  }
  throw new HttpError(
    501,
    "CONVERSION_PIPELINE_UNAVAILABLE",
    "The approved DIR schema and Elementor compiler are not available. No conversion job was created.",
  );
});

conversionsRouter.get("/conversions/:conversionId", async (req, res) => {
  const id = conversionIdSchema.parse(req.params.conversionId);
  const conversion = await authorizedConversion(id, authenticatedUserId(req));
  res.json({
    conversion: {
      id: conversion.id,
      status: conversion.status,
      errorCode: conversion.errorCode,
      errorMessage: conversion.errorMessage,
      attempt: conversion.attempt,
      sourcePlatform: conversion.sourcePlatform,
      targetProfile: conversion.targetProfile,
      rules: conversion.ruleVersions.map(({ ruleVersion }) => ruleVersion),
      createdAt: conversion.createdAt,
      updatedAt: conversion.updatedAt,
    },
  });
});

conversionsRouter.get("/conversions/:conversionId/stages", async (req, res) => {
  const id = conversionIdSchema.parse(req.params.conversionId);
  await authorizedConversion(id, authenticatedUserId(req));
  const stages = await prisma.conversionStage.findMany({
    where: { conversionId: id },
    orderBy: { position: "asc" },
    select: { name: true, status: true, inputHash: true, outputKey: true, diagnostics: true, startedAt: true, completedAt: true },
  });
  res.json({ stages });
});

conversionsRouter.get("/conversions/:conversionId/reports", async (req, res) => {
  const id = conversionIdSchema.parse(req.params.conversionId);
  await authorizedConversion(id, authenticatedUserId(req));
  const report = await prisma.validationReport.findUnique({
    where: { conversionId: id },
    select: { diagnostics: true, createdAt: true },
  });
  res.json({ report });
});

conversionsRouter.post("/conversions/:conversionId/cancel", async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const id = conversionIdSchema.parse(req.params.conversionId);
  const conversion = await authorizedConversion(id, authenticatedUserId(req));
  if (["SUCCEEDED", "FAILED", "BLOCKED", "CANCELLED"].includes(conversion.status)) {
    throw new HttpError(409, "CONVERSION_NOT_CANCELLABLE", "Conversion is already finished");
  }
  if (conversion.status === "QUEUED") {
    const cancelled = await prisma.$transaction(async (tx) => {
      const updated = await tx.conversionJob.updateMany({
        where: { id, status: "QUEUED" },
        data: {
          status: "CANCELLED",
          cancelRequestedAt: new Date(),
          workerId: null,
          lockedAt: null,
        },
      });
      if (updated.count === 0) return false;
      await tx.conversionStage.updateMany({
        where: { conversionId: id, status: StageStatus.PENDING },
        data: { status: StageStatus.CANCELLED, completedAt: new Date() },
      });
      return true;
    });
    if (!cancelled) {
      const requested = await prisma.conversionJob.updateMany({
        where: { id, status: "RUNNING" },
        data: { cancelRequestedAt: new Date() },
      });
      if (requested.count === 0) {
        throw new HttpError(409, "CONVERSION_NOT_CANCELLABLE", "Conversion is already finished");
      }
    }
  } else {
    const requested = await prisma.conversionJob.updateMany({
      where: { id, status: "RUNNING" },
      data: { cancelRequestedAt: new Date() },
    });
    if (requested.count === 0) {
      throw new HttpError(409, "CONVERSION_NOT_CANCELLABLE", "Conversion is already finished");
    }
  }
  res.status(202).json({ conversionId: id, cancellationRequested: true });
});

conversionsRouter.post("/conversions/:conversionId/retry", async (req, res) => {
  z.object({}).strict().parse(req.body ?? {});
  const id = conversionIdSchema.parse(req.params.conversionId);
  const conversion = await authorizedConversion(id, authenticatedUserId(req));
  if (conversion.status !== "FAILED") {
    throw new HttpError(409, "CONVERSION_NOT_RETRYABLE", "Only failed conversions can be retried");
  }
  await prisma.$transaction(async (tx) => {
    const retried = await tx.conversionJob.updateMany({
      where: { id, status: "FAILED" },
      data: {
        status: "QUEUED",
        errorCode: null,
        errorMessage: null,
        cancelRequestedAt: null,
        attempt: 0,
        availableAt: new Date(),
        workerId: null,
        lockedAt: null,
      },
    });
    if (retried.count === 0) {
      throw new HttpError(409, "CONVERSION_NOT_RETRYABLE", "Only failed conversions can be retried");
    }
    await tx.conversionStage.updateMany({
      where: { conversionId: id, status: { in: [StageStatus.FAILED, StageStatus.RUNNING] } },
      data: { status: StageStatus.PENDING, startedAt: null, completedAt: null, diagnostics: Prisma.DbNull },
    });
  });
  res.status(202).json({ conversionId: id, status: "QUEUED" });
});
