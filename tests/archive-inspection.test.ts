import { describe, expect, it } from "vitest";
import { inspectZip } from "../src/modules/uploads/archive-inspection.js";

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

describe("uploaded archive inspection", () => {
  it("accepts a safe ZIP without extracting it", async () => {
    await expect(inspectZip(makeZip("src/page.tsx", "export default null"))).resolves.toBeUndefined();
  });

  it("rejects a path-traversal ZIP entry", async () => {
    await expect(inspectZip(makeZip("../outside.txt", "not extracted"))).rejects.toMatchObject({
      code: "UNSAFE_ARCHIVE",
      status: 400,
    });
  });

  it("rejects a symbolic-link entry", async () => {
    await expect(inspectZip(makeZip("src/link", "target", 0xa1ff))).rejects.toMatchObject({
      code: "UNSAFE_ARCHIVE",
      status: 400,
    });
  });

  it("rejects malformed ZIP data", async () => {
    await expect(inspectZip(Buffer.from("not a zip"))).rejects.toBeTruthy();
  });
});
