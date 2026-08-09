import { randomUUID } from 'node:crypto';
import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../authorization/index.js';
import { normalizePhone } from '../auth/crypto.js';
import { AppError } from '../../shared/errors.js';

export interface EnterpriseView {
  readonly id: string;
  readonly createdByAccountId: string;
  readonly name: string;
  readonly unifiedSocialCreditCode?: string;
  readonly profileComplete: boolean;
  readonly memberCount: number;
  readonly companyCount: number;
  readonly notStartedCount: number;
  readonly submittedCount: number;
  readonly wallet: { readonly id: string; readonly balanceCents: string; readonly status: string };
  readonly canEditName: boolean;
  readonly canEditCreditCode: boolean;
}

export interface EnterpriseMemberView {
  readonly id: string;
  readonly accountId?: string;
  readonly displayName?: string;
  readonly phoneMasked: string;
  readonly avatarId?: number;
  readonly status: 'PENDING' | 'ACTIVE' | 'REVOKED';
  readonly createdAt: string;
}

function normalizeName(value: string): { name: string; normalized: string } {
  const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if ([...name].length < 1 || [...name].length > 120) {
    throw new AppError('ENTERPRISE_NAME_INVALID', '企业名称必须为 1 至 120 个字符', 400, 'name');
  }
  return { name, normalized: name.toLocaleLowerCase('zh-CN') };
}

function normalizeCreditCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[0-9A-Z]{18}$/u.test(code)) {
    throw new AppError('ENTERPRISE_CREDIT_CODE_INVALID', '统一社会信用代码必须为 18 位数字或大写字母', 400, 'unifiedSocialCreditCode');
  }
  return code;
}

function maskPhone(value: string): string {
  return value.length <= 7 ? '***' : `${value.slice(0, 4)}****${value.slice(-4)}`;
}

export class EnterpriseService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
  ) {}

  async list(actor: Actor): Promise<readonly EnterpriseView[]> {
    const result = await this.reader.query<{
      id: string; name: string; unified_social_credit_code: string | null; created_by_account_id: string;
      member_count: string; company_count: string; submitted_count: string;
      wallet_id: string; balance_cents: string; wallet_status: string;
    }>(
      `SELECT e.id,e.name,e.unified_social_credit_code,e.created_by_account_id,
              (SELECT count(*) FROM enterprise_member em WHERE em.enterprise_id=e.id AND em.status='ACTIVE')::text member_count,
              (SELECT count(*) FROM shop s WHERE s.enterprise_id=e.id AND s.status<>'PURGED')::text company_count,
              (SELECT count(*) FROM shop s
                JOIN shop_current_published_snapshot scps ON scps.shop_id=s.id
               WHERE s.enterprise_id=e.id AND s.status<>'PURGED'
                 AND NOT EXISTS (
                   SELECT 1 FROM dataset_slice ds
                    WHERE ds.shop_id=s.id AND ds.current_version_id IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM published_snapshot_slice pss
                         WHERE pss.published_snapshot_id=scps.published_snapshot_id
                           AND pss.dataset_slice_id=ds.id AND pss.dataset_version_id=ds.current_version_id
                      )
                 ))::text submitted_count,
              w.id wallet_id,w.balance_cents::text,w.status wallet_status
         FROM enterprise e
         JOIN wallet_account w ON w.enterprise_id=e.id
        WHERE $2 OR EXISTS(
          SELECT 1 FROM enterprise_member em
           WHERE em.enterprise_id=e.id AND em.account_id=$1 AND em.status='ACTIVE'
        )
        ORDER BY e.updated_at DESC,e.created_at DESC,e.id DESC`,
      [actor.accountId, actor.roles.has('ADMIN')],
    );
    return result.rows.map((row) => {
      const companyCount = Number(row.company_count);
      const submittedCount = Number(row.submitted_count);
      return {
        id: row.id,
        createdByAccountId: row.created_by_account_id,
        name: row.name,
        ...(row.unified_social_credit_code ? { unifiedSocialCreditCode: row.unified_social_credit_code } : {}),
        profileComplete: Boolean(row.unified_social_credit_code),
        memberCount: Number(row.member_count),
        companyCount,
        submittedCount,
        notStartedCount: companyCount - submittedCount,
        wallet: { id: row.wallet_id, balanceCents: row.balance_cents, status: row.wallet_status },
        canEditName: actor.roles.has('ADMIN') || row.created_by_account_id === actor.accountId,
        canEditCreditCode: actor.roles.has('ADMIN'),
      };
    });
  }

  async create(input: { readonly actor: Actor; readonly name: string; readonly unifiedSocialCreditCode: string; readonly requestId: string }): Promise<EnterpriseView> {
    if (!input.actor.roles.has('ACCOUNTANT')) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    const names = normalizeName(input.name);
    const code = normalizeCreditCode(input.unifiedSocialCreditCode);
    const id = randomUUID();
    await this.transactions.transaction(async (client) => {
      try {
        await client.query(
          `INSERT INTO enterprise(id,name,normalized_name,unified_social_credit_code,created_by_account_id)
           VALUES($1,$2,$3,$4,$5)`,
          [id, names.name, names.normalized, code, input.actor.accountId],
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          throw new AppError('ENTERPRISE_CREDIT_CODE_CONFLICT', '该统一社会信用代码已存在', 409, 'unifiedSocialCreditCode');
        }
        throw error;
      }
      const account = await client.query<{ phone_e164: string; display_name: string | null }>(
        'SELECT phone_e164,display_name FROM account WHERE id=$1 FOR SHARE',
        [input.actor.accountId],
      );
      const row = account.rows[0];
      if (!row) throw new AppError('ACCOUNT_NOT_FOUND', '账户不存在', 404);
      await client.query(
        `INSERT INTO enterprise_member
          (enterprise_id,account_id,phone_e164,display_name,status,invited_by_account_id,activated_at)
         VALUES($1,$2,$3,$4,'ACTIVE',$2,clock_timestamp())`,
        [id, input.actor.accountId, row.phone_e164, row.display_name],
      );
      await client.query('INSERT INTO wallet_account(enterprise_id) VALUES($1)', [id]);
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId, actorRoles: [...input.actor.roles], objectType: 'enterprise', objectId: id,
        action: 'ENTERPRISE_CREATED', result: 'SUCCEEDED', reason: null, requestId: input.requestId,
        before: null, after: { name: names.name, unifiedSocialCreditCode: code },
      });
    });
    const nextActor = { ...input.actor, enterpriseIds: new Set([...(input.actor.enterpriseIds ?? []), id]) };
    const created = (await this.list(nextActor)).find((enterprise) => enterprise.id === id);
    if (!created) throw new Error('企业创建后无法读取');
    return created;
  }

  async updateProfile(input: { readonly actor: Actor; readonly enterpriseId: string; readonly name?: string; readonly unifiedSocialCreditCode?: string; readonly requestId: string }): Promise<void> {
    this.requireAccess(input.actor, input.enterpriseId);
    if (input.name === undefined && input.unifiedSocialCreditCode === undefined) {
      throw new AppError('ENTERPRISE_PROFILE_EMPTY', '至少提交一个需要修改的字段', 400);
    }
    const names = input.name === undefined ? undefined : normalizeName(input.name);
    const code = input.unifiedSocialCreditCode === undefined ? undefined : normalizeCreditCode(input.unifiedSocialCreditCode);
    await this.transactions.transaction(async (client) => {
      const current = await client.query<{ name: string; unified_social_credit_code: string | null; created_by_account_id: string }>(
        'SELECT name,unified_social_credit_code,created_by_account_id FROM enterprise WHERE id=$1 FOR UPDATE', [input.enterpriseId],
      );
      const before = current.rows[0];
      if (!before) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      const isAdmin = input.actor.roles.has('ADMIN');
      if (names && !isAdmin && before.created_by_account_id !== input.actor.accountId) {
        throw new AppError('ENTERPRISE_NAME_FORBIDDEN', '只有企业创建者或管理员可以修改企业名称', 403, 'name');
      }
      if (code !== undefined && !isAdmin) {
        throw new AppError('ENTERPRISE_CREDIT_CODE_FORBIDDEN', '统一社会信用代码只能由管理员修改', 403, 'unifiedSocialCreditCode');
      }
      try {
        await client.query(
          `UPDATE enterprise SET name=COALESCE($2,name),normalized_name=COALESCE($3,normalized_name),
                 unified_social_credit_code=COALESCE($4,unified_social_credit_code),updated_at=clock_timestamp()
            WHERE id=$1`,
          [input.enterpriseId, names?.name ?? null, names?.normalized ?? null, code ?? null],
        );
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === '23505') {
          throw new AppError('ENTERPRISE_CREDIT_CODE_CONFLICT', '该统一社会信用代码已存在', 409, 'unifiedSocialCreditCode');
        }
        throw error;
      }
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId, actorRoles: [...input.actor.roles], objectType: 'enterprise', objectId: input.enterpriseId,
        action: 'ENTERPRISE_PROFILE_UPDATED', result: 'SUCCEEDED', reason: null, requestId: input.requestId,
        before: { name: before.name, unifiedSocialCreditCode: before.unified_social_credit_code },
        after: {
          name: names?.name ?? before.name,
          unifiedSocialCreditCode: code ?? before.unified_social_credit_code,
        },
      });
    });
  }

  async listMembers(actor: Actor, enterpriseId: string): Promise<readonly EnterpriseMemberView[]> {
    this.requireAccess(actor, enterpriseId);
    const result = await this.reader.query<{
      id: string; account_id: string | null; display_name: string | null; phone_e164: string;
      status: EnterpriseMemberView['status']; created_at: Date; avatar_id: number | null;
    }>(
      `SELECT em.id,em.account_id,COALESCE(em.display_name,a.display_name) display_name,
              em.phone_e164,em.status,em.created_at,a.avatar_id
         FROM enterprise_member em LEFT JOIN account a ON a.id=em.account_id
        WHERE em.enterprise_id=$1 AND em.status<>'REVOKED'
        ORDER BY CASE em.status WHEN 'ACTIVE' THEN 0 ELSE 1 END,em.created_at,em.id`,
      [enterpriseId],
    );
    return result.rows.map((row) => ({
      id: row.id, ...(row.account_id ? { accountId: row.account_id } : {}),
      ...(row.display_name ? { displayName: row.display_name } : {}), phoneMasked: maskPhone(row.phone_e164),
      ...(row.avatar_id ? { avatarId: row.avatar_id } : {}), status: row.status, createdAt: row.created_at.toISOString(),
    }));
  }

  async addMember(input: { readonly actor: Actor; readonly enterpriseId: string; readonly phone: string; readonly displayName?: string; readonly requestId: string }): Promise<EnterpriseMemberView> {
    this.requireAccess(input.actor, input.enterpriseId);
    const phoneE164 = normalizePhone(input.phone);
    const displayName = input.displayName?.trim().normalize('NFC') || null;
    if (displayName && [...displayName].length > 80) throw new AppError('MEMBER_NAME_INVALID', '姓名最多为 80 个字符', 400, 'displayName');
    const memberId = await this.transactions.transaction(async (client) => {
      const enterprise = await client.query<{ unified_social_credit_code: string | null }>(
        'SELECT unified_social_credit_code FROM enterprise WHERE id=$1 FOR UPDATE', [input.enterpriseId],
      );
      if (!enterprise.rows[0]?.unified_social_credit_code) throw new AppError('ENTERPRISE_PROFILE_INCOMPLETE', '请先补齐企业名称和统一社会信用代码', 409);
      const existing = await client.query<{ id: string; status: EnterpriseMemberView['status'] }>(
        `SELECT id,status FROM enterprise_member WHERE enterprise_id=$1 AND phone_e164=$2 ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.enterpriseId, phoneE164],
      );
      if (existing.rows[0] && existing.rows[0].status !== 'REVOKED') return existing.rows[0].id;
      const account = await client.query<{ id: string }>('SELECT id FROM account WHERE phone_e164=$1 AND registered_at IS NOT NULL', [phoneE164]);
      const accountId = account.rows[0]?.id ?? null;
      const status = accountId ? 'ACTIVE' : 'PENDING';
      const result = existing.rows[0]
        ? await client.query<{ id: string }>(
            `UPDATE enterprise_member SET account_id=$2,display_name=$3,status=$4,
                    authorization_epoch=authorization_epoch+1,activated_at=CASE WHEN $4='ACTIVE' THEN clock_timestamp() ELSE NULL END,
                    revoked_at=NULL,revoke_reason=NULL,invited_by_account_id=$5,updated_at=clock_timestamp()
              WHERE id=$1 RETURNING id`,
            [existing.rows[0].id, accountId, displayName, status, input.actor.accountId],
          )
        : await client.query<{ id: string }>(
            `INSERT INTO enterprise_member
              (enterprise_id,account_id,phone_e164,display_name,status,invited_by_account_id,activated_at)
             VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $5='ACTIVE' THEN clock_timestamp() ELSE NULL END)
             RETURNING id`,
            [input.enterpriseId, accountId, phoneE164, displayName, status, input.actor.accountId],
          );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('新增做账员失败');
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId, actorRoles: [...input.actor.roles], objectType: 'enterprise_member', objectId: id,
        action: 'ENTERPRISE_MEMBER_ADDED', result: 'SUCCEEDED', reason: null, requestId: input.requestId,
        before: null, after: { enterpriseId: input.enterpriseId, status },
      });
      return id;
    });
    const member = (await this.listMembers(input.actor, input.enterpriseId)).find((item) => item.id === memberId);
    if (!member) throw new Error('新增做账员后无法读取');
    return member;
  }

  async removeMember(input: { readonly actor: Actor; readonly enterpriseId: string; readonly memberId: string; readonly reason: string; readonly requestId: string }): Promise<void> {
    this.requireAccess(input.actor, input.enterpriseId);
    const reason = input.reason.trim();
    if (!reason) throw new AppError('REASON_REQUIRED', '删除做账员必须填写原因', 400, 'reason');
    await this.transactions.transaction(async (client) => {
      const member = await client.query<{ id: string; status: EnterpriseMemberView['status'] }>(
        'SELECT id,status FROM enterprise_member WHERE id=$1 AND enterprise_id=$2 FOR UPDATE',
        [input.memberId, input.enterpriseId],
      );
      const row = member.rows[0];
      if (!row || row.status === 'REVOKED') throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      if (row.status === 'ACTIVE') {
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('enterprise-members:' || $1, 0))",
          [input.enterpriseId],
        );
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text count FROM enterprise_member WHERE enterprise_id=$1 AND status='ACTIVE'`,
          [input.enterpriseId],
        );
        if (Number(count.rows[0]?.count ?? 0) <= 1) throw new AppError('ENTERPRISE_LAST_MEMBER', '企业必须至少保留一名有效做账员', 409);
      }
      await client.query(
        `UPDATE enterprise_member SET status='REVOKED',authorization_epoch=authorization_epoch+1,
                revoked_at=clock_timestamp(),revoke_reason=$3,updated_at=clock_timestamp()
          WHERE id=$1 AND enterprise_id=$2`,
        [input.memberId, input.enterpriseId, reason],
      );
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId, actorRoles: [...input.actor.roles], objectType: 'enterprise_member', objectId: input.memberId,
        action: 'ENTERPRISE_MEMBER_REVOKED', result: 'SUCCEEDED', reason, requestId: input.requestId,
        before: { status: row.status }, after: { status: 'REVOKED', enterpriseId: input.enterpriseId },
      });
    });
  }

  private requireAccess(actor: Actor, enterpriseId: string): void {
    if (!actor.roles.has('ADMIN') && !actor.enterpriseIds?.has(enterpriseId)) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    }
  }
}
