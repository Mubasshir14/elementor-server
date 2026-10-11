import * as yauzl from "yauzl";
import { HttpError } from "../../middleware/errors.js";

const MAX_ENTRIES = 10_000;
const MAX_EXPANDED_BYTES = 512 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 200;

export async function inspectZip(buffer: Buffer): Promise<void> {
  try {
    const archive = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(
        buffer,
        { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
        (error, zipFile) => {
          if (error) reject(error);
          else if (zipFile) resolve(zipFile);
          else reject(new Error("ZIP parser did not return an archive"));
        },
      );
    });
    await new Promise<void>((resolve, reject) => {
      let entries = 0;
      let expandedBytes = 0;
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(error);
      };
      archive.on("error", (error) => fail(error));
      archive.on("end", () => {
        if (settled) return;
        settled = true;
        resolve();
      });
      archive.on("entry", (entry) => {
        entries += 1;
        expandedBytes += entry.uncompressedSize;
        const name = entry.fileName;
        const normalizedName = name.replaceAll("\\", "/");
        const pathParts = normalizedName.split("/");
        const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        const invalidFileType = mode !== 0 && mode !== 0x8000 && mode !== 0x4000;
        if (
          entries > MAX_ENTRIES ||
          expandedBytes > MAX_EXPANDED_BYTES ||
          name.includes("\0") ||
          normalizedName.startsWith("/") ||
          /^[a-z]:/i.test(normalizedName) ||
          pathParts.includes("..") ||
          invalidFileType ||
          (entry.generalPurposeBitFlag & 0x1) !== 0 ||
          (entry.uncompressedSize > 0 &&
            (entry.compressedSize === 0 ||
              entry.uncompressedSize / entry.compressedSize > MAX_COMPRESSION_RATIO))
        ) {
          fail(new HttpError(400, "UNSAFE_ARCHIVE", "Archive contains unsafe paths or exceeds safety limits"));
          return;
        }
        archive.readEntry();
      });
      archive.readEntry();
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "UNSAFE_ARCHIVE", "Archive is malformed or contains unsafe entries");
  }
}
