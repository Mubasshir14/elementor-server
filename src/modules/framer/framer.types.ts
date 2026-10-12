export type FramerImportMethod = "published-site-url";

export type FramerPublishedSiteSummary = {
  method: FramerImportMethod;
  siteUrl: string;
  finalUrl: string;
  title?: string | undefined;
  description?: string | undefined;
  pageCount: number;
  linkCount: number;
  imageCount: number;
  stylesheetCount: number;
  scriptCount: number;
  diagnostics: string[];
};

