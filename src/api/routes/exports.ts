import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Actor } from "../../modules/authorization/index.js";
import type { ExportAssumptionInput, PostgresExportService } from "../../modules/exports/postgres.js";
import { UuidSchema } from "../../shared/contracts.js";
import { requireIdempotencyKey } from "../idempotency.js";

const RateStringSchema = Type.String({
  minLength: 1,
  maxLength: 10,
  pattern: "^(?:0|1)(?:\\.\\d{1,8})?$",
});
const NullableRateSchema = Type.Union([Type.Null(), RateStringSchema]);
const ContinentPrefixesSchema = Type.Array(Type.Union([
  Type.Literal("AS"), Type.Literal("EU"), Type.Literal("AF"), Type.Literal("AM"), Type.Literal("OC"),
]), { maxItems: 5, uniqueItems: true });
const ExportAssumptionsSchema = Type.Object({
  profitRate: Type.Optional(NullableRateSchema),
  minimumSalesCostRate: Type.Optional(NullableRateSchema),
  continentPrefixes: Type.Optional(ContinentPrefixesSchema),
}, { additionalProperties: false });
const ExportListQuery = Type.Object({ shopId: UuidSchema });
const ExportParams = Type.Object({ id: UuidSchema });
const ExportDownloadQuery = Type.Object({
  token: Type.String({ minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{43}$" }),
});
const CurrentExportParams = Type.Object({ shopId: UuidSchema });
const CostPreviewQuery = Type.Object({
  profitRate: Type.Optional(Type.String({ maxLength: 10, pattern: "^(?:(?:0|1)(?:\\.\\d{1,8})?)?$" })),
  minimumSalesCostRate: Type.Optional(Type.String({ maxLength: 10, pattern: "^(?:(?:0|1)(?:\\.\\d{1,8})?)?$" })),
}, { additionalProperties: false });
const CreateSnapshotExportSchema = Type.Object({
  shopId: UuidSchema,
  snapshotId: UuidSchema,
  profitRate: Type.Optional(NullableRateSchema),
  minimumSalesCostRate: Type.Optional(NullableRateSchema),
  continentPrefixes: Type.Optional(ContinentPrefixesSchema),
}, { additionalProperties: false });
type ExportAssumptionsBody = Static<typeof ExportAssumptionsSchema>;
type CostPreviewQuerystring = Static<typeof CostPreviewQuery>;
type CreateSnapshotExportBody = Static<typeof CreateSnapshotExportSchema>;

function previewAssumptions(query: CostPreviewQuerystring): ExportAssumptionInput {
  return {
    ...(query.profitRate === undefined ? {} : { profitRate: query.profitRate === "" ? null : query.profitRate }),
    ...(query.minimumSalesCostRate === undefined
      ? {}
      : { minimumSalesCostRate: query.minimumSalesCostRate === "" ? null : query.minimumSalesCostRate }),
  };
}

export interface ExportRouteOptions {
  service: PostgresExportService;
  authenticate(request: FastifyRequest, csrf: boolean): Promise<Actor>;
}

export const exportRoutes: FastifyPluginAsync<ExportRouteOptions> = async (app, options) => {
  app.get<{ Querystring: { shopId: string } }>(
    "/api/v1/exports",
    { schema: { querystring: ExportListQuery } },
    async (request) => options.service.list(await options.authenticate(request, false), request.query.shopId),
  );
  app.get<{ Params: { shopId: string }; Querystring: CostPreviewQuerystring }>(
    "/api/v1/shops/:shopId/exports/cost-preview",
    { schema: { params: CurrentExportParams, querystring: CostPreviewQuery } },
    async (request) => options.service.previewCostAccounting(
      await options.authenticate(request, false),
      request.params.shopId,
      previewAssumptions(request.query),
    ),
  );
  app.post<{ Params: { shopId: string }; Body: ExportAssumptionsBody }>(
    "/api/v1/shops/:shopId/exports/current",
    { schema: { params: CurrentExportParams, body: ExportAssumptionsSchema } },
    async (request) => options.service.createCurrent(
      await options.authenticate(request, true),
      request.params.shopId,
      requireIdempotencyKey(request),
      request.id,
      request.body,
    ),
  );
  app.post<{ Body: CreateSnapshotExportBody }>(
    "/api/v1/exports",
    { schema: { body: CreateSnapshotExportSchema } },
    async (request) => options.service.create(
      await options.authenticate(request, true),
      request.body.shopId,
      request.body.snapshotId,
      requireIdempotencyKey(request),
      request.id,
      request.body,
    ),
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/exports/:id/cancel",
    { schema: { params: ExportParams } },
    async (request, reply) => {
      await options.service.cancel(await options.authenticate(request, true), request.params.id, request.id);
      return reply.code(204).send();
    },
  );
  app.post<{ Params: { id: string } }>(
    "/api/v1/exports/:id/download-token",
    { schema: { params: ExportParams } },
    async (request) => {
      const token = await options.service.createDownloadToken(await options.authenticate(request, true), request.params.id, request.id);
      return { url: `/api/v1/exports/${request.params.id}/download?token=${encodeURIComponent(token)}` };
    },
  );
  app.get<{ Params: { id: string }; Querystring: { token: string } }>(
    "/api/v1/exports/:id/download",
    { schema: { params: ExportParams, querystring: ExportDownloadQuery } },
    async (request, reply) => {
      const file = await options.service.download(await options.authenticate(request, false), request.params.id, request.query.token, request.id);
      return reply
        .header("Content-Type", file.mediaType)
        .header("Content-Disposition", `attachment; filename="sales-cost.${file.fileName.endsWith(".zip") ? "zip" : "xlsx"}"; filename*=UTF-8''${encodeURIComponent(file.fileName)}`)
        .header("Content-Length", file.contentLength)
        .header("X-Accel-Buffering", "no")
        .send(file.stream);
    },
  );
};
