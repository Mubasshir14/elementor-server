import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadConversionRules,
  resetRuleCacheForTests,
} from "../src/modules/rules/rule-loader.js";
import {
  buildConversionMessages,
  requestConversionCompletion,
} from "../src/infrastructure/ai/provider.js";
import { DIR_NODE_KINDS, validateDir } from "../src/modules/conversions/dir-schema.js";

afterEach(() => {
  vi.unstubAllGlobals();
  resetRuleCacheForTests();
});

describe("Markdown rule loading drives the AI conversion request", () => {
  it("puts the current FIGMA.md + ELEMENTOR_SKILL.md into the system instructions", () => {
    resetRuleCacheForTests();
    const rules = loadConversionRules("figma");
    const messages = buildConversionMessages({
      rules,
      designPayload: '{"pages":[]}',
      task: "Return one DIR JSON object and nothing else.",
    });
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("Figma → DIR Conversion Skill");
    expect(messages[0].content.length).toBeGreaterThan(1000);
    expect(messages[0].content).toContain("UNTRUSTED");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("BEGIN UNTRUSTED-DESIGN");
    expect(messages[1].content).toContain('{"pages":[]}');
    // User payload never bleeds into the trusted instructions.
    expect(messages[0].content).not.toContain('{"pages":[]}');
  });

  it("edits to the rule file change subsequent instructions without code changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-test-"));
    const figmaPath = join(dir, "FIGMA.md");
    const targetPath = join(dir, "ELEMENTOR_SKILL.md");
    writeFileSync(figmaPath, "# v1 marker ORIGINAL-RULE-TEXT");
    writeFileSync(targetPath, "# target");

    try {
      resetRuleCacheForTests();
      const before = loadConversionRules("figma", { rootDir: dir });
      expect(before.sourceRule.text).toContain("ORIGINAL-RULE-TEXT");

      // Simulate an administrator editing the Markdown file at conversion time.
      writeFileSync(figmaPath, "# v2 marker UPDATED-RULE-TEXT");
      const now = Date.now() / 1000 + 10;
      utimesSync(figmaPath, now, now);

      const after = loadConversionRules("figma", { rootDir: dir });
      expect(after.sourceRule.text).toContain("UPDATED-RULE-TEXT");
      expect(after.sourceRule.text).not.toContain("ORIGINAL-RULE-TEXT");
      expect(after.sourceRule.sha256).not.toBe(before.sourceRule.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("rule cache invalidation and missing rules", () => {
  it("returns the cached rules on an unchanged file (mtime+hash hit)", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-cache-"));
    writeFileSync(join(dir, "FIGMA.md"), "# x");
    writeFileSync(join(dir, "ELEMENTOR_SKILL.md"), "# y");
    try {
      resetRuleCacheForTests();
      const a = loadConversionRules("figma", { rootDir: dir });
      const b = loadConversionRules("figma", { rootDir: dir });
      expect(b).toBe(a);
      const forced = loadConversionRules("figma", { rootDir: dir, forceReload: true });
      expect(forced).not.toBe(a);
      expect(forced.sourceRule.sha256).toBe(a.sourceRule.sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not silently fall back when the target rule file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-missing-"));
    writeFileSync(join(dir, "FIGMA.md"), "# only source");
    try {
      resetRuleCacheForTests();
      expect(() => loadConversionRules("figma", { rootDir: dir })).toThrowError(/ELEMENTOR_SKILL\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported source type instead of guessing a rule file", () => {
    resetRuleCacheForTests();
    expect(() => loadConversionRules("react-next-zip" as never)).toThrowError(/source-analysis rule file/i);
  });
});

describe("AI provider request construction", () => {
  beforeEach(() => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_API_KEY = "test-key";
    process.env.AI_MODEL = "test-model";
    resetRuleCacheForTests();
  });

  it("disabled AI provider fails explicitly with an actionable error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-dis-"));
    writeFileSync(join(dir, "FIGMA.md"), "# x");
    writeFileSync(join(dir, "ELEMENTOR_SKILL.md"), "# y");
    process.env.AI_PROVIDER = "disabled";
    const rules = loadConversionRules("figma", { rootDir: dir });
    await expect(requestConversionCompletion({
      rules,
      designPayload: "{}",
      task: "task",
    })).rejects.toThrowError(/AI conversion is disabled/i);
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends the loaded Markdown rules as the system message on the wire", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rules-wire-"));
    writeFileSync(join(dir, "FIGMA.md"), "# RULESENTINEL-FIGMA");
    writeFileSync(join(dir, "ELEMENTOR_SKILL.md"), "# RULESENTINEL-TARGET");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "{}" } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const rules = loadConversionRules("figma", { rootDir: dir });
    await requestConversionCompletion({ rules, designPayload: '{"n":1}', task: "Return DIR" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/chat/completions");
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain("RULESENTINEL-FIGMA");
    expect(body.messages[0].content).toContain("RULESENTINEL-TARGET");
    expect(body.messages[1].content).toContain("BEGIN UNTRUSTED-DESIGN");
    rmSync(dir, { recursive: true, force: true });
  });
});


describe("DIR validation against the documented canonical specification", () => {
  it("accepts a minimal valid DIR shaped exactly like FIGMA.md section 2", () => {
    const dir = {
      version: 1,
      meta: {},
      breakpoints: {},
      globals: {},
      assets: [],
      pages: [
        {
          sections: [
            {
              role: "hero",
              children: [
                { kind: "heading", text: "Hello", level: 1 },
                { kind: "text", html: "<p>Body</p>" },
                { kind: "button", label: "Go" },
                { kind: "container", children: [{ kind: "image", src: "assets/a.png" }] },
              ],
            },
          ],
        },
      ],
    };
    const result = validateDir(dir);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.pageCount).toBe(1);
    expect(result.sectionCount).toBe(1);
    expect(result.nodeCount).toBe(5);
  });

  it("rejects invented node kinds, missing fields, and a wrong envelope", () => {
    expect(validateDir({}).issues.map((i) => i.code)).toContain("DIR_VERSION_MISSING");
    expect(validateDir(null).issues[0].code).toBe("DIR_NOT_OBJECT");

    const bad = {
      version: 1,
      meta: {},
      breakpoints: {},
      globals: {},
      assets: [],
      pages: [{ sections: [{ role: "hero", children: [
        { kind: "card", children: [] },
        { kind: "heading" },
        { kind: "image" },
      ] }] }],
    };
    const result = validateDir(bad);
    expect(result.valid).toBe(false);
    const codes = result.issues.map((i) => i.code);
    expect(codes).toContain("DIR_UNKNOWN_KIND");
    expect(codes).toContain("DIR_HEADING_TEXT_MISSING");
    expect(codes).toContain("DIR_IMAGE_SRC_MISSING");
  });

  it("exposes the exact allowed kinds documented in FIGMA.md", () => {
    expect([...DIR_NODE_KINDS].sort()).toEqual(
      ["button", "container", "form", "heading", "iconBox", "image", "nav", "text"].sort(),
    );
  });
});

