import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

vi.mock("../src/infrastructure/database/prisma.js", () => ({
  prisma: {
    session: { findFirst: vi.fn() },
    projectMember: { findUnique: vi.fn() },
    sourceImport: { findFirst: vi.fn() },
    conversionJob: { findUnique: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findFirst: vi.fn() },
    conversionStage: { createMany: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    ruleFileVersion: { upsert: vi.fn() },
    conversionRuleVersion: { create: vi.fn() },
    validationReport: { upsert: vi.fn() },
    artifact: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn(),
    $disconnect: vi.fn(),
  },
}));

import { createApp } from "../src/app.js";
import { prisma } from "../src/infrastructure/database/prisma.js";
import { storage } from "../src/infrastructure/storage/local.js";
import { generateElementorOutput } from "../src/modules/conversions/elementor-generator.js";
import {
  validateElementorOutput,
  assertValidElementorOutput,
  assertElementorCoversDirSections,
  assertElementorJsonRoundTrip,
} from "../src/modules/conversions/elementor-output-schema.js";
import {
  runConversionPipeline,
  persistElementorArtifact,
} from "../src/modules/conversions/conversion-pipeline.js";
import * as aiProvider from "../src/infrastructure/ai/provider.js";
import { resetRuleCacheForTests } from "../src/modules/rules/rule-loader.js";

const app = createApp();
const token = jwt.sign(
  { sid: "session-test" },
  process.env.JWT_SECRET!,
  { subject: "user-test", issuer: "design-to-elementor-api", expiresIn: "5m" },
);

const PROJECT_ID = "cxxxxxxxxxxxxxxxxxxxxxxxx";
const SOURCE_IMPORT_ID = "csourceimport000000000000";
const ARTIFACT_ID = "cartifacttest0000000000000";

const validDir = {
  version: 1,
  meta: { name: "Landing" },
  breakpoints: {},
  globals: {},
  assets: [],
  pages: [
    {
      sections: [
        {
          role: "hero",
          children: [{ kind: "heading", text: "Hello", level: "h1" }],
        },
      ],
    },
  ],
};

const validElementorOutput = {
  title: "Landing",
  type: "page",
  version: "0.4",
  page_settings: [],
  content: [
    {
      id: "sec-hero",
      elType: "container",
      isInner: false,
      settings: { _section_role: "hero", _css_id: "sec-hero" },
      elements: [
        {
          id: "wdg-heading",
          elType: "widget",
          isInner: false,
          widgetType: "heading",
          settings: { title: "Hello", header_size: "h1" },
          elements: [],
        },
      ],
    },
  ],
};

/** The reported elementor14.json failure shape: valid JSON, import-rejected. */
const elementor14FailureShape = {
  content: [
    {
      id: "section-header",
      elType: "container",
      settings: {},
      elements: [
        {
          id: "btn-1",
          elType: "widget",
          widgetType: "button",
          settings: { text: "Home" },
          elements: [],
        },
      ],
    },
    {
      id: "section-footer",
      elType: "container",
      settings: {},
      elements: [
        {
          id: "txt-1",
          elType: "widget",
          widgetType: "text-editor",
          settings: { editor: "<p>Footer</p>" },
          elements: [],
        },
      ],
    },
  ],
};

/** Genuine Elementor-exported reference shape (developer docs, General Structure). */
const genuineElementorReference = {
  title: "Sample Page",
  type: "page",
  version: "0.4",
  page_settings: [],
  content: [
    {
      id: "6af611eb",
      elType: "container",
      isInner: false,
      settings: [],
      elements: [
        {
          id: "6a637978",
          elType: "widget",
          widgetType: "heading",
          isInner: false,
          settings: { title: "Add Your Heading Text Here", align: "center" },
          elements: [],
        },
      ],
    },
  ],
};

/** Stub fetch with queued OpenAI-compatible completions (one per model call). */
function stubFetch(contents: Array<() => unknown>) {
  const fetchMock = vi.fn();
  for (const make of contents) {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: make() } }] }),
    });
  }
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function generationContext() {
  return { projectId: PROJECT_ID, conversionId: "conversion-test", sourceType: "figma" as const };
}

beforeEach(() => {
  process.env.AI_PROVIDER = "groq";
  process.env.AI_API_KEY = "test-api-key";
  process.env.AI_MODEL = "test-model";
  vi.mocked(prisma.session.findFirst).mockReset();
  vi.mocked(prisma.projectMember.findUnique).mockReset();
  vi.mocked(prisma.sourceImport.findFirst).mockReset();
  vi.mocked(prisma.conversionJob.findUnique).mockReset();
  vi.mocked(prisma.conversionJob.create).mockReset();
  vi.mocked(prisma.$transaction).mockReset();
  vi.mocked(prisma.artifact.create).mockReset();
  vi.mocked(prisma.artifact.findFirst).mockReset();
  vi.mocked(prisma.artifact.findMany).mockReset();
  resetRuleCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.AI_PROVIDER = "disabled";
  process.env.AI_API_KEY = "";
  process.env.AI_MODEL = "";
  resetRuleCacheForTests();
});

afterAll(async () => {
  await prisma.$disconnect();
  const storagePath = process.env.LOCAL_STORAGE_PATH;
  if (storagePath) await rmSync(storagePath, { recursive: true, force: true });
});

describe("Elementor output validation (documented structural contract)", () => {
  it("accepts a valid native Elementor document and preserves nested elements", () => {
    const result = validateElementorOutput(validElementorOutput);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.output?.content).toHaveLength(1);
    expect(result.output?.type).toBe("page");
    expect(result.output?.version).toBe("0.4");
    const section = result.output?.content[0] as { elements?: unknown[] };
    expect(section.elements).toHaveLength(1);
  });

  it("accepts a genuine Elementor-exported reference shape (settings as [])", () => {
    const result = validateElementorOutput(genuineElementorReference);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("rejects the reported elementor14.json shape: valid JSON is not importable without a template type", () => {
    // Regression: elementor14.json parsed as JSON but Elementor rejected it
    // with "Invalid template type" because the envelope had no type/title.
    const result = validateElementorOutput(elementor14FailureShape);
    expect(result.valid).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("ELEMENTOR_TITLE_MISSING");
    expect(codes).toContain("ELEMENTOR_TYPE_MISSING");
    expect(codes).toContain("ELEMENTOR_VERSION_MISSING");
    expect(codes).toContain("ELEMENTOR_PAGE_SETTINGS_MISSING");
  });

  it("rejects unknown template types instead of guessing", () => {
    const result = validateElementorOutput({
      title: "X",
      type: "elementor",
      version: "0.4",
      page_settings: [],
      content: [],
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("ELEMENTOR_TYPE_INVALID");
  });

  it("rejects unsupported versions, bad page_settings, elTypes, widget types, and missing widget settings", () => {
    const badVersion = validateElementorOutput({
      title: "X",
      type: "page",
      version: "9.9",
      page_settings: [],
      content: [],
    });
    expect(badVersion.issues[0]?.code).toBe("ELEMENTOR_VERSION_UNSUPPORTED");

    const badSettings = validateElementorOutput({
      title: "X",
      type: "page",
      version: "0.4",
      page_settings: "nope",
      content: [],
    });
    expect(badSettings.issues[0]?.code).toBe("ELEMENTOR_PAGE_SETTINGS_INVALID");

    const badElType = validateElementorOutput({
      title: "X",
      type: "page",
      version: "0.4",
      page_settings: [],
      content: [{ id: "a", elType: "e-section", settings: {}, elements: [] }],
    });
    expect(badElType.issues[0]?.code).toBe("ELEMENTOR_EL_TYPE_INVALID");

    const badWidget = validateElementorOutput({
      title: "X",
      type: "page",
      version: "0.4",
      page_settings: [],
      content: [
        {
          id: "a",
          elType: "container",
          settings: {},
          elements: [{ id: "b", elType: "widget", widgetType: "super-carousel-9000", settings: {}, elements: [] }],
        },
      ],
    });
    expect(badWidget.issues[0]?.code).toBe("ELEMENTOR_WIDGET_TYPE_UNSUPPORTED");

    const missingControl = validateElementorOutput({
      title: "X",
      type: "page",
      version: "0.4",
      page_settings: [],
      content: [
        {
          id: "a",
          elType: "container",
          settings: {},
          elements: [{ id: "b", elType: "widget", widgetType: "heading", settings: {}, elements: [] }],
        },
      ],
    });
    expect(missingControl.issues[0]?.code).toBe("ELEMENTOR_WIDGET_SETTING_MISSING");
  });

  it("detects missing DIR sections and verifies ordering + JSON round-trip", () => {
    const dir = {
      pages: [{ sections: [{ role: "hero" }, { role: "features" }, { role: "footer" }] }],
    };
    const partial = validateElementorOutput({
      title: "Landing",
      type: "page",
      version: "0.4",
      page_settings: [],
      content: [
        {
          id: "sec-hero",
          elType: "container",
          settings: { _section_role: "hero" },
          elements: [],
        },
        {
          id: "sec-footer",
          elType: "container",
          settings: { _section_role: "footer" },
          elements: [],
        },
      ],
    });
    expect(partial.valid).toBe(true);
    const coverage = assertElementorCoversDirSections(partial.output!, dir);
    expect(coverage.map((i) => i.code)).toContain("ELEMENTOR_SECTION_MISSING");
    expect(assertElementorJsonRoundTrip(partial.output!)).toEqual([]);
  });

  it("rejects non-object roots and missing content arrays with actionable diagnostics", () => {
    expect(validateElementorOutput("nope").issues[0]?.code).toBe("ELEMENTOR_NOT_OBJECT");
    expect(validateElementorOutput(null).issues[0]?.code).toBe("ELEMENTOR_NOT_OBJECT");
    const noTitle = validateElementorOutput({ sections: [] });
    expect(noTitle.valid).toBe(false);
    expect(noTitle.issues[0]?.code).toBe("ELEMENTOR_TITLE_MISSING");
    expect(noTitle.issues[1]?.code).toBe("ELEMENTOR_TYPE_MISSING");
    expect(noTitle.issues[2]?.code).toBe("ELEMENTOR_VERSION_MISSING");
    expect(noTitle.issues[3]?.code).toBe("ELEMENTOR_PAGE_SETTINGS_MISSING");
    expect(noTitle.issues[4]?.code).toBe("ELEMENTOR_CONTENT_NOT_ARRAY");
  });

  it("identifies the failing path for malformed nodes, ids, types, and nesting", () => {
    const bad = {
      title: "X",
      type: "page",
      version: "0.4",
      page_settings: [],
      content: [
        { elType: "container", settings: {}, elements: [] },
        { id: "", elType: "container", settings: {}, elements: [] },
        { id: "bad id!", elType: "container", settings: {}, elements: [] },
        { id: "sec-3", elType: "", settings: "not-an-object", elements: [] },
        { id: "sec-3", elType: "container", settings: {}, elements: [] },
        { id: "sec-5", elType: "container", settings: {}, elements: "nope" },
        "not-a-node",
      ],
    };
    const result = validateElementorOutput(bad);
    expect(result.valid).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("ELEMENTOR_ID_MISSING");
    expect(codes).toContain("ELEMENTOR_ID_INVALID");
    expect(codes).toContain("ELEMENTOR_EL_TYPE_MISSING");
    expect(codes).toContain("ELEMENTOR_SETTINGS_NOT_OBJECT");
    expect(codes).toContain("ELEMENTOR_ID_DUPLICATE");
    expect(codes).toContain("ELEMENTOR_ELEMENTS_NOT_ARRAY");
    expect(codes).toContain("ELEMENTOR_NODE_NOT_OBJECT");
    expect(result.issues.some((i) => i.path.startsWith("content["))).toBe(true);
  });

  it("recursively validates nested widgets with widgetType", () => {
    const nested = {
      title: "X",
      type: "page",
      version: "0.4",
      page_settings: [],
      content: [
        {
          id: "sec",
          elType: "container",
          settings: {},
          elements: [{ id: "wid", elType: "widget", widgetType: 42, settings: {}, elements: [] }],
        },
      ],
    };
    const result = validateElementorOutput(nested);
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("ELEMENTOR_WIDGET_TYPE_MISSING");
    expect(result.issues[0]?.path).toBe("content[0].elements[0].widgetType");
  });

  it("assertValidElementorOutput throws an actionable HttpError for invalid output", () => {
    expect(() =>
      assertValidElementorOutput({ title: "X", type: "page", version: "0.4", page_settings: [], content: [{ elType: "x" }] }),
    ).toThrowError(/did not match the approved schema/);
    expect(() => assertValidElementorOutput(validElementorOutput)).not.toThrow();
  });
});

describe("Elementor generation module (Markdown rules drive the AI request)", () => {
  it("sends the current ELEMENTOR_SKILL.md content as trusted system instructions", async () => {
    const fetchMock = stubFetch([() => JSON.stringify(validElementorOutput)]);
    const result = await generateElementorOutput(validDir, generationContext());

    expect(result.output.content).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("Elementor Target Rules");
    expect(body.messages[0].content).toContain("elementor-conversion-rulebook");
    // The DIR rides as untrusted data, never merged into the system prompt.
    expect(body.messages[1].content).toContain("BEGIN UNTRUSTED-DESIGN");
    expect(body.messages[1].content).toContain("Landing");
    expect(body.messages[0].content).not.toContain("BEGIN UNTRUSTED-DESIGN");
  });

  it("uses edited rule files for subsequent generations without code changes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "elementor-rules-"));
    try {
      writeFileSync(join(dir, "FIGMA.md"), "# source rules v1");
      writeFileSync(join(dir, "ELEMENTOR_SKILL.md"), "# ELEMENTOR-RULE-V1");
      const fetchMock = stubFetch([
        () => JSON.stringify(validElementorOutput),
        () => JSON.stringify(validElementorOutput),
      ]);

      await generateElementorOutput(validDir, generationContext(), { rootDir: dir });
      writeFileSync(join(dir, "ELEMENTOR_SKILL.md"), "# ELEMENTOR-RULE-V2-EDITED");
      await generateElementorOutput(validDir, generationContext(), { rootDir: dir });

      const first = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
      const second = JSON.parse(String((fetchMock.mock.calls[1] as [string, RequestInit])[1].body));
      expect(first.messages[0].content).toContain("ELEMENTOR-RULE-V1");
      expect(second.messages[0].content).toContain("ELEMENTOR-RULE-V2-EDITED");
      expect(second.messages[0].content).not.toContain("ELEMENTOR-RULE-V1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never fabricates output when the AI provider is disabled", async () => {
    process.env.AI_PROVIDER = "disabled";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(generateElementorOutput(validDir, generationContext())).rejects.toMatchObject({
      code: "AI_PROVIDER_DISABLED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces provider HTTP failures instead of producing output", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, text: async () => "upstream" }));
    await expect(generateElementorOutput(validDir, generationContext())).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
    });
  });

  it("rejects malformed model JSON and structurally invalid Elementor output", async () => {
    stubFetch([() => "this is not json"]);
    await expect(generateElementorOutput(validDir, generationContext())).rejects.toMatchObject({
      code: "ELEMENTOR_JSON_UNPARSEABLE",
    });

    stubFetch([() => JSON.stringify({ foo: 1 })]);
    await expect(generateElementorOutput(validDir, generationContext())).rejects.toMatchObject({
      code: "ELEMENTOR_OUTPUT_INVALID",
    });
  });
});

describe("Pipeline integration (validated DIR reaches generation)", () => {
  const snapshotKey = "imports/pipeline-ok/snapshot.json";
  const blockedSnapshotKey = "imports/pipeline-block/snapshot.json";

  async function writeSnapshot(key: string, dirOrJson: unknown) {
    const bytes = Buffer.from(typeof dirOrJson === "string" ? dirOrJson : JSON.stringify(dirOrJson), "utf8");
    const existing = await storage.stat(key);
    if (!existing) await storage.write(key, Readable.from([bytes]), bytes.length);
  }

  it("proceeds from a valid DIR to real generation and returns native Elementor output", async () => {
    await writeSnapshot(snapshotKey, {
      pages: [{ sections: [{ role: "hero", children: [{ kind: "heading", text: "Hello", level: "h1" }] }] }],
    });
    const fetchMock = stubFetch([
      () => JSON.stringify(validDir),
      () => JSON.stringify(validElementorOutput),
    ]);

    const result = await runConversionPipeline(
      { sourceType: "figma", snapshotKey },
      snapshotKey,
      { projectId: PROJECT_ID, conversionId: "conv-pipeline-ok", sourceType: "figma" },
    );

    expect(result.status).toBe("SUCCEEDED");
    if (result.status !== "SUCCEEDED") throw new Error("expected success");
    expect(result.elementorOutput.content[0]?.id).toBe("sec-hero");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const fileNames = result.ruleVersions.map((r) => r.fileName);
    expect(fileNames).toContain("FIGMA.md");
    expect(fileNames).toContain("ELEMENTOR_SKILL.md");
  });

  it("blocks at source_ir_validation for an invalid DIR and never calls the generator", async () => {
    // Ensure the snapshot fixture exists so the pipeline can read the source
    // design before it attempts to generate a canonical DIR.
    await writeSnapshot(blockedSnapshotKey, {
      pages: [
        {
          sections: [
            {
              role: "hero",
              children: [{ kind: "heading", text: "Hello" }],
            },
          ],
        },
      ],
    });

    const invalidDir = JSON.stringify({ pages: [{ sections: "not-an-array" }] });

    const requestCompletionSpy = vi.spyOn(aiProvider, "requestConversionCompletion");
    requestCompletionSpy.mockResolvedValue({
      text: invalidDir,
      provider: "groq",
      model: "test-model",
      ruleVersions: [],
    });

    const result = await runConversionPipeline(
      { sourceType: "figma", snapshotKey: blockedSnapshotKey },
      blockedSnapshotKey,
      { projectId: PROJECT_ID, conversionId: "conv-pipeline-block", sourceType: "figma" },
    );

    expect(result.status).toBe("BLOCKED");
    if (result.status !== "BLOCKED") throw new Error("expected blocked");
    expect(result.stage).toBe("source_ir_validation");
    expect(result.diagnostics[0]?.code).toBe("DIR_SECTIONS_NOT_ARRAY");
    expect(requestCompletionSpy).toHaveBeenCalledTimes(1);
    requestCompletionSpy.mockRestore();
  });

  it("propagates AI provider failures instead of marking success", async () => {
    await writeSnapshot(snapshotKey, {
      pages: [{ sections: [{ role: "hero", children: [{ kind: "heading", text: "Hello" }] }] }],
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    await expect(
      runConversionPipeline(
        { sourceType: "figma", snapshotKey },
        snapshotKey,
        { projectId: PROJECT_ID, conversionId: "conv-pipeline-fail", sourceType: "figma" },
      ),
    ).rejects.toMatchObject({ code: "AI_PROVIDER_UNREACHABLE" });
  });
});

describe("Artifact persistence (private storage + DB record)", () => {
  it("stores the validated output privately and records a matching Artifact row", async () => {
    vi.mocked(prisma.artifact.create).mockResolvedValue({ id: "art-1" } as never);
    const projectId = "cprojectartifact00000000001";
    const conversionId = "cconversionartifact0000001";

    const result = await persistElementorArtifact(projectId, conversionId, validElementorOutput);

    expect(result.storageKey).toBe(`conversions/${projectId}/${conversionId}/elementor.json`);
    expect(result.contentType).toBe("application/json");
    // Bytes really landed in private local storage.
    const stored = await storage.readFile(result.storageKey);
    expect(JSON.parse(stored.toString("utf8"))).toEqual(validElementorOutput);
    const sha = createHash("sha256").update(stored).digest("hex");
    expect(result.sha256).toBe(sha);
    expect(result.sizeBytes).toBe(stored.length);
    // DB record mirrors the actual bytes.
    expect(prisma.artifact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        projectId,
        conversionId,
        storageKey: result.storageKey,
        fileName: "elementor.json",
        contentType: "application/json",
        sizeBytes: BigInt(stored.length),
        sha256: sha,
        status: "READY",
      }),
    }));
  });

  it("fails loudly and leaves no dangling file when Artifact persistence fails", async () => {
    vi.mocked(prisma.artifact.create).mockRejectedValue(new Error("db write failed"));
    const projectId = "cprojectartfail0000000001";
    const conversionId = "cconversionartfail000001";
    const storageKey = `conversions/${projectId}/${conversionId}/elementor.json`;

    await expect(persistElementorArtifact(projectId, conversionId, validElementorOutput)).rejects.toThrow(
      /db write failed/,
    );
    expect(await storage.stat(storageKey)).toBeNull();
    expect(prisma.artifact.create).toHaveBeenCalledTimes(1);
  });
});

describe("Conversion creation API (job + stages + persisted rules)", () => {
  function mockTx() {
    return {
      conversionJob: { create: vi.fn().mockResolvedValue({ id: "conv-created-1", status: "QUEUED" }) },
      conversionStage: { createMany: vi.fn(), update: vi.fn() },
      ruleFileVersion: { upsert: vi.fn().mockResolvedValue({ id: "rv-1" }) },
      conversionRuleVersion: { create: vi.fn() },
    };
  }

  function figmaPayload(idempotencyKey: string) {
    return {
      sourceType: "figma",
      sourceImportId: SOURCE_IMPORT_ID,
      idempotencyKey,
      targetProfile: { platform: "elementor", architecture: "atomic", licenseMode: "free" },
    };
  }

  it("creates a QUEUED job with stages and rule versions for a ready Figma import", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.sourceImport.findFirst).mockResolvedValue({ id: SOURCE_IMPORT_ID, kind: "FIGMA_FILE" } as never);
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue(null as never);
    const tx = mockTx();
    vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => await fn(tx) as any);

    const response = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${token}`)
      .send(figmaPayload("idem-key-figma-create-1"));

    expect(response.status).toBe(201);
    expect(response.body.conversion.status).toBe("QUEUED");
    expect(response.body.idempotentReplay).toBe(false);
    expect(tx.conversionJob.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ projectId: PROJECT_ID, sourcePlatform: "FIGMA", status: "QUEUED" }),
    }));
    expect(tx.conversionStage.createMany).toHaveBeenCalledTimes(1);
    expect(tx.ruleFileVersion.upsert).toHaveBeenCalled();
    expect(tx.conversionRuleVersion.create).toHaveBeenCalledTimes(2);
  });

  it("replays idempotently without creating a duplicate job", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.sourceImport.findFirst).mockResolvedValue({ id: SOURCE_IMPORT_ID, kind: "FIGMA_FILE" } as never);
    const replayHash = createHash("sha256").update(JSON.stringify({
      sourceType: "figma",
      detectedFramework: null,
      sourceImportId: SOURCE_IMPORT_ID,
      uploadId: null,
      targetProfile: { platform: "elementor", architecture: "atomic", licenseMode: "free" },
    })).digest("hex");
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue({ id: "conv-existing", status: "QUEUED", requestHash: replayHash } as never);
    vi.mocked(prisma.$transaction).mockResolvedValue(undefined as never);

    const response = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${token}`)
      .send(figmaPayload("idem-key-figma-replay-1"));

    expect(response.status).toBe(200);
    expect(response.body.idempotentReplay).toBe(true);
    expect(response.body.conversion.id).toBe("conv-existing");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("returns 409 when an idempotency key is reused with a different request", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.sourceImport.findFirst).mockResolvedValue({ id: SOURCE_IMPORT_ID, kind: "FIGMA_FILE" } as never);
    vi.mocked(prisma.conversionJob.findUnique).mockResolvedValue({
      id: "conv-existing",
      status: "QUEUED",
      requestHash: "different-hash-than-this-request",
    } as never);
    vi.mocked(prisma.$transaction).mockClear();

    const response = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${token}`)
      .send(figmaPayload("idem-key-figma-reuse-1"));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });


  it("rejects a mismatched source import without creating a job", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.sourceImport.findFirst).mockResolvedValue({ id: SOURCE_IMPORT_ID, kind: "FRAMER_SITE" } as never);
    vi.mocked(prisma.conversionJob.create).mockClear();

    const response = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${token}`)
      .send(figmaPayload("idem-key-figma-mismatch"));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("SOURCE_IMPORT_MISMATCH");
    expect(prisma.conversionJob.create).not.toHaveBeenCalled();
  });

  it("keeps source types without approved Markdown rules at 501 with no job", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "OWNER" } as never);
    vi.mocked(prisma.conversionJob.create).mockClear();

    const response = await request(app)
      .post(`/api/v1/projects/${PROJECT_ID}/conversions`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        sourceType: "screenshot",
        idempotencyKey: "idem-key-screenshot-501-1",
        targetProfile: { platform: "elementor", architecture: "atomic", licenseMode: "free" },
      });

    expect(response.status).toBe(501);
    expect(response.body.error.code).toBe("CONVERSION_PIPELINE_UNAVAILABLE");
    expect(response.body.error.message).toMatch(/No conversion job was created/);
    expect(prisma.conversionJob.create).not.toHaveBeenCalled();
  });
});

describe("Artifact API authorization (private until authorized)", () => {
  it("hides artifacts from users without project membership", async () => {
    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.artifact.findFirst).mockResolvedValue({
      id: ARTIFACT_ID,
      projectId: PROJECT_ID,
      storageKey: "conversions/p/c/elementor.json",
      fileName: "elementor.json",
      contentType: "application/json",
      sizeBytes: 2n,
      status: "READY",
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue(null as never);

    const denied = await request(app)
      .get(`/api/v1/artifacts/${ARTIFACT_ID}/download`)
      .set("Authorization", `Bearer ${token}`);

    expect(denied.status).toBe(404);
    expect(denied.body.error.code).toBe("PROJECT_NOT_FOUND");
  });

  it("serves the private Elementor artifact to an authorized project member", async () => {
    const projectId = "cprojectartifactdl000000001";
    const conversionId = "cconversionartifactdl00001";
    const storageKey = `conversions/${projectId}/${conversionId}/elementor.json`;
    const bytes = Buffer.from(JSON.stringify(validElementorOutput), "utf8");
    const existing = await storage.stat(storageKey);
    if (!existing) await storage.write(storageKey, Readable.from([bytes]), bytes.length);

    vi.mocked(prisma.session.findFirst).mockResolvedValue({ id: "session-test", userId: "user-test" } as never);
    vi.mocked(prisma.artifact.findFirst).mockResolvedValue({
      id: ARTIFACT_ID,
      projectId,
      storageKey,
      fileName: "elementor.json",
      contentType: "application/json",
      sizeBytes: BigInt(bytes.length),
      status: "READY",
    } as never);
    vi.mocked(prisma.projectMember.findUnique).mockResolvedValue({ role: "VIEWER" } as never);

    const response = await request(app)
      .get(`/api/v1/artifacts/${ARTIFACT_ID}/download`)
      .set("Authorization", `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.headers["cache-control"]).toContain("private");
    expect(JSON.parse(response.text)).toEqual(validElementorOutput);
  });
});
