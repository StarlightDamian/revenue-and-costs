import { Type, type Static } from '@sinclair/typebox';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import { authorizePlatform, requireAllowed } from '../../modules/authorization/index.js';
import type { IdentityAdminService } from '../../modules/auth/index.js';
import type { WalletService } from '../../modules/wallet/index.js';
import type { PostgresFxService } from '../../modules/fx/index.js';
import { IsoDateSchema, UuidSchema } from '../../shared/contracts.js';
import { AppError } from '../../shared/errors.js';
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
const FxOverrideParams = Type.Object({ overrideId: UuidSchema });
const FxOverrideSchema = Type.Object({
  currency: Type.String({ pattern: '^[A-Za-z]{3}$' }),
  validFrom: IsoDateSchema,
  validTo: IsoDateSchema,
  cnyPerUnit: Type.String({ pattern: '^(?!0(?:\\.0{1,8})?$)(?:0|[1-9][0-9]{0,21})(?:\\.[0-9]{1,8})?$' }),
  sourceReference: Type.String({ minLength: 1, maxLength: 2000, pattern: '\\S' }),
  reason: Type.String({ minLength: 1, maxLength: 1000, pattern: '\\S' }),
});
type StatusBody = Static<typeof StatusSchema>;
type AdminRoleBody = Static<typeof AdminRoleSchema>;
type AdjustmentBody = Static<typeof AdjustmentSchema>;
type FxOverrideBody = Static<typeof FxOverrideSchema>;

async function requireStringFxRate(request: FastifyRequest): Promise<void> {
  const body = request.body as { cnyPerUnit?: unknown } | null;
  if (!body || typeof body.cnyPerUnit !== 'string') {
    throw new AppError('FX_OVERRIDE_RATE_STRING_REQUIRED', '汇率必须使用十进制字符串', 400, 'cnyPerUnit');
  }
}

export interface AdminRouteOptions {
  readonly identity: IdentityAdminService;
  readonly wallet: WalletService;
  readonly fx: Pick<PostgresFxService, 'listOverrides' | 'createOverride' | 'reviseOverride'>;
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

  app.get('/api/v1/admin/fx-overrides', async (request) => {
    const actor = await options.authenticate(request, false);
    requireAllowed(authorizePlatform(actor, 'ADMIN_DATA_GOVERNANCE'));
    const response = await options.fx.listOverrides();
    request.log.info({ event: 'fx_override_listed', rowCount: response.rows.length }, 'Manual FX overrides listed');
    return response;
  });

  app.post<{ Body: FxOverrideBody }>(
    '/api/v1/admin/fx-overrides',
    { schema: { body: FxOverrideSchema }, preValidation: requireStringFxRate },
    async (request, reply) => {
      const actor = await options.authenticate(request, true);
      requireAllowed(authorizePlatform(actor, 'ADMIN_DATA_GOVERNANCE'));
      const response = await options.fx.createOverride({
        actor,
        ...request.body,
        idempotencyKey: requireIdempotencyKey(request, '新增人工汇率必须提供有效幂等键'),
        requestId: request.id,
      });
      request.log.info({
        event: 'fx_override_created',
        currency: response.override.currency,
        validFrom: response.override.validFrom,
        validTo: response.override.validTo,
      }, 'Manual FX override created');
      return reply.code(201).send(response);
    },
  );

  app.post<{ Params: { overrideId: string }; Body: FxOverrideBody }>(
    '/api/v1/admin/fx-overrides/:overrideId/revisions',
    { schema: { params: FxOverrideParams, body: FxOverrideSchema }, preValidation: requireStringFxRate },
    async (request, reply) => {
      const actor = await options.authenticate(request, true);
      requireAllowed(authorizePlatform(actor, 'ADMIN_DATA_GOVERNANCE'));
      const response = await options.fx.reviseOverride(request.params.overrideId, {
        actor,
        ...request.body,
        idempotencyKey: requireIdempotencyKey(request, '修改人工汇率必须提供有效幂等键'),
        requestId: request.id,
      });
      request.log.info({
        event: 'fx_override_revised',
        currency: response.override.currency,
        validFrom: response.override.validFrom,
        validTo: response.override.validTo,
      }, 'Manual FX override revised');
      return reply.code(201).send(response);
    },
  );
};
