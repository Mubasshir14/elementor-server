import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

vi.mock("../src/infrastructure/database/prisma.js", () => ({
  prisma: {
    session: { findFirst: vi.fn() },
    project: { findMany: vi.fn(), create: vi.fn() },
    projectMember: { findUnique: vi.fn() },
    upload: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      aggregate: vi.fn(),
    },
    sourceImport: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    conversionJob: { create: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { createApp } from "../src/app.js";
import { prisma } from "../src/infrastructure/database/prisma.js";
import { storage } from "../src/infrastructure/storage/local.js";

const app = createApp();
const token = jwt.sign(
  { sid: "session-test" },
  process.env.JWT_SECRET!,
  { subject: "user-test", issuer: "design-to-elementor-api", expiresIn: "5m" },
);

const PROJECT_ID = "cxxxxxxxxxxxxxxxxxxxxxxxx";
const UPLOAD_ID = "00000000-0000-4000-8000-0000000000ff";
const STORAGE_KEY = `uploads/${PROJECT_ID}/${UPLOAD_ID}.json`;

const figmaFileJson = {
  name: "Landing",
  document: {
    type: "DOCUMENT",
    children: [{ type: "CANVAS", name: "Page 1", children: [{ type: "FRAME", name: "Hero" }] }],
  },
  components: { "1:2": { name: "Button" } },
  styles: {},
};

afterAll(async () => {
  await prisma.$disconnect();
  const storagePath = process.env.LOCAL_STORAGE_PATH;
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

function authenticate() {
  vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
}

function seedFigmaUpload(fileName: string, createdById = "user-test") {
  return {
    id: UPLOAD_ID,
    projectId: PROJECT_ID,
    createdById,
    status: "PENDING",
    storageKey: STORAGE_KEY,
    contentType: "application/json",
    sourceType: "FIGMA",
    fileName,
    sizeBytes: 0n,
  };
}

describe("Figma direct file upload", () => {
  beforeEach(() => {
    vi.mocked(prisma.session.findFirst).mockReset();
    vi.mocked(prisma.projectMember.findUnique).mockReset();
    vi.mocked(prisma.upload.findUnique).mockReset();
    vi.mocked(prisma.upload.update).mockReset();
    vi.mocked(prisma.upload.aggregate).mockReset();
    vi.mocked(prisma.$transaction).mockReset();
    vi.mocked(prisma.sourceImport.create).mockReset();
  });

  afterEach(async () => {
    const alreadyDeleted = await storage.stat(STORAGE_KEY).then((s) => !!s);
    if (alreadyDeleted) await storage.delete(STORAGE_KEY);
  });

  it("requires authentication before reserving a Figma upload", async () => {
    const response = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/uploads`)
      .send({ sourceType: "figma", fileName: "design.json", contentType: "application/json", sizeBytes: 10 });
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("reserves a Figma upload only for project owners/editors and validates .fig/.json formats", async () => {
    authenticate();
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "VIEWER" } as never);

    const viewerResponse = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/uploads`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceType: "figma", fileName: "design.json", contentType: "application/json", sizeBytes: 10 });
    expect(viewerResponse.status).toBe(403);
    expect(viewerResponse.body.error.code).toBe("PROJECT_FORBIDDEN");

    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);

    // Unsupported extension for the Figma source.
    const wrongExt = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/uploads`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceType: "figma", fileName: "design.gif", contentType: "application/octet-stream", sizeBytes: 10 });
    expect(wrongExt.status).toBe(400);
    expect(wrongExt.body.error.code).toBe("FILE_TYPE_MISMATCH");

    // `.json` must not be reserved as a ZIP content type.
    const zipForFigma = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/uploads`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceType: "figma", fileName: "design.json", contentType: "application/zip", sizeBytes: 10 });
    expect(zipForFigma.status).toBe(400);
    expect(zipForFigma.body.error.code).toBe("FILE_TYPE_MISMATCH");

    // A native `.fig` reservation with the binary content type succeeds.
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => await fn({
      $queryRaw: vi.fn(),
      upload: {
        aggregate: vi.fn().mockResolvedValue({ _sum: { sizeBytes: 0n } }),
        create: vi.fn().mockResolvedValue({
          id: "up-1", fileName: "design.fig", contentType: "application/octet-stream", sizeBytes: 10n, status: "PENDING",
        }),
      },
    }) as any);
    const figOk = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/uploads`)
      .set("Authorization", `Bearer ${token}`)
      .send({ sourceType: "figma", fileName: "design.fig", contentType: "application/octet-stream", sizeBytes: 10 });
    expect(figOk.status).toBe(201);
    expect(figOk.body.upload.fileName).toBe("design.fig");
  });

  it("validates and parses an uploaded Figma file, storing it privately with ownership", async () => {
    authenticate();
    const bytes = Buffer.from(JSON.stringify(figmaFileJson), "utf8");
    await storage.write(STORAGE_KEY, Readable.from([bytes]), bytes.length);
    vi.mocked(prisma.upload.findUnique).mockResolvedValue({
      ...seedFigmaUpload("design.json"),
      sizeBytes: BigInt(bytes.length),
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.upload.update).mockImplementation(async (args: any) => args.data as never);
    vi.mocked(prisma.sourceImport.create).mockResolvedValue({
      id: "import-1",
      kind: "FIGMA_FILE",
      status: "READY",
      fileName: "Landing",
      summary: {},
      diagnostics: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    const response = await request(app)
      .post(`/api/v1/uploads/${UPLOAD_ID}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.upload.status).toBe("READY");
    expect(response.body.upload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(response.body.sourceImport.kind).toBe("FIGMA_FILE");
    expect(prisma.sourceImport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "FIGMA_FILE", projectId: PROJECT_ID, createdById: "user-test" }),
    }));

    await storage.delete(STORAGE_KEY);
  });

  it("recovers real design structure from an uploaded native .fig file", async () => {
    authenticate();
    const figBytes = readFileSync(join(__dirname, "fixtures", "design.fig"));
    await storage.write(STORAGE_KEY, Readable.from([figBytes]), figBytes.length);
    vi.mocked(prisma.upload.findUnique).mockResolvedValue({
      ...seedFigmaUpload("design.fig"),
      sizeBytes: BigInt(figBytes.length),
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.upload.update).mockImplementation(async (args: any) => args.data as never);
    vi.mocked(prisma.sourceImport.create).mockResolvedValue({
      id: "import-fig",
      kind: "FIGMA_FILE",
      status: "READY",
      fileName: "Design Test",
      summary: {},
      diagnostics: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } as never);

    const response = await request(app)
      .post(`/api/v1/uploads/${UPLOAD_ID}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(200);
    expect(response.body.upload.status).toBe("READY");
    expect(response.body.sourceImport.kind).toBe("FIGMA_FILE");
    expect(response.body.sourceImport.fileName).toBe("Design Test");
    expect(prisma.sourceImport.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ kind: "FIGMA_FILE", projectId: PROJECT_ID, createdById: "user-test" }),
    }));
    const createArgs = vi.mocked(prisma.sourceImport.create).mock.calls[0]?.[0] as any;
    expect(createArgs.data.summary.pageCount).toBeGreaterThanOrEqual(1);
    expect(createArgs.data.summary.nodeCount).toBeGreaterThanOrEqual(5);
    expect(createArgs.data.diagnostics[0].code).toBe("FIGMA_NATIVE_PARSED_LOCALLY");

    await storage.delete(STORAGE_KEY);
  });

  it("rejects a mislabeled or malformed Figma payload and never reports a successful parse", async () => {
    authenticate();
    const nativeBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("binary-canvas.fig-data", "latin1"),
    ]);
    await storage.write(STORAGE_KEY, Readable.from([nativeBytes]), nativeBytes.length);
    vi.mocked(prisma.upload.findUnique).mockResolvedValue({
      ...seedFigmaUpload("design.json"),
      sizeBytes: BigInt(nativeBytes.length),
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.upload.update).mockImplementation(async (args: never) => args as never);

    const response = await request(app)
      .post(`/api/v1/uploads/${UPLOAD_ID}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe("FIGMA_NATIVE_FILE_UNSUPPORTED");
    expect(prisma.sourceImport.create).not.toHaveBeenCalled();
    expect(prisma.upload.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "REJECTED" }),
    }));

    await storage.delete(STORAGE_KEY);
  });

  it("does not let a viewer complete another user's Figma upload", async () => {
    authenticate();
    const bytes = Buffer.from(JSON.stringify(figmaFileJson), "utf8");
    await storage.write(STORAGE_KEY, Readable.from([bytes]), bytes.length);
    vi.mocked(prisma.upload.findUnique).mockResolvedValue({
      ...seedFigmaUpload("design.json", "someone-else"),
      sizeBytes: BigInt(bytes.length),
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "VIEWER" } as never);

    const response = await request(app)
      .post(`/api/v1/uploads/${UPLOAD_ID}/complete`)
      .set("Authorization", `Bearer ${token}`)
      .send({});

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PROJECT_FORBIDDEN");

    await storage.delete(STORAGE_KEY);
  });
});

