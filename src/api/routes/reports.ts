import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { AppError } from "../../shared/errors";
import { IsoDateSchema, UuidSchema } from "../../shared/contracts.js";
import type { SnapshotManifest } from "../../modules/publishing";
import type { Actor, ShopCapability } from "../../modules/authorization/index.js";
import { requireIdempotencyKey } from "../idempotency.js";
import { PassThrough } from "node:stream";
import { structuredLog } from "../../shared/structured-logger.js";
import { formatMarketplaceForExport, type ContinentPrefix } from "../../modules/accounting-preferences/index.js";
import { intermediateFileName, writeIntermediateWorkbook } from "../../modules/publishing/intermediate-export.js";
import type { IntermediateFilter, IntermediateReportKind } from "../../shared/intermediate-report.js";

export interface ReportRouteServices {
  getCurrent(shopId: string, filter: ReportFilter): Promise<unknown>;
  getPreview(shopId: string, filter: ReportFilter): Promise<unknown>;
  requestCalculation(shopId: string, input: { actorAccountId: string; idempotencyKey: string }): Promise<unknown>;
  publish(manifest: SnapshotManifest, input: { actorAccountId: string; idempotencyKey: string }): Promise<unknown>;
  getIntermediate(shopId: string, kind: IntermediateReportKind, limit: number, afterId?: string, filter?: IntermediateFilter, calculationRunId?: string, frozenRates?: ReadonlyMap<string, string>): Promise<{ items: Array<Record<string, string>>; nextCursor?: string }>;
  getIntermediateSummary(shopId: string, kind: IntermediateReportKind, filter?: IntermediateFilter): Promise<unknown>;
  getIntermediateExportContext(shopId: string, kind: IntermediateReportKind, filter?: IntermediateFilter): Promise<{ enterpriseName: string; calculationRunId: string; frozenRates: ReadonlyMap<string, string> }>;
}

export interface ReportRouteOptions {
  services: ReportRouteServices;
  authenticate(request: FastifyRequest): Promise<Actor>;
  authorize(actor: Actor, shopId: string, capability: ShopCapability): Promise<void>;
  auditAdminAccess(
    actor: Actor,
    shopId: string,
    view: "PUBLISHED" | "PREVIEW",
    requestId: string,
    filter: ReportFilter,
  ): Promise<void>;
  getContinentPrefixes?(accountId: string): Promise<readonly ContinentPrefix[]>;
}

const ShopParams = Type.Object({ shopId: UuidSchema });
const ReportQuerySchema = Type.Object({
  start: Type.Optional(IsoDateSchema),
  end: Type.Optional(IsoDateSchema),
  marketplace: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: "\\S" })),
});
type ReportQuery = Static<typeof ReportQuerySchema>;
export interface ReportFilter {
  readonly start?: string;
  readonly end?: string;
  readonly marketplace?: string;
}
const PublishBody = Type.Object({
  calculationRunId: UuidSchema,
  slices: Type.Array(Type.Object({
    sliceId: UuidSchema,
    datasetVersionId: UuidSchema,
    disposition: Type.Union([
      Type.Literal("INCLUDED"),
      Type.Literal("INCLUDED_WITH_WARNING"),
      Type.Literal("HARD_EXCLUDED"),
    ]),
  }), { minItems: 1 }),
});
const IntermediateQuery = Type.Object({
  kind: Type.Union([Type.Literal("TRANSACTION"), Type.Literal("SHIPMENT")]),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
  after: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
  marketplaces: Type.Optional(Type.String({ maxLength: 1000 })),
  currencies: Type.Optional(Type.String({ maxLength: 500 })),
  start: Type.Optional(IsoDateSchema),
  end: Type.Optional(IsoDateSchema),
});
const IntermediateExportQuery = Type.Omit(IntermediateQuery, ["limit", "after"]);

type IntermediateQuerystring = Static<typeof IntermediateQuery>;

function codeList(value: string | undefined, field: "marketplaces" | "currencies"): readonly string[] | undefined {
  if (value === undefined) return undefined;
  const values = [...new Set(value.split(",").map((part) => part.trim().toUpperCase()).filter(Boolean))];
  if (values.length > 50 || values.some((item) => !/^[A-Z0-9_-]{1,32}$/u.test(item))) {
    throw new AppError("INTERMEDIATE_FILTER_INVALID", "筛选代码无效", 400, field);
  }
  return values.length ? values : undefined;
}

function intermediateFilter(query: IntermediateQuerystring): IntermediateFilter {
  if (query.start && query.end && query.start > query.end) {
    throw new AppError("REPORT_DATE_RANGE_INVALID", "开始日期不能晚于结束日期", 400, "start");
  }
  const marketplaces = codeList(query.marketplaces, "marketplaces");
  const currencies = codeList(query.currencies, "currencies");
  return {
    ...(marketplaces ? { marketplaces } : {}),
    ...(currencies ? { currencies } : {}),
    ...(query.start ? { start: query.start } : {}),
    ...(query.end ? { end: query.end } : {}),
  };
}

function reportFilter(query: ReportQuery): ReportFilter {
  if (query.start && query.end && query.start > query.end) {
    throw new AppError("REPORT_DATE_RANGE_INVALID", "开始日期不能晚于结束日期", 400, "start");
  }
  return {
    ...(query.start ? { start: query.start } : {}),
    ...(query.end ? { end: query.end } : {}),
    ...(query.marketplace ? { marketplace: query.marketplace.trim() } : {}),
  };
}

export const reportRoutes: FastifyPluginAsync<ReportRouteOptions> = async (app, options) => {
  app.get<{ Params: { shopId: string }; Querystring: IntermediateQuerystring }>(
    "/api/v1/reports/shops/:shopId/intermediate",
    { schema: { params: ShopParams, querystring: IntermediateQuery } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
      return options.services.getIntermediate(request.params.shopId, request.query.kind, request.query.limit ?? 100, request.query.after, intermediateFilter(request.query));
    },
  );
  app.get<{ Params: { shopId: string }; Querystring: IntermediateQuerystring }>(
    "/api/v1/reports/shops/:shopId/intermediate/summary",
    { schema: { params: ShopParams, querystring: IntermediateExportQuery } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
      return options.services.getIntermediateSummary(request.params.shopId, request.query.kind, intermediateFilter(request.query));
    },
  );
  app.get<{ Params: { shopId: string }; Querystring: IntermediateQuerystring }>(
    "/api/v1/reports/shops/:shopId/intermediate/export",
    { schema: { params: ShopParams, querystring: IntermediateExportQuery } },
    async (request, reply) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
      const startedAt = Date.now();
      const filter = intermediateFilter(request.query);
      let context: { enterpriseName: string; calculationRunId: string; frozenRates: ReadonlyMap<string, string> };
      try {
        context = await options.services.getIntermediateExportContext(request.params.shopId, request.query.kind, filter);
      } catch (error) {
        if (error instanceof Error && error.message === "INTERMEDIATE_FX_NOT_FIXED") {
          throw new AppError("INTERMEDIATE_FX_NOT_FIXED", "计算运行缺少唯一冻结汇率，暂不能导出", 409);
        }
        throw error;
      }
      const prefixes = await options.getContinentPrefixes?.(actor.accountId) ?? ["EU"];
      const rows = async function* () {
        let after: string | undefined;
        do {
          const page = await options.services.getIntermediate(request.params.shopId, request.query.kind, 200, after, filter, context.calculationRunId, context.frozenRates);
          for (const item of page.items) yield { ...item, marketplace: formatMarketplaceForExport(item.marketplace ?? "", prefixes) };
          after = page.nextCursor;
        } while (after);
      };
      const stream = new PassThrough();
      void writeIntermediateWorkbook({ output: stream, kind: request.query.kind, enterpriseName: context.enterpriseName, rows: rows() })
        .then((count) => structuredLog("info", "api", "intermediate_report_exported", { reportKind: request.query.kind, rowCount: count, durationMs: Date.now() - startedAt }))
        .catch((error: unknown) => stream.destroy(error instanceof Error ? error : new Error("INTERMEDIATE_EXPORT_FAILED")));
      const fileName = intermediateFileName(request.query.kind, context.enterpriseName);
      return reply.header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
        .header("Content-Disposition", `attachment; filename="intermediate.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
        .send(stream);
    },
  );
  app.get<{ Params: { shopId: string }; Querystring: ReportQuery }>("/api/v1/reports/shops/:shopId/current", { schema: { params: ShopParams, querystring: ReportQuerySchema } }, async (request) => {
    const filter = reportFilter(request.query);
    const actor = await options.authenticate(request);
    await options.authorize(actor, request.params.shopId, "PUBLISHED_RESULT_READ");
    const report = await options.services.getCurrent(request.params.shopId, filter);
    if (actor.roles.has("ADMIN")) {
      await options.auditAdminAccess(actor, request.params.shopId, "PUBLISHED", request.id, filter);
    }
    return report;
  });
  app.get<{ Params: { shopId: string }; Querystring: ReportQuery }>("/api/v1/reports/shops/:shopId/preview", { schema: { params: ShopParams, querystring: ReportQuerySchema } }, async (request) => {
    const filter = reportFilter(request.query);
    const actor = await options.authenticate(request);
    await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
    const report = await options.services.getPreview(request.params.shopId, filter);
    if (actor.roles.has("ADMIN")) {
      await options.auditAdminAccess(actor, request.params.shopId, "PREVIEW", request.id, filter);
    }
    return report;
  });
  app.post<{ Params: { shopId: string } }>("/api/v1/reports/shops/:shopId/runs", { schema: { params: ShopParams } }, async (request) => {
    const actor = await options.authenticate(request);
    await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
    return options.services.requestCalculation(request.params.shopId, {
      actorAccountId: actor.accountId,
      idempotencyKey: requireIdempotencyKey(request),
    });
  });
  app.post<{ Params: { shopId: string }; Body: Omit<SnapshotManifest, "shopId"> }>(
    "/api/v1/reports/shops/:shopId/publish",
    { schema: { params: ShopParams, body: PublishBody } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "RESULT_PUBLISH");
      return options.services.publish({ ...request.body, shopId: request.params.shopId }, {
        actorAccountId: actor.accountId,
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
};
