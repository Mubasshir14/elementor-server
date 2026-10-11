import { describe, expect, it } from "vitest";
import { ScanSemaphore } from "../src/infrastructure/storage/scan-semaphore.js";

describe("upload scan concurrency", () => {
  it("bounds active scans and releases capacity exactly once", () => {
    const semaphore = new ScanSemaphore(1);
    const release = semaphore.acquire();
    expect(release).toBeTypeOf("function");
    expect(semaphore.acquire()).toBeUndefined();
    release?.();
    release?.();
    expect(semaphore.acquire()).toBeTypeOf("function");
  });
});
