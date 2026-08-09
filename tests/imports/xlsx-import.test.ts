import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import { describe, expect, it, vi } from "vitest";

import type { FieldMappingDefinition } from "../../src/modules/mappings/types.js";
import { analyzeStoredUpload } from "../../src/modules/imports/postgres-analyzer.js";
import { analyzeXlsxStream, parseMappedXlsxStream } from "../../src/modules/imports/xlsx-stream.js";

const shipmentMapping: FieldMappingDefinition = {
  reportKind: "SHIPMENT",
  locale: "test-shipment",
  fields: [
    { canonical: "order_id", sourceHeaders: ["亚马逊订单编号"], required: true },
    { canonical: "quantity", sourceHeaders: ["已发货数量"], required: true },
    { canonical: "sales_channel", sourceHeaders: ["销售渠道"], required: true },
  ],
};

async function workbookBuffer(rows: readonly (readonly unknown[])[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("配送订单");
  for (const row of rows) sheet.addRow([...row]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("streaming XLSX shipment import", () => {
  it("matches a structural shipment header without using the file name", async () => {
    const bytes = await workbookBuffer([
      ["说明"],
      ["亚马逊订单编号", "已发货数量", "销售渠道"],
      ["order-1", 2, "amazon.de"],
    ]);

    await expect(analyzeXlsxStream(
      () => Readable.from([bytes]),
      [{ id: "mapping-1", definition: shipmentMapping }],
    )).resolves.toMatchObject({
      status: "MATCHED",
      mappingVersionId: "mapping-1",
      headerLineNumber: "2",
    });
  });

  it("keeps an unrelated workbook unsupported", async () => {
    const bytes = await workbookBuffer([
      ["货件名称", "货件编号", "状态"],
      ["FBA shipment", "FBA123", "已完成"],
    ]);

    await expect(analyzeXlsxStream(
      () => Readable.from([bytes]),
      [{ id: "mapping-1", definition: shipmentMapping }],
    )).resolves.toMatchObject({ status: "UNSUPPORTED" });
  });

  it("persists a matched workbook as a parsed shipment", async () => {
    const bytes = await workbookBuffer([
      ["亚马逊订单编号", "已发货数量", "销售渠道"],
      ["order-1", 2, "amazon.de"],
    ]);
    const client = {
      query: vi.fn(async (sql: string, _parameters?: readonly unknown[]) => {
        void _parameters;
        if (sql.includes("FROM import_batch WHERE id=$1 FOR UPDATE")) {
          return { rows: [{ status: "ANALYZING", shop_id: "shop-1", created_by: "actor-1" }], rowCount: 1 };
        }
        if (sql.includes("count(DISTINCT")) {
          return { rows: [{ expected: "1", analyzed: "1", parsed: "1", awaiting: "0", failed: "0" }], rowCount: 1 };
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
          relative_path: "opaque-name.bin",
          storage_path: "encrypted/object-1",
          plaintext_sha256: "00".repeat(32),
          plaintext_size: String(bytes.byteLength),
          encryption_context: {},
          detected_kind: "OTHER",
        }] })
        .mockResolvedValueOnce({ rows: [] }),
      connect: vi.fn(async () => client),
    };
    const store = { createDecryptionStream: vi.fn(() => Readable.from([bytes])) };

    await analyzeStoredUpload(pool as never, store as never, "file-1", [{
      id: "mapping-1",
      definition: shipmentMapping,
      report_kind: "SHIPMENT",
    }]);

    const upsert = client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO import_file"));
    expect(upsert?.[1]).toEqual(expect.arrayContaining(["SHIPMENT", "PARSED", "xlsx", "mapping-1"]));
    expect(store.createDecryptionStream).toHaveBeenCalledTimes(3);
  });

  it("projects rows one at a time and preserves physical row numbers", async () => {
    const bytes = await workbookBuffer([
      ["亚马逊订单编号", "已发货数量", "销售渠道", "买家姓名"],
      ["order-1", 2, "amazon.de", "不应持久化"],
      ["亚马逊订单编号", "已发货数量", "销售渠道", "买家姓名"],
      ["order-2", 1, "amazon.co.uk", "不应持久化"],
    ]);
    const rows: Array<{ sourceRowNumber: string; values: Readonly<Record<string, string>> }> = [];

    const result = await parseMappedXlsxStream({
      openChunks: () => Readable.from([bytes]),
      mapping: shipmentMapping,
      expectedHeaderLineNumber: "1",
      onRow: async (row) => { rows.push({ sourceRowNumber: row.sourceRowNumber, values: row.values }); },
    });

    expect(result).toEqual({ parsedRows: "2", repeatedHeaders: "1" });
    expect(rows).toEqual([
      { sourceRowNumber: "2", values: { order_id: "order-1", quantity: "2", sales_channel: "amazon.de" } },
      { sourceRowNumber: "4", values: { order_id: "order-2", quantity: "1", sales_channel: "amazon.co.uk" } },
    ]);
  });
});
