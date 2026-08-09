import ExcelJS from "exceljs";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { intermediateLogicalName, writeIntermediateWorkbook } from "../../src/modules/publishing/intermediate-export.js";

async function workbookBuffer(kind: "TRANSACTION" | "SHIPMENT", row: Record<string, string>): Promise<Buffer> {
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  async function* rows() { yield row; }
  await writeIntermediateWorkbook({ output, kind, enterpriseName: "示例企业", rows: rows() });
  return Buffer.concat(chunks);
}

describe("intermediate XLSX export", () => {
  it("writes shipment quantity separately and sums only the eight H-O amount cells", async () => {
    const buffer = await workbookBuffer("SHIPMENT", {
      id: "1", marketplace: "EU-BE", localDate: "2026-04-01", orderId: "=unsafe", sku: "SKU-1", currency: "EUR",
      shippedQuantity: "3", productPrice: "10.25", productTax: "2", shippingPrice: "1", shippingTax: "0.2",
      giftWrapPrice: "0", giftWrapTax: "0", productPromotionDiscount: "-1.60000000", shipmentPromotionDiscount: "-0.3",
      cnyRate: "7.81234567", originalTotal: "11.55000000", cnyTotal: "90.23456789",
    });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0]!;
    expect(sheet.getRow(1).values).toEqual([undefined, "行号", "站点", "当地日期", "订单号", "SKU", "币种", "发货数量", "商品价格", "商品税", "配送费", "配送税", "礼品包装费", "礼品包装税", "商品促销折扣", "配送促销折扣", "人民币汇率", "原币合计", "人民币合计"]);
    expect(sheet.getCell("D2").value).toBe("'=unsafe");
    expect(sheet.getCell("G2").formula).toBe('ROUND(VALUE("3"),2)');
    expect(sheet.getCell("N2").formula).toBe('ROUND(VALUE("-1.60000000"),2)');
    expect(sheet.getCell("P2").numFmt).toBe("0.00000000");
    expect(sheet.getCell("Q2").formula).toBe("ROUND(SUM(H2:O2),2)");
    expect(sheet.getCell("R2").formula).toBe("ROUND(Q2*P2,2)");
  });

  it.each(["TRANSACTION", "SHIPMENT"] as const)("keeps an unavailable %s rate blank", async (kind) => {
    const buffer = await workbookBuffer(kind, {
      id: "1", marketplace: "US", localDate: "2026-08-01", currency: "USD", shippedQuantity: "0",
    });
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(buffer as never);
    const sheet = workbook.worksheets[0]!;
    const rateCell = kind === "TRANSACTION" ? "Y2" : "P2";
    expect(sheet.getCell(rateCell).value).toBeNull();
    if (kind === "SHIPMENT") expect(sheet.getCell("R2").formula).toBe("ROUND(Q2*P2,2)");
  });

  it("sanitizes illegal sheet characters and truncates with a stable hash", () => {
    const name = intermediateLogicalName("TRANSACTION", "非常长/且包含:非法*字符?的企业名称超过Excel限制");
    expect([...name].length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[\\/*?:[\]]/u);
    expect(intermediateLogicalName("TRANSACTION", "非常长/且包含:非法*字符?的企业名称超过Excel限制")).toBe(name);
  });
});
