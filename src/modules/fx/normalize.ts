import { currencyCode, decimal, decimal8 } from "./decimal.js";
import type { NormalizedFxQuote, RawFxQuote } from "./types.js";

export function normalizeOfficialQuote(quote: RawFxQuote): NormalizedFxQuote {
  const base = currencyCode(quote.baseCurrency);
  const counter = currencyCode(quote.quoteCurrency);
  const unit = decimal(quote.baseUnit);
  const rate = decimal(quote.rate);
  if (!unit.isPositive() || !rate.isPositive()) {
    throw new Error("FX_RATE_MUST_BE_POSITIVE");
  }

  if (counter === "CNY" && base !== "CNY") {
    return {
      id: quote.id,
      source: "OFFICIAL",
      validDate: quote.validDate,
      currency: base,
      cnyPerUnit: decimal8(rate.div(unit)),
    };
  }

  if (base === "CNY" && counter !== "CNY") {
    return {
      id: quote.id,
      source: "OFFICIAL",
      validDate: quote.validDate,
      currency: counter,
      cnyPerUnit: decimal8(unit.div(rate)),
    };
  }

  throw new Error(`UNSUPPORTED_OFFICIAL_PAIR:${base}/${counter}`);
}

