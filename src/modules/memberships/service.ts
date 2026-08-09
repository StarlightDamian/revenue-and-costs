import { createHash, createHmac, randomUUID } from 'node:crypto';
import type {
  Actor,
  CustomerMembership,
  SqlClient,
  TransactionRunner,
  TransactionSideEffects,
} from '../authorization/index.js';
import { AuthorizationError, authorizeShop, requireAllowed } from '../authorization/index.js';
import { normalizePhone, tokenDigest } from '../auth/crypto.js';
import { AppError } from '../../shared/errors.js';

interface ShopRow extends Record<string, unknown> {
  id: string;
  enterprise_id: string;
  status: 'ACTIVE' | 'EXPIRED_READONLY' | 'TRASHED' | 'PURGED';
}

interface MembershipRow extends Record<string, unknown> {
  id: string;
  shop_id: string;
  account_id: string;
  status: CustomerMembership['status'];
  export_allowed: boolean;
  authorization_epoch: string;
}

interface InvitationActivationRow extends Record<string, unknown> {
  readonly id: string;
  readonly shop_id: string;
  readonly status: 'PENDING' | 'ACTIVE' | 'REVOKED' | 'EXPIRED';
  readonly export_allowed: boolean;
  readonly invited_by: string;
  readonly expires_at: Date;
}

export interface ShopInvitationResult {
  readonly invitationId: string;
  readonly status: 'PENDING' | 'ACTIVE';
  readonly expiresAt: string;
}

function mapMembership(row: MembershipRow): CustomerMembership {
  return {
    id: row.id,
    shopId: row.shop_id,
    accountId: row.account_id,
    status: row.status,
    exportAllowed: row.export_allowed,
    authorizationEpoch: row.authorization_epoch,
  };
}

/** 后续导出模块必须在同一事务内实现状态失效；下载仍实时检查 membership。 */
export interface MembershipArtifactInvalidator {
  invalidateForMembership(client: SqlClient, membershipId: string, newAuthorizationEpoch: string): Promise<void>;
}

export class MembershipService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
    private readonly invitationSecret: Uint8Array,
    private readonly artifactInvalidator: MembershipArtifactInvalidator,
  ) {}

  async list(actor: Actor, shopId: string): Promise<readonly CustomerMembership[]> {
    const shop = await this.loadShop(this.reader, shopId);
    requireAllowed(
      authorizeShop(actor, { id: shop.id, enterpriseId: shop.enterprise_id, state: shop.status }, null, 'MEMBERSHIP_MANAGE'),
    );
    const result = await this.reader.query<MembershipRow>(
      `SELECT id, shop_id, account_id, status, export_allowed, authorization_epoch
         FROM shop_membership WHERE shop_id = $1 ORDER BY granted_at`,
      [shopId],
    );
    return result.rows.map(mapMembership);
  }

  async invite(input: {
    readonly actor: Actor;
    readonly shopId: string;
    readonly phone: string;
    readonly exportAllowed?: boolean;
    readonly expiresInMs?: number;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<ShopInvitationResult> {
    const phoneE164 = normalizePhone(input.phone);
    const expiresAt = new Date(Date.now() + (input.expiresInMs ?? 72 * 60 * 60_000));
    return this.transactions.transaction(async (client) => {
      const shop = await this.loadShop(client, input.shopId, true);
      requireAllowed(
        authorizeShop(
          input.actor,
          { id: shop.id, enterpriseId: shop.enterprise_id, state: shop.status },
          null,
          'MEMBERSHIP_MANAGE',
        ),
      );
      const expired = await client.query<{ id: string; expires_at: Date }>(
        `UPDATE shop_invitation
            SET status = 'EXPIRED'
          WHERE shop_id = $1 AND invited_phone_e164 = $2
            AND status = 'PENDING' AND expires_at <= clock_timestamp()
          RETURNING id, expires_at`,
        [input.shopId, phoneE164],
      );
      for (const invitation of expired.rows) {
        await this.auditInvitationExpired(client, invitation.id, invitation.expires_at, input.requestId);
      }
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shop-invitation:' || $1 || ':' || $2, 0))",
        [input.actor.accountId, input.idempotencyKey],
      );
      const existing = await client.query<InvitationActivationRow & { invited_phone_e164: string }>(
        `SELECT id, shop_id, invited_phone_e164, status, export_allowed, invited_by, expires_at
           FROM shop_invitation WHERE invited_by = $1 AND idempotency_key = $2`,
        [input.actor.accountId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.shop_id !== input.shopId ||
          prior.invited_phone_e164 !== phoneE164 ||
          prior.export_allowed !== (input.exportAllowed ?? false)
        ) {
          throw new AppError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同客户邀请', 409);
        }
        const activationStatus = prior.status === 'PENDING'
          ? await this.activateForRegisteredCustomer(client, prior, phoneE164, input.requestId)
          : prior.status;
        if (activationStatus !== 'PENDING' && activationStatus !== 'ACTIVE') {
          throw new AppError('INVITATION_STATE_CONFLICT', '客户邀请状态已失效，请重新邀请', 409);
        }
        return {
          invitationId: prior.id,
          status: activationStatus,
          expiresAt: prior.expires_at.toISOString(),
        };
      }
      const invitationId = randomUUID();
      const token = this.invitationToken(invitationId);
      const result = await client.query<{ id: string }>(
        `INSERT INTO shop_invitation
          (id, shop_id, invited_phone_e164, token_digest, export_allowed, invited_by, expires_at, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          invitationId,
          input.shopId,
          phoneE164,
          tokenDigest(token),
          input.exportAllowed ?? false,
          input.actor.accountId,
          expiresAt,
          input.idempotencyKey,
        ],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('创建客户邀请失败');
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop_invitation',
        objectId: id,
        action: 'CUSTOMER_INVITED',
        result: 'SUCCEEDED',
        reason: null,
        requestId: input.requestId,
        before: null,
        after: { shopId: input.shopId, exportAllowed: input.exportAllowed ?? false, expiresAt: expiresAt.toISOString() },
      });
      const status = await this.activateForRegisteredCustomer(client, {
        id,
        shop_id: input.shopId,
        status: 'PENDING',
        export_allowed: input.exportAllowed ?? false,
        invited_by: input.actor.accountId,
        expires_at: expiresAt,
      }, phoneE164, input.requestId);
      return { invitationId: id, status, expiresAt: expiresAt.toISOString() };
    });
  }

  async accept(input: {
    readonly actor: Actor;
    readonly token: string;
    readonly requestId: string;
  }): Promise<CustomerMembership> {
    if (input.actor.status !== 'ACTIVE') {
      throw new AppError('ACCOUNT_ROLE_CONFLICT', '只有有效账号可以激活公司客户授权', 409);
    }
    const result = await this.transactions.transaction(async (client) => {
      const invitation = await client.query<{
        id: string;
        shop_id: string;
        invited_phone_e164: string;
        status: string;
        export_allowed: boolean;
        invited_by: string;
        expires_at: Date;
        account_phone: string;
      }>(
        `SELECT i.*, a.phone_e164 AS account_phone
           FROM shop_invitation i
           JOIN account a ON a.id = $2
          WHERE i.token_digest = $1 FOR UPDATE OF i`,
        [tokenDigest(input.token), input.actor.accountId],
      );
      const row = invitation.rows[0];
      if (!row || row.status !== 'PENDING') {
        return { invalid: true } as const;
      }
      if (row.expires_at.getTime() <= Date.now()) {
        const expired = await client.query<{ id: string; expires_at: Date }>(
          `UPDATE shop_invitation SET status = 'EXPIRED'
            WHERE id = $1 AND status = 'PENDING'
            RETURNING id, expires_at`,
          [row.id],
        );
        const expiredInvitation = expired.rows[0];
        if (expiredInvitation) {
          await this.auditInvitationExpired(client, expiredInvitation.id, expiredInvitation.expires_at, input.requestId);
        }
        return { invalid: true } as const;
      }
      if (row.invited_phone_e164 !== row.account_phone) {
        return { invalid: true } as const;
      }
      const existingMembership = await client.query<{ id: string; authorization_epoch: string }>(
        `SELECT id, authorization_epoch::text
           FROM shop_membership
          WHERE shop_id = $1 AND account_id = $2
          FOR UPDATE`,
        [row.shop_id, input.actor.accountId],
      );
      const membership = await client.query<MembershipRow>(
        `INSERT INTO shop_membership
          (shop_id, account_id, export_allowed, invitation_id, granted_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (shop_id, account_id) DO UPDATE
           SET status = 'ACTIVE', export_allowed = EXCLUDED.export_allowed,
               authorization_epoch = shop_membership.authorization_epoch + 1,
               invitation_id = EXCLUDED.invitation_id, granted_by = EXCLUDED.granted_by,
               granted_at = clock_timestamp(), revoked_at = NULL, revoke_reason = NULL,
               updated_at = clock_timestamp()
         RETURNING id, shop_id, account_id, status, export_allowed, authorization_epoch`,
        [row.shop_id, input.actor.accountId, row.export_allowed, row.id, row.invited_by],
      );
      await client.query(
        `UPDATE shop_invitation SET status = 'ACTIVE', accepted_by = $2, accepted_at = clock_timestamp()
          WHERE id = $1`,
        [row.id, input.actor.accountId],
      );
      const accepted = membership.rows[0];
      if (!accepted) throw new Error('接受客户邀请失败');
      const previousMembership = existingMembership.rows[0];
      if (previousMembership && previousMembership.authorization_epoch !== accepted.authorization_epoch) {
        await this.artifactInvalidator.invalidateForMembership(
          client,
          accepted.id,
          accepted.authorization_epoch,
        );
      }
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop_membership',
        objectId: accepted.id,
        action: 'CUSTOMER_INVITATION_ACCEPTED',
        result: 'SUCCEEDED',
        reason: null,
        requestId: input.requestId,
        before: null,
        after: { shopId: accepted.shop_id, exportAllowed: accepted.export_allowed },
      });
      return { invalid: false, membership: mapMembership(accepted) } as const;
    });
    if (result.invalid) throw new AppError('INVITATION_INVALID', '邀请无效或已过期', 400);
    return result.membership;
  }

  async setExportAllowed(input: {
    readonly actor: Actor;
    readonly membershipId: string;
    readonly allowed: boolean;
    readonly reason: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<CustomerMembership> {
    if (!input.reason.trim()) throw new AppError('REASON_REQUIRED', '变更客户导出权限必须填写原因', 400, 'reason');
    return this.transactions.transaction(async (client) => {
      const requestHash = this.changeRequestHash('EXPORT', input.membershipId, String(input.allowed), input.reason.trim());
      const current = await client.query<MembershipRow & { enterprise_id: string; shop_status: ShopRow['status'] }>(
        `SELECT sm.*, s.enterprise_id, s.status AS shop_status
           FROM shop_membership sm JOIN shop s ON s.id = sm.shop_id
          WHERE sm.id = $1 FOR UPDATE OF sm, s`,
        [input.membershipId],
      );
      const row = current.rows[0];
      if (!row) throw new AuthorizationError();
      requireAllowed(
        authorizeShop(
          input.actor,
          { id: row.shop_id, enterpriseId: row.enterprise_id, state: row.shop_status },
          null,
          'MEMBERSHIP_MANAGE',
        ),
      );
      const duplicate = await this.readIdempotentChange(
        client,
        input.actor.accountId,
        'membership-export',
        input.idempotencyKey,
        requestHash,
      );
      if (duplicate) return duplicate;
      if (row.status !== 'ACTIVE') {
        throw new AppError('MEMBERSHIP_STATE_CONFLICT', '客户关系不是有效状态', 409);
      }
      if (row.export_allowed === input.allowed) {
        const response = mapMembership(row);
        await this.storeIdempotentChange(
          client,
          input.actor.accountId,
          'membership-export',
          input.idempotencyKey,
          requestHash,
          response,
        );
        return response;
      }
      const updated = await client.query<MembershipRow>(
        `UPDATE shop_membership
            SET export_allowed = $2, authorization_epoch = authorization_epoch + 1,
                updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'ACTIVE'
          RETURNING id, shop_id, account_id, status, export_allowed, authorization_epoch`,
        [row.id, input.allowed],
      );
      const next = updated.rows[0];
      if (!next) throw new AppError('MEMBERSHIP_STATE_CONFLICT', '客户关系发生并发变化', 409);
      if (!input.allowed) await this.artifactInvalidator.invalidateForMembership(client, next.id, next.authorization_epoch);
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop_membership',
        objectId: row.id,
        action: 'CUSTOMER_EXPORT_PERMISSION_CHANGED',
        result: 'SUCCEEDED',
        reason: input.reason.trim(),
        requestId: input.requestId,
        before: { exportAllowed: row.export_allowed, authorizationEpoch: row.authorization_epoch },
        after: { exportAllowed: next.export_allowed, authorizationEpoch: next.authorization_epoch },
      });
      const response = mapMembership(next);
      await this.storeIdempotentChange(
        client,
        input.actor.accountId,
        'membership-export',
        input.idempotencyKey,
        requestHash,
        response,
      );
      return response;
    });
  }

  async revoke(input: {
    readonly actor: Actor;
    readonly membershipId: string;
    readonly reason: string;
    readonly requestId: string;
    readonly idempotencyKey: string;
  }): Promise<CustomerMembership> {
    if (!input.reason.trim()) throw new AppError('REASON_REQUIRED', '撤销客户关系必须填写原因', 400, 'reason');
    return this.transactions.transaction(async (client) => {
      const requestHash = this.changeRequestHash('REVOKE', input.membershipId, '', input.reason.trim());
      const current = await client.query<MembershipRow & { enterprise_id: string; shop_status: ShopRow['status'] }>(
        `SELECT sm.*, s.enterprise_id, s.status AS shop_status
           FROM shop_membership sm JOIN shop s ON s.id = sm.shop_id
          WHERE sm.id = $1 FOR UPDATE OF sm, s`,
        [input.membershipId],
      );
      const row = current.rows[0];
      if (!row) throw new AuthorizationError();
      requireAllowed(
        authorizeShop(
          input.actor,
          { id: row.shop_id, enterpriseId: row.enterprise_id, state: row.shop_status },
          null,
          'MEMBERSHIP_MANAGE',
        ),
      );
      const duplicate = await this.readIdempotentChange(
        client,
        input.actor.accountId,
        'membership-revoke',
        input.idempotencyKey,
        requestHash,
      );
      if (duplicate) return duplicate;
      if (row.status !== 'ACTIVE') {
        const response = mapMembership(row);
        await this.storeIdempotentChange(
          client,
          input.actor.accountId,
          'membership-revoke',
          input.idempotencyKey,
          requestHash,
          response,
        );
        return response;
      }
      const updated = await client.query<MembershipRow>(
        `UPDATE shop_membership
            SET status = 'REVOKED', export_allowed = false,
                authorization_epoch = authorization_epoch + 1,
                revoked_at = clock_timestamp(), revoke_reason = $2,
                updated_at = clock_timestamp()
          WHERE id = $1 AND status = 'ACTIVE'
          RETURNING id, shop_id, account_id, status, export_allowed, authorization_epoch`,
        [row.id, input.reason.trim()],
      );
      const next = updated.rows[0];
      if (!next) throw new AppError('MEMBERSHIP_REVOKE_CONFLICT', '客户撤权并发冲突', 409);
      await this.artifactInvalidator.invalidateForMembership(client, next.id, next.authorization_epoch);
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop_membership',
        objectId: row.id,
        action: 'CUSTOMER_REVOKED',
        result: 'SUCCEEDED',
        reason: input.reason.trim(),
        requestId: input.requestId,
        before: { status: row.status, authorizationEpoch: row.authorization_epoch },
        after: { status: next.status, authorizationEpoch: next.authorization_epoch },
      });
      const response = mapMembership(next);
      await this.storeIdempotentChange(
        client,
        input.actor.accountId,
        'membership-revoke',
        input.idempotencyKey,
        requestHash,
        response,
      );
      return response;
    });
  }

  private async loadShop(client: SqlClient, shopId: string, lock = false): Promise<ShopRow> {
    const result = await client.query<ShopRow>(`SELECT id, enterprise_id, status FROM shop WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [
      shopId,
    ]);
    const row = result.rows[0];
    if (!row) throw new AuthorizationError();
    return row;
  }

  private invitationToken(invitationId: string): string {
    return createHmac('sha256', this.invitationSecret).update(invitationId).digest('base64url');
  }

  private async activateForRegisteredCustomer(
    client: SqlClient,
    invitation: InvitationActivationRow,
    phoneE164: string,
    requestId: string,
  ): Promise<'PENDING' | 'ACTIVE'> {
    const account = await client.query<{
      id: string;
      status: 'ACTIVE' | 'DISABLED';
      role: 'ACCOUNTANT' | 'ADMIN' | null;
    }>(
      `SELECT a.id, a.status, ar.role
         FROM account a
         LEFT JOIN account_role ar ON ar.account_id = a.id
        WHERE a.phone_e164 = $1 AND a.registered_at IS NOT NULL
        FOR UPDATE OF a`,
      [phoneE164],
    );
    const invitee = account.rows[0];
    if (!invitee) return 'PENDING';
    if (invitee.status !== 'ACTIVE') {
      throw new AppError('ACCOUNT_DISABLED', '该账号已停用，无法授权公司', 409);
    }
    if (!invitee.role) {
      throw new AppError('ACCOUNT_ROLE_CONFLICT', '该手机号尚未完成平台注册，暂不能激活客户授权', 409);
    }
    const existingMembership = await client.query<{ id: string; authorization_epoch: string }>(
      `SELECT id, authorization_epoch::text
         FROM shop_membership
        WHERE shop_id = $1 AND account_id = $2
        FOR UPDATE`,
      [invitation.shop_id, invitee.id],
    );
    const membership = await client.query<MembershipRow>(
      `INSERT INTO shop_membership
        (shop_id, account_id, export_allowed, invitation_id, granted_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shop_id, account_id) DO UPDATE
         SET status = 'ACTIVE', export_allowed = EXCLUDED.export_allowed,
             authorization_epoch = shop_membership.authorization_epoch + 1,
             invitation_id = EXCLUDED.invitation_id, granted_by = EXCLUDED.granted_by,
             granted_at = clock_timestamp(), revoked_at = NULL, revoke_reason = NULL,
             updated_at = clock_timestamp()
       RETURNING id, shop_id, account_id, status, export_allowed, authorization_epoch`,
      [invitation.shop_id, invitee.id, invitation.export_allowed, invitation.id, invitation.invited_by],
    );
    const accepted = membership.rows[0];
    if (!accepted) throw new Error('自动激活客户授权失败');
    await client.query(
      `UPDATE shop_invitation
          SET status = 'ACTIVE', accepted_by = $2, accepted_at = clock_timestamp()
        WHERE id = $1 AND status = 'PENDING'`,
      [invitation.id, invitee.id],
    );
    const previous = existingMembership.rows[0];
    if (previous && previous.authorization_epoch !== accepted.authorization_epoch) {
      await this.artifactInvalidator.invalidateForMembership(client, accepted.id, accepted.authorization_epoch);
    }
    await this.effects.audit(client, {
      actorAccountId: invitee.id,
      actorRoles: [invitee.role ?? 'ACCOUNTANT'],
      objectType: 'shop_membership',
      objectId: accepted.id,
      action: 'CUSTOMER_INVITATION_ACCEPTED',
      result: 'SUCCEEDED',
      reason: null,
      requestId,
      before: null,
      after: { shopId: accepted.shop_id, exportAllowed: accepted.export_allowed, automatic: true },
    });
    return 'ACTIVE';
  }

  private async auditInvitationExpired(
    client: SqlClient,
    invitationId: string,
    expiresAt: Date,
    requestId: string,
  ): Promise<void> {
    await this.effects.audit(client, {
      actorAccountId: null,
      actorRoles: [],
      objectType: 'shop_invitation',
      objectId: invitationId,
      action: 'CUSTOMER_INVITATION_EXPIRED',
      result: 'SUCCEEDED',
      reason: null,
      requestId,
      before: { status: 'PENDING', expiresAt: expiresAt.toISOString() },
      after: { status: 'EXPIRED' },
    });
  }

  private changeRequestHash(action: string, membershipId: string, value: string, reason: string): string {
    return createHash('sha256').update(action).update('\0').update(membershipId).update('\0').update(value).update('\0').update(reason).digest('hex');
  }

  private async readIdempotentChange(
    client: SqlClient,
    actorAccountId: string,
    scope: string,
    key: string,
    requestHash: string,
  ): Promise<CustomerMembership | null> {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('idempotency:' || $1 || ':' || $2 || ':' || $3, 0))",
      [actorAccountId, scope, key],
    );
    const result = await client.query<{ request_hash: string; response_body: CustomerMembership | null }>(
      `SELECT request_hash, response_body FROM idempotency_record
        WHERE actor_account_id = $1 AND scope = $2 AND idempotency_key = $3`,
      [actorAccountId, scope, key],
    );
    const prior = result.rows[0];
    if (!prior) return null;
    if (prior.request_hash !== requestHash) {
      throw new AppError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同客户授权操作', 409);
    }
    if (!prior.response_body) throw new Error('幂等操作缺少既有响应');
    return prior.response_body;
  }

  private async storeIdempotentChange(
    client: SqlClient,
    actorAccountId: string,
    scope: string,
    key: string,
    requestHash: string,
    response: CustomerMembership,
  ): Promise<void> {
    await client.query(
      `INSERT INTO idempotency_record
        (actor_account_id, scope, idempotency_key, request_hash, response_status, response_body, expires_at)
       VALUES ($1,$2,$3,$4,200,$5::jsonb,clock_timestamp() + interval '7 days')`,
      [actorAccountId, scope, key, requestHash, JSON.stringify(response)],
    );
  }
}
