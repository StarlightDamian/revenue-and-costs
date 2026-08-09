import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { ChinaMoneyXlsxSource, parseChinaMoneyWorkbook } from "../../src/modules/fx/chinamoney-xlsx.js";
import { parseChinaMoneyPage } from "../../src/modules/fx/chinamoney.js";

async function workbookBytes(rows: string[][] = [
  ["2026-07-28", "6.7928", "4.1427", "0.60204"],
  ["2006-01-04", "8.0702", "6.9535", "---"],
]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet0");
  sheet.addRow(["日期", "USD/CNY", "100JPY/CNY", "CNY/MYR"]);
  for (const row of rows) sheet.addRow(row);
  sheet.addRow(["数据来源：", "中国货币网", "中国货币网", "中国货币网"]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("ChinaMoney official XLSX source", () => {
  it("parses every workbook cell into the existing official quote contract", async () => {
    const payload = await parseChinaMoneyWorkbook(await workbookBytes());
    const parsed = parseChinaMoneyPage(payload);
    expect(parsed.quotes).toEqual([
      { validDate: "2026-07-28", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "6.7928" },
      { validDate: "2026-07-28", baseCurrency: "JPY", quoteCurrency: "CNY", baseUnit: "100", rate: "4.1427" },
      { validDate: "2026-07-28", baseCurrency: "CNY", quoteCurrency: "MYR", baseUnit: "1", rate: "0.60204" },
      { validDate: "2006-01-04", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "8.0702" },
      { validDate: "2006-01-04", baseCurrency: "JPY", quoteCurrency: "CNY", baseUnit: "100", rate: "6.9535" },
    ]);
  });

  it("requests the official export with the requested range and preserves raw bytes", async () => {
    const bytes = await workbookBytes([["2026-07-28", "6.7928", "4.1427", "0.60204"]]);
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("startDate")).toBe("2026-06-28");
      expect(url.searchParams.get("endDate")).toBe("2026-07-28");
      return new Response(Uint8Array.from(bytes).buffer, { status: 200, headers: { "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    };
    const page = await new ChinaMoneyXlsxSource("https://www.chinamoney.com.cn/export", fetcher as typeof fetch)
      .fetchPage({ from: "2026-06-28", to: "2026-07-28" }, 1, 500);
    expect(page.rawBody).toEqual(new Uint8Array(bytes));
    expect(page.hasMore).toBe(false);
    expect(parseChinaMoneyPage(page.payload).quotes).toHaveLength(3);
    expect((page.payload as { rawWorkbookBase64: string }).rawWorkbookBase64).toBe(bytes.toString("base64"));
  });

  it("splits full history into bounded ranges", async () => {
    const bytes = await workbookBytes([["2026-01-05", "7.1", "4.2", "0.6"]]);
    const fetcher = async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("startDate")).toBe("2026-01-01");
      expect(url.searchParams.get("endDate")).toBe("2026-06-29");
      return new Response(Uint8Array.from(bytes).buffer, { status: 200 });
    };
    const page = await new ChinaMoneyXlsxSource("https://www.chinamoney.com.cn/export", fetcher as typeof fetch)
      .fetchPage({ from: "2026-01-01", to: "2026-07-28" }, 1, 500);
    expect(page.hasMore).toBe(true);
  });
});
