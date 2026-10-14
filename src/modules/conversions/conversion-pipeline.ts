import { HttpError } from "../../middleware/errors.js";
import { Readable } from "node:stream";
import { prisma } from "../../infrastructure/database/prisma.js";
import { storage } from "../../infrastructure/storage/local.js";
import {
  ConversionRules,
  ConversionSourceType,
  loadConversionRules,
} from "../rules/rule-loader.js";
import {
  requestConversionCompletion,
  AiCompletionRequest,
} from "../../infrastructure/ai/provider.js";
import { validateDir, DirValidationResult } from "./dir-schema.js";
import { parseNativeFigFile, FigNativeDocument } from "../uploads/fig-native.js";
import { generateElementorOutput, ElementorGenerationContext } from "./elementor-generator.js";
import { projectReactSnapshotForAi } from "../react-nextjs/react-nextjs.service.js";
import { EmitterDocument } from "./elementor-output-schema.js";

// Stage 3 & 5 Token budget constants:
// Groq's on-demand TPM limit is 8,000 tokens (prompt tokens + completion tokens).
// Whole-page token limits (single-section / monolithic):
// 6000 prompt tokens + 1800 completion tokens = 7800 tokens (< 8000 TPM limit).
const MAX_PROMPT_ESTIMATED_TOKENS = 6000;
const DIR_MAX_OUTPUT_TOKENS = 1800;
// Bounded section-by-section constants (multi-section):
// 6200 prompt tokens + 1200 completion tokens = 7400 tokens (< 8000 TPM limit).
const SECTION_MAX_PROMPT_TOKENS = 6200;
const SECTION_MAX_OUTPUT_TOKENS = 1200;

function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// Conversion pipeline. Each stage is separated and truthful:
//
//   1. load the current Markdown rules (runtime, invalidated on edit),
//   2. obtain the parsed source design,
//   3. ask the AI to produce the canonical DIR,
//   4. validate that DIR against the documented specification,
//   5. generate native Elementor output from the validated DIR.
//
// Stage 5 is the real AI-driven DIR-to-Elementor transformation. It uses the
// current ELEMENTOR_SKILL.md rule file as trusted system instructions and the
// validated canonical DIR as the only design input. The result must be genuine
// native Elementor JSON; HTML/CSS or the DIR itself are never acceptable output.

export type ConversionSource = {
  sourceType: ConversionSourceType;
  snapshotKey: string;
};

export interface ConversionContext {
  projectId: string;
  conversionId: string;
  sourceType: ConversionSourceType;
}

export type ConversionPipelineResult =
  | {
      status: "BLOCKED";
      stage: string;
      diagnostics: Array<{ code: string; message: string; stage: string }>;
      ruleVersions: Array<{ fileName: string; sha256: string }>;
    }
  | {
      status: "SUCCEEDED";
      dir: unknown;
      dirValidation: DirValidationResult;
      elementorOutput: EmitterDocument;
      ruleVersions: Array<{ fileName: string; sha256: string }>;
    };

const DIR_TASK = [
  "Interpret the design in the UNTRUSTED-DESIGN block using the source analysis",
  "rules above, then output the canonical DIR JSON for the target described in",
  "the target rules above. Keep \"globals\": {}, \"breakpoints\": {}, \"assets\": [] minimal,",
  "and emit the layout in \"pages\": [{ \"sections\": [...] }] with headings, text, and buttons.",
  "Node kinds MUST be strictly one of: 'container', 'heading', 'text', 'button', 'image', 'iconBox', 'nav', 'form'.",
  "Never use kinds like 'footer', 'header', 'section' for child nodes; use 'container' instead.",
  "Return ONE complete, valid DIR JSON object and nothing else: no markdown fences, no comments.",
].join(" ");

const ELEMENTOR_TASK = [
  "You are converting a validated canonical DIR into native Elementor output.",
  "Using the Elementor output rules provided in the system instructions, produce",
  "a single native Elementor JSON document and return nothing else.",
  "Return ONLY the Elementor JSON object: no markdown fences, no comments, no",
  "explanation.",
].join(" ");

function normalizeDir(dir: any): any {
  if (!dir || typeof dir !== "object") return dir;
  if (dir.version === undefined) dir.version = "1.0";
  if (!dir.meta || typeof dir.meta !== "object") dir.meta = {};
  if (!dir.breakpoints || typeof dir.breakpoints !== "object") dir.breakpoints = {};
  if (!dir.globals || typeof dir.globals !== "object") dir.globals = {};
  if (!Array.isArray(dir.assets)) dir.assets = [];

  if (!Array.isArray(dir.pages)) {
    if (Array.isArray(dir.sections)) {
      dir.pages = [{ id: "main-page", sections: dir.sections }];
    } else {
      dir.pages = [{ id: "main-page", sections: [] }];
    }
  }

  // Canonical DIR node kinds per dir-schema.ts. Unknown kinds are normalized to
  // containers here so validation can still report them structurally; this does
  // NOT drop or merge sections.
  const canonicalKinds = new Set(["container", "heading", "text", "button", "image", "iconBox", "nav", "form"]);
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.kind && !canonicalKinds.has(node.kind)) {
      node.kind = "container";
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };

  dir.pages = dir.pages.map((page: any, idx: number) => {
    if (!page || typeof page !== "object") {
      return { id: `page-${idx}`, sections: [] };
    }
    // The DIR schema requires each page to have a `sections` array. If the AI
    // output is malformed and supplies a non‑array `sections` value, do **not**
    // silently turn it into an empty array; let `validateDir` report the issue
    // so the pipeline can be blocked before any Elementor generation runs.
    const rawSections = page.sections;
    if (Array.isArray(rawSections)) {
      rawSections.forEach((sec: any) => {
        if (sec && typeof sec === "object") {
          if (!sec.role || typeof sec.role !== "string" || !sec.role.trim()) {
            sec.role = "content";
          }
          if (!Array.isArray(sec.children)) sec.children = [];
          sec.children.forEach(walk);
        }
      });
      page.sections = rawSections;
    } else {
      // Keep the (possibly wrong) value intact – validation will flag it.
      // No further processing of section children.
    }
    return page;
  });

  return dir;
}

function extractJson(text: string): unknown {
  let candidate = text.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(candidate);
  if (fenceMatch?.[1]) {
    candidate = fenceMatch[1].trim();
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new HttpError(422, "DIR_UNPARSEABLE", "The AI response did not contain a valid JSON object envelope.");
  }
  candidate = candidate.slice(start, end + 1);

  try {
    return normalizeDir(JSON.parse(candidate));
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Unexpected non-whitespace character after JSON at position") ||
      msg.includes("Unexpected end of JSON input") ||
      msg.includes("Unterminated string") ||
      msg.includes("Expected ',' or ']' after array element")
    ) {
      throw new HttpError(
        422,
        "DIR_TRUNCATED",
        `The AI response appears truncated or incomplete (${msg}). Refusing to repair or accept incomplete DIR JSON.`,
      );
    }
    console.error("DIR JSON parse failed:", msg, "Length:", text.length, "Tail 300 chars:\n", text.slice(-300));
    throw new HttpError(422, "DIR_UNPARSEABLE", `The AI response was not valid DIR JSON (${msg}).`);
  }
}

export function extractSectionDirJson(
  text: string,
  fallbackId: string,
  fallbackRole: string,
): { id: string; role: string; children: unknown[] } {
  let candidate = text.trim();
  const fenceMatch = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(candidate);
  if (fenceMatch?.[1]) {
    candidate = fenceMatch[1].trim();
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new HttpError(422, "DIR_UNPARSEABLE", "The AI section response did not contain a valid JSON object envelope.");
  }
  candidate = candidate.slice(start, end + 1);

  let parsed: any;
  try {
    parsed = JSON.parse(candidate);
  } catch (err: any) {
    const msg = err instanceof Error ? err.message : String(err);
    if (
      msg.includes("Unexpected non-whitespace character after JSON at position") ||
      msg.includes("Unexpected end of JSON input") ||
      msg.includes("Unterminated string") ||
      msg.includes("Expected ',' or ']' after array element")
    ) {
      throw new HttpError(
        422,
        "DIR_TRUNCATED",
        `Section generation response was truncated or incomplete (${msg}). Refusing to accept partial section output.`,
      );
    }
    throw new HttpError(422, "DIR_UNPARSEABLE", `Failed to parse section DIR JSON: ${msg}`);
  }

  // Support wrappers if the model returned { section: ... } or { sections: [ ... ] } or { pages: [ ... ] }
  if (parsed.section && typeof parsed.section === "object") parsed = parsed.section;
  if (Array.isArray(parsed.sections) && parsed.sections.length > 0) parsed = parsed.sections[0];
  if (Array.isArray(parsed.pages) && parsed.pages[0]?.sections?.[0]) parsed = parsed.pages[0].sections[0];

  if (!parsed || typeof parsed !== "object") {
    throw new HttpError(422, "DIR_INVALID", "Generated section is not an object.");
  }

  const role = typeof parsed.role === "string" && parsed.role.trim() ? parsed.role.trim() : fallbackRole;
  const id = typeof parsed.id === "string" && parsed.id.trim() ? parsed.id.trim() : fallbackId;
  const children = Array.isArray(parsed.children) ? parsed.children : [];

  const canonicalKinds = new Set(["container", "heading", "text", "button", "image", "iconBox", "nav", "form"]);
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.kind && !canonicalKinds.has(node.kind)) {
      node.kind = "container";
    }
    if (Array.isArray(node.children)) {
      node.children.forEach(walk);
    }
  };
  children.forEach(walk);

  return { id, role, children };
}

export interface SourceSectionCandidate {
  id: string;
  name: string;
  role: string;
  raw: any;
}

export function extractSourceSections(snapshot: any): SourceSectionCandidate[] {
  if (!snapshot || typeof snapshot !== "object") return [];

  // 1. React / Next.js routes
  if (Array.isArray(snapshot.routes)) {
    const items: SourceSectionCandidate[] = [];
    for (const route of snapshot.routes) {
      if (Array.isArray(route.sections)) {
        for (const sec of route.sections) {
          if (sec && typeof sec === "object") {
            items.push({
              id: sec.id || `sec-${items.length + 1}`,
              name: sec.name || sec.role || `Section ${items.length + 1}`,
              role: sec.role || "content",
              raw: {
                ...sec,
                routePath: route.path,
                routeName: route.name,
              },
            });
          }
        }
      }
    }
    if (items.length > 0) return items;
  }

  // 2. Direct sections on snapshot root
  if (Array.isArray(snapshot.sections)) {
    return snapshot.sections.map((sec: any, idx: number) => ({
      id: sec.id || `sec-${idx + 1}`,
      name: sec.name || sec.role || `Section ${idx + 1}`,
      role: sec.role || "content",
      raw: sec,
    }));
  }

  // 3. Pages with sections
  if (Array.isArray(snapshot.pages)) {
    const items: SourceSectionCandidate[] = [];
    for (const page of snapshot.pages) {
      if (Array.isArray(page.sections)) {
        for (const sec of page.sections) {
          if (sec && typeof sec === "object") {
            items.push({
              id: sec.id || `sec-${items.length + 1}`,
              name: sec.name || sec.role || `Section ${items.length + 1}`,
              role: sec.role || "content",
              raw: sec,
            });
          }
        }
      }
    }
    if (items.length > 0) return items;
  }

  return [];
}

/**
 * Run the Markdown-driven conversion pipeline for a stored source snapshot.
 *
 * Pipeline:
 *   1. Load the current Markdown rules (fresh at conversion time).
 *   2. Obtain the parsed source design from private storage.
 *   3. Ask the AI to produce the canonical DIR.
 *   4. Validate the DIR against the documented specification.
 *   5. Generate native Elementor output using ELEMENTOR_SKILL.md.
 *
 * Returns BLOCKED when any stage fails with diagnostics, or SUCCEEDED with the
 * validated canonical DIR and the actual generated Elementor output.
 */
export async function runConversionPipeline(
  source: ConversionSource,
  snapshotKey: string,
  context: ConversionContext,
): Promise<ConversionPipelineResult> {
  // Stage 1: load the current Markdown rules (fresh at conversion time).
  const rules: ConversionRules = loadConversionRules(source.sourceType);
  const ruleVersions = rules.versions.map((v) => ({ fileName: v.fileName, sha256: v.sha256 }));

  // Stage 2: obtain the parsed source design from private storage.
  const snapshotBytes = await storage.readFile(snapshotKey);
  let snapshot: unknown;
  try {
    snapshot = JSON.parse(snapshotBytes.toString("utf8"));
  } catch {
    throw new HttpError(422, "SOURCE_SNAPSHOT_UNPARSEABLE", "The stored source snapshot could not be parsed.");
  }

  // If this is a React/Next.js snapshot, project it deterministically to strip bloat
  // (diagnostics, raw package dependencies, unreferenced components) while preserving
  // all copy, section hierarchies, layout hints, design tokens, and buttons.
  const effectiveSnapshot =
    source.sourceType === "react-next-zip" &&
    typeof snapshot === "object" &&
    snapshot !== null &&
    (snapshot as any).source === "react-next-zip"
      ? projectReactSnapshotForAi(snapshot as any)
      : snapshot;

  const designPayload = JSON.stringify(effectiveSnapshot);

  // Stage 3: ask the AI to produce the canonical DIR using the source rules.
  // Bounded section-by-section generation vs bounded single-page generation
  const sourceSections = extractSourceSections(effectiveSnapshot);

  let dir: unknown;
  if (sourceSections.length > 1) {
    // Multi-section layout: execute bounded section-by-section generation with deterministic merging
    const mergedSections: Array<{ id: string; role: string; children: unknown[] }> = [];

    for (const [i, secItem] of sourceSections.entries()) {
      if (!secItem) continue;
      const sectionPayload = JSON.stringify({
        sectionIndex: i,
        totalSections: sourceSections.length,
        section: secItem.raw,
        styles: (effectiveSnapshot as any)?.styles,
        components: (effectiveSnapshot as any)?.components,
      });

      const estimatedTokens = estimateTokenCount(rules.systemInstructions + "\n" + sectionPayload);
      if (estimatedTokens > SECTION_MAX_PROMPT_TOKENS) {
        throw new HttpError(
          422,
          "AI_CONTEXT_TOO_LARGE",
          `Section "${secItem.name}" context (${estimatedTokens} estimated tokens) exceeds the bounded section limit (${SECTION_MAX_PROMPT_TOKENS} tokens).`,
        );
      }

      const sectionTask = [
        `Convert single design section ${i + 1} of ${sourceSections.length} ("${secItem.name}", role: "${secItem.role}") into a canonical DIR section object.`,
        "Output MUST be a single JSON object: { \"id\": string, \"role\": string, \"children\": [ ... ] }.",
        "Node kinds MUST be strictly one of: 'container', 'heading', 'text', 'button', 'image', 'iconBox', 'nav', 'form'.",
        "Never use kinds like 'footer', 'header', 'section' for child nodes; use 'container' instead.",
        "Containers must carry a 'children' array. Headings require 'text'. Text nodes require 'html'. Buttons require 'label'. Images require 'src'.",
        "Preserve all copy, headings, text, and buttons from this section.",
        "Return ONLY the single DIR section JSON object: no markdown fences, no comments, no explanation.",
      ].join(" ");

      const sectionCompletion = await requestCompletion({
        rules,
        designPayload: sectionPayload,
        task: sectionTask,
        maxOutputTokens: SECTION_MAX_OUTPUT_TOKENS,
      });

      const parsedSection = extractSectionDirJson(sectionCompletion.text, secItem.id, secItem.role);
      mergedSections.push(parsedSection);
    }

    dir = {
      version: "1.0",
      meta: {
        name: (effectiveSnapshot as any)?.packageName || "Converted Landing",
        source: source.sourceType,
      },
      breakpoints: {
        desktop: 1024,
        tablet: 768,
        mobile: 360,
      },
      globals: {
        colors: (effectiveSnapshot as any)?.styles?.colors ?? [],
        fonts: (effectiveSnapshot as any)?.styles?.fonts ?? [],
      },
      assets: (effectiveSnapshot as any)?.assets ?? [],
      pages: [
        {
          id: "page-main",
          title: (effectiveSnapshot as any)?.packageName || "Home",
          sections: mergedSections, // Deterministically merged in strict source order!
        },
      ],
    };
  } else {
    // Single-section or monolithic snapshot: bounded whole-page request
    const estimatedPromptTokens = estimateTokenCount(rules.systemInstructions + "\n" + designPayload);
    if (estimatedPromptTokens > MAX_PROMPT_ESTIMATED_TOKENS) {
      throw new HttpError(
        422,
        "AI_CONTEXT_TOO_LARGE",
        `The design source context (${estimatedPromptTokens} estimated tokens) exceeds the AI provider budget limit (${MAX_PROMPT_ESTIMATED_TOKENS} tokens).`,
      );
    }

    const dirCompletion = await requestCompletion({
      rules,
      designPayload,
      task: DIR_TASK,
      maxOutputTokens: DIR_MAX_OUTPUT_TOKENS,
    });

    dir = extractJson(dirCompletion.text);
  }
  const dirValidation = validateDir(dir);
  if (!dirValidation.valid) {
    return {
      status: "BLOCKED",
      stage: "source_ir_validation",
      ruleVersions,
      diagnostics: dirValidation.issues.slice(0, 10).map((issue) => ({
        code: issue.code,
        message: `${issue.path}: ${issue.message}`,
        stage: "source_ir_validation",
      })),
    };
  }

  // Stage 5: generate native Elementor output using the current ELEMENTOR_SKILL.md.
  const elementorContext: ConversionContext = {
    projectId: context.projectId,
    conversionId: context.conversionId,
    sourceType: source.sourceType,
  };
  const elementorResult = await generateElementorOutput(dir, elementorContext);

  return {
    status: "SUCCEEDED",
    dir,
    dirValidation,
    elementorOutput: elementorResult.output,
    ruleVersions: elementorResult.ruleVersions,
  };
}

/** Ask the AI provider for the requested completion using the loaded Markdown rules. */
async function requestCompletion(
  request: AiCompletionRequest,
): Promise<{ text: string; ruleVersions: Array<{ fileName: string; sha256: string }> }> {
  const completion = await requestConversionCompletion(request);
  return {
    text: completion.text,
    ruleVersions: completion.ruleVersions,
  };
}

export type ElementorArtifactResult = {
  storageKey: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
};

/**
 * Persist the validated native Elementor output to private local storage and
 * record the matching Artifact row. The write is atomic: the Artifact record is
 * only created after the bytes are durably stored, and both operations run
 * against the correct project/conversion. Failures throw so the caller can mark
 * the conversion FAILED — never a false success.
 */
export async function persistElementorArtifact(
  projectId: string,
  conversionId: string,
  elementorOutput: EmitterDocument,
): Promise<ElementorArtifactResult> {
  const fileName = "elementor.json";
  const contentType = "application/json";
  const storageKey = `conversions/${projectId}/${conversionId}/elementor.json`;
  const outputBytes = Buffer.from(JSON.stringify(elementorOutput), "utf8");
  const { sizeBytes, sha256 } = await storage.write(storageKey, Readable.from([outputBytes]), outputBytes.length);
  try {
    await prisma.artifact.create({
      data: {
        projectId,
        conversionId,
        storageKey,
        fileName,
        contentType,
        sizeBytes: BigInt(sizeBytes),
        sha256,
        status: "READY",
      },
    });
  } catch (error) {
    // Never leave a dangling artifact file when its DB record failed.
    await storage.delete(storageKey).catch(() => undefined);
    throw error;
  }
  return { storageKey, fileName, contentType, sizeBytes, sha256 };
}

/** Parse a native `.fig` upload into a document (used before pipeline runs). */
export function parseFigmaSourceDocument(bytes: Buffer, fileName: string): FigNativeDocument {
  return parseNativeFigFile(bytes, fileName).document;
}
