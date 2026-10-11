import { randomUUID } from "node:crypto";
import { StageStatus, UploadStatus } from "./generated/prisma/client.js";
import { env } from "./config/env.js";
import { prisma } from "./infrastructure/database/prisma.js";
import { storage } from "./infrastructure/storage/local.js";
import {
  claimNextConversion,
  heartbeatConversion,
  recordConversionFailure,
  recoverStaleConversions,
} from "./infrastructure/queue/postgres-jobs.js";
import { runConversionPipeline } from "./modules/conversions/conversion-pipeline.js";

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

async function processConversion(conversionId: string, workerId: string): Promise<void> {
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
    if (!conversion.upload || conversion.upload.status !== UploadStatus.READY) {
      throw new Error("Conversion upload is not ready");
    }
    const uploadSha256 = conversion.upload.sha256;

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

    // Run the Markdown-driven conversion pipeline for Figma/Framer sources.
    // React/Next.js keeps the original blocked behavior (no source-analysis rule
    // file exists for it yet). The pipeline loads rules at conversion time, asks
    // the AI for a DIR, validates it, then reports the missing Elementor
    // generator as an explicit blocker — never a fabricated success.
    let pipelineResult: Awaited<ReturnType<typeof runConversionPipeline>> | null = null;
    if (conversion.upload.sourceImportId) {
      const sourceImport = await prisma.sourceImport.findUnique({
        where: { id: conversion.upload.sourceImportId },
        select: { snapshotKey: true, kind: true },
      });
      if (sourceImport?.snapshotKey && (sourceImport.kind === "FIGMA_FILE" || sourceImport.kind === "FRAMER_SITE")) {
        try {
          pipelineResult = await runConversionPipeline(
            {
              sourceType: sourceImport.kind === "FIGMA_FILE" ? "figma" : "framer",
              snapshotKey: sourceImport.snapshotKey,
            },
            sourceImport.snapshotKey,
          );
        } catch (error) {
          // Actionable pipeline error (disabled AI, missing key, unreachable
          // provider, unparseable source): mark FAILED with a truthful code.
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
    }

    const pipelineDiagnostics = pipelineResult?.status === "BLOCKED" ? pipelineResult.diagnostics : null;
    const diagnostic = pipelineResult?.status === "BLOCKED"
      ? {
          code: pipelineResult.diagnostics[0]?.code ?? "CONVERSION_BLOCKED",
          severity: "error",
          message: pipelineResult.diagnostics[0]?.message ?? "Conversion was blocked.",
          stage: pipelineResult.stage,
        }
      : {
          code: "APPROVED_IR_SCHEMA_MISSING",
          severity: "error",
          message: "Conversion stopped because the approved DIR/IR schema is not available to the backend.",
          stage: "source_ir_validation",
        };
    await prisma.$transaction(async (tx) => {
      const owned = await tx.conversionJob.updateMany({
        where: { id: conversionId, status: "RUNNING", workerId },
        data: {
          status: "BLOCKED",
          errorCode: diagnostic.code,
          errorMessage: diagnostic.message,
          workerId: null,
          lockedAt: null,
        },
      });
      if (owned.count === 0) return;
      await tx.conversionStage.update({
        where: { conversionId_name: { conversionId, name: "source_ir_validation" } },
        data: {
          status: StageStatus.BLOCKED,
          inputHash: uploadSha256,
          diagnostics: pipelineDiagnostics ?? [diagnostic],
          completedAt: new Date(),
        },
      });
      await tx.conversionStage.updateMany({
        where: { conversionId, status: StageStatus.PENDING },
        data: {
          status: StageStatus.BLOCKED,
          diagnostics: [{ code: "UPSTREAM_STAGE_BLOCKED", stage: "source_ir_validation" }],
          completedAt: new Date(),
        },
      });
      await tx.validationReport.upsert({
        where: { conversionId },
        create: { conversionId, diagnostics: pipelineDiagnostics ?? [diagnostic] },
        update: { diagnostics: pipelineDiagnostics ?? [diagnostic] },
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
          error instanceof Error ? error.name : "unknown",
        );
      }
    } catch (error) {
      console.error("PostgreSQL conversion worker loop failed", error instanceof Error ? error.name : "unknown");
      await delay(POLL_INTERVAL_MS);
    }
  }
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

process.once("SIGINT", () => {
  stopping = true;
});
process.once("SIGTERM", () => {
  stopping = true;
});

void startWorker().catch((error: unknown) => {
  console.error(
    "PostgreSQL conversion worker stopped unexpectedly",
    error instanceof Error ? error.name : "unknown",
  );
  process.exitCode = 1;
  void prisma.$disconnect();
});
