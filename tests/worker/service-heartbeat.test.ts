import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { recordWorkerHeartbeat, WORKER_HEARTBEAT_BUSINESS_KEY } from "../../src/worker/service-heartbeat.js";

describe("worker service heartbeat", () => {
  it("projects liveness without creating a second queue owner", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql;
      void parameters;
      return { rows: [], rowCount: 1 };
    });

    await recordWorkerHeartbeat({ query } as unknown as Pool);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("INSERT INTO job_operation");
    expect(query.mock.calls[0]?.[0]).toContain("ON CONFLICT(business_key) DO UPDATE");
    expect(query.mock.calls[0]?.[1]).toEqual([WORKER_HEARTBEAT_BUSINESS_KEY]);
  });
});
