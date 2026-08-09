import { createHash } from "node:crypto";
import { access, constants, mkdir, statfs } from "node:fs/promises";
import type { Pool } from "pg";
import type { AppConfig } from "../../shared/config";

export interface ReadinessCheck { name: string; status: "ok" | "blocked"; detail: string }

const BACKUP_FRESHNESS_MS = 26 * 60 * 60 * 1000;
const RESTORE_DRILL_FRESHNESS_MS = 93 * 24 * 60 * 60 * 1000;

function referenceDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function operationalReadiness(config: AppConfig, pool: Pool): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  try {
    await pool.query("SELECT 1");
    checks.push({ name: "database", status: "ok", detail: "connected" });
    const schema = await pool.query<{ migration_count: string; queue_table: string | null }>(
      `SELECT (SELECT count(*)::text FROM schema_migration) AS migration_count,
              to_regclass('pgboss.job')::text AS queue_table`,
    );
    const row = schema.rows[0];
    checks.push({ name: "migrations", status: Number(row?.migration_count ?? "0") >= 21 ? "ok" : "blocked", detail: `${row?.migration_count ?? "0"} applied` });
    checks.push({ name: "queue", status: row?.queue_table ? "ok" : "blocked", detail: row?.queue_table ? "pgboss schema present" : "pgboss schema missing" });
  }
  catch { checks.push({ name: "database", status: "blocked", detail: "unavailable" }); }
  try {
    if (config.mode !== "production") await mkdir(config.storageRoot, { recursive: true });
    await access(config.storageRoot, constants.R_OK | constants.W_OK);
    const disk = await statfs(config.storageRoot, { bigint: true });
    const free = disk.bavail * disk.bsize;
    checks.push({ name: "storage", status: free >= 10n * 1024n * 1024n * 1024n ? "ok" : "blocked", detail: `${free} free bytes` });
  } catch { checks.push({ name: "storage", status: "blocked", detail: "not readable and writable" }); }
  if (config.mode === "production") {
    const externalTargetsConfigured = Boolean(
      config.storageReplicaRoot &&
      config.remoteBackupTarget &&
      config.storageReplicaRoot !== config.storageRoot,
    );
    checks.push({
      name: "external-targets",
      status: externalTargetsConfigured ? "ok" : "blocked",
      detail: externalTargetsConfigured ? "configured; evidence checked separately" : "missing or aliases primary storage",
    });
    if (externalTargetsConfigured && config.storageReplicaRoot && config.remoteBackupTarget) {
      try {
        const backupTargetDigest = referenceDigest(config.remoteBackupTarget);
        const replicaTargetDigest = referenceDigest(config.storageReplicaRoot);
        const evidence = await pool.query<{
          backup_fresh: boolean;
          recovery_fresh: boolean;
          remote_object_count: string;
          invalid_remote_object_count: string;
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
             (SELECT count(*)::text FROM stored_object
               WHERE verification_status = 'REMOTE_VERIFIED') AS remote_object_count,
             (SELECT count(*)::text FROM stored_object so
               WHERE so.verification_status = 'REMOTE_VERIFIED'
                 AND NOT EXISTS (
                   SELECT 1 FROM stored_object_replica sor
                    WHERE sor.object_id = so.id AND sor.status = 'VERIFIED'
                      AND sor.replica_kind = 'OFFSITE'
                      AND sor.target_reference_sha256 = $4
                      AND sor.ciphertext_sha256 = so.ciphertext_sha256
                      AND sor.verified_at IS NOT NULL
                 )) AS invalid_remote_object_count`,
          [
            backupTargetDigest,
            new Date(Date.now() - BACKUP_FRESHNESS_MS),
            new Date(Date.now() - RESTORE_DRILL_FRESHNESS_MS),
            replicaTargetDigest,
          ],
        );
        const row = evidence.rows[0];
        const remoteCount = BigInt(row?.remote_object_count ?? "0");
        const invalidRemoteCount = BigInt(row?.invalid_remote_object_count ?? "0");
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
          status: remoteCount > 0n && invalidRemoteCount === 0n ? "ok" : "blocked",
          detail: `${remoteCount} remote objects; ${invalidRemoteCount} invalid replica proofs`,
        });
      } catch {
        checks.push({ name: "backup-evidence", status: "blocked", detail: "evidence query unavailable" });
        checks.push({ name: "recovery-evidence", status: "blocked", detail: "evidence query unavailable" });
        checks.push({ name: "object-replication-evidence", status: "blocked", detail: "evidence query unavailable" });
      }
    } else {
      checks.push({ name: "backup-evidence", status: "blocked", detail: "external target not configured" });
      checks.push({ name: "recovery-evidence", status: "blocked", detail: "external target not configured" });
      checks.push({ name: "object-replication-evidence", status: "blocked", detail: "external target not configured" });
    }
    checks.push({ name: "sms", status: config.smsProvider === "sandbox" ? "blocked" : "ok", detail: config.smsProvider });
    checks.push({ name: "payment", status: config.paymentProvider === "sandbox" ? "blocked" : "ok", detail: config.paymentProvider });
    checks.push({ name: "china-money", status: config.chinaMoneyEnabled ? "ok" : "blocked", detail: config.chinaMoneyEnabled ? "enabled" : "disabled" });
  }
  return checks;
}
