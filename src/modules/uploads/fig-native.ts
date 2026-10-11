import * as fflate from "fflate";
import { decompress as zstdDecompress } from "fzstd";
import * as kiwi from "kiwi-schema";
import { createHash } from "node:crypto";
import { HttpError } from "../../middleware/errors.js";

// Native Figma `.fig` parser.
//
// A `.fig` file is a ZIP archive (store mode) that contains `canvas.fig`
// (plus `meta.json`, `thumbnail.png`, optional `images/`). `canvas.fig` is a
// length-prefixed binary in Figma's Kiwi serialization format:
//
//   [8B prelude "fig-kiwi"][4B version LE][4B schemaLen][schema chunk]
//   [4B messageLen][message chunk][optional pass-through chunks...]
//
// The schema chunk is raw-deflate compressed and is self-describing: it defines
// every type used in the file, so we decode it from the file itself rather than
// bundling a schema that goes stale. The message chunk is Zstandard-compressed
// (older files use deflate). Decoding yields `{ nodeChanges: [...], blobs }`;
// the tree is reconstructed from each node's `parentIndex` (parent guid +
// position).
//
// This is a real parser built on kiwi-schema (the same Kiwi codec the format is
// based on). It recovers actual design nodes and properties; it never
// fabricates data. Properties the format/parse does not expose are recorded as
// structured diagnostics, never invented.

const MAX_CANVAS_BYTES = 64 * 1024 * 1024;
const NODE_BUDGET = 50_000;

export type FigNativeDiagnostic = { code: string; message: string; nodeId?: string };

export type FigNativeNode = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  size?: { x: number; y: number } | undefined;
  position?: { x: number; y: number } | undefined;
  layout?: {
    mode: "HORIZONTAL" | "VERTICAL" | "NONE";
    primaryAlign?: string | undefined;
    counterAlign?: string | undefined;
    gap?: number | undefined;
    padding?: { left: number; right: number; top: number; bottom: number } | undefined;
  } | undefined;
  fills?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } | undefined; hex?: string | undefined }> | undefined;
  strokes?: Array<{ type: string; color?: { r: number; g: number; b: number; a: number } | undefined; hex?: string | undefined; weight?: number | undefined }> | undefined;
  cornerRadius?: number | undefined;
  rectangleCornerRadii?: [number, number, number, number] | undefined;
  opacity?: number | undefined;
  characters?: string | undefined;
  typography?: {
    fontFamily?: string | undefined;
    fontWeight?: number | undefined;
    fontSize?: number | undefined;
    lineHeight?: number | undefined;
    letterSpacing?: number | undefined;
    textAlign?: string | undefined;
  } | undefined;
  componentId?: string | undefined;
  isInstance?: boolean | undefined;
  children: FigNativeNode[];
};

export type FigNativePage = {
  id: string;
  name: string;
  type: string;
  children: FigNativeNode[];
};

export type FigNativeDocument = {
  fileName: string;
  version: number;
  pages: FigNativePage[];
  nodeCount: number;
  componentCount: number;
  instanceCount: number;
  diagnostics: FigNativeDiagnostic[];
};

export type FigNativeParseResult = {
  sha256: string;
  byteLength: number;
  document: FigNativeDocument;
};

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Recover visible text characters from `textData`/`derivedTextData`. */
function readTextCharacters(raw: Record<string, any>): string | undefined {
  const candidates = [raw.textData, raw.derivedTextData];
  for (const source of candidates) {
    if (isRecord(source) && typeof source.characters === "string" && source.characters.length > 0) {
      return source.characters;
    }
  }
  return undefined;
}

/**
 * Recover typography from a resolved `style` object when present, otherwise from
 * node-level `fontName`/`fontSize`/`fontWeight`/`textAlign` fields. Returns
 * undefined only when the file exposes no usable typography, so the caller can
 * record a diagnostic instead of inventing values.
 */
function extractTypography(
  raw: Record<string, any>,
  style: Record<string, any> | undefined,
): NonNullable<FigNativeNode["typography"]> | undefined {
  const fontName = isRecord(raw.fontName) ? raw.fontName : undefined;
  const typography: NonNullable<FigNativeNode["typography"]> = {};
  let found = false;
  const setStr = (key: "fontFamily" | "textAlign", value: unknown) => {
    if (typeof value === "string") { (typography as Record<string, unknown>)[key] = value; found = true; }
  };
  const setNum = (key: "fontWeight" | "fontSize" | "lineHeight" | "letterSpacing", value: unknown) => {
    if (typeof value === "number") { (typography as Record<string, unknown>)[key] = value; found = true; }
  };
  if (style) {
    setStr("fontFamily", style.fontFamily);
    setNum("fontWeight", style.fontWeight);
    setNum("fontSize", style.fontSize);
    setNum("lineHeight", typeof style.lineHeightPx === "number" ? style.lineHeightPx : style.lineHeightPercent);
    setNum("letterSpacing", style.letterSpacing);
    setStr("textAlign", style.textAlignHorizontal);
  }
  if (!found && fontName) setStr("fontFamily", fontName.family);
  if (typeof raw.fontSize === "number") setNum("fontSize", raw.fontSize);
  if (typeof raw.fontWeight === "number") setNum("fontWeight", raw.fontWeight);
  if (typeof raw.textAlign === "string") setStr("textAlign", raw.textAlign);
  return found ? typography : undefined;
}

function hasZipMagic(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07) &&
    (bytes[3] === 0x04 || bytes[3] === 0x06 || bytes[3] === 0x08)
  );
}

function hasKiwiMagic(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 8).toString("latin1");
  return head === "fig-kiwi" || head === "fig-makee" || head === "fig-deck" || head.startsWith("fig-jam");
}

function isSupportedPrelude(prelude: string): boolean {
  return prelude === "fig-kiwi" || prelude === "fig-makee" || prelude === "fig-deck" || prelude.startsWith("fig-jam");
}

function toHex(color: any): string | undefined {
  if (!isRecord(color)) return undefined;
  const { r, g, b } = color;
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return undefined;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return `#${c(r).toString(16).padStart(2, "0")}${c(g).toString(16).padStart(2, "0")}${c(b).toString(16).padStart(2, "0")}`;
}

function mapPaint(paint: any): { type: string; color?: { r: number; g: number; b: number; a: number } | undefined; hex?: string | undefined } {
  if (!isRecord(paint)) return { type: "UNKNOWN" };
  const type = typeof paint.type === "string" ? paint.type : "UNKNOWN";
  const hex = toHex(paint.color);
  const color = isRecord(paint.color) && typeof paint.color.r === "number" && typeof paint.color.g === "number" && typeof paint.color.b === "number"
    ? {
        r: paint.color.r as number,
        g: paint.color.g as number,
        b: paint.color.b as number,
        a: typeof paint.color.a === "number" ? paint.color.a : 1,
      }
    : undefined;
  const out: { type: string; color?: { r: number; g: number; b: number; a: number } | undefined; hex?: string | undefined } = { type };
  if (color !== undefined) out.color = color;
  if (hex !== undefined) out.hex = hex;
  return out;
}

function guidKey(guid: any): string {
  if (!isRecord(guid)) return "";
  const s = typeof guid.sessionID === "number" ? guid.sessionID : 0;
  const l = typeof guid.localID === "number" ? guid.localID : 0;
  return `${s}:${l}`;
}

/** Decode the raw (already-unzipped) `canvas.fig` binary into `{ message, version }`. */
function decodeCanvasFig(canvas: Uint8Array): { message: Record<string, any>; version: number } {
  if (canvas.byteLength < 16) {
    throw new HttpError(400, "FIG_NATIVE_INVALID", "The canvas.fig payload is too small to be a valid Figma document.");
  }
  const prelude = Buffer.from(canvas.subarray(0, 8)).toString("latin1").replace(/\0+$/, "");
  if (!isSupportedPrelude(prelude)) {
    throw new HttpError(415, "FIG_NATIVE_UNSUPPORTED_PRELUDE", `Unsupported native Figma prelude "${prelude}".`);
  }
  const dv = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  let off = 8;
  const version = dv.getUint32(off, true); off += 4;

  const schemaLen = dv.getUint32(off, true); off += 4;
  if (schemaLen <= 0 || off + schemaLen > canvas.byteLength) {
    throw new HttpError(400, "FIG_NATIVE_INVALID", "The canvas.fig schema chunk length is invalid.");
  }
  const schemaCompressed = canvas.subarray(off, off + schemaLen); off += schemaLen;

  let schemaBin: Uint8Array;
  try {
    schemaBin = fflate.decompressSync(schemaCompressed);
  } catch {
    try {
      schemaBin = fflate.inflateSync(schemaCompressed);
    } catch {
      throw new HttpError(400, "FIG_NATIVE_INVALID", "The canvas.fig schema chunk could not be decompressed.");
    }
  }

  const messageLen = dv.getUint32(off, true); off += 4;
  if (messageLen <= 0 || off + messageLen > canvas.byteLength) {
    throw new HttpError(400, "FIG_NATIVE_INVALID", "The canvas.fig message chunk length is invalid.");
  }
  const messageCompressed = canvas.subarray(off, off + messageLen); off += messageLen;

  let messageBin: Uint8Array;
  try {
    const out = zstdDecompress(messageCompressed);
    messageBin = out instanceof Uint8Array ? out : new Uint8Array(out as any);
  } catch {
    try {
      messageBin = fflate.decompressSync(messageCompressed);
    } catch {
      try {
        messageBin = fflate.inflateSync(messageCompressed);
      } catch {
        throw new HttpError(400, "FIG_NATIVE_INVALID", "The canvas.fig message chunk could not be decompressed.");
      }
    }
  }

  let message: Record<string, any>;
  try {
    const schema = kiwi.decodeBinarySchema(new Uint8Array(schemaBin));
    const compiled = kiwi.compileSchema(schema);
    message = compiled.decodeMessage(messageBin) as Record<string, any>;
  } catch {
    throw new HttpError(400, "FIG_NATIVE_INVALID", "The canvas.fig message could not be decoded with its embedded schema.");
  }
  if (!isRecord(message) || !Array.isArray(message.nodeChanges)) {
    throw new HttpError(400, "FIG_NATIVE_INVALID", "The decoded Figma message did not contain a node list.");
  }
  return { message, version };
}


function nodeToFigNative(raw: Record<string, any>, diagnostics: FigNativeDiagnostic[], id: string): FigNativeNode {
  const node: FigNativeNode = {
    id,
    name: typeof raw.name === "string" ? raw.name : "",
    type: typeof raw.type === "string" ? raw.type : "UNKNOWN",
    visible: raw.visible !== false,
    children: [],
  };
  if (isRecord(raw.size) && typeof raw.size.x === "number" && typeof raw.size.y === "number") {
    node.size = { x: raw.size.x, y: raw.size.y };
  }
  if (isRecord(raw.transform) && typeof raw.transform.m02 === "number" && typeof raw.transform.m12 === "number") {
    node.position = { x: raw.transform.m02, y: raw.transform.m12 };
  }
  if (typeof raw.stackMode === "string" && raw.stackMode !== "NONE") {
    const layout: NonNullable<FigNativeNode["layout"]> = {
      mode: raw.stackMode === "HORIZONTAL" ? "HORIZONTAL" : "VERTICAL",
    };
    const primaryAlign = typeof raw.primaryAxisAlignItems === "string" ? raw.primaryAxisAlignItems : undefined;
    if (primaryAlign !== undefined) layout.primaryAlign = primaryAlign;
    const counterAlign = typeof raw.counterAxisAlignItems === "string" ? raw.counterAxisAlignItems : undefined;
    if (counterAlign !== undefined) layout.counterAlign = counterAlign;
    if (typeof raw.itemSpacing === "number") layout.gap = raw.itemSpacing;
    if (
      typeof raw.paddingLeft === "number" || typeof raw.paddingRight === "number" ||
      typeof raw.paddingTop === "number" || typeof raw.paddingBottom === "number"
    ) {
      layout.padding = {
        left: num(raw.paddingLeft),
        right: num(raw.paddingRight),
        top: num(raw.paddingTop),
        bottom: num(raw.paddingBottom),
      };
    }
    node.layout = layout;
  }
  if (Array.isArray(raw.fillPaints) && raw.fillPaints.length > 0) {
    node.fills = raw.fillPaints.map(mapPaint);
  }
  if (Array.isArray(raw.strokePaints) && raw.strokePaints.length > 0) {
    node.strokes = raw.strokePaints.map((p: any) => {
      const paint = mapPaint(p);
      const stroke: NonNullable<FigNativeNode["strokes"]>[number] = { type: paint.type };
      if (paint.color !== undefined) stroke.color = paint.color;
      if (paint.hex !== undefined) stroke.hex = paint.hex;
      if (typeof raw.strokeWeight === "number") stroke.weight = raw.strokeWeight;
      return stroke;
    });
  }
  if (typeof raw.cornerRadius === "number" && raw.cornerRadius > 0) node.cornerRadius = raw.cornerRadius;
  if (
    typeof raw.rectangleTopLeftCornerRadius === "number" ||
    typeof raw.rectangleTopRightCornerRadius === "number" ||
    typeof raw.rectangleBottomLeftCornerRadius === "number" ||
    typeof raw.rectangleBottomRightCornerRadius === "number"
  ) {
    node.rectangleCornerRadii = [
      num(raw.rectangleTopLeftCornerRadius),
      num(raw.rectangleTopRightCornerRadius),
      num(raw.rectangleBottomLeftCornerRadius),
      num(raw.rectangleBottomRightCornerRadius),
    ];
  }
  if (typeof raw.opacity === "number") node.opacity = raw.opacity;
  const textChars = typeof raw.characters === "string" && raw.characters.length > 0 ? raw.characters : readTextCharacters(raw);
  if (textChars !== undefined) node.characters = textChars;
  const style = isRecord(raw.style) ? raw.style : undefined;
  const hasText = node.characters !== undefined && node.characters.length > 0;
  if (hasText) {
    const typography = extractTypography(raw, style);
    if (typography) {
      node.typography = typography;
    } else {
      diagnostics.push({
        code: "FIG_NATIVE_TEXT_STYLE_PARTIAL",
        message: `Text node "${node.name}" exposed characters but no resolved style.`,
        nodeId: id,
      });
    }
  }
  if (typeof raw.componentId === "string" && raw.componentId) node.componentId = raw.componentId;
  if (raw.type === "INSTANCE") node.isInstance = true;
  return node;
}


/** Reconstruct the tree from the flat nodeChanges array using parentIndex. */
export function buildFigTree(
  message: Record<string, any>,
  diagnostics: FigNativeDiagnostic[],
): { pages: FigNativePage[]; nodeCount: number; componentCount: number; instanceCount: number } {
  const changes: any[] = Array.isArray(message.nodeChanges) ? message.nodeChanges : [];
  const byGuid = new Map<string, Record<string, any>>();
  let componentCount = 0;
  let instanceCount = 0;
  for (const change of changes) {
    if (!isRecord(change)) continue;
    if (change.phase === "REMOVED") continue;
    const key = guidKey(change.guid);
    if (key) byGuid.set(key, change);
    if (change.type === "COMPONENT") componentCount += 1;
    if (change.type === "INSTANCE") instanceCount += 1;
    if (byGuid.size > NODE_BUDGET) {
      diagnostics.push({ code: "FIG_NATIVE_NODE_BUDGET", message: `Node budget of ${NODE_BUDGET} reached; remaining nodes were not reconstructed.` });
      break;
    }
  }

  const childrenByParent = new Map<string, Array<{ position: string; guid: string; change: any }>>();
  for (const change of changes) {
    if (!isRecord(change) || change.phase === "REMOVED") continue;
    const parent = isRecord(change.parentIndex) ? guidKey(change.parentIndex.guid) : "";
    if (!parent) continue;
    const list = childrenByParent.get(parent) ?? [];
    const position = isRecord(change.parentIndex) && typeof change.parentIndex.position === "string"
      ? change.parentIndex.position
      : "~";
    list.push({ position, guid: guidKey(change.guid), change });
    childrenByParent.set(parent, list);
  }


  const built = new Map<string, FigNativeNode>();
  const build = (change: any, guid: string, depth: number): FigNativeNode => {
    const existing = built.get(guid);
    if (existing) return existing;
    const node = nodeToFigNative(change, diagnostics, guid);
    built.set(guid, node);
    if (depth < 64) {
      const kids = (childrenByParent.get(guid) ?? []).slice()
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0));
      for (const kid of kids) {
        const kidChange = byGuid.get(kid.guid) ?? kid.change;
        node.children.push(build(kidChange, kid.guid, depth + 1));
      }
    } else {
      diagnostics.push({ code: "FIG_NATIVE_DEPTH_CAPPED", message: `Nesting depth capped under node ${guid}.`, nodeId: guid });
    }
    return node;
  };

  const documentNode = changes.find((c) => isRecord(c) && c.type === "DOCUMENT" && c.phase !== "REMOVED");
  const documentGuid = documentNode ? guidKey(documentNode.guid) : "";
  const pages: FigNativePage[] = [];
  const pageEntries = (childrenByParent.get(documentGuid) ?? []).slice()
    .sort((a, b) => (a.position < b.position ? -1 : 1));
  for (const entry of pageEntries) {
    const canvas = byGuid.get(entry.guid) ?? entry.change;
    if (!isRecord(canvas) || (canvas.type !== "CANVAS" && canvas.type !== "SECTION_OVERLAY")) continue;
    const pageNode = build(canvas, entry.guid, 0);
    pages.push({ id: entry.guid, name: pageNode.name || "Untitled page", type: pageNode.type, children: pageNode.children });
  }
  return { pages, nodeCount: byGuid.size, componentCount, instanceCount };
}

function readMeta(unzipped: Record<string, Uint8Array>): { file_name?: string } | undefined {
  const key = Object.keys(unzipped).find((k) => k.endsWith("meta.json"));
  if (!key) return undefined;
  const metaBytes = unzipped[key];
  if (!metaBytes) return undefined;
  try {
    return JSON.parse(Buffer.from(metaBytes).toString("utf8"));
  } catch {
    return undefined;
  }
}

function finalize(
  bytes: Buffer,
  fileName: string,
  version: number,
  tree: { pages: FigNativePage[]; nodeCount: number; componentCount: number; instanceCount: number },
  diagnostics: FigNativeDiagnostic[],
): FigNativeParseResult {
  if (tree.pages.length === 0) {
    throw new HttpError(422, "FIG_NATIVE_NO_PAGES", "The Figma document contained no pages/canvases to convert.");
  }
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteLength: bytes.length,
    document: {
      fileName: fileName.slice(0, 200),
      version,
      pages: tree.pages,
      nodeCount: tree.nodeCount,
      componentCount: tree.componentCount,
      instanceCount: tree.instanceCount,
      diagnostics,
    },
  };
}


/**
 * Parse an uploaded native `.fig` file entirely on the local filesystem. Raw
 * (unzipped) `canvas.fig` binaries are also accepted. No network request is
 * made. Throws actionable HttpErrors for non-ZIP, truncated, or malformed
 * files so a caller can never report a successful parse for an unparsed file.
 */
export function parseNativeFigFile(bytes: Buffer, fileName: string): FigNativeParseResult {
  if (bytes.length === 0) {
    throw new HttpError(400, "FIG_FILE_EMPTY", "The uploaded file is empty.");
  }
  if (hasKiwiMagic(bytes)) {
    const { message, version } = decodeCanvasFig(new Uint8Array(bytes));
    const diagnostics: FigNativeDiagnostic[] = [];
    const tree = buildFigTree(message, diagnostics);
    return finalize(bytes, fileName, version, tree, diagnostics);
  }
  if (!hasZipMagic(bytes)) {
    throw new HttpError(415, "FIG_NATIVE_UNSUPPORTED_FORMAT", "That file is not a native Figma .fig archive. Upload a .fig file exported from Figma (File > Save local copy).");
  }
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = fflate.unzipSync(new Uint8Array(bytes));
  } catch {
    throw new HttpError(400, "FIG_NATIVE_INVALID", "The uploaded .fig archive could not be opened.");
  }
  const canvasKey = Object.keys(unzipped).find((k) => k.endsWith("canvas.fig"));
  if (!canvasKey) {
    throw new HttpError(415, "FIG_NATIVE_NO_CANVAS", "The uploaded archive does not contain a canvas.fig document.");
  }
  const canvas = unzipped[canvasKey];
  if (!canvas) {
    throw new HttpError(415, "FIG_NATIVE_NO_CANVAS", "The uploaded archive does not contain a canvas.fig document.");
  }
  if (canvas.byteLength > MAX_CANVAS_BYTES) {
    throw new HttpError(413, "FIG_NATIVE_TOO_LARGE", "The Figma canvas payload exceeds the supported size limit.");
  }
  const meta = readMeta(unzipped);
  const { message, version } = decodeCanvasFig(canvas);
  const diagnostics: FigNativeDiagnostic[] = [];
  const tree = buildFigTree(message, diagnostics);
  return finalize(bytes, meta?.file_name || fileName, version, tree, diagnostics);
}

