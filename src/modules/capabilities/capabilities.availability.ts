import { env } from "../../config/env.js";
import { aiProviderEnabled } from "../../infrastructure/ai/provider.js";
import { getActiveStorageService } from "../storage/storage.service.js";
import { ConversionSourceType, loadConversionRules } from "../rules/rule-loader.js";

// Runtime conversion-availability evaluation. The capabilities endpoint must
// report actual runtime state — never hardcoded values — so the UI can tell the
// user exactly what is (un)available and why. Conversion is only advertised as
// available when every dependency is genuinely usable:
//
//   * the Markdown rule files for the source type and the Elementor target load,
//   * the AI provider is configured,
//   * the private storage provider resolves.
//
// Nothing here changes conversion behavior; it only reports readiness.

export interface ConversionAvailability {
  available: boolean;
  unavailableReason: string | null;
}

const AVAILABLE_REASON =
  "Native Elementor conversion is available: the canonical DIR schema, Markdown conversion rules, Elementor output validation, and the AI provider are all configured.";

function unavailable(reason: string): ConversionAvailability {
  return { available: false, unavailableReason: reason };
}

function evaluateAiProvider(): ConversionAvailability {
  const apiKey = process.env.AI_API_KEY || env.AI_API_KEY;
  const model = process.env.AI_MODEL || env.AI_MODEL;
  if (!aiProviderEnabled()) {
    return unavailable(
      "AI conversion is disabled. Set AI_PROVIDER, AI_API_KEY, and AI_MODEL on the API server to enable Figma, Framer, and React/Next.js conversion.",
    );
  }
  if (!apiKey || !model) {
    return unavailable(
      "AI conversion is not fully configured. AI_API_KEY and AI_MODEL are required on the API server before conversion can run.",
    );
  }
  return { available: true, unavailableReason: null };
}

function evaluateStorage(): ConversionAvailability {
  try {
    getActiveStorageService();
    return { available: true, unavailableReason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Storage provider could not be initialized";
    return unavailable(`Conversion artifact storage is not usable: ${message}`);
  }
}

function evaluateRules(sourceType: ConversionSourceType): ConversionAvailability {
  try {
    const rules = loadConversionRules(sourceType);
    if (!rules.targetRule.text.trim() || !rules.sourceRule.text.trim()) {
      return unavailable("A required conversion rule file is empty or unreadable.");
    }
    return { available: true, unavailableReason: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversion rules could not be loaded";
    return unavailable(message);
  }
}

/** Evaluate overall (target-side) conversion availability across all sources. */
export function evaluateTargetAvailability(): ConversionAvailability {
  const storage = evaluateStorage();
  if (!storage.available) return storage;
  const ai = evaluateAiProvider();
  if (!ai.available) return ai;
  const sources: ConversionSourceType[] = ["figma", "framer", "react-next-zip"];
  for (const sourceType of sources) {
    const rules = evaluateRules(sourceType);
    if (!rules.available) return rules;
  }
  return { available: true, unavailableReason: AVAILABLE_REASON };
}

/** Evaluate per-source conversion availability (rules for that source must load). */
export function evaluateSourceAvailability(sourceType: ConversionSourceType): ConversionAvailability {
  const storage = evaluateStorage();
  if (!storage.available) return storage;
  const ai = evaluateAiProvider();
  if (!ai.available) return ai;
  const rules = evaluateRules(sourceType);
  if (!rules.available) return rules;
  return { available: true, unavailableReason: AVAILABLE_REASON };
}
