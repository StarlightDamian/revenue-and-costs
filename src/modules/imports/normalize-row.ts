import { Temporal } from "@js-temporal/polyfill";
import Decimal from "decimal.js";
import { canonicalTransactionDescription, canonicalTransactionType } from "../calculation/fee-classification.js";

export interface MarketplaceProfile { code: string; sourceTimezone: string; currency: string; nonAmazon: boolean }

const MARKETPLACES: Readonly<Record<string, Omit<MarketplaceProfile, "nonAmazon"> >> = {
  "amazon.com": { code: "US", sourceTimezone: "America/Los_Angeles", currency: "USD" },
  "amazon.ca": { code: "CA", sourceTimezone: "America/Toronto", currency: "CAD" },
  "amazon.com.mx": { code: "MX", sourceTimezone: "America/Mexico_City", currency: "MXN" },
  "amazon.com.br": { code: "BR", sourceTimezone: "America/Sao_Paulo", currency: "BRL" },
  "amazon.com.au": { code: "AU", sourceTimezone: "Australia/Sydney", currency: "AUD" },
  "amazon.co.uk": { code: "UK", sourceTimezone: "Europe/London", currency: "GBP" },
  "amazon.de": { code: "DE", sourceTimezone: "Europe/Berlin", currency: "EUR" },
  "amazon.fr": { code: "FR", sourceTimezone: "Europe/Paris", currency: "EUR" },
  "amazon.it": { code: "IT", sourceTimezone: "Europe/Rome", currency: "EUR" },
  "amazon.es": { code: "ES", sourceTimezone: "Europe/Madrid", currency: "EUR" },
  "amazon.nl": { code: "NL", sourceTimezone: "Europe/Amsterdam", currency: "EUR" },
  "amazon.com.be": { code: "BE", sourceTimezone: "Europe/Brussels", currency: "EUR" },
  "amazon.ie": { code: "IE", sourceTimezone: "Europe/Dublin", currency: "EUR" },
  "amazon.se": { code: "SE", sourceTimezone: "Europe/Stockholm", currency: "SEK" },
  "amazon.pl": { code: "PL", sourceTimezone: "Europe/Warsaw", currency: "PLN" },
  "amazon.co.jp": { code: "JP", sourceTimezone: "Asia/Tokyo", currency: "JPY" },
  "amazon.jp": { code: "JP", sourceTimezone: "Asia/Tokyo", currency: "JPY" },
  "amazon.ae": { code: "AE", sourceTimezone: "Asia/Dubai", currency: "AED" },
  "amazon.sa": { code: "SA", sourceTimezone: "Asia/Riyadh", currency: "SAR" },
  "amazon.com.tr": { code: "TR", sourceTimezone: "Europe/Istanbul", currency: "TRY" },
};

export function marketplaceProfile(input: string): MarketplaceProfile {
  const key = input.normalize("NFKC").trim().toLocaleLowerCase("und").replace(/^https?:\/\//u, "").replace(/\/$/u, "");
  if (/non[- ]?amazon/u.test(key)) return { code: "NON_AMAZON", sourceTimezone: "UTC", currency: "CNY", nonAmazon: true };
  const known = MARKETPLACES[key];
  if (!known) throw new Error("IMPORT_UNKNOWN_MARKETPLACE");
  return { ...known, nonAmazon: false };
}

/**
 * Resolves the only Amazon marketplace evidenced by non-empty rows in one
 * transaction report. Mixed recognized Amazon sites make blank-cell inference
 * unsafe. Unknown non-empty and Non-Amazon rows remain independently filtered
 * and therefore do not become site candidates.
 */
export class SingleSiteMarketplaceInference {
  private profile: MarketplaceProfile | undefined;
  private mixed = false;

  observe(input: string): void {
    if (!input.normalize("NFKC").trim()) return;
    let candidate: MarketplaceProfile;
    try {
      candidate = marketplaceProfile(input);
    } catch {
      return;
    }
    if (candidate.nonAmazon) return;
    if (this.profile && this.profile.code !== candidate.code) {
      this.mixed = true;
      return;
    }
    this.profile = candidate;
  }

  resolve(): MarketplaceProfile | undefined {
    return this.mixed ? undefined : this.profile;
  }
}

export function normalizedDecimal(input: string | undefined): string {
  let value = (input ?? "").normalize("NFKC").replaceAll("−", "-").trim();
  if (!value || value === "-") throw new Error("IMPORT_FINANCIAL_VALUE_REQUIRED");
  const negative = /^\(.*\)$/u.test(value);
  if (negative) value = value.slice(1, -1).trim();
  else if (value.includes("(") || value.includes(")")) throw new Error("IMPORT_FINANCIAL_VALUE_INVALID");
  value = value
    .replace(/^\p{Sc}\s*/u, "")
    .replace(/\s*\p{Sc}$/u, "")
    .replace(/^[A-Za-z]{3}\s+/u, "")
    .replace(/\s+[A-Za-z]{3}$/u, "")
    .replace(/[\s\u00a0]/gu, "");
  if (!/[0-9]/u.test(value) || /[^0-9.,+-]/u.test(value) || (negative && /^[+-]/u.test(value))) {
    throw new Error("IMPORT_FINANCIAL_VALUE_INVALID");
  }
  const comma = value.lastIndexOf(",");
  const dot = value.lastIndexOf(".");
  if (comma >= 0 && dot >= 0) {
    value = comma > dot ? value.replaceAll(".", "").replace(",", ".") : value.replaceAll(",", "");
  } else if (comma >= 0) {
    const decimals = value.length - comma - 1;
    value = decimals === 3 ? value.replaceAll(",", "") : value.replace(",", ".");
  }
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(value)) throw new Error("IMPORT_FINANCIAL_VALUE_INVALID");
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error("IMPORT_FINANCIAL_VALUE_INVALID");
    return (negative ? parsed.neg() : parsed).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8);
  } catch (error) {
    if (error instanceof Error && error.message === "IMPORT_FINANCIAL_VALUE_INVALID") throw error;
    throw new Error("IMPORT_FINANCIAL_VALUE_INVALID", { cause: error });
  }
}

/**
 * Amazon reports use sparse amount columns: an empty cell means that the
 * component does not apply to this row. Keep this separate from the strict
 * normalizer so required anchor values can never be silently coerced.
 */
export function normalizedSparseDecimal(input: string | undefined): string {
  const value = (input ?? "").normalize("NFKC").trim();
  return !value || value === "-" ? "0.00000000" : normalizedDecimal(value);
}

export type FulfillmentMode = "AMAZON" | "MERCHANT" | "BLANK";

export function normalizeFulfillment(input: string | undefined): FulfillmentMode {
  const value = (input ?? "").normalize("NFKC").trim().toLocaleLowerCase("und");
  if (!value) return "BLANK";
  return value === "amazon" ? "AMAZON" : "MERCHANT";
}

const MONTHS: Readonly<Record<string, string>> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
  oca:"01",sub:"02",nis:"04",haz:"06",tem:"07",agu:"08",eyl:"09",eki:"10",kas:"11",ara:"12",
  gen:"01",mag:"05",giu:"06",lug:"07",ago:"08",set:"09",ott:"10",dic:"12",
  janv:"01",fevr:"02",mars:"03",avr:"04",mai:"05",juin:"06",juil:"07",aout:"08",sept:"09",decembre:"12",
  ene:"01",abr:"04",junio:"06",julio:"07",septiembre:"09",diciembre:"12",
  sty:"01",lut:"02",kwi:"04",maj:"05",cze:"06",lip:"07",sie:"08",wrz:"09",paz:"10",lis:"11",gru:"12",
  okt:"10",mrt:"03",mei:"05",
  fev:"02",out:"10",dez:"12",
};

function monthToken(value: string): string | undefined {
  const normalized = value.normalize("NFD").replace(/\p{M}/gu, "").replaceAll(".", "").toLocaleLowerCase("und");
  return MONTHS[normalized] ?? MONTHS[normalized.slice(0, 3)];
}

function displayedDate(value: string): string {
  const ymd = /(\d{4})[/-](\d{1,2})[/-](\d{1,2})/u.exec(value);
  if (ymd) return `${ymd[1]}-${ymd[2]!.padStart(2, "0")}-${ymd[3]!.padStart(2, "0")}`;
  const dmy = /(\d{1,2})[./](\d{1,2})[./](\d{4})/u.exec(value);
  if (dmy) return `${dmy[3]}-${dmy[2]!.padStart(2, "0")}-${dmy[1]!.padStart(2, "0")}`;
  const english = /([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})/u.exec(value);
  const month = english ? monthToken(english[1]!) : undefined;
  if (english && month) return `${english[3]}-${month}-${english[2]!.padStart(2, "0")}`;
  const portuguese = /(\d{1,2})\s+de\s+([\p{L}.]+)\s+de\s+(\d{4})/iu.exec(value);
  const portugueseMonth = portuguese ? monthToken(portuguese[2]!) : undefined;
  if (portuguese && portugueseMonth) return `${portuguese[3]}-${portugueseMonth}-${portuguese[1]!.padStart(2, "0")}`;
  const localized = /(\d{1,2})\s+([\p{L}.]+)\s+(\d{4})/u.exec(value);
  const localizedMonth = localized ? monthToken(localized[2]!) : undefined;
  if (localized && localizedMonth) return `${localized[3]}-${localizedMonth}-${localized[1]!.padStart(2, "0")}`;
  throw new Error("IMPORT_REPORT_DATE_INVALID");
}

export function normalizeReportDate(value: string, profile: MarketplaceProfile) {
  try {
    const fxDate = displayedDate(value);
    const time = /(\d{1,2}):(\d{2}):(\d{2})(?:\s*([ap])\.?\s*m\.?)?/iu.exec(value);
    let hour = time?.[1];
    const meridiem = time?.[4]?.toLocaleLowerCase("und");
    if (hour && meridiem) {
      const twelveHour = Number(hour);
      if (twelveHour < 1 || twelveHour > 12) throw new Error("IMPORT_REPORT_DATE_INVALID");
      hour = String((twelveHour % 12) + (meridiem === "p" ? 12 : 0));
    }
    const plain = Temporal.PlainDateTime.from(`${fxDate}T${time ? `${hour!.padStart(2, "0")}:${time[2]}:${time[3]}` : "00:00:00"}`);
    const trailingOffset = /(Z|[+-]\d{2}:?\d{2})\s*$/iu.exec(value)?.[1]?.toUpperCase();
    const isoOffset = trailingOffset && trailingOffset !== "Z" && !trailingOffset.includes(":")
      ? `${trailingOffset.slice(0, 3)}:${trailingOffset.slice(3)}`
      : trailingOffset;
    const gmtOffset = /\b(?:GMT|UTC)\s*([+-])(\d{1,2})(?::?(\d{2}))?\b/iu.exec(value);
    const offset = isoOffset === "Z" ? "UTC" : isoOffset
      ?? (gmtOffset ? `${gmtOffset[1]}${gmtOffset[2]!.padStart(2, "0")}:${gmtOffset[3] ?? "00"}` : undefined);
    const zone = offset ?? (/\bUTC\b/u.test(value) ? "UTC" : /\bJST\b/u.test(value) ? "Asia/Tokyo"
      : /\bPDT\b/u.test(value) || /\bPST\b/u.test(value) ? "America/Los_Angeles" : profile.sourceTimezone);
    const instant = offset
      ? Temporal.Instant.from(`${plain.toString()}${offset === "UTC" ? "Z" : offset}`)
      : plain.toZonedDateTime(zone).toInstant();
    // localDate/localMonth are compatibility names. Financial grouping follows
    // the date printed by the report; parsedAt preserves the audited instant
    // without shifting a row into another report day or month.
    return { parsedAt: instant.toString(), sourceTimezone: zone, fxDate, localDate: fxDate, localMonth: `${fxDate.slice(0, 7)}-01` };
  } catch (error) {
    if (error instanceof Error && error.message === "IMPORT_REPORT_DATE_INVALID") throw error;
    throw new Error("IMPORT_REPORT_DATE_INVALID", { cause: error });
  }
}

export function normalizeTransactionType(value: string): string {
  return canonicalTransactionType(value);
}

export function normalizeTransactionDescription(value: string): string {
  return canonicalTransactionDescription(value);
}
