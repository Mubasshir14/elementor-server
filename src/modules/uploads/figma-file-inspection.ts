import { createHash } from "node:crypto";
import { HttpError } from "../../middleware/errors.js";
import { FigmaFileSummary, summarizeFigmaFile } from "./figma-import.js";

// The only Figma design format this adapter can parse locally and verifiably is
// the JSON returned by the official Figma REST API `GET /v1/files/:file_key`
// endpoint. It is documented, stable, has an OpenAPI specification, and can be
// saved to disk by the user and uploaded here with zero remote calls.
//
// The native `.fig` format is intentionally NOT supported. A `.fig` file is a
// ZIP archive whose payload (`canvas.fig`) uses Figma's proprietary Kiwi binary
// format with an embedded, version-unstable schema. There is no official parser
// and no published specification, so we must not claim compatibility, invent a
// decoder, or fabricate design data. Uploaded native `.fig` files are detected
// and rejected with an actionable message instead.

const MAX_FIGMA_JSON_BYTES = 25 * 1024 * 1024;
const NODE_BUDGET = 50_000;

export const FIGMA_SUPPORTED_UPLOAD_FORMAT = ".json";
export const FIGMA_SUPPORTED_UPLOAD_DESCRIPTION = "Figma REST API file JSON export (.json)";

/** ZIP local-file-header magic (`PK\x03\x04`). Native `.fig` files start with it. */
function hasZipMagic(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

/** Raw Kiwi payload magic used by unzipped `.fig`/`.deck` binaries. */
function hasKiwiMagic(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8).toString("latin1");
  return head === "fig-kiwi" || head === "fig-makee";
}

export type FigmaNativeFileKind = "fig" | "deck" | "unknown-archive";

/**
 * Detect a native Figma binary design file by its content, independent of the
 * file name. Returns the detected kind, or null when the bytes are not a native
 * Figma design archive.
 */
export function detectNativeFigmaFile(bytes: Buffer): FigmaNativeFileKind | null {
  if (hasKiwiMagic(bytes)) return "fig";
  if (hasZipMagic(bytes)) {
    // A `.fig`/`.deck` archive contains a `canvas.fig` entry; scan the first
    // chunk of the directory for that marker without extracting.
    const window = bytes.subarray(0, Math.min(bytes.length, 64 * 1024)).toString("latin1");
    if (window.includes("canvas.fig")) return "fig";
    return "unknown-archive";
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countNodes(node: unknown, budget = NODE_BUDGET): number {
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

function nodeName(node: unknown): string | undefined {
  if (isRecord(node) && typeof node.name === "string" && node.name.trim()) {
    return node.name.trim().slice(0, 200);
  }
  return undefined;
}

/**
 * Extract the real design structure exposed by the Figma REST API file JSON:
 * one entry per page/canvas with an observed node count, plus the component and
 * style names actually present. Nothing here is invented; every value is read
 * from the uploaded document.
 */
export function extractFigmaStructure(payload: unknown): {
  pages: Array<{ name: string; type: string; nodeCount: number }>;
  totalNodes: number;
  componentNames: string[];
  styleNames: string[];
} {
  if (!isRecord(payload)) {
    throw new HttpError(400, "FIGMA_FILE_INVALID", "The uploaded file is not a Figma design document.");
  }
  const document = payload.document;
  if (!isRecord(document)) {
    throw new HttpError(400, "FIGMA_FILE_INVALID", "The uploaded file does not contain a Figma document tree.");
  }
  const pages: Array<{ name: string; type: string; nodeCount: number }> = [];
  const canvasChildren = Array.isArray(document.children) ? document.children : [];
  for (const canvas of canvasChildren) {
    const name = nodeName(canvas) ?? "Untitled page";
    const type = isRecord(canvas) && typeof canvas.type === "string" ? canvas.type : "CANVAS";
    pages.push({ name, type, nodeCount: countNodes(canvas) });
  }
  const documentNodes = countNodes(document);
  const componentNames: string[] = [];
  if (isRecord(payload.components)) {
    for (const value of Object.values(payload.components)) {
      const name = isRecord(value) ? nodeName(value) : undefined;
      if (name) componentNames.push(name);
    }
  }
  const styleNames: string[] = [];
  if (isRecord(payload.styles)) {
    for (const value of Object.values(payload.styles)) {
      const name = isRecord(value) ? nodeName(value) : undefined;
      if (name) styleNames.push(name);
    }
  }
  return { pages, totalNodes: documentNodes, componentNames, styleNames };
}

export type FigmaFileInspection = {
  sha256: string;
  byteLength: number;
  summary: FigmaFileSummary;
  structure: ReturnType<typeof extractFigmaStructure>;
};

/**
 * Validate and parse an uploaded Figma design file entirely on the local
 * filesystem. No network request is made. Throws actionable HttpErrors for
 * native `.fig` files, malformed JSON, and non-Figma JSON so that a caller can
 * never report a successful parse for a file that was not actually parsed.
 */
export function inspectFigmaFileJson(bytes: Buffer): FigmaFileInspection {
  if (bytes.length === 0) {
    throw new HttpError(400, "FIGMA_FILE_EMPTY", "The uploaded file is empty.");
  }
  if (bytes.length > MAX_FIGMA_JSON_BYTES) {
    throw new HttpError(413, "FIGMA_FILE_TOO_LARGE", "The uploaded Figma file exceeds the supported size limit.");
  }

  const native = detectNativeFigmaFile(bytes);
  if (native === "fig") {
    throw new HttpError(
      415,
      "FIGMA_NATIVE_FILE_UNSUPPORTED",
      "That looks like a native .fig file uploaded with a .json name. Reserve the upload with the .fig filename and the binary content type so it goes through the native Figma parser.",
    );
  }
  if (native === "unknown-archive") {
    throw new HttpError(
      415,
      "FIGMA_FILE_UNSUPPORTED_FORMAT",
      "That file is a compressed archive, not a Figma REST API file JSON export. Upload the .json export instead.",
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new HttpError(
      400,
      "FIGMA_FILE_INVALID_JSON",
      "The uploaded file is not valid JSON. Export the Figma file JSON and upload that .json file.",
    );
  }

  // summarizeFigmaFile throws when the payload is not a genuine Figma file
  // response (missing name or document), which prevents false success.
  const summary = summarizeFigmaFile("upload", payload);
  const structure = extractFigmaStructure(payload);

  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    summary,
    structure,
  };
}

