export {
  FIGMA_SUPPORTED_UPLOAD_FORMAT,
  FIGMA_SUPPORTED_UPLOAD_DESCRIPTION,
  detectNativeFigmaFile,
  extractFigmaStructure,
  inspectFigmaFileJson,
} from "../figma/figma.parser.js";
export type {
  FigmaNativeFileKind,
  FigmaFileInspection,
  FigmaExtractedStructure,
} from "../figma/figma.types.js";
