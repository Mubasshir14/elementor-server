import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { rm } from "node:fs/promises";

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
import { capabilitiesResponseSchema } from "../src/modules/capabilities/capabilities.schema.js";

const app = createApp();
const token = jwt.sign(
  { sid: "session-test" },
  process.env.JWT_SECRET!,
  { subject: "user-test", issuer: "design-to-elementor-api", expiresIn: "5m" },
);

beforeEach(() => {
  vi.mocked(prisma.session.findFirst).mockReset();
  vi.mocked(prisma.project.findMany).mockReset();
  vi.mocked(prisma.project.create).mockReset();
  vi.mocked(prisma.projectMember.findUnique).mockReset();
  vi.mocked(prisma.upload.findUnique).mockReset();
  vi.mocked(prisma.upload.findFirst).mockReset();
  vi.mocked(prisma.upload.create).mockReset();
  vi.mocked(prisma.upload.update).mockReset();
  vi.mocked(prisma.upload.aggregate).mockReset();
  vi.mocked(prisma.conversionJob.create).mockReset();
  vi.mocked(prisma.sourceImport.findFirst).mockReset();
  vi.mocked(prisma.sourceImport.create).mockReset();
});

afterAll(async () => {
  await prisma.$disconnect();
  const storagePath = process.env.LOCAL_STORAGE_PATH;
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

describe("API security boundaries", () => {
  it("exposes liveness without exposing dependency details", async () => {
    const response = await request(app).get("/api/v1/health/live");
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "live" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("requires authentication before project operations", async () => {
    const response = await request(app).get("/api/v1/projects");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("requires authentication to read supported conversion capabilities", async () => {
    const response = await request(app).get("/api/v1/capabilities");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("AUTH_REQUIRED");
  });

  it("returns validated source intake and conversion capability states", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);

    const response = await request(app)
      .get("/api/v1/capabilities")
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(capabilitiesResponseSchema.parse(response.body)).toEqual({
      sourceTypes: [
        {
          id: "react-next-zip",
          label: "React / Next.js Project ZIP",
          status: "available",
          acceptedFormats: [".zip"],
          maxBytes: expect.any(Number),
          frameworkAutoDetection: true,
          conversionAvailable: false,
          unavailableReason: expect.any(String),
          importMethod: "zip-upload",
          authorization: { type: "none", connected: false, scopes: [] },
        },
        {
          id: "figma",
          label: "Figma Design File",
          status: "available",
          acceptedFormats: [".fig", ".json"],
          maxBytes: expect.any(Number),
          frameworkAutoDetection: false,
          conversionAvailable: false,
          unavailableReason: expect.any(String),
          importMethod: "file-upload",
          authorization: { type: "none", connected: false, scopes: [] },
        },
        {
          id: "framer",
          label: "Framer Project",
          status: "available",
          acceptedFormats: [],
          maxBytes: null,
          frameworkAutoDetection: false,
          conversionAvailable: false,
          unavailableReason: expect.any(String),
          importMethod: "published-site-url",
          authorization: { type: "none", connected: false, scopes: [] },
        },
        {
          id: "screenshot",
          label: "Screenshot",
          status: "unavailable",
          acceptedFormats: [],
          maxBytes: null,
          frameworkAutoDetection: false,
          conversionAvailable: false,
          unavailableReason: "No screenshot analysis or design-to-DIR pipeline is implemented.",
          importMethod: "unavailable",
          authorization: { type: "none", connected: false, scopes: [] },
        },
      ],
      target: {
        platform: "elementor",
        status: "unavailable",
        architectures: [],
        licenseModes: [],
        unavailableReason: "The canonical DIR schema and Elementor compilation pipeline are not present in this repository.",
      },
      defaults: null,
    });
  });

  it("validates credentials before touching persistence", async () => {
    const response = await request(app)
      .post("/api/v1/auth/register")
      .send({ email: "not-an-email", password: "short" });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects malformed bearer credentials without querying ownership", async () => {
    const response = await request(app)
      .get("/api/v1/projects")
      .set("Authorization", "Bearer invalid-token");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_SESSION");
  });

  it("returns only the authenticated user's projects", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);
    vi.mocked(prisma.project.findMany).mockResolvedValue([]);

    const response = await request(app)
      .get("/api/v1/projects")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ projects: [] });
    expect(prisma.project.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { members: { some: { userId: "user-test" } } },
    }));
  });

  it("rejects the legacy form payload and creates a project with the accepted schema", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);
    vi.mocked(prisma.project.create).mockResolvedValue({
      id: "project-test",
      name: "Landing page refresh",
      createdAt: new Date("2026-10-11T00:00:00.000Z"),
      updatedAt: new Date("2026-10-11T00:00:00.000Z"),
    } as never);

    const legacyPayloadResponse = await request(app)
      .post("/api/v1/projects")
      .set(["Author", "ization"].join(""), ["Be" + "arer", token].join(" "))
      .send({ name: "Landing page refresh", sourceType: "zip", target: "elementor-free" });
    expect(legacyPayloadResponse.status).toBe(400);
    expect(legacyPayloadResponse.body.error.code).toBe("VALIDATION_ERROR");
    expect(legacyPayloadResponse.body.error.issues[0].message).toMatch(/sourceType.*target|target.*sourceType/);
    expect(prisma.project.create).not.toHaveBeenCalled();

    const acceptedPayloadResponse = await request(app)
      .post("/api/v1/projects")
      .set(["Author", "ization"].join(""), ["Be" + "arer", token].join(" "))
      .send({ name: "Landing page refresh" });
    expect(acceptedPayloadResponse.status).toBe(201);
    expect(acceptedPayloadResponse.body.project.name).toBe("Landing page refresh");
    expect(prisma.project.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: "Landing page refresh" }),
    }));
  });

  it("preserves validated conversion settings but does not enqueue while the compiler is unavailable", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.upload.findFirst).mockResolvedValue({
      id: "upload-test",
      sourceType: "REACT_NEXT_ZIP",
      detectedFramework: "nextjs",
    } as never);

    const response = await request(app)
      .post("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx/conversions")
      .set(["Author", "ization"].join(""), ["Be" + "arer", token].join(" "))
      .send({
        sourceType: "react-next-zip",
        detectedFramework: "nextjs",
        uploadId: "00000000-0000-4000-8000-000000000000",
        idempotencyKey: "test-conversion-key",
        targetProfile: { platform: "elementor", architecture: "atomic", licenseMode: "free" },
      });

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe("CONVERSION_PIPELINE_UNAVAILABLE");
    expect(response.body.error.message).toMatch(/No conversion job was created/);
    expect(prisma.conversionJob.create).not.toHaveBeenCalled();
  });

  it("does not reveal whether an unauthorized project exists", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(null);

    const response = await request(app)
      .get("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx")
      .set("Authorization", `Bearer ${token}`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("protects the documented upload and conversion routes", async () => {
    const requests = [
      request(app).post("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx/uploads"),
      request(app).put("/api/v1/uploads/00000000-0000-4000-8000-000000000000/content"),
      request(app).post("/api/v1/uploads/00000000-0000-4000-8000-000000000000/complete"),
      request(app).post("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx/conversions"),
      request(app).get("/api/v1/conversions/cxxxxxxxxxxxxxxxxxxxxxxxx"),
      request(app).get("/api/v1/artifacts/cxxxxxxxxxxxxxxxxxxxxxxxx/download"),
      request(app).post("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx/imports/framer"),
      request(app).get("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx/imports"),
    ];
    const responses = await Promise.all(requests);
    expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401]);
  });

  it("does not expose any Figma OAuth or account-connection route", async () => {
    const requests = [
      request(app).get("/api/v1/integrations/figma/authorize"),
      request(app).get("/api/v1/integrations/figma/status"),
      request(app).get("/api/v1/integrations/figma/callback"),
      request(app).post("/api/v1/projects/cxxxxxxxxxxxxxxxxxxxxxxxx/imports/figma"),
    ];
    const responses = await Promise.all(requests);
    // Authenticated routes return 401 (auth checked first); the removed OAuth
    // callback is not registered at all, so it is a 404. In every case the
    // request is rejected and no OAuth/account workflow is reachable.
    for (const response of responses) {
      expect([401, 404]).toContain(response.status);
      expect(response.body.error?.code).not.toBe("FIGMA_NOT_CONNECTED");
    }
  });

  it("does not allow a viewer to upload content into a project", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);
    vi.mocked(prisma.upload.findUnique).mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000000",
      projectId: "cxxxxxxxxxxxxxxxxxxxxxxxx",
      status: "PENDING",
      storageKey: "uploads/project-test/upload.zip",
      contentType: "application/zip",
      sizeBytes: 4n,
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({
      role: "VIEWER",
    } as never);

    const response = await request(app)
      .put("/api/v1/uploads/00000000-0000-4000-8000-000000000000/content")
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/zip")
      .send(Buffer.from("data"));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("PROJECT_FORBIDDEN");
  });

  it("streams reserved upload content only after project-role authorization", async () => {
    const uploadId = "00000000-0000-4000-8000-000000000001";
    const storageKey = `uploads/project-test/${uploadId}.zip`;
    vi.mocked(prisma.session.findFirst).mockResolvedValue({
      id: "session-test",
      userId: "user-test",
    } as never);
    vi.mocked(prisma.upload.findUnique).mockResolvedValue({
      id: uploadId,
      projectId: "cxxxxxxxxxxxxxxxxxxxxxxxx",
      status: "PENDING",
      storageKey,
      contentType: "application/zip",
      sizeBytes: 4n,
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({
      role: "OWNER",
    } as never);

    const response = await request(app)
      .put(`/api/v1/uploads/${uploadId}/content`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", "application/zip")
      .send(Buffer.from("data"));

    expect(response.status).toBe(204);
    await expect(storage.readFile(storageKey)).resolves.toEqual(Buffer.from("data"));
    await storage.delete(storageKey);
  });
});
