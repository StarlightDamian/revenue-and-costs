import { describe, expect, it } from "vitest";
import {
  convertBatch,
  convertCurrency,
  normalizeOfficialQuote,
  type FxQuoteBook,
  type NormalizedFxQuote,
} from "../../src/modules/fx";

const quotes: NormalizedFxQuote[] = [
  normalizeOfficialQuote({ id: "usd-1", snapshotId: "s1", validDate: "2026-07-24", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "7.10000000" }),
  normalizeOfficialQuote({ id: "jpy-1", snapshotId: "s1", validDate: "2026-07-24", baseCurrency: "JPY", quoteCurrency: "CNY", baseUnit: "100", rate: "4.80000000" }),
  normalizeOfficialQuote({ id: "myr-1", snapshotId: "s1", validDate: "2026-07-24", baseCurrency: "CNY", quoteCurrency: "MYR", baseUnit: "1", rate: "0.65000000" }),
  normalizeOfficialQuote({ id: "usd-next", snapshotId: "s2", validDate: "2026-07-27", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "7.20000000" }),
  normalizeOfficialQuote({ id: "myr-next", snapshotId: "s2", validDate: "2026-07-27", baseCurrency: "CNY", quoteCurrency: "MYR", baseUnit: "1", rate: "0.64000000" }),
  normalizeOfficialQuote({ id: "eur-open", snapshotId: "s2", validDate: "2026-07-28", baseCurrency: "EUR", quoteCurrency: "CNY", baseUnit: "1", rate: "8.20000000" }),
];

const book: FxQuoteBook = {
  official: quotes,
  marketDayStatus: (date) => date === "2026-07-25" || date === "2026-07-26" ? "NON_TRADING" : "OPEN",
};

describe("汇率 Golden", () => {
  it("规范化 USD、100JPY 和 CNY/MYR", () => {
    expect(quotes.slice(0, 3).map((quote) => quote.cnyPerUnit)).toEqual([
      "7.10000000",
      "0.04800000",
      "1.53846154",
    ]);
  });

  it.each([
    ["2026-07-25", "2"],
    ["2026-07-26", "1"],
  ])("两个非 CNY 币种在周末 %s 后只使用共同的下一个工作日", (requestedDate, fallbackDays) => {
    expect(convertCurrency(book, requestedDate, "USD", "MYR")).toMatchObject({
      status: "OK",
      hitDate: "2026-07-27",
      fallbackDays,
      rate: "4.60800000",
      quoteIds: ["usd-next", "myr-next"],
      overrideIds: [],
    });
  });

  it("开市日存在其他报价但目标币对缺失时不借旧报价", () => {
    expect(convertCurrency(book, "2026-07-28", "USD", "CNY")).toMatchObject({
      status: "DATA_GAP",
      hitDate: "2026-07-28",
      fallbackDays: "0",
    });
  });

  it("相同币种返回输入日期并保留批量输入顺序、重复和无效行", () => {
    const result = convertBatch(book, [
      { input: "2026/07/24", fromCurrency: "CNY", toCurrency: "CNY" },
      { input: "2026/07/24", fromCurrency: "CNY", toCurrency: "CNY" },
      { input: "03/04/2026", fromCurrency: "USD", toCurrency: "CNY" },
      { input: "", fromCurrency: "USD", toCurrency: "CNY" },
    ]);
    expect(result.map((row) => row.status)).toEqual(["OK", "OK", "INVALID_DATE", "INVALID_DATE"]);
    expect(result[0]).toMatchObject({ input: "2026/07/24", rate: "1.00000000", fallbackDays: "0" });
  });

  it("人工值只能在开市日补缺口且不覆盖官方值", () => {
    const manualBook: FxQuoteBook = {
      official: quotes,
      overrides: [{ id: "manual-usd", currency: "USD", validFrom: "2026-07-28", validTo: "2026-07-28", cnyPerUnit: "7.20000000" }],
      marketDayStatus: book.marketDayStatus,
    };
    expect(convertCurrency(manualBook, "2026-07-28", "USD", "CNY")).toMatchObject({
      status: "OK",
      rate: "7.20000000",
      quoteIds: [],
      overrideIds: ["manual-usd"],
    });
  });

  it("交易日状态未知时不把报价缺失猜成非交易日并继续顺延", () => {
    const unknownBook: FxQuoteBook = {
      official: quotes,
      marketDayStatus: () => "UNKNOWN",
    };
    expect(convertCurrency(unknownBook, "2026-07-26", "USD", "CNY")).toMatchObject({
      status: "NO_AVAILABLE_QUOTE",
      hitDate: "2026-07-26",
      fallbackDays: "0",
    });
  });

  it("第一个开市日缺少目标币对时不继续寻找更晚报价", () => {
    const gapBook: FxQuoteBook = {
      official: [
        normalizeOfficialQuote({ id: "eur-monday", snapshotId: "s3", validDate: "2026-07-27", baseCurrency: "EUR", quoteCurrency: "CNY", baseUnit: "1", rate: "8.10000000" }),
        normalizeOfficialQuote({ id: "usd-tuesday", snapshotId: "s3", validDate: "2026-07-28", baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "7.30000000" }),
      ],
      marketDayStatus: book.marketDayStatus,
    };
    expect(convertCurrency(gapBook, "2026-07-26", "USD", "CNY")).toMatchObject({
      status: "DATA_GAP",
      hitDate: "2026-07-27",
      fallbackDays: "1",
    });
  });

  it("最多向未来顺延十个自然日", () => {
    const quoteAtLimit = normalizeOfficialQuote({
      id: "usd-at-limit", snapshotId: "s4", validDate: "2026-08-11",
      baseCurrency: "USD", quoteCurrency: "CNY", baseUnit: "1", rate: "7.40000000",
    });
    const withinLimit: FxQuoteBook = {
      official: [quoteAtLimit],
      marketDayStatus: (date) => date === "2026-08-11" ? "OPEN" : "NON_TRADING",
    };
    expect(convertCurrency(withinLimit, "2026-08-01", "USD", "CNY")).toMatchObject({
      status: "OK",
      hitDate: "2026-08-11",
      fallbackDays: "10",
    });

    const beyondLimit: FxQuoteBook = {
      official: [{ ...quoteAtLimit, id: "usd-beyond-limit", validDate: "2026-08-12" }],
      marketDayStatus: (date) => date === "2026-08-12" ? "OPEN" : "NON_TRADING",
    };
    expect(convertCurrency(beyondLimit, "2026-08-01", "USD", "CNY")).toMatchObject({
      status: "NO_AVAILABLE_QUOTE",
    });
  });
});
