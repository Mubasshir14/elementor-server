import { createHash } from "node:crypto";
import { HttpError } from "../../middleware/errors.js";

// This module keeps only the local, network-free parsing helpers for a Figma
// REST API file JSON export. All OAuth, access-token, and remote-API code was
// removed: the Figma intake workflow now uses direct file upload only.

export type FigmaFileSummary = {
  fileKey: string;
  name: string;
  lastModified?: string | undefined;
  editorType?: string | undefined;
  version?: string | undefined;
  thumbnailUrl?: string | undefined;
  pageCount?: number | undefined;
  componentCount?: number | undefined;
  styleCount?: number | undefined;
  nodeCount?: number | undefined;
};

function countNodes(node: unknown, budget = 50_000): number {
  let count = 0;
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") continue;
    count += 1;
    if (count > budget) return count;
    const record = current as Record<string, unknown>;
    if (Array.isArray(record.children)) {
      for (const child of record.children) stack.push(child);
    }
  }
  return count;
}

/**
 * Summarize a Figma REST API file JSON payload. This reads only values that the
 * payload actually exposes and throws when the payload is not a genuine Figma
 * file response, so a caller can never report success for an unparsed file.
 */
export function summarizeFigmaFile(fileKey: string, payload: unknown): FigmaFileSummary {
  if (typeof payload !== "object" || payload === null) {
    throw new HttpError(400, "FIGMA_FILE_INVALID", "The uploaded file is not a Figma design document.");
  }
  const record = payload as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.trim()) {
    throw new HttpError(400, "FIGMA_FILE_INVALID", "The uploaded file is missing the Figma file name.");
  }
  const document = record.document as Record<string, unknown> | undefined;
  const children = Array.isArray(document?.children) ? document!.children as unknown[] : [];
  const components = typeof record.components === "object" && record.components !== null
    ? Object.keys(record.components as Record<string, unknown>).length
    : 0;
  const styles = typeof record.styles === "object" && record.styles !== null
    ? Object.keys(record.styles as Record<string, unknown>).length
    : 0;
  return {
    fileKey,
    name: record.name.trim().slice(0, 200),
    lastModified: typeof record.lastModified === "string" ? record.lastModified : undefined,
    editorType: typeof record.editorType === "string" ? record.editorType : undefined,
    version: typeof record.version === "string" ? record.version : undefined,
    thumbnailUrl: typeof record.thumbnailUrl === "string" ? record.thumbnailUrl : undefined,
    pageCount: children.length || undefined,
    componentCount: components || undefined,
    styleCount: styles || undefined,
    nodeCount: document ? countNodes(document) : undefined,
  };
}

export function figmaSnapshotStorageKey(projectId: string, digest: string): string {
  const safe = digest.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24) || createHash("sha256").update(projectId).digest("hex").slice(0, 24);
  return `imports/${projectId}/figma-${safe}.json`;
}

