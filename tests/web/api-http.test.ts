import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, isApiErrorCode } from "../../src/web/api/http";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("web API request content types", () => {
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
  it("matches a structured API error by code", () => {
    const error = new ApiError({ code: "ACCOUNT_NOT_REGISTERED", message: "尚未注册" }, 409);

    expect(isApiErrorCode(error, "ACCOUNT_NOT_REGISTERED")).toBe(true);
    expect(isApiErrorCode(error, "OTP_INVALID")).toBe(false);
    expect(isApiErrorCode(new Error("尚未注册"), "ACCOUNT_NOT_REGISTERED")).toBe(false);
  });
});
