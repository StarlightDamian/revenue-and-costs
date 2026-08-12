import { describe, expect, it, vi } from 'vitest';
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../../src/modules/authorization/index.js';
import { IdentityAdminService } from '../../src/modules/auth/admin.js';

describe('IdentityAdminService phone masking', () => {
  it('keeps the Chinese national prefix and last four digits in administrator lists', async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: '10000000-0000-4000-8000-000000000001',
        display_name: '测试用户',
        avatar_id: 24,
        phone_e164: '+8616600000256',
        status: 'ACTIVE',
        roles: ['ACCOUNTANT'],
        created_at: new Date('2026-08-11T00:00:00.000Z'),
        enterprise_count: '1',
        company_count: '2',
      }],
      rowCount: 1,
    }));
    const client = { query } as unknown as SqlClient;
    const transactions: TransactionRunner = { transaction: async (work) => work(client) };
    const effects: TransactionSideEffects = { audit: vi.fn(), outbox: vi.fn() } as never;
    const service = new IdentityAdminService(transactions, client, effects);
    const actor: Actor = {
      accountId: '20000000-0000-4000-8000-000000000002',
      status: 'ACTIVE',
      roles: new Set(['ADMIN']),
      enterpriseIds: new Set(),
    };

    await expect(service.search(actor, '')).resolves.toEqual([
      expect.objectContaining({ phoneMasked: '+86 166****0256' }),
    ]);
  });
});
