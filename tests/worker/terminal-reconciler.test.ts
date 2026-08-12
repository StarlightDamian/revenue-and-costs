import type { Pool } from "pg";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalFailureProjector,
  reconcileTerminalBusinessFailures,
  startTerminalReconciler,
  type TerminalFailureProjector,
} from "../../src/worker/terminal-reconciler.js";

const JOB_ONE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_TWO_ID = "22222222-2222-4222-8222-222222222222";
const BATCH_ONE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BATCH_TWO_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const COMPLETED_ON = new Date("2026-08-09T03:00:00.000Z");
const temporaryRoots: string[] = [];

function failedJob(
  id: string,
  batchId: string,
  completedOn = COMPLETED_ON,
) {
  return {
    id,
    name: "import.commit" as const,
    data: { batchId },
    created_on: new Date(completedOn.getTime() - 60_000),
    completed_on: completedOn,
  };
}

function poolWithJobs(
  jobs: readonly ReturnType<typeof failedJob>[],
  superseded: boolean | ((businessId: string) => boolean) = false,
  lockAcquired = true,
) {
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    if (sql.includes("FROM pgboss.job job")) {
      return { rows: [...jobs], rowCount: jobs.length };
    }
    if (sql.includes("AS superseded")) {
      const businessId = String(parameters?.[2] ?? "");
      const value = typeof superseded === "function" ? superseded(businessId) : superseded;
      return { rows: [{ superseded: value }], rowCount: 1 };
    }
    if (sql.includes("INSERT INTO job_operation")) {
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  });
  const lockQuery = vi.fn(async (sql: string) => {
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: lockAcquired }], rowCount: 1 };
    if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
    throw new Error(`UNEXPECTED_LOCK_QUERY:${sql}`);
  });
  const release = vi.fn();
  const connect = vi.fn(async () => ({ query: lockQuery, release }));
  return { pool: { query, connect } as unknown as Pool, query, lockQuery, release };
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryRoots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe("terminal business failure reconciliation", () => {
  it("projects a failed job and records a SUCCEEDED reconciliation marker", async () => {
    const job = failedJob(JOB_ONE_ID, BATCH_ONE_ID);
    const { pool, query } = poolWithJobs([job]);
    const projector: TerminalFailureProjector = {
      project: vi.fn(async () => "PROJECTED" as const),
    };

    await expect(reconcileTerminalBusinessFailures(pool, projector)).resolves.toBe(1);

    expect(projector.project).toHaveBeenCalledOnce();
    expect(projector.project).toHaveBeenCalledWith(
      job,
      { field: "batchId", value: BATCH_ONE_ID },
    );
    const marker = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO job_operation") && String(sql).includes("'SUCCEEDED'"));
    expect(marker).toBeDefined();
    expect(marker?.[1]?.[0]).toBe(`terminal-reconcile:${JOB_ONE_ID}`);
    expect(JSON.parse(String(marker?.[1]?.[1]))).toEqual({
      queueName: "import.commit",
      outcome: "PROJECTED",
    });
  });

  it("projects an exhausted commit only while the same batch is still COMMITTING", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("WITH failed_batch AS") && sql.includes("current_stage='COMMIT_FAILED'")) {
        return { rows: [{ transitioned: true }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const pool = { query } as unknown as Pool;
    const projector = createTerminalFailureProjector({
      pool,
      objectStore: {} as never,
      failExport: vi.fn(async () => undefined),
    });
    const job = failedJob(JOB_ONE_ID, BATCH_ONE_ID);

    await expect(projector.project(job, { field: "batchId", value: BATCH_ONE_ID }))
      .resolves.toBe("PROJECTED");

    expect(query.mock.calls[0]?.[0]).toContain("status='COMMITTING'");
    expect(query.mock.calls[0]?.[0]).toContain("updated_at <= $2::timestamptz");
    expect(query.mock.calls[0]?.[1]).toEqual([BATCH_ONE_ID, COMPLETED_ON]);
  });

  it("retries terminal upload cleanup when the business row is already FAILED", async () => {
    const fileId = "00000000-0000-4000-8000-000000000001";
    const root = await mkdtemp(join(tmpdir(), "terminal-upload-cleanup-"));
    temporaryRoots.push(root);
    const tempPath = join(root, `${fileId}.part`);
    const archiveRoot = join(root, "archive", fileId);
    await mkdir(archiveRoot, { recursive: true });
    await writeFile(tempPath, "parent plaintext", "utf8");
    await writeFile(join(archiveRoot, "child.part"), "child plaintext", "utf8");

    const query = vi.fn(async (sql: string) => {
      if (sql.includes("SELECT status FROM upload_file")) {
        return { rows: [{ status: "FAILED" }], rowCount: 1 };
      }
      if (sql.includes("UPDATE upload_file SET temp_path=''")) {
        return { rows: [{ cleaned: true }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const transactionQuery = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("FROM upload_file uf") && sql.includes("FOR UPDATE OF uf,ub,ib")) {
        return {
          rows: [{
            batch_id: BATCH_ONE_ID,
            import_batch_id: BATCH_TWO_ID,
            relative_path: "source.zip",
            temp_path: tempPath,
            file_status: "FAILED",
            batch_status: "FAILED",
            import_status: "FAILED",
            archive_reservation_state: "COMMITTED",
          }],
          rowCount: 1,
        };
      }
      if (sql.includes("INSERT INTO import_issue")) return { rows: [], rowCount: 0 };
      throw new Error(`UNEXPECTED_TRANSACTION_QUERY:${sql}`);
    });
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn(async () => ({ query: transactionQuery, release })),
    } as unknown as Pool;
    const removeUncommitted = vi.fn(async () => undefined);
    const projector = createTerminalFailureProjector({
      pool,
      objectStore: { removeUncommitted } as never,
      failExport: vi.fn(async () => undefined),
    });
    const job = {
      id: JOB_ONE_ID,
      name: "upload.finalize" as const,
      data: { fileId },
      created_on: new Date(COMPLETED_ON.getTime() - 60_000),
      completed_on: COMPLETED_ON,
    };

    await expect(projector.project(job, { field: "fileId", value: fileId }))
      .resolves.toBe("PROJECTED");

    expect(removeUncommitted).toHaveBeenCalledWith(fileId);
    expect(transactionQuery.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true);
    await expect(access(tempPath)).rejects.toThrow();
    await expect(access(archiveRoot)).rejects.toThrow();
  });

  it("preserves a failed calculation run code when repairing its request batch", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      if (sql.includes("FROM calculation_run")) {
        return { rows: [{ status: "FAILED", failure_code: "FX_DATA_GAP:BRL:2025-12-30" }], rowCount: 1 };
      }
      if (sql.includes("WITH failed_batch AS")) return { rows: [{ transitioned: true }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const pool = { query } as unknown as Pool;
    const projector = createTerminalFailureProjector({
      pool,
      objectStore: {} as never,
      failExport: vi.fn(async () => undefined),
    });
    const job = {
      ...failedJob(JOB_ONE_ID, BATCH_ONE_ID),
      name: "calculation.requested" as const,
    };

    await expect(projector.project(job, { field: "batchId", value: BATCH_ONE_ID }))
      .resolves.toBe("PROJECTED");

    expect(query.mock.calls[1]?.[1]).toEqual([
      BATCH_ONE_ID,
      COMPLETED_ON,
      "CALCULATION_BLOCKED",
      "FX_DATA_GAP:BRL:2025-12-30",
    ]);
  });

  it("records SUPERSEDED without projecting when a newer job or pending outbox exists", async () => {
    const job = failedJob(JOB_ONE_ID, BATCH_ONE_ID);
    const { pool, query } = poolWithJobs([job], true);
    const projector: TerminalFailureProjector = {
      project: vi.fn(async () => "PROJECTED" as const),
    };

    await reconcileTerminalBusinessFailures(pool, projector);

    expect(projector.project).not.toHaveBeenCalled();
    const supersededCheck = query.mock.calls.find(([sql]) => String(sql).includes("AS superseded"));
    expect(supersededCheck?.[0]).toContain("FROM pgboss.job newer");
    expect(supersededCheck?.[0]).toContain("FROM outbox_event pending");
    const marker = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO job_operation") && String(sql).includes("'SUCCEEDED'"));
    expect(JSON.parse(String(marker?.[1]?.[1]))).toEqual({
      queueName: "import.commit",
      outcome: "SUPERSEDED",
    });
  });

  it("records a FAILED marker after a projector error and continues the same scan", async () => {
    const first = failedJob(JOB_ONE_ID, BATCH_ONE_ID);
    const second = failedJob(JOB_TWO_ID, BATCH_TWO_ID, new Date(COMPLETED_ON.getTime() + 1_000));
    const { pool, query } = poolWithJobs([first, second]);
    const projector: TerminalFailureProjector = {
      project: vi.fn(async (job) => {
        if (job.id === JOB_ONE_ID) throw new Error("synthetic projection failure");
        return "PROJECTED" as const;
      }),
    };
    const log = vi.fn();

    await expect(reconcileTerminalBusinessFailures(pool, projector, { log })).resolves.toBe(2);

    expect(projector.project).toHaveBeenCalledTimes(2);
    const failedMarker = query.mock.calls.find(([sql, parameters]) =>
      String(sql).includes("'FAILED'") && parameters?.[0] === `terminal-reconcile:${JOB_ONE_ID}`);
    expect(failedMarker).toBeDefined();
    expect(failedMarker?.[0]).toContain("TERMINAL_RECONCILIATION_FAILED");
    expect(JSON.parse(String(failedMarker?.[1]?.[1]))).toEqual({
      queueName: "import.commit",
      outcome: "RECOVERY_FAILED",
      businessField: "batchId",
      businessId: BATCH_ONE_ID,
    });
    const succeededMarker = query.mock.calls.find(([sql, parameters]) =>
      String(sql).includes("'SUCCEEDED'") && parameters?.[0] === `terminal-reconcile:${JOB_TWO_ID}`);
    expect(succeededMarker).toBeDefined();
    expect(log).toHaveBeenCalledWith(
      "error",
      "terminal_reconciliation_failed",
      expect.objectContaining({ jobId: JOB_ONE_ID, businessId: BATCH_ONE_ID }),
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "terminal_reconciliation_succeeded",
      expect.objectContaining({ jobId: JOB_TWO_ID, outcome: "PROJECTED" }),
    );
  });

  it("defers without projecting while the original callback still owns the job lock", async () => {
    const job = failedJob(JOB_ONE_ID, BATCH_ONE_ID);
    const { pool, query, lockQuery, release } = poolWithJobs([job], false, false);
    const projector: TerminalFailureProjector = {
      project: vi.fn(async () => "PROJECTED" as const),
    };
    const log = vi.fn();

    await expect(reconcileTerminalBusinessFailures(pool, projector, { log })).resolves.toBe(1);

    expect(projector.project).not.toHaveBeenCalled();
    expect(lockQuery).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
      [`worker-job:import.commit:${BATCH_ONE_ID}`],
    );
    expect(release).toHaveBeenCalledWith();
    const marker = query.mock.calls.find(([sql]) =>
      String(sql).includes("INSERT INTO job_operation") && String(sql).includes("'RUNNING'"));
    expect(JSON.parse(String(marker?.[1]?.[1]))).toEqual({
      queueName: "import.commit",
      outcome: "ACTIVE_CALLBACK",
      businessField: "batchId",
      businessId: BATCH_ONE_ID,
    });
    expect(log).toHaveBeenCalledWith(
      "info",
      "terminal_reconciliation_deferred",
      expect.objectContaining({ jobId: JOB_ONE_ID, outcome: "ACTIVE_CALLBACK" }),
    );
  });
});

describe("terminal reconciliation scheduler", () => {
  it("prevents overlapping work and stop waits for the in-flight run", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const work = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onFailure = vi.fn();
    const scheduler = startTerminalReconciler(work, onFailure);

    scheduler.wake();
    scheduler.wake();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(work).toHaveBeenCalledOnce();

    let stopped = false;
    const stopping = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finish();
    await stopping;
    expect(stopped).toBe(true);
    expect(onFailure).not.toHaveBeenCalled();

    scheduler.wake();
    await vi.runAllTimersAsync();
    expect(work).toHaveBeenCalledOnce();
  });
});
