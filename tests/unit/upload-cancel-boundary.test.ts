import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { UploadService } from "../../src/modules/uploads/service.js";

describe("upload cancellation boundary", () => {
  it("does not cancel import states after commit has started", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        return { rows: [], rowCount: 1 };
      },
      release: vi.fn(),
    };
    const pool = { connect: async () => client as unknown as PoolClient } as unknown as Pool;

    await new UploadService(pool, ".").cancelBatch("00000000-0000-4000-8000-000000000001");

    const importUpdate = queries.find((sql) => sql.includes("UPDATE import_batch"));
    expect(importUpdate).toContain("AWAITING_COMMIT_CONFIRMATION");
    expect(importUpdate).not.toMatch(/COMMITTING|COMMITTED|CALCULATING|RESULT_PUBLISHING|RESULT_PUBLISHED/u);
    expect(queries.at(0)).toBe("BEGIN");
    expect(queries.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
