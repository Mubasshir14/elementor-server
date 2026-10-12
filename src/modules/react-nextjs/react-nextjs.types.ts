export type DetectedFramework = "react" | "nextjs";

export type RouterConvention = "nextjs-app-router" | "nextjs-pages-router" | "react-spa";

export interface ZipInspectionOptions {
  maxEntries?: number | undefined;
  maxExpandedBytes?: number | undefined;
  maxEntryBytes?: number | undefined;
  maxCompressionRatio?: number | undefined;
}

export interface ReactProjectInspectionResult {
  detectedFramework: DetectedFramework;
  packageRoot: string;
  sourceFileCount: number;
  packageName?: string | undefined;
  routerConvention?: RouterConvention | undefined;
  routeCount?: number | undefined;
  componentCount?: number | undefined;
  styleFileCount?: number | undefined;
  assetCount?: number | undefined;
}

export interface ReactNextExtractedHeading {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
  className?: string | undefined;
}

export interface ReactNextExtractedButton {
  label: string;
  href?: string | undefined;
  variant?: "primary" | "secondary" | "outline" | "ghost" | "link" | undefined;
  className?: string | undefined;
}

export interface ReactNextExtractedNavItem {
  label: string;
  href: string;
}

export interface ReactNextExtractedImage {
  src: string;
  alt?: string | undefined;
  className?: string | undefined;
}

export interface ReactNextExtractedFormField {
  name: string;
  type: "text" | "email" | "tel" | "textarea" | "select" | "checkbox" | "password";
  label?: string | undefined;
  placeholder?: string | undefined;
  required?: boolean | undefined;
}

export interface ReactNextExtractedForm {
  action?: string | undefined;
  submitLabel?: string | undefined;
  fields: ReactNextExtractedFormField[];
}

export interface ReactNextExtractedSection {
  id: string;
  name: string;
  role:
    | "header"
    | "hero"
    | "features"
    | "content"
    | "testimonials"
    | "pricing"
    | "faq"
    | "cta"
    | "footer"
    | "custom";
  tagName: string;
  className?: string | undefined;
  layoutHint?:
    | {
        mode: "flex" | "grid" | "stack";
        direction?: "row" | "column" | undefined;
        columns?: number | undefined;
        gapPx?: number | undefined;
      }
    | undefined;
  headings: ReactNextExtractedHeading[];
  paragraphs: string[];
  buttons: ReactNextExtractedButton[];
  navItems: ReactNextExtractedNavItem[];
  images: ReactNextExtractedImage[];
  forms: ReactNextExtractedForm[];
  childComponents: string[];
}

export interface ReactNextRouteSummary {
  id: string;
  path: string;
  name: string;
  sourceFile: string;
  isLayout?: boolean | undefined;
  sections: ReactNextExtractedSection[];
  importedComponents: string[];
}

export interface ReactNextComponentSummary {
  name: string;
  sourceFile: string;
  roleHint?: ReactNextExtractedSection["role"] | undefined;
  className?: string | undefined;
  headings: ReactNextExtractedHeading[];
  paragraphs: string[];
  buttons: ReactNextExtractedButton[];
  navItems: ReactNextExtractedNavItem[];
  images: ReactNextExtractedImage[];
  forms: ReactNextExtractedForm[];
}

export interface ReactNextStyleTokens {
  colors: Array<{ name: string; value: string; source: string }>;
  fonts: Array<{ name: string; family: string; source: string }>;
  customProperties: Record<string, string>;
  tailwindConfigured: boolean;
  styleFiles: string[];
}

export interface ReactNextAssetSummary {
  id: string;
  path: string;
  kind: "image" | "svg" | "font" | "icon";
}

export interface ReactNextDiagnostic {
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  sourcePath?: string | undefined;
}

export interface ReactNextProjectSnapshot {
  schemaVersion: "1.0";
  source: "react-next-zip";
  detectedFramework: DetectedFramework;
  routerConvention: RouterConvention;
  packageRoot: string;
  packageInfo: {
    name: string;
    version?: string | undefined;
    dependencies: string[];
    devDependencies: string[];
    stylingSolutions: string[];
  };
  stats: {
    sourceFileCount: number;
    inspectedFileCount: number;
    routeCount: number;
    componentCount: number;
    styleFileCount: number;
    assetCount: number;
    omittedFileCount: number;
  };
  routes: ReactNextRouteSummary[];
  components: ReactNextComponentSummary[];
  styles: ReactNextStyleTokens;
  assets: ReactNextAssetSummary[];
  diagnostics: ReactNextDiagnostic[];
}

