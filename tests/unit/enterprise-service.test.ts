import { describe, expect, it, vi } from 'vitest';
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../../src/modules/authorization/index.js';
import { EnterpriseService } from '../../src/modules/enterprises/service.js';

const accountId = '10000000-0000-4000-8000-000000000001';
const enterpriseId = '20000000-0000-4000-8000-000000000002';
const memberId = '30000000-0000-4000-8000-000000000003';
const actor: Actor = {
  accountId,
  status: 'ACTIVE',
  roles: new Set(['ACCOUNTANT']),
  enterpriseIds: new Set([enterpriseId]),
};

function serviceFor(query: ReturnType<typeof vi.fn>) {
  const client = { query } as unknown as SqlClient;
  const transactions: TransactionRunner = { transaction: async (work) => work(client) };
  const effects: TransactionSideEffects = { audit: vi.fn(async () => undefined), outbox: vi.fn(async () => undefined) };
  return { service: new EnterpriseService(transactions, client, effects), effects };
}

describe('EnterpriseService', () => {
  it('creates a free enterprise with its first active accountant and wallet', async () => {
    let createdId = '';
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      if (sql.includes('INSERT INTO enterprise(')) {
        createdId = String(parameters?.[0]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT phone_e164,display_name FROM account')) {
        return { rows: [{ phone_e164: '+8613800000000', display_name: null }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO enterprise_member')) return { rows: [], rowCount: 1 };
      if (sql.includes('INSERT INTO wallet_account')) return { rows: [], rowCount: 1 };
      if (sql.includes('SELECT e.id,e.name')) {
        return { rows: [{
          id: createdId, name: '玉荣国际', unified_social_credit_code: '91310000TEST000001',
          created_by_account_id: accountId,
          member_count: '1', company_count: '0', submitted_count: '0',
          wallet_id: '40000000-0000-4000-8000-000000000004', balance_cents: '0', wallet_status: 'ACTIVE',
        }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service, effects } = serviceFor(query);

    const created = await service.create({
      actor,
      name: '  玉荣国际  ',
      unifiedSocialCreditCode: '91310000test000001',
      requestId: 'enterprise-create',
    });

    expect(created).toMatchObject({ name: '玉荣国际', profileComplete: true, memberCount: 1, companyCount: 0, createdByAccountId: accountId, canEditName: true, canEditCreditCode: false });
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO wallet_account'))).toBe(true);
    expect(effects.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ENTERPRISE_CREATED' }));
  });

  it('keeps an unregistered invited phone as a non-expiring pending member', async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes('SELECT unified_social_credit_code FROM enterprise')) {
        return { rows: [{ unified_social_credit_code: '91310000TEST000001' }], rowCount: 1 };
      }
      if (sql.includes('SELECT id,status FROM enterprise_member')) return { rows: [], rowCount: 0 };
      if (sql.includes('SELECT id FROM account')) return { rows: [], rowCount: 0 };
      if (sql.includes('INSERT INTO enterprise_member')) return { rows: [{ id: memberId }], rowCount: 1 };
      if (sql.includes('FROM enterprise_member em LEFT JOIN account')) {
        return { rows: [{
          id: memberId, account_id: null, display_name: '小陈', phone_e164: '+8613900001234',
          status: 'PENDING', created_at: new Date('2026-08-04T00:00:00Z'), avatar_id: null,
        }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service } = serviceFor(query);

    await expect(service.addMember({
      actor,
      enterpriseId,
      phone: '+8613900001234',
      displayName: '小陈',
      requestId: 'member-add',
    })).resolves.toEqual({
      id: memberId,
      displayName: '小陈',
      phoneMasked: '+86 139****1234',
      status: 'PENDING',
      createdAt: '2026-08-04T00:00:00.000Z',
    });
  });

  it('prevents removing the last active accountant under the enterprise lock', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT id,status FROM enterprise_member')) return { rows: [{ id: memberId, status: 'ACTIVE' }], rowCount: 1 };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
      if (sql.includes("count(*)::text count FROM enterprise_member")) return { rows: [{ count: '1' }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service } = serviceFor(query);

    await expect(service.removeMember({
      actor,
      enterpriseId,
      memberId,
      reason: '离职',
      requestId: 'member-remove',
    })).rejects.toMatchObject({ code: 'ENTERPRISE_LAST_MEMBER', statusCode: 409 });
    expect(query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE enterprise_member'))).toBe(false);
  });

  it('returns 404 for a cross-enterprise member request before touching storage', async () => {
    const query = vi.fn();
    const { service } = serviceFor(query);

    await expect(service.listMembers(actor, '20000000-0000-4000-8000-000000000099'))
      .rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    expect(query).not.toHaveBeenCalled();
  });

  it('allows the active enterprise creator to change only the name', async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes('SELECT name,unified_social_credit_code,created_by_account_id')) return { rows: [{ name: '旧名称', unified_social_credit_code: '91310000TEST000001', created_by_account_id: accountId }], rowCount: 1 };
      if (sql.startsWith('UPDATE enterprise')) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const { service, effects } = serviceFor(query);
    await expect(service.updateProfile({ actor, enterpriseId, name: '新名称', requestId: 'rename' })).resolves.toBeUndefined();
    expect(query.mock.calls[1]?.[1]).toEqual([enterpriseId, '新名称', '新名称', null]);
    expect(effects.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'ENTERPRISE_PROFILE_UPDATED', before: { name: '旧名称', unifiedSocialCreditCode: '91310000TEST000001' }, after: { name: '新名称', unifiedSocialCreditCode: '91310000TEST000001' } }));
  });

  it('rejects a creator credit-code change but permits an administrator', async () => {
    const row = { name: '企业', unified_social_credit_code: '91310000TEST000001', created_by_account_id: accountId };
    const creatorQuery = vi.fn(async (sql: string) => sql.includes('SELECT name,unified_social_credit_code,created_by_account_id') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 1 });
    await expect(serviceFor(creatorQuery).service.updateProfile({ actor, enterpriseId, unifiedSocialCreditCode: '91310000TEST000002', requestId: 'credit-denied' }))
      .rejects.toMatchObject({ code: 'ENTERPRISE_CREDIT_CODE_FORBIDDEN', statusCode: 403 });
    expect(creatorQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE enterprise'))).toBe(false);

    const adminActor: Actor = { ...actor, roles: new Set(['ADMIN']), enterpriseIds: new Set() };
    const adminQuery = vi.fn(async (sql: string) => sql.includes('SELECT name,unified_social_credit_code,created_by_account_id') ? { rows: [row], rowCount: 1 } : { rows: [], rowCount: 1 });
    await expect(serviceFor(adminQuery).service.updateProfile({ actor: adminActor, enterpriseId, unifiedSocialCreditCode: '91310000TEST000002', requestId: 'credit-admin' })).resolves.toBeUndefined();
    expect(adminQuery.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE enterprise'))).toBe(true);
  });
});
