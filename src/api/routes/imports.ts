import { Type } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Actor, ShopCapability } from "../../modules/authorization/index.js";
import { parseAccountingPeriodScope } from "../../shared/accounting-period.js";
import { UuidSchema } from "../../shared/contracts.js";
import { requireIdempotencyKey } from "../idempotency.js";

export interface ImportRouteServices {
  getBatch(shopId: string, batchId: string): Promise<unknown>;
  getLatestBatch(shopId: string): Promise<unknown>;
  confirm(shopId: string, batchId: string, input: { actorAccountId: string; idempotencyKey: string }): Promise<unknown>;
  acknowledge(shopId: string, issueId: string, input: { actorAccountId: string; reason: string; confirmations: string; idempotencyKey: string }): Promise<unknown>;
  rollback(shopId: string, versionId: string, input: { actorAccountId: string; reason: string; idempotencyKey: string }): Promise<unknown>;
  getCompleteness(shopId: string, period?: { periodStart?: string; periodEnd?: string }): Promise<unknown>;
}

export interface ImportRouteOptions {
  services: ImportRouteServices;
  authenticate(request: FastifyRequest): Promise<Actor>;
  authorize(actor: Actor, shopId: string, capability: ShopCapability): Promise<void>;
}

const MonthSchema = Type.String({ pattern: "^(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])$" });
const ShopQuery = Type.Object({ shopId: UuidSchema, periodStart: Type.Optional(MonthSchema), periodEnd: Type.Optional(MonthSchema) });
const ShopParams = Type.Object({ shopId: UuidSchema });
const Params = Type.Object({ shopId: UuidSchema, id: UuidSchema });
const ReasonBody = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000 }), confirmations: Type.Optional(Type.String({ pattern: "^[12]$" })) });
const AcknowledgeBody = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 1000 })), confirmations: Type.Optional(Type.String({ pattern: "^[12]$" })) });

export const importRoutes: FastifyPluginAsync<ImportRouteOptions> = async (app, options) => {
  app.get<{ Querystring: { shopId: string; periodStart?: string; periodEnd?: string } }>("/api/v1/imports/completeness", { schema: { querystring: ShopQuery } }, async (request) => {
    const accountingPeriod = parseAccountingPeriodScope({
      ...(request.query.periodStart ? { periodStart: request.query.periodStart } : {}),
      ...(request.query.periodEnd ? { periodEnd: request.query.periodEnd } : {}),
    });
    const actor = await options.authenticate(request);
    await options.authorize(actor, request.query.shopId, "DRAFT_RESULT_READ");
    return options.services.getCompleteness(request.query.shopId, accountingPeriod);
  });
  app.get<{ Params: { shopId: string } }>(
    "/api/v1/imports/shops/:shopId/batches/latest",
    { schema: { params: ShopParams } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
      return options.services.getLatestBatch(request.params.shopId);
    },
  );
  app.get<{ Params: { shopId: string; id: string } }>(
    "/api/v1/imports/shops/:shopId/batches/:id",
    { schema: { params: Params } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "DRAFT_RESULT_READ");
      return options.services.getBatch(request.params.shopId, request.params.id);
    },
  );
  app.post<{ Params: { shopId: string; id: string } }>(
    "/api/v1/imports/shops/:shopId/batches/:id/confirm",
    { schema: { params: Params } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "IMPORT_COMMIT");
      return options.services.confirm(request.params.shopId, request.params.id, {
        actorAccountId: actor.accountId,
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
  app.post<{ Params: { shopId: string; id: string }; Body: { reason?: string; confirmations?: string } }>(
    "/api/v1/imports/shops/:shopId/issues/:id/acknowledge",
    { schema: { params: Params, body: AcknowledgeBody } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "QUALITY_ACKNOWLEDGE");
      return options.services.acknowledge(request.params.shopId, request.params.id, {
        actorAccountId: actor.accountId,
        reason: request.body.reason?.trim() || "未填写",
        confirmations: request.body.confirmations ?? "1",
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
  app.post<{ Params: { shopId: string; id: string }; Body: { reason: string } }>(
    "/api/v1/imports/shops/:shopId/versions/:id/rollback",
    { schema: { params: Params, body: ReasonBody } },
    async (request) => {
      const actor = await options.authenticate(request);
      await options.authorize(actor, request.params.shopId, "DATASET_ROLLBACK");
      return options.services.rollback(request.params.shopId, request.params.id, {
        actorAccountId: actor.accountId,
        reason: request.body.reason,
        idempotencyKey: requireIdempotencyKey(request),
      });
    },
  );
};
