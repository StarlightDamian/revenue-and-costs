import { describe, expect, it } from "vitest";
import {
  LOGGER_REDACT_PATHS,
  buildRequestCompletion,
  safeRequestId,
} from "../../src/api/request-logging";

describe("structured request diagnostics", () => {
  it("accepts browser request IDs and replaces untrusted values", () => {
    const requestId = "15210cf7-8b96-4412-8808-4b1f44c962b7";
    expect(safeRequestId(requestId)).toBe(requestId);

    const replaced = safeRequestId("13800000000\r\nforged=true");
    expect(replaced).toMatch(/^[0-9a-f-]{36}$/u);
    expect(replaced).not.toContain("13800000000");
  });

  it("emits an allowlisted terminal event without raw error or request values", () => {
    const cause = Object.assign(new Error("database secret sentinel 13800000000"), { code: "ECONNREFUSED" });
    cause.stack = "Error: database secret sentinel 13800000000\n    at query (D:\\wwwroot\\revenue-and-costs\\src\\modules\\auth\\postgres.ts:241:5)";
    const error = new Error("outer secret sentinel", { cause });
    error.name = "AuthFailure";
    error.stack = "AuthFailure: outer secret sentinel\n    at rejectLogin (D:\\wwwroot\\revenue-and-costs\\src\\modules\\auth\\service.ts:326:13)";

    const record = buildRequestCompletion({
      requestId: "15210cf7-8b96-4412-8808-4b1f44c962b7",
      method: "POST",
      route: "/api/v1/auth/verify",
      statusCode: 503,
      durationMs: 12.345,
      errorCode: "AUTH_AUDIT_UNAVAILABLE",
      error,
    });

    expect(record).toMatchObject({
      event: "http_request_completed",
      service: "api",
      requestId: "15210cf7-8b96-4412-8808-4b1f44c962b7",
      method: "POST",
      route: "/api/v1/auth/verify",
      statusCode: 503,
      durationMs: 12.35,
      outcome: "FAILED",
      errorCode: "AUTH_AUDIT_UNAVAILABLE",
      errorType: "AuthFailure",
      errorSource: "src/modules/auth/service.ts:326:13",
      causeType: "Error",
      causeSystemCode: "ECONNREFUSED",
      causeSource: "src/modules/auth/postgres.ts:241:5",
    });
    const serialized = JSON.stringify(record);
    for (const secret of ["sentinel", "13800000000", "D:\\\\wwwroot", "challengeId", "cookie"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("fails closed for raw URLs, query values and unsupported methods", () => {
    const record = buildRequestCompletion({
      requestId: "15210cf7-8b96-4412-8808-4b1f44c962b7",
      method: "TRACE\r\nphone=13800000000",
      route: "/api/v1/admin/users?search=13800000000",
      statusCode: 409,
      durationMs: Number.NaN,
      errorCode: "account not registered: 13800000000",
    });

    expect(record).toMatchObject({ method: "OTHER", route: "<unmatched>", durationMs: 0, errorCode: "INTERNAL_ERROR" });
    expect(JSON.stringify(record)).not.toContain("13800000000");
  });

  it("keeps a defense-in-depth redact list for accidental structured fields", () => {
    expect(LOGGER_REDACT_PATHS).toEqual(expect.arrayContaining([
      "req.headers",
      "req.body",
      "req.query",
      "req.params",
      "phone",
      "phoneE164",
      "otp",
      "sessionToken",
      "csrfToken",
      "token",
      "signature",
      "err.message",
      "err.stack",
    ]));
  });
});
