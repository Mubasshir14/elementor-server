import { HttpError } from "../../middleware/errors.js";

// Output validator for native Elementor JSON. The authoritative shapes are:
// - Official Elementor developer docs (Data Structure / General Structure):
//   { title: string, type: string, version: "0.4", page_settings: [] | {}, content: [] }
// - server/rules/ELEMENTOR_SKILL.md §5 for node/widget mapping.
// This module enforces the documented envelope so an AI-produced document that
// is merely syntactically-valid JSON (e.g. `{ content: [...] }` with no
// template type) cannot advance as importable. It never invents mappings.

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

export type EmitterNode = {
  id: string;
  elType: string;
  isInner?: boolean;
  widgetType?: string;
  settings: Record<string, unknown>;
  elements: EmitterNode[];
};

export interface EmitterDocument {
  title: string;
  type: string;
  version: string;
  page_settings: Record<string, unknown> | never[];
  content: EmitterNode[];
}

export const ELEMENTOR_VERSION = "0.4";

// Valid document/template types per Elementor developer docs
// (General Structure: "header, footer, error-404, popup, page, post, etc.").
// This allowlist covers the documented values plus long-standing template-library
// types. Unknown types are rejected rather than guessed.
export const VALID_ELEMENTOR_TEMPLATE_TYPES = [
  "page",
  "post",
  "header",
  "footer",
  "popup",
  "error-404",
  "section",
  "single",
  "single-post",
  "single-page",
  "archive",
  "search",
  "product",
  "landing-page",
] as const;

export const VALID_ELEMENTOR_EL_TYPES = ["container", "section", "column", "widget"] as const;

// Core Elementor widgets the pipeline is allowed to emit. Anything outside this
// list is rejected so the model cannot invent controls. Kept intentionally to
// the widgets referenced by ELEMENTOR_SKILL.md plus ubiquitous core widgets.
export const SUPPORTED_ELEMENTOR_WIDGET_TYPES = [
  "heading",
  "text-editor",
  "image",
  "button",
  "icon-box",
  "image-box",
  "icon",
  "nav-menu",
  "menu-anchor",
  "form",
  "divider",
  "spacer",
  "video",
  "google_maps",
  "tabs",
  "accordion",
  "image-carousel",
  "counter",
  "testimonial",
  "call-to-action",
] as const;

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
 *
 * A document that is merely JSON-parseable is NOT sufficient: the Elementor
 * Template Library requires the top-level envelope
 * { title, type, version, page_settings, content } and rejects anything else
 * with "Invalid template type".
 */
export function validateElementorOutput(value: unknown): ElementorValidationResult {
  const issues: ElementorDiagnostics[] = [];

  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ path: "$", code: "ELEMENTOR_NOT_OBJECT", message: "The generated native Elementor output must be a JSON object." }],
      output: null,
    };
  }

  const root = value as Record<string, unknown>;

  // --- Envelope: title ---
  let title = "";
  if (!isString(root.title) || root.title.length === 0) {
    issues.push({
      path: "title",
      code: "ELEMENTOR_TITLE_MISSING",
      message: "The root object must contain a non-empty string `title`.",
    });
  } else {
    title = root.title;
  }

  // --- Envelope: type (the field Elementor checks on import) ---
  let type = "";
  if (!isString(root.type) || root.type.length === 0) {
    issues.push({
      path: "type",
      code: "ELEMENTOR_TYPE_MISSING",
      message:
        "The root object must contain a valid template `type` (e.g. 'page'). " +
        "Elementor rejects imports without it as 'Invalid template type'.",
    });
  } else if (!(VALID_ELEMENTOR_TEMPLATE_TYPES as readonly string[]).includes(root.type)) {
    issues.push({
      path: "type",
      code: "ELEMENTOR_TYPE_INVALID",
      message: `Unknown template type "${root.type}". Valid types: ${VALID_ELEMENTOR_TEMPLATE_TYPES.join(", ")}.`,
    });
  } else {
    type = root.type;
  }

  // --- Envelope: version ---
  let version = ELEMENTOR_VERSION;
  if (root.version === undefined) {
    issues.push({
      path: "version",
      code: "ELEMENTOR_VERSION_MISSING",
      message: `The root object must contain a \`version\` string (expected "${ELEMENTOR_VERSION}").`,
    });
  } else if (!isString(root.version) || root.version.length === 0) {
    issues.push({
      path: "version",
      code: "ELEMENTOR_VERSION_INVALID",
      message: `The root \`version\` must be a non-empty string (expected "${ELEMENTOR_VERSION}").`,
    });
  } else if (root.version !== ELEMENTOR_VERSION) {
    issues.push({
      path: "version",
      code: "ELEMENTOR_VERSION_UNSUPPORTED",
      message: `Unsupported Elementor data-structure version "${root.version}". Expected "${ELEMENTOR_VERSION}".`,
    });
    version = root.version;
  }

  // --- Envelope: page_settings ([] when empty, object when configured) ---
  let pageSettings: Record<string, unknown> | never[] = [];
  if (root.page_settings === undefined) {
    issues.push({
      path: "page_settings",
      code: "ELEMENTOR_PAGE_SETTINGS_MISSING",
      message: "The root object must contain `page_settings` (use [] when no page settings are defined).",
    });
  } else if (Array.isArray(root.page_settings)) {
    if (root.page_settings.length !== 0) {
      issues.push({
        path: "page_settings",
        code: "ELEMENTOR_PAGE_SETTINGS_INVALID",
        message: "`page_settings` must be an empty array or an object of key/value settings.",
      });
    } else {
      pageSettings = [];
    }
  } else if (isRecord(root.page_settings)) {
    pageSettings = root.page_settings;
  } else {
    issues.push({
      path: "page_settings",
      code: "ELEMENTOR_PAGE_SETTINGS_INVALID",
      message: "`page_settings` must be an empty array or an object of key/value settings.",
    });
  }

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

  // Section-order stability: duplicate section ids at the top level indicate a
  // merge/reorder defect upstream; already reported as ELEMENTOR_ID_DUPLICATE.
  const output: EmitterDocument | null =
    issues.length === 0 ? { title, type, version, page_settings: pageSettings, content: nodes } : null;
  if (output === null) {
    return { valid: false, issues, output: null };
  }
  return { valid: true, issues, output };
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

  const node: EmitterNode = {
    id: "",
    elType: "",
    settings: {},
    elements: [],
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

  // elType: required, must be a known Elementor element kind.
  if (!isString(value.elType) || value.elType.length === 0) {
    issues.push({ path: `${path}.elType`, code: "ELEMENTOR_EL_TYPE_MISSING", message: "Each element must define a non-empty string `elType`." });
  } else if (!(VALID_ELEMENTOR_EL_TYPES as readonly string[]).includes(value.elType)) {
    issues.push({
      path: `${path}.elType`,
      code: "ELEMENTOR_EL_TYPE_INVALID",
      message: `Unknown elType "${value.elType}". Valid values: ${VALID_ELEMENTOR_EL_TYPES.join(", ")}.`,
    });
  } else {
    node.elType = value.elType;
  }

  // isInner: optional boolean (Elementor emits it on every element).
  if (typeof value.isInner !== "undefined") {
    if (typeof value.isInner !== "boolean") {
      issues.push({ path: `${path}.isInner`, code: "ELEMENTOR_IS_INNER_INVALID", message: "`isInner` must be a boolean when present." });
    } else {
      node.isInner = value.isInner;
    }
  }

  const isWidget = node.elType === "widget" || typeof value.widgetType !== "undefined";

  // widgetType: required for widgets, forbidden on containers/sections/columns.
  if (isWidget) {
    if (!isString(value.widgetType) || value.widgetType.length === 0) {
      issues.push({
        path: `${path}.widgetType`,
        code: "ELEMENTOR_WIDGET_TYPE_MISSING",
        message: "Widget elements must define a non-empty string `widgetType`.",
      });
    } else if (!(SUPPORTED_ELEMENTOR_WIDGET_TYPES as readonly string[]).includes(value.widgetType)) {
      issues.push({
        path: `${path}.widgetType`,
        code: "ELEMENTOR_WIDGET_TYPE_UNSUPPORTED",
        message: `Unsupported widgetType "${value.widgetType}". Supported: ${SUPPORTED_ELEMENTOR_WIDGET_TYPES.join(", ")}.`,
      });
      node.widgetType = value.widgetType;
    } else {
      node.widgetType = value.widgetType;
      validateWidgetSettings(value.widgetType, value.settings, `${path}.settings`, issues);
    }
  } else if (typeof value.widgetType !== "undefined") {
    issues.push({
      path: `${path}.widgetType`,
      code: "ELEMENTOR_WIDGET_TYPE_UNEXPECTED",
      message: "Only widget elements may carry `widgetType`; containers/sections/columns must omit it.",
    });
  }

  // settings: required; Elementor exports [] when an element has no settings,
  // otherwise an object of real controls. Accept both, normalize to {}.
  if (Array.isArray(value.settings)) {
    if (value.settings.length !== 0) {
      issues.push({
        path: `${path}.settings`,
        code: "ELEMENTOR_SETTINGS_INVALID",
        message: "Each element must define a `settings` object (or [] when empty, per Elementor exports).",
      });
    } else {
      node.settings = {};
    }
  } else if (!isRecord(value.settings)) {
    issues.push({ path: `${path}.settings`, code: "ELEMENTOR_SETTINGS_NOT_OBJECT", message: "Each element must define a `settings` object." });
  } else {
    node.settings = value.settings as Record<string, unknown>;
  }

  // elements: required array (may be empty) per Elementor exports.
  if (typeof value.elements === "undefined") {
    issues.push({
      path: `${path}.elements`,
      code: "ELEMENTOR_ELEMENTS_MISSING",
      message: "Each element must define an `elements` array (use [] for leaf widgets).",
    });
  } else if (!isArray(value.elements)) {
    issues.push({ path: `${path}.elements`, code: "ELEMENTOR_ELEMENTS_NOT_ARRAY", message: "Each `elements` must be an array." });
  } else {
    const children: EmitterNode[] = [];
    const childSeenIds = new Set<string>();
    for (let j = 0; j < value.elements.length; j++) {
      const child = validateEmitterNode(value.elements[j], `${path}.elements[${j}]`, issues, childSeenIds);
      if (child) children.push(child);
    }
    node.elements = children;
  }

  return node;
}

/**
 * Verify a widget's settings carry the required control for its type.
 * Only the documented minimal controls are enforced; the Markdown rules
 * remain authoritative for the full mapping.
 */
function validateWidgetSettings(
  widgetType: string,
  settings: unknown,
  path: string,
  issues: ElementorDiagnostics[],
): void {
  if (!isRecord(settings)) return; // structural issue already reported
  const required: Record<string, string[]> = {
    heading: ["title"],
    "text-editor": ["editor"],
    button: ["text"],
    image: ["image"],
    "icon-box": ["title_text"],
    form: ["form_fields"],
  };
  const keys = required[widgetType];
  if (!keys) return;
  for (const key of keys) {
    if (settings[key] === undefined) {
      issues.push({
        path: `${path}.${key}`,
        code: "ELEMENTOR_WIDGET_SETTING_MISSING",
        message: `Widget "${widgetType}" requires setting "${key}".`,
      });
    }
  }
}

/**
 * Verify every DIR section role is represented (in order) in the emitted
 * Elementor content. The role is preserved as a CSS id/class on the section
 * container by the generation rules; matching uses settings._css_id,
 * settings.css_classes, settings._section_role, or the container id.
 */
export function assertElementorCoversDirSections(
  output: EmitterDocument,
  dir: unknown,
): ElementorDiagnostics[] {
  const issues: ElementorDiagnostics[] = [];
  const pages = (dir as { pages?: Array<{ sections?: Array<{ role?: unknown }> }> })?.pages;
  if (!Array.isArray(pages)) return issues;
  const expectedRoles: string[] = [];
  for (const page of pages) {
    if (!page || !Array.isArray(page.sections)) continue;
    for (const section of page.sections) {
      if (section && typeof section.role === "string" && section.role.trim()) {
        expectedRoles.push(section.role.trim().toLowerCase());
      }
    }
  }
  if (expectedRoles.length === 0) return issues;

  const emittedMarkers: string[] = [];
  const collect = (nodes: EmitterNode[]) => {
    for (const node of nodes) {
      const s = node.settings as Record<string, unknown>;
      const candidates = [
        typeof s._section_role === "string" ? s._section_role : "",
        typeof s._css_id === "string" ? s._css_id : "",
        typeof s.css_classes === "string" ? s.css_classes : "",
        typeof node.id === "string" ? node.id : "",
      ]
        .join(" ")
        .toLowerCase();
      emittedMarkers.push(candidates);
      if (node.elements.length > 0) collect(node.elements);
    }
  };
  collect(output.content);

  const topLevelMarkers: string[] = output.content.map((node) => {
    const s = node.settings as Record<string, unknown>;
    return [
      typeof s._section_role === "string" ? s._section_role : "",
      typeof s._css_id === "string" ? s._css_id : "",
      typeof s.css_classes === "string" ? s.css_classes : "",
      typeof node.id === "string" ? node.id : "",
    ]
      .join(" ")
      .toLowerCase();
  });

  let cursor = 0;
  for (const role of expectedRoles) {
    let found = -1;
    for (let i = cursor; i < topLevelMarkers.length; i++) {
      if (topLevelMarkers[i]!.includes(role)) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      const deepFound = emittedMarkers.some((m) => m.includes(role));
      issues.push({
        path: `content[sections:${role}]`,
        code: deepFound ? "ELEMENTOR_SECTION_ORDER_UNCERTAIN" : "ELEMENTOR_SECTION_MISSING",
        message: deepFound
          ? `DIR section "${role}" is present but not as a top-level container in order; section ordering cannot be verified.`
          : `DIR section "${role}" has no corresponding top-level Elementor container; the page content is incomplete.`,
      });
    } else {
      cursor = found + 1;
    }
  }
  return issues;
}

/**
 * Round-trip check: the validated output must serialize to JSON losslessly.
 */
export function assertElementorJsonRoundTrip(output: EmitterDocument): ElementorDiagnostics[] {
  try {
    const serialized = JSON.stringify(output);
    const reparsed = JSON.parse(serialized) as EmitterDocument;
    if (!Array.isArray(reparsed.content) || reparsed.content.length !== output.content.length) {
      return [{ path: "$", code: "ELEMENTOR_JSON_ROUNDTRIP_MISMATCH", message: "JSON serialization round-trip changed the content array." }];
    }
    return [];
  } catch (error) {
    return [{ path: "$", code: "ELEMENTOR_JSON_UNSERIALIZABLE", message: `Output is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}` }];
  }
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
