import type { PlatformRole, SqlClient } from '../authorization/index.js';

export type OtpPurpose = 'REGISTER' | 'LOGIN' | 'PHONE_CHANGE_OLD' | 'PHONE_CHANGE_NEW';

export interface AccountRecord {
  readonly id: string;
  readonly phoneE164: string;
  readonly displayName: string | null;
  readonly registeredAt: Date | null;
  readonly avatarId: number;
  readonly status: 'ACTIVE' | 'DISABLED';
  readonly themeId: 'comfort' | 'tech' | 'light' | 'dark';
  readonly sessionGeneration: string;
  readonly roles: ReadonlySet<PlatformRole>;
  readonly enterpriseIds?: ReadonlySet<string>;
}

export interface OtpChallengeRecord {
  readonly id: string;
  readonly phoneE164: string;
  readonly purpose: OtpPurpose;
  readonly codeHmac: Uint8Array;
  readonly failedAttempts: number;
  readonly maxAttempts: number;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface SessionRecord {
  readonly id: string;
  readonly accountId: string;
  readonly csrfDigest: Uint8Array;
  readonly accountGeneration: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly loginSequence: string;
}

export type LoginFailureCode =
  | 'OTP_INVALID'
  | 'ACCOUNT_NOT_REGISTERED'
  | 'ACCOUNT_DISABLED'
  | 'LOGIN_PROCESSING_FAILED';

export interface AuthRepository {
  createOtpChallengeAfterRateCheck(
    input: {
      readonly id: string;
      readonly phoneE164: string;
      readonly purpose: OtpPurpose;
      readonly codeHmac: Uint8Array;
      readonly ipDigest: Uint8Array;
      readonly deviceDigest: Uint8Array;
      readonly expiresAt: Date;
      readonly maxAttempts: number;
      readonly limits: { readonly phone: number; readonly ip: number; readonly device: number; readonly windowMs: number };
    },
  ): Promise<void>;
  lockOtpChallenge<Result>(
    id: string,
    work: (client: SqlClient, challenge: OtpChallengeRecord) => Promise<Result>,
  ): Promise<Result>;
  markOtpFailed(client: SqlClient, id: string): Promise<void>;
  consumeOtp(client: SqlClient, id: string, consumedAt: Date): Promise<void>;
  findLoginAccount(client: SqlClient, phoneE164: string): Promise<AccountRecord | null>;
  registerLoginAccount(
    client: SqlClient,
    input: {
      readonly phoneE164: string;
      readonly displayName: string | null;
      readonly avatarId: number;
      readonly verifiedAt: Date;
      readonly grantAdministrator: boolean;
    },
  ): Promise<{ readonly account: AccountRecord; readonly registered: boolean }>;
  findAccountById(id: string): Promise<AccountRecord | null>;
  activateInvitedAccount(client: SqlClient, phoneE164: string, verifiedAt: Date, avatarId: number): Promise<AccountRecord | null>;
  createSessionWithLoginAudit(input: {
    readonly accountId: string;
    readonly tokenDigest: Uint8Array;
    readonly csrfDigest: Uint8Array;
    readonly accountGeneration: string;
    readonly expiresAt: Date;
    readonly actorRoles: readonly PlatformRole[];
    readonly requestId: string;
  }, client?: SqlClient): Promise<{ readonly sessionId: string; readonly loginSequence: string }>;
  recordLoginFailure(input: {
    readonly actorAccountId: string | null;
    readonly actorRoles: readonly PlatformRole[];
    readonly objectType: 'account' | 'otp_challenge';
    readonly objectId: string;
    readonly failureCode: LoginFailureCode;
    readonly requestId: string;
  }): Promise<void>;
  findSession(tokenDigest: Uint8Array): Promise<SessionRecord | null>;
  revokeSession(sessionId: string): Promise<void>;
  updateTheme(accountId: string, themeId: AccountRecord['themeId']): Promise<void>;
  updateAvatar(accountId: string, avatarId: number): Promise<void>;
  updateDisplayName(accountId: string, displayName: string | null): Promise<void>;
  bootstrapAdministrator(phoneE164: string, verifiedAt: Date): Promise<AccountRecord>;
  completePhoneChange(input: {
    readonly accountId: string;
    readonly oldChallengeId: string;
    readonly newChallengeId: string;
    readonly newPhoneE164: string;
    readonly now: Date;
    readonly actorRoles: readonly PlatformRole[];
    readonly requestId: string;
  }): Promise<void>;
}

export interface SmsProvider {
  readonly kind: 'SANDBOX' | 'TEMPORARY_ADMIN' | 'PRODUCTION';
  validateOtpRequest?(input: { readonly phoneE164: string; readonly purpose: OtpPurpose }): void;
  sendOtp(input: { readonly phoneE164: string; readonly purpose: OtpPurpose; readonly code: string }): Promise<void>;
}
