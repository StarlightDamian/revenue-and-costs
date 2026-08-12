import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { decimal } from "./decimal.js";
import { parseUnambiguousDate } from "./date.js";

export interface ChinaMoneyRange { readonly from: string; readonly to: string }

export interface ChinaMoneyPage {
  readonly request: Readonly<Record<string, string>>;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string | Uint8Array;
  readonly payload: unknown;
  readonly page: number;
  readonly hasMore: boolean;
}

export interface ChinaMoneySource {
  readonly sourceName: "ChinaMoney" | "ChinaMoneyXlsx" | "ChinaMoneyFixture";
  readonly pageSize?: number;
  fetchPage(range: ChinaMoneyRange, page: number, pageSize: number): Promise<ChinaMoneyPage>;
}

export interface ChinaMoneyQuoteRecord {
  readonly validDate: string;
  readonly baseCurrency: string;
  readonly quoteCurrency: string;
  readonly baseUnit: string;
  readonly rate: string;
}

export interface ParsedChinaMoneyPage {
  readonly quotes: readonly ChinaMoneyQuoteRecord[];
  readonly explicitNonTradingDates: readonly string[];
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

interface ChinaMoneyRecordSet {
  readonly rows: readonly Record<string, unknown>[];
  readonly authoritativeTable: boolean;
}

function records(payload: unknown): ChinaMoneyRecordSet {
  const root = object(payload);
  const data = object(root?.data);
  if (Array.isArray(data?.head)) {
    if (!Array.isArray(root?.records) || !Array.isArray(data.searchlist)) {
      throw new Error("CHINAMONEY_TABLE_RECORD_INVALID");
    }
    const headers = data.head.map((value) => typeof value === "string" ? value.trim().toUpperCase() : "");
    const searchList = data.searchlist.map((value) => typeof value === "string" ? value.trim().toUpperCase() : "");
    if (headers.length === 0 || new Set(headers).size !== headers.length
      || headers.some((header) => !/^(?:\d+)?[A-Z]{3}\/[A-Z]{3}$/u.test(header))
      || searchList.length !== headers.length
      || searchList.some((header, index) => header !== headers[index])) {
      throw new Error("CHINAMONEY_TABLE_HEADER_INVALID");
    }
    const seenDates = new Set<string>();
    const rows = root.records.map((value) => {
      const row = object(value);
      if (!row || typeof row.date !== "string" || !Array.isArray(row.values) || row.values.length !== headers.length) {
        throw new Error("CHINAMONEY_TABLE_RECORD_INVALID");
      }
      const validDate = parseUnambiguousDate(row.date);
      if (!validDate) throw new Error("CHINAMONEY_TABLE_RECORD_INVALID");
      if (seenDates.has(validDate)) throw new Error("CHINAMONEY_TABLE_DUPLICATE_DATE");
      seenDates.add(validDate);
      const normalized: Record<string, unknown> = { validDate };
      for (const [index, header] of headers.entries()) {
        const rawValue = row.values[index];
        if (typeof rawValue !== "string") throw new Error("CHINAMONEY_TABLE_RATE_INVALID");
        const value = rawValue.trim();
        if (/^-+$/u.test(value)) continue;
        const parsedRate = rate(value);
        if (!parsedRate) throw new Error("CHINAMONEY_TABLE_RATE_INVALID");
        normalized[header] = value;
      }
      return normalized;
    });
    return { rows, authoritativeTable: true };
  }
  const candidates = [root?.records, data?.records, data?.result, root?.result, root?.data];
  const found = candidates.find(Array.isArray);
  if (!found) throw new Error("CHINAMONEY_RECORDS_NOT_FOUND");
  return {
    rows: found.map(object).filter((row): row is Record<string, unknown> => Boolean(row)),
    authoritativeTable: false,
  };
}

function recordDate(row: Record<string, unknown>): string {
  for (const key of ["validDate", "valid_date", "tradeDate", "showDateCN", "showDate", "date"]) {
    const value = row[key];
    if (typeof value === "string") {
      const parsed = parseUnambiguousDate(value);
      if (parsed) return parsed;
    }
  }
  throw new Error("CHINAMONEY_RECORD_DATE_INVALID");
}

function pair(value: string): { baseCurrency: string; quoteCurrency: string; baseUnit: string } | undefined {
  const match = /^(?:(\d+))?([A-Z]{3})\/([A-Z]{3})$/u.exec(value.trim().toUpperCase());
  if (!match) return undefined;
  return { baseCurrency: match[2]!, quoteCurrency: match[3]!, baseUnit: match[1] ?? "1" };
}

function rate(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll(",", "");
  try {
    const parsed = decimal(normalized);
    return parsed.isPositive() ? parsed.toFixed() : undefined;
  } catch {
    return undefined;
  }
}

export function parseChinaMoneyPage(payload: unknown): ParsedChinaMoneyPage {
  const quotes: ChinaMoneyQuoteRecord[] = [];
  const recordSet = records(payload);
  for (const row of recordSet.rows) {
    const validDate = recordDate(row);
    const longPair = typeof row.currencyPair === "string" ? pair(row.currencyPair)
      : typeof row.pair === "string" ? pair(row.pair) : undefined;
    const longRate = rate(row.rate ?? row.centralParityRate ?? row.middlePrice ?? row.price);
    if (longPair && longRate) quotes.push({ validDate, ...longPair, rate: longRate });
    for (const [key, value] of Object.entries(row)) {
      const parsedPair = pair(key);
      const parsedRate = rate(value);
      if (parsedPair && parsedRate) quotes.push({ validDate, ...parsedPair, rate: parsedRate });
    }
  }
  const unique = new Map<string, ChinaMoneyQuoteRecord>();
  for (const quote of quotes) {
    const key = `${quote.validDate}:${quote.baseUnit}${quote.baseCurrency}/${quote.quoteCurrency}`;
    const existing = unique.get(key);
    if (existing && existing.rate !== quote.rate) throw new Error(`CHINAMONEY_CONFLICTING_QUOTE:${key}`);
    unique.set(key, quote);
  }
  const root = object(payload);
  const data = object(root?.data);
  const rawNonTrading = root?.nonTradingDates ?? data?.nonTradingDates;
  const explicitNonTradingDates = Array.isArray(rawNonTrading)
    ? rawNonTrading.map((value) => typeof value === "string" ? parseUnambiguousDate(value) : undefined)
      .filter((value): value is string => Boolean(value))
    : [];
  if (unique.size === 0 && explicitNonTradingDates.length === 0 && !recordSet.authoritativeTable) {
    throw new Error("CHINAMONEY_QUOTES_NOT_FOUND");
  }
  return { quotes: [...unique.values()], explicitNonTradingDates };
}

function pageCount(payload: unknown): number | undefined {
  const root = object(payload); const data = object(root?.data);
  for (const value of [root?.totalPages, root?.pageTotal, data?.totalPages, data?.pageTotal]) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (Number.isInteger(number) && number >= 1) return number;
  }
  return undefined;
}

const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

export async function readBoundedResponseBody(response: Response, maxBytes: number, errorCode: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const value = Number(declared);
    if (!Number.isSafeInteger(value) || value < 0 || value > maxBytes) throw new Error(errorCode);
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel(errorCode);
        throw new Error(errorCode);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export class HttpChinaMoneySource implements ChinaMoneySource {
  readonly sourceName = "ChinaMoney" as const;
  constructor(private readonly endpointTemplate: string, private readonly fetcher: typeof fetch = fetch) {
    for (const placeholder of ["{from}", "{to}", "{page}", "{pageSize}"]) {
      if (!endpointTemplate.includes(placeholder)) throw new Error(`CHINAMONEY_ENDPOINT_PLACEHOLDER_MISSING:${placeholder}`);
    }
  }

  async fetchPage(range: ChinaMoneyRange, page: number, pageSize: number): Promise<ChinaMoneyPage> {
    const url = this.endpointTemplate
      .replaceAll("{from}", encodeURIComponent(range.from)).replaceAll("{to}", encodeURIComponent(range.to))
      .replaceAll("{page}", String(page)).replaceAll("{pageSize}", String(pageSize));
    const response = await this.fetcher(url, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("CHINAMONEY_REDIRECT_REJECTED");
    if (!response.ok) throw new Error(`CHINAMONEY_HTTP_${response.status}`);
    const rawBody = new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedResponseBody(response, MAX_JSON_RESPONSE_BYTES, "CHINAMONEY_RESPONSE_SIZE_INVALID"),
    );
    let payload: unknown;
    try { payload = JSON.parse(rawBody); } catch { throw new Error("CHINAMONEY_RESPONSE_NOT_JSON"); }
    const parsed = parseChinaMoneyPage(payload);
    const totalPages = pageCount(payload);
    const requestUrl = new URL(url);
    return {
      request: { endpoint: `${requestUrl.origin}${requestUrl.pathname}`, from: range.from, to: range.to, page: String(page), pageSize: String(pageSize) },
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "" },
      rawBody,
      payload,
      page,
      hasMore: totalPages !== undefined ? page < totalPages : parsed.quotes.length >= pageSize,
    };
  }
}

export class FixtureChinaMoneySource implements ChinaMoneySource {
  readonly sourceName = "ChinaMoneyFixture" as const;
  constructor(private readonly fixturePath: string) {}
  async fetchPage(range: ChinaMoneyRange, page: number, pageSize: number): Promise<ChinaMoneyPage> {
    if (page !== 1) throw new Error("CHINAMONEY_FIXTURE_SINGLE_PAGE_ONLY");
    const rawBody = await readFile(this.fixturePath, "utf8");
    const payload: unknown = JSON.parse(rawBody);
    parseChinaMoneyPage(payload);
    return { request: { fixture: basename(this.fixturePath), from: range.from, to: range.to, page: "1", pageSize: String(pageSize) }, status: 200, headers: { "content-type": "application/json" }, rawBody, payload, page, hasMore: false };
  }
}
