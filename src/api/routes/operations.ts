import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../shared/config";
import type { Pool } from "pg";
import { operationalReadiness } from "../../modules/operations/readiness";

export async function registerOperationsRoutes(app: FastifyInstance, deps: { config: AppConfig; pool: Pool; requireAdmin: (request: unknown) => Promise<void> }): Promise<void> {
  app.get("/api/v1/admin/operations/readiness", async (request, reply) => {
    await deps.requireAdmin(request);
    const checks = await operationalReadiness(deps.config, deps.pool);
    const ready = checks.every((check) => check.status === "ok");
    return reply.code(ready ? 200 : 503).send({ ready, checks });
  });
  app.get("/api/v1/admin/operations/jobs", async (request) => {
    await deps.requireAdmin(request);
    const result = await deps.pool.query(
      `SELECT id::text,name,state::text,retry_count::text,retry_limit::text,
              created_on,started_on,completed_on,heartbeat_on
         FROM pgboss.job ORDER BY created_on DESC LIMIT 50`,
    );
    return { items: result.rows };
  });
  app.get("/api/v1/admin/operations/status", async (request) => {
    await deps.requireAdmin(request);
    const [fx, storage, backups, checkpoints, alerts] = await Promise.all([
      deps.pool.query(
        "SELECT id::text,sync_kind,status,coverage_from,coverage_to,started_at,finished_at,error_code FROM fx_sync_run ORDER BY started_at DESC LIMIT 20",
      ),
      deps.pool.query(
        `SELECT object_kind,verification_status,count(*)::text AS object_count,
                coalesce(sum(plaintext_size),0)::text AS plaintext_bytes
           FROM stored_object GROUP BY object_kind,verification_status ORDER BY object_kind,verification_status`,
      ),
      deps.pool.query(
        "SELECT id::text,backup_kind,status,target_name,started_at,finished_at,manifest_sha256,error_code FROM backup_run ORDER BY started_at DESC LIMIT 20",
      ),
      deps.pool.query(
        "SELECT id::text,checkpoint_kind,source_version,status,created_at,verified_at FROM recovery_checkpoint ORDER BY created_at DESC LIMIT 20",
      ),
      deps.pool.query(
        "SELECT id::text,severity,alert_type,status,opened_at,resolved_at FROM operational_alert WHERE status<>'RESOLVED' ORDER BY opened_at DESC LIMIT 50",
      ),
    ]);
    return { fxSyncRuns: fx.rows, storage: storage.rows, backups: backups.rows, recoveryCheckpoints: checkpoints.rows, alerts: alerts.rows };
  });
}
