import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRule, loadRulesForConversion } from "../src/modules/rule-files/rules.service.js";

describe("rule loading", () => {
  it("records the exact content hash for the existing Figma rulebook", async () => {
    const rule = await loadRule("FIGMA.md");
    const source = await readFile(new URL("../rules/FIGMA.md", import.meta.url), "utf8");
    expect(rule.sha256).toBe(createHash("sha256").update(source, "utf8").digest("hex"));
    expect(rule.content).toBe(source);
  });

  it("selects the Elementor rules with the requested source rules", async () => {
    const rules = await loadRulesForConversion("framer");
    expect(rules.map((rule) => rule.fileName)).toEqual(["ELEMENTOR_SKILL.md", "FRAMER.md"]);
    expect(rules.every((rule) => /^[a-f0-9]{64}$/.test(rule.sha256))).toBe(true);
  });

  it("rejects rule paths outside the approved set", async () => {
    await expect(loadRule("../README.md")).rejects.toMatchObject({
      code: "UNKNOWN_RULE_FILE",
      status: 400,
    });
  });
});
