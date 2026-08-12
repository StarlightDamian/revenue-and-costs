import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeStoredUpload,
  markStoredUploadAnalysisFailed,
} from "../../src/modules/imports/postgres-analyzer.js";

describe("PostgreSQL import prefix analyzer", () => {
  it("idempotently projects an exhausted stored-file analysis as FAILED and refreshes preflight", async () => {
    const statements: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
        statements.push(parameters ? { sql, parameters } : { sql });
        if (sql.includes("FROM upload_file uf") && sql.includes("FOR UPDATE")) {
          return { rows: [{
            import_batch_id: "import-1",
            upload_batch_id: "upload-1",
            stored_object_id: "object-1",
            relative_path: "private/customer/source.csv",
            plaintext_sha256: "00".repeat(32),
            plaintext_size: "4",
          }], rowCount: 1 };
        }
        if (sql.includes("INSERT INTO import_file")) {
          return { rows: [{ id: "import-file-1", parse_status: "FAILED" }], rowCount: 1 };
        }
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
    const pool = { connect: vi.fn(async () => client) };

    await expect(markStoredUploadAnalysisFailed(pool as never, "upload-file-1")).resolves.toMatchObject({
      importBatchId: "import-1",
      importFileStatus: "FAILED",
      batchStatus: "FAILED",
      batchStage: "PREFLIGHT_COMPLETE",
      batchFailureCode: "NO_USABLE_UPLOAD_FILES",
    });

    const upsert = statements.find(({ sql }) => sql.includes("INSERT INTO import_file"));
    expect(upsert?.sql).toContain("parse_status='FAILED'");
    expect(upsert?.sql).toContain("WHERE import_file.parse_status='PENDING'");
    const issue = statements.find(({ sql }) => sql.includes("'IMPORT_ANALYZE_FAILED'"));
    expect(issue).toBeDefined();
    expect(JSON.stringify(issue?.parameters)).not.toContain("private/customer/source.csv");
    expect(statements.some(({ sql }) => sql.includes("SET status=$2,current_stage=$3,failure_code=$4"))).toBe(true);
    expect(client.release).toHaveBeenCalledOnce();
  });

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
