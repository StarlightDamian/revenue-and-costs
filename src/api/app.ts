import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { AppError } from "../shared/errors";
import type { AppConfig } from "../shared/config";
import { operationalReadiness } from "../modules/operations/readiness";
import { registerCoreRoutes } from "./service-graph.js";
import {
  LOGGER_REDACT_PATHS,
  buildRequestCompletion,
  safeDiagnosticCode,
  safeRequestId,
} from "./request-logging.js";

export interface ApiDependencies {
  config: AppConfig;
  pool: Pool;
  logStream?: { write(message: string): void };
}

export interface HttpProblem {
  readonly code: string;
  readonly message: string;
  readonly statusCode: number;
  readonly field?: string;
}

export function classifyHttpError(error: unknown): HttpProblem {
  if (error instanceof AppError) {
    return {
      code: safeDiagnosticCode(error.code),
      message: error.message,
      statusCode: error.statusCode,
      ...(error.field ? { field: error.field } : {}),
    };
  }
  if (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 600) {
    const rawCode = "code" in error && typeof error.code === "string" ? error.code : error.name.toUpperCase();
    return {
      code: safeDiagnosticCode(rawCode),
      message: error.statusCode >= 500 ? "服务暂时不可用，请稍后重试" : error.message,
      statusCode: error.statusCode,
    };
  }
  if (error instanceof Error && error.name === "ReasonRequiredError") {
    return { code: "REASON_REQUIRED", message: "此操作必须填写原因", statusCode: 400 };
  }
  if (error instanceof Error && /^[A-Z][A-Z0-9_]*(?::[^\r\n]{1,100})?$/u.test(error.message)) {
    const [code] = error.message.split(":", 1) as [string];
    const statusCode = code.endsWith("_NOT_FOUND") || code === "RESOURCE_NOT_FOUND" ? 404
      : code.includes("REQUIRED") || code.includes("INVALID") || code.includes("LIMIT") || code.includes("UNSAFE") ? 400
        : 409;
    return { code, message: "请求无法按当前状态完成", statusCode };
  }
  return { code: "INTERNAL_ERROR", message: "服务器内部错误", statusCode: 500 };
}

export async function createApp(deps: ApiDependencies): Promise<FastifyInstance> {
  interface RequestLogState {
    readonly startedAt: number;
    readonly reply: FastifyReply;
    terminalLogged: boolean;
    problem?: { readonly errorCode: string; readonly error: unknown };
  }
  const requestLogStates = new WeakMap<FastifyRequest, RequestLogState>();
  const app = Fastify({
    logController: new LogController({ disableRequestLogging: true }),
    logger: {
      base: { pid: process.pid },
      level: deps.config.mode === "production" ? "info" : "debug",
      redact: [...LOGGER_REDACT_PATHS],
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      serializers: {
        req(request) {
          return { method: request.method };
        },
      },
    },
    genReqId(request) {
      return safeRequestId(request.headers["x-request-id"]);
    },
  });
  const logCompletion = (
    request: FastifyRequest,
    reply: FastifyReply,
    terminal?: { readonly outcome: "ABORTED" | "TIMED_OUT"; readonly statusCode: number; readonly errorCode: string },
  ): void => {
    const state = requestLogStates.get(request);
    if (!state || state.terminalLogged) return;
    state.terminalLogged = true;
    const record = buildRequestCompletion({
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: terminal?.statusCode ?? reply.statusCode,
      durationMs: performance.now() - state.startedAt,
      ...(terminal ? { outcome: terminal.outcome, errorCode: terminal.errorCode } : {}),
      ...(!terminal && state.problem ? { errorCode: state.problem.errorCode, error: state.problem.error } : {}),
    });
    if (record.outcome === "FAILED" || record.outcome === "TIMED_OUT") request.log.error(record, "http request completed");
    else if (record.outcome === "ABORTED" || record.statusCode === 403 || record.statusCode === 429) request.log.warn(record, "http request completed");
    else request.log.info(record, "http request completed");
    requestLogStates.delete(request);
  };
  app.addHook("onRequest", async (request, reply) => {
    requestLogStates.set(request, { startedAt: performance.now(), reply, terminalLogged: false });
    reply.raw.once("close", () => {
      if (!reply.raw.writableFinished) {
        logCompletion(request, reply, { outcome: "ABORTED", statusCode: 499, errorCode: "CLIENT_ABORTED" });
      }
    });
  });
  app.addHook("onRequestAbort", async (request) => {
    const state = requestLogStates.get(request);
    if (state) logCompletion(request, state.reply, { outcome: "ABORTED", statusCode: 499, errorCode: "CLIENT_ABORTED" });
  });
  app.addHook("onTimeout", async (request, reply) => {
    logCompletion(request, reply, { outcome: "TIMED_OUT", statusCode: 504, errorCode: "REQUEST_TIMEOUT" });
  });
  app.addHook("onResponse", async (request, reply) => {
    logCompletion(request, reply);
  });
  // Fastify plugins inherit the error handler present when they are registered.
  // Install it first so route errors carry the same safe diagnostic contract.
  app.setErrorHandler((error, request, reply) => {
    const problem = classifyHttpError(error);
    const logState = requestLogStates.get(request);
    if (logState && !logState.terminalLogged) logState.problem = { errorCode: problem.code, error };
    return reply.code(problem.statusCode).send({
      code: problem.code,
      message: problem.message,
      requestId: request.id,
      ...(problem.field ? { field: problem.field } : {}),
    });
  });
  await app.register(cookie, { hook: "onRequest" });
  await app.register(helmet, { contentSecurityPolicy: false });

  app.get("/health/live", async () => ({ status: "ok", service: "api", time: new Date().toISOString() }));
  app.get("/health/ready", async (_request, reply) => {
    const checks = await operationalReadiness(deps.config, deps.pool);
    const ready = checks.every((check) => check.status === "ok");
    return reply.code(ready ? 200 : 503).send({ status: ready ? "ok" : "degraded", service: "api", time: new Date().toISOString(), checks });
  });

  await registerCoreRoutes(app, deps.config, deps.pool);
  return app;
}
