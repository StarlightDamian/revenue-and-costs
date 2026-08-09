import { currencyCode, decimal, decimal8 } from "./decimal.js";
import { addDays, parseUnambiguousDate } from "./date.js";
import type {
  BatchFxInput,
  BatchFxOutput,
  FxConversion,
  FxOverride,
  FxQuoteBook,
  IsoDate,
  NormalizedFxQuote,
} from "./types.js";

const DEFAULT_FALLBACK_DAYS = 10;

interface LocatedRate {
  readonly cnyPerUnit: string;
  readonly id: string;
  readonly source: "OFFICIAL" | "MANUAL" | "IDENTITY";
}

function officialAt(book: FxQuoteBook, date: IsoDate): readonly NormalizedFxQuote[] {
  return book.official.filter((quote) => quote.validDate === date);
}

function findOverride(
  overrides: readonly FxOverride[],
  currency: string,
  date: string,
): LocatedRate | undefined {
  const matches = overrides.filter(
    (override) =>
      override.currency === currency && override.validFrom <= date && date <= override.validTo,
  );
  if (matches.length > 1) throw new Error(`AMBIGUOUS_FX_OVERRIDE:${currency}:${date}`);
  const match = matches[0];
  return match ? { cnyPerUnit: match.cnyPerUnit, id: match.id, source: "MANUAL" } : undefined;
}

function locateCurrency(
  book: FxQuoteBook,
  dayQuotes: readonly NormalizedFxQuote[],
  currency: string,
  date: string,
): LocatedRate | undefined {
  if (currency === "CNY") return { cnyPerUnit: "1.00000000", id: "CNY", source: "IDENTITY" };
  const official = dayQuotes.filter((quote) => quote.currency === currency);
  if (official.length > 1) throw new Error(`AMBIGUOUS_OFFICIAL_QUOTE:${currency}:${date}`);
  if (official[0]) return { cnyPerUnit: official[0].cnyPerUnit, id: official[0].id, source: "OFFICIAL" };
  return findOverride(book.overrides ?? [], currency, date);
}

export function convertCurrency(
  book: FxQuoteBook,
  requestedDate: string,
  fromInput: string,
  toInput: string,
  maximumFallbackDays = DEFAULT_FALLBACK_DAYS,
): FxConversion {
  if (!Number.isInteger(maximumFallbackDays) || maximumFallbackDays < 0 || maximumFallbackDays > 10) {
    throw new Error("INVALID_MAXIMUM_FX_FALLBACK_DAYS");
  }
  const parsedDate = parseUnambiguousDate(requestedDate);
  if (!parsedDate) {
    return {
      status: "INVALID_DATE",
      requestedDate,
      fromCurrency: fromInput,
      toCurrency: toInput,
      quoteIds: [],
      overrideIds: [],
      reason: "日期必须是明确的年-月-日格式",
    };
  }

  let from: string;
  let to: string;
  try {
    from = currencyCode(fromInput);
    to = currencyCode(toInput);
  } catch {
    return {
      status: "INVALID_CURRENCY",
      requestedDate: parsedDate,
      fromCurrency: fromInput,
      toCurrency: toInput,
      quoteIds: [],
      overrideIds: [],
      reason: "币种必须是三位字母代码",
    };
  }

  if (from === to) {
    return {
      status: "OK",
      requestedDate: parsedDate,
      hitDate: parsedDate,
      fromCurrency: from,
      toCurrency: to,
      rate: "1.00000000",
      fallbackDays: "0",
      quoteIds: [],
      overrideIds: [],
    };
  }

  for (let fallback = 0; fallback <= maximumFallbackDays; fallback += 1) {
    const candidate = addDays(parsedDate, fallback);
    const dayQuotes = officialAt(book, candidate);
    const calendar = book.marketDayStatus(candidate);
    const provenNonTrading = calendar === "NON_TRADING";
    if (provenNonTrading) continue;

    if (calendar === "UNKNOWN" && dayQuotes.length === 0) {
      return {
        status: "NO_AVAILABLE_QUOTE",
        requestedDate: parsedDate,
        hitDate: candidate,
        fromCurrency: from,
        toCurrency: to,
        fallbackDays: String(fallback),
        quoteIds: [],
        overrideIds: [],
        reason: "交易日状态未知，不能把缺失报价推断为非交易日",
      };
    }

    const fromRate = locateCurrency(book, dayQuotes, from, candidate);
    const toRate = locateCurrency(book, dayQuotes, to, candidate);
    if (!fromRate || !toRate) {
      return {
        status: "DATA_GAP",
        requestedDate: parsedDate,
        hitDate: candidate,
        fromCurrency: from,
        toCurrency: to,
        fallbackDays: String(fallback),
        quoteIds: [fromRate, toRate]
          .filter((rate): rate is LocatedRate => rate?.source === "OFFICIAL")
          .map((rate) => rate.id),
        overrideIds: [fromRate, toRate]
          .filter((rate): rate is LocatedRate => rate?.source === "MANUAL")
          .map((rate) => rate.id),
        reason: "开市日存在报价但目标币种报价缺失",
      };
    }

    return {
      status: "OK",
      requestedDate: parsedDate,
      hitDate: candidate,
      fromCurrency: from,
      toCurrency: to,
      rate: decimal8(decimal(fromRate.cnyPerUnit).div(decimal(toRate.cnyPerUnit))),
      fallbackDays: String(fallback),
      quoteIds: [fromRate, toRate].filter((rate) => rate.source === "OFFICIAL").map((rate) => rate.id),
      overrideIds: [fromRate, toRate].filter((rate) => rate.source === "MANUAL").map((rate) => rate.id),
    };
  }

  return {
    status: "NO_AVAILABLE_QUOTE",
    requestedDate: parsedDate,
    fromCurrency: from,
    toCurrency: to,
    quoteIds: [],
    overrideIds: [],
    reason: `向未来顺延 ${maximumFallbackDays} 个自然日内没有共同可用报价`,
  };
}

export function convertBatch(book: FxQuoteBook, rows: readonly BatchFxInput[]): BatchFxOutput[] {
  return rows.map((row) => ({
    input: row.input,
    ...convertCurrency(book, row.input, row.fromCurrency, row.toCurrency),
  }));
}
