import { HttpError } from "../../middleware/errors.js";
import { storage } from "../../infrastructure/storage/local.js";
import {
  ConversionRules,
  ConversionSourceType,
  loadConversionRules,
} from "../rules/rule-loader.js";
import { requestConversionCompletion } from "../../infrastructure/ai/provider.js";
import { validateDir, DirValidationResult } from "./dir-schema.js";
import { parseNativeFigFile, FigNativeDocument } from "../uploads/fig-native.js";

// Conversion pipeline. Each stage is separated and truthful:
//
//   1. load the current Markdown rules (runtime, invalidated on edit),
//   2. obtain the parsed source design,
//   3. ask the AI to produce the canonical DIR,
//   4. validate that DIR against the documented specification,
//   5. generate native Elementor output.
//
// Stage 5 is deliberately BLOCKED: this repository ships no Elementor generator,
// and inventing one (or emitting HTML/CSS that only looks like Elementor) would
// fabricate output. The pipeline returns a clear, actionable diagnostic instead.

export type ConversionSource = {
  sourceType: ConversionSourceType;
  snapshotKey: string;
};

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
      ruleVersions: Array<{ fileName: string; sha256: string }>;
    };

const DIR_TASK = [
  "Interpret the design in the UNTRUSTED-DESIGN block using the source analysis",
  "rules above, then output the canonical DIR JSON for the target described in",
  "the target rules above. Return ONE DIR JSON object and nothing else: no",
  "markdown fences, no comments, no explanations.",
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
 * Throws only for unexpected infrastructure errors; expected pipeline outcomes
 * (missing rules, disabled AI, invalid DIR, missing Elementor generator) are
 * returned as truthful BLOCKED results or actionable HttpErrors.
 */
export async function runConversionPipeline(
  source: ConversionSource,
  snapshotKey: string,
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

  // Stage 3: ask the AI to produce the DIR using the loaded rules.
  // requestConversionCompletion throws an actionable HttpError when AI is
  // disabled/unconfigured, so we never fabricate a DIR here.
  const completion = await requestConversionCompletion({
    rules,
    designPayload,
    task: DIR_TASK,
  });

  // Stage 4: validate the generated DIR against the documented specification.
  const dir = extractJson(completion.text);
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

  // Stage 5: native Elementor generation. No generator exists in this
  // repository, so report it as an explicit, actionable blocker rather than
  // emitting fabricated Elementor output. This is the honest terminal state.
  return {
    status: "BLOCKED",
    stage: "target_ir_generation",
    ruleVersions,
    diagnostics: [
      {
        code: "ELEMENTOR_GENERATOR_MISSING",
        stage: "target_ir_generation",
        message: [
          "The canonical DIR was produced and validated, but no native Elementor",
          "generator is implemented in this repository. The approved Elementor",
          "output generator must be supplied before a conversion can complete;",
          "HTML/CSS is not an acceptable substitute for native Elementor output.",
        ].join(" "),
      },
    ],
  };
}

/** Parse a native `.fig` upload into a document (used before pipeline runs). */
export function parseFigmaSourceDocument(bytes: Buffer, fileName: string): FigNativeDocument {
  return parseNativeFigFile(bytes, fileName).document;
}
