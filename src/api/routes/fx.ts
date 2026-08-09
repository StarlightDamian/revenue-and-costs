import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync } from "fastify";
import { IsoDateSchema } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors";

const BatchRowSchema = Type.Object({
  input: Type.String(),
  fromCurrency: Type.String({ pattern: "^[A-Za-z]{3}$" }),
  toCurrency: Type.String({ pattern: "^[A-Za-z]{3}$" }),
});

const BatchBodySchema = Type.Object({ rows: Type.Array(BatchRowSchema, { maxItems: 10000 }) });
const HistoryQuerySchema = Type.Object({
  from: Type.Optional(IsoDateSchema),
  to: Type.Optional(IsoDateSchema),
  currencies: Type.Optional(Type.String({
    pattern: "^[A-Za-z]{3}(?:\\s*,\\s*[A-Za-z]{3})*$",
    maxLength: 399,
  })),
});
type BatchBody = Static<typeof BatchBodySchema>;

export interface FxRouteServices {
  history(input: { from?: string; to?: string; currencies?: readonly string[] }): Promise<{ rows: readonly unknown[] }>;
  status(): Promise<{ status: string; coverageFrom?: string | null; coverageTo?: string | null; quoteCount?: number; lastSucceededAt?: string | null }>;
  convertBatch(rows: BatchBody["rows"]): Promise<unknown>;
}

export interface FxRouteOptions {
  services: FxRouteServices;
  syncEnabled?: boolean;
}

export const fxRoutes: FastifyPluginAsync<FxRouteOptions> = async (app, options) => {
  app.get<{ Querystring: { from?: string; to?: string; currencies?: string } }>(
    "/api/v1/fx/history",
    { schema: { querystring: HistoryQuerySchema } },
    async (request) => {
      const input = {
        ...(request.query.from ? { from: request.query.from } : {}),
        ...(request.query.to ? { to: request.query.to } : {}),
        ...(request.query.currencies
          ? { currencies: request.query.currencies.split(",").map((item) => item.trim().toUpperCase()) }
          : {}),
      };
      const result = await options.services.history(input);
      const record = { event: "fx_history_query", ...input, rowCount: result.rows.length };
      if (result.rows.length === 0) request.log.warn(record, "FX history query returned no rows");
      else request.log.info(record, "FX history query completed");
      return result;
    },
  );
  app.get("/api/v1/fx/status", async (request) => {
    const result = await options.services.status();
    const response = { ...result, syncEnabled: options.syncEnabled ?? false };
    const record = { event: "fx_status_read", syncEnabled: response.syncEnabled, quoteCount: response.quoteCount ?? 0, latestStatus: response.status };
    if (!response.syncEnabled || !response.quoteCount) request.log.warn(record, "FX data source requires attention");
    else request.log.info(record, "FX status read");
    return response;
  });
  app.post<{ Body: BatchBody }>(
    "/api/v1/fx/convert-batch",
    { schema: { body: BatchBodySchema } },
    async (request) => {
      if (request.body.rows.length === 0) throw new AppError("EMPTY_FX_BATCH", "请至少输入一行日期", 400, "rows");
      return options.services.convertBatch(request.body.rows);
    },
  );
};
