import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import * as yauzl from "yauzl";
import { prisma } from "../../infrastructure/database/prisma.js";
import { HttpError } from "../../middleware/errors.js";
import { storage } from "../storage/storage.service.js";
import type {
  DetectedFramework,
  ReactNextAssetSummary,
  ReactNextComponentSummary,
  ReactNextDiagnostic,
  ReactNextExtractedButton,
  ReactNextExtractedForm,
  ReactNextExtractedFormField,
  ReactNextExtractedHeading,
  ReactNextExtractedImage,
  ReactNextExtractedNavItem,
  ReactNextExtractedSection,
  ReactNextProjectSnapshot,
  ReactNextRouteSummary,
  ReactNextStyleTokens,
  ReactProjectInspectionResult,
  RouterConvention,
} from "./react-nextjs.types.js";
import { inspectZip } from "./react-nextjs.validator.js";
import { isGeneratedArchivePath } from "./archive-entry-policy.js";
export { projectReactSnapshotForAi, type ProjectedReactSnapshot } from "./react-nextjs.projection.js";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 192 * 1024;
const MAX_INSPECTED_TEXT_FILES = 80;
const MAX_TOTAL_EXTRACTED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_JSON_BYTES = 2 * 1024 * 1024;

type PackageManifest = {
  name?: unknown;
  version?: unknown;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
};

const IGNORED_DIRECTORY_PATTERN =
  /(?:^|\/)(?:node_modules|\.next|dist|build|out|\.git|\.turbo|\.vercel|coverage|__tests__|cypress|playwright-report)\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasDependency(manifest: PackageManifest, name: string): boolean {
  return [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies].some(
    (dependencies) => isRecord(dependencies) && typeof dependencies[name] === "string",
  );
}

function listDependencyNames(record: Record<string, unknown> | undefined): string[] {
  if (!isRecord(record)) return [];
  return Object.entries(record)
    .filter(([, version]) => typeof version === "string")
    .map(([name]) => name)
    .slice(0, 120);
}

function isSourceFile(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?)$/i.test(path) && !IGNORED_DIRECTORY_PATTERN.test(path);
}

function isStyleOrConfigFile(path: string): boolean {
  return (
    !IGNORED_DIRECTORY_PATTERN.test(path) &&
    (/\.(?:css|scss|sass)$/i.test(path) ||
      /(?:^|\/)tailwind\.config\.(?:[cm]?[jt]s|json)$/i.test(path))
  );
}

function isStaticAssetFile(path: string): boolean {
  return (
    !IGNORED_DIRECTORY_PATTERN.test(path) &&
    /\.(?:png|jpe?g|webp|avif|gif|svg|ico|woff2?|ttf|otf)$/i.test(path)
  );
}

function classifyProject(
  manifestPath: string,
  manifest: PackageManifest,
  allPaths: string[],
): { detectedFramework: DetectedFramework; routerConvention: RouterConvention } {
  const projectRoot =
    manifestPath === "package.json" ? "" : manifestPath.slice(0, -"package.json".length);
  const projectPaths = allPaths
    .filter((path) => path.startsWith(projectRoot))
    .map((path) => path.slice(projectRoot.length));

  const hasAppRouter = projectPaths.some((path) =>
    /^(?:src\/)?app\/(?:.+\/)?(?:page|layout|route)\.(?:[cm]?[jt]sx?)$/i.test(path),
  );
  const hasPagesRouter = projectPaths.some((path) =>
    /^(?:src\/)?pages\/.+\.(?:[cm]?[jt]sx?)$/i.test(path),
  );
  const hasNextRouting =
    hasAppRouter ||
    hasPagesRouter ||
    projectPaths.some((path) => /^(?:src\/)?(?:app|pages)\/.+\.(?:[cm]?[jt]sx?)$/i.test(path));
  const hasReactSource = projectPaths.some(
    (path) =>
      /^(?:src\/)?(?:app|pages|components|routes|views|screens|features|sections)\/.+\.(?:[cm]?[jt]sx?)$/i.test(
        path,
      ) || /^(?:src\/)?(?:App|app|index|main)\.(?:[cm]?[jt]sx?)$/i.test(path),
  );

  if (hasDependency(manifest, "next") && hasNextRouting) {
    return {
      detectedFramework: "nextjs",
      routerConvention: hasAppRouter ? "nextjs-app-router" : "nextjs-pages-router",
    };
  }
  if (hasDependency(manifest, "react") && hasReactSource) {
    return {
      detectedFramework: "react",
      routerConvention: "react-spa",
    };
  }
  throw new HttpError(
    400,
    "UNRECOGNIZED_REACT_PROJECT",
    "The ZIP must contain a package.json with React or Next.js dependencies and matching application source files.",
  );
}

function cleanJsxText(raw: string): string {
  return raw
    .replace(/\{["'`]([^"'`]+)["'`]\}/g, "$1")
    .replace(/\{[^}]*\}/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttribute(attrs: string, attrName: string): string | undefined {
  const regex = new RegExp(
    `\\b${attrName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|\\{\\s*["'\`]([^"'\`]*)["'\`]\\s*\\})`,
    "i",
  );
  const match = attrs.match(regex);
  const value = match?.[1] ?? match?.[2] ?? match?.[3];
  return value ? value.trim() : undefined;
}

function inferRoleFromNameOrTag(
  name: string,
  tagName: string,
  headings: ReactNextExtractedHeading[],
): ReactNextExtractedSection["role"] {
  const lower = `${name} ${tagName}`.toLowerCase();
  if (lower.includes("header") || lower.includes("navbar") || lower.includes("topbar") || tagName === "header" || tagName === "nav") {
    return "header";
  }
  if (lower.includes("footer") || tagName === "footer") return "footer";
  if (lower.includes("hero") || lower.includes("banner") || headings.some((h) => h.level === 1)) {
    return "hero";
  }
  if (lower.includes("feature") || lower.includes("service") || lower.includes("benefit")) {
    return "features";
  }
  if (lower.includes("pricing") || lower.includes("plan")) return "pricing";
  if (lower.includes("testimonial") || lower.includes("review")) return "testimonials";
  if (lower.includes("faq") || lower.includes("question")) return "faq";
  if (lower.includes("cta") || lower.includes("contact") || lower.includes("newsletter")) {
    return "cta";
  }
  return "content";
}

function inferLayoutFromClassName(className: string | undefined): ReactNextExtractedSection["layoutHint"] {
  if (!className) return undefined;
  const tokens = className.split(/\s+/);
  const isGrid = tokens.some((t) => t === "grid" || t.startsWith("grid-cols-"));
  const isFlex = tokens.some((t) => t === "flex" || t === "inline-flex");
  let gapPx: number | undefined;
  const gapMatch = className.match(/\bgap-(\d+(?:\.\d+)?)\b/);
  if (gapMatch?.[1]) {
    gapPx = Math.round(Number(gapMatch[1]) * 4);
  }
  if (isGrid) {
    const colsMatch = className.match(/(?:lg:|md:)?grid-cols-(\d+)/);
    return {
      mode: "grid",
      columns: colsMatch?.[1] ? Number(colsMatch[1]) : undefined,
      gapPx,
    };
  }
  if (isFlex) {
    const isColumn = tokens.includes("flex-col");
    return {
      mode: "flex",
      direction: isColumn ? "column" : "row",
      gapPx,
    };
  }
  return undefined;
}

function extractElementsFromSource(sourceCode: string): {
  headings: ReactNextExtractedHeading[];
  paragraphs: string[];
  buttons: ReactNextExtractedButton[];
  navItems: ReactNextExtractedNavItem[];
  images: ReactNextExtractedImage[];
  forms: ReactNextExtractedForm[];
  className?: string | undefined;
} {
  const headings: ReactNextExtractedHeading[] = [];
  const paragraphs: string[] = [];
  const buttons: ReactNextExtractedButton[] = [];
  const navItems: ReactNextExtractedNavItem[] = [];
  const images: ReactNextExtractedImage[] = [];
  const forms: ReactNextExtractedForm[] = [];

  // Extract headings <h1>..<h6>
  const headingRegex = /<h([1-6])\b([^>]*)>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingRegex.exec(sourceCode)) !== null && headings.length < 25) {
    const level = Number(match[1]) as 1 | 2 | 3 | 4 | 5 | 6;
    const attrs = match[2] ?? "";
    const text = cleanJsxText((match[3] ?? "").replace(/<[^>]+>/g, " "));
    if (text) {
      headings.push({
        level,
        text: text.slice(0, 280),
        className: extractAttribute(attrs, "className"),
      });
    }
  }

  // Extract paragraphs <p>, <li>, <blockquote>
  const paragraphRegex = /<(?:p|blockquote|li)\b[^>]*>([\s\S]*?)<\/(?:p|blockquote|li)>/gi;
  while ((match = paragraphRegex.exec(sourceCode)) !== null && paragraphs.length < 30) {
    const text = cleanJsxText((match[1] ?? "").replace(/<[^>]+>/g, " "));
    if (text && text.length >= 2) {
      paragraphs.push(text.slice(0, 500));
    }
  }

  // Extract <nav> links
  const navBlockRegex = /<nav\b[^>]*>([\s\S]*?)<\/nav>/gi;
  while ((match = navBlockRegex.exec(sourceCode)) !== null) {
    const navBody = match[1] ?? "";
    const linkRegex = /<(?:a|Link|NavLink)\b([^>]*)>([\s\S]*?)<\/(?:a|Link|NavLink)>/gi;
    let linkMatch: RegExpExecArray | null;
    while ((linkMatch = linkRegex.exec(navBody)) !== null && navItems.length < 20) {
      const attrs = linkMatch[1] ?? "";
      const label = cleanJsxText((linkMatch[2] ?? "").replace(/<[^>]+>/g, " "));
      const href = extractAttribute(attrs, "href") ?? extractAttribute(attrs, "to") ?? "#";
      if (label) {
        navItems.push({ label: label.slice(0, 80), href: href.slice(0, 200) });
      }
    }
  }

  // Extract <button> and CTA <a>/<Link>
  const buttonRegex = /<button\b([^>]*)>([\s\S]*?)<\/button>/gi;
  while ((match = buttonRegex.exec(sourceCode)) !== null && buttons.length < 20) {
    const attrs = match[1] ?? "";
    const label = cleanJsxText((match[2] ?? "").replace(/<[^>]+>/g, " "));
    if (label) {
      const className = extractAttribute(attrs, "className");
      buttons.push({
        label: label.slice(0, 100),
        variant: className?.includes("outline") || className?.includes("border") ? "outline" : "primary",
        className,
      });
    }
  }

  const ctaLinkRegex = /<(?:a|Link)\b([^>]*)>([\s\S]*?)<\/(?:a|Link)>/gi;
  while ((match = ctaLinkRegex.exec(sourceCode)) !== null && buttons.length < 25) {
    const attrs = match[1] ?? "";
    const className = extractAttribute(attrs, "className");
    const label = cleanJsxText((match[2] ?? "").replace(/<[^>]+>/g, " "));
    const href = extractAttribute(attrs, "href") ?? extractAttribute(attrs, "to");
    const isNavDuplicate = navItems.some((item) => item.label === label && item.href === href);
    if (
      label &&
      !isNavDuplicate &&
      (className?.match(/\b(?:btn|button|bg-|px-|py-|rounded)/i) || buttons.length === 0)
    ) {
      buttons.push({
        label: label.slice(0, 100),
        href: href?.slice(0, 200),
        variant: className?.includes("outline") ? "outline" : "primary",
        className,
      });
    }
  }

  // Extract <img> and <Image>
  const imgRegex = /<(?:img|Image)\b([^>]*)\/?>/gi;
  while ((match = imgRegex.exec(sourceCode)) !== null && images.length < 25) {
    const attrs = match[1] ?? "";
    const src = extractAttribute(attrs, "src");
    const alt = extractAttribute(attrs, "alt");
    if (src) {
      images.push({
        src: src.slice(0, 260),
        alt: alt?.slice(0, 180),
        className: extractAttribute(attrs, "className"),
      });
    }
  }

  // Extract <form> blocks
  const formRegex = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  while ((match = formRegex.exec(sourceCode)) !== null && forms.length < 10) {
    const formAttrs = match[1] ?? "";
    const formBody = match[2] ?? "";
    const fields: ReactNextExtractedFormField[] = [];
    const inputRegex = /<(input|textarea|select)\b([^>]*)\/?>/gi;
    let inputMatch: RegExpExecArray | null;
    while ((inputMatch = inputRegex.exec(formBody)) !== null && fields.length < 15) {
      const tag = (inputMatch[1] ?? "input").toLowerCase();
      const iAttrs = inputMatch[2] ?? "";
      const rawType = (extractAttribute(iAttrs, "type") ?? (tag === "textarea" ? "textarea" : tag === "select" ? "select" : "text")).toLowerCase();
      if (rawType === "submit" || rawType === "hidden") continue;
      const allowedTypes: ReactNextExtractedFormField["type"][] = [
        "text",
        "email",
        "tel",
        "textarea",
        "select",
        "checkbox",
        "password",
      ];
      const normalizedType = allowedTypes.includes(rawType as ReactNextExtractedFormField["type"])
        ? (rawType as ReactNextExtractedFormField["type"])
        : "text";
      const name =
        extractAttribute(iAttrs, "name") ??
        extractAttribute(iAttrs, "id") ??
        `field_${fields.length + 1}`;
      fields.push({
        name: name.slice(0, 80),
        type: normalizedType,
        label: extractAttribute(iAttrs, "aria-label") ?? extractAttribute(iAttrs, "placeholder"),
        placeholder: extractAttribute(iAttrs, "placeholder"),
        required: /\brequired\b/i.test(iAttrs),
      });
    }
    const submitMatch = formBody.match(/<button\b[^>]*>([\s\S]*?)<\/button>/i);
    const submitLabel = submitMatch?.[1] ? cleanJsxText(submitMatch[1].replace(/<[^>]+>/g, " ")) : undefined;
    if (fields.length > 0) {
      forms.push({
        action: extractAttribute(formAttrs, "action"),
        submitLabel: submitLabel || "Submit",
        fields,
      });
    }
  }

  const rootClassMatch = sourceCode.match(/className\s*=\s*["']([^"']+)["']/);
  return {
    headings,
    paragraphs,
    buttons,
    navItems,
    images,
    forms,
    className: rootClassMatch?.[1],
  };
}

function extractChildComponentReferences(sourceCode: string): string[] {
  const found = new Set<string>();
  const jsxTagRegex = /<([A-Z][A-Za-z0-9_]*)\b/g;
  const builtinTags = new Set([
    "Fragment",
    "Suspense",
    "StrictMode",
    "Link",
    "NavLink",
    "Image",
    "Head",
    "Script",
    "Provider",
  ]);
  let match: RegExpExecArray | null;
  while ((match = jsxTagRegex.exec(sourceCode)) !== null && found.size < 30) {
    const tag = match[1];
    if (tag && !builtinTags.has(tag)) {
      found.add(tag);
    }
  }
  return Array.from(found);
}

function extractSectionsFromPageSource(
  routeId: string,
  routeName: string,
  sourceCode: string,
  componentsByName: Map<string, ReactNextComponentSummary>,
): ReactNextExtractedSection[] {
  const sections: ReactNextExtractedSection[] = [];
  const landmarkRegex = /<(header|nav|section|main|footer|article)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = landmarkRegex.exec(sourceCode)) !== null && sections.length < 16) {
    const tagName = (match[1] ?? "section").toLowerCase();
    const attrs = match[2] ?? "";
    const inner = match[3] ?? "";
    // FIX (elementor14 header/footer-only artifact): a `<main>` wrapper whose
    // inner content is composed of component references (e.g. `<Hero />`,
    // `<Features />`) previously hit `continue` here, discarding ALL nested
    // page sections while header/footer from layout.tsx survived. Instead,
    // treat the wrapper as a container: inline each referenced component's
    // analyzed structure as its own section at this position.
    if (tagName === "main" && /<section\b/i.test(inner)) {
      const childComponents = extractChildComponentReferences(inner);
      let inlined = false;
      for (const compName of childComponents) {
        const comp = componentsByName.get(compName);
        if (!comp) continue;
        if (
          comp.headings.length === 0 &&
          comp.paragraphs.length === 0 &&
          comp.buttons.length === 0 &&
          comp.navItems.length === 0 &&
          comp.images.length === 0 &&
          comp.forms.length === 0
        ) {
          continue;
        }
        index += 1;
        sections.push({
          id: `${routeId}-sec-${index}`,
          name: comp.name,
          role: comp.roleHint ?? inferRoleFromNameOrTag(comp.name, "section", comp.headings),
          tagName: "section",
          className: comp.className,
          layoutHint: inferLayoutFromClassName(comp.className),
          headings: comp.headings,
          paragraphs: comp.paragraphs,
          buttons: comp.buttons,
          navItems: comp.navItems,
          images: comp.images,
          forms: comp.forms,
          childComponents: [comp.name],
        });
        inlined = true;
        if (sections.length >= 16) break;
      }
      if (inlined) continue;
      // No analyzable child components: fall through and parse inner landmarks
      // individually instead of swallowing them inside one wrapper section.
      const innerSections = extractSectionsFromPageSource(routeId, routeName, inner, componentsByName);
      for (const s of innerSections) {
        if (sections.length >= 16) break;
        index += 1;
        sections.push({ ...s, id: `${routeId}-sec-${index}` });
      }
      if (innerSections.length > 0) continue;
    }
    const extracted = extractElementsFromSource(inner);
    const childComponents = extractChildComponentReferences(inner);

    // Inline elements from referenced child components if present in project
    for (const compName of childComponents) {
      const comp = componentsByName.get(compName);
      if (!comp) continue;
      extracted.headings.push(...comp.headings);
      extracted.paragraphs.push(...comp.paragraphs);
      extracted.buttons.push(...comp.buttons);
      extracted.navItems.push(...comp.navItems);
      extracted.images.push(...comp.images);
      extracted.forms.push(...comp.forms);
    }

    if (
      extracted.headings.length === 0 &&
      extracted.paragraphs.length === 0 &&
      extracted.buttons.length === 0 &&
      extracted.navItems.length === 0 &&
      extracted.images.length === 0 &&
      extracted.forms.length === 0 &&
      childComponents.length === 0
    ) {
      // A landmark with no direct copy may still wrap nested sections (e.g. a
      // `<div className="page">` around component calls). Recurse so nested
      // landmarks are not silently dropped.
      if (tagName === "main" || tagName === "article") {
        const innerSections = extractSectionsFromPageSource(routeId, routeName, inner, componentsByName);
        for (const s of innerSections) {
          if (sections.length >= 16) break;
          index += 1;
          sections.push({ ...s, id: `${routeId}-sec-${index}` });
        }
        if (innerSections.length > 0) continue;
      }
      continue;
    }

    index += 1;
    const sectionIdAttr = extractAttribute(attrs, "id");
    const className = extractAttribute(attrs, "className") ?? extracted.className;
    const sectionName =
      sectionIdAttr ??
      extracted.headings[0]?.text.slice(0, 48) ??
      `${routeName} ${tagName} ${index}`;
    const role = inferRoleFromNameOrTag(sectionName, tagName, extracted.headings);

    sections.push({
      id: `${routeId}-sec-${index}`,
      name: sectionName,
      role,
      tagName,
      className,
      layoutHint: inferLayoutFromClassName(className),
      headings: extracted.headings.slice(0, 12),
      paragraphs: extracted.paragraphs.slice(0, 16),
      buttons: extracted.buttons.slice(0, 10),
      navItems: extracted.navItems.slice(0, 12),
      images: extracted.images.slice(0, 12),
      forms: extracted.forms.slice(0, 4),
      childComponents,
    });
  }

  if (sections.length === 0) {
    const extracted = extractElementsFromSource(sourceCode);
    const childComponents = extractChildComponentReferences(sourceCode);
    for (const compName of childComponents) {
      const comp = componentsByName.get(compName);
      if (!comp) continue;
      if (comp.headings.length > 0 || comp.paragraphs.length > 0 || comp.buttons.length > 0 || comp.navItems.length > 0) {
        index += 1;
        sections.push({
          id: `${routeId}-sec-${index}`,
          name: comp.name,
          role: comp.roleHint ?? inferRoleFromNameOrTag(comp.name, "section", comp.headings),
          tagName: "section",
          className: comp.className,
          layoutHint: inferLayoutFromClassName(comp.className),
          headings: comp.headings,
          paragraphs: comp.paragraphs,
          buttons: comp.buttons,
          navItems: comp.navItems,
          images: comp.images,
          forms: comp.forms,
          childComponents: [comp.name],
        });
      }
    }

    if (
      sections.length === 0 &&
      (extracted.headings.length > 0 ||
        extracted.paragraphs.length > 0 ||
        extracted.buttons.length > 0 ||
        extracted.navItems.length > 0 ||
        extracted.images.length > 0 ||
        extracted.forms.length > 0)
    ) {
      sections.push({
        id: `${routeId}-sec-1`,
        name: extracted.headings[0]?.text.slice(0, 48) ?? routeName,
        role: inferRoleFromNameOrTag(routeName, "section", extracted.headings),
        tagName: "section",
        className: extracted.className,
        layoutHint: inferLayoutFromClassName(extracted.className),
        headings: extracted.headings,
        paragraphs: extracted.paragraphs,
        buttons: extracted.buttons,
        navItems: extracted.navItems,
        images: extracted.images,
        forms: extracted.forms,
        childComponents,
      });
    }
  }

  return sections;
}

function deriveRouteFromPath(relativePath: string, routerConvention: RouterConvention): {
  isRoute: boolean;
  isLayout: boolean;
  routePath: string;
  routeName: string;
} {
  const normalized = relativePath.replace(/^src\//, "");

  if (routerConvention === "nextjs-app-router") {
    const layoutMatch = normalized.match(/^app\/(?:(.+)\/)?layout\.(?:[cm]?[jt]sx?)$/i);
    if (layoutMatch) {
      return {
        isRoute: false,
        isLayout: true,
        routePath: "/",
        routeName: "Root Layout",
      };
    }
    const pageMatch = normalized.match(/^app\/(?:(.+)\/)?page\.(?:[cm]?[jt]sx?)$/i);
    if (pageMatch) {
      const rawSegments = (pageMatch[1] ?? "")
        .split("/")
        .filter((seg) => seg && !seg.startsWith("(") && !seg.startsWith("@"));
      const routePath = rawSegments.length === 0 ? "/" : `/${rawSegments.join("/")}`;
      const routeName =
        rawSegments.length === 0
          ? "Home"
          : rawSegments[rawSegments.length - 1]!
              .replace(/[-_]/g, " ")
              .replace(/\b\w/g, (ch) => ch.toUpperCase());
      return { isRoute: true, isLayout: false, routePath, routePathName: routeName, routeName } as {
        isRoute: boolean;
        isLayout: boolean;
        routePath: string;
        routeName: string;
      };
    }
  }

  if (routerConvention === "nextjs-pages-router") {
    const pagesMatch = normalized.match(/^pages\/(.+)\.(?:[cm]?[jt]sx?)$/i);
    if (pagesMatch?.[1]) {
      const sub = pagesMatch[1];
      if (sub.startsWith("api/") || sub === "_document" || sub === "_error") {
        return { isRoute: false, isLayout: false, routePath: "", routeName: "" };
      }
      if (sub === "_app") {
        return { isRoute: false, isLayout: true, routePath: "/", routeName: "App Layout" };
      }
      const routePath =
        sub === "index"
          ? "/"
          : `/${sub.replace(/\/index$/i, "")}`;
      const lastSeg = routePath === "/" ? "Home" : routePath.split("/").filter(Boolean).pop() ?? "Page";
      return {
        isRoute: true,
        isLayout: false,
        routePath,
        routeName: lastSeg.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
      };
    }
  }

  // React SPA conventions
  if (/^(?:App|app)\.(?:[cm]?[jt]sx?)$/i.test(normalized)) {
    return { isRoute: true, isLayout: false, routePath: "/", routeName: "Home" };
  }
  const spaPageMatch = normalized.match(/^(?:pages|views|routes|screens)\/([^/]+)\.(?:[cm]?[jt]sx?)$/i);
  if (spaPageMatch?.[1]) {
    const name = spaPageMatch[1];
    const isHome = /^(?:home|index|landing|main)$/i.test(name);
    return {
      isRoute: true,
      isLayout: false,
      routePath: isHome ? "/" : `/${name.toLowerCase()}`,
      routeName: isHome ? "Home" : name.replace(/[-_]/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
    };
  }

  return { isRoute: false, isLayout: false, routePath: "", routeName: "" };
}

function extractStylesFromFiles(
  styleFiles: Array<{ path: string; content: string }>,
  hasTailwindDep: boolean,
): ReactNextStyleTokens {
  const customProperties: Record<string, string> = {};
  const colors: Array<{ name: string; value: string; source: string }> = [];
  const fonts: Array<{ name: string; family: string; source: string }> = [];
  const seenColors = new Set<string>();
  const seenFonts = new Set<string>();
  let tailwindConfigured = hasTailwindDep;

  for (const file of styleFiles) {
    if (file.path.includes("tailwind.config")) {
      tailwindConfigured = true;
    }

    // CSS custom properties --var-name: value;
    const varRegex = /(--[A-Za-z0-9_-]+)\s*:\s*([^;}\r\n]+);/g;
    let match: RegExpExecArray | null;
    while ((match = varRegex.exec(file.content)) !== null && Object.keys(customProperties).length < 60) {
      const name = match[1]?.trim();
      const value = match[2]?.trim();
      if (name && value) {
        customProperties[name] = value;
        if (/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(value) && !seenColors.has(value.toLowerCase())) {
          seenColors.add(value.toLowerCase());
          colors.push({
            name: name.replace(/^--/, ""),
            value,
            source: file.path,
          });
        }
      }
    }

    // Hex colors in CSS or tailwind.config
    const hexRegex = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
    while ((match = hexRegex.exec(file.content)) !== null && colors.length < 30) {
      const hex = match[0];
      if (hex && !seenColors.has(hex.toLowerCase())) {
        seenColors.add(hex.toLowerCase());
        colors.push({
          name: `color-${colors.length + 1}`,
          value: hex,
          source: file.path,
        });
      }
    }

    // font-family declarations
    const fontRegex = /font-family\s*:\s*([^;}\r\n]+);/gi;
    while ((match = fontRegex.exec(file.content)) !== null && fonts.length < 12) {
      const rawFamily = match[1]?.split(",")[0]?.replace(/["']/g, "").trim();
      if (rawFamily && !rawFamily.startsWith("var(") && !seenFonts.has(rawFamily.toLowerCase())) {
        seenFonts.add(rawFamily.toLowerCase());
        fonts.push({
          name: fonts.length === 0 ? "primary" : `font-${fonts.length + 1}`,
          family: rawFamily,
          source: file.path,
        });
      }
    }
  }

  return {
    colors,
    fonts,
    customProperties,
    tailwindConfigured,
    styleFiles: styleFiles.map((f) => f.path),
  };
}

export async function inspectReactProjectZip(buffer: Buffer): Promise<{
  detectedFramework: DetectedFramework;
  packageRoot: string;
  sourceFileCount: number;
}> {
  const { inspection } = await analyzeReactNextProjectZip(buffer, { metadataOnly: true });
  return {
    detectedFramework: inspection.detectedFramework,
    packageRoot: inspection.packageRoot,
    sourceFileCount: inspection.sourceFileCount,
  };
}

export async function analyzeReactNextProjectZip(
  buffer: Buffer,
  options: { metadataOnly?: boolean } = {},
): Promise<{
  inspection: ReactProjectInspectionResult;
  snapshot: ReactNextProjectSnapshot;
}> {
  await inspectZip(buffer);

  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (openError, archive) => {
      if (openError || !archive) {
        reject(new HttpError(400, "INVALID_PROJECT_ARCHIVE", "The project ZIP could not be opened."));
        return;
      }

      const paths: string[] = [];
      let manifestPath: string | undefined;
      let manifest: PackageManifest | undefined;
      const textFileBuffers = new Map<string, string>();
      let extractedTextBytes = 0;
      let omittedFileCount = 0;
      let generatedExcludedCount = 0;
      let settled = false;

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(error);
      };

      archive.on("error", () =>
        fail(
          new HttpError(400, "INVALID_PROJECT_ARCHIVE", "The project ZIP could not be read safely."),
        ),
      );

      archive.on("end", () => {
        if (settled) return;
        settled = true;

        const manifestCandidates = paths.filter(
          (path) => path === "package.json" || /^[^/]+\/package\.json$/i.test(path),
        );
        if (manifestCandidates.length !== 1 || !manifestPath || !manifest) {
          reject(
            new HttpError(
              400,
              "UNRECOGNIZED_REACT_PROJECT",
              "The ZIP must contain one root package.json, optionally inside one project folder.",
            ),
          );
          return;
        }

        try {
          const { detectedFramework, routerConvention } = classifyProject(
            manifestPath,
            manifest,
            paths,
          );
          const packageRoot =
            manifestPath === "package.json" ? "" : manifestPath.slice(0, -"package.json".length);

          const relativePaths = paths
            .filter((p) => p.startsWith(packageRoot))
            .map((p) => p.slice(packageRoot.length))
            .filter(Boolean);

          const sourceFiles = relativePaths.filter(isSourceFile);
          const styleFilePaths = relativePaths.filter(isStyleOrConfigFile);
          const assetFilePaths = relativePaths.filter(isStaticAssetFile);

          const dependencies = listDependencyNames(manifest.dependencies);
          const devDependencies = listDependencyNames(manifest.devDependencies);
          const allDeps = new Set([...dependencies, ...devDependencies]);
          const stylingSolutions: string[] = [];
          if (allDeps.has("tailwindcss") || styleFilePaths.some((p) => p.includes("tailwind.config"))) {
            stylingSolutions.push("tailwindcss");
          }
          if (allDeps.has("styled-components")) stylingSolutions.push("styled-components");
          if (allDeps.has("@emotion/react") || allDeps.has("@emotion/styled")) {
            stylingSolutions.push("emotion");
          }
          if (allDeps.has("sass")) stylingSolutions.push("sass");
          if (styleFilePaths.some((p) => /\.module\.(?:css|scss)$/i.test(p))) {
            stylingSolutions.push("css-modules");
          }
          if (styleFilePaths.some((p) => /\.(?:css|scss)$/i.test(p))) {
            stylingSolutions.push("css");
          }

          const packageName =
            typeof manifest.name === "string" && manifest.name.trim()
              ? manifest.name.trim()
              : packageRoot.replace(/\/$/, "") || "react-next-project";

          if (options.metadataOnly) {
            const inspection: ReactProjectInspectionResult = {
              detectedFramework,
              packageRoot,
              sourceFileCount: sourceFiles.length,
              packageName,
              routerConvention,
              styleFileCount: styleFilePaths.length,
              assetCount: assetFilePaths.length,
            };
            const emptySnapshot: ReactNextProjectSnapshot = {
              schemaVersion: "1.0",
              source: "react-next-zip",
              detectedFramework,
              routerConvention,
              packageRoot,
              packageInfo: {
                name: packageName,
                version: typeof manifest.version === "string" ? manifest.version : undefined,
                dependencies,
                devDependencies,
                stylingSolutions,
              },
              stats: {
                sourceFileCount: sourceFiles.length,
                inspectedFileCount: 0,
                routeCount: 0,
                componentCount: 0,
                styleFileCount: styleFilePaths.length,
                assetCount: assetFilePaths.length,
                omittedFileCount: 0,
              },
              routes: [],
              components: [],
              styles: {
                colors: [],
                fonts: [],
                customProperties: {},
                tailwindConfigured: stylingSolutions.includes("tailwindcss"),
                styleFiles: styleFilePaths,
              },
              assets: [],
              diagnostics:
                generatedExcludedCount > 0
                  ? [
                      {
                        severity: "info" as const,
                        code: "GENERATED_FILES_EXCLUDED",
                        message: `Generated build/cache files were excluded from source inspection (${generatedExcludedCount.toLocaleString("en-US")} entr${generatedExcludedCount === 1 ? "y" : "ies"} skipped).`,
                      },
                    ]
                  : [],
            };
            resolve({ inspection, snapshot: emptySnapshot });
            return;
          }

          const diagnostics: ReactNextDiagnostic[] = [];
          if (generatedExcludedCount > 0) {
            diagnostics.push({
              severity: "info",
              code: "GENERATED_FILES_EXCLUDED",
              message: `Generated build/cache files were excluded from source inspection (${generatedExcludedCount.toLocaleString("en-US")} entr${generatedExcludedCount === 1 ? "y" : "ies"} skipped).`,
            });
          }
          const components: ReactNextComponentSummary[] = [];
          const componentsByName = new Map<string, ReactNextComponentSummary>();
          const rawRouteEntries: Array<{
            relativePath: string;
            routePath: string;
            routeName: string;
            isLayout: boolean;
            content: string;
          }> = [];
          const loadedStyleFiles: Array<{ path: string; content: string }> = [];

          for (const [fullPath, content] of textFileBuffers.entries()) {
            if (!fullPath.startsWith(packageRoot)) continue;
            const relPath = fullPath.slice(packageRoot.length);

            if (isStyleOrConfigFile(relPath)) {
              loadedStyleFiles.push({ path: relPath, content });
              continue;
            }

            if (!isSourceFile(relPath)) continue;

            if (/\b(?:useState|useReducer|useEffect|useQuery|fetch\s*\()/i.test(content)) {
              diagnostics.push({
                severity: "info",
                code: "DYNAMIC_CLIENT_STATE_DETECTED",
                message: `Dynamic React state or runtime effect detected in ${relPath}; static JSX defaults were extracted without code execution.`,
                sourcePath: relPath,
              });
            }

            const routeInfo = deriveRouteFromPath(relPath, routerConvention);
            if (routeInfo.isRoute || routeInfo.isLayout) {
              rawRouteEntries.push({
                relativePath: relPath,
                routePath: routeInfo.routePath,
                routeName: routeInfo.routeName,
                isLayout: routeInfo.isLayout,
                content,
              });
            } else {
              const fileBase = relPath
                .split("/")
                .pop()
                ?.replace(/\.(?:[cm]?[jt]sx?)$/i, "") ?? "Component";
              const compName =
                fileBase === "index"
                  ? relPath.split("/").slice(-2, -1)[0] ?? "Component"
                  : fileBase;
              const extracted = extractElementsFromSource(content);
              if (
                extracted.headings.length > 0 ||
                extracted.paragraphs.length > 0 ||
                extracted.buttons.length > 0 ||
                extracted.navItems.length > 0 ||
                extracted.images.length > 0 ||
                extracted.forms.length > 0
              ) {
                const compSummary: ReactNextComponentSummary = {
                  name: compName,
                  sourceFile: relPath,
                  roleHint: inferRoleFromNameOrTag(compName, "section", extracted.headings),
                  className: extracted.className,
                  headings: extracted.headings.slice(0, 10),
                  paragraphs: extracted.paragraphs.slice(0, 15),
                  buttons: extracted.buttons.slice(0, 10),
                  navItems: extracted.navItems.slice(0, 12),
                  images: extracted.images.slice(0, 10),
                  forms: extracted.forms.slice(0, 4),
                };
                components.push(compSummary);
                componentsByName.set(compName, compSummary);
              }
            }
          }

          // Build routes
          const routes: ReactNextRouteSummary[] = [];
          const layoutSections: ReactNextExtractedSection[] = [];
          for (const entry of rawRouteEntries.filter((r) => r.isLayout)) {
            const extractedLayout = extractSectionsFromPageSource(
              "layout",
              entry.routeName,
              entry.content,
              componentsByName,
            );
            layoutSections.push(...extractedLayout);
          }

          const pageEntries = rawRouteEntries.filter((r) => !r.isLayout);
          if (pageEntries.length === 0 && sourceFiles.length > 0) {
            // Fallback to first source file with JSX content if custom entry point is used
            for (const [fullPath, content] of textFileBuffers.entries()) {
              if (!fullPath.startsWith(packageRoot)) continue;
              const relPath = fullPath.slice(packageRoot.length);
              if (isSourceFile(relPath)) {
                pageEntries.push({
                  relativePath: relPath,
                  routePath: "/",
                  routeName: "Home",
                  isLayout: false,
                  content,
                });
                break;
              }
            }
          }

          for (let i = 0; i < pageEntries.length; i++) {
            const entry = pageEntries[i]!;
            const routeId = `route-${i + 1}`;
            const pageSections = extractSectionsFromPageSource(
              routeId,
              entry.routeName,
              entry.content,
              componentsByName,
            );
            const headerLayouts = layoutSections.filter((s) => s.role === "header");
            const footerLayouts = layoutSections.filter((s) => s.role === "footer");
            const combinedSections = [
              ...headerLayouts.filter(
                (hl) => !pageSections.some((ps) => ps.role === "header" && ps.name === hl.name),
              ),
              ...pageSections,
              ...footerLayouts.filter(
                (fl) => !pageSections.some((ps) => ps.role === "footer" && ps.name === fl.name),
              ),
            ];
            routes.push({
              id: routeId,
              path: entry.routePath,
              name: entry.routeName,
              sourceFile: entry.relativePath,
              sections: combinedSections,
              importedComponents: extractChildComponentReferences(entry.content),
            });
          }

          if (omittedFileCount > 0) {
            diagnostics.push({
              severity: "info",
              code: "BOUNDED_ANALYSIS_LIMIT_APPLIED",
              message: `Inspected ${textFileBuffers.size} prioritized source/style files and omitted ${omittedFileCount} lower-priority files to keep analysis bounded.`,
            });
          }

          const styles = extractStylesFromFiles(
            loadedStyleFiles,
            stylingSolutions.includes("tailwindcss"),
          );

          const assets: ReactNextAssetSummary[] = assetFilePaths.slice(0, 60).map((assetPath, idx) => {
            const ext = assetPath.split(".").pop()?.toLowerCase() ?? "";
            const kind: ReactNextAssetSummary["kind"] =
              ext === "svg"
                ? "svg"
                : ext === "ico"
                  ? "icon"
                  : ["woff", "woff2", "ttf", "otf"].includes(ext)
                    ? "font"
                    : "image";
            return {
              id: `asset-${idx + 1}`,
              path: assetPath,
              kind,
            };
          });

          const snapshot: ReactNextProjectSnapshot = {
            schemaVersion: "1.0",
            source: "react-next-zip",
            detectedFramework,
            routerConvention,
            packageRoot,
            packageInfo: {
              name: packageName,
              version: typeof manifest.version === "string" ? manifest.version : undefined,
              dependencies,
              devDependencies,
              stylingSolutions,
            },
            stats: {
              sourceFileCount: sourceFiles.length,
              inspectedFileCount: textFileBuffers.size,
              routeCount: routes.length,
              componentCount: components.length,
              styleFileCount: styleFilePaths.length,
              assetCount: assets.length,
              omittedFileCount,
            },
            routes,
            components: components.slice(0, 40),
            styles,
            assets,
            diagnostics: diagnostics.slice(0, 30),
          };

          const inspection: ReactProjectInspectionResult = {
            detectedFramework,
            packageRoot,
            sourceFileCount: sourceFiles.length,
            packageName,
            routerConvention,
            routeCount: routes.length,
            componentCount: components.length,
            styleFileCount: styleFilePaths.length,
            assetCount: assets.length,
          };

          resolve({ inspection, snapshot });
        } catch (error) {
          reject(error);
        }
      });

      archive.on("entry", (entry) => {
        const normalizedPath = entry.fileName.replaceAll("\\", "/");

        // Generated build/cache/dependency entries are excluded from source
        // analysis and the conversion snapshot entirely: they are never read,
        // never buffered, and never influence route/component detection. All
        // security checks already ran during inspectZip on this same archive.
        if (isGeneratedArchivePath(normalizedPath)) {
          generatedExcludedCount += 1;
          archive.readEntry();
          return;
        }

        paths.push(normalizedPath);

        const isRootManifest =
          normalizedPath === "package.json" || /^[^/]+\/package\.json$/i.test(normalizedPath);

        if (isRootManifest) {
          if (entry.uncompressedSize > MAX_PACKAGE_JSON_BYTES) {
            fail(
              new HttpError(
                400,
                "INVALID_PROJECT_MANIFEST",
                "The project package.json exceeds the inspection limit.",
              ),
            );
            return;
          }
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              fail(
                new HttpError(
                  400,
                  "INVALID_PROJECT_MANIFEST",
                  "The project package.json could not be read.",
                ),
              );
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > MAX_PACKAGE_JSON_BYTES) {
                stream.destroy(new Error("Manifest exceeds inspection limit"));
                return;
              }
              chunks.push(chunk);
            });
            stream.on("error", () =>
              fail(
                new HttpError(
                  400,
                  "INVALID_PROJECT_MANIFEST",
                  "The project package.json is malformed or unreadable.",
                ),
              ),
            );
            stream.on("end", () => {
              if (settled) return;
              try {
                const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!isRecord(parsed)) {
                  throw new Error("package.json must contain an object");
                }
                if (manifestPath) {
                  fail(
                    new HttpError(
                      400,
                      "AMBIGUOUS_PROJECT_ARCHIVE",
                      "The ZIP contains multiple possible project roots; upload one project at a time.",
                    ),
                  );
                  return;
                }
                manifestPath = normalizedPath;
                manifest = parsed;
                archive.readEntry();
              } catch {
                fail(
                  new HttpError(
                    400,
                    "INVALID_PROJECT_MANIFEST",
                    "The project package.json is not valid JSON.",
                  ),
                );
              }
            });
          });
          return;
        }

        if (
          !options.metadataOnly &&
          ! normalizedPath.endsWith("/") &&
          (isSourceFile(normalizedPath) || isStyleOrConfigFile(normalizedPath))
        ) {
          if (
            textFileBuffers.size >= MAX_INSPECTED_TEXT_FILES ||
            entry.uncompressedSize > MAX_SOURCE_FILE_BYTES ||
            extractedTextBytes + entry.uncompressedSize > MAX_TOTAL_EXTRACTED_TEXT_BYTES
          ) {
            omittedFileCount += 1;
            archive.readEntry();
            return;
          }
          archive.openReadStream(entry, (streamError, stream) => {
            if (streamError || !stream) {
              archive.readEntry();
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            stream.on("data", (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes <= MAX_SOURCE_FILE_BYTES) {
                chunks.push(chunk);
              }
            });
            stream.on("error", () => {
              archive.readEntry();
            });
            stream.on("end", () => {
              if (settled) return;
              extractedTextBytes += bytes;
              textFileBuffers.set(normalizedPath, Buffer.concat(chunks).toString("utf8"));
              archive.readEntry();
            });
          });
          return;
        }

        archive.readEntry();
      });

      archive.readEntry();
    });
  });
}

export async function persistReactNextImport(params: {
  projectId: string;
  userId: string;
  uploadId: string;
  fileName?: string;
  snapshot: ReactNextProjectSnapshot;
}) {
  const serialized = Buffer.from(JSON.stringify(params.snapshot), "utf8");
  const snapshotKey = `imports/${params.projectId}/react-next-${randomUUID()}.json`;
  const written = await storage.putObject(
    snapshotKey,
    Readable.from(serialized),
    Math.max(serialized.length, MAX_SNAPSHOT_JSON_BYTES),
    { contentType: "application/json" },
  );

  const summary = {
    source: "react-next-zip",
    detectedFramework: params.snapshot.detectedFramework,
    routerConvention: params.snapshot.routerConvention,
    packageRoot: params.snapshot.packageRoot,
    packageInfo: params.snapshot.packageInfo,
    stats: params.snapshot.stats,
    routes: params.snapshot.routes.map((r) => ({
      id: r.id,
      path: r.path,
      name: r.name,
      sourceFile: r.sourceFile,
      sectionCount: r.sections.length,
    })),
    components: params.snapshot.components.map((c) => ({
      name: c.name,
      sourceFile: c.sourceFile,
      roleHint: c.roleHint,
    })),
    styleSummary: {
      colorCount: params.snapshot.styles.colors.length,
      fontCount: params.snapshot.styles.fonts.length,
      tailwindConfigured: params.snapshot.styles.tailwindConfigured,
      styleFiles: params.snapshot.styles.styleFiles,
    },
  };

  try {
    const sourceImport = await prisma.sourceImport.create({
      data: {
        projectId: params.projectId,
        createdById: params.userId,
        kind: "REACT_NEXT_PROJECT",
        status: "READY",
        fileKey: params.uploadId,
        fileName: params.fileName ?? params.snapshot.packageInfo.name,
        snapshotKey,
        summary: summary as never,
        diagnostics: [
          {
            code: "REACT_NEXT_STATIC_ANALYSIS_COMPLETE",
            message: `Inspected ${params.snapshot.stats.inspectedFileCount} source/style files (${params.snapshot.stats.routeCount} route(s), ${params.snapshot.stats.componentCount} component(s)) without executing uploaded code.`,
          },
          ...params.snapshot.diagnostics.map((d) => ({
            code: d.code,
            severity: d.severity,
            message: d.message,
            sourcePath: d.sourcePath,
          })),
        ] as never,
      },
      select: {
        id: true,
        kind: true,
        status: true,
        fileName: true,
        snapshotKey: true,
        summary: true,
        diagnostics: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      sourceImport,
      snapshotStorageKey: snapshotKey,
      snapshotSizeBytes: written.sizeBytes,
      snapshotSha256: written.sha256,
    };
  } catch (error) {
    await storage.deleteObject(snapshotKey).catch(() => undefined);
    throw error;
  }
}

export async function getReactNextUploadInspection(params: {
  projectId: string;
  userId: string;
  uploadId: string;
}) {
  const upload = await prisma.upload.findFirst({
    where: {
      id: params.uploadId,
      projectId: params.projectId,
      sourceType: "REACT_NEXT_ZIP",
    },
    include: {
      sourceImport: true,
    },
  });

  if (!upload) {
    throw new HttpError(404, "UPLOAD_NOT_FOUND", "React/Next.js project upload was not found");
  }
  if (upload.status !== "READY") {
    throw new HttpError(409, "UPLOAD_NOT_READY", "React/Next.js project upload is not ready yet");
  }

  if (upload.sourceImport?.snapshotKey) {
    const raw = await storage.getObject(upload.sourceImport.snapshotKey);
    const snapshot = JSON.parse(raw.toString("utf8")) as ReactNextProjectSnapshot;
    return {
      uploadId: upload.id,
      sourceImportId: upload.sourceImport.id,
      status: upload.status,
      fileName: upload.fileName,
      detectedFramework: upload.detectedFramework ?? snapshot.detectedFramework,
      sizeBytes: upload.sizeBytes.toString(),
      sha256: upload.sha256,
      snapshot,
    };
  }

  const zipBuffer = await storage.getObject(upload.storageKey);
  const { snapshot } = await analyzeReactNextProjectZip(zipBuffer);
  const persisted = await persistReactNextImport({
    projectId: params.projectId,
    userId: params.userId,
    uploadId: upload.id,
    fileName: upload.fileName,
    snapshot,
  });
  await prisma.upload.update({
    where: { id: upload.id },
    data: { sourceImportId: persisted.sourceImport.id },
  });

  return {
    uploadId: upload.id,
    sourceImportId: persisted.sourceImport.id,
    status: upload.status,
    fileName: upload.fileName,
    detectedFramework: snapshot.detectedFramework,
    sizeBytes: upload.sizeBytes.toString(),
    sha256: upload.sha256,
    snapshot,
  };
}
