import { randomUUID } from "node:crypto";
import { safeErrorDiagnostic } from "../shared/diagnostics.js";

const UUID_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FALLBACK_REQUEST_ID = /^[0-9]{10,17}-[0-9a-f]{8,32}$/iu;
const SAFE_ROUTE = /^\/[A-Za-z0-9_./:*-]{0,199}$/u;
const SAFE_DIAGNOSTIC_CODE = /^[A-Z0-9_]{2,80}$/u;
const SAFE_METHODS = new Set(["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]);

export const LOGGER_REDACT_PATHS = [
  "req.headers",
  "req.body",
  "req.query",
  "req.params",
  "res.headers.set-cookie",
  "headers",
  "body",
  "query",
  "params",
  "phone",
  "phoneE164",
  "otp",
  "otpCode",
  "challengeId",
  "deviceId",
  "sessionToken",
  "csrfToken",
  "token",
  "signature",
  "rawBody",
  "*.phone",
  "*.phoneE164",
  "*.otp",
  "*.otpCode",
  "*.challengeId",
  "*.deviceId",
  "*.sessionToken",
  "*.csrfToken",
  "*.token",
  "*.signature",
  "*.rawBody",
  "err.message",
  "err.stack",
  "error.message",
  "error.stack",
] as const;

export interface RequestCompletionInput {
  readonly requestId: string;
  readonly method: string;
  readonly route: string | undefined;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly errorCode?: string;
  readonly error?: unknown;
  readonly outcome?: "ABORTED" | "TIMED_OUT";
}

export interface RequestCompletion {
  readonly event: "http_request_completed";
  readonly service: "api";
  readonly requestId: string;
  readonly method: string;
  readonly route: string;
  readonly statusCode: number;
  readonly durationMs: number;
  readonly outcome: "SUCCEEDED" | "REJECTED" | "FAILED" | "ABORTED" | "TIMED_OUT";
  readonly errorCode?: string;
  readonly errorType?: string;
  readonly errorSource?: string;
  readonly errorSystemCode?: string;
  readonly causeType?: string;
  readonly causeSource?: string;
  readonly causeSystemCode?: string;
}

export function safeRequestId(raw: unknown): string {
  return typeof raw === "string" && (UUID_REQUEST_ID.test(raw) || FALLBACK_REQUEST_ID.test(raw))
    ? raw
    : randomUUID();
}

export function safeDiagnosticCode(raw: unknown, fallback = "INTERNAL_ERROR"): string {
  return typeof raw === "string" && SAFE_DIAGNOSTIC_CODE.test(raw) ? raw : fallback;
}

export function buildRequestCompletion(input: RequestCompletionInput): RequestCompletion {
  const statusCode = Number.isInteger(input.statusCode) && input.statusCode >= 100 && input.statusCode <= 599
    ? input.statusCode
    : 500;
  const outcome = input.outcome ?? (statusCode >= 500 ? "FAILED" : statusCode >= 400 ? "REJECTED" : "SUCCEEDED");
  const errorCode = outcome === "SUCCEEDED" ? undefined : safeDiagnosticCode(input.errorCode);
  const details = outcome === "FAILED" ? safeErrorDiagnostic(input.error) : {};
  return {
    event: "http_request_completed",
    service: "api",
    requestId: safeRequestId(input.requestId),
    method: SAFE_METHODS.has(input.method) ? input.method : "OTHER",
    route: input.route && SAFE_ROUTE.test(input.route) ? input.route : "<unmatched>",
    statusCode,
    durationMs: Number.isFinite(input.durationMs) && input.durationMs >= 0 ? Math.round(input.durationMs * 100) / 100 : 0,
    outcome,
    ...(errorCode ? { errorCode } : {}),
    ...details,
  };
}
