import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it, vi } from "vitest";
import { UploadService } from "../../src/modules/uploads/service.js";

describe("upload completion compatibility", () => {
  it("scopes the idempotent finalize backfill to a ready batch with a mutable import", async () => {
    const calls: string[] = [];
    const query = vi.fn(async (sql: string): Promise<Partial<QueryResult>> => {
      calls.push(sql);
      if (sql.includes("count(*)::text AS count")) return { rows: [{ count: "0" }] };
      if (sql.includes("SELECT id,status FROM import_batch")) {
        return { rows: [{ id: "00000000-0000-4000-8000-000000000002", status: "ANALYZING" }] };
      }
      if (sql.includes("SELECT status,shop_id,created_by FROM import_batch")) {
        return { rows: [{ status: "ANALYZING", shop_id: "00000000-0000-4000-8000-000000000003", created_by: "00000000-0000-4000-8000-000000000004" }] };
      }
      if (sql.includes("count(DISTINCT coalesce")) {
        return { rows: [{ expected: "1", analyzed: "0", parsed: "0", awaiting: "0", failed: "0" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const client = { query, release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;

    await expect(new UploadService(pool, ".").completeBatch("00000000-0000-4000-8000-000000000001"))
      .resolves.toEqual({ id: "00000000-0000-4000-8000-000000000002", status: "ANALYZING" });

    const finalizeSql = calls.find((sql) => sql.includes("'upload.finalize'"));
    expect(finalizeSql).toContain("file.status='COMPLETE' AND NOT file.metadata_only");
    expect(finalizeSql).toContain("JOIN upload_batch batch ON batch.id=file.batch_id");
    expect(finalizeSql).toContain("JOIN import_batch batch_import ON batch_import.upload_batch_id=batch.id");
    expect(finalizeSql).toContain("batch.status='READY'");
    expect(finalizeSql).toContain("batch_import.status IN ('UPLOADING','ANALYZING','AWAITING_MAPPING','AWAITING_COMMIT_CONFIRMATION')");
    expect(finalizeSql).toContain("ON CONFLICT (topic,business_key) DO NOTHING");
  });
});
