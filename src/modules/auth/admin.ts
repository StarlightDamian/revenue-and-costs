import type { Actor, PlatformRole, SqlClient, TransactionRunner, TransactionSideEffects } from '../authorization/index.js';
import { authorizePlatform, requireAllowed } from '../authorization/index.js';
import { AppError } from '../../shared/errors.js';
import { maskPhone } from './crypto.js';

function rethrowIdentityConstraint(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === '23514'
      && 'message' in error && String(error.message).includes('last active administrator')) {
    throw new AppError('LAST_ACTIVE_ADMIN', '不能停用或撤销最后一个有效管理员', 409);
  }
  throw error;
}

export interface ManagedAccount {
  readonly id: string;
  readonly displayName?: string;
  readonly avatarId: number;
  readonly phoneMasked: string;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly roles: readonly PlatformRole[];
  readonly createdAt: string;
  readonly enterpriseCount: number;
  readonly companyCount: number;
}

interface ManagedAccountRow extends Record<string, unknown> {
  id: string;
  display_name: string | null;
  avatar_id: number;
  phone_e164: string;
  status: 'ACTIVE' | 'DISABLED';
  roles: PlatformRole[] | null;
  created_at: Date;
  enterprise_count: string;
  company_count: string;
}

export class IdentityAdminService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
  ) {}

  async search(actor: Actor, query: string): Promise<readonly ManagedAccount[]> {
    requireAllowed(authorizePlatform(actor, 'ADMIN_ACCOUNTANTS'));
    const normalized = query.trim();
    const result = await this.reader.query<ManagedAccountRow>(
      `SELECT a.id, a.display_name, a.avatar_id, a.phone_e164, a.status, a.created_at,
              roles.roles, enterprises.enterprise_count, companies.company_count
         FROM account a
         LEFT JOIN LATERAL (
           SELECT array_agg(ar.role ORDER BY ar.role) AS roles
             FROM account_role ar WHERE ar.account_id = a.id
         ) roles ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::text AS enterprise_count FROM enterprise_member em
            WHERE em.account_id=a.id AND em.status='ACTIVE'
         ) enterprises ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT s.id)::text AS company_count
             FROM enterprise_member em JOIN shop s ON s.enterprise_id=em.enterprise_id
            WHERE em.account_id=a.id AND em.status='ACTIVE' AND s.status<>'PURGED'
         ) companies ON true
        WHERE ($1 = '' OR a.id::text = $1 OR a.phone_e164 LIKE '%' || $1 || '%' OR a.display_name ILIKE '%' || $1 || '%')
        ORDER BY a.created_at DESC LIMIT 100`,
      [normalized],
    );
    return result.rows.map((row) => ({
      id: row.id,
      ...(row.display_name ? { displayName: row.display_name } : {}),
      avatarId: row.avatar_id,
      phoneMasked: maskPhone(row.phone_e164),
      status: row.status,
      roles: row.roles ?? [],
      createdAt: row.created_at.toISOString(),
      enterpriseCount: Number(row.enterprise_count),
      companyCount: Number(row.company_count),
    }));
  }

  async setStatus(input: {
    readonly actor: Actor;
    readonly accountId: string;
    readonly status: 'ACTIVE' | 'DISABLED';
    readonly reason: string;
    readonly requestId: string;
  }): Promise<void> {
    requireAllowed(authorizePlatform(input.actor, 'ADMIN_ACCOUNTANTS'));
    if (!input.reason.trim()) throw new AppError('REASON_REQUIRED', '启用或停用账户必须填写原因', 400, 'reason');
    try {
      await this.transactions.transaction(async (client) => {
      const current = await client.query<{ status: string }>('SELECT status FROM account WHERE id = $1 FOR UPDATE', [input.accountId]);
      const before = current.rows[0];
      if (!before) throw new AppError('ACCOUNT_NOT_FOUND', '账户不存在', 404);
      await client.query(
        `UPDATE account SET status = $2, session_generation = session_generation + 1,
             updated_at = clock_timestamp() WHERE id = $1`,
        [input.accountId, input.status],
      );
      await client.query(
        `UPDATE auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE account_id = $1`,
        [input.accountId],
      );
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'account',
        objectId: input.accountId,
        action: 'ACCOUNT_STATUS_CHANGED',
        result: 'SUCCEEDED',
        reason: input.reason.trim(),
        requestId: input.requestId,
        before,
        after: { status: input.status },
      });
      });
    } catch (error) {
      rethrowIdentityConstraint(error);
    }
  }

  async setAdministrator(input: {
    readonly actor: Actor;
    readonly accountId: string;
    readonly enabled: boolean;
    readonly reason: string;
    readonly requestId: string;
  }): Promise<void> {
    requireAllowed(authorizePlatform(input.actor, 'ADMIN_ACCOUNTANTS'));
    if (!input.reason.trim()) throw new AppError('REASON_REQUIRED', '变更管理员角色必须填写原因', 400, 'reason');
    try {
      await this.transactions.transaction(async (client) => {
      const account = await client.query<{ id: string; role: PlatformRole | null }>(
        `SELECT a.id, ar.role
           FROM account a LEFT JOIN account_role ar ON ar.account_id = a.id
          WHERE a.id = $1 FOR UPDATE OF a`,
        [input.accountId],
      );
      const current = account.rows[0];
      if (!current) throw new AppError('ACCOUNT_NOT_FOUND', '账户不存在', 404);
      if (input.enabled) {
        await client.query('DELETE FROM account_role WHERE account_id = $1', [input.accountId]);
        await client.query(
          `INSERT INTO account_role (account_id, role, granted_by)
           VALUES ($1,'ADMIN',$2)`,
          [input.accountId, input.actor.accountId],
        );
      } else {
        await client.query('DELETE FROM account_role WHERE account_id = $1', [input.accountId]);
        await client.query(
          `INSERT INTO account_role (account_id, role, granted_by)
           VALUES ($1,'ACCOUNTANT',$2)`,
          [input.accountId, input.actor.accountId],
        );
      }
      await client.query(
        `UPDATE account SET session_generation = session_generation + 1,
             updated_at = clock_timestamp() WHERE id = $1`,
        [input.accountId],
      );
      await client.query(
        `UPDATE auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE account_id = $1`,
        [input.accountId],
      );
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'account_role',
        objectId: input.accountId,
        action: input.enabled ? 'ADMIN_GRANTED' : 'ADMIN_REVOKED',
        result: 'SUCCEEDED',
        reason: input.reason.trim(),
        requestId: input.requestId,
        before: { role: current.role },
        after: { role: input.enabled ? 'ADMIN' : 'ACCOUNTANT' },
      });
      });
    } catch (error) {
      rethrowIdentityConstraint(error);
    }
  }
}
