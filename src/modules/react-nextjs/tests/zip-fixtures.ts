// Deterministic synthetic ZIP fixtures for regression tests.
//
// Build stored-entry ZIPs in memory with *declared* central-directory sizes
// that may differ from the actual stored payload. Declared sizes are what the
// metadata-only safety inspector sees (it never opens entry streams), so tests
// can model multi-megabyte generated entries with kilobyte payloads — no large
// binary fixtures, no 300 MB commits.
import { deflateRawSync } from "node:zlib";

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface SyntheticZipEntry {
  name: string;
  /** Actual stored payload bytes (defaults to a small placeholder). */
  data?: Buffer | string;
  /** Uncompressed size declared in local+central headers (defaults to data length). */
  declaredUncompressed?: number;
  /** Compressed size declared in local+central headers (defaults to data length). */
  declaredCompressed?: number;
  /** General-purpose bit flag (bit 0 = encrypted). */
  flags?: number;
  /** Unix file mode in the external-attributes high 16 bits (e.g. 0o120777 symlink). */
  unixFileType?: number;
  /** Compression method (0 = stored; deflate needs real compressed payload). */
  method?: number;
}

export function buildStoredZip(entries: SyntheticZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = typeof entry.data === "string" ? Buffer.from(entry.data) : (entry.data ?? Buffer.from("x"));
    const declaredUncompressed = entry.declaredUncompressed ?? data.length;
    const declaredCompressed = entry.declaredCompressed ?? data.length;
    const flags = entry.flags ?? 0;
    const method = entry.method ?? 0;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(declaredCompressed, 18);
    local.writeUInt32LE(declaredUncompressed, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(checksum, 16);
    header.writeUInt32LE(declaredCompressed, 20);
    header.writeUInt32LE(declaredUncompressed, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt32LE(((entry.unixFileType ?? 0o100644) << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuffer, end]);
}

/** Build a genuinely deflated entry (used for the compression-ratio guard). */
export function buildDeflatedZipEntry(name: string, contents: string): { name: string; data: Buffer; method: number } {
  return { name, data: deflateRawSync(Buffer.from(contents)), method: 8 };
}
