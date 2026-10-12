import { describe, expect, it } from "vitest";
import {
  GENERATED_ARCHIVE_DIRECTORIES,
  isGeneratedArchivePath,
} from "../src/modules/react-nextjs/archive-entry-policy.js";

describe("generated archive-entry classification policy", () => {
  it("covers the documented generated directories", () => {
    expect([...GENERATED_ARCHIVE_DIRECTORIES]).toEqual(
      expect.arrayContaining([
        "node_modules",
        ".next",
        ".nuxt",
        ".output",
        ".turbo",
        ".cache",
        ".vite",
        "dist",
        "build",
        "coverage",
        ".git",
        ".vercel",
      ]),
    );
  });

  it("excludes turpopack cache entries under a ZIP root prefix (the reported failure)", () => {
    expect(
      isGeneratedArchivePath("intake-archive/.next/dev/cache/turbopack/acba4a6b/00005344.sst"),
    ).toBe(true);
    expect(isGeneratedArchivePath(".next/dev/cache/turbopack/acba4a6b/00005344.sst")).toBe(true);
  });

  it("excludes nested generated directories and build outputs", () => {
    expect(isGeneratedArchivePath("app/node_modules/lodash/index.js")).toBe(true);
    expect(isGeneratedArchivePath("intake-archive/dist/bundle.js")).toBe(true);
    expect(isGeneratedArchivePath("a\\b\\.next\\cache\\x.sst")).toBe(true);
    expect(isGeneratedArchivePath("site/build/asset.js.map")).toBe(true);
    expect(isGeneratedArchivePath("proj/.git/objects/ab/cd")).toBe(true);
  });

  it("does not exclude legitimate source files with similar names", () => {
    expect(isGeneratedArchivePath("src/build-tools/important.ts")).toBe(false);
    expect(isGeneratedArchivePath("src/Build/component.tsx")).toBe(false);
    expect(isGeneratedArchivePath("src/next.config.ts")).toBe(false);
    expect(isGeneratedArchivePath("src/dist.ts")).toBe(false);
    expect(isGeneratedArchivePath("components/Builder.tsx")).toBe(false);
    expect(isGeneratedArchivePath("src/App.tsx")).toBe(false);
    expect(isGeneratedArchivePath("package.json")).toBe(false);
    expect(isGeneratedArchivePath("")).toBe(false);
  });

  it("only treats a final segment as a directory for directory entries", () => {
    // A plain file literally named `dist` is a regular entry, not a prefix.
    expect(isGeneratedArchivePath("src/dist")).toBe(false);
    // Directory entries (trailing slash) expose their final segment as a dir.
    expect(isGeneratedArchivePath("node_modules/")).toBe(true);
    expect(isGeneratedArchivePath("intake-archive/.next/")).toBe(true);
  });
});
