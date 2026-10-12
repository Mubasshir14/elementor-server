import { describe, expect, it } from "vitest";
import { deflateRawSync } from "node:zlib";
import { inspectZip } from "../src/modules/uploads/archive-inspection.js";
import { isGeneratedArchivePath } from "../src/modules/react-nextjs/archive-entry-policy.js";
import { buildStoredZip } from "../src/modules/react-nextjs/tests/zip-fixtures.js";

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(fileName: string, contents: string, unixFileType = 0): Buffer {
  const name = Buffer.from(fileName);
  const data = Buffer.from(contents);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((unixFileType << 16) >>> 0, 38);
  const centralOffset = local.length + name.length + data.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

function makeDeflatedZip(fileName: string, contents: string): Buffer {
  const name = Buffer.from(fileName);
  const data = Buffer.from(contents);
  const compressed = deflateRawSync(data);
  const checksum = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8); // compression method 8 = deflate
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10); // compression method 8 = deflate
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  const centralOffset = local.length + name.length + compressed.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, compressed, central, name, end]);
}

describe("uploaded archive inspection", () => {
  it("accepts a safe ZIP without extracting it", async () => {
    await expect(inspectZip(makeZip("src/page.tsx", "export default null"))).resolves.toBeUndefined();
  });

  it("rejects a path-traversal ZIP entry", async () => {
    await expect(inspectZip(makeZip("../outside.txt", "not extracted"))).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH_TRAVERSAL",
      status: 400,
    });
  });

  it("rejects an absolute-path ZIP entry", async () => {
    await expect(inspectZip(makeZip("/etc/passwd", "not extracted"))).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH_ABSOLUTE",
      status: 400,
    });
  });

  it("rejects a symbolic-link entry", async () => {
    await expect(inspectZip(makeZip("src/link", "target", 0xa1ff))).rejects.toMatchObject({
      code: "ZIP_SYMLINK_ENTRY",
      status: 400,
    });
  });

  it("rejects malformed ZIP data", async () => {
    await expect(inspectZip(Buffer.from("not a zip"))).rejects.toMatchObject({
      code: "ARCHIVE_MALFORMED",
      status: 400,
    });
  });

  it("rejects a truncated ZIP central directory", async () => {
    const full = makeZip("src/page.tsx", "export default null");
    await expect(inspectZip(full.subarray(0, full.length - 12))).rejects.toMatchObject({
      code: "ARCHIVE_MALFORMED",
      status: 400,
    });
  });
});

describe("uploaded archive inspection safety limits (distinct codes)", () => {
  it("rejects entry-count overflow with a specific code", async () => {
    await expect(inspectZip(makeZip("src/a.tsx", "a"), { maxEntries: 0 })).rejects.toMatchObject({
      code: "ZIP_ENTRY_COUNT_EXCEEDED",
      status: 400,
    });
  });

  it("rejects per-entry uncompressed-size overflow with a specific code", async () => {
    await expect(inspectZip(makeZip("src/a.tsx", "abcdefghij"), { maxEntryBytes: 4 })).rejects.toMatchObject({
      code: "ZIP_ENTRY_SIZE_EXCEEDED",
      status: 400,
    });
  });

  it("rejects total uncompressed-size overflow with a specific code", async () => {
    await expect(
      inspectZip(makeZip("src/a.tsx", "abcdefghij"), { maxExpandedBytes: 4 }),
    ).rejects.toMatchObject({
      code: "ZIP_UNCOMPRESSED_SIZE_EXCEEDED",
      status: 400,
    });
  });

  it("rejects compression-ratio overflow (decompression-bomb) with a specific code", async () => {
    // A highly compressible (deflated) entry whose declared uncompressed size is
    // far larger than its compressed size trips the decompression-bomb guard.
    const bomb = makeDeflatedZip("src/bomb.txt", "A".repeat(65_536));
    await expect(inspectZip(bomb, { maxCompressionRatio: 100 })).rejects.toMatchObject({
      code: "ZIP_COMPRESSION_RATIO_EXCEEDED",
      status: 400,
    });
  });

  it("accepts a metadata-realistic large archive within configured defaults", async () => {
    // Deterministic metadata-scale archive: 512 small entries whose combined
    // uncompressed size is far below the 1 GiB default, mirroring the size class
    // of a real project export without committing a large binary fixture.
    const entries: Buffer[] = [];
    const central: Buffer[] = [];
    let offset = 0;
    const count = 512;
    for (let i = 0; i < count; i += 1) {
      const name = Buffer.from(`src/components/Component${i}.tsx`);
      const data = Buffer.from(`export function Component${i}() { return null; }`);
      const checksum = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(name.length, 26);
      entries.push(local, name, data);
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt32LE(checksum, 16);
      header.writeUInt32LE(data.length, 20);
      header.writeUInt32LE(data.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      offset += local.length + name.length + data.length;
    }
    const centralBuffer = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(count, 8);
    end.writeUInt16LE(count, 10);
    end.writeUInt32LE(centralBuffer.length, 12);
    end.writeUInt32LE(offset, 16);
    const archive = Buffer.concat([...entries, centralBuffer, end]);
    expect(archive.byteLength).toBeGreaterThan(16_000); // >512 small entries
    await expect(inspectZip(archive)).resolves.toBeUndefined();
  });
});

describe("generated build/cache exclusion (turbopack cache root cause)", () => {
  const TURBOPACK_CACHE_PATH = "intake-archive/.next/dev/cache/turbopack/acba4a6b/00005344.sst";
  // The exact failing metadata from the reported upload: 75,614,418 declared
  // uncompressed bytes against the 67,108,864 (64 MiB) per-entry limit.
  const FAILED_ENTRY_BYTES = 75_614_418;
  const MAX_ENTRY_BYTES = 67_108_864;

  it("accepts a generated cache entry above the per-entry limit without reading it", async () => {
    // Stored payload is 1 byte; the declared header metadata is the 75 MB
    // class. If the inspector tried to open/decompress this entry it would
    // hit EOF — resolution therefore proves it was never read.
    const zip = buildStoredZip([
      { name: "intake-archive/package.json", data: JSON.stringify({ name: "app" }) },
      {
        name: TURBOPACK_CACHE_PATH,
        data: Buffer.from("x"),
        declaredUncompressed: FAILED_ENTRY_BYTES,
        declaredCompressed: FAILED_ENTRY_BYTES,
      },
    ]);
    await expect(inspectZip(zip)).resolves.toBeUndefined();
  });

  it("still rejects a legitimate source file above the per-entry limit with path and sizes", async () => {
    const zip = buildStoredZip([
      {
        name: "src/big-data.ts",
        data: Buffer.from("x"),
        declaredUncompressed: FAILED_ENTRY_BYTES,
        declaredCompressed: FAILED_ENTRY_BYTES,
      },
    ]);
    await expect(inspectZip(zip)).rejects.toMatchObject({
      code: "ZIP_ENTRY_SIZE_EXCEEDED",
      status: 400,
    });
    const error = await inspectZip(zip).catch((e: unknown) => e) as { message: string };
    expect(error.message).toMatch(/src\/big-data\.ts/);
    expect(error.message).toMatch(/64 MiB/);
    expect(error.message).toContain(FAILED_ENTRY_BYTES.toLocaleString("en-US"));
    expect(error.message).toContain(MAX_ENTRY_BYTES.toLocaleString("en-US"));
    expect(error.message).toMatch(/Remove it from the project ZIP/);
  });

  it("does not exclude source files under similar-looking directories", async () => {
    expect(isGeneratedArchivePath("src/build-tools/important.ts")).toBe(false);
    const zip = buildStoredZip([
      {
        name: "src/build-tools/important.ts",
        data: Buffer.from("x"),
        declaredUncompressed: FAILED_ENTRY_BYTES,
        declaredCompressed: FAILED_ENTRY_BYTES,
      },
    ]);
    await expect(inspectZip(zip)).rejects.toMatchObject({ code: "ZIP_ENTRY_SIZE_EXCEEDED" });
  });

  it("still applies entry-type and encryption checks to generated paths", async () => {
    const symlink = buildStoredZip([
      { name: "intake-archive/.next/cache/link", data: Buffer.from("target"), unixFileType: 0o120777 },
    ]);
    await expect(inspectZip(symlink)).rejects.toMatchObject({ code: "ZIP_SYMLINK_ENTRY" });

    const encrypted = buildStoredZip([
      { name: "intake-archive/.next/cache/secret.bin", data: Buffer.from("secret"), flags: 0x1 },
    ]);
    await expect(inspectZip(encrypted)).rejects.toMatchObject({ code: "ZIP_ENCRYPTED_ENTRY" });
  });

  it("never lets the exclusion policy waive path traversal", async () => {
    const traversal = buildStoredZip([{ name: ".next/../../etc/passwd", data: Buffer.from("x") }]);
    await expect(inspectZip(traversal)).rejects.toMatchObject({
      code: "ZIP_UNSAFE_PATH_TRAVERSAL",
    });
  });

  it("still enforces global entry-count and uncompressed-size limits for generated paths", async () => {
    const overCount = buildStoredZip([
      { name: "intake-archive/.next/cache/a.bin", data: Buffer.from("x") },
    ]);
    await expect(inspectZip(overCount, { maxEntries: 0 })).rejects.toMatchObject({
      code: "ZIP_ENTRY_COUNT_EXCEEDED",
    });

    const overTotal = buildStoredZip([
      {
        name: "intake-archive/.next/cache/bomb.bin",
        data: Buffer.from("x"),
        declaredUncompressed: 1_073_741_825,
        declaredCompressed: 1_073_741_825,
      },
    ]);
    await expect(inspectZip(overTotal)).rejects.toMatchObject({
      code: "ZIP_UNCOMPRESSED_SIZE_EXCEEDED",
    });
  });
});
