import type { FastifyRequest } from "fastify";
import { AppError } from "../shared/errors.js";

export function requireIdempotencyKey(
  request: FastifyRequest,
  message = "缺少有效的幂等键",
): string {
  const value = request.headers["idempotency-key"];
  if (typeof value !== "string" || value.length < 8 || value.length > 200 || !value.trim()) {
    throw new AppError("IDEMPOTENCY_KEY_REQUIRED", message, 400, "Idempotency-Key");
  }
  return value;
}
