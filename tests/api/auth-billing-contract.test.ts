import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { meRoutes } from '../../src/api/routes/me.js';
import { appRoutes } from '../../src/api/routes/apps.js';
import { adminRoutes } from '../../src/api/routes/admin.js';
import { paymentRoutes } from '../../src/api/routes/payments.js';
import type { Actor } from '../../src/modules/authorization/index.js';
import {
  PaymentService,
  TemporaryManualPaymentProvider,
  type PaymentRepository,
  type VerifiedPaymentEvent,
} from '../../src/modules/payments/index.js';

const actor: Actor = {
  accountId: '10000000-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  roles: new Set(['ACCOUNTANT']),
  enterpriseIds: new Set(['40000000-0000-4000-8000-000000000004']),
};

describe('身份与计费 HTTP 合约', () => {
  it('/me 返回前端使用的主题、掩码手机号、客户店铺数和字符串钱包', async () => {
    const app = Fastify();
    let displayName = '财务管理员';
    const csrfRequirements: boolean[] = [];
    await app.register(meRoutes, {
      authService: {
        async setTheme() {},
        async setDisplayName(_accountId: string, nextDisplayName: string) {
          displayName = nextDisplayName;
        },
      } as never,
      async authenticate(_request, requireCsrf) {
        csrfRequirements.push(requireCsrf);
        return { actor, isFirstLogin: true };
      },
      async getAccount() {
        return {
          id: actor.accountId,
          phoneE164: '+8613800000000',
          displayName,
          registeredAt: new Date('2026-07-28T00:00:00.000Z'),
          avatarId: 24,
          status: 'ACTIVE',
          themeId: 'comfort',
          sessionGeneration: '1',
          roles: actor.roles,
        };
      },
      async getCustomerAccess() {
        return { count: 2, homeShopId: '20000000-0000-4000-8000-000000000002' };
      },
    });
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: actor.accountId,
      displayName: '财务管理员',
      avatarId: 24,
      phoneMasked: '+86 138****0000',
      theme: 'comfort',
      roles: ['ACCOUNTANT'],
      customerShopCount: 2,
      customerHomeShopId: '20000000-0000-4000-8000-000000000002',
      isFirstLogin: true,
    });
    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      payload: { displayName: '更新后的名称' },
    });
    expect(updated.statusCode).toBe(200);
    expect(displayName).toBe('更新后的名称');
    expect(updated.json()).toMatchObject({ displayName: '更新后的名称', phoneMasked: '+86 138****0000' });
    const emojiName = '😀'.repeat(80);
    const emojiUpdated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me/profile',
      payload: { displayName: emojiName },
    });
    expect(emojiUpdated.statusCode).toBe(200);
    expect(displayName).toBe(emojiName);
    expect(csrfRequirements).toEqual([false, true, true]);
    await app.close();
  });

  it('充值报价、账本与受控实付使用同一分单位合约', async () => {
    const applied: VerifiedPaymentEvent[] = [];
    let createdOrders = 0;
    const repository: PaymentRepository = {
      async createOrder() {
        createdOrders += 1;
        return { id: '20000000-0000-4000-8000-000000000002', status: 'CREATED', duplicate: false };
      },
      async markOrderPending() {},
      async applyVerifiedEvent(input) {
        applied.push(input.event);
        return {
          eventId: 'event-1',
          orderId: input.event.internalOrderId,
          status: 'PROCESSED',
          walletBalanceCents: '1000000',
        };
      },
    };
    const service = new PaymentService(repository, [new TemporaryManualPaymentProvider('merchant', Buffer.alloc(32, 8))]);
    const app = Fastify();
    await app.register(paymentRoutes, {
      service,
      wallet: {
        async getEnterpriseForActor() {
          return { walletId: '50000000-0000-4000-8000-000000000005', enterpriseId: '40000000-0000-4000-8000-000000000004', balanceCents: '0', status: 'ACTIVE', version: '1' };
        },
        async listWalletEntries() {
          return [
            {
              id: '1',
              type: 'TOP_UP',
              amountCents: '1000000',
              balanceAfterCents: '1000000',
              occurredAt: '2026-07-28T00:00:00.000Z',
            },
          ];
        },
      } as never,
      async authenticate() {
        return actor;
      },
    });
    const quote = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/quote',
      payload: { enterpriseId: '40000000-0000-4000-8000-000000000004', creditAmountCents: '1000000' },
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toEqual({
      creditAmountCents: '1000000',
      payableAmountCents: '1000000',
      discountBasisPoints: '10000',
    });
    const belowMinimum = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/quote',
      payload: { enterpriseId: '40000000-0000-4000-8000-000000000004', creditAmountCents: '9999' },
    });
    expect(belowMinimum.statusCode).toBe(400);

    const ledger = await app.inject({ method: 'GET', url: '/api/v1/payments/ledger?enterpriseId=40000000-0000-4000-8000-000000000004' });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()[0]).toMatchObject({ amountCents: '1000000' });

    const genericLocalOrder = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/orders',
      headers: { 'idempotency-key': 'generic-local-test-key' },
      payload: {
        enterpriseId: '40000000-0000-4000-8000-000000000004',
        provider: 'SANDBOX',
        creditAmountCents: '1000000',
      },
    });
    expect(genericLocalOrder.statusCode).toBe(400);
    expect(createdOrders).toBe(0);

    const disabledSandbox = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/sandbox/orders',
      headers: { 'idempotency-key': 'sandbox-test-key' },
      payload: { enterpriseId: '40000000-0000-4000-8000-000000000004', creditAmountCents: '1000000' },
    });
    expect(disabledSandbox.statusCode).toBe(503);
    expect(createdOrders).toBe(0);

    const manual = await app.inject({
      method: 'POST',
      url: '/api/v1/payments/manual/orders',
      headers: { 'idempotency-key': 'manual-test-key' },
      payload: { enterpriseId: '40000000-0000-4000-8000-000000000004', creditAmountCents: '1000000' },
    });
    expect(manual.statusCode).toBe(200);
    expect(manual.json()).toMatchObject({ status: 'PAID', walletBalanceCents: '1000000' });
    expect(createdOrders).toBe(1);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ amountCents: '1000000', currency: 'CNY' });
    await app.close();
  });

  it('应用管理返回并更新服务端角色策略，而不是前端硬编码', async () => {
    const updates: unknown[] = [];
    const admin: Actor = { ...actor, roles: new Set(['ADMIN']) };
    const app = Fastify();
    await app.register(appRoutes, {
      catalog: {
        async list() {
          return [{
            id: '30000000-0000-4000-8000-000000000003',
            code: 'amazon-sales-cost',
            name: '亚马逊销售成本',
            status: 'ACTIVE',
            sortOrder: 10,
            allowedRoles: ['ACCOUNTANT'],
            currentPrice: null,
          }];
        },
        async updateApplication(input: unknown) {
          updates.push(input);
        },
      } as never,
      async authenticate() {
        return admin;
      },
    });
    const listed = await app.inject({ method: 'GET', url: '/api/v1/apps' });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0]).toMatchObject({ allowedRoles: ['ACCOUNTANT'] });

    const updated = await app.inject({
      method: 'PATCH',
      url: '/api/v1/apps/30000000-0000-4000-8000-000000000003',
      payload: {
        name: '亚马逊销售成本',
        status: 'ACTIVE',
        sortOrder: 10,
        allowedRoles: [],
        reason: '暂停普通用户创建权限',
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(updates[0]).toMatchObject({ allowedRoles: [] });
    await app.close();
  });

  it('管理员可按目标账户读取账本并以整数分调账', async () => {
    const adjustments: unknown[] = [];
    const admin: Actor = { ...actor, roles: new Set(['ADMIN']) };
    const app = Fastify();
    await app.register(adminRoutes, {
      identity: {} as never,
      fx: {} as never,
      wallet: {
        async listEnterpriseEntries(enterpriseId: string) {
          return [{
            id: '4',
            type: 'ADMIN_ADJUSTMENT',
            amountCents: '125',
            balanceAfterCents: '125',
            occurredAt: '2026-07-28T00:00:00.000Z',
            reason: enterpriseId,
          }];
        },
        async adjustEnterprise(input: unknown) {
          adjustments.push(input);
          return { accountId: actor.accountId, balanceCents: '125', status: 'ACTIVE', version: '1' };
        },
      } as never,
      async authenticate() {
        return admin;
      },
    });
    const ledger = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/enterprises/40000000-0000-4000-8000-000000000004/wallet-ledger`,
    });
    expect(ledger.statusCode).toBe(200);
    expect(ledger.json()[0]).toMatchObject({ amountCents: '125', reason: '40000000-0000-4000-8000-000000000004' });

    const adjusted = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/enterprises/40000000-0000-4000-8000-000000000004/wallet-adjustments`,
      headers: { 'idempotency-key': 'admin-adjustment-test' },
      payload: { deltaCents: '125', reason: '人工核对后补录' },
    });
    expect(adjusted.statusCode).toBe(200);
    expect(adjustments[0]).toMatchObject({ enterpriseId: '40000000-0000-4000-8000-000000000004', deltaCents: '125' });
    const missingKey = await app.inject({
      method: 'POST',
      url: `/api/v1/admin/enterprises/40000000-0000-4000-8000-000000000004/wallet-adjustments`,
      payload: { deltaCents: '125', reason: '人工核对后补录' },
    });
    expect(missingKey.statusCode).toBe(400);
    await app.close();
  });
});
