import { tmpdir } from 'node:os';
import type { Pool } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readMigrationManifest } from '../../src/db/migrate.js';
import { operationalReadiness } from '../../src/modules/operations/readiness.js';
import type { AppConfig } from '../../src/shared/config.js';

const { statfsMock } = vi.hoisted(() => ({ statfsMock: vi.fn() }));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  statfs: statfsMock,
}));

const currentMigrationManifest = await readMigrationManifest();

const productionConfig: AppConfig = {
  mode: 'production',
  host: '127.0.0.1',
  port: 3000,
  databaseUrl: 'postgresql://redacted',
  publicOrigin: 'https://example.test',
  appBasePath: '/revenue-costs',
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

function poolWithEvidence(
  evidence: Record<string, unknown>,
  workerReady = true,
  appliedMigrations = currentMigrationManifest,
): Pool {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('applied_migrations')) {
      return { rows: [{
        applied_migrations: appliedMigrations,
        queue_table: 'pgboss.job',
        worker_ready: workerReady,
        usable_connections: 17,
      }], rowCount: 1 };
    }
    if (sql.includes('backup_fresh')) return { rows: [evidence], rowCount: 1 };
    throw new Error(`unexpected readiness query: ${sql}`);
  });
  return { query } as unknown as Pool;
}

describe('production recovery readiness', () => {
  beforeEach(() => {
    const oneGiB = 1n * 1024n * 1024n * 1024n;
    statfsMock.mockReset();
    statfsMock.mockResolvedValue({ bavail: oneGiB * 2n, bsize: 1n });
  });

  it('applies an inclusive 1 GiB runtime storage floor to operational readiness', async () => {
    const oneGiB = 1n * 1024n * 1024n * 1024n;
    const evidence = {
      backup_fresh: true,
      recovery_fresh: true,
      stored_object_count: '0',
      unreplicated_object_count: '0',
    };
    statfsMock.mockResolvedValueOnce({ bavail: oneGiB - 1n, bsize: 1n });
    const blocked = await operationalReadiness(productionConfig, poolWithEvidence(evidence));
    expect(blocked).toContainEqual({
      name: 'storage',
      status: 'blocked',
      detail: `${oneGiB - 1n} free bytes; ${oneGiB} required`,
    });

    statfsMock.mockResolvedValueOnce({ bavail: oneGiB, bsize: 1n });
    const accepted = await operationalReadiness(productionConfig, poolWithEvidence(evidence));
    expect(accepted).toContainEqual({
      name: 'storage',
      status: 'ok',
      detail: `${oneGiB} free bytes; ${oneGiB} required`,
    });
  });

  it('reports explicitly accepted pilot gaps as degraded while preserving core readiness checks', async () => {
    const checks = await operationalReadiness(
      {
        ...productionConfig,
        temporaryDegradedProduction: true,
        smsProvider: 'temporary-admin-fixed',
        paymentProvider: 'temporary-manual',
        chinaMoneyEnabled: false,
        storagePolicy: 'LOCAL_VERIFIED',
        storageReplicaRoot: undefined,
        remoteBackupTarget: undefined,
      },
      poolWithEvidence({
        backup_fresh: false,
        recovery_fresh: false,
        stored_object_count: '0',
        unreplicated_object_count: '0',
      }),
    );

    const byName = new Map(checks.map((check) => [check.name, check]));
    expect(byName.get('database')?.status).toBe('ok');
    expect(byName.get('migrations')?.status).toBe('ok');
    expect(byName.get('worker')?.status).toBe('ok');
    expect(byName.get('external-targets')?.status).toBe('degraded');
    expect(byName.get('backup-evidence')?.status).toBe('degraded');
    expect(byName.get('sms')?.status).toBe('degraded');
    expect(byName.get('payment')?.status).toBe('degraded');
    expect(byName.get('china-money')?.status).toBe('degraded');
    expect(checks.some((check) => check.status === 'blocked')).toBe(false);
  });

  it('blocks readiness when the worker heartbeat is missing or stale', async () => {
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: true,
        recovery_fresh: true,
        stored_object_count: '2',
        unreplicated_object_count: '0',
      }, false),
    );

    expect(checks).toContainEqual({ name: 'worker', status: 'blocked', detail: 'heartbeat missing or stale' });
  });

  it('blocks readiness when the shared PostgreSQL cluster cannot satisfy the bounded runtime budget', async () => {
    const pool = poolWithEvidence({}) as unknown as { query: ReturnType<typeof vi.fn> };
    pool.query.mockImplementation(async (sql: string) => {
      if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
      if (sql.includes('applied_migrations')) {
        return { rows: [{
          applied_migrations: currentMigrationManifest,
          queue_table: 'pgboss.job',
          worker_ready: true,
          usable_connections: 14,
        }], rowCount: 1 };
      }
      if (sql.includes('backup_fresh')) {
        return { rows: [{
          backup_fresh: true,
          recovery_fresh: true,
          stored_object_count: '0',
          unreplicated_object_count: '0',
        }], rowCount: 1 };
      }
      throw new Error(`unexpected readiness query: ${sql}`);
    });

    const checks = await operationalReadiness(productionConfig, pool as unknown as Pool);

    expect(checks).toContainEqual(expect.objectContaining({
      name: 'database-connections',
      status: 'blocked',
    }));
  });

  it('does not treat configured local paths as proof of offsite backup or recovery', async () => {
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: false,
        recovery_fresh: false,
        stored_object_count: '0',
        unreplicated_object_count: '0',
      }),
    );
    const byName = new Map(checks.map((check) => [check.name, check]));
    expect(byName.get('backup-evidence')?.status).toBe('blocked');
    expect(byName.get('recovery-evidence')?.status).toBe('blocked');
    expect(byName.get('object-replication-evidence')?.status).toBe('ok');
  });

  it('accepts only fresh offsite backup, verified restore, and valid remote object replica evidence', async () => {
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: true,
        recovery_fresh: true,
        stored_object_count: '2',
        unreplicated_object_count: '0',
      }),
    );
    const recovery = checks.filter((check) => check.name.endsWith('-evidence'));
    expect(recovery).toEqual([
      expect.objectContaining({ name: 'backup-evidence', status: 'ok' }),
      expect.objectContaining({ name: 'recovery-evidence', status: 'ok' }),
      expect.objectContaining({ name: 'object-replication-evidence', status: 'ok' }),
    ]);
  });

  it('blocks readiness when any current migration filename or checksum differs', async () => {
    const mismatched = currentMigrationManifest.map((migration, index) => index === 0
      ? { ...migration, checksum: '0'.repeat(64) }
      : migration);
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: true,
        recovery_fresh: true,
        stored_object_count: '0',
        unreplicated_object_count: '0',
      }, true, mismatched),
    );

    expect(checks).toContainEqual(expect.objectContaining({ name: 'migrations', status: 'blocked' }));
  });

  it('blocks readiness when one stored object lacks a matching verified offsite replica', async () => {
    const checks = await operationalReadiness(
      productionConfig,
      poolWithEvidence({
        backup_fresh: true,
        recovery_fresh: true,
        stored_object_count: '2',
        unreplicated_object_count: '1',
      }),
    );

    expect(checks).toContainEqual(expect.objectContaining({
      name: 'object-replication-evidence',
      status: 'blocked',
    }));
  });
});
