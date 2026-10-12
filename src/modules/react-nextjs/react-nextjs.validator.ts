import * as yauzl from "yauzl";
import { z } from "zod";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errors.js";
import type { ZipInspectionOptions } from "./react-nextjs.types.js";
import { isGeneratedArchivePath } from "./archive-entry-policy.js";

export const reactNextProjectUploadParamsSchema = z.object({
  projectId: z.string().cuid(),
  uploadId: z.string().uuid(),
});

// Distinct, machine-readable failure codes for every safety rule. The UI and
// operator logs can act on these instead of one generic message.
export const ZIP_REJECTION_CODES = {
  MALFORMED: "ARCHIVE_MALFORMED",
  ENTRY_NAME_INVALID: "ZIP_ENTRY_NAME_INVALID",
  UNSAFE_PATH_ABSOLUTE: "ZIP_UNSAFE_PATH_ABSOLUTE",
  UNSAFE_PATH_TRAVERSAL: "ZIP_UNSAFE_PATH_TRAVERSAL",
  SYMLINK_ENTRY: "ZIP_SYMLINK_ENTRY",
  UNSUPPORTED_ENTRY_TYPE: "ZIP_UNSUPPORTED_ENTRY_TYPE",
  ENCRYPTED_ENTRY: "ZIP_ENCRYPTED_ENTRY",
  ENTRY_COUNT_EXCEEDED: "ZIP_ENTRY_COUNT_EXCEEDED",
  ENTRY_SIZE_EXCEEDED: "ZIP_ENTRY_SIZE_EXCEEDED",
  UNCOMPRESSED_SIZE_EXCEEDED: "ZIP_UNCOMPRESSED_SIZE_EXCEEDED",
  COMPRESSION_RATIO_EXCEEDED: "ZIP_COMPRESSION_RATIO_EXCEEDED",
} as const;

function formatBytes(value: number): string {
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(Math.max(value, 1)) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

// Human-readable byte limits (67,108,864 -> "64 MiB") for actionable messages.
function formatByteLimit(value: number): string {
  const MiB = 1024 ** 2;
  if (value % MiB === 0) {
    return `${value / MiB} MiB`;
  }
  return formatBytes(value);
}

// Log safe, structured diagnostics only: the failing rule, counts, sizes, and
// the sanitized entry name. Never log file contents, credentials, or URLs.
function logRejection(details: Record<string, unknown>): void {
  console.warn(`[zip-inspection] rejected ${JSON.stringify(details)}`);
}

// Strip control characters from an entry name before logging.
function sanitizeEntryName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, "?").slice(0, 120);
}

/**
 * Inspect an uploaded ZIP archive without extracting or executing anything.
 *
 * The central directory and entry metadata are read with lazy entries, so no
 * entry data is ever decompressed during inspection and memory stays bounded by
 * the size of the archive buffer itself. Every safety rule is checked
 * independently and the first failure produces its own machine-readable code and
 * an actionable, source-specific message:
 *
 *   - unsafe/absolute paths and path traversal (ZIP Slip),
 *   - symbolic links and other unsupported entry types,
 *   - password-encrypted entries,
 *   - entry-count, total-uncompressed-size, and per-entry size limits,
 *   - compression-ratio (decompression-bomb) limits,
 *   - malformed or truncated archives.
 */
export async function inspectZip(buffer: Buffer, options: ZipInspectionOptions = {}): Promise<void> {
  const maxEntries = options.maxEntries ?? env.ZIP_MAX_ENTRIES;
  const maxExpandedBytes = options.maxExpandedBytes ?? env.ZIP_MAX_UNCOMPRESSED_BYTES;
  const maxEntryBytes = options.maxEntryBytes ?? env.ZIP_MAX_ENTRY_BYTES;
  const maxCompressionRatio = options.maxCompressionRatio ?? env.ZIP_MAX_COMPRESSION_RATIO;

  const reject = (code: string, message: string, details: Record<string, unknown>): never => {
    logRejection({ code, ...details });
    throw new HttpError(400, code, message);
  };

  if (buffer.length < 4 || buffer[0] !== 0x50 || buffer[1] !== 0x4b) {
    reject(
      ZIP_REJECTION_CODES.MALFORMED,
      "The uploaded file is not a readable ZIP archive (it is missing the ZIP signature).",
      { archiveBytes: buffer.length },
    );
  }

  let archive: yauzl.ZipFile;
  try {
    archive = await new Promise<yauzl.ZipFile>((resolve, rejectOpen) => {
      yauzl.fromBuffer(
        buffer,
        { lazyEntries: true, decodeStrings: true, validateEntrySizes: false },
        (error, zipFile) => {
          if (error) rejectOpen(error);
          else if (zipFile) resolve(zipFile);
          else rejectOpen(new Error("ZIP parser did not return an archive"));
        },
      );
    });
  } catch (error) {
    reject(
      ZIP_REJECTION_CODES.MALFORMED,
      "The uploaded ZIP archive could not be read. It may be truncated, corrupted, or use an unsupported ZIP feature.",
      { parserError: error instanceof Error ? error.name : "unknown" },
    );
  }

  let entries = 0;
  let expandedBytes = 0;

  await new Promise<void>((resolve, rejectScan) => {
    let settled = false;
    // Rejections must flow through the promise, never throw inside a yauzl
    // event handler (which would surface as an uncaught exception).
    const fail = (code: string, message: string, details: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      archive.close();
      logRejection({ code, entries, expandedBytes, ...details });
      rejectScan(new HttpError(400, code, message));
    };
    // yauzl validates entry names while reading the central directory and emits
    // its own path errors before the entry event; classify them with the same
    // machine-readable codes so callers see one consistent taxonomy.
    const classifyParserError = (error: Error): { code: string; message: string } => {
      const text = error.message ?? "";
      if (text.includes("absolute path")) {
        return {
          code: ZIP_REJECTION_CODES.UNSAFE_PATH_ABSOLUTE,
          message:
            "The archive contains an entry with an absolute path. Re-create the ZIP with relative paths inside the project folder.",
        };
      }
      if (text.includes("invalid relative path") || text.includes("invalid characters")) {
        return {
          code: ZIP_REJECTION_CODES.UNSAFE_PATH_TRAVERSAL,
          message:
            "The archive contains a path-traversal entry that could write outside its folder. Re-create the ZIP without '..' path segments.",
        };
      }
      return {
        code: ZIP_REJECTION_CODES.MALFORMED,
        message:
          "The uploaded ZIP archive could not be read. It may be truncated, corrupted, or use an unsupported ZIP feature.",
      };
    };
    archive.on("error", (error) => {
      const classified = classifyParserError(error);
      fail(classified.code, classified.message, {
        parserError: error instanceof Error ? error.name : "unknown",
      });
    });
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

      // 1. Entry names must be decodable and free of NUL bytes.
      if (name.includes("\0")) {
        fail(
          ZIP_REJECTION_CODES.ENTRY_NAME_INVALID,
          "The archive contains an entry with an invalid name.",
          { entry: sanitizeEntryName(name) },
        );
        return;
      }

      // 2. No absolute paths or drive letters (ZIP Slip via absolute paths).
      if (normalizedName.startsWith("/") || /^[a-z]:/i.test(normalizedName)) {
        fail(
          ZIP_REJECTION_CODES.UNSAFE_PATH_ABSOLUTE,
          "The archive contains an entry with an absolute path. Re-create the ZIP with relative paths inside the project folder.",
          { entry: sanitizeEntryName(name) },
        );
        return;
      }

      // 3. No parent-directory traversal (ZIP Slip).
      if (pathParts.includes("..")) {
        fail(
          ZIP_REJECTION_CODES.UNSAFE_PATH_TRAVERSAL,
          "The archive contains a path-traversal entry that could write outside its folder. Re-create the ZIP without '..' path segments.",
          { entry: sanitizeEntryName(name) },
        );
        return;
      }

      // 4. Entry-type checks: symbolic links and other special entries are rejected.
      if (mode === 0xa000) {
        fail(
          ZIP_REJECTION_CODES.SYMLINK_ENTRY,
          "The archive contains a symbolic-link entry. Re-create the ZIP with regular files only.",
          { entry: sanitizeEntryName(name) },
        );
        return;
      }
      if (mode !== 0 && mode !== 0x8000 && mode !== 0x4000) {
        fail(
          ZIP_REJECTION_CODES.UNSUPPORTED_ENTRY_TYPE,
          "The archive contains an unsupported entry type (for example a device or socket entry).",
          { entry: sanitizeEntryName(name) },
        );
        return;
      }

      // 5. Password-encrypted entries are never processed.
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
        fail(
          ZIP_REJECTION_CODES.ENCRYPTED_ENTRY,
          "The archive contains password-encrypted entries. Upload an unencrypted project ZIP.",
          { entry: sanitizeEntryName(name) },
        );
        return;
      }

      // 6. Entry-count limit — global, applies to every entry including
      //    generated ones (excluded entries still consume the count budget).
      if (entries > maxEntries) {
        fail(
          ZIP_REJECTION_CODES.ENTRY_COUNT_EXCEEDED,
          `The archive contains too many files (${entries.toLocaleString("en-US")} entries; the limit is ${maxEntries.toLocaleString("en-US")}). Remove dependency folders such as node_modules and re-create the ZIP.`,
          { maxEntries },
        );
        return;
      }

      // Classification runs only after all path/type/encryption checks above,
      // so an excluded entry can never dodge a security rule.
      const generated = isGeneratedArchivePath(normalizedName);

      // 7. Per-entry uncompressed size limit. Generated build/cache files are
      //    never read, extracted, or decompressed anywhere in the pipeline, so
      //    the per-entry inspection limit does not apply to them; it still
      //    applies to every entry whose content will be processed.
      if (!generated && entry.uncompressedSize > maxEntryBytes) {
        const safePath = sanitizeEntryName(normalizedName);
        fail(
          ZIP_REJECTION_CODES.ENTRY_SIZE_EXCEEDED,
          `A source file exceeds the ${formatByteLimit(maxEntryBytes)} inspection limit: ${safePath} is ${formatBytes(entry.uncompressedSize)} (${entry.uncompressedSize.toLocaleString("en-US")} bytes; limit ${maxEntryBytes.toLocaleString("en-US")} bytes). Remove it from the project ZIP or review the archive.`,
          { entry: safePath, entryUncompressedBytes: entry.uncompressedSize, maxEntryBytes, generated },
        );
        return;
      }

      // 8. Total uncompressed size limit (decompression-bomb protection).
      //    Global: generated entries count toward the expanded total too.
      if (expandedBytes > maxExpandedBytes) {
        fail(
          ZIP_REJECTION_CODES.UNCOMPRESSED_SIZE_EXCEEDED,
          `The archive expands to more than the supported ${formatBytes(maxExpandedBytes)} total. Remove dependency folders such as node_modules and re-create the ZIP.`,
          { maxExpandedBytes },
        );
        return;
      }

      // 9. Compression-ratio limit. Only meaningful where content will later be
      //    decompressed or processed; generated entries are never read, so they
      //    are exempt here while everything else keeps the guard unchanged.
      if (
        !generated &&
        entry.uncompressedSize > 0 &&
        (entry.compressedSize === 0 || entry.uncompressedSize / entry.compressedSize > maxCompressionRatio)
      ) {
        fail(
          ZIP_REJECTION_CODES.COMPRESSION_RATIO_EXCEEDED,
          `The archive contains a file whose compression ratio exceeds the supported ${maxCompressionRatio}:1 limit.`,
          {
            entry: sanitizeEntryName(name),
            entryUncompressedBytes: entry.uncompressedSize,
            entryCompressedBytes: entry.compressedSize,
            maxCompressionRatio,
          },
        );
        return;
      }

      archive.readEntry();
    });
    archive.readEntry();
  });
}
