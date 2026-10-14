import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Prisma, ProjectRole, StageStatus, UploadStatus } from "../../generated/prisma/client.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { storage } from "../../infrastructure/storage/local.js";
import { authenticatedUserId } from "../auth/auth.middleware.js";
import { requireProjectRole } from "../projects/access.js";
import { conversionSettingsBaseSchema } from "../capabilities/capabilities.schema.js";
import { loadRulesForConversion, persistConversionRules } from "../rule-files/rules.service.js";

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

// Conversion history for a project. Returns the real persisted ConversionJob rows
// that belong to the requested project (queried by the projectId foreign key, never
// by assuming a job id equals a project or upload id). Ownership is enforced via
// requireProjectRole so a user only sees history for projects they are a member of.
conversionsRouter.get("/projects/:projectId/conversions", async (req, res) => {
  const projectId = z.string().cuid().parse(req.params.projectId);
  await requireProjectRole(projectId, authenticatedUserId(req), Object.values(ProjectRole));
  const jobs = await prisma.conversionJob.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      sourcePlatform: true,
      createdAt: true,
      updatedAt: true,
      artifacts: {
        where: { status: "READY" },
        select: { id: true },
        take: 1,
      },
    },
  });
  res.json({
    conversions: jobs.map((job) => ({
      id: job.id,
      status: job.status,
      sourcePlatform: job.sourcePlatform,
      hasArtifact: job.artifacts.length > 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    })),
  });
});

/** Download the completed conversion's Elementor artifact (application/json). */
conversionsRouter.get("/conversions/:conversionId/artifacts/download", async (req, res) => {
  const id = conversionIdSchema.parse(req.params.conversionId);
  const userId = authenticatedUserId(req);
  const conversion = await authorizedConversion(id, userId);

  // A download is only available for a genuinely completed job.
  if (conversion.status !== "SUCCEEDED") {
    throw new HttpError(
      409,
      "CONVERSION_NOT_COMPLETED",
      "This conversion has not finished successfully yet, so there is no artifact to download.",
    );
  }

  const artifact = await prisma.artifact.findFirst({
    where: { conversionId: conversion.id, status: "READY" },
    select: { id: true, fileName: true, contentType: true, sizeBytes: true, storageKey: true },
  });
  if (!artifact) {
    throw new HttpError(
      409,
      "CONVERSION_NO_ARTIFACT",
      "The conversion completed, but the Elementor artifact file was not persisted.",
    );
  }

  // Verify the private object exists and the stored metadata is consistent.
  const stored = await storage.stat(artifact.storageKey);
  if (!stored || stored.sizeBytes !== Number(artifact.sizeBytes)) {
    // Clean up the dangling DB record so it cannot be offered again.
    await prisma.artifact.deleteMany({ where: { id: artifact.id, status: "READY" } }).catch(() => undefined);
    throw new HttpError(
      500,
      "ARTIFACT_STORAGE_MISMATCH",
      "The Elementor artifact file could not be read from storage; the download is unavailable.",
    );
  }

  const stream = await storage.createReadStream(artifact.storageKey);
  const rejectChars = new Set([0x0a, 0x0d, 0x22, 0x5c, 0x2f]);
  const safeName = Array.from(artifact.fileName).map((ch) => rejectChars.has(ch.charCodeAt(0)) ? '_' : ch).join('');
  res.status(200);
  res.setHeader("Content-Type", artifact.contentType ?? "application/json");
  res.setHeader("Content-Length", String(stored.sizeBytes));
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`,
  );
  res.setHeader("Cache-Control", "private, no-store");
  await pipeline(stream, res);
});

conversionsRouter.post("/projects/:projectId/conversions", async (req, res) => {
  const body = createSchema.parse(req.body);
  const projectId = z.string().cuid().parse(req.params.projectId);
  const userId = authenticatedUserId(req);
  await requireProjectRole(projectId, userId, [ProjectRole.OWNER, ProjectRole.EDITOR]);
  if (body.sourceType === "screenshot") {
    throw new HttpError(
      501,
      "CONVERSION_PIPELINE_UNAVAILABLE",
      "This source type has no approved Markdown conversion rules yet. No conversion job was created.",
    );
  }

  let resolvedUploadId: string | null = null;
  let resolvedSourceImportId: string | null = body.sourceImportId ?? null;
  let sourcePlatform: "REACT_NEXT_ZIP" | "FIGMA" | "FRAMER";

  if (body.sourceType === "react-next-zip") {
    if (!body.uploadId) {
      throw new HttpError(
        400,
        "UPLOAD_REQUIRED",
        "React/Next.js conversions require a validated upload reference",
      );
    }
    const upload = await prisma.upload.findFirst({
      where: {
        id: body.uploadId,
        projectId,
        sourceType: "REACT_NEXT_ZIP",
        status: UploadStatus.READY,
      },
      select: {
        id: true,
        sourceType: true,
        detectedFramework: true,
        sourceImportId: true,
      },
    });
    if (!upload) {
      throw new HttpError(
        400,
        "UPLOAD_NOT_READY",
        "Conversion requires a ready React or Next.js project upload in this project",
      );
    }
    if (
      body.detectedFramework &&
      upload.detectedFramework &&
      body.detectedFramework !== upload.detectedFramework
    ) {
      throw new HttpError(
        400,
        "FRAMEWORK_MISMATCH",
        "Conversion framework settings must match the detected project framework.",
      );
    }
    if (body.sourceImportId) {
      const sourceImport = await prisma.sourceImport.findFirst({
        where: { id: body.sourceImportId, projectId, status: "READY" },
        select: { id: true, kind: true },
      });
      if (!sourceImport || sourceImport.kind !== "REACT_NEXT_PROJECT") {
        throw new HttpError(
          400,
          "SOURCE_IMPORT_MISMATCH",
          "Conversion source settings must match the validated React/Next.js import.",
        );
      }
      resolvedSourceImportId = sourceImport.id;
    } else if (upload.sourceImportId) {
      resolvedSourceImportId = upload.sourceImportId;
    }
    resolvedUploadId = upload.id;
    sourcePlatform = "REACT_NEXT_ZIP";
  } else {
    if (!body.sourceImportId) {
      throw new HttpError(
        400,
        "SOURCE_IMPORT_REQUIRED",
        "Figma and Framer conversions require a validated source import reference",
      );
    }
    const sourceImport = await prisma.sourceImport.findFirst({
      where: { id: body.sourceImportId, projectId, status: "READY" },
      select: { id: true, kind: true },
    });
    if (!sourceImport) {
      throw new HttpError(
        400,
        "SOURCE_IMPORT_NOT_READY",
        "Conversion requires a ready Figma or Framer import in this project",
      );
    }
    const expectedKind = body.sourceType === "figma" ? "FIGMA_FILE" : "FRAMER_SITE";
    if (sourceImport.kind !== expectedKind) {
      throw new HttpError(
        400,
        "SOURCE_IMPORT_MISMATCH",
        "Conversion source settings must match the validated import.",
      );
    }
    if (body.uploadId) {
      const upload = await prisma.upload.findFirst({
        where: {
          id: body.uploadId,
          projectId,
          sourceImportId: sourceImport.id,
          status: UploadStatus.READY,
        },
        select: { id: true },
      });
      if (!upload) {
        throw new HttpError(
          400,
          "UPLOAD_SOURCE_MISMATCH",
          "The upload reference must belong to the validated source import.",
        );
      }
      resolvedUploadId = upload.id;
    }
    resolvedSourceImportId = sourceImport.id;
    sourcePlatform = body.sourceType === "figma" ? "FIGMA" : "FRAMER";
  }

  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        sourceType: body.sourceType,
        detectedFramework: body.detectedFramework ?? null,
        sourceImportId: resolvedSourceImportId,
        uploadId: resolvedUploadId,
        targetProfile: body.targetProfile,
      }),
    )
    .digest("hex");
  const rules = await loadRulesForConversion(body.sourceType);

  const existing = await prisma.conversionJob.findUnique({
    where: { projectId_idempotencyKey: { projectId, idempotencyKey: body.idempotencyKey } },
    select: { id: true, status: true, requestHash: true },
  });
  if (existing) {
    // Same key + same request replays idempotently; same key + different
    // payload is a client contract violation (documented 409).
    if (existing.requestHash !== requestHash) {
      throw new HttpError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This idempotency key was already used with a different conversion request.",
      );
    }
    return res.status(200).json({ conversion: { id: existing.id, status: existing.status }, idempotentReplay: true });
  }

  const conversion = await prisma.$transaction(async (tx) => {
    const created = await tx.conversionJob.create({
      data: {
        projectId,
        createdById: userId,
        uploadId: resolvedUploadId,
        sourcePlatform,
        idempotencyKey: body.idempotencyKey,
        requestHash,
        status: "QUEUED",
        targetProfile: body.targetProfile as Prisma.InputJsonValue,
      },
      select: { id: true, status: true },
    });
    await persistConversionRules(tx, created.id, rules);
    await tx.conversionStage.createMany({
      data: [
        { conversionId: created.id, name: "source_inspection", position: 0 },
        { conversionId: created.id, name: "source_ir_validation", position: 1 },
        { conversionId: created.id, name: "target_ir_generation", position: 2 },
      ],
    });
    await tx.conversionStage.update({
      where: { conversionId_name: { conversionId: created.id, name: "source_inspection" } },
      data: { status: StageStatus.COMPLETED, completedAt: new Date(), inputHash: requestHash },
    });
    return created;
  });

  return res.status(201).json({ conversion: { id: conversion.id, status: conversion.status }, idempotentReplay: false });
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
