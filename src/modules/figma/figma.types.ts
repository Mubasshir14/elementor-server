export type FigNativeDiagnostic = {
  code: string;
  message: string;
  nodeId?: string;
};

export type FigNativeNode = {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  size?: { x: number; y: number } | undefined;
  position?: { x: number; y: number } | undefined;
  constraints?: {
    horizontal?: string | undefined;
    vertical?: string | undefined;
  } | undefined;
  layout?: {
    mode: "HORIZONTAL" | "VERTICAL" | "NONE";
    primaryAlign?: string | undefined;
    counterAlign?: string | undefined;
    gap?: number | undefined;
    padding?: { left: number; right: number; top: number; bottom: number } | undefined;
    wrap?: boolean | undefined;
    sizingHorizontal?: string | undefined;
    sizingVertical?: string | undefined;
  } | undefined;
  fills?: Array<{
    type: string;
    color?: { r: number; g: number; b: number; a: number } | undefined;
    hex?: string | undefined;
  }> | undefined;
  strokes?: Array<{
    type: string;
    color?: { r: number; g: number; b: number; a: number } | undefined;
    hex?: string | undefined;
    weight?: number | undefined;
  }> | undefined;
  cornerRadius?: number | undefined;
  rectangleCornerRadii?: [number, number, number, number] | undefined;
  opacity?: number | undefined;
  characters?: string | undefined;
  typography?: {
    fontFamily?: string | undefined;
    fontWeight?: number | undefined;
    fontSize?: number | undefined;
    lineHeight?: number | undefined;
    letterSpacing?: number | undefined;
    textAlign?: string | undefined;
  } | undefined;
  componentId?: string | undefined;
  isInstance?: boolean | undefined;
  isComponentSet?: boolean | undefined;
  variantProperties?: Record<string, string> | undefined;
  children: FigNativeNode[];
};

export type FigNativePage = {
  id: string;
  name: string;
  type: string;
  children: FigNativeNode[];
};

export type FigNativeDocument = {
  fileName: string;
  version: number;
  pages: FigNativePage[];
  nodeCount: number;
  componentCount: number;
  instanceCount: number;
  diagnostics: FigNativeDiagnostic[];
};

export type FigNativeParseResult = {
  sha256: string;
  byteLength: number;
  document: FigNativeDocument;
};

export type FigmaFileSummary = {
  fileKey: string;
  name: string;
  lastModified?: string | undefined;
  editorType?: string | undefined;
  version?: string | undefined;
  thumbnailUrl?: string | undefined;
  pageCount?: number | undefined;
  componentCount?: number | undefined;
  styleCount?: number | undefined;
  nodeCount?: number | undefined;
};

export type FigmaNativeFileKind = "fig" | "deck" | "unknown-archive";

export type FigmaExtractedStructure = {
  pages: Array<{ name: string; type: string; nodeCount: number }>;
  totalNodes: number;
  componentNames: string[];
  styleNames: string[];
};

export type FigmaFileInspection = {
  sha256: string;
  byteLength: number;
  summary: FigmaFileSummary;
  structure: FigmaExtractedStructure;
};

