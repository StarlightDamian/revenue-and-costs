import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, cnyToCents } from '../../src/web/api/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Web/API 适配契约', () => {
  it('直接消费服务端规范公司字段，不维护第二套状态映射', async () => {
    const shop = {
      id: 'shop-1',
      enterpriseId: 'enterprise-1',
      createdByAccountId: 'account-1',
      lastOperatedByAccountId: 'account-2',
      name: '测试公司',
      access: 'ENTERPRISE',
      accountingStatus: 'NOT_STARTED',
      status: 'EXPIRED',
      termStart: '2024-02-29',
      termEndExclusive: '2025-02-28',
      renameAvailable: false,
      publishedSnapshot: { id: 'snapshot-1', publishedAt: '2026-07-28T00:00:00.000Z', stale: true },
      customerExportAllowed: true,
    } as const;
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([shop]), {
      headers: { 'content-type': 'application/json' },
    })));

    await expect(api.listShops()).resolves.toEqual([shop]);
  });

  it('充值页面金额使用 bigint 精确转分', () => {
    expect(cnyToCents('100.01')).toBe('10001');
    expect(cnyToCents('20000')).toBe('2000000');
    expect(() => cnyToCents('100.001')).toThrow();
    expect(() => cnyToCents('-1')).toThrow();
  });
});
