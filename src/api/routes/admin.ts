import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import { authorizePlatform, requireAllowed } from '../../modules/authorization/index.js';
import type { IdentityAdminService } from '../../modules/auth/index.js';
import type { WalletService } from '../../modules/wallet/index.js';
import { UuidSchema } from '../../shared/contracts.js';
import { requireIdempotencyKey } from '../idempotency.js';

const AccountParams = Type.Object({ accountId: UuidSchema });
const EnterpriseParams = Type.Object({ enterpriseId: UuidSchema });
const StatusSchema = Type.Object({
  status: Type.Union([Type.Literal('ACTIVE'), Type.Literal('DISABLED')]),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
const AdminRoleSchema = Type.Object({
  enabled: Type.Boolean(),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
const AdjustmentSchema = Type.Object({
  deltaCents: Type.String({ pattern: '^-?[1-9][0-9]*$' }),
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
});
type StatusBody = Static<typeof StatusSchema>;
type AdminRoleBody = Static<typeof AdminRoleSchema>;
type AdjustmentBody = Static<typeof AdjustmentSchema>;

export interface AdminRouteOptions {
  readonly identity: IdentityAdminService;
  readonly wallet: WalletService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<Actor>;
}

export const adminRoutes: FastifyPluginAsync<AdminRouteOptions> = async (app, options) => {
  app.get<{ Querystring: { q?: string; search?: string } }>('/api/v1/admin/users', async (request) => {
    const actor = await options.authenticate(request, false);
    return options.identity.search(actor, request.query.search ?? request.query.q ?? '');
  });

  app.patch<{ Params: { accountId: string }; Body: StatusBody }>(
    '/api/v1/admin/users/:accountId/status',
    { schema: { params: AccountParams, body: StatusSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      await options.identity.setStatus({
        actor,
        accountId: request.params.accountId,
        requestId: request.id,
        ...request.body,
      });
      return { updated: true };
    },
  );

  app.patch<{ Params: { accountId: string }; Body: AdminRoleBody }>(
    '/api/v1/admin/users/:accountId/admin-role',
    { schema: { params: AccountParams, body: AdminRoleSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      await options.identity.setAdministrator({
        actor,
        accountId: request.params.accountId,
        requestId: request.id,
        ...request.body,
      });
      return { updated: true };
    },
  );

  app.post<{ Params: { enterpriseId: string }; Body: AdjustmentBody }>(
    '/api/v1/admin/enterprises/:enterpriseId/wallet-adjustments',
    { schema: { params: EnterpriseParams, body: AdjustmentSchema } },
    async (request) => {
      const actor = await options.authenticate(request, true);
      requireAllowed(authorizePlatform(actor, 'ADMIN_ACCOUNTANTS'));
      const key = requireIdempotencyKey(request, '管理员调账必须提供有效幂等键');
      return options.wallet.adjustEnterprise({
        actorAccountId: actor.accountId,
        enterpriseId: request.params.enterpriseId,
        idempotencyKey: key,
        requestId: request.id,
        ...request.body,
      });
    },
  );

  app.get<{ Params: { enterpriseId: string } }>(
    '/api/v1/admin/enterprises/:enterpriseId/wallet-ledger',
    { schema: { params: EnterpriseParams } },
    async (request) => {
      const actor = await options.authenticate(request, false);
      requireAllowed(authorizePlatform(actor, 'ADMIN_ACCOUNTANTS'));
      return options.wallet.listEnterpriseEntries(request.params.enterpriseId);
    },
  );
};
