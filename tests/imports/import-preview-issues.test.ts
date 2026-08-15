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
});
