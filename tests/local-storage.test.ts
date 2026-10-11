import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import { storage } from "../src/infrastructure/storage/local.js";

const key = () => `uploads/project-test/${randomUUID()}.zip`;

afterAll(async () => {
  const storagePath = process.env.LOCAL_STORAGE_PATH;
  if (storagePath) await rm(storagePath, { recursive: true, force: true });
});

describe("local file storage", () => {
  it("writes and reads files through the shared private storage API", async () => {
    const storageKey = key();
    const content = Buffer.from("streamed upload contents");
    const result = await storage.write(storageKey, Readable.from([content]), content.length);

    expect(result).toEqual({
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
    await expect(storage.stat(storageKey)).resolves.toEqual({ sizeBytes: content.length });
    await expect(storage.readFile(storageKey)).resolves.toEqual(content);
    await storage.delete(storageKey);
    await expect(storage.stat(storageKey)).resolves.toBeNull();
  });

  it("rejects traversal and platform-specific path separators", async () => {
    await expect(storage.readFile("../outside.txt")).rejects.toMatchObject({
      code: "INVALID_STORAGE_KEY",
    });
    await expect(storage.delete("uploads\\project\\file.zip")).rejects.toMatchObject({
      code: "INVALID_STORAGE_KEY",
    });
  });

  it("returns a missing result when a key's parent directory does not exist", async () => {
    await expect(storage.stat(`uploads/missing-${randomUUID()}/file.zip`)).resolves.toBeNull();
  });

  it("stops a streamed write at its byte limit and does not leave a partial file", async () => {
    const storageKey = key();
    async function* chunks() {
      yield Buffer.alloc(3);
      yield Buffer.alloc(3);
    }

    await expect(storage.write(storageKey, Readable.from(chunks()), 5)).rejects.toMatchObject({
      code: "UPLOAD_TOO_LARGE",
      status: 413,
    });
    await expect(storage.stat(storageKey)).resolves.toBeNull();
  });

  it("supports bounded-memory writes larger than a single stream chunk", async () => {
    const storageKey = key();
    const chunk = Buffer.alloc(1024 * 1024, 7);
    async function* chunks() {
      for (let index = 0; index < 8; index += 1) yield chunk;
    }
    const result = await storage.write(storageKey, Readable.from(chunks()), 8 * chunk.length);

    expect(result.sizeBytes).toBe(8 * chunk.length);
    expect(await storage.stat(storageKey)).toEqual({ sizeBytes: 8 * chunk.length });
    await storage.delete(storageKey);
  });
});
