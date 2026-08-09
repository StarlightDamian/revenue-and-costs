import { Type, type Static } from "@sinclair/typebox";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Actor, ShopCapability } from "../../modules/authorization/index.js";
import type { OnboardingGuide, PostgresOnboardingService } from "../../modules/onboarding/index.js";
import { UuidSchema } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";

const GuideSchema = Type.Union([Type.Literal("WORKSPACE"), Type.Literal("SHOP_WORKFLOW")]);
const QuerySchema = Type.Object({ guide: GuideSchema, shopId: Type.Optional(UuidSchema), version: Type.Integer({ minimum: 1, maximum: 1000 }) }, { additionalProperties: false });
const BodySchema = Type.Object({
  guide: GuideSchema,
  shopId: Type.Optional(UuidSchema),
  version: Type.Integer({ minimum: 1, maximum: 1000 }),
  dismissed: Type.Boolean(),
}, { additionalProperties: false });
type Query = Static<typeof QuerySchema>;
type Body = Static<typeof BodySchema>;

function resourceKey(input: { guide: OnboardingGuide; shopId?: string }): string {
  return input.guide === "WORKSPACE" ? "GLOBAL" : input.shopId!;
}

function assertShape(input: { guide: OnboardingGuide; shopId?: string }): void {
  if ((input.guide === "SHOP_WORKFLOW") !== Boolean(input.shopId)) throw new AppError("ONBOARDING_SCOPE_INVALID", "引导范围无效", 400, "shopId");
}

export interface OnboardingRouteOptions {
  readonly service: PostgresOnboardingService;
  authenticate(request: FastifyRequest, csrf: boolean): Promise<Actor>;
  authorize(actor: Actor, shopId: string, capability: ShopCapability): Promise<void>;
}

export const onboardingRoutes: FastifyPluginAsync<OnboardingRouteOptions> = async (app, options) => {
  app.get<{ Querystring: Query }>("/api/v1/me/onboarding", { schema: { querystring: QuerySchema } }, async (request) => {
    const actor = await options.authenticate(request, false); assertShape(request.query);
    if (request.query.shopId) await options.authorize(actor, request.query.shopId, "SHOP_READ");
    return options.service.get(actor.accountId, request.query.guide, resourceKey(request.query), request.query.version);
  });
  app.patch<{ Body: Body }>("/api/v1/me/onboarding", { schema: { body: BodySchema } }, async (request) => {
    const actor = await options.authenticate(request, true); assertShape(request.body);
    if (request.body.shopId) await options.authorize(actor, request.body.shopId, "SHOP_READ");
    return options.service.set(actor.accountId, request.body.guide, resourceKey(request.body), request.body.version, request.body.dismissed);
  });
};
