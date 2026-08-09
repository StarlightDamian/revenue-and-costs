import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAsyncResource } from "../../src/web/composables/useAsyncResource.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("useAsyncResource concurrency", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the newest result when an older request succeeds later", async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const loader = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const resource = useAsyncResource(loader);

    const olderReload = resource.reload();
    const newerReload = resource.reload();
    newer.resolve("new");
    await newerReload;
    older.resolve("old");
    await olderReload;

    expect(resource.data.value).toBe("new");
    expect(resource.status.value).toBe("ready");
    expect(resource.error.value).toBe("");
  });

  it("ignores an older failure after a newer request succeeds", async () => {
    const older = deferred<string>();
    const newer = deferred<string>();
    const loader = vi.fn()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const resource = useAsyncResource(loader);

    const olderReload = resource.reload();
    const newerReload = resource.reload();
    newer.resolve("new");
    await newerReload;
    older.reject(new Error("old failure"));
    await olderReload;

    expect(resource.data.value).toBe("new");
    expect(resource.status.value).toBe("ready");
    expect(resource.error.value).toBe("");
  });
});
