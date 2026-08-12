import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChinaMoneyJsonSource,
  FixtureChinaMoneySource,
  HttpChinaMoneySource,
  normalizeOfficialQuote,
  parseChinaMoneyPage,
} from "../../src/modules/fx/index.js";

const fixturePath = resolve("tests/fixtures/fx/chinamoney-sample.json");

function officialJson(input: {
  readonly startDate?: string;
  readonly endDate?: string;
  readonly records?: ReadonlyArray<{ readonly date: string; readonly values: readonly string[] }>;
  readonly pageTotal?: number;
} = {}): unknown {
  const records = input.records ?? [{ date: "2026-08-10", values: ["6.7884", "---"] }];
  return {
    head: { version: "2.0", provider: "CWAP", rep_code: "200", rep_message: "" },
    data: {
      head: ["USD/CNY", "EUR/CNY"],
      total: records.length,
      pageTotal: input.pageTotal ?? 1,
      searchlist: ["USD/CNY", "EUR/CNY"],
      endDate: input.endDate ?? "2026-08-11",
      pageSize: 15,
      currency: "",
      pageNum: 1,
      startDate: input.startDate ?? "2026-07-31",
    },
    records,
  };
}

describe("ChinaMoney provider adapter", () => {
  it("parses wide official quote rows, 100 JPY and explicit non-trading evidence", async () => {
    const payload: unknown = JSON.parse(await readFile(fixturePath, "utf8"));
    const parsed = parseChinaMoneyPage(payload);
    expect(parsed.explicitNonTradingDates).toEqual(["2026-07-25", "2026-07-26"]);
    expect(parsed.quotes).toHaveLength(3);
    expect(parsed.quotes.map((quote, index) => normalizeOfficialQuote({
      id: `q-${index}`,
      snapshotId: "snapshot",
      ...quote,
    }).cnyPerUnit)).toEqual(["7.10000000", "0.04800000", "1.53846154"]);
  });

  it("rejects conflicting values for one date and currency pair", () => {
    expect(() => parseChinaMoneyPage({ records: [
      { validDate: "2026-07-24", currencyPair: "USD/CNY", rate: "7.1" },
      { validDate: "2026-07-24", currencyPair: "USD/CNY", rate: "7.2" },
    ] })).toThrow("CHINAMONEY_CONFLICTING_QUOTE");
  });

  it("strictly parses the official head/values table without treating missing cells as zero", () => {
    const parsed = parseChinaMoneyPage(officialJson({
      records: [
        { date: "2026-08-10", values: ["6.7884", "7.8171"] },
        { date: "2026-08-07", values: ["6.7904", "---"] },
      ],
    }));
    expect(parsed.quotes).toEqual([
      { validDate: "2026-08-10", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "6.7884" },
      { validDate: "2026-08-10", baseCurrency: "EUR", quoteCurrency: "CNY", baseUnit: "1", rate: "7.8171" },
      { validDate: "2026-08-07", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "6.7904" },
    ]);
    expect(() => parseChinaMoneyPage({
      ...(officialJson() as Record<string, unknown>),
      records: [{ date: "2026-08-10", values: ["6.7884"] }],
    })).toThrow("CHINAMONEY_TABLE_RECORD_INVALID");
    expect(() => parseChinaMoneyPage({
      ...(officialJson() as Record<string, unknown>),
      records: [{ date: "2026-08-10", values: ["not-a-rate", "---"] }],
    })).toThrow("CHINAMONEY_TABLE_RATE_INVALID");
  });

  it("retains directional pairs for normalization-level conflict validation", () => {
    const parsed = parseChinaMoneyPage({ records: [{
      validDate: "2026-07-24",
      "USD/CNY": "7.10000000",
      "CNY/USD": "0.15000000"
    }] });
    expect(parsed.quotes).toHaveLength(2);
  });

  it("rejects JSON numeric rates before JavaScript number precision can enter finance", () => {
    expect(() => parseChinaMoneyPage({ records: [
      { validDate: "2026-07-24", currencyPair: "USD/CNY", rate: 7.1 },
    ] })).toThrow("CHINAMONEY_QUOTES_NOT_FOUND");
  });

  it("keeps fixture use local and single-page", async () => {
    const source = new FixtureChinaMoneySource(fixturePath);
    const page = await source.fetchPage({ from: "2026-07-24", to: "2026-07-26" }, 1, 500);
    expect(page).toMatchObject({ status: 200, page: 1, hasMore: false });
    expect(page.request.fixture).toBe("chinamoney-sample.json");
    expect(page.request.fixture).not.toContain(":");
    await expect(source.fetchPage({ from: "2026-07-24", to: "2026-07-26" }, 2, 500))
      .rejects.toThrow("CHINAMONEY_FIXTURE_SINGLE_PAGE_ONLY");
  });

  it("requires a pageable endpoint and preserves page metadata", async () => {
    expect(() => new HttpChinaMoneySource("https://example.test?from={from}"))
      .toThrow("CHINAMONEY_ENDPOINT_PLACEHOLDER_MISSING");
    const requests: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      requests.push(String(input));
      return new Response(JSON.stringify({
        records: [{ validDate: "2026-07-24", currencyPair: "USD/CNY", rate: "7.1" }],
        totalPages: 2,
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const source = new HttpChinaMoneySource(
      "https://example.test/quotes?from={from}&to={to}&page={page}&size={pageSize}",
      fetcher,
    );
    const page = await source.fetchPage({ from: "2026-07-01", to: "2026-07-24" }, 1, 500);
    expect(page.hasMore).toBe(true);
    expect(requests[0]).toContain("page=1");
    expect(page.request).toEqual({ endpoint: "https://example.test/quotes", from: "2026-07-01", to: "2026-07-24", page: "1", pageSize: "500" });
  });

  it("rejects redirects and oversized chunked responses", async () => {
    const endpoint = "https://example.test/quotes?from={from}&to={to}&page={page}&size={pageSize}";
    let redirectMode: RequestRedirect | undefined;
    const redirecting: typeof fetch = async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/internal" } });
    };
    await expect(new HttpChinaMoneySource(endpoint, redirecting).fetchPage({ from: "2026-07-01", to: "2026-07-24" }, 1, 500))
      .rejects.toThrow("CHINAMONEY_REDIRECT_REJECTED");
    expect(redirectMode).toBe("manual");

    const oversized: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6 * 1024 * 1024));
        controller.enqueue(new Uint8Array(6 * 1024 * 1024));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "application/json" } });
    await expect(new HttpChinaMoneySource(endpoint, oversized).fetchPage({ from: "2026-07-01", to: "2026-07-24" }, 1, 500))
      .rejects.toThrow("CHINAMONEY_RESPONSE_SIZE_INVALID");
  });

  it("posts the official all-pairs query in 21-day slices and bounds current-day absence evidence", async () => {
    let requestUrl: URL | undefined;
    let requestInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      requestUrl = new URL(String(input));
      requestInit = init;
      return new Response(JSON.stringify(officialJson()), {
        status: 200,
        headers: { "content-type": "application/json;charset=UTF-8" },
      });
    };
    const source = new ChinaMoneyJsonSource(
      "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew",
      fetcher,
      () => "2026-08-11",
    );
    const page = await source.fetchPage({ from: "2026-07-31", to: "2026-08-11" }, 1, 15);
    const headers = new Headers(requestInit?.headers);

    expect(requestInit?.method).toBe("POST");
    expect(requestInit?.redirect).toBe("manual");
    expect(requestInit?.body).toBe("");
    expect(headers.get("origin")).toBe("https://www.chinamoney.com.cn");
    expect(headers.get("referer")).toBe("https://www.chinamoney.com.cn/chinese/bkccpr/index.html?tab=2");
    expect(headers.get("user-agent")).toContain("Mozilla/5.0");
    expect(requestUrl?.searchParams.get("startDate")).toBe("2026-07-31");
    expect(requestUrl?.searchParams.get("endDate")).toBe("2026-08-11");
    expect(requestUrl?.searchParams.get("pageNum")).toBe("1");
    expect(requestUrl?.searchParams.get("pageSize")).toBe("15");
    expect(page.request).toMatchObject({
      method: "POST",
      from: "2026-07-31",
      to: "2026-08-11",
      pageSize: "15",
      allPairs: "true",
      allPairsAbsentThrough: "2026-08-10",
    });
    expect(page.hasMore).toBe(false);
  });

  it("maps source pages to non-overlapping 21-calendar-day official queries", async () => {
    const requests: Array<{ from: string; to: string }> = [];
    const fetcher: typeof fetch = async (input) => {
      const url = new URL(String(input));
      const from = url.searchParams.get("startDate")!;
      const to = url.searchParams.get("endDate")!;
      requests.push({ from, to });
      return new Response(JSON.stringify(officialJson({
        startDate: from,
        endDate: to,
        records: [{ date: to, values: ["6.8", "7.8"] }],
      })), { status: 200, headers: { "content-type": "application/json" } });
    };
    const source = new ChinaMoneyJsonSource(
      "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew",
      fetcher,
      () => "2026-08-12",
    );
    const range = { from: "2026-07-01", to: "2026-08-11" };

    await expect(source.fetchPage(range, 1, 15)).resolves.toMatchObject({ hasMore: true });
    await expect(source.fetchPage(range, 2, 15)).resolves.toMatchObject({ hasMore: false });
    expect(requests).toEqual([
      { from: "2026-07-01", to: "2026-07-21" },
      { from: "2026-07-22", to: "2026-08-11" },
    ]);
  });

  it("fails closed on multi-page or out-of-range official responses and leaves an empty current day unproven", async () => {
    const response = (payload: unknown): typeof fetch => async () => new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    const endpoint = "https://www.chinamoney.com.cn/ags/ms/cm-u-bk-ccpr/CcprHisNew";
    await expect(new ChinaMoneyJsonSource(endpoint, response(officialJson({ pageTotal: 2 })), () => "2026-08-11")
      .fetchPage({ from: "2026-07-31", to: "2026-08-11" }, 1, 15))
      .rejects.toThrow("CHINAMONEY_JSON_PAGINATION_INVALID");
    await expect(new ChinaMoneyJsonSource(endpoint, response(officialJson({
      records: [{ date: "2026-07-30", values: ["6.7", "7.8"] }],
    })), () => "2026-08-11").fetchPage({ from: "2026-07-31", to: "2026-08-11" }, 1, 15))
      .rejects.toThrow("CHINAMONEY_JSON_DATE_OUT_OF_RANGE");

    const empty = officialJson({ startDate: "2026-08-11", endDate: "2026-08-11", records: [] });
    const page = await new ChinaMoneyJsonSource(endpoint, response(empty), () => "2026-08-11")
      .fetchPage({ from: "2026-08-11", to: "2026-08-11" }, 1, 15);
    expect(page.request.allPairsAbsentThrough).toBe("none");
    expect(parseChinaMoneyPage(page.payload).quotes).toEqual([]);
  });
});
