import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import { authorizePlatform, requireAllowed } from '../../modules/authorization/index.js';
import type { CatalogService } from '../../modules/catalog/index.js';
import { UuidSchema } from '../../shared/contracts.js';
import { requireIdempotencyKey } from '../idempotency.js';

const ApplicationParams = Type.Object({ applicationId: UuidSchema });
const PriceSchema = Type.Object({
  annualPriceCents: Type.String({ pattern: '^(0|[1-9][0-9]*)$' }),
  effectiveFrom: Type.Optional(Type.String({ format: 'date-time' })),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
type PriceBody = Static<typeof PriceSchema>;
const UpdateApplicationSchema = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 120 }),
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('INACTIVE')]),
  sortOrder: Type.Integer({ minimum: -1000000, maximum: 1000000 }),
  allowedRoles: Type.Array(Type.Literal('ACCOUNTANT'), {
    uniqueItems: true,
    maxItems: 1,
  }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
type UpdateApplicationBody = Static<typeof UpdateApplicationSchema>;

export interface AppRouteOptions {
  readonly catalog: CatalogService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<Actor>;
}

export const appRoutes: FastifyPluginAsync<AppRouteOptions> = async (app, options) => {
  app.get('/api/v1/apps', async (request) => {
    const actor = await options.authenticate(request, false);
    return options.catalog.list(actor.roles.has('ADMIN'));
  });

  app.post<{ Params: { applicationId: string }; Body: PriceBody }>(
    '/api/v1/apps/:applicationId/prices',
    { schema: { params: ApplicationParams, body: PriceSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      requireAllowed(authorizePlatform(actor, 'ADMIN_APPLICATIONS'));
      const key = requireIdempotencyKey(request, '创建价格版本必须提供有效幂等键');
      const id = await options.catalog.createPriceVersion({
        applicationId: request.params.applicationId,
        actorAccountId: actor.accountId,
        requestId: request.id,
        annualPriceCents: request.body.annualPriceCents,
        effectiveFrom: request.body.effectiveFrom ?? new Date().toISOString(),
        reason: request.body.reason,
        idempotencyKey: key,
      });
      return { id };
    },
  );

  app.patch<{ Params: { applicationId: string }; Body: UpdateApplicationBody }>(
    '/api/v1/apps/:applicationId',
    { schema: { params: ApplicationParams, body: UpdateApplicationSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      requireAllowed(authorizePlatform(actor, 'ADMIN_APPLICATIONS'));
      await options.catalog.updateApplication({
        applicationId: request.params.applicationId,
        actorAccountId: actor.accountId,
        requestId: request.id,
        ...request.body,
      });
      return { updated: true };
    },
  );
};
