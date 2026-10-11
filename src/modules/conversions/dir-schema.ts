import { HttpError } from "../../middleware/errors.js";

// Validator for the project's canonical DIR JSON. The authoritative shape is
// documented in server/rules/FIGMA.md §2 and must not be replaced by a new
// envelope, schema, or node kinds. This module only enforces the documented
// structure so an AI-produced DIR cannot advance while malformed; it does not
// invent fields or perform design interpretation (that is the Markdown rules'
// job). Allowed node kinds and the top-level envelope mirror FIGMA.md exactly.

export const DIR_NODE_KINDS = [
  "container",
  "heading",
  "text",
  "button",
  "image",
  "iconBox",
  "nav",
  "form",
] as const;

export type DirNodeKind = (typeof DIR_NODE_KINDS)[number];

export type DirValidationIssue = { path: string; code: string; message: string };

export type DirValidationResult = {
  valid: boolean;
  issues: DirValidationIssue[];
  nodeCount: number;
  pageCount: number;
  sectionCount: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a candidate DIR document against the documented canonical shape.
 * Never throws for content issues — it returns them so callers surface actionable
 * diagnostics.
 */
export function validateDir(value: unknown): DirValidationResult {
  const issues: DirValidationIssue[] = [];
  let nodeCount = 0;
  let pageCount = 0;
  let sectionCount = 0;

  if (!isRecord(value)) {
    issues.push({ path: "$", code: "DIR_NOT_OBJECT", message: "DIR must be a single JSON object." });
    return { valid: false, issues, nodeCount, pageCount, sectionCount };
  }

  if (value.version === undefined) {
    issues.push({ path: "version", code: "DIR_VERSION_MISSING", message: "DIR is missing the top-level version." });
  }
  for (const key of ["meta", "breakpoints", "globals", "assets", "pages"]) {
    if (!(key in value)) {
      issues.push({ path: key, code: "DIR_FIELD_MISSING", message: `DIR is missing the required "${key}" field.` });
    }
  }
  if (!Array.isArray(value.pages)) {
    issues.push({ path: "pages", code: "DIR_PAGES_NOT_ARRAY", message: "DIR pages must be an array." });
    return { valid: issues.length === 0, issues, nodeCount, pageCount, sectionCount };
  }

  const validateNode = (node: unknown, path: string) => {
    if (!isRecord(node)) {
      issues.push({ path, code: "DIR_NODE_NOT_OBJECT", message: "Each node must be an object." });
      return;
    }
    nodeCount += 1;
    const kind = node.kind;
    if (typeof kind !== "string" || !(DIR_NODE_KINDS as readonly string[]).includes(kind)) {
      issues.push({
        path: `${path}.kind`,
        code: "DIR_UNKNOWN_KIND",
        message: `Unknown node kind "${String(kind)}". Allowed kinds: ${DIR_NODE_KINDS.join(", ")}.`,
      });
    }
    if (kind === "container") {
      if (node.children !== undefined && !Array.isArray(node.children)) {
        issues.push({ path: `${path}.children`, code: "DIR_CHILDREN_NOT_ARRAY", message: "container.children must be an array." });
      } else if (Array.isArray(node.children)) {
        node.children.forEach((child: unknown, i: number) => validateNode(child, `${path}.children[${i}]`));
      }
    }
    if (kind === "heading" && typeof node.text !== "string") {
      issues.push({ path: `${path}.text`, code: "DIR_HEADING_TEXT_MISSING", message: "heading nodes require a text field." });
    }
    if (kind === "text" && typeof node.html !== "string") {
      issues.push({ path: `${path}.html`, code: "DIR_TEXT_HTML_MISSING", message: "text nodes require an html field." });
    }
    if (kind === "image" && typeof node.src !== "string") {
      issues.push({ path: `${path}.src`, code: "DIR_IMAGE_SRC_MISSING", message: "image nodes require a src field." });
    }
    if (kind === "button" && typeof node.label !== "string") {
      issues.push({ path: `${path}.label`, code: "DIR_BUTTON_LABEL_MISSING", message: "button nodes require a label field." });
    }
  };

  value.pages.forEach((page: unknown, pIndex: number) => {
    pageCount += 1;
    const pagePath = `pages[${pIndex}]`;
    if (!isRecord(page)) {
      issues.push({ path: pagePath, code: "DIR_PAGE_NOT_OBJECT", message: "Each page must be an object." });
      return;
    }
    if (!Array.isArray(page.sections)) {
      issues.push({ path: `${pagePath}.sections`, code: "DIR_SECTIONS_NOT_ARRAY", message: "Each page requires a sections array." });
      return;
    }
    page.sections.forEach((section: unknown, sIndex: number) => {
      sectionCount += 1;
      const sectionPath = `${pagePath}.sections[${sIndex}]`;
      if (!isRecord(section)) {
        issues.push({ path: sectionPath, code: "DIR_SECTION_NOT_OBJECT", message: "Each section must be an object." });
        return;
      }
      if (typeof section.role !== "string" || !section.role.trim()) {
        issues.push({ path: `${sectionPath}.role`, code: "DIR_SECTION_ROLE_MISSING", message: "Each section requires a role." });
      }
      if (!Array.isArray(section.children)) {
        issues.push({ path: `${sectionPath}.children`, code: "DIR_SECTION_CHILDREN_NOT_ARRAY", message: "Each section requires a children array." });
        return;
      }
      section.children.forEach((child: unknown, cIndex: number) => validateNode(child, `${sectionPath}.children[${cIndex}]`));
    });
  });

  return { valid: issues.length === 0, issues, nodeCount, pageCount, sectionCount };
}

/** Throw an actionable HttpError when a DIR document fails validation. */
export function assertValidDir(value: unknown): DirValidationResult {
  const result = validateDir(value);
  if (!result.valid) {
    const summary = result.issues.slice(0, 5).map((i) => `${i.path}: ${i.message}`).join("; ");
    throw new HttpError(422, "DIR_INVALID", `The generated DIR did not match the approved specification. ${summary}`);
  }
  return result;
}
