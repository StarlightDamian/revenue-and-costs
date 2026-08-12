import { Temporal } from "@js-temporal/polyfill";
import {
  parseChinaMoneyPage,
  readBoundedResponseBody,
  type ChinaMoneyPage,
  type ChinaMoneyRange,
  type ChinaMoneySource,
} from "./chinamoney.js";

export const CHINAMONEY_JSON_ENDPOINT = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew";
const CHINAMONEY_REFERER = "https://www.chinamoney.com.cn/chinese/bkccpr/index.html?tab=2";
const CHINAMONEY_ORIGIN = "https://www.chinamoney.com.cn";
const CHINAMONEY_PAGE_SIZE = 15;
const CHINAMONEY_SLICE_DAYS = 21;
const MAX_JSON_RESPONSE_BYTES = 10 * 1024 * 1024;

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateOfficialPayload(
  payload: unknown,
  range: ChinaMoneyRange,
): ReturnType<typeof parseChinaMoneyPage> {
  const root = object(payload);
  const envelope = object(root?.head);
  const data = object(root?.data);
  if (envelope?.rep_code !== "200" || envelope.provider !== "CWAP") {
    throw new Error("CHINAMONEY_JSON_ENVELOPE_INVALID");
  }
  if (!data || data.startDate !== range.from || data.endDate !== range.to || data.currency !== "") {
    throw new Error("CHINAMONEY_JSON_RANGE_ECHO_INVALID");
  }
  if (data.pageNum !== 1 || data.pageSize !== CHINAMONEY_PAGE_SIZE || data.pageTotal !== 1) {
    throw new Error("CHINAMONEY_JSON_PAGINATION_INVALID");
  }
  if (!Array.isArray(root?.records) || !Number.isSafeInteger(data.total)
    || data.total !== root.records.length || root.records.length > CHINAMONEY_PAGE_SIZE) {
    throw new Error("CHINAMONEY_JSON_RECORD_COUNT_INVALID");
  }
  const parsed = parseChinaMoneyPage(payload);
  const dates = [
    ...parsed.quotes.map((quote) => quote.validDate),
    ...parsed.explicitNonTradingDates,
  ];
  if (dates.some((date) => date < range.from || date > range.to)) {
    throw new Error("CHINAMONEY_JSON_DATE_OUT_OF_RANGE");
  }
  return parsed;
}

function safeAbsenceCutoff(
  pageTo: Temporal.PlainDate,
  shanghaiToday: Temporal.PlainDate,
  openDates: readonly string[],
): string {
  if (Temporal.PlainDate.compare(pageTo, shanghaiToday) < 0) return pageTo.toString();
  const latestOpen = [...new Set(openDates)].sort().at(-1);
  return latestOpen ?? "none";
}

export class ChinaMoneyJsonSource implements ChinaMoneySource {
  readonly sourceName = "ChinaMoney" as const;
  readonly pageSize = CHINAMONEY_PAGE_SIZE;

  constructor(
    private readonly endpoint = CHINAMONEY_JSON_ENDPOINT,
    private readonly fetcher: typeof fetch = fetch,
    private readonly shanghaiToday: () => string = () => Temporal.Now.plainDateISO("Asia/Shanghai").toString(),
  ) {}

  async fetchPage(range: ChinaMoneyRange, page: number, pageSize: number): Promise<ChinaMoneyPage> {
    if (!Number.isSafeInteger(page) || page < 1) throw new Error("CHINAMONEY_JSON_PAGE_INVALID");
    if (pageSize !== CHINAMONEY_PAGE_SIZE) throw new Error("CHINAMONEY_JSON_PAGE_SIZE_INVALID");
    const requestedFrom = Temporal.PlainDate.from(range.from);
    const requestedTo = Temporal.PlainDate.from(range.to);
    if (Temporal.PlainDate.compare(requestedFrom, requestedTo) > 0) throw new Error("CHINAMONEY_JSON_RANGE_INVALID");
    const pageFrom = requestedFrom.add({ days: (page - 1) * CHINAMONEY_SLICE_DAYS });
    if (Temporal.PlainDate.compare(pageFrom, requestedTo) > 0) throw new Error("CHINAMONEY_JSON_PAGE_OUT_OF_RANGE");
    const candidateTo = pageFrom.add({ days: CHINAMONEY_SLICE_DAYS - 1 });
    const pageTo = Temporal.PlainDate.compare(candidateTo, requestedTo) < 0 ? candidateTo : requestedTo;
    const pageRange = { from: pageFrom.toString(), to: pageTo.toString() };
    const url = new URL(this.endpoint);
    url.searchParams.set("lang", "CN");
    url.searchParams.set("startDate", pageRange.from);
    url.searchParams.set("endDate", pageRange.to);
    url.searchParams.set("currency", "");
    url.searchParams.set("pageNum", "1");
    url.searchParams.set("pageSize", String(CHINAMONEY_PAGE_SIZE));
    const response = await this.fetcher(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        origin: CHINAMONEY_ORIGIN,
        referer: CHINAMONEY_REFERER,
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/127.0.0.0 Safari/537.36",
      },
      body: "",
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("CHINAMONEY_REDIRECT_REJECTED");
    if (!response.ok) throw new Error(`CHINAMONEY_JSON_HTTP_${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/iu.test(contentType)) throw new Error("CHINAMONEY_JSON_CONTENT_TYPE_INVALID");
    const rawBody = new TextDecoder("utf-8", { fatal: true }).decode(
      await readBoundedResponseBody(response, MAX_JSON_RESPONSE_BYTES, "CHINAMONEY_RESPONSE_SIZE_INVALID"),
    );
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      throw new Error("CHINAMONEY_RESPONSE_NOT_JSON");
    }
    const parsed = validateOfficialPayload(payload, pageRange);
    const today = Temporal.PlainDate.from(this.shanghaiToday());
    const allPairsAbsentThrough = safeAbsenceCutoff(
      pageTo,
      today,
      parsed.quotes.map((quote) => quote.validDate),
    );
    return {
      request: {
        endpoint: `${url.origin}${url.pathname}`,
        method: "POST",
        from: pageRange.from,
        to: pageRange.to,
        page: String(page),
        apiPage: "1",
        pageSize: String(CHINAMONEY_PAGE_SIZE),
        allPairs: "true",
        allPairsAbsentThrough,
      },
      status: response.status,
      headers: { "content-type": contentType },
      rawBody,
      payload,
      page,
      hasMore: Temporal.PlainDate.compare(pageTo, requestedTo) < 0,
    };
  }
}
