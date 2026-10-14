import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

vi.mock("../src/infrastructure/database/prisma.js", () => ({
  prisma: {
    session: { findFirst: vi.fn() },
    projectMember: { findUnique: vi.fn() },
    sourceImport: { findFirst: vi.fn() },
    conversionJob: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    conversionStage: { createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    ruleFileVersion: { upsert: vi.fn() },
    conversionRuleVersion: { create: vi.fn() },
    validationReport: { upsert: vi.fn() },
    artifact: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn(), deleteMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

vi.mock("../src/infrastructure/storage/local.js", () => ({
  storage: {
    stat: vi.fn(),
    createReadStream: vi.fn(),
    readFile: vi.fn(),
    delete: vi.fn(),
  },
}));

import { prisma } from "../src/infrastructure/database/prisma.js";
import { createApp } from "../src/app.js";
import { resetRuleCacheForTests } from "../src/modules/rules/rule-loader.js";
import { storage } from "../src/infrastructure/storage/local.js";
import { Readable } from "node:stream";

const app = createApp();
const TOKEN = jwt.sign({ sid: "csessiontest00000000000" }, process.env.JWT_SECRET!, {
  subject: "cusersession00000000000",
  issuer: "design-to-elementor-api",
  expiresIn: "5m",
});

const queuedJob = {
  id: "cqueued00000000000000000",
  projectId: "cxxxxxxxxxxxxxxxxxxxxxxxx",
  uploadId: null,
  createdById: "user-000000000000",
  sourcePlatform: "REACT_NEXT_ZIP",
  idempotencyKey: "key-one",
  requestHash: "abc123",
  queueJobId: null,
  status: "QUEUED",
  targetProfile: null,
  errorCode: null,
  errorMessage: null,
  attempt: 0,
  cancelRequestedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const readyJobFailed = {
  id: "cfailed00000000000000000",
  projectId: "cxxxxxxxxxxxxxxxxxxxxxxxx",
  uploadId: null,
  createdById: "user-000000000000",
  sourcePlatform: "REACT_NEXT_ZIP",
  idempotencyKey: "key-two",
  requestHash: "abc456",
  queueJobId: null,
  status: "FAILED",
  targetProfile: null,
  errorCode: "WORKER_FAILED",
  errorMessage: "Conversion worker encountered an unexpected failure",
  attempt: 1,
  cancelRequestedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const succeededJob = {
  id: "csucceeded000000000000000",
  projectId: "cxxxxxxxxxxxxxxxxxxxxxxxx",
  uploadId: null,
  createdById: "user-000000000000",
  sourcePlatform: "REACT_NEXT_ZIP",
  idempotencyKey: "key-three",
  requestHash: "abc789",
  queueJobId: null,
  status: "SUCCEEDED",
  targetProfile: null,
  errorCode: null,
  errorMessage: null,
  attempt: 0,
  cancelRequestedAt: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const artifactRow = {
  id: "cartifact0000000000000",
  conversionId: "csucceeded000000000000000",
  storageKey: "conversions/cxxxxxxxxxxxxxxxxxxxxxxxx/csucceeded000000000000000/elementor.json",
  fileName: "elementor.json",
  contentType: "application/json",
  sizeBytes: 31n,
  sha256: "abc123",
  status: "READY",
  createdAt: new Date().toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "csessiontest00000000000", userId: "cusersession00000000000" });
  vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" });
  // Transactions pass the mocked prisma client as the tx object so routes that
  // use tx.conversionJob/tx.conversionStage/tx.validationReport/tx.artifact behave.
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: unknown) =>
    (callback as (tx: unknown) => Promise<unknown>)(prisma),
  );
  vi.mocked(storage.stat).mockReset();
  vi.mocked(storage.createReadStream).mockReset();
  vi.mocked(prisma.conversionJob.findUnique).mockReset();
  vi.mocked(prisma.conversionJob.findFirst).mockReset();
  vi.mocked(prisma.conversionJob.findMany).mockReset();
  vi.mocked(prisma.conversionJob.updateMany).mockReset();
  vi.mocked(prisma.conversionStage.updateMany).mockReset();
  vi.mocked(prisma.artifact.findFirst).mockReset();
  vi.mocked(prisma.artifact.findMany).mockReset();
  vi.mocked(prisma.artifact.create).mockReset();
  vi.mocked(prisma.artifact.updateMany).mockReset();
  // Transactions pass the mocked prisma client as the tx object so routes that
  // use tx.conversionJob/tx.conversionStage/tx.validationReport/tx.artifact behave.
  vi.mocked(prisma.$transaction).mockImplementation(async (callback: unknown) =>
    (callback as (tx: unknown) => Promise<unknown>)(prisma),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetRuleCacheForTests();
});

describe("Conversion artifact download endpoint", () => {
  it("409s a queued conversion: CONVERSION_NOT_COMPLETED", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(queuedJob);
    const res = await request(app)
      .get("/api/v1/conversions/cqueued00000000000000000/artifacts/download")
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("CONVERSION_NOT_COMPLETED");
  });

  it("409s a failed conversion: CONVERSION_NOT_COMPLETED", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(readyJobFailed);
    const res = await request(app)
      .get("/api/v1/conversions/cfailed00000000000000000/artifacts/download")
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("CONVERSION_NOT_COMPLETED");
  });

  it("409s a completed conversion that has no persisted artifact rows", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(succeededJob);
    vi.mocked(prisma.artifact.findFirst).mockResolvedValue(null);
    const res = await request(app)
      .get("/api/v1/conversions/csucceeded000000000000000/artifacts/download")
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("CONVERSION_NO_ARTIFACT");
  });

  it("500s when the artifact record exists but the private object is missing", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(succeededJob);
    vi.mocked(prisma.artifact.findFirst).mockResolvedValue(artifactRow);
    // The private object does not exist: storage.stat returns null.
    vi.mocked(storage.stat).mockResolvedValue(null);
    vi.mocked(prisma.artifact.deleteMany).mockResolvedValue({ count: 1 });
    const res = await request(app)
      .get("/api/v1/conversions/csucceeded000000000000000/artifacts/download")
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(500);
    expect(body.error?.code).toBe("ARTIFACT_STORAGE_MISMATCH");
  });

  it("returns the artifact JSON with the correct content type and filename when SUCCEEDED + artifact + storage exists", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(succeededJob);
    vi.mocked(prisma.artifact.findFirst).mockResolvedValue(artifactRow);
    vi.mocked(storage.stat).mockResolvedValue({ sizeBytes: Number(artifactRow.sizeBytes) });
    const expectedJson = { content: [{ id: "sec-hero" }] };
    vi.mocked(storage.createReadStream).mockResolvedValue(Readable.from([Buffer.from(JSON.stringify(expectedJson), "utf8")]));
    const res = await request(app)
      .get("/api/v1/conversions/csucceeded000000000000000/artifacts/download")
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.headers["content-disposition"]).toMatch(/filename="elementor\.json"/);
    expect(res.headers["content-disposition"]).toMatch(/filename\*=UTF-8''elementor\.json/);
    expect(res.headers["content-length"]).toBe(String(artifactRow.sizeBytes));
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.body).toEqual(expectedJson);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/v1/conversions/cqueued00000000000000000/artifacts/download");
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(401);
    expect(body.error?.code).toBe("AUTH_REQUIRED");
  });

  it("404s for an unknown conversion id", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(null);
    const res = await request(app)
      .get("/api/v1/conversions/cnope0000000000000000000/artifacts/download")
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("CONVERSION_NOT_FOUND");
  });
});

describe("Conversion retry endpoint", () => {
  it("requeues a FAILED job exactly once and does not double-claim it", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(readyJobFailed);
    vi.mocked(prisma.conversionJob.updateMany).mockResolvedValue({ count: 1 });
    vi.mocked(prisma.conversionStage.updateMany).mockResolvedValue({ count: 1 });
    const res = await request(app)
      .post("/api/v1/conversions/cfailed00000000000000000/retry")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    expect(res.status).toBe(202);
    const body = res.body as { conversionId: string; status: string };
    expect(body.conversionId).toBe("cfailed00000000000000000");
    expect(body.status).toBe("QUEUED");
  });

  it("409s retrying a job that is already SUCCEEDED", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(succeededJob);
    const res = await request(app)
      .post("/api/v1/conversions/csucceeded000000000000000/retry")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("CONVERSION_NOT_RETRYABLE");
  });

  it("409s retrying a job that is QUEUED", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(queuedJob);
    const res = await request(app)
      .post("/api/v1/conversions/cqueued00000000000000000/retry")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(409);
    expect(body.error?.code).toBe("CONVERSION_NOT_RETRYABLE");
  });

describe("Project conversion history endpoint", () => {
  const PROJECT_ID = "cxxxxxxxxxxxxxxxxxxxxxxxx";

  it("returns an empty list for a project with no conversion jobs", async () => {
    vi.mocked(prisma.conversionJob.findMany).mockResolvedValue([]);
    const res = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = res.body as { conversions: unknown[] };
    expect(body.conversions).toEqual([]);
    expect(prisma.conversionJob.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { projectId: PROJECT_ID } }),
    );
  });

  it("returns the real persisted jobs (with distinct ids) for a project with multiple jobs", async () => {
    vi.mocked(prisma.conversionJob.findMany).mockResolvedValue([
      { id: "cjobone0000000000000000000", status: "SUCCEEDED", sourcePlatform: "REACT_NEXT_ZIP", createdAt: new Date("2026-10-01T00:00:00.000Z"), updatedAt: new Date("2026-10-01T00:05:00.000Z"), artifacts: [{ id: "cart000000000000000000000" }] },
      { id: "cjobtwo0000000000000000000", status: "QUEUED", sourcePlatform: "REACT_NEXT_ZIP", createdAt: new Date("2026-10-02T00:00:00.000Z"), updatedAt: new Date("2026-10-02T00:00:00.000Z"), artifacts: [] },
    ]);
    const res = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = res.body as { conversions: Array<{ id: string; status: string; hasArtifact: boolean }> };
    expect(body.conversions).toHaveLength(2);
    // The returned ids are genuine ConversionJob ids, NOT the project id.
    expect(body.conversions.map((c) => c.id)).toEqual(["cjobone0000000000000000000", "cjobtwo0000000000000000000"]);
    expect(body.conversions.every((c) => c.id !== PROJECT_ID)).toBe(true);
    expect(body.conversions[0]?.hasArtifact).toBe(true);
    expect(body.conversions[1]?.hasArtifact).toBe(false);
  });

  it("returns a single job for a project with one job", async () => {
    vi.mocked(prisma.conversionJob.findMany).mockResolvedValue([
      { id: "cjobone0000000000000000000", status: "RUNNING", sourcePlatform: "FIGMA", createdAt: new Date("2026-10-03T00:00:00.000Z"), updatedAt: new Date("2026-10-03T00:01:00.000Z"), artifacts: [] },
    ]);
    const res = await request(app)
      .get(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = res.body as { conversions: Array<{ id: string; status: string }> };
    expect(body.conversions).toHaveLength(1);
    expect(body.conversions[0]?.id).toBe("cjobone0000000000000000000");
  });

  it("404s a conversion that belongs to another user's project (no membership)", async () => {
    // The signed-in user is not a member of the foreign project.
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/v1/projects/cforeignproject000000000/conversions`)
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("404s an unknown conversion id (details endpoint uses the job id, not a project id)", async () => {
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/v1/conversions/cunknownconversion0000/`)
      .set("Authorization", `Bearer ${TOKEN}`);
    const body = res.body as { error?: { code: string } };
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe("CONVERSION_NOT_FOUND");
  });
});

});

