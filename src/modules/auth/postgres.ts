import type { PlatformRole, SqlClient, TransactionRunner } from '../authorization/index.js';
import type { AccountRecord, AuthRepository, OtpChallengeRecord, SessionRecord } from './model.js';
import { AppError } from '../../shared/errors.js';

interface AccountRow extends Record<string, unknown> {
  id: string;
  phone_e164: string;
  display_name: string | null;
  registered_at: Date | null;
  avatar_id: number;
  status: 'ACTIVE' | 'DISABLED';
  theme_id: AccountRecord['themeId'];
  session_generation: string;
}

async function hydrateAccount(client: SqlClient, row: AccountRow): Promise<AccountRecord> {
  const [roleResult, enterpriseResult] = await Promise.all([
    client.query<{ role: PlatformRole }>('SELECT role FROM account_role WHERE account_id = $1 ORDER BY role', [row.id]),
    client.query<{ enterprise_id: string }>(
      `SELECT enterprise_id FROM enterprise_member
        WHERE account_id = $1 AND status = 'ACTIVE'
        ORDER BY enterprise_id`,
      [row.id],
    ),
  ]);
  return {
    id: row.id,
    phoneE164: row.phone_e164,
    displayName: row.display_name,
    registeredAt: row.registered_at,
    avatarId: row.avatar_id,
    status: row.status,
    themeId: row.theme_id,
    sessionGeneration: row.session_generation,
    roles: new Set(roleResult.rows.map(({ role }) => role)),
    enterpriseIds: new Set(enterpriseResult.rows.map(({ enterprise_id }) => enterprise_id)),
  };
}

async function activatePendingRelationships(client: SqlClient, row: AccountRow): Promise<void> {
  await client.query(
    `UPDATE enterprise_member pending
        SET status='REVOKED',revoked_at=clock_timestamp(),revoke_reason='手机号换绑后与既有成员关系合并',
            authorization_epoch=pending.authorization_epoch+1,updated_at=clock_timestamp()
       FROM enterprise_member active
      WHERE pending.phone_e164=$1 AND pending.status='PENDING'
        AND active.enterprise_id=pending.enterprise_id AND active.account_id=$2 AND active.status='ACTIVE'`,
    [row.phone_e164, row.id],
  );
  const enterpriseMemberships = await client.query<{ id: string; enterprise_id: string }>(
    `UPDATE enterprise_member
        SET account_id = $2, status = 'ACTIVE', activated_at = clock_timestamp(),
            updated_at = clock_timestamp()
      WHERE phone_e164 = $1 AND status = 'PENDING'
      RETURNING id, enterprise_id`,
    [row.phone_e164, row.id],
  );
  for (const membership of enterpriseMemberships.rows) {
    await client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,metadata)
       VALUES($1,'ENTERPRISE_MEMBER_ACTIVATED','enterprise_member',$2,$3::jsonb)`,
      [row.id, membership.id, JSON.stringify({ enterpriseId: membership.enterprise_id, automatic: true })],
    );
  }

  const invitations = await client.query<{
    id: string; shop_id: string; export_allowed: boolean; invited_by: string;
  }>(
    `SELECT id, shop_id, export_allowed, invited_by
       FROM shop_invitation
      WHERE invited_phone_e164 = $1 AND status = 'PENDING'
        AND expires_at > clock_timestamp()
      ORDER BY created_at FOR UPDATE`,
    [row.phone_e164],
  );
  for (const invitation of invitations.rows) {
    const membership = await client.query<{ id: string }>(
      `INSERT INTO shop_membership
        (shop_id, account_id, export_allowed, invitation_id, granted_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shop_id, account_id) DO UPDATE
         SET status = 'ACTIVE', export_allowed = EXCLUDED.export_allowed,
             authorization_epoch = shop_membership.authorization_epoch + 1,
             invitation_id = EXCLUDED.invitation_id, granted_by = EXCLUDED.granted_by,
             granted_at = clock_timestamp(), revoked_at = NULL, revoke_reason = NULL,
             updated_at = clock_timestamp()
       RETURNING id`,
      [invitation.shop_id, row.id, invitation.export_allowed, invitation.id, invitation.invited_by],
    );
    await client.query(
      `UPDATE shop_invitation SET status='ACTIVE', accepted_by=$2, accepted_at=clock_timestamp()
        WHERE id=$1 AND status='PENDING'`,
      [invitation.id, row.id],
    );
    const membershipId = membership.rows[0]?.id;
    if (!membershipId) throw new Error('自动激活客户授权失败');
    await client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,metadata)
       VALUES($1,'CUSTOMER_INVITATION_ACCEPTED','shop_membership',$2,$3::jsonb)`,
      [row.id, membershipId, JSON.stringify({ shopId: invitation.shop_id, automatic: 'registration' })],
    );
  }
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
  ) {}

  async createOtpChallengeAfterRateCheck(input: Parameters<AuthRepository['createOtpChallengeAfterRateCheck']>[0]): Promise<void> {
    await this.transactions.transaction(async (client) => {
      const lockKeys = [
        `device:${Buffer.from(input.deviceDigest).toString('hex')}`,
        `ip:${Buffer.from(input.ipDigest).toString('hex')}`,
        `phone:${input.phoneE164}:${input.purpose}`,
      ].sort();
      for (const key of lockKeys) {
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
      }
      const rate = await client.query<{ phone_count: string; ip_count: string; device_count: string }>(
        `SELECT
           count(*) FILTER (WHERE phone_e164 = $1 AND purpose = $2) AS phone_count,
           count(*) FILTER (WHERE ip_digest = $3) AS ip_count,
           count(*) FILTER (WHERE device_digest = $4) AS device_count
         FROM otp_challenge
         WHERE created_at >= clock_timestamp() - ($5::bigint * interval '1 millisecond')`,
        [input.phoneE164, input.purpose, input.ipDigest, input.deviceDigest, input.limits.windowMs.toString()],
      );
      const counts = rate.rows[0];
      if (
        !counts ||
        BigInt(counts.phone_count) >= BigInt(input.limits.phone) ||
        BigInt(counts.ip_count) >= BigInt(input.limits.ip) ||
        BigInt(counts.device_count) >= BigInt(input.limits.device)
      ) {
        const error = new Error('验证码请求过于频繁');
        error.name = 'OtpRateLimitError';
        throw error;
      }
      await client.query(
        `INSERT INTO otp_challenge
          (id, phone_e164, purpose, code_hmac, ip_digest, device_digest, expires_at, max_attempts)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          input.id,
          input.phoneE164,
          input.purpose,
          input.codeHmac,
          input.ipDigest,
          input.deviceDigest,
          input.expiresAt,
          input.maxAttempts,
        ],
      );
    });
  }

  async lockOtpChallenge<Result>(
    id: string,
    work: (client: SqlClient, challenge: OtpChallengeRecord) => Promise<Result>,
  ): Promise<Result> {
    return this.transactions.transaction(async (client) => {
      const result = await client.query<{
        id: string;
        phone_e164: string;
        purpose: OtpChallengeRecord['purpose'];
        code_hmac: Uint8Array;
        failed_attempts: number;
        max_attempts: number;
        expires_at: Date;
        consumed_at: Date | null;
      }>('SELECT * FROM otp_challenge WHERE id = $1 FOR UPDATE', [id]);
      const row = result.rows[0];
      if (!row) {
        throw new AppError('OTP_INVALID', '验证码无效或已过期', 400);
      }
      return work(client, {
        id: row.id,
        phoneE164: row.phone_e164,
        purpose: row.purpose,
        codeHmac: row.code_hmac,
        failedAttempts: row.failed_attempts,
        maxAttempts: row.max_attempts,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      });
    });
  }

  async markOtpFailed(client: SqlClient, id: string): Promise<void> {
    await client.query(
      `UPDATE otp_challenge
          SET failed_attempts = LEAST(failed_attempts + 1, max_attempts)
        WHERE id = $1 AND failed_attempts < max_attempts`,
      [id],
    );
  }

  async consumeOtp(client: SqlClient, id: string, consumedAt: Date): Promise<void> {
    const result = await client.query(
      'UPDATE otp_challenge SET consumed_at = $2 WHERE id = $1 AND consumed_at IS NULL',
      [id, consumedAt],
    );
    if (result.rowCount !== 1) throw new AppError('OTP_INVALID', '验证码无效或已被使用', 400);
  }

  async findLoginAccount(client: SqlClient, phoneE164: string): Promise<AccountRecord | null> {
    const result = await client.query<AccountRow>(
      'SELECT * FROM account WHERE phone_e164 = $1 AND registered_at IS NOT NULL',
      [phoneE164],
    );
    const row = result.rows[0];
    return row ? hydrateAccount(client, row) : null;
  }

  async activateInvitedAccount(client: SqlClient, phoneE164: string, verifiedAt: Date, avatarId: number): Promise<AccountRecord | null> {
    const invitation = await client.query<{ display_name: string | null }>(
      `SELECT display_name FROM enterprise_member
        WHERE phone_e164=$1 AND status='PENDING'
        ORDER BY created_at,id LIMIT 1 FOR UPDATE`,
      [phoneE164],
    );
    if (!invitation.rows[0]) return null;
    const inserted = await client.query<AccountRow>(
      `INSERT INTO account(phone_e164,phone_verified_at,display_name,registered_at,avatar_id)
       VALUES($1,$2,$3,$2,$4)
       ON CONFLICT(phone_e164) DO NOTHING RETURNING *`,
      [phoneE164, verifiedAt, invitation.rows[0].display_name, avatarId],
    );
    const row = inserted.rows[0];
    if (!row) return this.findLoginAccount(client, phoneE164);
    await client.query(`INSERT INTO account_role(account_id,role) VALUES($1,'ACCOUNTANT')`, [row.id]);
    await activatePendingRelationships(client, row);
    await client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,metadata)
       VALUES($1,'ACCOUNT_REGISTERED','account',$1,$2::jsonb)`,
      [row.id, JSON.stringify({ role: 'ACCOUNTANT', automatic: 'enterprise-invitation' })],
    );
    return hydrateAccount(client, row);
  }

  async registerLoginAccount(
    client: SqlClient,
    input: Parameters<AuthRepository['registerLoginAccount']>[1],
  ): Promise<{ readonly account: AccountRecord; readonly registered: boolean }> {
    let result = await client.query<AccountRow>('SELECT * FROM account WHERE phone_e164 = $1 FOR UPDATE', [input.phoneE164]);
    let row = result.rows[0];
    if (row?.registered_at) return { account: await hydrateAccount(client, row), registered: false };
    if (!row) {
      result = await client.query<AccountRow>(
        `INSERT INTO account (phone_e164, phone_verified_at, display_name, registered_at, avatar_id)
         VALUES ($1,$2,$3,$2,$4)
         ON CONFLICT (phone_e164) DO NOTHING
         RETURNING *`,
        [input.phoneE164, input.verifiedAt, input.displayName, input.avatarId],
      );
      row = result.rows[0];
      if (!row) {
        const concurrent = await client.query<AccountRow>('SELECT * FROM account WHERE phone_e164 = $1 FOR UPDATE', [input.phoneE164]);
        row = concurrent.rows[0];
        if (row?.registered_at) return { account: await hydrateAccount(client, row), registered: false };
      }
    } else {
      const completed = await client.query<AccountRow>(
        `UPDATE account
            SET display_name=$2,registered_at=$3,phone_verified_at=$3,avatar_id=$4,updated_at=$3
          WHERE id=$1 AND registered_at IS NULL
          RETURNING *`,
        [row.id, input.displayName, input.verifiedAt, input.avatarId],
      );
      row = completed.rows[0];
    }
    if (!row) throw new Error('创建账户失败');

    const role: PlatformRole = input.grantAdministrator
      ? 'ADMIN'
      : 'ACCOUNTANT';
    await client.query(
      `INSERT INTO account_role (account_id, role)
       VALUES ($1,$2)`,
      [row.id, role],
    );
    await activatePendingRelationships(client, row);
    await client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,metadata)
       VALUES($1,'ACCOUNT_REGISTERED','account',$1,$2::jsonb)`,
      [row.id, JSON.stringify({ role })],
    );
    return { account: await hydrateAccount(client, row), registered: true };
  }

  async findAccountById(id: string): Promise<AccountRecord | null> {
    const result = await this.reader.query<AccountRow>('SELECT * FROM account WHERE id = $1', [id]);
    const row = result.rows[0];
    return row ? hydrateAccount(this.reader, row) : null;
  }

  async createSessionWithLoginAudit(input: Parameters<AuthRepository['createSessionWithLoginAudit']>[0]): Promise<{ sessionId: string; loginSequence: string }> {
    return this.transactions.transaction(async (client) => {
      const login = await client.query<{ login_sequence: string }>(
        `UPDATE account
            SET successful_login_count=successful_login_count+1,
                first_login_at=COALESCE(first_login_at,clock_timestamp()),
                last_login_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE id=$1
          RETURNING successful_login_count::text login_sequence`,
        [input.accountId],
      );
      const loginSequence = login.rows[0]?.login_sequence;
      if (!loginSequence) throw new Error('更新登录生命周期失败');
      const result = await client.query<{ id: string }>(
        `INSERT INTO auth_session
          (account_id, token_digest, csrf_digest, account_generation, expires_at, login_sequence)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [input.accountId, input.tokenDigest, input.csrfDigest, input.accountGeneration, input.expiresAt, loginSequence],
      );
      const id = result.rows[0]?.id;
      if (!id) throw new Error('创建会话失败');
      await client.query(
        `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
         VALUES($1,'ACCOUNT_LOGIN','account',$1,NULL,$2::jsonb)`,
        [input.accountId, JSON.stringify({
          actorRoles: input.actorRoles,
          result: 'SUCCEEDED',
          requestId: input.requestId,
          before: null,
          after: { sessionCreated: true, loginSequence },
        })],
      );
      return { sessionId: id, loginSequence };
    });
  }

  async recordLoginFailure(input: Parameters<AuthRepository['recordLoginFailure']>[0]): Promise<void> {
    await this.reader.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
       VALUES($1,'ACCOUNT_LOGIN',$2,$3,$4,$5::jsonb)`,
      [
        input.actorAccountId,
        input.objectType,
        input.objectId,
        input.failureCode,
        JSON.stringify({
          actorRoles: input.actorRoles,
          result: 'FAILED',
          requestId: input.requestId,
          before: null,
          after: { failureCode: input.failureCode },
        }),
      ],
    );
  }

  async findSession(digest: Uint8Array): Promise<SessionRecord | null> {
    const result = await this.reader.query<{
      id: string;
      account_id: string;
      csrf_digest: Uint8Array;
      account_generation: string;
      expires_at: Date;
      revoked_at: Date | null;
      login_sequence: string;
    }>(
      `SELECT id, account_id, csrf_digest, account_generation, expires_at, revoked_at, login_sequence::text
         FROM auth_session WHERE token_digest = $1`,
      [digest],
    );
    const row = result.rows[0];
    return row
      ? {
          id: row.id,
          accountId: row.account_id,
          csrfDigest: row.csrf_digest,
          accountGeneration: row.account_generation,
          expiresAt: row.expires_at,
          revokedAt: row.revoked_at,
          loginSequence: row.login_sequence,
        }
      : null;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.reader.query(
      'UPDATE auth_session SET revoked_at = COALESCE(revoked_at, clock_timestamp()) WHERE id = $1',
      [sessionId],
    );
  }

  async updateTheme(accountId: string, themeId: AccountRecord['themeId']): Promise<void> {
    await this.reader.query('UPDATE account SET theme_id = $2, updated_at = clock_timestamp() WHERE id = $1', [
      accountId,
      themeId,
    ]);
  }

  async updateAvatar(accountId: string, avatarId: number): Promise<void> {
    await this.reader.query('UPDATE account SET avatar_id = $2, updated_at = clock_timestamp() WHERE id = $1', [
      accountId,
      avatarId,
    ]);
  }

  async bootstrapAdministrator(phoneE164: string, verifiedAt: Date): Promise<AccountRecord> {
    return this.transactions.transaction(async (client) => {
      const guard = await client.query<{ completed_at: Date | null }>(
        'SELECT completed_at FROM identity_bootstrap WHERE singleton = true FOR UPDATE',
      );
      if (guard.rows[0]?.completed_at) {
        throw new AppError('ADMIN_BOOTSTRAP_CLOSED', '首位管理员初始化入口已永久关闭', 409);
      }
      const inserted = await client.query<AccountRow>(
        `INSERT INTO account (phone_e164, phone_verified_at)
         VALUES ($1,$2)
         ON CONFLICT (phone_e164) DO UPDATE SET phone_verified_at = EXCLUDED.phone_verified_at
         RETURNING *`,
        [phoneE164, verifiedAt],
      );
      const row = inserted.rows[0];
      if (!row) throw new Error('创建管理员失败');
      const existingRole = await client.query<{ role: PlatformRole }>(
        "SELECT role FROM account_role WHERE account_id=$1 FOR UPDATE",
        [row.id],
      );
      if (existingRole.rows[0]) {
        await client.query("UPDATE account_role SET role='ADMIN' WHERE account_id=$1", [row.id]);
      } else {
        await client.query("INSERT INTO account_role (account_id,role) VALUES($1,'ADMIN')", [row.id]);
      }
      await client.query(
        `UPDATE identity_bootstrap SET completed_at = $2, completed_by = $1
          WHERE singleton = true AND completed_at IS NULL`,
        [row.id, verifiedAt],
      );
      return hydrateAccount(client, row);
    });
  }

  async completePhoneChange(input: Parameters<AuthRepository['completePhoneChange']>[0]): Promise<void> {
    await this.transactions.transaction(async (client) => {
      const account = await client.query<{ phone_e164: string; session_generation: string }>(
        'SELECT phone_e164, session_generation::text FROM account WHERE id = $1 FOR UPDATE',
        [input.accountId],
      );
      const accountRow = account.rows[0];
      if (!accountRow) throw new AppError('ACCOUNT_NOT_FOUND', '账户不存在', 404);
      const challenges = await client.query<{
        id: string;
        phone_e164: string;
        purpose: string;
        consumed_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, phone_e164, purpose, consumed_at, expires_at FROM otp_challenge
          WHERE id = ANY($1::uuid[]) FOR UPDATE`,
        [[input.oldChallengeId, input.newChallengeId]],
      );
      const oldChallenge = challenges.rows.find(({ id }) => id === input.oldChallengeId);
      const newChallenge = challenges.rows.find(({ id }) => id === input.newChallengeId);
      if (
        oldChallenge?.purpose !== 'PHONE_CHANGE_OLD' ||
        oldChallenge.phone_e164 !== accountRow.phone_e164 ||
        !oldChallenge.consumed_at ||
        oldChallenge.expires_at.getTime() <= input.now.getTime() ||
        newChallenge?.purpose !== 'PHONE_CHANGE_NEW' ||
        newChallenge.phone_e164 !== input.newPhoneE164 ||
        !newChallenge.consumed_at ||
        newChallenge.expires_at.getTime() <= input.now.getTime()
      ) {
        throw new AppError('PHONE_CHANGE_VERIFICATION_REQUIRED', '新旧手机号尚未完成双重验证', 400);
      }
      await client.query(
        `UPDATE enterprise_member pending
            SET status='REVOKED',revoked_at=$3,revoke_reason='手机号换绑后与既有成员关系合并',
                authorization_epoch=pending.authorization_epoch+1,updated_at=$3
           FROM enterprise_member active
          WHERE pending.phone_e164=$2 AND pending.status='PENDING'
            AND active.enterprise_id=pending.enterprise_id AND active.account_id=$1 AND active.status='ACTIVE'`,
        [input.accountId, input.newPhoneE164, input.now],
      );
      await client.query(
        `UPDATE enterprise_member SET phone_e164=$2,updated_at=$3
          WHERE account_id=$1 AND status='ACTIVE'`,
        [input.accountId, input.newPhoneE164, input.now],
      );
      const updated = await client.query<AccountRow>(
        `UPDATE account
            SET phone_e164 = $2, phone_verified_at = $3,
                session_generation = session_generation + 1, updated_at = $3
          WHERE id = $1
          RETURNING *`,
        [input.accountId, input.newPhoneE164, input.now],
      );
      const updatedAccount = updated.rows[0];
      if (!updatedAccount) throw new Error('手机号换绑失败');
      await activatePendingRelationships(client, updatedAccount);
      const nextGeneration = updatedAccount.session_generation;
      await client.query(
        'UPDATE auth_session SET revoked_at = COALESCE(revoked_at, $2) WHERE account_id = $1',
        [input.accountId, input.now],
      );
      await client.query(
        `INSERT INTO phone_change_request
          (account_id, old_phone_e164, new_phone_e164, old_challenge_id, new_challenge_id,
           status, expires_at, completed_at)
         VALUES ($1,$2,$3,$4,$5,'COMPLETED',$6,$6)`,
        [
          input.accountId,
          accountRow.phone_e164,
          input.newPhoneE164,
          input.oldChallengeId,
          input.newChallengeId,
          input.now,
        ],
      );
      await client.query(
        `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
         VALUES($1,'ACCOUNT_PHONE_CHANGED','account',$1,NULL,$2::jsonb)`,
        [input.accountId, JSON.stringify({
          actorRoles: input.actorRoles,
          result: 'SUCCEEDED',
          requestId: input.requestId,
          before: { sessionGeneration: accountRow.session_generation },
          after: { sessionGeneration: nextGeneration, sessionsRevoked: true },
        })],
      );
    });
  }
}
