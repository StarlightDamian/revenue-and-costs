import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { readMigrationManifest } from '../../src/db/migrate.js';
import { REQUIRED_USABLE_CONNECTIONS } from '../../src/db/connection-budget.js';
import type { AppConfig } from '../../src/shared/config.js';

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

describe('temporary production health', () => {
  it('starts with the controlled recharge provider and reports accepted gaps as degraded readiness', async () => {
    process.env.NODE_ENV = 'production';
    const migrationManifest = await readMigrationManifest();
    const pool = {
      async query(sql: string) {
        if (sql === 'SELECT 1') return { rows: [{ '?column?': 1 }], rowCount: 1 };
        if (sql.includes('schema_migration')) {
          return {
            rows: [{
              applied_migrations: migrationManifest,
              queue_table: 'pgboss.job',
              worker_ready: true,
              usable_connections: REQUIRED_USABLE_CONNECTIONS,
            }],
            rowCount: 1,
          };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Pool;
    const config: AppConfig = {
      mode: 'production',
      host: '127.0.0.1',
      port: 4282,
      databaseUrl: 'postgresql://redacted',
      databaseCapacityPath: process.cwd(),
      publicOrigin: 'https://www.googcci.com.cn',
      appBasePath: '/revenue-costs',
      otpHmacKey: 'o'.repeat(32),
      sessionHmacKey: 's'.repeat(32),
      paymentProvider: 'temporary-manual',
      smsProvider: 'temporary-admin-fixed',
      temporaryAdminOtpCode: '246810',
      temporaryDegradedProduction: true,
      registrationAdminPhoneE164: '+8613800000000',
      chinaMoneyEnabled: false,
      chinaMoneyEndpointTemplate: undefined,
      chinaMoneyAuthorizationReference: undefined,
      chinaMoneyFixturePath: undefined,
      chinaMoneyHistoryStart: undefined,
      storageRoot: process.cwd(),
      exportOutputRoot: resolve('.work/test-temporary-production-exports'),
      storageReplicaRoot: undefined,
      storagePolicy: 'LOCAL_VERIFIED',
      fileKekBase64: Buffer.alloc(32, 1).toString('base64'),
      remoteBackupTarget: undefined,
    };
    const app = await createApp({ config, pool });

    try {
      const response = await app.inject({ method: 'GET', url: '/health/ready' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'degraded', service: 'api' });
    } finally {
      await app.close();
    }
  });
});
