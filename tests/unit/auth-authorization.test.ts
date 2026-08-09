import { describe, expect, it } from 'vitest';
import { constantTimeEqual, normalizePhone, otpHmac, tokenDigest } from '../../src/modules/auth/index.js';
import {
  authorizePlatform,
  authorizeShop,
  type Actor,
  type CustomerMembership,
} from '../../src/modules/authorization/index.js';

const user: Actor = { accountId: 'user-1', status: 'ACTIVE', roles: new Set(['ACCOUNTANT']), enterpriseIds: new Set(['enterprise-1']) };
const admin: Actor = { accountId: 'admin-1', status: 'ACTIVE', roles: new Set(['ADMIN']) };
const customerOnly: Actor = { accountId: 'customer-1', status: 'ACTIVE', roles: new Set(['ACCOUNTANT']) };
const shop = { id: 'shop-1', enterpriseId: 'enterprise-1', state: 'ACTIVE' as const };
const membership: CustomerMembership = {
  id: 'membership-1',
  shopId: shop.id,
  accountId: customerOnly.accountId,
  status: 'ACTIVE',
  exportAllowed: false,
  authorizationEpoch: '1',
};

describe('OTP 和令牌密码学边界', () => {
  it('HMAC 绑定 challenge、手机号、用途和验证码', () => {
    const secret = Buffer.alloc(32, 7);
    const expected = otpHmac(secret, 'challenge-a', '+8613800000000', 'LOGIN', '123456');
    expect(constantTimeEqual(expected, otpHmac(secret, 'challenge-a', '+8613800000000', 'LOGIN', '123456'))).toBe(true);
    expect(constantTimeEqual(expected, otpHmac(secret, 'challenge-b', '+8613800000000', 'LOGIN', '123456'))).toBe(false);
    expect(constantTimeEqual(expected, otpHmac(secret, 'challenge-a', '+8613800000000', 'PHONE_CHANGE_NEW', '123456'))).toBe(false);
  });

  it('只接受规范 E.164 手机号且令牌只保留摘要', () => {
    expect(normalizePhone('+86 138 0000 0000')).toBe('+8613800000000');
    expect(() => normalizePhone('13800000000')).toThrow();
    expect(Buffer.from(tokenDigest('secret-token')).toString('utf8')).not.toContain('secret-token');
  });
});

describe('平台角色与公司客户关系相互独立', () => {
  it('公司客户仍可作为做账员创建企业和公司', () => {
    expect(authorizePlatform(customerOnly, 'FX_READ').allowed).toBe(true);
    expect(authorizePlatform(customerOnly, 'ENTERPRISE_CREATE').allowed).toBe(true);
    expect(authorizePlatform(customerOnly, 'SHOP_CREATE').allowed).toBe(true);
  });

  it('ACCOUNTANT 使用钱包建店，ADMIN 可免费建店但不参与钱包消费', () => {
    expect(authorizePlatform(user, 'ENTERPRISE_CREATE').allowed).toBe(true);
    expect(authorizePlatform(user, 'SHOP_CREATE').allowed).toBe(true);
    expect(authorizePlatform(admin, 'SHOP_CREATE')).toMatchObject({ allowed: true, scope: 'ADMIN' });
    expect(authorizePlatform(admin, 'ENTERPRISE_CREATE').allowed).toBe(false);
    expect(authorizePlatform(admin, 'FX_READ').allowed).toBe(true);
  });

  it('客户只能读取已发布结果，导出默认关闭且永远不能下载原件', () => {
    expect(authorizeShop(customerOnly, shop, membership, 'PUBLISHED_RESULT_READ').allowed).toBe(true);
    expect(authorizeShop(customerOnly, shop, membership, 'DRAFT_RESULT_READ').allowed).toBe(false);
    expect(authorizeShop(customerOnly, shop, membership, 'RESULT_EXPORT').allowed).toBe(false);
    expect(authorizeShop(customerOnly, shop, { ...membership, exportAllowed: true }, 'RESULT_EXPORT').allowed).toBe(true);
    expect(authorizeShop(customerOnly, shop, { ...membership, exportAllowed: true }, 'ORIGINAL_DOWNLOAD').allowed).toBe(false);
  });

  it('撤销 membership 后立即拒绝，管理员下载原件要求原因', () => {
    expect(authorizeShop(customerOnly, shop, { ...membership, status: 'REVOKED' }, 'PUBLISHED_RESULT_READ').allowed).toBe(false);
    expect(authorizeShop(admin, shop, null, 'ORIGINAL_DOWNLOAD')).toMatchObject({ allowed: true, reasonRequired: true });
  });

  it('过期店铺只读但允许续期，回收站只允许查看/恢复/墓碑', () => {
    const owner: Actor = { accountId: 'owner-1', status: 'ACTIVE', roles: new Set(['ACCOUNTANT']), enterpriseIds: new Set([shop.enterpriseId]) };
    const expired = { ...shop, state: 'EXPIRED_READONLY' as const };
    expect(authorizeShop(owner, expired, null, 'UPLOAD').allowed).toBe(false);
    expect(authorizeShop(owner, expired, null, 'SHOP_RENEW').allowed).toBe(true);
    expect(authorizeShop(owner, expired, null, 'MEMBERSHIP_MANAGE').allowed).toBe(true);
    expect(authorizeShop(admin, expired, null, 'UPLOAD').allowed).toBe(false);
    const trashed = { ...shop, state: 'TRASHED' as const };
    expect(authorizeShop(owner, trashed, null, 'SHOP_RESTORE').allowed).toBe(true);
    expect(authorizeShop(owner, trashed, null, 'RESULT_EXPORT').allowed).toBe(false);
    expect(authorizeShop(customerOnly, trashed, membership, 'PUBLISHED_RESULT_READ').allowed).toBe(false);
  });

  it('禁用账户的所有能力都被拒绝', () => {
    const disabled: Actor = { ...user, status: 'DISABLED' };
    expect(authorizePlatform(disabled, 'FX_READ').allowed).toBe(false);
    expect(authorizeShop(disabled, shop, null, 'SHOP_READ').allowed).toBe(false);
  });
});
