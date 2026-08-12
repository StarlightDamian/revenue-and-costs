import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export function normalizePhone(phone: string): string {
  const normalized = phone.trim().replace(/[\s()-]/g, '');
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) throw new Error('手机号必须使用 E.164 格式');
  return normalized;
}

export function maskPhone(phone: string): string {
  const normalized = phone.trim();
  const chineseNationalNumber = /^\+86([0-9]{11})$/u.exec(normalized)?.[1];
  if (chineseNationalNumber) {
    return `+86 ${chineseNationalNumber.slice(0, 3)}****${chineseNationalNumber.slice(-4)}`;
  }
  return normalized.length <= 7 ? '***' : `${normalized.slice(0, 4)}****${normalized.slice(-4)}`;
}

export function createOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function otpHmac(
  secret: Uint8Array,
  challengeId: string,
  phone: string,
  purpose: string,
  code: string,
): Uint8Array {
  return createHmac('sha256', secret)
    .update(challengeId)
    .update('\0')
    .update(phone)
    .update('\0')
    .update(purpose)
    .update('\0')
    .update(code)
    .digest();
}

export function privacyDigest(secret: Uint8Array, value: string): Uint8Array {
  return createHmac('sha256', secret).update(value).digest();
}

export function tokenDigest(token: string): Uint8Array {
  return createHash('sha256').update(token).digest();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}
