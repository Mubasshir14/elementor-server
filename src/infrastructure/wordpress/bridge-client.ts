import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";
import ipaddr from "ipaddr.js";
import { HttpError } from "../../middleware/errors.js";

const MAX_RESPONSE_BYTES = 256 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

export interface BridgeCapabilities {
  bridgeVersion: string;
  wordpressVersion: string;
  elementorVersion: string;
  elementorProActive: boolean;
  widgets: string[];
  features: Record<string, "verified" | "unavailable" | "unverified">;
  nativeDocumentWrite: boolean;
}

function validateSiteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, "INVALID_SITE_URL", "Site URL is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(url.hostname)
  ) {
    throw new HttpError(400, "UNSAFE_SITE_URL", "WordPress site must be a public HTTPS hostname without credentials");
  }
  return url;
}

function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.parse(address).range() === "unicast";
}

export async function bridgeRequest<T>(
  rawSiteUrl: string,
  path: string,
  credential: string,
  validate: (value: unknown) => value is T,
): Promise<T> {
  const baseUrl = validateSiteUrl(rawSiteUrl);
  let resolved: LookupAddress[];
  try {
    resolved = await lookup(baseUrl.hostname, { all: true, verbatim: true });
  } catch {
    throw new HttpError(502, "SITE_DNS_FAILED", "WordPress site hostname could not be resolved");
  }
  if (resolved.length === 0 || resolved.some(({ address }) => !isPublicAddress(address))) {
    throw new HttpError(400, "UNSAFE_SITE_ADDRESS", "WordPress site resolves to a non-public network address");
  }
  const endpoint = new URL(path.replace(/^\/+/, ""), `${baseUrl.toString().replace(/\/+$/, "")}/`);
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
  const authorization = `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
  let payload: unknown;
  try {
    payload = await new Promise<unknown>((resolve, reject) => {
      const request = httpsRequest(
        endpoint,
        {
          method: "GET",
          agent: false,
          lookup: pinnedLookup,
          timeout: REQUEST_TIMEOUT_MS,
          headers: {
            Authorization: authorization,
            Accept: "application/json",
            "User-Agent": "DesignToElementorBridge/1.0",
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              response.destroy(new Error("Bridge response exceeded limit"));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            if (response.statusCode !== 200) {
              reject(new HttpError(502, "BRIDGE_REQUEST_FAILED", "WordPress bridge rejected capability verification"));
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(new HttpError(502, "BRIDGE_INVALID_RESPONSE", "WordPress bridge returned invalid JSON"));
            }
          });
        },
      );
      request.on("timeout", () => request.destroy(new Error("WordPress bridge request timed out")));
      request.on("error", reject);
      request.end();
    });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "BRIDGE_UNAVAILABLE", "WordPress bridge could not be reached");
  }
  if (!validate(payload)) {
    throw new HttpError(502, "BRIDGE_INVALID_RESPONSE", "WordPress bridge capability response did not match the contract");
  }
  return payload;
}

export function isBridgeCapabilities(value: unknown): value is BridgeCapabilities {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const features = candidate.features;
  const widgets = candidate.widgets;
  return (
    typeof candidate.bridgeVersion === "string" &&
    candidate.bridgeVersion.length > 0 &&
    typeof candidate.wordpressVersion === "string" &&
    candidate.wordpressVersion.length > 0 &&
    typeof candidate.elementorVersion === "string" &&
    candidate.elementorVersion.length > 0 &&
    typeof candidate.elementorProActive === "boolean" &&
    Array.isArray(widgets) &&
    widgets.every((widget) => typeof widget === "string") &&
    typeof features === "object" &&
    features !== null &&
    !Array.isArray(features) &&
    Object.values(features).every((feature) =>
      feature === "verified" || feature === "unavailable" || feature === "unverified",
    ) &&
    typeof candidate.nativeDocumentWrite === "boolean"
  );
}
