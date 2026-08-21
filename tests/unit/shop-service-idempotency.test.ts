import { describe, expect, it, vi } from 'vitest';
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../../src/modules/authorization/index.js';
import { ShopService } from '../../src/modules/shops/service.js';

const admin: Actor = {
  accountId: '10000000-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  roles: new Set(['ADMIN']),
};
const ownerAccountId = '10000000-0000-4000-8000-000000000002';
const enterpriseId = '50000000-0000-4000-8000-000000000005';
const user: Actor = { accountId: ownerAccountId, status: 'ACTIVE', roles: new Set(['ACCOUNTANT']), enterpriseIds: new Set([enterpriseId]) };
const applicationId = '20000000-0000-4000-8000-000000000001';
const shopId = '30000000-0000-4000-8000-000000000001';

const baseCharge = {
  id: shopId,
  application_id: applicationId,
  owner_account_id: ownerAccountId,
  enterprise_id: enterpriseId,
  created_by_account_id: ownerAccountId,
  last_operated_by_account_id: ownerAccountId,
  name: '当前店名',
  original_name: '旗舰 店',
  status: 'ACTIVE',
  start_date: '2026-01-01',
  close_date: '2027-01-01',
  rename_count: 1,
  charge_start_date: '2026-01-01',
  charge_close_date: '2027-01-01',
  supersedes_term_id: null,
  waiver_type: null,
  waiver_reason: null,
} as const;

function serviceFor(prior: Record<string, unknown>) {
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM shop_charge sc')) return { rows: [prior], rowCount: 1 };
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  });
  const client = { query } as unknown as SqlClient;
  const transactions: TransactionRunner = { transaction: async (work) => work(client) };
  const effects: TransactionSideEffects = {
    async audit() {},
    async outbox() {},
  };
  return { service: new ShopService(transactions, client, effects), query };
}

function createInput(overrides: Record<string, unknown> = {}) {
  return {
    actor: user,
    enterpriseId,
    applicationId,
    name: '  旗舰   店  ',
    startDate: '2026-01-01',
    requestedCloseDate: '2027-01-01',
    idempotencyKey: 'shop-idempotency-key',
    requestId: 'request-create',
    ...overrides,
  };
}

describe('ShopService idempotency binding', () => {
  it('maps a duplicate live shop name to an actionable field conflict', async () => {
    const duplicateName = Object.assign(new Error('duplicate shop name'), {
      code: '23505',
      constraint: 'shop_enterprise_live_name_uq',
    });
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes('FROM shop_charge sc')) return { rows: [], rowCount: 0 };
      if (sql.includes('FROM enterprise e JOIN wallet_account')) {
        return { rows: [{ wallet_id: '60000000-0000-4000-8000-000000000006', unified_social_credit_code: '91310000TEST000001' }], rowCount: 1 };
      }
      if (sql.includes('FROM application a')) {
        return { rows: [{ id: '21000000-0000-4000-8000-000000000001', annual_price_cents: '18800' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO shop')) throw duplicateName;
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query } as unknown as SqlClient;
    const transactions: TransactionRunner = { transaction: async (work) => work(client) };
    const effects: TransactionSideEffects = { async audit() {}, async outbox() {} };
    const service = new ShopService(transactions, client, effects);

    await expect(service.create({
      actor: admin,
      enterpriseId,
      applicationId,
      name: '测试6',
      startDate: '2026-08-02',
      requestedCloseDate: '2027-08-02',
      idempotencyKey: 'duplicate-name-key',
      waiverReason: '管理员免费建店测试',
      requestId: 'duplicate-name-request',
    })).rejects.toMatchObject({
      code: 'SHOP_NAME_CONFLICT',
      statusCode: 409,
      field: 'name',
      message: '已有同名店铺（包括回收站），请更换店铺名称',
    });
  });

  it('replays a canonically identical create request after the shop was renamed', async () => {
    const fixture = serviceFor(baseCharge);

    await expect(fixture.service.create(createInput())).resolves.toMatchObject({
      id: shopId,
      name: '当前店名',
    });
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['application', { applicationId: '20000000-0000-4000-8000-000000000009' }],
    ['name', { name: '另一店铺' }],
    ['start date', { startDate: '2025-01-01' }],
    ['close date', { requestedCloseDate: '2028-01-01' }],
  ])('rejects a create replay with a different %s', async (_label, overrides) => {
    const fixture = serviceFor(baseCharge);

    await expect(fixture.service.create(createInput(overrides))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    });
  });

  it('rejects creating a shop for an enterprise the accountant cannot access before idempotency lookup', async () => {
    const fixture = serviceFor(baseCharge);
    await expect(fixture.service.create(createInput({ enterpriseId: '50000000-0000-4000-8000-000000000009' })))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    expect(fixture.query).not.toHaveBeenCalled();
  });

  it('allows an administrator to create without a waiver reason and proceeds to idempotency validation', async () => {
    const fixture = serviceFor(baseCharge);
    await expect(fixture.service.create(createInput({
      actor: admin,
      waiverReason: undefined,
    }))).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
    expect(fixture.query).toHaveBeenCalled();
  });

  it('rejects reusing a create key for renew', async () => {
    const fixture = serviceFor({ ...baseCharge, waiver_type: 'ADMIN_FREE', waiver_reason: '审批通过' });

    await expect(fixture.service.renew({
      actor: admin,
      shopId,
      requestedCloseDate: '2027-01-01',
      idempotencyKey: 'shop-idempotency-key',
      waiverReason: '审批通过',
      requestId: 'request-renew',
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  });

  it('rejects reusing a renew key for create', async () => {
    const fixture = serviceFor({
      ...baseCharge,
      charge_close_date: '2028-01-01',
      supersedes_term_id: '40000000-0000-4000-8000-000000000001',
      waiver_type: 'ADMIN_FREE',
      waiver_reason: '审批通过',
    });

    await expect(fixture.service.create(createInput())).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    });
  });

  it('replays an identical renew request', async () => {
    const fixture = serviceFor({
      ...baseCharge,
      charge_close_date: '2028-01-01',
      supersedes_term_id: '40000000-0000-4000-8000-000000000001',
      waiver_type: 'ADMIN_FREE',
      waiver_reason: '审批通过',
    });

    await expect(fixture.service.renew({
      actor: admin,
      shopId,
      requestedCloseDate: '2028-01-01',
      idempotencyKey: 'shop-idempotency-key',
      waiverReason: ' 审批通过 ',
      requestId: 'request-renew',
    })).resolves.toMatchObject({ id: shopId });
    expect(fixture.query).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['shop', { shopId: '30000000-0000-4000-8000-000000000009' }],
    ['close date', { requestedCloseDate: '2029-01-01' }],
    ['admin waiver', { waiverReason: '另一审批原因' }],
  ])('rejects a renew replay with a different %s', async (_label, overrides) => {
    const fixture = serviceFor({
      ...baseCharge,
      charge_close_date: '2028-01-01',
      supersedes_term_id: '40000000-0000-4000-8000-000000000001',
      waiver_type: 'ADMIN_FREE',
      waiver_reason: '审批通过',
    });

    await expect(fixture.service.renew({
      actor: admin,
      shopId,
      requestedCloseDate: '2028-01-01',
      idempotencyKey: 'shop-idempotency-key',
      waiverReason: '审批通过',
      requestId: 'request-renew',
      ...overrides,
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 });
  });
});
