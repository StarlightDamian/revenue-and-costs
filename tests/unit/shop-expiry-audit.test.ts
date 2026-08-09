import { describe, expect, it, vi } from 'vitest';
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../../src/modules/authorization/index.js';
import { ShopService } from '../../src/modules/shops/service.js';

const actor: Actor = {
  accountId: '10000000-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  roles: new Set(['ACCOUNTANT']),
};

function fixture(expiredRowsByRefresh: ReadonlyArray<ReadonlyArray<{ id: string; close_date: string }>>) {
  const pendingRows = [...expiredRowsByRefresh];
  const transactionQuery = vi.fn(async (sql: string) => {
    if (!sql.includes("UPDATE shop SET status = 'EXPIRED_READONLY'")) {
      throw new Error(`UNEXPECTED_TRANSACTION_QUERY:${sql}`);
    }
    return { rows: [...(pendingRows.shift() ?? [])], rowCount: null };
  });
  const transactionClient = { query: transactionQuery } as unknown as SqlClient;
  let commits = 0;
  const transaction = vi.fn();
  const transactions: TransactionRunner = {
    async transaction<Result>(work: (client: SqlClient) => Promise<Result>): Promise<Result> {
      transaction();
      const result = await work(transactionClient);
      commits += 1;
      return result;
    },
  };
  const readerQuery = vi.fn(async (sql: string) => {
    if (!sql.includes('FROM shop s')) throw new Error(`UNEXPECTED_READER_QUERY:${sql}`);
    return { rows: [], rowCount: 0 };
  });
  const reader = { query: readerQuery } as unknown as SqlClient;
  const audit = vi.fn(async () => undefined);
  const effects: TransactionSideEffects = { audit, async outbox() {} };
  return {
    service: new ShopService(transactions, reader, effects),
    transaction,
    transactionClient,
    transactionQuery,
    audit,
    commits: () => commits,
  };
}

describe('ShopService expiry persistence', () => {
  it('audits every actual ACTIVE to EXPIRED_READONLY transition in the update transaction', async () => {
    const firstShop = '30000000-0000-4000-8000-000000000001';
    const secondShop = '30000000-0000-4000-8000-000000000002';
    const test = fixture([[
      { id: firstShop, close_date: '2026-07-28' },
      { id: secondShop, close_date: '2026-07-27' },
    ]]);

    await expect(test.service.listAccessible(actor)).resolves.toEqual([]);

    expect(test.transaction).toHaveBeenCalledOnce();
    expect(test.transactionQuery.mock.calls[0]?.[0]).toContain(
      "close_date <= timezone('Asia/Shanghai', clock_timestamp())::date",
    );
    expect(test.transactionQuery.mock.calls[0]?.[0]).toContain('RETURNING id, close_date');
    expect(test.audit).toHaveBeenCalledTimes(2);
    expect(test.audit).toHaveBeenNthCalledWith(1, test.transactionClient, {
      actorAccountId: null,
      actorRoles: [],
      objectType: 'shop',
      objectId: firstShop,
      action: 'SHOP_EXPIRED_READONLY',
      result: 'SUCCEEDED',
      reason: null,
      requestId: 'system:shop-expiry-refresh',
      before: { state: 'ACTIVE', closeDate: '2026-07-28' },
      after: { state: 'EXPIRED_READONLY' },
    });
    expect(test.commits()).toBe(1);
  });

  it('does not repeat the audit when the conditional update returns no row', async () => {
    const shopId = '30000000-0000-4000-8000-000000000001';
    const test = fixture([[{ id: shopId, close_date: '2026-07-28' }], []]);

    await test.service.listAccessible(actor);
    await test.service.listAccessible(actor);

    expect(test.audit).toHaveBeenCalledOnce();
    expect(test.transaction).toHaveBeenCalledTimes(2);
    expect(test.commits()).toBe(2);
  });

  it('does not commit the status transition when its audit fails', async () => {
    const shopId = '30000000-0000-4000-8000-000000000001';
    const test = fixture([[{ id: shopId, close_date: '2026-07-28' }]]);
    test.audit.mockRejectedValueOnce(new Error('AUDIT_UNAVAILABLE'));

    await expect(test.service.listAccessible(actor)).rejects.toThrow('AUDIT_UNAVAILABLE');

    expect(test.audit).toHaveBeenCalledOnce();
    expect(test.commits()).toBe(0);
  });
});
