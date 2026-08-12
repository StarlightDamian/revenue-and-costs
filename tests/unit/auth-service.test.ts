import { describe, expect, it } from 'vitest';
import {
  AuthService,
  SandboxSmsProvider,
  TemporaryAdminSmsProvider,
  type AccountRecord,
  type AuthRepository,
  type OtpChallengeRecord,
  type SessionRecord,
} from '../../src/modules/auth/index.js';
import type { PlatformRole, SqlClient } from '../../src/modules/authorization/index.js';

const dummyClient: SqlClient = {
  async query() {
    return { rows: [], rowCount: 0 };
  },
};

class MemoryAuthRepository implements AuthRepository {
  challenges = new Map<string, OtpChallengeRecord>();
  sessions = new Map<string, SessionRecord>();
  loginAudits: Array<Parameters<AuthRepository['recordLoginFailure']>[0] | {
    readonly actorAccountId: string;
    readonly actorRoles: readonly PlatformRole[];
    readonly objectType: 'account';
    readonly objectId: string;
    readonly result: 'SUCCEEDED';
    readonly requestId: string;
  }> = [];
  failLoginAuditWrite = false;
  sessionClients: Array<SqlClient | undefined> = [];
  account: AccountRecord = {
    id: '10000000-0000-4000-8000-000000000001',
    phoneE164: '+8613800000000',
    displayName: '测试用户',
    registeredAt: new Date('2026-07-27T00:00:00.000Z'),
    avatarId: 1,
    status: 'ACTIVE',
    themeId: 'comfort',
    sessionGeneration: '1',
    roles: new Set(['ACCOUNTANT']),
  };

  async createOtpChallengeAfterRateCheck(input: Parameters<AuthRepository['createOtpChallengeAfterRateCheck']>[0]) {
    this.challenges.set(input.id, {
      id: input.id,
      phoneE164: input.phoneE164,
      purpose: input.purpose,
      codeHmac: input.codeHmac,
      failedAttempts: 0,
      maxAttempts: input.maxAttempts,
      expiresAt: input.expiresAt,
      consumedAt: null,
    });
  }

  async lockOtpChallenge<Result>(
    id: string,
    work: (client: SqlClient, challenge: OtpChallengeRecord) => Promise<Result>,
  ): Promise<Result> {
    const challenge = this.challenges.get(id);
    if (!challenge) throw new Error('missing challenge');
    return work(dummyClient, challenge);
  }

  async markOtpFailed(_client: SqlClient, id: string) {
    const challenge = this.challenges.get(id)!;
    this.challenges.set(id, { ...challenge, failedAttempts: challenge.failedAttempts + 1 });
  }

  async consumeOtp(_client: SqlClient, id: string, consumedAt: Date) {
    const challenge = this.challenges.get(id)!;
    if (challenge.consumedAt) throw new Error('used');
    this.challenges.set(id, { ...challenge, consumedAt });
  }

  async findLoginAccount(_client: SqlClient, phoneE164: string) {
    return this.account.phoneE164 === phoneE164 && this.account.registeredAt ? this.account : null;
  }

  async activateInvitedAccount() {
    return null;
  }

  async registerLoginAccount(
    _client: SqlClient,
    input: Parameters<AuthRepository['registerLoginAccount']>[1],
  ) {
    if (this.account.phoneE164 === input.phoneE164 && this.account.registeredAt) {
      return { account: this.account, registered: false };
    }
    this.account = {
      ...this.account,
      phoneE164: input.phoneE164,
      displayName: input.displayName,
      registeredAt: input.verifiedAt,
      avatarId: input.avatarId,
      roles: new Set(input.grantAdministrator ? ['ADMIN'] : ['ACCOUNTANT']),
    };
    return { account: this.account, registered: true };
  }

  async findAccountById(id: string) {
    return id === this.account.id ? this.account : null;
  }

  async createSessionWithLoginAudit(
    input: Parameters<AuthRepository['createSessionWithLoginAudit']>[0],
    client?: SqlClient,
  ) {
    this.sessionClients.push(client);
    if (this.failLoginAuditWrite) throw new Error('audit unavailable');
    const id = `session-${this.sessions.size + 1}`;
    const loginSequence = String(this.sessions.size + 1);
    this.sessions.set(Buffer.from(input.tokenDigest).toString('hex'), {
      id,
      accountId: input.accountId,
      csrfDigest: input.csrfDigest,
      accountGeneration: input.accountGeneration,
      expiresAt: input.expiresAt,
      revokedAt: null,
      loginSequence,
    });
    this.loginAudits.push({
      actorAccountId: input.accountId,
      actorRoles: input.actorRoles,
      objectType: 'account',
      objectId: input.accountId,
      result: 'SUCCEEDED',
      requestId: input.requestId,
    });
    return { sessionId: id, loginSequence };
  }

  async recordLoginFailure(input: Parameters<AuthRepository['recordLoginFailure']>[0]) {
    if (this.failLoginAuditWrite) throw new Error('audit unavailable');
    this.loginAudits.push(input);
  }

  async findSession(digest: Uint8Array) {
    return this.sessions.get(Buffer.from(digest).toString('hex')) ?? null;
  }

  async revokeSession(sessionId: string) {
    for (const [key, session] of this.sessions) {
      if (session.id === sessionId) this.sessions.set(key, { ...session, revokedAt: new Date() });
    }
  }


  async updateTheme(_accountId: string, themeId: AccountRecord['themeId']) {
    this.account = { ...this.account, themeId };
  }

  async updateAvatar(_accountId: string, avatarId: number) {
    this.account = { ...this.account, avatarId };
  }

  async updateDisplayName(_accountId: string, displayName: string | null) {
    this.account = { ...this.account, displayName };
  }

  async bootstrapAdministrator() {
    return this.account;
  }

  async completePhoneChange(input: Parameters<AuthRepository['completePhoneChange']>[0]) {
    void input;
  }
}

describe('AuthService', () => {
  it('limits the temporary fixed code to login for the configured administrator and never discloses it', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(
      repository,
      new TemporaryAdminSmsProvider(repository.account.phoneE164),
      {
        otpSecret: Buffer.alloc(32, 1),
        privacySecret: Buffer.alloc(32, 2),
        temporaryAdminOtpCode: '246810',
      },
    );

    const challenge = await service.requestOtp({
      phone: repository.account.phoneE164,
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'temporary-admin-login',
    });
    expect(challenge).not.toHaveProperty('sandboxCode');
    await expect(service.verifyLogin({
      challengeId: challenge.challengeId,
      phone: repository.account.phoneE164,
      code: '246810',
      requestId: 'temporary-admin-login',
    })).resolves.toMatchObject({ account: { id: repository.account.id } });

    await expect(service.requestOtp({
      phone: '+8613900000000',
      purpose: 'LOGIN',
      ip: '127.0.0.2',
      deviceId: 'other-phone',
    })).rejects.toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE', statusCode: 503 });
    await expect(service.requestOtp({
      phone: repository.account.phoneE164,
      purpose: 'REGISTER',
      ip: '127.0.0.3',
      deviceId: 'temporary-register',
    })).rejects.toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE', statusCode: 503 });
    expect(repository.challenges.size).toBe(1);

    const serialized = JSON.stringify(repository.loginAudits);
    expect(serialized).not.toContain('246810');
    expect(serialized).not.toContain(repository.account.phoneE164);
  });

  it('allows opt-in fixed-code registration and login while keeping phone changes disabled', async () => {
    const repository = new MemoryAuthRepository();
    const registeredPhone = '+8613900000000';
    const service = new AuthService(
      repository,
      new TemporaryAdminSmsProvider(repository.account.phoneE164, true),
      {
        otpSecret: Buffer.alloc(32, 1),
        privacySecret: Buffer.alloc(32, 2),
        temporaryAdminOtpCode: '246810',
      },
    );

    const registration = await service.requestOtp({
      phone: registeredPhone,
      purpose: 'REGISTER',
      ip: '127.0.0.1',
      deviceId: 'temporary-public-register',
    });
    expect(registration).not.toHaveProperty('sandboxCode');
    const registeredSession = await service.verifyRegistration({
      challengeId: registration.challengeId,
      phone: registeredPhone,
      code: '246810',
      displayName: '新做账员',
      requestId: 'temporary-public-registration',
    });
    expect(registeredSession).toMatchObject({
      account: { displayName: '新做账员', phoneE164: registeredPhone },
      isFirstLogin: true,
    });
    await expect(service.authenticate(registeredSession.sessionToken)).resolves.toMatchObject({ isFirstLogin: true });
    expect(repository.account.roles).toEqual(new Set(['ACCOUNTANT']));

    const login = await service.requestOtp({
      phone: registeredPhone,
      purpose: 'LOGIN',
      ip: '127.0.0.2',
      deviceId: 'temporary-public-login',
    });
    await expect(service.verifyLogin({
      challengeId: login.challengeId,
      phone: registeredPhone,
      code: '246810',
      requestId: 'temporary-public-login',
    })).resolves.toMatchObject({ account: { phoneE164: registeredPhone }, isFirstLogin: false });

    await expect(service.requestOtp({
      phone: registeredPhone,
      purpose: 'PHONE_CHANGE_NEW',
      ip: '127.0.0.3',
      deviceId: 'temporary-phone-change',
    })).rejects.toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE', statusCode: 503 });
  });

  it('marks only the first successfully issued login session as initial', async () => {
    const repository = new MemoryAuthRepository();
    const sms = new SandboxSmsProvider();
    const service = new AuthService(repository, sms, {
      otpSecret: Buffer.alloc(32, 1),
      privacySecret: Buffer.alloc(32, 2),
      now: () => new Date('2026-08-07T00:00:00.000Z'),
      allowSandboxCodeDisclosure: true,
      sandboxOtpCode: '246810',
    });

    const firstOtp = await service.requestOtp({ phone: repository.account.phoneE164, purpose: 'LOGIN', ip: '127.0.0.1', deviceId: 'first-login-device' });
    const first = await service.verifyLogin({ challengeId: firstOtp.challengeId, phone: repository.account.phoneE164, code: '246810', requestId: 'first-login' });
    const secondOtp = await service.requestOtp({ phone: repository.account.phoneE164, purpose: 'LOGIN', ip: '127.0.0.2', deviceId: 'second-login-device' });
    const second = await service.verifyLogin({ challengeId: secondOtp.challengeId, phone: repository.account.phoneE164, code: '246810', requestId: 'second-login' });

    expect(first.isFirstLogin).toBe(true);
    expect(second.isFirstLogin).toBe(false);
    await expect(service.authenticate(first.sessionToken)).resolves.toMatchObject({ isFirstLogin: true });
    await expect(service.authenticate(second.sessionToken)).resolves.toMatchObject({ isFirstLogin: false });
  });

  it('固定沙箱验证码完成实名注册后直接签发首个正常会话', async () => {
    const repository = new MemoryAuthRepository();
    repository.account = { ...repository.account, displayName: null, registeredAt: null, roles: new Set() };
    const service = new AuthService(repository, new SandboxSmsProvider(), {
      otpSecret: Buffer.alloc(32, 1),
      privacySecret: Buffer.alloc(32, 2),
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      allowSandboxCodeDisclosure: true,
      sandboxOtpCode: '246810',
      registrationAdminPhoneE164: '+8613800000000',
    });
    const loginBeforeRegistration = await service.requestOtp({
      phone: '+8613800000000', purpose: 'LOGIN', ip: '127.0.0.1', deviceId: 'login-before-register',
    });
    expect(loginBeforeRegistration.sandboxCode).toBe('246810');
    await expect(service.verifyLogin({
      challengeId: loginBeforeRegistration.challengeId, phone: '+8613800000000', code: '246810', requestId: 'login-before-registration',
    })).rejects.toMatchObject({ code: 'ACCOUNT_NOT_REGISTERED' });

    const registration = await service.requestOtp({
      phone: '+8613800000000', purpose: 'REGISTER', ip: '127.0.0.1', deviceId: 'register-device',
    });
    const session = await service.verifyRegistration({
      challengeId: registration.challengeId,
      phone: '+8613800000000',
      code: '246810',
      displayName: '  注册管理员  ',
      requestId: 'registration-session',
    });
    expect(session).toMatchObject({ account: { displayName: '注册管理员' }, isFirstLogin: true });
    expect(repository.account.avatarId).toBeGreaterThanOrEqual(1);
    expect(repository.account.avatarId).toBeLessThanOrEqual(59);
    expect(repository.account.roles).toEqual(new Set(['ADMIN']));
    expect(repository.sessions.size).toBe(1);
    expect(repository.sessionClients).toEqual([dummyClient]);
    expect(session.account.displayName).toBe('注册管理员');
    await expect(service.authenticate(session.sessionToken)).resolves.toMatchObject({ isFirstLogin: true });
    await expect(service.verifyRegistration({
      challengeId: registration.challengeId,
      phone: '+8613800000000',
      code: '246810',
      requestId: 'registration-replay',
    })).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(repository.loginAudits).toEqual([
      expect.objectContaining({
        actorAccountId: null,
        objectType: 'otp_challenge',
        objectId: loginBeforeRegistration.challengeId,
        failureCode: 'ACCOUNT_NOT_REGISTERED',
        requestId: 'login-before-registration',
      }),
      expect.objectContaining({
        actorAccountId: repository.account.id,
        objectType: 'account',
        objectId: repository.account.id,
        result: 'SUCCEEDED',
        requestId: 'registration-session',
      }),
    ]);
    expect(JSON.stringify(repository.loginAudits)).not.toContain(repository.account.phoneE164);
    expect(JSON.stringify(repository.loginAudits)).not.toContain('246810');
    await expect(service.setAvatar(repository.account.id, 59)).resolves.toBeUndefined();
    expect(repository.account.avatarId).toBe(59);
    await expect(service.setAvatar(repository.account.id, 60)).rejects.toMatchObject({ code: 'AVATAR_INVALID' });
    await expect(service.setDisplayName(repository.account.id, '  海\u0065\u0301  ')).resolves.toBeUndefined();
    expect(repository.account.displayName).toBe('海é');
    await expect(service.setDisplayName(repository.account.id, '   ')).resolves.toBeUndefined();
    expect(repository.account.displayName).toBeNull();
    await expect(service.setDisplayName(repository.account.id, '名'.repeat(81)))
      .rejects.toMatchObject({ code: 'DISPLAY_NAME_INVALID', statusCode: 400 });
    await expect(service.setDisplayName(repository.account.id, '😀'.repeat(80))).resolves.toBeUndefined();
    expect(repository.account.displayName).toBe('😀'.repeat(80));
    await expect(service.setDisplayName(repository.account.id, '😀'.repeat(81)))
      .rejects.toMatchObject({ code: 'DISPLAY_NAME_INVALID', statusCode: 400 });
    await expect(service.setDisplayName(repository.account.id, 'e\u0301'.repeat(80))).resolves.toBeUndefined();
    expect(repository.account.displayName).toBe('é'.repeat(80));
    await expect(service.setDisplayName(repository.account.id, '可见\u0000名称'))
      .rejects.toMatchObject({ code: 'DISPLAY_NAME_INVALID', statusCode: 400 });
  });

  it('OTP 在事务语义下仅消费一次，并签发摘要会话和 CSRF', async () => {
    const repository = new MemoryAuthRepository();
    const sms = new SandboxSmsProvider();
    const now = new Date('2026-07-28T00:00:00.000Z');
    const service = new AuthService(repository, sms, {
      otpSecret: Buffer.alloc(32, 1),
      privacySecret: Buffer.alloc(32, 2),
      now: () => now,
      allowSandboxCodeDisclosure: true,
    });
    const challenge = await service.requestOtp({
      phone: '+8613800000000',
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'test-device',
    });
    expect(challenge.sandboxCode).toMatch(/^[0-9]{6}$/);
    const session = await service.verifyLogin({
      challengeId: challenge.challengeId,
      phone: '+8613800000000',
      code: challenge.sandboxCode!,
      requestId: 'single-use-login',
    });
    expect(session.sessionToken).not.toBe([...repository.sessions.keys()][0]);
    await expect(service.authenticate(session.sessionToken, session.csrfToken)).resolves.toMatchObject({
      actor: { accountId: repository.account.id },
    });
    await expect(
      service.verifyLogin({
        challengeId: challenge.challengeId,
        phone: '+8613800000000',
        code: challenge.sandboxCode!,
        requestId: 'reused-login-challenge',
      }),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });

  it('错误验证码累计失败且错误 CSRF 被拒绝', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(repository, new SandboxSmsProvider(), {
      otpSecret: Buffer.alloc(32, 3),
      privacySecret: Buffer.alloc(32, 4),
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      allowSandboxCodeDisclosure: true,
    });
    const challenge = await service.requestOtp({
      phone: '+8613800000000',
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'test-device',
    });
    await expect(
      service.verifyLogin({ challengeId: challenge.challengeId, phone: '+8613800000000', code: '999999', requestId: 'wrong-login-code' }),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    expect(repository.challenges.get(challenge.challengeId)?.failedAttempts).toBe(1);
    const session = await service.verifyLogin({
      challengeId: challenge.challengeId,
      phone: '+8613800000000',
      code: challenge.sandboxCode!,
      requestId: 'login-after-wrong-code',
    });
    await expect(service.authenticate(session.sessionToken, 'wrong-csrf')).rejects.toMatchObject({ code: 'CSRF_INVALID' });
  });

  it('达到最大错误次数后即使验证码正确也保持锁死', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(repository, new SandboxSmsProvider(), {
      otpSecret: Buffer.alloc(32, 5),
      privacySecret: Buffer.alloc(32, 6),
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      allowSandboxCodeDisclosure: true,
    });
    const challenge = await service.requestOtp({
      phone: '+8613800000000',
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'locked-device',
    });
    const wrongCode = challenge.sandboxCode === '000000' ? '999999' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        service.verifyLogin({ challengeId: challenge.challengeId, phone: '+8613800000000', code: wrongCode, requestId: `locked-login-${attempt}` }),
      ).rejects.toMatchObject({ code: 'OTP_INVALID' });
    }
    expect(repository.challenges.get(challenge.challengeId)?.failedAttempts).toBe(5);
    await expect(
      service.verifyLogin({
        challengeId: challenge.challengeId,
        phone: '+8613800000000',
        code: challenge.sandboxCode!,
        requestId: 'locked-login-correct-code',
      }),
    ).rejects.toMatchObject({ code: 'OTP_INVALID' });
  });

  it('登录失败审计区分可归属与不可归属对象且不记录认证秘密', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(repository, new SandboxSmsProvider(), {
      otpSecret: Buffer.alloc(32, 7),
      privacySecret: Buffer.alloc(32, 8),
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      allowSandboxCodeDisclosure: true,
      sandboxOtpCode: '246810',
    });
    const wrongCode = await service.requestOtp({
      phone: repository.account.phoneE164,
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'unattributable-login',
    });
    await expect(service.verifyLogin({
      challengeId: wrongCode.challengeId,
      phone: repository.account.phoneE164,
      code: '135790',
      requestId: 'unattributable-failure',
    })).rejects.toMatchObject({ code: 'OTP_INVALID' });

    repository.account = { ...repository.account, status: 'DISABLED' };
    const disabled = await service.requestOtp({
      phone: repository.account.phoneE164,
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'attributable-login',
    });
    await expect(service.verifyLogin({
      challengeId: disabled.challengeId,
      phone: repository.account.phoneE164,
      code: disabled.sandboxCode!,
      requestId: 'attributable-failure',
    })).rejects.toMatchObject({ code: 'ACCOUNT_DISABLED' });

    expect(repository.loginAudits).toEqual([
      expect.objectContaining({
        actorAccountId: null,
        objectType: 'otp_challenge',
        objectId: wrongCode.challengeId,
        failureCode: 'OTP_INVALID',
        requestId: 'unattributable-failure',
      }),
      expect.objectContaining({
        actorAccountId: repository.account.id,
        objectType: 'account',
        objectId: repository.account.id,
        failureCode: 'ACCOUNT_DISABLED',
        requestId: 'attributable-failure',
      }),
    ]);
    const serialized = JSON.stringify(repository.loginAudits);
    expect(serialized).not.toContain(repository.account.phoneE164);
    expect(serialized).not.toContain('246810');
    expect(serialized).not.toContain('135790');
  });

  it('审计不可用时登录统一失败关闭且不签发会话', async () => {
    const repository = new MemoryAuthRepository();
    const service = new AuthService(repository, new SandboxSmsProvider(), {
      otpSecret: Buffer.alloc(32, 9),
      privacySecret: Buffer.alloc(32, 10),
      now: () => new Date('2026-07-28T00:00:00.000Z'),
      allowSandboxCodeDisclosure: true,
      sandboxOtpCode: '246810',
    });
    const failed = await service.requestOtp({
      phone: repository.account.phoneE164,
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'audit-failed-login',
    });
    repository.failLoginAuditWrite = true;
    await expect(service.verifyLogin({
      challengeId: failed.challengeId,
      phone: repository.account.phoneE164,
      code: '135790',
      requestId: 'audit-failed-attempt',
    })).rejects.toMatchObject({ code: 'AUTH_AUDIT_UNAVAILABLE', statusCode: 503 });
    expect(repository.challenges.get(failed.challengeId)?.failedAttempts).toBe(1);

    repository.failLoginAuditWrite = false;
    const successful = await service.requestOtp({
      phone: repository.account.phoneE164,
      purpose: 'LOGIN',
      ip: '127.0.0.1',
      deviceId: 'audit-success-login',
    });
    repository.failLoginAuditWrite = true;
    await expect(service.verifyLogin({
      challengeId: successful.challengeId,
      phone: repository.account.phoneE164,
      code: successful.sandboxCode!,
      requestId: 'audit-failed-success',
    })).rejects.toMatchObject({ code: 'AUTH_AUDIT_UNAVAILABLE', statusCode: 503 });
    expect(repository.sessions.size).toBe(0);
  });
});
