import ExcelJS from "exceljs";
import { Temporal } from "@js-temporal/polyfill";
import { parseChinaMoneyPage, readBoundedResponseBody, type ChinaMoneyPage, type ChinaMoneyRange, type ChinaMoneySource } from "./chinamoney.js";
import { parseUnambiguousDate } from "./date.js";
import { decimal } from "./decimal.js";

export const CHINAMONEY_XLSX_ENDPOINT = "https://www.chinamoney.com.cn/dqs/rest/cm-u-bk-ccpr/CcprHisExcelNew";
const MAX_WORKBOOK_BYTES = 10 * 1024 * 1024;

function text(cell: ExcelJS.Cell): string {
  return cell.text.trim();
}

export async function parseChinaMoneyWorkbook(bytes: Uint8Array): Promise<{ records: ReadonlyArray<Readonly<Record<string, string>>> }> {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKBOOK_BYTES) throw new Error("CHINAMONEY_XLSX_SIZE_INVALID");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Uint8Array.from(bytes).buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet || text(sheet.getCell(1, 1)) !== "日期") throw new Error("CHINAMONEY_XLSX_HEADER_INVALID");
  const headers: string[] = [];
  for (let column = 2; column <= sheet.columnCount; column += 1) {
    const header = text(sheet.getCell(1, column)).toUpperCase();
    if (!/^(?:\d+)?[A-Z]{3}\/[A-Z]{3}$/u.test(header)) throw new Error("CHINAMONEY_XLSX_HEADER_INVALID");
    headers.push(header);
  }
  if (headers.length === 0 || new Set(headers).size !== headers.length) throw new Error("CHINAMONEY_XLSX_HEADER_INVALID");

  const records: Array<Record<string, string>> = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawDate = text(row.getCell(1));
    if (rawDate === "数据来源：" || (!rawDate && records.length > 0)) break;
    if (!rawDate && !row.hasValues) continue;
    const validDate = parseUnambiguousDate(rawDate);
    if (!validDate) throw new Error("CHINAMONEY_XLSX_DATE_INVALID");
    const record: Record<string, string> = { validDate };
    for (const [index, header] of headers.entries()) {
      const value = text(row.getCell(index + 2));
      if (!value || /^-+$/u.test(value)) continue;
      try {
        if (!decimal(value.replaceAll(",", "")).isPositive()) throw new Error("not positive");
      } catch {
        throw new Error("CHINAMONEY_XLSX_RATE_INVALID");
      }
      record[header] = value;
    }
    if (Object.keys(record).length === 1) throw new Error("CHINAMONEY_XLSX_INCOMPLETE_ROW");
    records.push(record);
  }
  if (records.length === 0) throw new Error("CHINAMONEY_XLSX_EMPTY");
  const parsed = parseChinaMoneyPage({ records });
  const rateCount = records.reduce((count, record) => count + Object.keys(record).length - 1, 0);
  if (parsed.quotes.length !== rateCount) throw new Error("CHINAMONEY_XLSX_INCOMPLETE_ROW");
  return { records };
}

export class ChinaMoneyXlsxSource implements ChinaMoneySource {
  readonly sourceName = "ChinaMoneyXlsx" as const;

  constructor(
    private readonly endpoint = CHINAMONEY_XLSX_ENDPOINT,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async fetchPage(range: ChinaMoneyRange, page: number, pageSize: number): Promise<ChinaMoneyPage> {
    const requestedFrom = Temporal.PlainDate.from(range.from);
    const requestedTo = Temporal.PlainDate.from(range.to);
    const pageFrom = requestedFrom.add({ days: (page - 1) * 180 });
    if (Temporal.PlainDate.compare(pageFrom, requestedTo) > 0) throw new Error("CHINAMONEY_XLSX_PAGE_OUT_OF_RANGE");
    const candidateTo = pageFrom.add({ days: 179 });
    const pageTo = Temporal.PlainDate.compare(candidateTo, requestedTo) < 0 ? candidateTo : requestedTo;
    const url = new URL(this.endpoint);
    url.searchParams.set("startDate", pageFrom.toString());
    url.searchParams.set("endDate", pageTo.toString());
    url.searchParams.set("currency", "");
    const response = await this.fetcher(url, {
      method: "GET",
      headers: {
        accept: "*/*",
        referer: "https://www.chinamoney.com.cn/chinese/bkccpr/index.html?tab=2",
        "user-agent": "Mozilla/5.0",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("CHINAMONEY_REDIRECT_REJECTED");
    if (!response.ok) throw new Error(`CHINAMONEY_XLSX_HTTP_${response.status}`);
    const rawBody = await readBoundedResponseBody(response, MAX_WORKBOOK_BYTES, "CHINAMONEY_XLSX_SIZE_INVALID");
    const parsedWorkbook = await parseChinaMoneyWorkbook(rawBody);
    if (parsedWorkbook.records.some((record) => record["validDate"]! < pageFrom.toString() || record["validDate"]! > pageTo.toString())) {
      throw new Error("CHINAMONEY_XLSX_DATE_OUT_OF_RANGE");
    }
    const payload = {
      ...parsedWorkbook,
      format: "xlsx",
      rawWorkbookBase64: Buffer.from(rawBody).toString("base64"),
    };
    return {
      request: {
        endpoint: `${url.origin}${url.pathname}`,
        from: pageFrom.toString(),
        to: pageTo.toString(),
        page: String(page),
        pageSize: String(pageSize),
        format: "xlsx",
      },
      status: response.status,
      headers: {
        "content-type": response.headers.get("content-type") ?? "",
        "content-disposition": response.headers.get("content-disposition") ?? "",
      },
      rawBody,
      payload,
      page,
      hasMore: Temporal.PlainDate.compare(pageTo, requestedTo) < 0,
    };
  }
}
