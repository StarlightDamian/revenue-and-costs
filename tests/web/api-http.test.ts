import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, isApiErrorCode, withAppBasePath } from "../../src/web/api/http";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("web API request content types", () => {
  it("prefixes API and download paths exactly once under the application base", () => {
    expect(withAppBasePath("/api/v1/me", "/revenue-costs/")).toBe("/revenue-costs/api/v1/me");
    expect(withAppBasePath("/revenue-costs/api/v1/me", "/revenue-costs/")).toBe("/revenue-costs/api/v1/me");
    expect(withAppBasePath("/api/v1/me", "/")).toBe("/api/v1/me");
    expect(() => withAppBasePath("https://example.test/api/v1/me", "/revenue-costs/")).toThrow("same-origin");
  });

  it("preserves an explicit streaming upload content type", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      request = init;
      return new Response(null, { status: 204 });
    }));

    await apiFetch("/api/v1/uploads/files/file-id", {
      method: "PATCH",
      headers: { "Content-Type": "application/offset+octet-stream" },
      body: new Blob(["chunk"]),
    });

    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/offset+octet-stream");
  });

  it("defaults string command bodies to JSON", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      request = init;
      return new Response(null, { status: 204 });
    }));

    await apiFetch("/api/v1/commands", { method: "POST", body: JSON.stringify({ ok: true }) });

    expect(new Headers(request?.headers).get("Content-Type")).toBe("application/json");
  });

  it("does not mislabel an untyped binary body as JSON", async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal("document", { cookie: "" });
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => {
      request = init;
      return new Response(null, { status: 204 });
    }));

    await apiFetch("/api/v1/binary", { method: "POST", body: new Blob(["chunk"]) });

    expect(new Headers(request?.headers).has("Content-Type")).toBe(false);
  });
});

describe("web API error classification", () => {
  it("does not abort an active request after a shared 60-second deadline", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("document", { cookie: "" });
    let aborted = false;
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init: RequestInit) => await new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    })));

    void apiFetch("/api/v1/shops/shop-1/workflow").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_001);

    expect(aborted).toBe(false);
  });

  it("matches a structured API error by code", () => {
    const error = new ApiError({ code: "ACCOUNT_NOT_REGISTERED", message: "尚未注册" }, 409);

    expect(isApiErrorCode(error, "ACCOUNT_NOT_REGISTERED")).toBe(true);
    expect(isApiErrorCode(error, "OTP_INVALID")).toBe(false);
    expect(isApiErrorCode(new Error("尚未注册"), "ACCOUNT_NOT_REGISTERED")).toBe(false);
  });
});
