import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSourceAvailability,
  evaluateTargetAvailability,
} from "../src/modules/capabilities/capabilities.availability.js";

const flags = vi.hoisted(() => ({ failRules: false }));

vi.mock("../src/modules/rules/rule-loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/rules/rule-loader.js")>();
  return {
    ...actual,
    loadConversionRules: (sourceType: Parameters<typeof actual.loadConversionRules>[0], options?: never) => {
      if (flags.failRules) {
        const error = new Error("Required conversion rule file is missing: FIGMA.md. Restore server/rules/FIGMA.md.");
        (error as { code?: string }).code = "RULE_FILE_MISSING";
        throw error;
      }
      return actual.loadConversionRules(sourceType, options);
    },
  };
});

const AI_ENV = {
  AI_PROVIDER: "groq",
  AI_API_KEY: "test-key",
  AI_MODEL: "test-model",
};

const savedEnv = {
  AI_PROVIDER: process.env.AI_PROVIDER,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_MODEL: process.env.AI_MODEL,
};

beforeEach(() => {
  vi.unstubAllGlobals();
  flags.failRules = false;
  process.env.AI_PROVIDER = AI_ENV.AI_PROVIDER;
  process.env.AI_API_KEY = AI_ENV.AI_API_KEY;
  process.env.AI_MODEL = AI_ENV.AI_MODEL;
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.AI_PROVIDER = savedEnv.AI_PROVIDER;
  process.env.AI_API_KEY = savedEnv.AI_API_KEY;
  process.env.AI_MODEL = savedEnv.AI_MODEL;
});

describe("conversion capability evaluation (runtime, never hardcoded)", () => {
  it("reports conversion unavailable for every source when the AI provider is disabled", () => {
    process.env.AI_PROVIDER = "disabled";
    for (const source of ["figma", "framer", "react-next-zip"] as const) {
      const result = evaluateSourceAvailability(source);
      expect(result.available).toBe(false);
      expect(result.unavailableReason).toMatch(/AI conversion is disabled/);
    }
    const target = evaluateTargetAvailability();
    expect(target.available).toBe(false);
    expect(target.unavailableReason).toMatch(/AI conversion is disabled/);
  });

  it("reports conversion unavailable when AI credentials are incomplete", () => {
    process.env.AI_PROVIDER = "groq";
    process.env.AI_API_KEY = "";
    process.env.AI_MODEL = "";
    const result = evaluateSourceAvailability("figma");
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toMatch(/AI_API_KEY/);
  });

  it("reports conversion available when the provider and Markdown rules are usable", () => {
    process.env.AI_PROVIDER = AI_ENV.AI_PROVIDER;
    process.env.AI_API_KEY = AI_ENV.AI_API_KEY;
    process.env.AI_MODEL = AI_ENV.AI_MODEL;
    for (const source of ["figma", "framer", "react-next-zip"] as const) {
      const result = evaluateSourceAvailability(source);
      expect(result.available).toBe(true);
    }
    const target = evaluateTargetAvailability();
    expect(target.available).toBe(true);
    expect(target.unavailableReason).toMatch(/Native Elementor conversion is available/);
  });

  it("surfaces the rule-loader error as the unavailable reason when rules fail", () => {
    flags.failRules = true;
    const result = evaluateSourceAvailability("figma");
    expect(result.available).toBe(false);
    expect(result.unavailableReason).toMatch(/RULE_FILE_MISSING|missing/i);
    const target = evaluateTargetAvailability();
    expect(target.available).toBe(false);
    expect(target.unavailableReason).toMatch(/RULE_FILE_MISSING|missing/i);
  });

  it("never reports directories or contents, only rule-file names and reasons", () => {
    process.env.AI_PROVIDER = AI_ENV.AI_PROVIDER;
    process.env.AI_API_KEY = AI_ENV.AI_API_KEY;
    process.env.AI_MODEL = AI_ENV.AI_MODEL;
    const result = evaluateTargetAvailability();
    expect(JSON.stringify(result)).not.toMatch(/backblaze|secret|token|password/i);
  });
});
