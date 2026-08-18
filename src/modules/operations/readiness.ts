import { createHash } from "node:crypto";
import { access, constants, mkdir, statfs } from "node:fs/promises";
import type { Pool } from "pg";
import type { AppConfig } from "../../shared/config";
import { readMigrationManifest, type MigrationManifestEntry } from "../../db/migrate.js";
import {
  DATABASE_POOL_LIMITS,
  REQUIRED_USABLE_CONNECTIONS,
  SHARED_CLUSTER_CONNECTION_RESERVE,
  STEADY_STATE_CONNECTION_BUDGET,
} from "../../db/connection-budget.js";

export interface ReadinessCheck { name: string; status: "ok" | "degraded" | "blocked"; detail: string }

const BACKUP_FRESHNESS_MS = 26 * 60 * 60 * 1000;
const RESTORE_DRILL_FRESHNESS_MS = 93 * 24 * 60 * 60 * 1000;
const READINESS_STORAGE_FREE_SPACE_FLOOR_BYTES = 1n * 1024n * 1024n * 1024n;

function referenceDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

let expectedMigrationManifest: Promise<readonly MigrationManifestEntry[]> | undefined;

function currentMigrationManifest(): Promise<readonly MigrationManifestEntry[]> {
  expectedMigrationManifest ??= readMigrationManifest();
  return expectedMigrationManifest;
}

export async function operationalReadiness(config: AppConfig, pool: Pool): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  try {
    await pool.query("SELECT 1");
    checks.push({ name: "database", status: "ok", detail: "connected" });
    const expectedMigrations = await currentMigrationManifest();
    const schema = await pool.query<{
      applied_migrations: MigrationManifestEntry[];
      queue_table: string | null;
      worker_ready: boolean;
      usable_connections: number;
    }>(
      `SELECT COALESCE((SELECT jsonb_agg(jsonb_build_object('filename',filename,'checksum',checksum) ORDER BY filename)
                         FROM schema_migration),'[]'::jsonb) AS applied_migrations,
              to_regclass('pgboss.job')::text AS queue_table,
              current_setting('max_connections')::integer
                - current_setting('superuser_reserved_connections')::integer
                - COALESCE(current_setting('reserved_connections', true), '0')::integer
                AS usable_connections,
              COALESCE((SELECT status='RUNNING'
                                AND last_heartbeat_at >= clock_timestamp() - interval '60 seconds'
                          FROM job_operation
                         WHERE business_key='service:worker'),false) AS worker_ready`,
    );
    const row = schema.rows[0];
    const appliedMigrations = row?.applied_migrations ?? [];
    const migrationsMatch = appliedMigrations.length === expectedMigrations.length
      && expectedMigrations.every(({ filename, checksum }, index) =>
        appliedMigrations[index]?.filename === filename && appliedMigrations[index]?.checksum === checksum);
    checks.push({
      name: "migrations",
      status: migrationsMatch ? "ok" : "blocked",
      detail: migrationsMatch
        ? `${expectedMigrations.length} current migrations applied`
        : `${appliedMigrations.length}/${expectedMigrations.length} migrations; ordered filename/checksum mismatch`,
    });
    checks.push({ name: "queue", status: row?.queue_table ? "ok" : "blocked", detail: row?.queue_table ? "pgboss schema present" : "pgboss schema missing" });
    checks.push({ name: "worker", status: row?.worker_ready ? "ok" : "blocked", detail: row?.worker_ready ? "heartbeat fresh" : "heartbeat missing or stale" });
    const usableConnections = row?.usable_connections ?? 0;
    checks.push({
      name: "database-connections",
      status: usableConnections >= REQUIRED_USABLE_CONNECTIONS ? "ok" : "blocked",
      detail: usableConnections >= REQUIRED_USABLE_CONNECTIONS
        ? `${usableConnections} usable; ${REQUIRED_USABLE_CONNECTIONS} required`
        : `${usableConnections} usable; requires ${STEADY_STATE_CONNECTION_BUDGET} runtime + ${SHARED_CLUSTER_CONNECTION_RESERVE} shared service + ${DATABASE_POOL_LIMITS.cli} release`,
    });
  }
  catch { checks.push({ name: "database", status: "blocked", detail: "unavailable" }); }
  try {
    if (config.mode !== "production") await mkdir(config.storageRoot, { recursive: true });
    await access(config.storageRoot, constants.R_OK | constants.W_OK);
    const disk = await statfs(config.storageRoot, { bigint: true });
    const free = disk.bavail * disk.bsize;
    checks.push({
      name: "storage",
      status: free >= READINESS_STORAGE_FREE_SPACE_FLOOR_BYTES ? "ok" : "blocked",
      detail: `${free} free bytes; ${READINESS_STORAGE_FREE_SPACE_FLOOR_BYTES} required`,
    });
  } catch { checks.push({ name: "storage", status: "blocked", detail: "not readable and writable" }); }
  if (config.mode === "production") {
    const acceptedMissingExternalStatus = config.temporaryDegradedProduction ? "degraded" : "blocked";
    const externalTargetsConfigured = Boolean(
      config.storageReplicaRoot &&
      config.remoteBackupTarget &&
      config.storageReplicaRoot !== config.storageRoot,
    );
    checks.push({
      name: "external-targets",
      status: externalTargetsConfigured ? "ok" : acceptedMissingExternalStatus,
      detail: externalTargetsConfigured ? "configured; evidence checked separately" : "missing or aliases primary storage",
    });
    if (externalTargetsConfigured && config.storageReplicaRoot && config.remoteBackupTarget) {
      try {
        const backupTargetDigest = referenceDigest(config.remoteBackupTarget);
        const replicaTargetDigest = referenceDigest(config.storageReplicaRoot);
        const evidence = await pool.query<{
          backup_fresh: boolean;
          recovery_fresh: boolean;
          stored_object_count: string;
          unreplicated_object_count: string;
        }>(
          `SELECT
             EXISTS (
               SELECT 1 FROM backup_run
                WHERE status = 'SUCCEEDED' AND target_kind = 'OFFSITE'
                  AND target_reference_sha256 = $1
                  AND finished_at >= $2
                  AND manifest_sha256 ~ '^[0-9a-f]{64}$'
                  AND manifest_hmac_sha256 ~ '^[0-9a-f]{64}$'
                  AND details->>'encryptionFormat' = 'AWS_ESDK_V2_FRAMED'
                  AND details->>'plaintextSha256' ~ '^[0-9a-f]{64}$'
                  AND details->>'ciphertextSha256' ~ '^[0-9a-f]{64}$'
             ) AS backup_fresh,
             EXISTS (
               SELECT 1 FROM recovery_checkpoint
                WHERE status = 'VERIFIED' AND checkpoint_kind = 'FULL_RESTORE_TEST'
                  AND target_kind = 'OFFSITE' AND target_reference_sha256 = $1
                  AND verified_at >= $3
                  AND manifest_sha256 ~ '^[0-9a-f]{64}$'
                  AND manifest_hmac_sha256 ~ '^[0-9a-f]{64}$'
                  AND details->>'validationVersion' = '2'
                  AND details->>'objectManifestSha256' ~ '^[0-9a-f]{64}$'
             ) AS recovery_fresh,
             (SELECT count(*)::text FROM stored_object) AS stored_object_count,
             (SELECT count(*)::text FROM stored_object so
               WHERE NOT EXISTS (
                   SELECT 1 FROM stored_object_replica sor
                    WHERE sor.object_id = so.id AND sor.status = 'VERIFIED'
                      AND sor.replica_kind = 'OFFSITE'
                      AND sor.target_reference_sha256 = $4
                      AND sor.ciphertext_sha256 = so.ciphertext_sha256
                      AND sor.verified_at IS NOT NULL
                 )) AS unreplicated_object_count`,
          [
            backupTargetDigest,
            new Date(Date.now() - BACKUP_FRESHNESS_MS),
            new Date(Date.now() - RESTORE_DRILL_FRESHNESS_MS),
            replicaTargetDigest,
          ],
        );
        const row = evidence.rows[0];
        const storedObjectCount = BigInt(row?.stored_object_count ?? "0");
        const unreplicatedObjectCount = BigInt(row?.unreplicated_object_count ?? "0");
        checks.push({
          name: "backup-evidence",
          status: row?.backup_fresh ? "ok" : "blocked",
          detail: row?.backup_fresh ? "fresh authenticated offsite backup" : "no authenticated offsite backup within 26 hours",
        });
        checks.push({
          name: "recovery-evidence",
          status: row?.recovery_fresh ? "ok" : "blocked",
          detail: row?.recovery_fresh ? "verified offsite restore drill" : "no verified offsite restore drill within 93 days",
        });
        checks.push({
          name: "object-replication-evidence",
          status: unreplicatedObjectCount === 0n ? "ok" : "blocked",
          detail: `${storedObjectCount} stored objects; ${unreplicatedObjectCount} missing verified offsite replicas`,
        });
      } catch {
        checks.push({ name: "backup-evidence", status: "blocked", detail: "evidence query unavailable" });
        checks.push({ name: "recovery-evidence", status: "blocked", detail: "evidence query unavailable" });
        checks.push({ name: "object-replication-evidence", status: "blocked", detail: "evidence query unavailable" });
      }
    } else {
      checks.push({ name: "backup-evidence", status: acceptedMissingExternalStatus, detail: "external target not configured" });
      checks.push({ name: "recovery-evidence", status: acceptedMissingExternalStatus, detail: "external target not configured" });
      checks.push({ name: "object-replication-evidence", status: acceptedMissingExternalStatus, detail: "external target not configured" });
    }
    checks.push({
      name: "sms",
      status: config.smsProvider === "temporary-admin-fixed" ? "degraded" : config.smsProvider === "sandbox" ? "blocked" : "ok",
      detail: config.smsProvider,
    });
    checks.push({
      name: "payment",
      status: config.temporaryDegradedProduction && ["disabled", "temporary-manual"].includes(config.paymentProvider)
        ? "degraded"
        : ["sandbox", "disabled", "temporary-manual"].includes(config.paymentProvider) ? "blocked" : "ok",
      detail: config.paymentProvider,
    });
    checks.push({
      name: "china-money",
      status: config.chinaMoneyEnabled ? "ok" : config.temporaryDegradedProduction ? "degraded" : "blocked",
      detail: config.chinaMoneyEnabled ? "enabled" : "disabled",
    });
    if (config.temporaryDegradedProduction) {
      checks.push({ name: "temporary-production-mode", status: "degraded", detail: "operator-approved controlled pilot" });
    }
  }
  return checks;
}
