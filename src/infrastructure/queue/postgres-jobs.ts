import { prisma } from "../database/prisma.js";

const STALE_JOB_MS = 60_000;
const MAX_BACKOFF_MS = 60_000;

function retryDelayMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), MAX_BACKOFF_MS);
}

export async function claimNextConversion(workerId: string): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const jobs = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ConversionJob"
      WHERE "status" = 'QUEUED'::"ConversionStatus"
        AND "availableAt" <= NOW()
        AND "cancelRequestedAt" IS NULL
      ORDER BY "availableAt" ASC, "createdAt" ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    `;
    const job = jobs[0];
    if (!job) return null;

    const claimed = await tx.conversionJob.updateMany({
      where: {
        id: job.id,
        status: "QUEUED",
        cancelRequestedAt: null,
      },
      data: {
        status: "RUNNING",
        attempt: { increment: 1 },
        workerId,
        lockedAt: new Date(),
        errorCode: null,
        errorMessage: null,
      },
    });
    return claimed.count === 1 ? job.id : null;
  });
}

export async function recoverStaleConversions(maxAttempts: number): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const staleJobs = await tx.$queryRaw<Array<{ id: string; attempt: number }>>`
      SELECT "id", "attempt"
      FROM "ConversionJob"
      WHERE "status" = 'RUNNING'::"ConversionStatus"
        AND "lockedAt" < NOW() - (${STALE_JOB_MS} * INTERVAL '1 millisecond')
      ORDER BY "lockedAt" ASC
      FOR UPDATE SKIP LOCKED
    `;

    for (const job of staleJobs) {
      const exhausted = job.attempt >= maxAttempts;
      const message = exhausted
        ? "Conversion worker stopped before completing the job; retry limit was reached"
        : "Conversion worker stopped unexpectedly; job was returned to the queue";
      await tx.conversionJob.update({
        where: { id: job.id },
        data: {
          status: exhausted ? "FAILED" : "QUEUED",
          ...(!exhausted && {
            availableAt: new Date(Date.now() + retryDelayMs(job.attempt)),
          }),
          lockedAt: null,
          workerId: null,
          errorCode: exhausted ? "WORKER_CRASHED" : "WORKER_RECOVERED",
          errorMessage: message,
        },
      });
      await tx.conversionStage.updateMany({
        where: { conversionId: job.id, status: "RUNNING" },
        data: exhausted
          ? {
              status: "FAILED",
              completedAt: new Date(),
              diagnostics: [{ code: "WORKER_CRASHED", message }],
            }
          : {
              status: "PENDING",
              startedAt: null,
              completedAt: null,
              diagnostics: [{ code: "WORKER_RECOVERED", message }],
            },
      });
    }
    return staleJobs.length;
  });
}

export async function recordConversionFailure(
  conversionId: string,
  workerId: string,
  attempt: number,
  maxAttempts: number,
): Promise<void> {
  const exhausted = attempt >= maxAttempts;
  const message = "Conversion worker encountered an unexpected failure";
  await prisma.$transaction(async (tx) => {
    const updated = await tx.conversionJob.updateMany({
      where: { id: conversionId, status: "RUNNING", workerId },
      data: {
        status: exhausted ? "FAILED" : "QUEUED",
        ...(!exhausted && {
          availableAt: new Date(Date.now() + retryDelayMs(attempt)),
        }),
        lockedAt: null,
        workerId: null,
        errorCode: exhausted ? "WORKER_FAILED" : "WORKER_RETRYING",
        errorMessage: message,
      },
    });
    if (updated.count === 0) return;
    await tx.conversionStage.updateMany({
      where: { conversionId, status: "RUNNING" },
      data: exhausted
        ? {
            status: "FAILED",
            completedAt: new Date(),
            diagnostics: [{ code: "WORKER_FAILED", message }],
          }
        : {
            status: "PENDING",
            startedAt: null,
            completedAt: null,
            diagnostics: [{ code: "WORKER_RETRYING", message }],
          },
    });
  });
}

export async function heartbeatConversion(
  conversionId: string,
  workerId: string,
): Promise<boolean> {
  const heartbeat = await prisma.conversionJob.updateMany({
    where: { id: conversionId, status: "RUNNING", workerId },
    data: { lockedAt: new Date() },
  });
  return heartbeat.count === 1;
}
