import { DATABASE_POOL_LIMITS } from "../db/connection-budget.js";
import { safeErrorDiagnostic } from "../shared/diagnostics.js";

export function pgBossRuntimeOptions(connectionString: string) {
  return {
    connectionString,
    schema: "pgboss",
    application_name: "revenue-costs-worker-queue",
    max: DATABASE_POOL_LIMITS.queue,
    // The two-second worker poll is the correctness path. Avoid a dedicated
    // LISTEN connection on the shared 20-connection PostgreSQL cluster.
    useListenNotify: false,
  } as const;
}

export function reportPgBossError(error: unknown): void {
  process.stderr.write(`${JSON.stringify({
    level: "error",
    time: Date.now(),
    event: "pg_boss_error",
    service: "worker",
    ...safeErrorDiagnostic(error),
  })}\n`);
}

interface PgBossStarter {
  on(event: "error", listener: (error: Error) => void): unknown;
  start(): Promise<unknown>;
}

export async function startPgBoss(
  boss: PgBossStarter,
  reportError: (error: Error) => void = reportPgBossError,
): Promise<void> {
  // EventEmitter treats an unhandled "error" event as a process-level crash.
  boss.on("error", reportError);
  await boss.start();
}
