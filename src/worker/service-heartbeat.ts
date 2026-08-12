import type { Pool } from "pg";

export const WORKER_HEARTBEAT_BUSINESS_KEY = "service:worker";
export const WORKER_HEARTBEAT_INTERVAL_MS = 15_000;

export async function recordWorkerHeartbeat(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO job_operation(business_key,job_name,status,last_heartbeat_at,updated_at)
     VALUES($1,'worker.runtime','RUNNING',clock_timestamp(),clock_timestamp())
     ON CONFLICT(business_key) DO UPDATE
       SET status='RUNNING',last_heartbeat_at=clock_timestamp(),updated_at=clock_timestamp(),finished_at=NULL,error_code=NULL`,
    [WORKER_HEARTBEAT_BUSINESS_KEY],
  );
}

export function startWorkerHeartbeat(
  pool: Pool,
  onFailure: (error: unknown) => void,
): { stop(): Promise<void> } {
  let inFlight: Promise<void> | undefined;
  const tick = () => {
    if (inFlight) return;
    inFlight = recordWorkerHeartbeat(pool)
      .catch(onFailure)
      .finally(() => { inFlight = undefined; });
  };
  const timer = setInterval(tick, WORKER_HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}
