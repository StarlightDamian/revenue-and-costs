import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  tryWithJobExecutionLock,
  withJobExecutionLocks,
} from "../../src/worker/job-execution-lock.js";

describe("worker job execution lock", () => {
  it("deduplicates and orders a callback batch, then unlocks it in reverse order", async () => {
    const events: string[] = [];
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      const key = String(parameters?.[0] ?? "");
      if (sql.includes("pg_advisory_lock")) {
        events.push(`lock:${key}`);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_unlock")) {
        events.push(`unlock:${key}`);
        return { rows: [{ unlocked: true }], rowCount: 1 };
      }
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const release = vi.fn(() => { events.push("release"); });
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;

    await expect(withJobExecutionLocks(pool, [
      { queueName: "import.analyze", businessId: "b" },
      { queueName: "import.analyze", businessId: "a" },
      { queueName: "import.analyze", businessId: "b" },
    ], async () => {
      events.push("work");
      return "done";
    })).resolves.toBe("done");

    expect(events).toEqual([
      "lock:worker-job:import.analyze:a",
      "lock:worker-job:import.analyze:b",
      "work",
      "unlock:worker-job:import.analyze:b",
      "unlock:worker-job:import.analyze:a",
      "release",
    ]);
    expect(release).toHaveBeenCalledWith();
  });

  it("releases every acquired lock when the protected callback fails", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("pg_advisory_unlock")
      ? { rows: [{ unlocked: true }], rowCount: 1 }
      : { rows: [], rowCount: 1 });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;

    await expect(withJobExecutionLocks(pool, [
      { queueName: "calculation.run", businessId: "run" },
    ], async () => { throw new Error("synthetic work failure"); })).rejects.toThrow("synthetic work failure");

    expect(query.mock.calls.some(([sql]) => String(sql).includes("pg_advisory_unlock"))).toBe(true);
    expect(release).toHaveBeenCalledWith();
  });

  it("destroys the session if acquiring a later lock fails", async () => {
    let lockCalls = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_advisory_unlock")) return { rows: [{ unlocked: true }], rowCount: 1 };
      lockCalls += 1;
      if (lockCalls === 2) throw new Error("synthetic connection failure");
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;

    await expect(withJobExecutionLocks(pool, [
      { queueName: "upload.finalize", businessId: "a" },
      { queueName: "upload.finalize", businessId: "b" },
    ], async () => undefined)).rejects.toThrow("synthetic connection failure");

    expect(query.mock.calls.filter(([sql]) => String(sql).includes("pg_advisory_unlock"))).toHaveLength(1);
    expect(release).toHaveBeenCalledWith(true);
  });

  it("does not run reconciliation work when the active callback owns the lock", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: false }], rowCount: 1 };
      throw new Error(`UNEXPECTED_QUERY:${sql}`);
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as unknown as Pool;
    const work = vi.fn(async () => "unsafe");

    await expect(tryWithJobExecutionLock(pool, "import.commit", "batch", work))
      .resolves.toEqual({ acquired: false });

    expect(work).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith();
  });

  it("serializes queue callbacks before they reserve lock connections", async () => {
    let finishFirst!: () => void;
    const firstWork = new Promise<void>((resolve) => { finishFirst = resolve; });
    const clients = Array.from({ length: 2 }, () => ({
      query: vi.fn(async (sql: string) => sql.includes("pg_advisory_unlock")
        ? { rows: [{ unlocked: true }], rowCount: 1 }
        : sql.includes("pg_try_advisory_lock")
          ? { rows: [{ acquired: true }], rowCount: 1 }
          : { rows: [], rowCount: 1 }),
      release: vi.fn(),
    }));
    const connect = vi.fn(async () => clients[connect.mock.calls.length - 1]);
    const pool = { connect } as unknown as Pool;

    const first = withJobExecutionLocks(pool, [
      { queueName: "upload.finalize", businessId: "first" },
    ], async () => firstWork);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledOnce());
    const secondWork = vi.fn(async () => "second");
    const second = tryWithJobExecutionLock(pool, "import.commit", "second", secondWork);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(connect).toHaveBeenCalledOnce();
    expect(secondWork).not.toHaveBeenCalled();

    finishFirst();
    await expect(Promise.all([first, second])).resolves.toEqual([
      undefined,
      { acquired: true, value: "second" },
    ]);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
