import { describe, expect, it } from "vitest";
import { framerHostHint, normalizeFramerSiteUrl } from "../framer.service.js";
import { framerImportBodySchema } from "../framer.validator.js";

describe("Framer isolated module validation and URL normalization", () => {
  it("validates Framer published-site request payloads and normalizes URLs", () => {
    const parsed = framerImportBodySchema.parse({
      siteUrl: "  https://studio.framer.website/landing  ",
    });
    expect(parsed.siteUrl).toBe("https://studio.framer.website/landing");

    const url = normalizeFramerSiteUrl(parsed.siteUrl);
    expect(url.hostname).toBe("studio.framer.website");
    expect(framerHostHint("studio.framer.website")).toBeUndefined();
    expect(framerHostHint("custom-domain.example.com")).toMatch(/custom domains/);
  });

  it("rejects non-http protocols in normalizeFramerSiteUrl", () => {
    expect(() => normalizeFramerSiteUrl("javascript:alert(1)")).toThrow();
    expect(() => normalizeFramerSiteUrl("file:///etc/passwd")).toThrow();
  });
});

