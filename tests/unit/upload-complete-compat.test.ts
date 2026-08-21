import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { UploadService } from "../../src/modules/uploads/service.js";

describe("upload completion compatibility", () => {
  it("backfills the finalize outbox when a completed file was staged by a newer uploader", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string): Promise<Partial<QueryResult>> => {
      calls.push(sql);
      if (sql.includes("count(*)::text AS count")) return { rows: [{ count: "0" }] };
      if (sql.includes("SELECT id,status FROM import_batch")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000002", status: "FAILED" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(new UploadService(pool, ".").completeBatch("00000000-0000-4000-8000-000000000001"))
      .resolves.toEqual({ id: "00000000-0000-4000-8000-000000000002", status: "FAILED" });

    const finalizeSql = calls.find((sql) => sql.includes("'upload.finalize'"));
    expect(finalizeSql).toContain("file.status='COMPLETE' AND NOT file.metadata_only");
    expect(finalizeSql).toContain("ON CONFLICT (topic,business_key) DO NOTHING");
  });
});
