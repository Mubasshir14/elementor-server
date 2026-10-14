import "dotenv/config";
import { z } from "zod";

export const MAX_UPLOAD_LIMIT_BYTES = 524_288_000; // 500 MiB
export const DEFAULT_PROJECT_QUOTA_BYTES = 2_147_483_648; // 2 GiB

function inferB2RegionFromEndpoint(endpoint: string | undefined): string | undefined {
  if (!endpoint) return undefined;
  const match = endpoint.trim().match(/^https?:\/\/s3\.([a-z0-9-]+)\.backblazeb2\.com/i);
  return match?.[1];
}

export const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  WEB_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  }, "DATABASE_URL must use PostgreSQL"),
  JWT_SECRET: z.string().min(32),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(MAX_UPLOAD_LIMIT_BYTES).default(MAX_UPLOAD_LIMIT_BYTES),
  MAX_UPLOAD_SIZE_BYTES: z.coerce.number().int().positive().max(MAX_UPLOAD_LIMIT_BYTES).optional(),
  UPLOAD_QUOTA_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(DEFAULT_PROJECT_QUOTA_BYTES),
  ZIP_MAX_ENTRIES: z.coerce.number().int().positive().max(100_000).default(10_000),
  ZIP_MAX_UNCOMPRESSED_BYTES: z.coerce.number().int().positive().max(4_294_967_296).default(1_073_741_824),
  ZIP_MAX_ENTRY_BYTES: z.coerce.number().int().positive().max(524_288_000).default(67_108_864),
  ZIP_MAX_COMPRESSION_RATIO: z.coerce.number().int().positive().max(1_000).default(200),
  STORAGE_PROVIDER: z.enum(["b2", "local"]).default("local"),
  LOCAL_STORAGE_PATH: z.string().trim().min(1).default("./storage/uploads"),
  B2_BUCKET_NAME: z.string().trim().optional(),
  B2_ENDPOINT: z.string().trim().optional(),
  B2_REGION: z.string().trim().optional(),
  B2_APPLICATION_KEY_ID: z.string().trim().optional(),
  B2_APPLICATION_KEY: z.string().trim().optional(),
  B2_PRESIGNED_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  AI_PROVIDER: z.string().regex(/^[a-z0-9-]+$/).default("disabled"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(300_000).default(60_000),
  GEMINI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  ENABLE_GEMINI: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  SITE_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  CONVERSION_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(2),
  CONVERSION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
}).superRefine((value, context) => {
  if (value.AI_PROVIDER !== "disabled" && (!value.AI_API_KEY || !value.AI_MODEL)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["AI_PROVIDER"],
      message: "Enabled AI providers require an API key and model",
    });
  }
  if (new URL(value.WEB_ORIGIN).origin !== value.WEB_ORIGIN) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WEB_ORIGIN"],
      message: "WEB_ORIGIN must be an origin without a path",
    });
  }
  if (
    value.SITE_CREDENTIAL_ENCRYPTION_KEY &&
    Buffer.from(value.SITE_CREDENTIAL_ENCRYPTION_KEY, "base64").length !== 32
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["SITE_CREDENTIAL_ENCRYPTION_KEY"],
      message: "Site credential encryption key must be a base64-encoded 32-byte key",
    });
  }
  if (value.NODE_ENV === "production") {
    if (new URL(value.WEB_ORIGIN).protocol !== "https:") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["WEB_ORIGIN"],
        message: "Production WEB_ORIGIN must use HTTPS",
      });
    }
    if (value.STORAGE_PROVIDER !== "b2") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["STORAGE_PROVIDER"],
        message: "Production requires STORAGE_PROVIDER=b2 (Backblaze B2); local filesystem fallback is disabled in production",
      });
    }
  }
  if (value.STORAGE_PROVIDER === "b2") {
    if (!value.B2_BUCKET_NAME) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["B2_BUCKET_NAME"],
        message: "B2_BUCKET_NAME is required when STORAGE_PROVIDER=b2",
      });
    }
    if (!value.B2_REGION) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["B2_REGION"],
        message: "B2_REGION is required when STORAGE_PROVIDER=b2",
      });
    }
    if (!value.B2_APPLICATION_KEY_ID) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["B2_APPLICATION_KEY_ID"],
        message: "B2_APPLICATION_KEY_ID is required when STORAGE_PROVIDER=b2",
      });
    }
    if (!value.B2_APPLICATION_KEY) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["B2_APPLICATION_KEY"],
        message: "B2_APPLICATION_KEY is required when STORAGE_PROVIDER=b2",
      });
    }
    if (!value.B2_ENDPOINT) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["B2_ENDPOINT"],
        message: "B2_ENDPOINT is required when STORAGE_PROVIDER=b2",
      });
    } else {
      try {
        const parsed = new URL(value.B2_ENDPOINT);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
          throw new Error("Invalid protocol");
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["B2_ENDPOINT"],
          message: "B2_ENDPOINT must be a valid HTTP(S) URL",
        });
      }
    }
  }
});

export function parseEnvironment(input: NodeJS.ProcessEnv = process.env) {
  const normalized: NodeJS.ProcessEnv = { ...input };

  if (normalized.MAX_UPLOAD_SIZE_BYTES?.trim()) {
    const maxUploadSize = Number(normalized.MAX_UPLOAD_SIZE_BYTES.trim());
    const currentUploadMax = normalized.UPLOAD_MAX_BYTES ? Number(normalized.UPLOAD_MAX_BYTES) : undefined;
    if (
      Number.isFinite(maxUploadSize) &&
      (currentUploadMax === undefined || currentUploadMax === 52_428_800 || maxUploadSize > currentUploadMax)
    ) {
      normalized.UPLOAD_MAX_BYTES = String(maxUploadSize);
    }
  }

  if (!normalized.B2_REGION?.trim() && normalized.B2_ENDPOINT?.trim()) {
    const inferredRegion = inferB2RegionFromEndpoint(normalized.B2_ENDPOINT);
    if (inferredRegion) {
      normalized.B2_REGION = inferredRegion;
    }
  }

  return envSchema.parse(normalized);
}

export const env = parseEnvironment(process.env);
export type Environment = z.infer<typeof envSchema>;
