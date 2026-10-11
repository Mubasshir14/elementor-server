import { describe, expect, it } from "vitest";
import { decryptSiteCredential, encryptSiteCredential } from "../src/infrastructure/wordpress/credentials.js";
import { bridgeRequest, isBridgeCapabilities } from "../src/infrastructure/wordpress/bridge-client.js";

describe("WordPress bridge security", () => {
  it("encrypts stored credentials and detects tampering", () => {
    const credential = "bridge-user:private-application-password";
    const encrypted = encryptSiteCredential(credential);
    expect(encrypted).not.toContain(credential);
    expect(decryptSiteCredential(encrypted)).toBe(credential);
    const tampered = `${encrypted.slice(0, -2)}xx`;
    expect(() => decryptSiteCredential(tampered)).toThrow();
  });

  it("rejects insecure and loopback bridge URLs before connecting", async () => {
    await expect(
      bridgeRequest("http://127.0.0.1", "wp-json/design-to-elementor/v1/capabilities", "x:y", isBridgeCapabilities),
    ).rejects.toMatchObject({ code: "UNSAFE_SITE_URL" });
    await expect(
      bridgeRequest("https://127.0.0.1", "wp-json/design-to-elementor/v1/capabilities", "x:y", isBridgeCapabilities),
    ).rejects.toMatchObject({ code: "UNSAFE_SITE_URL" });
  });

  it("accepts only complete capability reports", () => {
    expect(isBridgeCapabilities({
      bridgeVersion: "1.0",
      wordpressVersion: "6.8",
      elementorVersion: "3.29",
      elementorProActive: false,
      widgets: ["heading", "image"],
      features: { containers: "verified" },
      nativeDocumentWrite: false,
    })).toBe(true);
    expect(isBridgeCapabilities({ elementorVersion: "3.29" })).toBe(false);
  });
});
