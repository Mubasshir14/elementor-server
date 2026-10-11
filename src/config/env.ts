import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  WEB_ORIGIN: z.string().url(),
  DATABASE_URL: z.string().url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "postgres:" || protocol === "postgresql:";
  }, "DATABASE_URL must use PostgreSQL"),
  JWT_SECRET: z.string().min(32),
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(52_428_800).default(52_428_800),
  UPLOAD_QUOTA_BYTES: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(524_288_000),
  STORAGE_PROVIDER: z.enum(["local"]).default("local"),
  LOCAL_STORAGE_PATH: z.string().trim().min(1).default("./storage/uploads"),
  AI_PROVIDER: z.string().regex(/^[a-z0-9-]+$/).default("disabled"),
  AI_API_KEY: z.string().optional(),
  AI_MODEL: z.string().optional(),
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
  }
});

export const env = schema.parse(process.env);
export type Environment = z.infer<typeof schema>;
