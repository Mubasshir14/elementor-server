import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "../../config/env.js";
import { HttpError } from "../../middleware/errors.js";

function siteEncryptionKey(): Buffer {
  const encoded = env.SITE_CREDENTIAL_ENCRYPTION_KEY;
  if (!encoded) {
    throw new HttpError(503, "SITE_CREDENTIALS_UNAVAILABLE", "WordPress credential encryption is not configured");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new HttpError(503, "SITE_CREDENTIALS_UNAVAILABLE", "WordPress credential encryption key must be 32 bytes");
  }
  return key;
}

export function encryptSiteCredential(credential: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", siteEncryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptSiteCredential(value: string): string {
  const [version, ivValue, tagValue, ciphertextValue] = value.split(":");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new HttpError(500, "SITE_CREDENTIAL_INVALID", "Stored WordPress credential cannot be decrypted");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", siteEncryptionKey(), Buffer.from(ivValue, "base64"));
    decipher.setAuthTag(Buffer.from(tagValue, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new HttpError(500, "SITE_CREDENTIAL_INVALID", "Stored WordPress credential cannot be decrypted");
  }
}
