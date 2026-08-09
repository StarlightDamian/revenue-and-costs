import { describe, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import { isPermanentExportFailure } from "../../src/modules/exports/postgres";
import { analyzeStoredUpload, loadImportMappingCandidates } from "../../src/modules/imports/postgres-analyzer";
import {
  FILE_JOB_BATCH_SIZE,
  isPermanentCalculationFailure,
  pgBossRuntimeOptions,
  registerHandlers,
  runExportJob,
  runImportAnalyzeBatch,
  runRetryableJob,
} from "../../src/worker/register-handlers";

vi.mock("../../src/modules/imports/postgres-analyzer", () => ({
  analyzeStoredUpload: vi.fn(async () => undefined),
  loadImportMappingCandidates: vi.fn(async () => [{ id: "mapping-1", definition: { fields: [] }, report_kind: "TRANSACTION" }]),
}));

describe("worker retry lifecycle", () => {
  it("amortizes file queue polling with a bounded batch and isolates each analysis result", async () => {
    expect(FILE_JOB_BATCH_SIZE).toBe(32);
    const analyze = vi.fn(async (fileId: string) => {
      if (fileId === "bad") throw new Error("temporary read failure");
    });
    const log = vi.fn();
    const result = await runImportAnalyzeBatch([
      { id: "job-1", data: { fileId: "good-1" } },
      { id: "job-2", data: { fileId: "bad" } },
      { id: "job-3", data: { fileId: "good-2" } },
    ], analyze, log);

    expect(result).toEqual([
      { id: "job-1", status: "completed" },
      { id: "job-2", status: "failed", output: { errorCode: "IMPORT_ANALYZE_RETRYABLE" } },
      { id: "job-3", status: "completed" },
    ]);
    expect(analyze).toHaveBeenCalledTimes(3);
  });

  it("uses queue notifications with a polling fallback instead of shortening every idle poll", async () => {
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async () => undefined),
    } as unknown as PgBoss;
    await registerHandlers(boss, { pool: {} as never, objectStore: {} as never, exports: {} as never });
    expect(pgBossRuntimeOptions("postgresql://test")).toMatchObject({
      connectionString: "postgresql://test",
      schema: "pgboss",
      useListenNotify: true,
    });
    expect(boss.updateQueue).toHaveBeenCalled();
    for (const [, options] of vi.mocked(boss.updateQueue).mock.calls) {
      expect(options).toMatchObject({ notify: true });
    }
  });

  it("loads one immutable mapping snapshot for a claimed analysis batch", async () => {
    vi.mocked(analyzeStoredUpload).mockClear();
    vi.mocked(loadImportMappingCandidates).mockClear();
    const callbacks = new Map<string, (jobs: readonly { id: string; data: { fileId: string } }[]) => Promise<unknown>>();
    const boss = {
      createQueue: vi.fn(async () => undefined),
      updateQueue: vi.fn(async () => undefined),
      work: vi.fn(async (name: string, _options: unknown, callback: (jobs: readonly { id: string; data: { fileId: string } }[]) => Promise<unknown>) => {
        callbacks.set(name, callback);
      }),
    } as unknown as PgBoss;
    const pool = {} as never;
    const objectStore = {} as never;
    await registerHandlers(boss, { pool, objectStore, exports: {} as never });

    await callbacks.get("import.analyze")?.([
      { id: "job-1", data: { fileId: "file-1" } },
      { id: "job-2", data: { fileId: "file-2" } },
      { id: "job-3", data: { fileId: "file-3" } },
    ]);

    expect(loadImportMappingCandidates).toHaveBeenCalledOnce();
    expect(analyzeStoredUpload).toHaveBeenCalledTimes(3);
    const snapshot = vi.mocked(analyzeStoredUpload).mock.calls[0]?.[3];
    expect(snapshot).toBeDefined();
    expect(vi.mocked(analyzeStoredUpload).mock.calls.every((call) => call[3] === snapshot)).toBe(true);
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

  it("terminates a legacy fulfillment contract error on its first calculation attempt", async () => {
    const terminal = vi.fn(async (error: unknown) => { void error; });
    await expect(runRetryableJob(
      { retryCount: 0, retryLimit: 5 },
      async () => { throw new Error("TRANSACTION_FULFILLMENT_REIMPORT_REQUIRED:42"); },
      terminal,
      isPermanentCalculationFailure,
    )).resolves.toBeUndefined();
    expect(terminal).toHaveBeenCalledOnce();
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
