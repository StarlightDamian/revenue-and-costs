import { randomInt, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { migrate } from '../../src/db/migrate.js';
import type { AppConfig } from '../../src/shared/config.js';

const databaseUrl = process.env.AUTH_BILLING_TEST_DATABASE_URL;

interface Session { cookie: string; csrf: string }
interface EnterpriseResponse { id: string; wallet: { balanceCents: string }; profileComplete: boolean }

function cookieSession(response: { headers: Record<string, string | number | readonly string[] | undefined> }): Session {
  const raw = response.headers['set-cookie'];
  const lines = Array.isArray(raw) ? raw.map(String) : raw ? [String(raw)] : [];
  const cookie = lines.map((line) => line.split(';', 1)[0]).join('; ');
  const csrfLine = lines.find((line) => line.startsWith('rc_csrf='));
  const csrf = decodeURIComponent(csrfLine?.split(';', 1)[0]?.slice('rc_csrf='.length) ?? '');
  if (!cookie || !csrf) throw new Error('login cookies missing');
  return { cookie, csrf };
}

describe.skipIf(!databaseUrl).sequential('企业、做账员、企业钱包与公司运行时集成', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const publicOrigin = 'http://enterprise-runtime.test';
  const suffix = randomInt(10_000_000, 99_999_999).toString();
  const ownerPhone = `+861${suffix}01`;
  const invitedPhone = `+861${suffix}02`;
  const outsiderPhone = `+861${suffix}03`;
  const registrationAdminPhone = `+861${suffix}04`;
  let app: Awaited<ReturnType<typeof createApp>>;
  let owner!: Session;
  let invited!: Session;
  let outsider!: Session;
  let administrator!: Session;
  let firstEnterprise!: EnterpriseResponse;
  let workingEnterprise!: EnterpriseResponse;
  let companyId = '';

  beforeAll(async () => {
    await migrate(pool);
    const config: AppConfig = {
      mode: 'test', host: '127.0.0.1', port: 3000, databaseUrl: databaseUrl!, publicOrigin,
      otpHmacKey: 'otp-test-key-32-bytes-minimum-value',
      sessionHmacKey: 'session-test-key-32-bytes-minimum',
      paymentProvider: 'sandbox', smsProvider: 'sandbox', sandboxOtpCode: '246810',
      registrationAdminPhoneE164: registrationAdminPhone,
      chinaMoneyEnabled: false, chinaMoneyEndpointTemplate: undefined,
      chinaMoneyAuthorizationReference: undefined, chinaMoneyFixturePath: undefined,
      chinaMoneyHistoryStart: undefined,
      storageRoot: resolve('.work/test-enterprise-runtime-storage'), storageReplicaRoot: undefined,
      storagePolicy: 'LOCAL_VERIFIED', fileKekBase64: Buffer.alloc(32, 9).toString('base64'),
      remoteBackupTarget: undefined,
    };
    app = await createApp({ config, pool });
  });

  afterAll(async () => {
    await app?.close();
    await pool.end();
  });

  function writeHeaders(session: Session) {
    return { cookie: session.cookie, origin: publicOrigin, 'x-csrf-token': session.csrf };
  }

  async function requestOtp(phone: string, purpose: 'REGISTER' | 'LOGIN', device: string) {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/otp', headers: { origin: publicOrigin },
      payload: { phone, purpose, deviceId: `enterprise-${suffix}-${device}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ challengeId: string; sandboxCode: string }>();
  }

  async function register(phone: string, displayName?: string) {
    const challenge = await requestOtp(phone, 'REGISTER', `${phone.slice(-4)}-register`);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/register', headers: { origin: publicOrigin },
      payload: { challengeId: challenge.challengeId, phone, code: challenge.sandboxCode, purpose: 'REGISTER', ...(displayName ? { displayName } : {}) },
    });
    expect(response.statusCode).toBe(201);
    expect(response.headers['set-cookie']).toBeUndefined();
  }

  async function login(phone: string): Promise<Session> {
    const challenge = await requestOtp(phone, 'LOGIN', `${phone.slice(-4)}-login-${randomUUID()}`);
    const response = await app.inject({
      method: 'POST', url: '/api/v1/auth/verify', headers: { origin: publicOrigin },
      payload: { challengeId: challenge.challengeId, phone, code: challenge.sandboxCode, purpose: 'LOGIN' },
    });
    expect(response.statusCode).toBe(200);
    return cookieSession(response);
  }

  async function createEnterprise(session: Session, ordinal: string): Promise<EnterpriseResponse> {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/enterprises', headers: writeHeaders(session),
      payload: {
        name: `运行时企业-${suffix}-${ordinal}`,
        unifiedSocialCreditCode: `91310000${suffix}${ordinal.padStart(2, '0')}`,
      },
    });
    expect(response.statusCode).toBe(201);
    return response.json<EnterpriseResponse>();
  }

  it('支持可选姓名注册、受邀手机号直接登录、多企业激活和最后成员保护', async () => {
    const unknownChallenge = await requestOtp(ownerPhone, 'LOGIN', 'unknown-login');
    const unknown = await app.inject({
      method: 'POST', url: '/api/v1/auth/verify', headers: { origin: publicOrigin },
      payload: { challengeId: unknownChallenge.challengeId, phone: ownerPhone, code: unknownChallenge.sandboxCode, purpose: 'LOGIN' },
    });
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toMatchObject({ code: 'ACCOUNT_NOT_REGISTERED' });

    await register(ownerPhone);
    owner = await login(ownerPhone);
    const ownerMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: owner.cookie } });
    const ownerBody = ownerMe.json<{ roles: string[]; avatarId: number; wallet?: unknown; displayName?: string }>();
    expect(ownerBody.roles).toEqual(['ACCOUNTANT']);
    expect(ownerBody.avatarId).toBeGreaterThanOrEqual(1);
    expect(ownerBody.avatarId).toBeLessThanOrEqual(59);
    expect(ownerBody).not.toHaveProperty('wallet');
    expect(ownerBody).not.toHaveProperty('displayName');

    firstEnterprise = await createEnterprise(owner, '01');
    workingEnterprise = await createEnterprise(owner, '02');
    for (const enterprise of [firstEnterprise, workingEnterprise]) {
      const invitation = await app.inject({
        method: 'POST', url: `/api/v1/enterprises/${enterprise.id}/members`, headers: writeHeaders(owner),
        payload: { phone: invitedPhone, displayName: '受邀做账员' },
      });
      expect(invitation.statusCode).toBe(201);
      expect(invitation.json()).toMatchObject({ status: 'PENDING', displayName: '受邀做账员' });
    }

    invited = await login(invitedPhone);
    const invitedMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: invited.cookie } });
    expect(invitedMe.json()).toMatchObject({ roles: ['ACCOUNTANT'], displayName: '受邀做账员' });
    const enterprises = await app.inject({ method: 'GET', url: '/api/v1/enterprises', headers: { cookie: invited.cookie } });
    expect(enterprises.json<Array<{ id: string }>>().map(({ id }) => id).sort())
      .toEqual([firstEnterprise.id, workingEnterprise.id].sort());

    const firstMembers = await app.inject({ method: 'GET', url: `/api/v1/enterprises/${firstEnterprise.id}/members`, headers: { cookie: owner.cookie } });
    const activeMembers = firstMembers.json<Array<{ id: string; accountId?: string; status: string }>>();
    expect(activeMembers).toHaveLength(2);
    expect(activeMembers.every(({ status }) => status === 'ACTIVE')).toBe(true);
    const ownerAccount = await pool.query<{ id: string }>('SELECT id FROM account WHERE phone_e164=$1', [ownerPhone]);
    const ownerMember = activeMembers.find(({ accountId }) => accountId === ownerAccount.rows[0]!.id);
    expect(ownerMember).toBeDefined();
    const removed = await app.inject({
      method: 'DELETE', url: `/api/v1/enterprises/${firstEnterprise.id}/members/${ownerMember!.id}`,
      headers: writeHeaders(owner), payload: { reason: '协作关系调整' },
    });
    expect(removed.statusCode).toBe(204);
    const ownerLostAccess = await app.inject({ method: 'GET', url: `/api/v1/enterprises/${firstEnterprise.id}/members`, headers: { cookie: owner.cookie } });
    expect(ownerLostAccess.statusCode).toBe(404);

    const remaining = await app.inject({ method: 'GET', url: `/api/v1/enterprises/${firstEnterprise.id}/members`, headers: { cookie: invited.cookie } });
    const lastMember = remaining.json<Array<{ id: string }>>()[0]!;
    const lastMemberRejected = await app.inject({
      method: 'DELETE', url: `/api/v1/enterprises/${firstEnterprise.id}/members/${lastMember.id}`,
      headers: writeHeaders(invited), payload: { reason: '不能删除最后成员' },
    });
    expect(lastMemberRejected.statusCode).toBe(409);
    expect(lastMemberRejected.json()).toMatchObject({ code: 'ENTERPRISE_LAST_MEMBER' });
  });

  it('企业钱包无折扣、188 元扣费、协同做账、跨企业 404 与客户关系相互独立', async () => {
    const quote = await app.inject({
      method: 'POST', url: '/api/v1/payments/quote', headers: writeHeaders(owner),
      payload: { enterpriseId: workingEnterprise.id, creditAmountCents: '20000' },
    });
    expect(quote.statusCode).toBe(200);
    expect(quote.json()).toMatchObject({ creditAmountCents: '20000', payableAmountCents: '20000', discountBasisPoints: '10000' });

    const topUpKey = `topup-${randomUUID()}`;
    const topUps = await Promise.all([1, 2].map(() => app.inject({
      method: 'POST', url: '/api/v1/payments/sandbox/orders',
      headers: { ...writeHeaders(owner), 'idempotency-key': topUpKey },
      payload: { enterpriseId: workingEnterprise.id, creditAmountCents: '20000' },
    })));
    expect(topUps.map(({ statusCode }) => statusCode)).toEqual([200, 200]);
    expect(topUps.every((response) => response.json().status === 'PAID')).toBe(true);

    const applications = await app.inject({ method: 'GET', url: '/api/v1/apps', headers: { cookie: owner.cookie } });
    const amazon = applications.json<Array<{ id: string; code: string }>>().find(({ code }) => code === 'amazon-sales-cost');
    expect(amazon).toBeDefined();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/shops',
      headers: { ...writeHeaders(owner), 'idempotency-key': `company-${randomUUID()}` },
      payload: {
        enterpriseId: workingEnterprise.id, applicationId: amazon!.id,
        name: `运行时公司-${suffix}`, startDate: '2026-08-01', requestedCloseDate: '2027-08-01',
      },
    });
    expect(created.statusCode).toBe(200);
    const company = created.json<{ id: string; enterpriseId: string; accountingStatus: string; createdByAccountId: string; lastOperatedByAccountId: string }>();
    companyId = company.id;
    expect(company).toMatchObject({ enterpriseId: workingEnterprise.id, accountingStatus: 'NOT_STARTED' });
    expect(company.createdByAccountId).toBe(company.lastOperatedByAccountId);

    const enterpriseAfterCharge = await app.inject({ method: 'GET', url: '/api/v1/enterprises', headers: { cookie: owner.cookie } });
    expect(enterpriseAfterCharge.json<EnterpriseResponse[]>().find(({ id }) => id === workingEnterprise.id)?.wallet.balanceCents).toBe('1200');
    const ledger = await app.inject({
      method: 'GET', url: `/api/v1/payments/ledger?enterpriseId=${workingEnterprise.id}`, headers: { cookie: owner.cookie },
    });
    expect(ledger.json()).toEqual([
      expect.objectContaining({ type: 'SHOP_CHARGE', amountCents: '-18800', balanceAfterCents: '1200' }),
      expect.objectContaining({ type: 'TOP_UP', amountCents: '20000', balanceAfterCents: '20000' }),
    ]);

    const collaboratorCompanies = await app.inject({
      method: 'GET', url: `/api/v1/shops?enterpriseId=${workingEnterprise.id}`, headers: { cookie: invited.cookie },
    });
    expect(collaboratorCompanies.statusCode).toBe(200);
    expect(collaboratorCompanies.json()).toEqual([expect.objectContaining({ id: companyId, access: 'ENTERPRISE' })]);
    const renamed = await app.inject({
      method: 'PATCH', url: `/api/v1/shops/${companyId}/name`, headers: writeHeaders(invited),
      payload: { name: `协同公司-${suffix}` },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ lastOperatedByAccountId: expect.any(String) });
    expect(renamed.json().lastOperatedByAccountId).not.toBe(company.createdByAccountId);

    await register(outsiderPhone, '外部做账员');
    outsider = await login(outsiderPhone);
    const crossEnterprise = await app.inject({
      method: 'GET', url: `/api/v1/shops?enterpriseId=${workingEnterprise.id}`, headers: { cookie: outsider.cookie },
    });
    expect(crossEnterprise.statusCode).toBe(404);

    const customerInvitation = await app.inject({
      method: 'POST', url: `/api/v1/shops/${companyId}/invitations`,
      headers: { ...writeHeaders(owner), 'idempotency-key': `customer-${randomUUID()}` },
      payload: { phone: outsiderPhone, exportAllowed: false },
    });
    expect(customerInvitation.statusCode).toBe(200);
    expect(customerInvitation.json()).toMatchObject({ status: 'ACTIVE' });
    const outsiderMe = await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: outsider.cookie } });
    expect(outsiderMe.json()).toMatchObject({ roles: ['ACCOUNTANT'], customerShopCount: 1 });
    const customerCompanies = await app.inject({ method: 'GET', url: '/api/v1/shops', headers: { cookie: outsider.cookie } });
    expect(customerCompanies.json()).toEqual([expect.objectContaining({ id: companyId, access: 'CUSTOMER' })]);
    const forbiddenRename = await app.inject({
      method: 'PATCH', url: `/api/v1/shops/${companyId}/name`, headers: writeHeaders(outsider), payload: { name: '越权改名' },
    });
    expect(forbiddenRename.statusCode).toBe(404);
  });

  it('管理员免费多年计费写入原价，并在升降级后吊销旧会话且保留客户关系', async () => {
    await register(registrationAdminPhone, '运行时管理员');
    administrator = await login(registrationAdminPhone);
    const applications = await app.inject({ method: 'GET', url: '/api/v1/apps', headers: { cookie: administrator.cookie } });
    const amazon = applications.json<Array<{ id: string; code: string }>>().find(({ code }) => code === 'amazon-sales-cost')!;
    const adminCompany = await app.inject({
      method: 'POST', url: '/api/v1/shops',
      headers: { ...writeHeaders(administrator), 'idempotency-key': `admin-company-${randomUUID()}` },
      payload: {
        enterpriseId: workingEnterprise.id, applicationId: amazon.id,
        name: `管理员免费公司-${suffix}`, startDate: '2026-08-01', requestedCloseDate: '2028-08-01',
      },
    });
    expect(adminCompany.statusCode).toBe(200);
    const charge = await pool.query<{
      original_amount_cents: string; charged_amount_cents: string; waiver_type: string | null; waiver_reason: string | null; wallet_ledger_id: string | null;
    }>(
      `SELECT original_amount_cents,charged_amount_cents,waiver_type,waiver_reason,wallet_ledger_id
         FROM shop_charge WHERE shop_id=$1`,
      [adminCompany.json<{ id: string }>().id],
    );
    expect(charge.rows[0]).toEqual({
      original_amount_cents: '37600', charged_amount_cents: '0', waiver_type: 'ADMIN_FREE',
      waiver_reason: null, wallet_ledger_id: null,
    });

    const outsiderAccount = await pool.query<{ id: string }>('SELECT id FROM account WHERE phone_e164=$1', [outsiderPhone]);
    const promoted = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/users/${outsiderAccount.rows[0]!.id}/admin-role`,
      headers: writeHeaders(administrator), payload: { enabled: true, reason: '运行时升管理员' },
    });
    expect(promoted.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: outsider.cookie } })).statusCode).toBe(401);
    outsider = await login(outsiderPhone);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: outsider.cookie } })).json())
      .toMatchObject({ roles: ['ADMIN'], customerShopCount: 1 });

    const demoted = await app.inject({
      method: 'PATCH', url: `/api/v1/admin/users/${outsiderAccount.rows[0]!.id}/admin-role`,
      headers: writeHeaders(administrator), payload: { enabled: false, reason: '运行时降回做账员' },
    });
    expect(demoted.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: outsider.cookie } })).statusCode).toBe(401);
    outsider = await login(outsiderPhone);
    expect((await app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: outsider.cookie } })).json())
      .toMatchObject({ roles: ['ACCOUNTANT'], customerShopCount: 1 });
    const retainedCustomer = await app.inject({ method: 'GET', url: '/api/v1/shops', headers: { cookie: outsider.cookie } });
    expect(retainedCustomer.json()).toEqual([expect.objectContaining({ id: companyId, access: 'CUSTOMER' })]);
  });
});
