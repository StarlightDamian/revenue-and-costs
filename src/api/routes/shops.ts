import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import type { MembershipService } from '../../modules/memberships/index.js';
import type { ShopService } from '../../modules/shops/index.js';
import { UuidSchema } from '../../shared/contracts.js';
import { requireIdempotencyKey } from '../idempotency.js';

const ShopParams = Type.Object({ shopId: UuidSchema });
const MembershipParams = Type.Object({ membershipId: UuidSchema });
const CreateShopSchema = Type.Object({
  enterpriseId: UuidSchema,
  applicationId: UuidSchema,
  name: Type.String({ minLength: 1, maxLength: 120 }),
  startDate: Type.String({ format: 'date' }),
  requestedCloseDate: Type.Optional(Type.String({ format: 'date' })),
  waiverReason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});
const RenewSchema = Type.Object({
  requestedCloseDate: Type.String({ format: 'date' }),
  waiverReason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});
const RenameSchema = Type.Object({ name: Type.String({ minLength: 1, maxLength: 120 }) });
const LifecycleSchema = Type.Object({ reason: Type.Optional(Type.String({ maxLength: 1000 })) });
const BulkTrashSchema = Type.Object({
  shopIds: Type.Array(UuidSchema, { minItems: 1, maxItems: 100, uniqueItems: true }),
  reason: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
});
const InviteSchema = Type.Object({
  phone: Type.String({ pattern: '^\\+[1-9][0-9]{7,14}$' }),
  exportAllowed: Type.Optional(Type.Boolean()),
});
const MembershipExportSchema = Type.Object({
  allowed: Type.Boolean(),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
const RevokeSchema = Type.Object({ reason: Type.String({ minLength: 1, maxLength: 1000 }) });
const AcceptSchema = Type.Object({ token: Type.String({ minLength: 32, maxLength: 200 }) });

type CreateShopBody = Static<typeof CreateShopSchema>;
type RenewBody = Static<typeof RenewSchema>;
type RenameBody = Static<typeof RenameSchema>;
type LifecycleBody = Static<typeof LifecycleSchema>;
type BulkTrashBody = Static<typeof BulkTrashSchema>;
type InviteBody = Static<typeof InviteSchema>;
type MembershipExportBody = Static<typeof MembershipExportSchema>;
type RevokeBody = Static<typeof RevokeSchema>;
type AcceptBody = Static<typeof AcceptSchema>;

export interface ShopRouteOptions {
  readonly shops: ShopService;
  readonly memberships: MembershipService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<Actor>;
}

export const shopRoutes: FastifyPluginAsync<ShopRouteOptions> = async (app, options) => {
  app.get<{ Querystring: { enterpriseId?: string } }>('/api/v1/shops', async (request) =>
    options.shops.listAccessible(await options.authenticate(request, false), request.query.enterpriseId));

  app.post<{ Body: BulkTrashBody }>(
    '/api/v1/shops/bulk-trash',
    { schema: { body: BulkTrashSchema } },
    async (request) => options.shops.bulkTrash({
      actor: await options.authenticate(request, true),
      shopIds: request.body.shopIds,
      reason: request.body.reason,
      idempotencyKey: requireIdempotencyKey(request),
      requestId: request.id,
    }),
  );

  app.get<{ Params: { shopId: string } }>(
    '/api/v1/shops/:shopId/workflow',
    { schema: { params: ShopParams } },
    async (request) => options.shops.getWorkflow(await options.authenticate(request, false), request.params.shopId),
  );

  app.post<{ Body: CreateShopBody }>(
    '/api/v1/shops',
    { schema: { body: CreateShopSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      return options.shops.create({
        actor,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id,
        ...request.body,
      });
    },
  );

  app.post<{ Params: { shopId: string }; Body: RenewBody }>(
    '/api/v1/shops/:shopId/renew',
    { schema: { params: ShopParams, body: RenewSchema } },
    async (request) =>
      options.shops.renew({
        actor: await options.authenticate(request, true),
        shopId: request.params.shopId,
        idempotencyKey: requireIdempotencyKey(request),
        requestId: request.id,
        ...request.body,
      }),
  );

  app.patch<{ Params: { shopId: string }; Body: RenameBody }>(
    '/api/v1/shops/:shopId/name',
    { schema: { params: ShopParams, body: RenameSchema } },
    async (request) =>
      options.shops.rename({
        actor: await options.authenticate(request, true),
        shopId: request.params.shopId,
        name: request.body.name,
        requestId: request.id,
      }),
  );

  for (const action of ['trash', 'restore', 'purge'] as const) {
    app.post<{ Params: { shopId: string }; Body: LifecycleBody }>(
      `/api/v1/shops/:shopId/${action}`,
      { schema: { params: ShopParams, body: LifecycleSchema } },
      async (request) =>
        options.shops.changeLifecycle({
          actor: await options.authenticate(request, true),
          shopId: request.params.shopId,
          action: action.toUpperCase() as 'TRASH' | 'RESTORE' | 'PURGE',
          ...(request.body.reason ? { reason: request.body.reason } : {}),
          requestId: request.id,
        }),
    );
  }

  app.get<{ Params: { shopId: string } }>(
    '/api/v1/shops/:shopId/members',
    { schema: { params: ShopParams } },
    async (request) => options.memberships.list(await options.authenticate(request, false), request.params.shopId),
  );

  app.post<{ Params: { shopId: string }; Body: InviteBody }>(
    '/api/v1/shops/:shopId/invitations',
    { schema: { params: ShopParams, body: InviteSchema } },
    async (request) => {
      const key = requireIdempotencyKey(request);
      return options.memberships.invite({
        actor: await options.authenticate(request, true),
        shopId: request.params.shopId,
        requestId: request.id,
        idempotencyKey: key,
        ...request.body,
      });
    },
  );

  app.post<{ Body: AcceptBody }>(
    '/api/v1/shops/invitations/accept',
    { schema: { body: AcceptSchema } },
    async (request) =>
      options.memberships.accept({
        actor: await options.authenticate(request, true),
        token: request.body.token,
        requestId: request.id,
      }),
  );

  app.patch<{ Params: { membershipId: string }; Body: MembershipExportBody }>(
    '/api/v1/shops/memberships/:membershipId/export',
    { schema: { params: MembershipParams, body: MembershipExportSchema } },
    async (request) =>
      options.memberships.setExportAllowed({
        actor: await options.authenticate(request, true),
        membershipId: request.params.membershipId,
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
        ...request.body,
      }),
  );

  app.post<{ Params: { membershipId: string }; Body: RevokeBody }>(
    '/api/v1/shops/memberships/:membershipId/revoke',
    { schema: { params: MembershipParams, body: RevokeSchema } },
    async (request) =>
      options.memberships.revoke({
        actor: await options.authenticate(request, true),
        membershipId: request.params.membershipId,
        requestId: request.id,
        idempotencyKey: requireIdempotencyKey(request),
        ...request.body,
      }),
  );
};
