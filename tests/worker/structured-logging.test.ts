import type { Pool } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const structuredLog = vi.hoisted(() => vi.fn());

vi.mock("../../src/shared/structured-logger.js", () => ({ structuredLog }));

import { runImportAnalyzeBatch } from "../../src/worker/register-handlers.js";
import { reconcileTerminalBusinessFailures } from "../../src/worker/terminal-reconciler.js";

beforeEach(() => {
  structuredLog.mockReset();
});

describe("worker structured logging", () => {
  it("uses the shared structured logger for default job diagnostics", async () => {
    await runImportAnalyzeBatch([{
      id: "job-1",
      data: { fileId: "file-1" },
      retryCount: 0,
      retryLimit: 5,
    }], async () => { throw new Error("temporary read failure"); });

    expect(structuredLog).toHaveBeenCalledWith(
      "error",
      "worker",
      "import_analysis_failed",
      expect.objectContaining({ jobId: "job-1", fileId: "file-1" }),
    );
  });

  it("uses the shared structured logger for default terminal reconciliation diagnostics", async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("FROM pgboss.job job")) {
          return {
            rows: [{
              id: "11111111-1111-4111-8111-111111111111",
              name: "import.commit",
              data: { batchId: "invalid" },
              created_on: new Date("2026-08-09T02:59:00.000Z"),
              completed_on: new Date("2026-08-09T03:00:00.000Z"),
            }],
            rowCount: 1,
          };
        }
        if (sql.includes("INSERT INTO job_operation")) return { rows: [], rowCount: 1 };
        throw new Error(`UNEXPECTED_QUERY:${sql}`);
      }),
    } as unknown as Pool;

    await reconcileTerminalBusinessFailures(pool, { project: vi.fn(async () => "NOOP" as const) });

    expect(structuredLog).toHaveBeenCalledWith(
      "error",
      "worker",
      "terminal_reconciliation_failed",
      expect.objectContaining({ jobId: "11111111-1111-4111-8111-111111111111" }),
    );
  });

  it("keeps explicit test logger injection isolated from the default logger", async () => {
    const injected = vi.fn();
    await runImportAnalyzeBatch([{
      id: "job-1",
      data: { fileId: "file-1" },
      retryCount: 0,
      retryLimit: 5,
    }], async () => { throw new Error("temporary read failure"); }, { log: injected });

    expect(injected).toHaveBeenCalledTimes(2);
    expect(structuredLog).not.toHaveBeenCalled();
  });
});
