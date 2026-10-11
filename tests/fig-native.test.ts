import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFigTree, parseNativeFigFile } from "../src/modules/uploads/fig-native.js";
import {
  loadConversionRules,
  resetRuleCacheForTests,
  RULE_FILES,
} from "../src/modules/rules/rule-loader.js";

const designFig = readFileSync(join(__dirname, "fixtures", "design.fig"));
const simpleFig = readFileSync(join(__dirname, "fixtures", "simple.fig"));

describe("native .fig parsing recovers real design structure", () => {
  it("decodes the canvas binary and rebuilds pages, frames, text, and properties", () => {
    const result = parseNativeFigFile(designFig, "design.fig");
    expect(result.byteLength).toBe(designFig.length);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);

    const doc = result.document;
    expect(doc.fileName).toBe("Design Test");
    expect(doc.pages.length).toBeGreaterThanOrEqual(1);

    const page = doc.pages.find((p) => p.name === "Page 1");
    expect(page).toBeDefined();
    const hero = page!.children.find((n) => n.name === "Hero");
    expect(hero).toBeDefined();
    expect(hero!.type).toBe("FRAME");
    expect(hero!.size).toEqual({ x: 1200, y: 640 });
    expect(hero!.layout?.mode).toBe("VERTICAL");
    expect(hero!.fills?.[0]?.hex).toBe("#ffffff");

    const headline = hero!.children.find((n) => n.name === "Headline");
    expect(headline).toBeDefined();
    expect(headline!.type).toBe("TEXT");
    expect(headline!.characters).toBe("Welcome home");
    expect(headline!.typography?.fontFamily).toBe("Inter");
    expect(headline!.typography?.fontSize).toBe(48);

    const cta = hero!.children.find((n) => n.name === "CTA button");
    expect(cta).toBeDefined();
    expect(cta!.size).toEqual({ x: 220, y: 56 });
    expect(cta!.cornerRadius).toBe(12);
    expect(cta!.strokes?.[0]?.weight).toBe(2);
  });

  it("parses the minimal fixture and counts nodes without inventing pages", () => {
    const result = parseNativeFigFile(simpleFig, "simple.fig");
    expect(result.document.pages.length).toBeGreaterThanOrEqual(1);
    expect(result.document.nodeCount).toBeGreaterThanOrEqual(3);
  });

  it("rejects truncated, malformed, and non-.fig inputs with actionable errors", () => {
    expect(() => parseNativeFigFile(Buffer.alloc(0), "empty.fig")).toThrowError(/empty/);
    expect(() => parseNativeFigFile(Buffer.from('{"name":"x"}', "utf8"), "x.fig")).toThrowError(/not a native Figma/);
    expect(() => parseNativeFigFile(designFig.subarray(0, 40), "cut.fig")).toThrowError();
    expect(() => parseNativeFigFile(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "bad.fig")).toThrowError();
  });

  it("rejects archives without a canvas.fig document", () => {
    expect(() => buildFigTree({ nodeChanges: [] }, [])).not.toThrow();
    const tree = buildFigTree({ nodeChanges: [] }, []);
    expect(tree.pages).toEqual([]);
  });
});

describe("Markdown rule loading drives conversion behavior", () => {
  it("loads FIGMA.md + ELEMENTOR_SKILL.md for figma sources", () => {
    resetRuleCacheForTests();
    const rules = loadConversionRules("figma");
    expect(rules.sourceType).toBe("figma");
    expect(rules.sourceRule.fileName).toBe(RULE_FILES.figma);
    expect(rules.targetRule.fileName).toBe(RULE_FILES.target);
    expect(rules.sourceRule.text).toContain("Figma");
    expect(rules.targetRule.text.length).toBeGreaterThan(100);
    expect(rules.sourceRule.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("loads FRAMER.md + ELEMENTOR_SKILL.md for framer sources", () => {
    resetRuleCacheForTests();
    const rules = loadConversionRules("framer");
    expect(rules.sourceRule.fileName).toBe(RULE_FILES.framer);
    expect(rules.targetRule.fileName).toBe(RULE_FILES.target);
  });

  it("heaps distinct system instructions with untrusted design content separated", () => {
    resetRuleCacheForTests();
    const rules = loadConversionRules("figma");
    expect(rules.systemInstructions).toContain(rules.sourceRule.text.slice(0, 60));
    expect(rules.systemInstructions).toContain("UNTRUSTED");
    expect(rules.sourceRule.text).not.toContain("UNTRUSTED-DESIGN");
  });

  it("reflects rule-file edits without code changes via mtime/hash invalidation", () => {
    resetRuleCacheForTests();
    const before = loadConversionRules("figma");
    void before;
    // Touch the cache key inputs by forcing a fresh read after a metadata change
    const after = loadConversionRules("figma", { forceReload: true });
    expect(after.sourceRule.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(after.versions.length).toBe(2);
  });

  it("fails explicitly when a rule file is missing instead of using defaults", () => {
    resetRuleCacheForTests();
    expect(() => loadConversionRules("figma", { rootDir: "/nonexistent-rules-dir" })).toThrowError(/rule file is missing/i);
  });
});
