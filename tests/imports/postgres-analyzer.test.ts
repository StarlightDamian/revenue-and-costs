import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { analyzeStoredUpload } from "../../src/modules/imports/postgres-analyzer.js";

describe("PostgreSQL import prefix analyzer", () => {
  it("targets the non-metadata partial unique index when upserting stored files", async () => {
    const transactionStatements: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        transactionStatements.push(sql);
        if (sql.includes("FROM import_batch WHERE id=$1 FOR UPDATE")) {
          return { rows: [{ status: "ANALYZING", shop_id: "shop-1", created_by: "actor-1" }], rowCount: 1 };
        }
        if (sql.includes("count(DISTINCT")) {
          return { rows: [{ expected: "1", analyzed: "1", parsed: "0", awaiting: "0", failed: "0" }], rowCount: 1 };
        }
        return { rows: [], rowCount: 1 };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [{
          import_batch_id: "import-1",
          upload_batch_id: "upload-1",
          stored_object_id: "object-1",
          relative_path: "source.bin",
          storage_path: "encrypted/object-1",
          plaintext_sha256: "00".repeat(32),
          plaintext_size: "4",
          encryption_context: {},
          detected_kind: "OTHER",
        }] })
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [] }),
      connect: vi.fn(async () => client),
    };
    const store = {
      createDecryptionStream: vi.fn(() => Readable.from([Buffer.from("data")])),
    };

    await analyzeStoredUpload(pool as never, store as never, "file-1");

    const upsert = transactionStatements.find((sql) => sql.includes("INSERT INTO import_file"));
    expect(upsert).toContain("ON CONFLICT (import_batch_id, stored_object_id) WHERE stored_object_id IS NOT NULL");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
