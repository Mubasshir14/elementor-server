import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { prismaMock, transactionMock } = vi.hoisted(() => ({
  prismaMock: {
    $transaction: vi.fn(),
    conversionJob: { updateMany: vi.fn() },
  },
  transactionMock: {
    $queryRaw: vi.fn(),
    conversionJob: {
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    conversionStage: { updateMany: vi.fn() },
  },
}));

vi.mock("../src/infrastructure/database/prisma.js", () => ({ prisma: prismaMock }));

import {
  claimNextConversion,
  heartbeatConversion,
  recordConversionFailure,
  recoverStaleConversions,
} from "../src/infrastructure/queue/postgres-jobs.js";

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$transaction.mockImplementation(async (callback) => callback(transactionMock));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PostgreSQL conversion queue", () => {
  it("claims a due job inside a SKIP LOCKED transaction", async () => {
    transactionMock.$queryRaw.mockResolvedValue([{ id: "conversion-1" }]);
    transactionMock.conversionJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(claimNextConversion("worker-1")).resolves.toBe("conversion-1");

    const query = transactionMock.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray;
    expect(query.join(" ")).toContain("FOR UPDATE SKIP LOCKED");
    expect(transactionMock.conversionJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "conversion-1", status: "QUEUED", cancelRequestedAt: null },
      data: expect.objectContaining({ status: "RUNNING", workerId: "worker-1" }),
    }));
  });

  it("returns no job when the queue is empty", async () => {
    transactionMock.$queryRaw.mockResolvedValue([]);

    await expect(claimNextConversion("worker-1")).resolves.toBeNull();
    expect(transactionMock.conversionJob.updateMany).not.toHaveBeenCalled();
  });

  it("requeues recoverable failures with bounded exponential backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    transactionMock.conversionJob.updateMany.mockResolvedValue({ count: 1 });
    transactionMock.conversionStage.updateMany.mockResolvedValue({ count: 1 });

    await recordConversionFailure("conversion-1", "worker-1", 10, 20);

    expect(prismaMock.$transaction).toHaveBeenCalledOnce();
    expect(transactionMock.conversionJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: "QUEUED",
        availableAt: new Date("2026-01-01T00:01:00.000Z"),
        workerId: null,
      }),
    }));
    expect(transactionMock.conversionStage.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "PENDING" }),
    }));
  });

  it("fails jobs after the configured attempt limit", async () => {
    vi.useFakeTimers();
    transactionMock.conversionJob.updateMany.mockResolvedValue({ count: 1 });
    transactionMock.conversionStage.updateMany.mockResolvedValue({ count: 1 });

    await recordConversionFailure("conversion-1", "worker-1", 3, 3);

    const update = transactionMock.conversionJob.updateMany.mock.calls[0]?.[0];
    expect(update.data).toMatchObject({ status: "FAILED", errorCode: "WORKER_FAILED" });
    expect(update.data).not.toHaveProperty("availableAt");
  });

  it("recovers stale leases and marks exhausted attempts failed", async () => {
    transactionMock.$queryRaw.mockResolvedValue([
      { id: "conversion-retry", attempt: 1 },
      { id: "conversion-failed", attempt: 3 },
    ]);
    transactionMock.conversionJob.update.mockResolvedValue({});
    transactionMock.conversionStage.updateMany.mockResolvedValue({ count: 1 });

    await expect(recoverStaleConversions(3)).resolves.toBe(2);

    expect(transactionMock.conversionJob.update).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: "conversion-retry" },
      data: expect.objectContaining({ status: "QUEUED", workerId: null, errorCode: "WORKER_RECOVERED" }),
    }));
    expect(transactionMock.conversionJob.update).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: "conversion-failed" },
      data: expect.objectContaining({ status: "FAILED", workerId: null, errorCode: "WORKER_CRASHED" }),
    }));
  });

  it("updates a lease only while the worker still owns it", async () => {
    prismaMock.conversionJob.updateMany.mockResolvedValue({ count: 1 });

    await expect(heartbeatConversion("conversion-1", "worker-1")).resolves.toBe(true);

    expect(prismaMock.conversionJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "conversion-1", status: "RUNNING", workerId: "worker-1" },
    }));
  });
});
