import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { markCalculationRunFailed, permanentCalculationFailureCode } from "../../src/modules/calculation/postgres-runner";
import { isPermanentExportFailure } from "../../src/modules/exports/postgres";
import {
  analyzeStoredUpload,
  loadImportMappingCandidates,
} from "../../src/modules/imports/postgres-analyzer";
import {
  markImportCommitFailed,
  safeImportCommitFailureCode,
} from "../../src/modules/imports/postgres-commit";
import { PostgresReportService } from "../../src/modules/publishing/postgres-service";
import {
  FILE_JOB_BATCH_SIZE,
  calculationRequestBlockCode,
  markCalculationRequestFailed,
  permanentUploadFailure,
  registerHandlers,
  runCalculationJob,
  runCalculationRequestJob,
  runExportJob,
  runImportAnalyzeBatch,
  runImportCommitJob,
  runRetryableJob,
} from "../../src/worker/register-handlers";
import { pgBossRuntimeOptions, startPgBoss } from "../../src/worker/pg-boss-runtime";

vi.mock("../../src/modules/imports/postgres-analyzer", () => ({
  analyzeStoredUpload: vi.fn(async () => undefined),
  loadImportMappingCandidates: vi.fn(async () => [{ id: "mapping-1", definition: { fields: [] }, report_kind: "TRANSACTION" }]),
  markStoredUploadAnalysisFailed: vi.fn(async () => ({
    importBatchId: "batch-1",
    importFileStatus: "FAILED",
    batchStatus: "FAILED",
    batchStage: "PREFLIGHT_COMPLETE",
    batchFailureCode: "NO_USABLE_UPLOAD_FILES",
  })),
}));

function advisoryLockClient() {
  let held = 0;
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    void parameters;
    if (sql.includes("pg_advisory_lock")) {
      held += 1;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("pg_advisory_unlock")) {
      held -= 1;
      return { rows: [{ unlocked: true }], rowCount: 1 };
    }
    throw new Error("UNEXPECTED_LOCK_QUERY");
  });
  const release = vi.fn();
  return {
    client: { query, release },
    query,
    release,
    isLocked: () => held > 0,
  };
}

describe("worker retry lifecycle", () => {
  it("dead-letters PDF bodies and PDF-bearing ZIPs instead of retrying storage", () => {
    expect(permanentUploadFailure(new Error("PDF_BODY_UPLOAD_REJECTED"))).toBe("PDF_BODY_UPLOAD_REJECTED");
    expect(permanentUploadFailure(new Error("ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD"))).toBe("ZIP_PDF_ENTRY_REQUIRES_FOLDER_UPLOAD");
    expect(permanentUploadFailure(new Error("ECONNRESET"))).toBeUndefined();
  });

  it("classifies deterministic calculation request blockers without retrying them", () => {
    expect(calculationRequestBlockCode(new Error("HARD_INCOMPLETE_CONFIRMATION_REQUIRED"))).toBe("HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
    expect(calculationRequestBlockCode(new Error("CALCULATION_DATE_ATTRIBUTION_MODE_MIXED"))).toBe("CALCULATION_DATE_ATTRIBUTION_MODE_MIXED");
    expect(calculationRequestBlockCode(new Error("ECONNRESET"))).toBeUndefined();
  });

  it("classifies only stable calculation contract failures as permanent", () => {
    expect(permanentCalculationFailureCode(new Error("FX_DATA_GAP:BRL:2025-07-30"))).toBe("FX_DATA_GAP");
    expect(permanentCalculationFailureCode(new Error("FX_NO_AVAILABLE_QUOTE:USD:2025-12-28"))).toBe("FX_NO_AVAILABLE_QUOTE");
    expect(permanentCalculationFailureCode(new Error("FX_INVALID_DATE:USD:not-a-date"))).toBe("FX_INVALID_DATE");
    expect(permanentCalculationFailureCode(new Error("FX_INVALID_CURRENCY:US:2025-01-01"))).toBe("FX_INVALID_CURRENCY");
    expect(permanentCalculationFailureCode(new Error("AMBIGUOUS_FX_OVERRIDE:USD:2025-01-01"))).toBe("AMBIGUOUS_FX_OVERRIDE");
    expect(permanentCalculationFailureCode(new Error("AMBIGUOUS_OFFICIAL_QUOTE:USD:2025-01-01"))).toBe("AMBIGUOUS_OFFICIAL_QUOTE");
    expect(permanentCalculationFailureCode(new Error("CALCULATION_FEE_CLASSIFICATION_MANIFEST_INVALID")))
      .toBe("CALCULATION_FEE_CLASSIFICATION_MANIFEST_INVALID");
    expect(permanentCalculationFailureCode(new Error("ECONNRESET"))).toBeUndefined();
  });

  it("dead-letters a deterministic calculation failure on the first attempt", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    const result = await runCalculationJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("FX_DATA_GAP:BRL:2025-07-30"); },
      terminal,
    );

    expect(result).toEqual({ status: "deadletter", output: { errorCode: "FX_DATA_GAP" } });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("keeps a transient calculation failure retryable", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    const result = await runCalculationJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("ECONNRESET"); },
      terminal,
    );

    expect(result).toEqual({ status: "failed", output: { errorCode: "CALCULATION_RETRYABLE" } });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("records an exhausted transient calculation with a generic terminal code", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    const result = await runCalculationJob(
      { retryCount: 5, retryLimit: 5 },
      async () => { throw new Error("connection to 10.0.0.8 failed"); },
      terminal,
    );

    expect(result).toEqual({ status: "failed", output: { errorCode: "CALCULATION_FAILED" } });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("atomically fails a calculation and only its still-calculating source import batch", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql; void parameters;
      return { rows: [], rowCount: 1 };
    });
    const runId = "00000000-0000-4000-8000-000000000001";

    await markCalculationRunFailed({ query } as never, runId, new Error("FX_DATA_GAP:BRL:2025-07-30"));

    expect(query).toHaveBeenCalledOnce();
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("WITH failed_run AS");
    expect(sql).toContain("RETURNING input_manifest,shop_id");
    expect(sql).toContain("input_manifest->>'sourceImportBatchId'");
    expect(sql).toContain("batch.shop_id=failed_run.shop_id");
    expect(sql).toContain("status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')");
    expect(parameters).toEqual([runId, "FX_DATA_GAP:BRL:2025-07-30"]);
  });

  it("drops unsafe calculation failure detail while retaining the stable base code", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql; void parameters;
      return { rows: [], rowCount: 1 };
    });

    await markCalculationRunFailed(
      { query } as never,
      "00000000-0000-4000-8000-000000000001",
      new Error("FX_DATA_GAP:brl:2025-07-30:customer-detail"),
    );

    expect(query.mock.calls[0]?.[1]?.[1]).toBe("FX_DATA_GAP");
  });

  it("does not overwrite terminal runs and projects a blocked run as a visible batch failure", async () => {
    const callbacks = new Map<string, (jobs: readonly {
      id: string;
      data: { batchId: string; actorAccountId: string };
      retryCount: number;
      retryLimit: number;
    }[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: unknown) => {
        callbacks.set(name, callback as (jobs: readonly {
          id: string;
          data: { batchId: string; actorAccountId: string };
          retryCount: number;
          retryLimit: number;
        }[]) => Promise<unknown>);
      }),
    } as unknown as PgBoss;
    const lock = advisoryLockClient();
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void parameters;
      expect(lock.isLocked()).toBe(true);
      if (sql.includes("FROM pgboss.job")) return { rows: [{ id: "job-1" }], rowCount: 1 };
      return sql.includes("SELECT shop_id FROM import_batch")
        ? { rows: [{ shop_id: "shop-1" }], rowCount: 1 }
        : { rows: [], rowCount: 1 };
    });
    const requestCalculation = vi.spyOn(PostgresReportService.prototype, "requestCalculation")
      .mockResolvedValue({ runId: "run-1", status: "QUEUED" });

    try {
      await registerHandlers(boss, {
        pool: { query, connect: vi.fn(async () => lock.client) } as never,
        objectStore: {} as never,
        exports: {} as never,
      });
      await callbacks.get("calculation.requested")?.([{
        id: "job-1",
        data: { batchId: "batch-1", actorAccountId: "actor-1" },
        retryCount: 0,
        retryLimit: 5,
      }]);
    } finally {
      requestCalculation.mockRestore();
    }

    const transition = query.mock.calls.find(([sql]) => sql.includes("SET status=CASE"));
    expect(transition?.[0]).toContain("WHEN run.status='BLOCKED' THEN 'FAILED'");
    expect(transition?.[0]).toContain("WHEN run.status='BLOCKED' THEN 'CALCULATION_BLOCKED'");
    expect(transition?.[0]).toContain("batch.status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')");
    expect(transition?.[0]).toContain("run.id=$2");
    expect(transition?.[0]).toContain("run.shop_id=batch.shop_id");
    expect(transition?.[0]).toContain("run.input_manifest->>'sourceImportBatchId'=batch.id::text");
    expect(transition?.[0]).toContain("run.status IN ('QUEUED','RUNNING','BLOCKED')");
    expect(transition?.[1]).toEqual(["batch-1", "run-1"]);
    expect(lock.isLocked()).toBe(false);
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("amortizes file queue polling with a bounded batch and isolates each analysis result", async () => {
    expect(FILE_JOB_BATCH_SIZE).toBe(32);
    const analyze = vi.fn(async (fileId: string) => {
      if (fileId === "bad") throw new Error("temporary read failure");
    });
    const log = vi.fn();
    const result = await runImportAnalyzeBatch([
      { id: "job-1", data: { fileId: "good-1" }, retryCount: 0, retryLimit: 5 },
      { id: "job-2", data: { fileId: "bad" }, retryCount: 0, retryLimit: 5 },
      { id: "job-3", data: { fileId: "good-2" }, retryCount: 0, retryLimit: 5 },
    ], analyze, { log });

    expect(result).toEqual([
      { id: "job-1", status: "completed" },
      { id: "job-2", status: "failed", output: { errorCode: "IMPORT_ANALYZE_RETRYABLE" } },
      { id: "job-3", status: "completed" },
    ]);
    expect(analyze).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith("error", "import_analysis_failed", expect.objectContaining({
      jobId: "job-2",
      fileId: "bad",
      retryCount: 0,
      retryLimit: 5,
      errorCode: "IMPORT_ANALYZE_RETRYABLE",
    }));
  });

  it("projects only the exhausted analysis attempt and keeps the pg-boss result failed", async () => {
    const terminal = vi.fn(async () => ({
      importBatchId: "batch-1",
      importFileStatus: "FAILED",
      batchStatus: "FAILED",
      batchStage: "PREFLIGHT_COMPLETE",
      batchFailureCode: "NO_USABLE_UPLOAD_FILES",
    }));
    const log = vi.fn();
    const result = await runImportAnalyzeBatch([{
      id: "job-1",
      data: { fileId: "file-1" },
      retryCount: 5,
      retryLimit: 5,
    }], async () => { throw new Error("temporary object read failure"); }, { log, onTerminalFailure: terminal });

    expect(result).toEqual([{
      id: "job-1",
      status: "failed",
      output: { errorCode: "IMPORT_ANALYZE_FAILED" },
    }]);
    expect(terminal).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith("error", "import_analysis_terminal_failed", expect.objectContaining({
      jobId: "job-1",
      fileId: "file-1",
      retryCount: 5,
      retryLimit: 5,
      errorCode: "IMPORT_ANALYZE_FAILED",
      importFileStatus: "FAILED",
      businessStatus: "FAILED",
      businessStage: "PREFLIGHT_COMPLETE",
      businessFailureCode: "NO_USABLE_UPLOAD_FILES",
      queueResult: "failed",
    }));
  });

  it("uses bounded polling without reserving a queue listener connection", async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
    } as unknown as PgBoss;
    await registerHandlers(boss, { pool: {} as never, objectStore: {} as never, exports: {} as never });
    expect(pgBossRuntimeOptions("postgresql://test")).toMatchObject({
      connectionString: "postgresql://test",
      schema: "pgboss",
      application_name: "revenue-costs-worker-queue",
      max: 1,
      useListenNotify: false,
    });
    expect(boss.updateQueue).toHaveBeenCalled();
    for (const [, options] of vi.mocked(boss.updateQueue).mock.calls) {
      expect(options).toMatchObject({ notify: false });
    }
    const calculationRegistration = vi.mocked(boss.work).mock.calls.find(([name]) => name === "calculation.run");
    expect(calculationRegistration?.[1]).toMatchObject({ includeMetadata: true, perJobResults: true });
    const analyzeRegistration = vi.mocked(boss.work).mock.calls.find(([name]) => name === "import.analyze");
    expect(analyzeRegistration?.[1]).toMatchObject({ includeMetadata: true, perJobResults: true });
    const commitRegistration = vi.mocked(boss.work).mock.calls.find(([name]) => name === "import.commit");
    expect(commitRegistration?.[1]).toMatchObject({ includeMetadata: true, perJobResults: true });
    const requestRegistration = vi.mocked(boss.work).mock.calls.find(([name]) => name === "calculation.requested");
    expect(requestRegistration?.[1]).toMatchObject({ includeMetadata: true, perJobResults: true });
  });

  it("attaches the PgBoss error listener before starting the queue runtime", async () => {
    const order: string[] = [];
    let errorListener: ((error: Error) => void) | undefined;
    const reportError = vi.fn();
    const boss = {
      on: vi.fn((event: "error", listener: (error: Error) => void) => {
        expect(event).toBe("error");
        order.push("listener");
        errorListener = listener;
      }),
      start: vi.fn(async () => {
        order.push("start");
        errorListener?.(new Error("database temporarily unavailable"));
      }),
    };

    await startPgBoss(boss, reportError);

    expect(order).toEqual(["listener", "start"]);
    expect(reportError).toHaveBeenCalledWith(expect.objectContaining({
      message: "database temporarily unavailable",
    }));
  });

  it("loads one immutable mapping snapshot for a claimed analysis batch", async () => {
    vi.mocked(analyzeStoredUpload).mockClear();
    vi.mocked(loadImportMappingCandidates).mockClear();
    const callbacks = new Map<string, (jobs: readonly {
      id: string;
      data: { fileId: string };
      retryCount: number;
      retryLimit: number;
    }[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: (jobs: readonly {
        id: string;
        data: { fileId: string };
        retryCount: number;
        retryLimit: number;
      }[]) => Promise<unknown>) => {
        callbacks.set(name, callback);
      }),
    } as unknown as PgBoss;
    const lock = advisoryLockClient();
    const query = vi.fn(async (sql: string) => {
      expect(lock.isLocked()).toBe(true);
      if (sql.includes("FROM pgboss.job")) {
        return { rows: [{ id: "job-1" }, { id: "job-2" }, { id: "job-3" }], rowCount: 3 };
      }
      throw new Error("UNEXPECTED_POOL_QUERY");
    });
    const pool = { query, connect: vi.fn(async () => lock.client) } as never;
    const objectStore = {} as never;
    await registerHandlers(boss, { pool, objectStore, exports: {} as never });

    await callbacks.get("import.analyze")?.([
      { id: "job-1", data: { fileId: "file-1" }, retryCount: 0, retryLimit: 5 },
      { id: "job-2", data: { fileId: "file-2" }, retryCount: 0, retryLimit: 5 },
      { id: "job-3", data: { fileId: "file-3" }, retryCount: 0, retryLimit: 5 },
    ]);

    expect(loadImportMappingCandidates).toHaveBeenCalledOnce();
    expect(analyzeStoredUpload).toHaveBeenCalledTimes(3);
    const snapshot = vi.mocked(analyzeStoredUpload).mock.calls[0]?.[3];
    expect(snapshot).toBeDefined();
    expect(vi.mocked(analyzeStoredUpload).mock.calls.every((call) => call[3] === snapshot)).toBe(true);
    expect(lock.isLocked()).toBe(false);
  });

  it("locks the whole file callback and skips jobs that are no longer active", async () => {
    vi.mocked(analyzeStoredUpload).mockClear();
    vi.mocked(loadImportMappingCandidates).mockClear();
    const callbacks = new Map<string, (jobs: readonly {
      id: string;
      data: { fileId: string };
      retryCount: number;
      retryLimit: number;
    }[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: unknown) => {
        callbacks.set(name, callback as (typeof callbacks extends Map<string, infer Handler> ? Handler : never));
      }),
    } as unknown as PgBoss;
    const lock = advisoryLockClient();
    const query = vi.fn(async (sql: string) => {
      expect(lock.isLocked()).toBe(true);
      expect(lock.query.mock.calls.filter(([statement]) => statement.includes("pg_advisory_lock")).length).toBe(2);
      if (sql.includes("FROM pgboss.job")) return { rows: [{ id: "job-active" }], rowCount: 1 };
      throw new Error("UNEXPECTED_POOL_QUERY");
    });
    await registerHandlers(boss, {
      pool: { query, connect: vi.fn(async () => lock.client) } as never,
      objectStore: {} as never,
      exports: {} as never,
    });

    const result = await callbacks.get("import.analyze")?.([
      { id: "job-active", data: { fileId: "file-active" }, retryCount: 0, retryLimit: 5 },
      { id: "job-inactive", data: { fileId: "file-inactive" }, retryCount: 0, retryLimit: 5 },
    ]);

    expect(result).toEqual(expect.arrayContaining([
      { id: "job-active", status: "completed" },
      { id: "job-inactive", status: "completed" },
    ]));
    expect(loadImportMappingCandidates).toHaveBeenCalledOnce();
    expect(analyzeStoredUpload).toHaveBeenCalledOnce();
    expect(analyzeStoredUpload).toHaveBeenCalledWith(expect.anything(), expect.anything(), "file-active", expect.anything());
    expect(lock.isLocked()).toBe(false);
  });

  it("releases the callback lock when non-per-job work throws", async () => {
    const callbacks = new Map<string, (jobs: readonly {
      id: string;
      data: { runId: string; actorAccountId: string; sourceImportBatchId: string };
      retryCount: number;
      retryLimit: number;
    }[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: unknown) => {
        callbacks.set(name, callback as (typeof callbacks extends Map<string, infer Handler> ? Handler : never));
      }),
    } as unknown as PgBoss;
    const lock = advisoryLockClient();
    const query = vi.fn(async (sql: string) => {
      expect(lock.isLocked()).toBe(true);
      if (sql.includes("FROM pgboss.job")) return { rows: [{ id: "job-1" }], rowCount: 1 };
      throw new Error("UNEXPECTED_POOL_QUERY");
    });
    const autoPublish = vi.spyOn(PostgresReportService.prototype, "autoPublishCalculation")
      .mockImplementation(async () => {
        expect(lock.isLocked()).toBe(true);
        throw new Error("ECONNRESET");
      });

    try {
      await registerHandlers(boss, {
        pool: { query, connect: vi.fn(async () => lock.client) } as never,
        objectStore: {} as never,
        exports: {} as never,
      });
      await expect(callbacks.get("report.auto-publish")?.([{
        id: "job-1",
        data: { runId: "run-1", actorAccountId: "actor-1", sourceImportBatchId: "batch-1" },
        retryCount: 0,
        retryLimit: 5,
      }])).rejects.toThrow("ECONNRESET");
    } finally {
      autoPublish.mockRestore();
    }

    expect(lock.isLocked()).toBe(false);
    expect(lock.query.mock.calls.some(([sql]) => sql.includes("pg_advisory_unlock"))).toBe(true);
    expect(lock.release).toHaveBeenCalledOnce();
  });

  it("rethrows a retryable attempt without running the terminal finalizer", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    await expect(runRetryableJob(
      { retryCount: 4, retryLimit: 5 },
      async () => { throw new Error("retry me"); },
      terminal,
    )).rejects.toThrow("retry me");
    expect(terminal).not.toHaveBeenCalled();
  });

  it("records the business terminal state on the final failed attempt and still rejects the pg-boss job", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    await expect(runRetryableJob(
      { retryCount: 5, retryLimit: 5 },
      async () => { throw new Error("exhausted"); },
      terminal,
    )).rejects.toThrow("exhausted");
    expect(terminal).toHaveBeenCalledOnce();
    expect(terminal.mock.calls[0]?.[0]).toMatchObject({ message: "exhausted" });
  });

  it("dead-letters a persisted deterministic import commit failure on its first attempt", async () => {
    const terminal = vi.fn(async () => undefined);
    const queryError = Object.assign(new Error("unsafe SQL detail"), { code: "42601" });

    expect(safeImportCommitFailureCode(queryError)).toBe("IMPORT_QUERY_INVALID");
    await expect(runImportCommitJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw queryError; },
      terminal,
    )).resolves.toEqual({ status: "deadletter", output: { errorCode: "IMPORT_QUERY_INVALID" } });
    expect(terminal).not.toHaveBeenCalled();
  });

  it("retries an unclassified import commit failure and projects it only when exhausted", async () => {
    const terminal = vi.fn(async () => undefined);
    const work = async () => { throw new Error("ECONNRESET"); };

    await expect(runImportCommitJob(
      { retryCount: 0, retryLimit: 5 }, work, terminal,
    )).resolves.toEqual({ status: "failed", output: { errorCode: "IMPORT_COMMIT_RETRYABLE" } });
    expect(terminal).not.toHaveBeenCalled();

    await expect(runImportCommitJob(
      { retryCount: 5, retryLimit: 5 }, work, terminal,
    )).resolves.toEqual({ status: "failed", output: { errorCode: "IMPORT_COMMIT_FAILED" } });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("atomically fails only a still-COMMITTING import batch and records one safe issue", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql; void parameters;
      return { rows: [{
      status: "FAILED",
      current_stage: "COMMIT_FAILED",
      failure_code: "IMPORT_COMMIT_FAILED",
      transitioned: true,
      }], rowCount: 1 };
    });

    await expect(markImportCommitFailed({ query } as never, "batch-1")).resolves.toEqual({
      status: "FAILED",
      currentStage: "COMMIT_FAILED",
      failureCode: "IMPORT_COMMIT_FAILED",
      transitioned: true,
    });
    const [sql, parameters] = query.mock.calls[0]!;
    expect(sql).toContain("status='COMMITTING'");
    expect(sql).toContain("INSERT INTO import_issue");
    expect(parameters).toEqual(["batch-1", "IMPORT_COMMIT_FAILED"]);
  });

  it("dead-letters deterministic calculation requests and leaves transient requests retryable", async () => {
    const terminal = vi.fn(async (error: unknown, code: string) => {
      void error; void code;
    });

    await expect(runCalculationRequestJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("NO_ACTIVE_DATASET"); },
      terminal,
    )).resolves.toEqual({ status: "deadletter", output: { errorCode: "NO_ACTIVE_DATASET" } });
    expect(terminal).toHaveBeenLastCalledWith(expect.any(Error), "NO_ACTIVE_DATASET");

    terminal.mockClear();
    await expect(runCalculationRequestJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("ECONNRESET"); },
      terminal,
    )).resolves.toEqual({ status: "failed", output: { errorCode: "CALCULATION_REQUEST_RETRYABLE" } });
    expect(terminal).not.toHaveBeenCalled();

    await expect(runCalculationRequestJob(
      { retryCount: 5, retryLimit: 5 },
      async () => { throw new Error("ECONNRESET"); },
      terminal,
    )).resolves.toEqual({ status: "failed", output: { errorCode: "CALCULATION_REQUEST_FAILED" } });
    expect(terminal).toHaveBeenLastCalledWith(expect.any(Error), "CALCULATION_REQUEST_FAILED");
  });

  it("atomically projects a calculation request terminal without overwriting forward states", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql; void parameters;
      return { rows: [{
      status: "FAILED",
      current_stage: "CALCULATION_REQUEST_BLOCKED",
      failure_code: "CALCULATION_REQUEST_FAILED",
      transitioned: true,
      }], rowCount: 1 };
    });

    await expect(markCalculationRequestFailed(
      { query } as never,
      "batch-1",
      "CALCULATION_REQUEST_FAILED",
    )).resolves.toEqual({
      status: "FAILED",
      currentStage: "CALCULATION_REQUEST_BLOCKED",
      failureCode: "CALCULATION_REQUEST_FAILED",
      transitioned: true,
    });
    const [sql] = query.mock.calls[0]!;
    expect(sql).toContain("status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')");
    expect(sql).toContain("INSERT INTO import_issue");
  });

  it("dead-letters a deterministic export contract failure on the first attempt", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    const result = await runExportJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("EXPORT_COMPLETENESS_FAILED"); },
      terminal,
      isPermanentExportFailure,
    );

    expect(result).toEqual({ status: "deadletter", output: { errorCode: "EXPORT_COMPLETENESS_FAILED" } });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("dead-letters a deterministic PostgreSQL query contract failure on the first attempt", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    const databaseError = Object.assign(new Error("syntax error at or near a reserved alias"), { code: "42601" });
    const result = await runExportJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw databaseError; },
      terminal,
      isPermanentExportFailure,
    );

    expect(result).toEqual({ status: "deadletter", output: { errorCode: "EXPORT_QUERY_INVALID" } });
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("keeps an unknown infrastructure export failure retryable", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    const result = await runExportJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("ECONNRESET"); },
      terminal,
      isPermanentExportFailure,
    );

    expect(result).toEqual({ status: "failed", output: { errorCode: "EXPORT_GENERATION_FAILED" } });
    expect(terminal).not.toHaveBeenCalled();
  });
});
