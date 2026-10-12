// Centralized archive-entry classification policy for generated/irrelevant
// directories. Used by both the ZIP safety inspector and the React/Next.js
// source analyzer so the two never disagree about which entries are generated.
//
// Design rules:
//   * Segment-exact, case-sensitive matching on normalized paths (never naive
//     substring matching), so `src/build-tools/important.ts` is NOT excluded
//     merely because it contains `build`, and `src/Build/` is NOT excluded
//     because a source directory happens to be called Build.
//   * Handles nested paths (`app/node_modules/...`), ZIP root-directory
//     prefixes (`intake-archive/.next/...`), backslash separators, and
//     directory entries with trailing slashes.
//   * A final segment is only treated as a generated *directory* when the path
//     is a directory entry (trailing slash); a plain file named `dist` at the
//     root is a regular entry, not a directory prefix.
//   * This policy only classifies paths for content exclusion. It never
//     exempts any entry from the security checks (ZIP Slip, symlinks,
//     encryption, global entry-count/total-size limits).

export const GENERATED_ARCHIVE_DIRECTORIES = [
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
] as const;

const GENERATED_DIRECTORY_SET: ReadonlySet<string> = new Set<string>(
  GENERATED_ARCHIVE_DIRECTORIES,
);

/**
 * Decide whether an archive entry path belongs to a generated build/cache/
 * dependency directory and should therefore be excluded from source analysis,
 * DIR generation, and conversion input.
 *
 * The caller must have already validated the path (no absolute paths, no `..`
 * traversal) before invoking this: classification must never be used to waive a
 * security check.
 */
export function isGeneratedArchivePath(entryPath: string): boolean {
  const normalized = entryPath.replaceAll("\\", "/");
  const isDirectoryEntry = normalized.endsWith("/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    return false;
  }
  // Directories in the path are every segment except possibly the last one;
  // for directory entries (trailing slash) the last segment is also a directory.
  const directorySegments = isDirectoryEntry ? segments : segments.slice(0, -1);
  return directorySegments.some((segment) => GENERATED_DIRECTORY_SET.has(segment));
}
