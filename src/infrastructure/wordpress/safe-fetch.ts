import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { HttpError } from "../../middleware/errors.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

export type SafeFetchResult = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  finalUrl: string;
};

export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.parse(address).range() === "unicast";
}

export function assertImportUrl(raw: string, maxLength = 2_048): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new HttpError(400, "INVALID_IMPORT_URL", "The supplied URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new HttpError(400, "UNSAFE_IMPORT_URL", "Only public HTTP(S) URLs can be imported");
  }
  if (url.username || url.password) {
    throw new HttpError(400, "UNSAFE_IMPORT_URL", "URLs with embedded credentials cannot be imported");
  }
  if (raw.length > maxLength) {
    throw new HttpError(400, "INVALID_IMPORT_URL", "The supplied URL is too long");
  }
  if (isIP(url.hostname)) {
    if (!isPublicAddress(url.hostname)) {
      throw new HttpError(400, "UNSAFE_IMPORT_URL", "Private, localhost, and link-local addresses cannot be imported");
    }
  }
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(url.hostname)) {
    throw new HttpError(400, "UNSAFE_IMPORT_URL", "Local hostnames cannot be imported");
  }
  return url;
}

async function resolvePublic(url: URL): Promise<LookupAddress[]> {
  let resolved: LookupAddress[];
  try {
    resolved = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, "IMPORT_DNS_FAILED", "The import hostname could not be resolved");
  }
  if (resolved.length === 0 || resolved.some(({ address }) => !isPublicAddress(address))) {
    throw new HttpError(400, "UNSAFE_IMPORT_URL", "The hostname resolves to a non-public network address");
  }
  return resolved;
}

function singleRequest(
  url: URL,
  resolved: LookupAddress[],
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  const requester = url.protocol === "https:" ? httpsRequest : httpRequest;
  const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
    if (options.all) {
      callback(null, resolved);
    } else {
      const first = resolved[0];
      if (!first) {
        callback(Object.assign(new Error("No verified address"), { code: "ENOTFOUND" }), "", 4);
      } else {
        callback(null, first.address, first.family);
      }
    }
  };
  return new Promise((resolve, reject) => {
    const request = requester(
      url,
      {
        method: "GET",
        agent: false,
        lookup: pinnedLookup,
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5",
          "User-Agent": "DesignToElementorImporter/1.0",
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("Import response exceeded limit"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Import request timed out")));
    request.on("error", reject);
    request.end();
  });
}

/**
 * Fetch a remote import target with SSRF protections: public HTTP(S) URLs only,
 * DNS-pinned resolution on every hop, redirect re-validation, and strict
 * request-size/time limits. Treated as untrusted data by callers.
 */
export async function safeFetchImportUrl(
  rawUrl: string,
  headers: Record<string, string> = {},
): Promise<SafeFetchResult> {
  let current = assertImportUrl(rawUrl);
  let finalUrl = current.toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const resolved = await resolvePublic(current);
    let response: { status: number; headers: Record<string, string | string[] | undefined>; body: Buffer };
    try {
      response = await singleRequest(current, resolved, headers);
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, "IMPORT_FETCH_FAILED", "The remote page could not be retrieved");
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.location;
      const target = Array.isArray(location) ? location[0] : location;
      if (!target) {
        throw new HttpError(502, "IMPORT_FETCH_FAILED", "The remote page returned an unsafe redirect");
      }
      try {
        current = new URL(target, current);
      } catch {
        throw new HttpError(502, "IMPORT_FETCH_FAILED", "The remote page returned an unsafe redirect");
      }
      current = assertImportUrl(current.toString());
      finalUrl = current.toString();
      continue;
    }
    return { status: response.status, headers: response.headers, body: response.body, finalUrl };
  }

  throw new HttpError(502, "IMPORT_FETCH_FAILED", "The remote page redirected too many times");
}
