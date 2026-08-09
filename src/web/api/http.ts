import type { ApiEnvelope, ApiProblem } from "./types";

export class ApiError extends Error {
  readonly code: string;
  readonly field: string | undefined;
  readonly requestId: string | undefined;
  readonly status: number;

  constructor(problem: ApiProblem, status: number) {
    super(problem.message);
    this.name = "ApiError";
    this.code = problem.code;
    this.field = problem.field;
    this.requestId = problem.requestId;
    this.status = status;
  }
}

export function isApiErrorCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function csrfToken(): string | undefined {
  return document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("rc_csrf="))?.slice(8);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("X-Request-Id", idempotencyKey());
  if (typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    headers.set("Idempotency-Key", headers.get("Idempotency-Key") ?? idempotencyKey());
    const csrf = csrfToken();
    if (csrf) headers.set("X-CSRF-Token", decodeURIComponent(csrf));
  }

  const response = await fetch(path, { ...init, method, headers, credentials: "include" });
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const payload = contentType.includes("application/json") ? await response.clone().json() : undefined;
    const problem = (payload?.error ?? payload ?? {
      code: "HTTP_ERROR",
      message: response.status === 404 ? "未找到或无权访问该资源" : "请求失败，请稍后重试",
      requestId: response.headers.get("x-request-id") ?? undefined,
    }) as ApiProblem;
    throw new ApiError(problem, response.status);
  }
  return response;
}

export async function apiRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiFetch(path, init);
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : undefined;
  if (response.status === 204) return undefined as T;
  return (payload && "data" in payload ? (payload as ApiEnvelope<T>).data : payload) as T;
}
