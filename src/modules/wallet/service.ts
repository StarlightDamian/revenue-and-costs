import type { Actor, SqlClient, TransactionRunner, TransactionSideEffects } from '../authorization/index.js';
import { AppError } from '../../shared/errors.js';

export type WalletStatus = 'ACTIVE' | 'RESTRICTED_DEBT' | 'RESTRICTED_RECONCILIATION';

export interface WalletSnapshot {
  readonly walletId: string;
  readonly enterpriseId?: string;
  readonly ownerAccountId?: string;
  readonly balanceCents: string;
  readonly status: WalletStatus;
  readonly version: string;
}

interface WalletRow extends Record<string, unknown> {
  id: string;
  enterprise_id: string | null;
  owner_account_id: string | null;
  balance_cents: string;
  status: WalletStatus;
  version: string;
}

function snapshot(row: WalletRow): WalletSnapshot {
  return {
    walletId: row.id,
    ...(row.enterprise_id ? { enterpriseId: row.enterprise_id } : {}),
    ...(row.owner_account_id ? { ownerAccountId: row.owner_account_id } : {}),
    balanceCents: row.balance_cents,
    status: row.status,
    version: row.version,
  };
}

export async function lockWallet(client: SqlClient, walletId: string): Promise<WalletSnapshot> {
  const result = await client.query<WalletRow>('SELECT * FROM wallet_account WHERE id = $1 FOR UPDATE', [walletId]);
  const row = result.rows[0];
  if (!row) throw new AppError('WALLET_NOT_FOUND', '钱包不存在或无权访问', 404);
  return snapshot(row);
}

export async function appendWalletEntry(
  client: SqlClient,
  input: {
    readonly walletId: string;
    readonly entryType: 'TOP_UP' | 'TOP_UP_REVERSAL' | 'SHOP_CHARGE' | 'ADMIN_ADJUSTMENT' | 'DEBT_SETTLEMENT';
    readonly deltaCents: bigint;
    readonly businessKey: string;
    readonly referenceType: string;
    readonly referenceId: string | null;
    readonly actorAccountId: string | null;
    readonly reason: string | null;
    readonly resolveReconciliation?: boolean;
    readonly allowRestrictedDebit?: boolean;
  },
): Promise<{ readonly ledgerId: string; readonly wallet: WalletSnapshot; readonly duplicate: boolean }> {
  if (input.deltaCents === 0n) throw new AppError('WALLET_AMOUNT_INVALID', '钱包账本金额不能为 0', 400);
  const current = await lockWallet(client, input.walletId);
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM wallet_ledger WHERE wallet_id = $1 AND business_key = $2`,
    [input.walletId, input.businessKey],
  );
  const duplicate = existing.rows[0];
  if (duplicate) return { ledgerId: duplicate.id, wallet: current, duplicate: true };
  if (input.deltaCents < 0n && current.status !== 'ACTIVE' && !input.allowRestrictedDebit) {
    throw new AppError('WALLET_RESTRICTED', '钱包当前限制消费', 409);
  }
  const nextBalance = BigInt(current.balanceCents) + input.deltaCents;
  const nextStatus: WalletStatus = nextBalance < 0n
    ? 'RESTRICTED_DEBT'
    : current.status === 'RESTRICTED_RECONCILIATION' && !input.resolveReconciliation
      ? 'RESTRICTED_RECONCILIATION'
      : 'ACTIVE';
  const updated = await client.query<WalletRow>(
    `UPDATE wallet_account
        SET balance_cents=$2,status=$3,version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 RETURNING *`,
    [input.walletId, nextBalance.toString(), nextStatus],
  );
  const ledger = await client.query<{ id: string }>(
    `INSERT INTO wallet_ledger
      (wallet_id,entry_type,delta_cents,balance_after_cents,business_key,
       reference_type,reference_id,actor_account_id,reason)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [input.walletId, input.entryType, input.deltaCents.toString(), nextBalance.toString(), input.businessKey,
      input.referenceType, input.referenceId, input.actorAccountId, input.reason],
  );
  const row = updated.rows[0];
  const ledgerId = ledger.rows[0]?.id;
  if (!row || !ledgerId) throw new Error('钱包账本写入失败');
  return { ledgerId, wallet: snapshot(row), duplicate: false };
}

export class WalletService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
  ) {}

  async getEnterprise(enterpriseId: string): Promise<WalletSnapshot> {
    const result = await this.reader.query<WalletRow>('SELECT * FROM wallet_account WHERE enterprise_id=$1', [enterpriseId]);
    const row = result.rows[0];
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    return snapshot(row);
  }

  async getEnterpriseForActor(actor: Actor, enterpriseId: string, requireComplete = false): Promise<WalletSnapshot> {
    if (!actor.roles.has('ADMIN') && !actor.enterpriseIds?.has(enterpriseId)) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    }
    const enterprise = await this.reader.query<{ unified_social_credit_code: string | null }>(
      'SELECT unified_social_credit_code FROM enterprise WHERE id=$1',
      [enterpriseId],
    );
    const row = enterprise.rows[0];
    if (!row) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    if (requireComplete && !row.unified_social_credit_code) {
      throw new AppError('ENTERPRISE_PROFILE_INCOMPLETE', '请先补齐企业名称和统一社会信用代码', 409);
    }
    return this.getEnterprise(enterpriseId);
  }

  async getLegacyAccount(accountId: string): Promise<WalletSnapshot | null> {
    const result = await this.reader.query<WalletRow>('SELECT * FROM wallet_account WHERE owner_account_id=$1', [accountId]);
    return result.rows[0] ? snapshot(result.rows[0]) : null;
  }

  async listEnterpriseEntries(enterpriseId: string, limit = 200) {
    const wallet = await this.getEnterprise(enterpriseId);
    return this.listWalletEntries(wallet.walletId, limit);
  }

  async listWalletEntries(walletId: string, limit = 200): Promise<readonly {
    readonly id: string;
    readonly type: string;
    readonly amountCents: string;
    readonly balanceAfterCents: string;
    readonly occurredAt: string;
    readonly reason?: string;
    readonly reference?: {
      readonly type: 'SHOP';
      readonly id: string;
      readonly name?: string;
      readonly status?: 'ACTIVE' | 'EXPIRED_READONLY' | 'TRASHED' | 'PURGED';
    };
  }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new AppError('LEDGER_LIMIT_INVALID', '账本查询条数无效', 400);
    }
    const result = await this.reader.query<{
      id: string;
      entry_type: string;
      delta_cents: string;
      balance_after_cents: string;
      created_at: Date;
      reason: string | null;
      reference_type: string;
      reference_id: string | null;
      reference_name: string | null;
      reference_status: 'ACTIVE' | 'EXPIRED_READONLY' | 'TRASHED' | 'PURGED' | null;
    }>(
      `SELECT wl.id,wl.entry_type,wl.delta_cents,wl.balance_after_cents,wl.created_at,wl.reason,
              wl.reference_type,wl.reference_id,
              CASE WHEN wl.reference_type = 'SHOP' THEN shop.name ELSE NULL END AS reference_name,
              CASE WHEN wl.reference_type = 'SHOP' THEN shop.status ELSE NULL END AS reference_status
         FROM wallet_ledger wl
         JOIN wallet_account wallet ON wallet.id = wl.wallet_id
         LEFT JOIN shop ON wl.reference_type = 'SHOP'
                        AND shop.id = wl.reference_id
                        AND shop.enterprise_id = wallet.enterprise_id
        WHERE wl.wallet_id=$1
        ORDER BY wl.created_at DESC,wl.id DESC LIMIT $2`,
      [walletId, limit],
    );
    return result.rows.map((row) => ({
      id: row.id, type: row.entry_type, amountCents: row.delta_cents,
      balanceAfterCents: row.balance_after_cents, occurredAt: row.created_at.toISOString(),
      ...(row.reason ? { reason: row.reason } : {}),
      ...(row.reference_type === 'SHOP' && row.reference_id && row.reference_name ? {
        reference: {
          type: 'SHOP' as const,
          id: row.reference_id,
          ...(row.reference_name ? { name: row.reference_name } : {}),
          ...(row.reference_status ? { status: row.reference_status } : {}),
        },
      } : {}),
    }));
  }

  async adjustEnterprise(input: {
    readonly enterpriseId: string;
    readonly actorAccountId: string;
    readonly deltaCents: string;
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<WalletSnapshot> {
    if (!input.reason.trim()) throw new AppError('REASON_REQUIRED', '管理员调账必须填写原因', 400, 'reason');
    const delta = BigInt(input.deltaCents);
    return this.transactions.transaction(async (client) => {
      const wallet = await client.query<WalletRow>('SELECT * FROM wallet_account WHERE enterprise_id=$1 FOR UPDATE', [input.enterpriseId]);
      const row = wallet.rows[0];
      if (!row) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      const result = await appendWalletEntry(client, {
        walletId: row.id, entryType: 'ADMIN_ADJUSTMENT', deltaCents: delta,
        businessKey: `admin-adjustment:${input.idempotencyKey}`, referenceType: 'ADMIN_ADJUSTMENT',
        referenceId: null, actorAccountId: input.actorAccountId, reason: input.reason.trim(), resolveReconciliation: true,
      });
      if (!result.duplicate) {
        await this.effects.audit(client, {
          actorAccountId: input.actorAccountId, actorRoles: ['ADMIN'], objectType: 'wallet_account', objectId: row.id,
          action: 'WALLET_ADJUSTED', result: 'SUCCEEDED', reason: input.reason.trim(), requestId: input.requestId,
          before: null, after: { enterpriseId: input.enterpriseId, balanceCents: result.wallet.balanceCents, ledgerId: result.ledgerId },
        });
      }
      return result.wallet;
    });
  }
}
