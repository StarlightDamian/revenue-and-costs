import type { Pool, PoolClient } from "pg";
import type { PgBoss } from "pg-boss";
import { describe, expect, it, vi } from "vitest";
import {
  createOutboxDispatchScheduler,
  dispatchOutbox,
} from "../../src/worker/outbox-dispatcher";

describe("outbox dispatcher", () => {
  it("groups a claimed batch by topic and marks every successful event in one update", async () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      topic: index % 2 === 0 ? "upload.finalize" : "import.analyze",
      business_key: `event-${index}`,
      payload: { index },
    }));
    const query = vi.fn(async (sql: string) => {
      if (["BEGIN", "COMMIT"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM outbox_event")) return { rows: events, rowCount: events.length };
      if (sql.startsWith("UPDATE outbox_event")) return { rows: [], rowCount: events.length };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const boss = {
      send: vi.fn(async () => "job-id"),
      insert: vi.fn(async () => ["job-id"]),
    } as unknown as PgBoss;

    await expect(dispatchOutbox(pool, boss, 50)).resolves.toBe(40);

    expect(boss.send).not.toHaveBeenCalled();
    expect(boss.insert).toHaveBeenCalledTimes(2);
    expect(query.mock.calls.filter(([sql]) => String(sql).startsWith("UPDATE outbox_event"))).toHaveLength(1);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("persists a safe failed-attempt marker after the claim transaction rolls back", async () => {
    const event = {
      id: "00000000-0000-4000-8000-000000000001",
      topic: "calculation.requested",
      business_key: "batch-1",
      payload: { batchId: "batch-1" },
    };
    const transactionQuery = vi.fn(async (sql: string) => {
      if (["BEGIN", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: null };
      if (sql.includes("FROM outbox_event")) return { rows: [event], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const diagnosticQuery = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql;
      void parameters;
      return { rows: [], rowCount: 1 };
    });
    const client = { query: transactionQuery, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client), query: diagnosticQuery } as unknown as Pool;
    const boss = { insert: vi.fn(async () => { throw new Error("ECONNRESET"); }) } as unknown as PgBoss;

    await expect(dispatchOutbox(pool, boss, 50)).rejects.toThrow("ECONNRESET");

    expect(transactionQuery).toHaveBeenCalledWith("ROLLBACK");
    expect(diagnosticQuery).toHaveBeenCalledOnce();
    expect(diagnosticQuery.mock.calls[0]?.[0]).toContain("attempt_count=attempt_count+1");
    expect(diagnosticQuery.mock.calls[0]?.[1]).toEqual([[event.id], "OUTBOX_DISPATCH_FAILED"]);
  });

  it("coalesces overlapping wakes but drains a notification received during dispatch", async () => {
    let finishFirst!: (count: number) => void;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise<number>((resolve) => { finishFirst = resolve; }))
      .mockResolvedValue(0);
    const reportError = vi.fn();
    const scheduler = createOutboxDispatchScheduler(run, 50, reportError);

    scheduler.wake();
    scheduler.wake();
    expect(run).toHaveBeenCalledTimes(1);
    finishFirst(1);
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await scheduler.stop();

    expect(reportError).not.toHaveBeenCalled();
  });

});
