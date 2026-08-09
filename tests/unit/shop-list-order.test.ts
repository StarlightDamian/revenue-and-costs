import { describe, expect, it, vi } from 'vitest';
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../../src/modules/authorization/index.js';
import { ShopService } from '../../src/modules/shops/service.js';

const actor: Actor = {
  accountId: '10000000-0000-4000-8000-000000000001',
  status: 'ACTIVE',
  roles: new Set(['ACCOUNTANT']),
};

describe('ShopService list ordering', () => {
  it('orders accessible shops by latest shop operation with deterministic tie-breakers', async () => {
    const transactionClient = {
      query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    } as unknown as SqlClient;
    const transactions: TransactionRunner = {
      transaction: async (work) => work(transactionClient),
    };
    const readerQuery = vi.fn(async (...args: [string, unknown?]) => {
      void args;
      return { rows: [], rowCount: 0 };
    });
    const reader = { query: readerQuery } as unknown as SqlClient;
    const effects: TransactionSideEffects = { async audit() {}, async outbox() {} };
    const service = new ShopService(transactions, reader, effects);

    await service.listAccessible(actor);

    const sql = String(readerQuery.mock.calls[0]?.[0]).replace(/\s+/gu, ' ');
    expect(sql).toContain(
      'ORDER BY accessible.updated_at DESC, accessible.created_at DESC, accessible.id DESC',
    );
  });
});
