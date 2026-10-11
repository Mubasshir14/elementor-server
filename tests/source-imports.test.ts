import { describe, expect, it } from "vitest";
import { summarizeFigmaFile } from "../src/modules/uploads/figma-import.js";
import {
  detectNativeFigmaFile,
  extractFigmaStructure,
  inspectFigmaFileJson,
} from "../src/modules/uploads/figma-file-inspection.js";
import { assertImportUrl } from "../src/infrastructure/wordpress/safe-fetch.js";

const figmaFileJson = {
  name: "Landing",
  lastModified: "2026-01-01T00:00:00Z",
  document: {
    type: "DOCUMENT",
    children: [
      { type: "CANVAS", name: "Page 1", children: [{ type: "FRAME", name: "Hero" }] },
    ],
  },
  components: { "1:2": { name: "Button" } },
  styles: { "3:4": { name: "Heading" } },
};

describe("Figma REST API file JSON parsing (local, no network)", () => {
  it("summarizes an official file response without inventing data", () => {
    const summary = summarizeFigmaFile("ABC123DEF456", figmaFileJson);
    expect(summary).toMatchObject({ fileKey: "ABC123DEF456", name: "Landing", pageCount: 1, componentCount: 1, styleCount: 1 });
  });

  it("rejects payloads that are not a genuine Figma file response", () => {
    expect(() => summarizeFigmaFile("key", {})).toThrowError();
    expect(() => summarizeFigmaFile("key", { name: "" })).toThrowError();
    expect(() => summarizeFigmaFile("key", null)).toThrowError();
  });

  it("parses a valid uploaded Figma file JSON locally", () => {
    const result = inspectFigmaFileJson(Buffer.from(JSON.stringify(figmaFileJson), "utf8"));
    expect(result.summary.name).toBe("Landing");
    expect(result.structure.pages).toEqual([{ name: "Page 1", type: "CANVAS", nodeCount: 2 }]);
    expect(result.structure.componentNames).toEqual(["Button"]);
    expect(result.structure.styleNames).toEqual(["Heading"]);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects native .fig files mislabeled as JSON with an actionable error", () => {
    // Minimal local-file-header ZIP magic followed by a canvas.fig entry name.
    const zipBytes = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("padding-canvas.fig-more", "latin1"),
    ]);
    expect(detectNativeFigmaFile(zipBytes)).toBe("fig");
    expect(() => inspectFigmaFileJson(zipBytes)).toThrowError(/Reserve the upload with the .fig filename/);
  });

  it("rejects raw kiwi-binary fig files with the native-parser redirect", () => {
    const kiwi = Buffer.from("fig-kiwi\x00\x00\x00\x06rest-of-binary", "latin1");
    expect(detectNativeFigmaFile(kiwi)).toBe("fig");
    expect(() => inspectFigmaFileJson(kiwi)).toThrowError(/Reserve the upload with the \.fig filename/);
  });

  it("rejects non-ZIP archives and malformed or non-Figma JSON", () => {
    const otherZip = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("no-canvas-here", "latin1"),
    ]);
    expect(detectNativeFigmaFile(otherZip)).toBe("unknown-archive");
    expect(() => inspectFigmaFileJson(otherZip)).toThrowError(/compressed archive/);

    expect(() => inspectFigmaFileJson(Buffer.from("not json", "utf8"))).toThrowError(/not valid JSON/);
    expect(() => inspectFigmaFileJson(Buffer.from(JSON.stringify({ foo: "bar" }), "utf8"))).toThrowError();
    expect(() => inspectFigmaFileJson(Buffer.alloc(0))).toThrowError(/empty/);
  });

  it("returns null for ordinary JSON bytes", () => {
    expect(detectNativeFigmaFile(Buffer.from(JSON.stringify(figmaFileJson), "utf8"))).toBeNull();
  });
});

describe("Figma structure extraction", () => {
  it("reads only observed pages, components, and styles", () => {
    const structure = extractFigmaStructure(figmaFileJson);
    expect(structure.totalNodes).toBeGreaterThan(0);
    expect(structure.pages.map((p) => p.name)).toEqual(["Page 1"]);
  });
});

describe("Framer import SSRF protections", () => {
  it("rejects localhost, private addresses, credentials, and protocols", () => {
    for (const bad of [
      "http://localhost:3000/",
      "http://127.0.0.1/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "ftp://example.com/site",
      "https://user:pass@example.com/",
    ]) {
      expect(() => assertImportUrl(bad)).toThrowError();
    }
  });

  it("accepts a public site URL", () => {
    expect(assertImportUrl("https://example.framer.website/").hostname).toBe("example.framer.website");
  });
});
