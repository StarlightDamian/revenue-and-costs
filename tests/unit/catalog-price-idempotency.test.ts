import { describe, expect, it, vi } from 'vitest';
import type { SqlClient, TransactionRunner, TransactionSideEffects } from '../../src/modules/authorization/index.js';
import { CatalogService } from '../../src/modules/catalog/index.js';

const applicationId = '20000000-0000-4000-8000-000000000001';
const actorAccountId = '10000000-0000-4000-8000-000000000001';
const priceId = '30000000-0000-4000-8000-000000000001';

function serviceFor(prior: Record<string, unknown> | null) {
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM application_price_version apv')) {
      return { rows: prior ? [prior] : [], rowCount: prior ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO application_price_version')) return { rows: [{ id: priceId }], rowCount: 1 };
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  });
  const client = { query } as unknown as SqlClient;
  const transactions: TransactionRunner = { transaction: async (work) => work(client) };
  const audit = vi.fn(async () => undefined);
  const effects: TransactionSideEffects = { audit, async outbox() {} };
  return { service: new CatalogService(transactions, client, effects), query, audit };
}

function input(overrides: Partial<Parameters<CatalogService['createPriceVersion']>[0]> = {}) {
  return {
    applicationId,
    annualPriceCents: '2000',
    effectiveFrom: '2026-01-01T08:00:00+08:00',
    actorAccountId,
    reason: ' 年度调价 ',
    requestId: 'request-price',
    idempotencyKey: 'price-idempotency-key',
    ...overrides,
  };
}

const prior = {
  id: priceId,
  application_id: applicationId,
  annual_price_cents: '2000',
  effective_from: new Date('2026-01-01T00:00:00.000Z'),
  reason: '年度调价',
};

describe('CatalogService price idempotency binding', () => {
  it('normalizes the effective instant and reason for an identical replay', async () => {
    const fixture = serviceFor(prior);

    await expect(fixture.service.createPriceVersion(input())).resolves.toBe(priceId);
    expect(fixture.query).toHaveBeenCalledTimes(2);
    expect(fixture.audit).not.toHaveBeenCalled();
  });

  it.each([
    ['effective instant', { effectiveFrom: '2026-01-02T00:00:00.000Z' }],
    ['reason', { reason: '另一调价原因' }],
  ])('rejects a replay with a different %s', async (_label, overrides) => {
    const fixture = serviceFor(prior);

    await expect(fixture.service.createPriceVersion(input(overrides))).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      statusCode: 409,
    });
  });

  it('stores and audits the canonical effective instant and trimmed reason', async () => {
    const fixture = serviceFor(null);

    await expect(fixture.service.createPriceVersion(input())).resolves.toBe(priceId);
    const insert = fixture.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO application_price_version'));
    expect(insert?.[1]).toEqual([
      applicationId,
      '2000',
      '2026-01-01T00:00:00.000Z',
      actorAccountId,
      'price-idempotency-key',
    ]);
    expect(fixture.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      reason: '年度调价',
      after: expect.objectContaining({ effectiveFrom: '2026-01-01T00:00:00.000Z' }),
    }));
  });
});
