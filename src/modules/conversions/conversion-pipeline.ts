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
import { EmitterDocument } from "./elementor-output-schema.js";

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
  "the target rules above. Return ONE DIR JSON object and nothing else: no",
  "markdown fences, no comments, no explanations.",
].join(" ");

const ELEMENTOR_TASK = [
  "You are converting a validated canonical DIR into native Elementor output.",
  "Using the Elementor output rules provided in the system instructions, produce",
  "a single native Elementor JSON document and return nothing else.",
  "Return ONLY the Elementor JSON object: no markdown fences, no comments, no",
  "explanation.",
].join(" ");

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? trimmed.slice(start, end + 1) : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    throw new HttpError(422, "DIR_UNPARSEABLE", "The AI response was not valid DIR JSON.");
  }
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
  const designPayload = JSON.stringify(snapshot);

  // Stage 3: ask the AI to produce the canonical DIR using the source rules.
  const dirCompletion = await requestCompletion({
    rules,
    designPayload,
    task: DIR_TASK,
  });

  // Stage 4: validate the generated DIR against the documented specification.
  const dir = extractJson(dirCompletion.text);
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
