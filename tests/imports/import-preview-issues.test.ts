import { describe, expect, it, vi } from "vitest";
import { PostgresImportService } from "../../src/modules/imports/postgres-service.js";

describe("import preview issue groups", () => {
  it("returns one Chinese aggregate with an exact count instead of row-level codes", async () => {
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "batch-1", status: "COMMITTING", current_stage: "COPY", failure_code: null,
        upload_batch_id: "upload-1", upload_ready: true,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        id: "issue-1",
        import_file_id: null,
        issue_code: "IMPORT_FINANCIAL_VALUE_INVALID",
        severity: "WARNING",
        field_name: "selling_fees",
        issue_count: "47",
        exact_count: true,
      }] }) };
    const service = new PostgresImportService({ transaction: vi.fn() } as never, database as never);

    const batch = await service.getBatch("shop-1", "batch-1");
    expect(batch.issues).toEqual([expect.objectContaining({
      kind: "IMPORT_FINANCIAL_VALUE_INVALID",
      severity: "WARNING",
      count: 47,
      exactCount: true,
      message: "有一行的金额不是系统能识别的数字（销售佣金列）",
    })]);
    expect(batch).toMatchObject({ uploadBatchId: "upload-1", uploadReady: true });
    expect(`${batch.issues[0]?.message}${batch.issues[0]?.action}`).not.toContain("selling_fees");
  });

  it("returns only removable staged upload files while an upload is still open", async () => {
    const database = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "batch-1", status: "UPLOADING", current_stage: "UPLOAD", failure_code: null,
        upload_batch_id: "upload-1", upload_batch_status: "UPLOADING", upload_ready: true,
        accounting_period_start: null, accounting_period_end: null,
      }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [
        { id: "file-1", relative_path: "US/transaction.csv", declared_size: "1024", status: "COMPLETE", metadata_only: false },
        { id: "file-2", relative_path: "notes.pdf", declared_size: "0", status: "COMPLETE", metadata_only: true },
      ] })
      .mockResolvedValueOnce({ rows: [] }) };
    const service = new PostgresImportService({ transaction: vi.fn() } as never, database as never);

    const batch = await service.getBatch("shop-1", "batch-1");

    expect(batch.stagedUploadFiles).toEqual([
      { id: "file-1", relativePath: "US/transaction.csv", bytes: "1024", status: "COMPLETE", metadataOnly: false },
      { id: "file-2", relativePath: "notes.pdf", bytes: "0", status: "COMPLETE", metadataOnly: true },
    ]);
    const stagedQuery = database.query.mock.calls[2];
    expect(String(stagedQuery?.[0])).toContain("archive_reservation_state='NONE'");
    expect(String(stagedQuery?.[0])).toContain("UPLOAD_FILES_REMOVED_BEFORE_IMPORT");
    expect(stagedQuery?.[1]).toEqual(["upload-1"]);
  });
});
