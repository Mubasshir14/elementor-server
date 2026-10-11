import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.NODE_ENV = "test";
process.env.API_PORT = "4000";
process.env.WEB_ORIGIN = "http://localhost:3000";
process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:5432/test";
process.env.JWT_SECRET = "test-only-secret-key-that-is-not-used-outside-tests";
process.env.UPLOAD_MAX_BYTES = "52428800";
process.env.UPLOAD_QUOTA_BYTES = "524288000";
process.env.STORAGE_PROVIDER = "local";
process.env.LOCAL_STORAGE_PATH = join(tmpdir(), `design-to-elementor-tests-${process.pid}-${randomUUID()}`);
process.env.AI_PROVIDER = "disabled";
process.env.AI_API_KEY = "";
process.env.AI_MODEL = "";
process.env.SITE_CREDENTIAL_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CONVERSION_WORKER_CONCURRENCY = "1";
process.env.CONVERSION_MAX_ATTEMPTS = "1";
