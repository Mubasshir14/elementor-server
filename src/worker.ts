import { randomUUID } from "node:crypto";
import { Prisma, StageStatus, UploadStatus } from "./generated/prisma/client.js";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { storage } from "./infrastructure/storage/local.js";
import {
  claimNextConversion,
  heartbeatConversion,
  recordConversionFailure,
  recoverStaleConversions,
} from "./infrastructure/queue/postgres-jobs.js";
import { runConversionPipeline, persistElementorArtifact } from "./modules/conversions/conversion-pipeline.js";
import {
  analyzeReactNextProjectZip,
  persistReactNextImport,
} from "./modules/react-nextjs/react-nextjs.service.js";
import { cleanupExpiredMultipartUploads } from "./modules/uploads/uploads.routes.js";

const POLL_INTERVAL_MS = 1_000;
const RECOVERY_INTERVAL_MS = 15_000;
const HEARTBEAT_INTERVAL_MS = 15_000;
let stopping = false;
let lastRecoveryAt = 0;

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

async function cancelIfRequested(conversionId: string, workerId: string): Promise<boolean> {
  const current = await prisma.conversionJob.findUnique({
    where: { id: conversionId },
    select: { cancelRequestedAt: true, status: true, workerId: true },
  });
  if (
    !current ||
    current.workerId !== workerId ||
    current.status !== "RUNNING" ||
    !current.cancelRequestedAt
  ) {
    return !current || current.workerId !== workerId || current.status !== "RUNNING";
  }

  await prisma.$transaction(async (tx) => {
    const cancelled = await tx.conversionJob.updateMany({
      where: { id: conversionId, status: "RUNNING", workerId, cancelRequestedAt: { not: null } },
      data: { status: "CANCELLED", workerId: null, lockedAt: null },
    });
    if (cancelled.count === 0) return;
    await tx.conversionStage.updateMany({
      where: { conversionId, status: { in: ["PENDING", "RUNNING"] } },
      data: { status: "CANCELLED", completedAt: new Date() },
    });
  });
  return true;
}

// Diagnostics honesty: a missing-source diagnostic must NEVER coexist with a
// successful outcome. On SUCCEEDED we persist a neutral completion marker (the UI
// only renders entries that carry a human message, so this stays invisible). On
// BLOCKED we persist the pipeline's real diagnostics. The missing-source fallback
// (`diagnostic`) is used only when the pipeline never ran (null result) — a path
// that always marks the job BLOCKED, never SUCCEEDED. Exported as a pure function
// so the invariant is directly unit-testable.
export function computePersistedDiagnostics(
  pipelineStatus: "SUCCEEDED" | "BLOCKED" | null,
  pipelineDiagnostics: unknown[] | null,
  missingSourceDiagnostic: unknown,
): { diagnostics: Prisma.InputJsonValue[]; success: boolean } {
  const success = pipelineStatus === "SUCCEEDED";
  const diagnostics: Prisma.InputJsonValue[] = success
    ? [{ code: "UPSTREAM_STAGE_COMPLETED" }]
    : pipelineStatus === "BLOCKED"
      ? ((pipelineDiagnostics ?? []) as Prisma.InputJsonValue[])
      : [missingSourceDiagnostic as Prisma.InputJsonValue];
  return { diagnostics, success };
}

export async function processConversion(conversionId: string, workerId: string): Promise<void> {
  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void heartbeatConversion(conversionId, workerId)
      .then((alive) => {
        if (!alive) leaseLost = true;
      })
      .catch((error: unknown) => {
        leaseLost = true;
        console.error(
          `Conversion ${conversionId} heartbeat failed`,
          error instanceof Error ? error.name : "unknown",
        );
      });
  }, HEARTBEAT_INTERVAL_MS);

  try {
    const conversion = await prisma.conversionJob.findUnique({
      where: { id: conversionId },
      include: { upload: true },
    });
    if (!conversion || conversion.workerId !== workerId) return;
    if (conversion.upload && conversion.upload.status !== UploadStatus.READY) {
      throw new Error("Conversion upload is not ready");
    }
    const uploadSha256 = conversion.upload?.sha256 ?? conversion.requestHash;

    const inspection = await prisma.conversionStage.update({
      where: { conversionId_name: { conversionId, name: "source_inspection" } },
      data: {
        status: StageStatus.RUNNING,
        inputHash: uploadSha256,
        startedAt: new Date(),
        completedAt: null,
      },
    });
    if (leaseLost || await cancelIfRequested(conversionId, workerId)) return;

    await prisma.conversionStage.update({
      where: { id: inspection.id },
      data: { status: StageStatus.COMPLETED, completedAt: new Date() },
    });
    if (leaseLost || await cancelIfRequested(conversionId, workerId)) return;

    let pipelineResult: Awaited<ReturnType<typeof runConversionPipeline>> | null = null;
    let resolvedImport: { snapshotKey: string | null; kind: string } | null = null;

    if (conversion.upload?.sourceImportId) {
      resolvedImport = await prisma.sourceImport.findUnique({
        where: { id: conversion.upload.sourceImportId },
        select: { snapshotKey: true, kind: true },
      });
    } else if (
      conversion.upload &&
      conversion.upload.sourceType === "REACT_NEXT_ZIP"
    ) {
      const zipBytes = await storage.readFile(conversion.upload.storageKey);
      const { snapshot } = await analyzeReactNextProjectZip(zipBytes);
      const persisted = await persistReactNextImport({
        projectId: conversion.projectId,
        userId: conversion.createdById,
        uploadId: conversion.upload.id,
        fileName: conversion.upload.fileName,
        snapshot,
      });
      await prisma.upload.update({
        where: { id: conversion.upload.id },
        data: { sourceImportId: persisted.sourceImport.id },
      });
      resolvedImport = {
        snapshotKey: persisted.snapshotStorageKey,
        kind: "REACT_NEXT_PROJECT",
      };
    } else if (!conversion.upload) {
      const expectedKind =
        conversion.sourcePlatform === "FIGMA"
          ? "FIGMA_FILE"
          : conversion.sourcePlatform === "FRAMER"
            ? "FRAMER_SITE"
            : "REACT_NEXT_PROJECT";
      resolvedImport = await prisma.sourceImport.findFirst({
        where: { projectId: conversion.projectId, kind: expectedKind, status: "READY" },
        orderBy: { createdAt: "desc" },
        select: { snapshotKey: true, kind: true },
      });
    }

    if (
      resolvedImport?.snapshotKey &&
      (resolvedImport.kind === "FIGMA_FILE" ||
        resolvedImport.kind === "FRAMER_SITE" ||
        resolvedImport.kind === "REACT_NEXT_PROJECT")
    ) {
      const pipelineSourceType =
        resolvedImport.kind === "FIGMA_FILE"
          ? "figma"
          : resolvedImport.kind === "FRAMER_SITE"
            ? "framer"
            : "react-next-zip";
      try {
        pipelineResult = await runConversionPipeline(
          {
            sourceType: pipelineSourceType,
            snapshotKey: resolvedImport.snapshotKey,
          },
          resolvedImport.snapshotKey,
          {
            projectId: conversion.projectId,
            conversionId: conversion.id,
            sourceType: pipelineSourceType,
          },
        );
      } catch (error) {
        const code = (error as { code?: string }).code ?? "CONVERSION_FAILED";
        const message = error instanceof Error ? error.message : "Conversion failed";
        await prisma.$transaction(async (tx) => {
          const owned = await tx.conversionJob.updateMany({
            where: { id: conversionId, status: "RUNNING", workerId },
            data: { status: "FAILED", errorCode: code, errorMessage: message, workerId: null, lockedAt: null },
          });
          if (owned.count === 0) return;
          await tx.conversionStage.updateMany({
            where: { conversionId, status: { in: [StageStatus.PENDING, StageStatus.RUNNING] } },
            data: { status: StageStatus.FAILED, completedAt: new Date() },
          });
          await tx.validationReport.upsert({
            where: { conversionId },
            create: { conversionId, diagnostics: [{ code, severity: "error", message, stage: "conversion" }] },
            update: { diagnostics: [{ code, severity: "error", message, stage: "conversion" }] },
          });
        });
        return;
      }
    }

    const success = pipelineResult?.status === "SUCCEEDED";

    // The single fallback diagnostic used only when the pipeline never ran
    // (pipelineResult === null). On BLOCKED we surface the pipeline's real first
    // diagnostic; otherwise this missing-source error. This is the value passed
    // as the fallback to computePersistedDiagnostics below.
    const diagnostic =
      pipelineResult?.status === "BLOCKED"
        ? {
            code: pipelineResult.diagnostics[0]?.code ?? "CONVERSION_BLOCKED",
            severity: "error",
            message: pipelineResult.diagnostics[0]?.message ?? "Conversion was blocked.",
            stage: pipelineResult.stage,
          }
        : {
            code: "SOURCE_ANALYSIS_RULES_MISSING",
            severity: "error",
            message:
              "Conversion stopped because this job has no validated source import; the Markdown-driven pipeline requires a ready source snapshot for the recorded source type.",
            stage: "source_ir_validation",
          };

    // Diagnostics honesty: the persisted stage/report diagnostics never include a
    // missing-source error alongside a successful outcome. See
    // computePersistedDiagnostics for the exact invariant (unit-tested).
    const { diagnostics: persistedDiagnostics } = computePersistedDiagnostics(
      pipelineResult?.status ?? null,
      pipelineResult?.status === "BLOCKED" ? pipelineResult.diagnostics : null,
      diagnostic,
    );


    // Persistence-first ordering: a conversion may only be marked SUCCEEDED
    // after the validated Elementor output is durably stored and the Artifact
    // record exists. Any storage/DB failure marks the job FAILED instead.
    let persisted: Awaited<ReturnType<typeof persistElementorArtifact>> | null = null;
    if (success && pipelineResult && pipelineResult.status === "SUCCEEDED") {
      try {
        persisted = await persistElementorArtifact(
          conversion.projectId,
          conversion.id,
          pipelineResult.elementorOutput,
        );
      } catch (error) {
        const code = (error as { code?: string }).code ?? "ARTIFACT_PERSISTENCE_FAILED";
        const message = error instanceof Error ? error.message : "Artifact persistence failed";
        await prisma.$transaction(async (tx) => {
          const owned = await tx.conversionJob.updateMany({
            where: { id: conversionId, status: "RUNNING", workerId },
            data: { status: "FAILED", errorCode: code, errorMessage: message, workerId: null, lockedAt: null },
          });
          if (owned.count === 0) return;
          await tx.conversionStage.updateMany({
            where: { conversionId, status: { in: [StageStatus.PENDING, StageStatus.RUNNING] } },
            data: { status: StageStatus.FAILED, completedAt: new Date() },
          });
          await tx.validationReport.upsert({
            where: { conversionId },
            create: { conversionId, diagnostics: [{ code, severity: "error", message, stage: "artifact_persistence" }] },
            update: { diagnostics: [{ code, severity: "error", message, stage: "artifact_persistence" }] },
          });
        });
        return;
      }
    }

    const completedAt = success ? new Date() : null;
    const jobStatus = success ? "SUCCEEDED" : "BLOCKED";
    const jobErrorCode = success ? null : diagnostic.code;
    const jobErrorMessage = success ? null : diagnostic.message;
    const jobWorkerId = success ? null : workerId;
    const jobLockedAt = success ? null : new Date();

    await prisma.$transaction(async (tx) => {
      const owned = await tx.conversionJob.updateMany({
        where: { id: conversionId, status: "RUNNING", workerId },
        data: {
          status: jobStatus,
          errorCode: jobErrorCode,
          errorMessage: jobErrorMessage,
          workerId: jobWorkerId,
          lockedAt: jobLockedAt,
        },
      });
      if (owned.count === 0) return;
      await tx.conversionStage.update({
        where: { conversionId_name: { conversionId, name: "source_ir_validation" } },
        data: {
          status: success ? StageStatus.COMPLETED : StageStatus.BLOCKED,
          inputHash: uploadSha256,
          diagnostics: persistedDiagnostics,
          completedAt,
        },
      });
      await tx.conversionStage.updateMany({
        where: { conversionId, status: StageStatus.PENDING },
        data: {
          status: success ? StageStatus.COMPLETED : StageStatus.BLOCKED,
          diagnostics: success ? [{ code: "UPSTREAM_STAGE_COMPLETED" }] : [{ code: "UPSTREAM_STAGE_BLOCKED", stage: "source_ir_validation" }],
          completedAt,
        },
      });
      if (success && persisted) {
        await tx.conversionStage.update({
          where: { conversionId_name: { conversionId, name: "target_ir_generation" } },
          data: {
            status: StageStatus.COMPLETED,
            outputKey: persisted.storageKey,
            completedAt,
          },
        });
      }
      await tx.validationReport.upsert({
        where: { conversionId },
        create: {
          conversionId,
          diagnostics: persistedDiagnostics,
        },
        update: {
          diagnostics: persistedDiagnostics,
        },
      });
    });
  } finally {
    clearInterval(heartbeat);
  }
}

async function workerLoop(workerId: string): Promise<void> {
  while (!stopping) {
    try {
      if (Date.now() - lastRecoveryAt >= RECOVERY_INTERVAL_MS) {
        await recoverStaleConversions(env.CONVERSION_MAX_ATTEMPTS);
        await cleanupExpiredMultipartUploads().catch(() => undefined);
        lastRecoveryAt = Date.now();
      }
      const conversionId = await claimNextConversion(workerId);
      if (!conversionId) {
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      try {
        await processConversion(conversionId, workerId);
      } catch (error) {
        const job = await prisma.conversionJob.findFirst({
          where: { id: conversionId, workerId, status: "RUNNING" },
          select: { attempt: true },
        });
        if (job) {
          await recordConversionFailure(
            conversionId,
            workerId,
            job.attempt,
            env.CONVERSION_MAX_ATTEMPTS,
          );
        }
        console.error(
          `Conversion ${conversionId} failed`,
          error instanceof Error ? error.message : "unknown",
        );
      }
    } catch (error) {
      console.error("PostgreSQL conversion worker loop failed", error instanceof Error ? error.message : "unknown");
      await delay(POLL_INTERVAL_MS);
    }
  }
}

export async function processNextPendingConversion(workerId = randomUUID()): Promise<string | null> {
  const conversionId = await claimNextConversion(workerId);
  if (!conversionId) return null;
  await processConversion(conversionId, workerId);
  return conversionId;
}

async function startWorker() {
  await storage.ready();
  const loops = Array.from(
    { length: env.CONVERSION_WORKER_CONCURRENCY },
    () => workerLoop(randomUUID()),
  );
  await Promise.all(loops);
  await prisma.$disconnect();
}

if (process.env.NODE_ENV !== "test" && process.env.WORKER_LIBRARY_MODE !== "1") {
  process.once("SIGINT", () => {
    stopping = true;
  });
  process.once("SIGTERM", () => {
    stopping = true;
  });

  void startWorker().catch((error: unknown) => {
    console.error(
      "PostgreSQL conversion worker stopped unexpectedly",
      error instanceof Error ? error.message : "unknown",
    );
    process.exitCode = 1;
    void prisma.$disconnect();
  });
}
