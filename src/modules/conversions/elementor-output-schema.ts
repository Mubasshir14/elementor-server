import { HttpError } from "../../middleware/errors.js";

// Output validator for native Elementor JSON. The authoritative shape is
// documented in server/rules/ELEMENTOR_SKILL.md. This module only enforces the
// documented structure so an AI-produced element cannot advance while malformed;
// it does not invent widget mappings or controls (that is the Markdown rules' job).

export type ElementorDiagnostics = {
  path: string;
  code: string;
  message: string;
};

export type ElementorValidationResult = {
  valid: boolean;
  issues: ElementorDiagnostics[];
  output: EmitterDocument | null;
};

export type EmitterNode =
  | {
      id: string;
      elType: string;
      settings: Record<string, unknown>;
      elements?: EmitterNode[];
    }
  | {
      id: string;
      elType: string;
      widgetType: string;
      settings: Record<string, unknown>;
      elements?: EmitterNode[];
    };

export interface EmitterDocument {
  content: EmitterNode[];
}

const ELEMENTOR_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Validate a generated native Elementor output against the documented schema.
 * Never throws for content issues — returns actionable diagnostics instead.
 */
export function validateElementorOutput(value: unknown): ElementorValidationResult {
  const issues: ElementorDiagnostics[] = [];
  let output: EmitterDocument | null = null;

  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ path: "$", code: "ELEMENTOR_NOT_OBJECT", message: "The generated native Elementor output must be a JSON object." }],
      output: null,
    };
  }

  const root = value as Record<string, unknown>;

  if (!isArray(root.content)) {
    issues.push({
      path: "content",
      code: "ELEMENTOR_CONTENT_NOT_ARRAY",
      message: "The root object must contain a `content` array.",
    });
    return { valid: false, issues, output: null };
  }

  const content = root.content as unknown[];
  const nodes: EmitterNode[] = [];
  const seenIds = new Set<string>();

  for (let i = 0; i < content.length; i++) {
    const node = validateEmitterNode(content[i], `content[${i}]`, issues, seenIds);
    if (node) nodes.push(node);
  }

  output = { content: nodes };
  return { valid: issues.length === 0, issues, output };
}

function validateEmitterNode(
  value: unknown,
  path: string,
  issues: ElementorDiagnostics[],
  seenIds: Set<string>,
): EmitterNode | null {
  if (!isRecord(value)) {
    issues.push({ path, code: "ELEMENTOR_NODE_NOT_OBJECT", message: "Each element must be a JSON object." });
    return null;
  }

  const node: { id: string; elType: string; settings: Record<string, unknown>; widgetType?: string; elements?: EmitterNode[] } = {
    id: "",
    elType: "",
    settings: {},
  };

  // id: required, non-empty, unique within parent
  if (!isString(value.id) || value.id.length === 0) {
    issues.push({ path: `${path}.id`, code: "ELEMENTOR_ID_MISSING", message: "Each element must define a non-empty string `id`." });
  } else if (!ELEMENTOR_ID_PATTERN.test(value.id)) {
    issues.push({ path: `${path}.id`, code: "ELEMENTOR_ID_INVALID", message: "Element `id` must contain only letters, digits, underscores, or hyphens." });
  } else if (seenIds.has(value.id)) {
    issues.push({ path: `${path}.id`, code: "ELEMENTOR_ID_DUPLICATE", message: "Element `id` values must be unique within the same parent." });
  } else {
    seenIds.add(value.id);
    node.id = value.id;
  }

  // elType: required, non-empty
  if (!isString(value.elType) || value.elType.length === 0) {
    issues.push({ path: `${path}.elType`, code: "ELEMENTOR_EL_TYPE_MISSING", message: "Each element must define a non-empty string `elType`." });
  } else {
    node.elType = value.elType;
  }

  // widgetType: required for widgets, absent for sections/containers
  if (typeof value.widgetType !== "undefined") {
    if (!isString(value.widgetType) || value.widgetType.length === 0) {
      issues.push({ path: `${path}.widgetType`, code: "ELEMENTOR_WIDGET_TYPE_INVALID", message: "A `widgetType` must be a non-empty string." });
    } else {
      node.widgetType = value.widgetType;
    }
  }

  // settings: required object
  if (typeof value.settings !== "object" || value.settings === null || Array.isArray(value.settings)) {
    issues.push({ path: `${path}.settings`, code: "ELEMENTOR_SETTINGS_NOT_OBJECT", message: "Each element must define a `settings` object." });
  } else {
    node.settings = value.settings as Record<string, unknown>;
  }

  // elements: optional array of nested elements
  if (typeof value.elements !== "undefined") {
    if (!isArray(value.elements)) {
      issues.push({ path: `${path}.elements`, code: "ELEMENTOR_ELEMENTS_NOT_ARRAY", message: "Each `elements` must be an array." });
    } else {
      const children: EmitterNode[] = [];
      for (let j = 0; j < value.elements.length; j++) {
        const child = validateEmitterNode(value.elements[j], `${path}.elements[${j}]`, issues, seenIds);
        if (child) children.push(child);
      }
      node.elements = children;
    }
  }

  return node;
}

/**
 * Throw an actionable HttpError when a generated Elementor output fails validation.
 */
export function assertValidElementorOutput(value: unknown): EmitterDocument {
  const result = validateElementorOutput(value);
  if (!result.valid || result.output === null) {
    const summary = result.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new HttpError(
      422,
      "ELEMENTOR_OUTPUT_INVALID",
      `The generated native Elementor output did not match the approved schema. ${summary}`,
    );
  }
  return result.output;
}
