import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { operationalReadiness } from '../../src/modules/operations/readiness.js';
import type { AppConfig } from '../../src/shared/config.js';

const productionConfig: AppConfig = {
  mode: 'production',
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://redacted',
  publicOrigin: 'https://example.test',
  otpHmacKey: 'o'.repeat(32),
  sessionHmacKey: 's'.repeat(32),
  paymentProvider: 'wechat',
  smsProvider: 'provider',
  chinaMoneyEnabled: true,
  chinaMoneyEndpointTemplate: 'https://www.chinamoney.com.cn/{from}/{to}/{page}/{pageSize}',
  chinaMoneyAuthorizationReference: 'approval-reference',
  chinaMoneyFixturePath: undefined,
  chinaMoneyHistoryStart: '2020-01-01',
  storageRoot: tmpdir(),
  storageReplicaRoot: `${tmpdir()}-offsite-mount`,
  storagePolicy: 'REMOTE_REQUIRED',
  fileKekBase64: Buffer.alloc(32, 1).toString('base64'),
  remoteBackupTarget: 'offsite-backup-vault',
};

function poolWithEvidence(evidence: Record<string, unknown>): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('migration_count')) {
      return { rows: [{ migration_count: '21', queue_table: 'pgboss.job' }], rowCount: 1 };
    }
    if (sql.includes('backup_fresh')) return { rows: [evidence], rowCount: 1 };
    throw new Error(`unexpected readiness query: ${sql}`);
  });
  return { query } as unknown as Pool;
}

describe('production recovery readiness', () => {
  it('does not treat configured local paths as proof of offsite backup or recovery', async () => {
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: false,
        recovery_fresh: false,
        remote_object_count: '0',
        invalid_remote_object_count: '0',
      }),
    );
    const byName = new Map(checks.map((check) => [check.name, check]));
    expect(byName.get('backup-evidence')?.status).toBe('blocked');
    expect(byName.get('recovery-evidence')?.status).toBe('blocked');
    expect(byName.get('object-replication-evidence')?.status).toBe('blocked');
  });

  it('accepts only fresh offsite backup, verified restore, and valid remote object replica evidence', async () => {
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: true,
        recovery_fresh: true,
        remote_object_count: '2',
        invalid_remote_object_count: '0',
      }),
    );
    const recovery = checks.filter((check) => check.name.endsWith('-evidence'));
    expect(recovery).toEqual([
      expect.objectContaining({ name: 'backup-evidence', status: 'ok' }),
      expect.objectContaining({ name: 'recovery-evidence', status: 'ok' }),
      expect.objectContaining({ name: 'object-replication-evidence', status: 'ok' }),
    ]);
  });
});
