import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Actor } from "../../modules/authorization/index.js";
import {
  normalizeAccountingPreferences,
  type AccountingPreferencesService,
} from "../../modules/accounting-preferences/index.js";
import { AppError } from "../../shared/errors.js";

const OptionalRateSchema = Type.Union([
  Type.Null(),
  Type.String({ minLength: 1, maxLength: 10, pattern: "^(?:0|1)(?:\\.\\d{1,8})?$" }),
]);
const AccountingPreferencesSchema = Type.Object({
  profitRate: OptionalRateSchema,
  minimumSalesCostRate: OptionalRateSchema,
  continentPrefixes: Type.Optional(Type.Array(Type.Union([
    Type.Literal("AS"), Type.Literal("EU"), Type.Literal("AF"), Type.Literal("AM"), Type.Literal("OC"),
  ]), { maxItems: 5, uniqueItems: true })),
}, { additionalProperties: false });
type AccountingPreferencesBody = Static<typeof AccountingPreferencesSchema>;

export interface AccountingPreferenceRouteOptions {
  readonly service: AccountingPreferencesService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<Actor>;
}

export const accountingPreferenceRoutes: FastifyPluginAsync<AccountingPreferenceRouteOptions> = async (app, options) => {
  app.get("/api/v1/me/accounting-preferences", async (request) => {
    const actor = await options.authenticate(request, false);
    return options.service.get(actor.accountId);
  });

  app.patch<{ Body: AccountingPreferencesBody }>(
    "/api/v1/me/accounting-preferences",
    { schema: { body: AccountingPreferencesSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      try {
        const current = request.body.continentPrefixes === undefined ? await options.service.get(actor.accountId) : undefined;
        return await options.service.update(actor, normalizeAccountingPreferences({
          ...request.body,
          continentPrefixes: request.body.continentPrefixes ?? current?.continentPrefixes ?? ["EU"],
        }), request.id);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("INVALID_ACCOUNTING_RATE:")) {
          throw new AppError("INVALID_ACCOUNTING_RATE", "比例必须在 0% 到 100% 之间，且最多保留 6 位百分比小数", 400);
        }
        if (error instanceof Error && error.message === "INVALID_CONTINENT_PREFIX") {
          throw new AppError("INVALID_CONTINENT_PREFIX", "大洲前缀无效", 400, "continentPrefixes");
        }
        throw error;
      }
    },
  );
};
