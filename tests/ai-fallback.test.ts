import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestConversionCompletion, getAvailableFreeProviders } from "../src/infrastructure/ai/provider.js";

function dummyRules() {
  return {
    sourceType: "react-next-zip" as const,
    sourceRule: { fileName: "REACT_NEXT.md", text: "# Rules", sha256: "abc1" },
    targetRule: { fileName: "ELEMENTOR_SKILL.md", text: "# Target", sha256: "abc2" },
    systemInstructions: "You are an Elementor expert.",
    versions: [
      { fileName: "REACT_NEXT.md", sha256: "abc1" },
      { fileName: "ELEMENTOR_SKILL.md", sha256: "abc2" },
    ],
  };
}

describe("Sequential free-tier AI fallback", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    process.env.AI_PROVIDER = "groq";
    process.env.AI_API_KEY = "mock-groq-key";
    process.env.AI_MODEL = "openai/gpt-oss-120b";
    process.env.OPENROUTER_API_KEY = "mock-openrouter-key";
    process.env.OPENROUTER_MODEL = "openrouter/free";
    process.env.GEMINI_API_KEY = "mock-gemini-key";
    process.env.GEMINI_MODEL = "gemini-3.8-flash";
    process.env.ENABLE_GEMINI = "true";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.unstubAllGlobals();
  });

  it("enforces strict free-tier policy: accepts openrouter/free and :free models, rejects paid models", () => {
    // 1. Official openrouter/free router is accepted
    process.env.OPENROUTER_MODEL = "openrouter/free";
    let candidates = getAvailableFreeProviders();
    expect(candidates.find((c) => c.provider === "openrouter")?.model).toBe("openrouter/free");

    // 2. Specific :free models are accepted
    process.env.OPENROUTER_MODEL = "meta-llama/llama-3.3-70b-instruct:free";
    candidates = getAvailableFreeProviders();
    expect(candidates.find((c) => c.provider === "openrouter")?.model).toBe("meta-llama/llama-3.3-70b-instruct:free");

    // 3. Paid models are rejected
    process.env.OPENROUTER_MODEL = "openai/gpt-4o";
    candidates = getAvailableFreeProviders();
    expect(candidates.find((c) => c.provider === "openrouter")).toBeUndefined();
  });

  it("includes Gemini when ENABLE_GEMINI=true and skips when false in development", () => {
    process.env.NODE_ENV = "development";
    process.env.ENABLE_GEMINI = "true";
    let candidates = getAvailableFreeProviders();
    expect(candidates.find((c) => c.provider === "gemini")).toBeDefined();

    process.env.ENABLE_GEMINI = "false";
    candidates = getAvailableFreeProviders();
    expect(candidates.find((c) => c.provider === "gemini")).toBeUndefined();
  });

  it("detects model response truncation from finish_reason: length", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("generativelanguage.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                finishReason: "MAX_TOKENS",
                content: { parts: [{ text: '{"truncated":"out' }] },
              },
            ],
          }),
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [
            {
              finish_reason: "length",
              message: { content: '{"truncated":"out' },
            },
          ],
        }),
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestConversionCompletion({
        rules: dummyRules(),
        designPayload: '{"type":"button"}',
        task: "Generate DIR",
      }),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
    });
  });

  it("falls back from Groq 429 to OpenRouter successfully", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("groq.com")) {
        return {
          ok: false,
          status: 429,
          text: async () => JSON.stringify({ error: { message: "Rate limit reached (8,000 TPM limit)" } }),
        };
      }
      if (url.includes("openrouter.ai")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '{"status":"ok_from_openrouter"}' } }],
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await requestConversionCompletion({
      rules: dummyRules(),
      designPayload: '{"type":"button"}',
      task: "Generate DIR",
    });

    expect(result.provider).toBe("openrouter");
    expect(result.model).toBe("openrouter/free");
    expect(result.text).toBe('{"status":"ok_from_openrouter"}');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back through Groq and OpenRouter to Gemini successfully", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("groq.com")) {
        return {
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded",
        };
      }
      if (url.includes("openrouter.ai")) {
        return {
          ok: false,
          status: 503,
          text: async () => "Service unavailable",
        };
      }
      if (url.includes("generativelanguage.googleapis.com")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            candidates: [
              {
                content: {
                  parts: [{ text: '{"status":"ok_from_gemini"}' }],
                },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected url: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await requestConversionCompletion({
      rules: dummyRules(),
      designPayload: '{"type":"button"}',
      task: "Generate DIR",
    });

    expect(result.provider).toBe("gemini");
    expect(result.model).toBe("gemini-3.8-flash");
    expect(result.text).toBe('{"status":"ok_from_gemini"}');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("never silently falls back to mock output when all free providers fail", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => {
      return {
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      };
    });

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      requestConversionCompletion({
        rules: dummyRules(),
        designPayload: '{"type":"button"}',
        task: "Generate DIR",
      }),
    ).rejects.toMatchObject({
      code: "AI_PROVIDER_ERROR",
    });
  });
});

