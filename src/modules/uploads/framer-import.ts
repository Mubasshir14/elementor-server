import { HttpError } from "../../middleware/errors.js";
import { assertImportUrl, safeFetchImportUrl } from "../../infrastructure/wordpress/safe-fetch.js";

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

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .slice(0, 300);
}

function extractTagContent(html: string, tag: string): string | undefined {
  const match = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]{1,2000})<\\/${tag}>`, "i"));
  return match?.[1]?.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || undefined;
}

function countMatches(html: string, pattern: RegExp): number {
  const matches = html.match(pattern);
  return matches ? Math.min(matches.length, 10_000) : 0;
}

function isFramerHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "framer.website" || host.endsWith(".framer.website") || host === "framer.site" || host.endsWith(".framer.site");
}

export function normalizeFramerSiteUrl(rawUrl: string): URL {
  const url = assertImportUrl(rawUrl);
  if (url.search || url.hash) {
    // Query strings and fragments do not change the published document identity for intake.
  }
  return url;
}

export function framerHostHint(hostname: string): string | undefined {
  if (isFramerHost(hostname)) return undefined;
  return "This URL is not hosted on a *.framer.website domain. Public Framer sites can use custom domains, so the import continues as published-site analysis, not native Framer canvas data.";
}

/**
 * Inspect a publicly accessible published page only. This intentionally does not
 * claim native Framer canvas/project recovery: it reports observable page
 * structure, content, links, styles, assets, and explicit limitations.
 */
export async function inspectFramerPublishedSite(rawUrl: string): Promise<FramerPublishedSiteSummary> {
  const normalized = normalizeFramerSiteUrl(rawUrl);
  const result = await safeFetchImportUrl(normalized.toString());
  if (result.status === 404) {
    throw new HttpError(404, "FRAMER_SITE_NOT_FOUND", "The Framer site URL could not be reached. Verify the published URL and try again");
  }
  if (result.status === 403 || result.status === 401) {
    throw new HttpError(403, "FRAMER_SITE_FORBIDDEN", "The published site refused access. Publish the site publicly and try again");
  }
  if (result.status === 429) {
    throw new HttpError(429, "FRAMER_RATE_LIMITED", "The published site is rate limiting imports. Wait and retry");
  }
  if (result.status < 200 || result.status >= 300) {
    throw new HttpError(502, "FRAMER_FETCH_FAILED", "The published Framer site could not be retrieved");
  }
  const contentType = Array.isArray(result.headers["content-type"])
    ? result.headers["content-type"][0]
    : result.headers["content-type"];
  if (contentType && !/text\/html|application\/xhtml/i.test(contentType)) {
    throw new HttpError(415, "FRAMER_UNSUPPORTED_CONTENT", "The URL did not return an HTML page. Provide the public published-site URL");
  }
  const html = result.body.toString("utf8");
  if (!html.trim()) {
    throw new HttpError(502, "FRAMER_EMPTY_RESPONSE", "The published site returned an empty page");
  }

  const title = extractTagContent(html, "title");
  const descriptionMatch = html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']{1,500})["'][^>]*>/i)
    ?? html.match(/<meta[^>]+content=["']([^"']{1,500})["'][^>]*name=["']description["'][^>]*>/i);
  const diagnostics: string[] = [
    "Published-site analysis only: this import inspects public HTML, not native Framer layers, components, interactions, or editing metadata.",
  ];
  const hint = framerHostHint(normalized.hostname);
  if (hint) diagnostics.push(hint);
  if (/<div[^>]*id=["']__framer-badge-container["']/i.test(html)) {
    diagnostics.push("Framer badge container detected; hosted chrome is not part of the editable design.");
  }
  const scriptCount = countMatches(html, /<script\b[^>]*>/gi);
  if (scriptCount > 0) {
    diagnostics.push("Client-rendered scripts were observed; dynamic content may be missing from this static snapshot.");
  }
  if (/data-framer|framer-motion|__framer/i.test(html) === false) {
    diagnostics.push("No Framer runtime markers were found in the HTML. The URL may not be a published Framer site.");
  }
  const blockedAssets = countMatches(html, /data-src=|loading=["']lazy["']/gi);
  if (blockedAssets > 0) {
    diagnostics.push("Lazy-loaded assets were observed; some images may require a browser render to enumerate fully.");
  }

  return {
    method: "published-site-url",
    siteUrl: normalized.toString(),
    finalUrl: result.finalUrl,
    title: title ? decodeEntities(title) : undefined,
    description: descriptionMatch?.[1] ? decodeEntities(descriptionMatch[1]) : undefined,
    pageCount: 1,
    linkCount: countMatches(html, /<a\b[^>]*href=/gi),
    imageCount: countMatches(html, /<img\b[^>]*>/gi),
    stylesheetCount: countMatches(html, /<link\b[^>]*rel=["']stylesheet["']/gi),
    scriptCount,
    diagnostics,
  };
}
