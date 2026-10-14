import type {
  ReactNextComponentSummary,
  ReactNextProjectSnapshot,
  ReactNextRouteSummary,
} from "./react-nextjs.types.js";

/**
 * Deterministic schema-aware projection of a ReactNextProjectSnapshot for AI input.
 *
 * Why this is needed:
 * Groq's on-demand TPM limit is 8,000 tokens per minute.
 * A full snapshot of a React/Next.js application includes:
 *  - Internal diagnostics (zip unpacker debug logs)
 *  - Full package.json dependency lists (100+ packages)
 *  - Duplicate / unused components
 *  - Long Tailwind utility class strings on every leaf element
 *  - Empty arrays and default fields
 *
 * This projection deterministically strips the bloat while preserving 100% of the
 * structural and design context required for DIR conversion:
 *  - Framework and routing conventions
 *  - Page/Route hierarchy and layout hints
 *  - Sections with their roles and component trees
 *  - All copy: headings (level & text), paragraphs, buttons (label & href), nav items, forms
 *  - Referenced components (including their child headings, paragraphs, buttons)
 *  - Essential design tokens (colors, fonts, custom properties)
 *  - Asset paths and kinds
 */

export interface ProjectedReactSnapshot {
  schemaVersion: "1.0";
  source: "react-next-zip";
  detectedFramework: string;
  routerConvention: string;
  packageName: string;
  stylingSolutions: string[];
  routes: Array<{
    path: string;
    name: string;
    isLayout?: boolean;
    sections: Array<{
      id: string;
      name: string;
      role: string;
      layoutHint?: {
        mode: "flex" | "grid" | "stack";
        direction?: "row" | "column";
        columns?: number;
        gapPx?: number;
      };
      headings?: Array<{ level: number; text: string }>;
      paragraphs?: string[];
      buttons?: Array<{ label: string; href?: string; variant?: string }>;
      navItems?: Array<{ label: string; href: string }>;
      images?: Array<{ src: string; alt?: string }>;
      forms?: Array<{
        action?: string;
        submitLabel?: string;
        fields: Array<{ name: string; type: string; label?: string; placeholder?: string; required?: boolean }>;
      }>;
      childComponents?: string[];
    }>;
  }>;
  components?: Array<{
    name: string;
    roleHint?: string;
    headings?: Array<{ level: number; text: string }>;
    paragraphs?: string[];
    buttons?: Array<{ label: string; href?: string; variant?: string }>;
    navItems?: Array<{ label: string; href: string }>;
    images?: Array<{ src: string; alt?: string }>;
    forms?: Array<{
      action?: string;
      submitLabel?: string;
      fields: Array<{ name: string; type: string; label?: string; placeholder?: string; required?: boolean }>;
    }>;
  }>;
  styles?: {
    colors: Array<{ name: string; value: string }>;
    fonts: Array<{ name: string; family: string }>;
    customProperties: Record<string, string>;
    tailwindConfigured: boolean;
  };
  assets?: Array<{ path: string; kind: string }>;
}

export function projectReactSnapshotForAi(snapshot: ReactNextProjectSnapshot): ProjectedReactSnapshot {
  // 1. Collect all component names that are referenced by routes or sections
  const referencedComponentNames = new Set<string>();
  const normalize = (name: string) => name.toLowerCase().replace(/[-_]/g, "");

  for (const route of snapshot.routes || []) {
    for (const comp of route.importedComponents || []) {
      referencedComponentNames.add(normalize(comp));
    }
    for (const sec of route.sections || []) {
      for (const comp of sec.childComponents || []) {
        referencedComponentNames.add(normalize(comp));
      }
    }
  }

  // 2. Project routes and sections, preserving ALL copy and structure in order.
  // Prioritize primary user-facing routes (e.g. "/", "/pricing") over internal error boundaries (e.g. "/__root").
  const userFacingRoutes = (snapshot.routes || []).filter(
    (r) => !r.path.startsWith("/__") && !r.name.includes("404"),
  );
  const routesToProject = userFacingRoutes.length > 0 ? userFacingRoutes : (snapshot.routes || []);

  const projectedRoutes = routesToProject.map((route: ReactNextRouteSummary) => ({
    path: route.path,
    name: route.name,
    ...(route.isLayout ? { isLayout: true } : {}),
    sections: (route.sections || []).map((sec) => {
      const projectedSec: any = {
        id: sec.id,
        name: sec.name,
        role: sec.role,
      };
      if (sec.layoutHint) {
        projectedSec.layoutHint = sec.layoutHint;
      }
      if (sec.headings && sec.headings.length > 0) {
        projectedSec.headings = sec.headings.map((h) => ({ level: h.level, text: h.text }));
      }
      if (sec.paragraphs && sec.paragraphs.length > 0) {
        projectedSec.paragraphs = sec.paragraphs;
      }
      if (sec.buttons && sec.buttons.length > 0) {
        projectedSec.buttons = sec.buttons.map((b) => ({
          label: b.label,
          ...(b.href ? { href: b.href } : {}),
          ...(b.variant ? { variant: b.variant } : {}),
        }));
      }
      if (sec.navItems && sec.navItems.length > 0) {
        projectedSec.navItems = sec.navItems;
      }
      if (sec.images && sec.images.length > 0) {
        projectedSec.images = sec.images.map((img) => ({
          src: img.src,
          ...(img.alt ? { alt: img.alt } : {}),
        }));
      }
      if (sec.forms && sec.forms.length > 0) {
        projectedSec.forms = sec.forms.map((f) => ({
          ...(f.action ? { action: f.action } : {}),
          ...(f.submitLabel ? { submitLabel: f.submitLabel } : {}),
          fields: f.fields.map((fld) => ({
            name: fld.name,
            type: fld.type,
            ...(fld.label ? { label: fld.label } : {}),
            ...(fld.placeholder ? { placeholder: fld.placeholder } : {}),
            ...(fld.required ? { required: true } : {}),
          })),
        }));
      }
      if (sec.childComponents && sec.childComponents.length > 0) {
        projectedSec.childComponents = sec.childComponents;
      }
      return projectedSec;
    }),
  }));

  // 3. Project only referenced components (or all if no references found)
  const componentsToInclude = (snapshot.components || []).filter(
    (c) => referencedComponentNames.size === 0 || referencedComponentNames.has(normalize(c.name)),
  );

  const projectedComponents = componentsToInclude
    .map((c: ReactNextComponentSummary) => {
      const hasHeadings = c.headings && c.headings.length > 0;
      const hasParagraphs = c.paragraphs && c.paragraphs.length > 0;
      const hasButtons = c.buttons && c.buttons.length > 0;
      const hasNavItems = c.navItems && c.navItems.length > 0;
      const hasImages = c.images && c.images.length > 0;
      const hasForms = c.forms && c.forms.length > 0;

      // Skip component if it contains zero design content
      if (!hasHeadings && !hasParagraphs && !hasButtons && !hasNavItems && !hasImages && !hasForms) {
        return null;
      }

      const truncateText = (t: string) => (t.length > 160 ? t.slice(0, 157) + "..." : t);

      const comp: any = {
        name: c.name,
      };
      if (c.roleHint) comp.roleHint = c.roleHint;
      if (hasHeadings) comp.headings = c.headings.slice(0, 3).map((h) => ({ level: h.level, text: truncateText(h.text) }));
      if (hasParagraphs) comp.paragraphs = c.paragraphs.slice(0, 2).map(truncateText);
      if (hasButtons) {
        comp.buttons = c.buttons.slice(0, 2).map((b) => ({
          label: truncateText(b.label),
          ...(b.href ? { href: b.href } : {}),
          ...(b.variant ? { variant: b.variant } : {}),
        }));
      }
      if (hasNavItems) comp.navItems = c.navItems.slice(0, 4);
      if (hasImages) {
        comp.images = c.images.slice(0, 2).map((img) => ({
          src: img.src,
          ...(img.alt ? { alt: img.alt } : {}),
        }));
      }
      if (hasForms) {
        comp.forms = c.forms.slice(0, 1).map((f) => ({
          ...(f.action ? { action: f.action } : {}),
          ...(f.submitLabel ? { submitLabel: f.submitLabel } : {}),
          fields: f.fields.slice(0, 4).map((fld) => ({
            name: fld.name,
            type: fld.type,
            ...(fld.label ? { label: fld.label } : {}),
            ...(fld.placeholder ? { placeholder: fld.placeholder } : {}),
            ...(fld.required ? { required: true } : {}),
          })),
        }));
      }
      return comp;
    })
    .filter(Boolean);

  // 4. Styles: keep unique colors, fonts, customProperties
  const styles: any = {};
  if (snapshot.styles) {
    if (snapshot.styles.colors && snapshot.styles.colors.length > 0) {
      styles.colors = snapshot.styles.colors.map((c) => ({ name: c.name, value: c.value }));
    }
    if (snapshot.styles.fonts && snapshot.styles.fonts.length > 0) {
      styles.fonts = snapshot.styles.fonts.map((f) => ({ name: f.name, family: f.family }));
    }
    if (snapshot.styles.customProperties && Object.keys(snapshot.styles.customProperties).length > 0) {
      // Keep only key design variables (e.g. --primary, --radius, --background) and cap at 10
      // so the AI does not waste its completion token limit repeating dozens of raw CSS vars.
      const entries = Object.entries(snapshot.styles.customProperties)
        .filter(([key]) => /--(?:primary|secondary|background|foreground|font|radius|accent)/i.test(key))
        .slice(0, 10);
      if (entries.length > 0) {
        styles.customProperties = Object.fromEntries(entries);
      }
    }
    styles.tailwindConfigured = Boolean(snapshot.styles.tailwindConfigured);
  }

  // 5. Assets: compact paths and kinds
  const assets = (snapshot.assets || []).map((a) => ({
    path: a.path,
    kind: a.kind,
  }));

  const result: ProjectedReactSnapshot = {
    schemaVersion: "1.0",
    source: "react-next-zip",
    detectedFramework: snapshot.detectedFramework,
    routerConvention: snapshot.routerConvention,
    packageName: snapshot.packageInfo?.name || "unnamed",
    stylingSolutions: snapshot.packageInfo?.stylingSolutions || [],
    routes: projectedRoutes,
  };

  if (projectedComponents.length > 0) {
    result.components = projectedComponents as any;
  }
  if (Object.keys(styles).length > 0) {
    result.styles = styles;
  }
  if (assets.length > 0) {
    result.assets = assets;
  }

  return result;
}
