import { Type, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Actor } from '../../modules/authorization/index.js';
import type { PaymentProviderName, PaymentService } from '../../modules/payments/index.js';
import type { WalletService } from '../../modules/wallet/index.js';
import { AppError } from '../../shared/errors.js';
import { requireIdempotencyKey } from '../idempotency.js';

const EnterpriseIdSchema = Type.String({ pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' });
const QuoteSchema = Type.Object({ enterpriseId: EnterpriseIdSchema, creditAmountCents: Type.String({ pattern: '^[1-9][0-9]*$' }) });
const CreateSchema = Type.Object({
  enterpriseId: EnterpriseIdSchema,
  provider: Type.Union([Type.Literal('WECHAT'), Type.Literal('ALIPAY'), Type.Literal('SANDBOX')]),
  creditAmountCents: Type.String({ pattern: '^[1-9][0-9]*$' }),
});

export interface PaymentRouteOptions {
  readonly service: PaymentService;
  readonly wallet: WalletService;
  authenticate(request: FastifyRequest, requireCsrf: boolean): Promise<Actor>;
}

function parseJsonBody<T>(raw: unknown, schema: TSchema): T {
  if (!(raw instanceof Uint8Array)) throw new AppError('RAW_BODY_REQUIRED', '请求正文格式无效', 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new AppError('BODY_INVALID', '请求正文不是有效 JSON', 400);
  }
  if (!Value.Check(schema, parsed)) throw new AppError('BODY_INVALID', '请求字段无效', 400);
  return parsed as T;
}

export const paymentRoutes: FastifyPluginAsync<PaymentRouteOptions> = async (app, options) => {
  // 支付路由在独立插件作用域内保留 JSON 原始字节；回调验签前不会 JSON.parse。
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer', bodyLimit: 1024 * 1024 },
    async (_request: FastifyRequest, body: Buffer) => body,
  );

  app.get<{ Querystring: { enterpriseId: string } }>('/api/v1/payments/ledger', async (request) => {
    const actor = await options.authenticate(request, false);
    const wallet = await options.wallet.getEnterpriseForActor(actor, request.query.enterpriseId);
    return options.wallet.listWalletEntries(wallet.walletId);
  });

  app.post<{ Body: Buffer }>('/api/v1/payments/quote', async (request) => {
    const actor = await options.authenticate(request, true);
    const body = parseJsonBody<{ enterpriseId: string; creditAmountCents: string }>(request.body, QuoteSchema);
    await options.wallet.getEnterpriseForActor(actor, body.enterpriseId, true);
    return options.service.quote(body.creditAmountCents);
  });

  app.post<{ Body: Buffer }>('/api/v1/payments/orders', async (request) => {
    const actor = await options.authenticate(request, true);
    const body = parseJsonBody<{ enterpriseId: string; provider: PaymentProviderName; creditAmountCents: string }>(request.body, CreateSchema);
    const wallet = await options.wallet.getEnterpriseForActor(actor, body.enterpriseId, true);
    const idempotencyKey = requireIdempotencyKey(request);
    return options.service.createOrder({ walletId: wallet.walletId, accountId: actor.accountId, idempotencyKey, provider: body.provider, creditAmountCents: body.creditAmountCents });
  });

  app.post<{ Body: Buffer }>('/api/v1/payments/sandbox/orders', async (request) => {
    const actor = await options.authenticate(request, true);
    const body = parseJsonBody<{ enterpriseId: string; creditAmountCents: string }>(request.body, QuoteSchema);
    const wallet = await options.wallet.getEnterpriseForActor(actor, body.enterpriseId, true);
    const key = requireIdempotencyKey(request);
    return options.service.createSandboxRecharge({
      walletId: wallet.walletId,
      accountId: actor.accountId,
      creditAmountCents: body.creditAmountCents,
      idempotencyKey: key,
      requestId: request.id,
    });
  });

  app.post<{ Body: Buffer; Params: { provider: string } }>(
    '/api/v1/payments/callback/:provider',
    { config: { logBody: false } },
    async (request) => {
      const provider = request.params.provider.toUpperCase();
      if (!['WECHAT', 'ALIPAY', 'SANDBOX'].includes(provider)) {
        throw new AppError('PROVIDER_NOT_FOUND', '支付渠道不存在', 404);
      }
      if (!(request.body instanceof Uint8Array)) throw new AppError('RAW_BODY_REQUIRED', '支付回调必须保留原始字节', 400);
      const headers = Object.fromEntries(
        Object.entries(request.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value]),
      );
      return options.service.handleRawCallback({
        provider: provider as PaymentProviderName,
        rawBody: request.body,
        headers,
        requestId: request.id,
      });
    },
  );
};
