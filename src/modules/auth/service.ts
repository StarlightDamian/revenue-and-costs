import { randomInt, randomUUID } from 'node:crypto';
import type { Actor, PlatformRole } from '../authorization/index.js';
import { constantTimeEqual, createOtpCode, normalizePhone, otpHmac, privacyDigest, randomToken, tokenDigest } from './crypto.js';
import type { AccountRecord, AuthRepository, LoginFailureCode, OtpPurpose, SmsProvider } from './model.js';

export interface AuthServiceOptions {
  readonly otpSecret: Uint8Array;
  readonly privacySecret: Uint8Array;
  readonly otpTtlMs?: number;
  readonly sessionTtlMs?: number;
  readonly now?: () => Date;
  readonly allowSandboxCodeDisclosure?: boolean;
  readonly sandboxOtpCode?: string;
  readonly registrationAdminPhoneE164?: string;
}

export interface SessionCredentials {
  readonly sessionId: string;
  readonly sessionToken: string;
  readonly csrfToken: string;
  readonly expiresAt: string;
  readonly account: AccountRecord;
  readonly isFirstLogin: boolean;
}

export class AuthFailure extends Error {
  constructor(
    readonly code: string,
    message = '验证码无效或已过期',
    readonly statusCode = 400,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AuthFailure';
  }
}

export class AuthService {
  private readonly now: () => Date;
  private readonly otpTtlMs: number;
  private readonly sessionTtlMs: number;

  constructor(
    private readonly repository: AuthRepository,
    private readonly sms: SmsProvider,
    private readonly options: AuthServiceOptions,
  ) {
    if (sms.kind === 'SANDBOX' && process.env.NODE_ENV === 'production') {
      throw new Error('生产环境禁止使用合成短信适配器');
    }
    if (options.sandboxOtpCode && (sms.kind !== 'SANDBOX' || !/^[0-9]{6}$/u.test(options.sandboxOtpCode))) {
      throw new Error('固定验证码只能用于沙箱且必须是 6 位数字');
    }
    this.now = options.now ?? (() => new Date());
    this.otpTtlMs = options.otpTtlMs ?? 5 * 60_000;
    this.sessionTtlMs = options.sessionTtlMs ?? 7 * 24 * 60 * 60_000;
  }

  async requestOtp(input: {
    readonly phone: string;
    readonly purpose: OtpPurpose;
    readonly ip: string;
    readonly deviceId: string;
  }): Promise<{ readonly challengeId: string; readonly expiresAt: string; readonly sandboxCode?: string }> {
    const phoneE164 = normalizePhone(input.phone);
    const id = randomUUID();
    const code = this.sms.kind === 'SANDBOX' && this.options.sandboxOtpCode
      ? this.options.sandboxOtpCode
      : createOtpCode();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.otpTtlMs);
    await this.repository.createOtpChallengeAfterRateCheck({
      id,
      phoneE164,
      purpose: input.purpose,
      codeHmac: otpHmac(this.options.otpSecret, id, phoneE164, input.purpose, code),
      ipDigest: privacyDigest(this.options.privacySecret, input.ip),
      deviceDigest: privacyDigest(this.options.privacySecret, input.deviceId),
      expiresAt,
      maxAttempts: 5,
      limits: { phone: 5, ip: 20, device: 10, windowMs: 60 * 60_000 },
    });
    await this.sms.sendOtp({ phoneE164, purpose: input.purpose, code });
    const base = { challengeId: id, expiresAt: expiresAt.toISOString() };
    return this.sms.kind === 'SANDBOX' && this.options.allowSandboxCodeDisclosure
      ? { ...base, sandboxCode: code }
      : base;
  }

  async verifyLogin(input: {
    readonly challengeId: string;
    readonly phone: string;
    readonly code: string;
    readonly requestId: string;
  }): Promise<SessionCredentials> {
    const phoneE164 = normalizePhone(input.phone);
    const now = this.now();
    let verification: { readonly verified: false } | { readonly verified: true; readonly account: AccountRecord | null };
    try {
      verification = await this.repository.lockOtpChallenge(input.challengeId, async (client, challenge) => {
        if (
          challenge.phoneE164 !== phoneE164 ||
          challenge.purpose !== 'LOGIN' ||
          challenge.consumedAt ||
          challenge.expiresAt.getTime() <= now.getTime() ||
          challenge.failedAttempts >= challenge.maxAttempts
        ) {
          return { verified: false } as const;
        }
        const candidate = otpHmac(this.options.otpSecret, challenge.id, phoneE164, challenge.purpose, input.code);
        if (!constantTimeEqual(candidate, challenge.codeHmac)) {
          await this.repository.markOtpFailed(client, challenge.id);
          return { verified: false } as const;
        }
        await this.repository.consumeOtp(client, challenge.id, now);
        return {
          verified: true,
          account: await this.repository.findLoginAccount(client, phoneE164)
            ?? await this.repository.activateInvitedAccount(client, phoneE164, now, randomInt(1, 60)),
        } as const;
      });
    } catch (error) {
      const failureCode = error instanceof Error && 'code' in error && error.code === 'OTP_INVALID'
        ? 'OTP_INVALID'
        : 'LOGIN_PROCESSING_FAILED';
      return this.rejectLogin({
        actorAccountId: null,
        actorRoles: [],
        objectType: 'otp_challenge',
        objectId: input.challengeId,
        failureCode,
        requestId: input.requestId,
      }, error);
    }
    if (!verification.verified) {
      return this.rejectLogin({
        actorAccountId: null,
        actorRoles: [],
        objectType: 'otp_challenge',
        objectId: input.challengeId,
        failureCode: 'OTP_INVALID',
        requestId: input.requestId,
      }, new AuthFailure('OTP_INVALID'));
    }
    const account = verification.account;
    if (!account) {
      return this.rejectLogin({
        actorAccountId: null,
        actorRoles: [],
        objectType: 'otp_challenge',
        objectId: input.challengeId,
        failureCode: 'ACCOUNT_NOT_REGISTERED',
        requestId: input.requestId,
      }, new AuthFailure('ACCOUNT_NOT_REGISTERED', '该手机号尚未注册，请先注册账号', 409));
    }
    if (account.status !== 'ACTIVE') {
      return this.rejectLogin({
        actorAccountId: account.id,
        actorRoles: [...account.roles],
        objectType: 'account',
        objectId: account.id,
        failureCode: 'ACCOUNT_DISABLED',
        requestId: input.requestId,
      }, new AuthFailure('ACCOUNT_DISABLED', '账户已停用', 403));
    }
    return this.issueSession(account, now, input.requestId);
  }

  async verifyRegistration(input: {
    readonly challengeId: string;
    readonly phone: string;
    readonly code: string;
    readonly displayName?: string;
  }): Promise<{ readonly accountId: string; readonly displayName?: string; readonly registeredAt: string }> {
    const phoneE164 = normalizePhone(input.phone);
    const displayName = input.displayName?.trim().normalize('NFC') || null;
    if (displayName && Array.from(displayName).length > 80) {
      throw new AuthFailure('REGISTRATION_NAME_INVALID', '姓名最多为 80 个字符', 400);
    }
    const now = this.now();
    const verification = await this.repository.lockOtpChallenge(input.challengeId, async (client, challenge) => {
      if (
        challenge.phoneE164 !== phoneE164 ||
        challenge.purpose !== 'REGISTER' ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= now.getTime() ||
        challenge.failedAttempts >= challenge.maxAttempts
      ) {
        return { verified: false } as const;
      }
      const candidate = otpHmac(this.options.otpSecret, challenge.id, phoneE164, challenge.purpose, input.code);
      if (!constantTimeEqual(candidate, challenge.codeHmac)) {
        await this.repository.markOtpFailed(client, challenge.id);
        return { verified: false } as const;
      }
      await this.repository.consumeOtp(client, challenge.id, now);
      return {
        verified: true,
        result: await this.repository.registerLoginAccount(client, {
          phoneE164,
          displayName,
          avatarId: randomInt(1, 60),
          verifiedAt: now,
          grantAdministrator: this.options.registrationAdminPhoneE164 === phoneE164,
        }),
      } as const;
    });
    if (!verification.verified) throw new AuthFailure('OTP_INVALID');
    if (!verification.result.registered) {
      throw new AuthFailure('ACCOUNT_ALREADY_REGISTERED', '该手机号已注册，请直接登录', 409);
    }
    return {
      accountId: verification.result.account.id,
      ...(displayName ? { displayName } : {}),
      registeredAt: now.toISOString(),
    };
  }

  async verifyChallenge(input: {
    readonly challengeId: string;
    readonly phone: string;
    readonly purpose: Exclude<OtpPurpose, 'LOGIN' | 'REGISTER'>;
    readonly code: string;
  }): Promise<{ readonly challengeId: string; readonly consumed: true }> {
    const phoneE164 = normalizePhone(input.phone);
    const now = this.now();
    const verified = await this.repository.lockOtpChallenge(input.challengeId, async (client, challenge) => {
      if (
        challenge.phoneE164 !== phoneE164 ||
        challenge.purpose !== input.purpose ||
        challenge.consumedAt ||
        challenge.expiresAt.getTime() <= now.getTime() ||
        challenge.failedAttempts >= challenge.maxAttempts
      ) {
        return false;
      }
      const candidate = otpHmac(this.options.otpSecret, challenge.id, phoneE164, challenge.purpose, input.code);
      if (!constantTimeEqual(candidate, challenge.codeHmac)) {
        await this.repository.markOtpFailed(client, challenge.id);
        return false;
      }
      await this.repository.consumeOtp(client, challenge.id, now);
      return true;
    });
    if (!verified) throw new AuthFailure('OTP_INVALID');
    return { challengeId: input.challengeId, consumed: true };
  }

  async changePhone(input: {
    readonly accountId: string;
    readonly actorRoles: readonly PlatformRole[];
    readonly oldChallengeId: string;
    readonly newChallengeId: string;
    readonly newPhone: string;
    readonly requestId: string;
  }): Promise<void> {
    await this.repository.completePhoneChange({
      accountId: input.accountId,
      actorRoles: input.actorRoles,
      oldChallengeId: input.oldChallengeId,
      newChallengeId: input.newChallengeId,
      newPhoneE164: normalizePhone(input.newPhone),
      now: this.now(),
      requestId: input.requestId,
    });
  }

  async authenticate(sessionToken: string, csrfToken?: string): Promise<{ readonly actor: Actor; readonly sessionId: string; readonly isFirstLogin: boolean }> {
    const session = await this.repository.findSession(tokenDigest(sessionToken));
    const now = this.now();
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now.getTime()) {
      throw new AuthFailure('SESSION_INVALID', '登录已失效', 401);
    }
    const account = await this.repository.findAccountById(session.accountId);
    if (!account || account.status !== 'ACTIVE' || account.sessionGeneration !== session.accountGeneration) {
      throw new AuthFailure('SESSION_INVALID', '登录已失效', 401);
    }
    if (csrfToken && !constantTimeEqual(tokenDigest(csrfToken), session.csrfDigest)) {
      throw new AuthFailure('CSRF_INVALID', '请求校验失败', 403);
    }
    return {
      actor: { accountId: account.id, status: account.status, roles: account.roles, enterpriseIds: account.enterpriseIds ?? new Set() },
      sessionId: session.id,
      isFirstLogin: session.loginSequence === '1',
    };
  }

  async logout(sessionToken: string): Promise<void> {
    const session = await this.repository.findSession(tokenDigest(sessionToken));
    if (session) await this.repository.revokeSession(session.id);
  }

  async setTheme(accountId: string, themeId: AccountRecord['themeId']): Promise<void> {
    await this.repository.updateTheme(accountId, themeId);
  }

  async setAvatar(accountId: string, avatarId: number): Promise<void> {
    if (!Number.isInteger(avatarId) || avatarId < 1 || avatarId > 59) {
      throw new AuthFailure('AVATAR_INVALID', '请选择有效头像', 400);
    }
    await this.repository.updateAvatar(accountId, avatarId);
  }

  async bootstrapAdministrator(phone: string): Promise<AccountRecord> {
    return this.repository.bootstrapAdministrator(normalizePhone(phone), this.now());
  }

  private async rejectLogin(
    audit: {
      readonly actorAccountId: string | null;
      readonly actorRoles: readonly PlatformRole[];
      readonly objectType: 'account' | 'otp_challenge';
      readonly objectId: string;
      readonly failureCode: LoginFailureCode;
      readonly requestId: string;
    },
    error: unknown,
  ): Promise<never> {
    try {
      // This insert runs after the OTP transaction has committed, so throwing the
      // authentication error cannot roll back the failure evidence.
      await this.repository.recordLoginFailure(audit);
    } catch (auditError) {
      // Audit availability is part of the authentication boundary. Fail closed
      // with one generic response for attributable and unattributable attempts.
      throw new AuthFailure('AUTH_AUDIT_UNAVAILABLE', '登录服务暂时不可用，请稍后重试', 503, { cause: auditError });
    }
    throw error;
  }

  private async issueSession(account: AccountRecord, now: Date, requestId: string): Promise<SessionCredentials> {
    const sessionToken = randomToken();
    const csrfToken = randomToken();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    let session: { readonly sessionId: string; readonly loginSequence: string };
    try {
      session = await this.repository.createSessionWithLoginAudit({
        accountId: account.id,
        tokenDigest: tokenDigest(sessionToken),
        csrfDigest: tokenDigest(csrfToken),
        accountGeneration: account.sessionGeneration,
        expiresAt,
        actorRoles: [...account.roles],
        requestId,
      });
    } catch (auditError) {
      // Session creation and its success audit are one repository transaction.
      // Neither may survive alone; callers receive one non-enumerating failure.
      throw new AuthFailure('AUTH_AUDIT_UNAVAILABLE', '登录服务暂时不可用，请稍后重试', 503, { cause: auditError });
    }
    return { sessionId: session.sessionId, sessionToken, csrfToken, expiresAt: expiresAt.toISOString(), account, isFirstLogin: session.loginSequence === '1' };
  }
}

export class SandboxSmsProvider implements SmsProvider {
  readonly kind = 'SANDBOX' as const;
  readonly deliveries: Array<{ phoneE164: string; purpose: OtpPurpose; code: string }> = [];

  async sendOtp(input: { readonly phoneE164: string; readonly purpose: OtpPurpose; readonly code: string }): Promise<void> {
    this.deliveries.push(input);
  }
}
