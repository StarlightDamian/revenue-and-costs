import { describe, expect, it } from "vitest";
import { marketplaceProfile, normalizedDecimal, normalizedSparseDecimal, normalizeReportDate, normalizeTransactionType, SingleSiteMarketplaceInference } from "../../src/modules/imports/normalize-row.js";

describe("import row normalization", () => {
  it("keeps report display date but crosses the German local month", () => {
    const date = normalizeReportDate("30.09.2025 22:20:17 UTC", marketplaceProfile("amazon.de"));
    expect(date.parsedAt).toBe("2025-09-30T22:20:17Z");
    expect(date.localDate).toBe("2025-10-01");
    expect(date.fxDate).toBe("2025-09-30");
    expect(date.localMonth).toBe("2025-10-01");
  });
  it("keeps UTC dates exact across a marketplace year boundary", () => {
    const date = normalizeReportDate("2025-01-01 01:00:00 UTC", marketplaceProfile("amazon.com"));
    expect(date).toMatchObject({
      parsedAt: "2025-01-01T01:00:00Z",
      sourceTimezone: "UTC",
      fxDate: "2025-01-01",
      localDate: "2024-12-31",
      localMonth: "2024-12-01",
    });
  });
  it("parses localized textual months without using the file name", () => {
    expect(normalizeReportDate("1 Eki 2025 14:28:51 UTC", marketplaceProfile("amazon.com.tr")).fxDate).toBe("2025-10-01");
    expect(normalizeReportDate("1 paź 2025 00:00:00 UTC", marketplaceProfile("amazon.pl")).fxDate).toBe("2025-10-01");
  });
  it("converts an ISO numeric offset to an instant before applying the marketplace timezone", () => {
    expect(normalizeReportDate("2026-04-30T23:48:44-07:00", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-05-01T06:48:44Z",
      sourceTimezone: "-07:00",
      fxDate: "2026-04-30",
      localDate: "2026-05-01",
      localMonth: "2026-05-01",
    });
  });
  it("parses Brazilian Portuguese dates with a numeric GMT offset", () => {
    expect(normalizeReportDate("1 de jul. de 2025 23:36:22 GMT-7", marketplaceProfile("amazon.com.br"))).toMatchObject({
      parsedAt: "2025-07-02T06:36:22Z",
      sourceTimezone: "-07:00",
      fxDate: "2025-07-01",
      localDate: "2025-07-02",
      localMonth: "2025-07-01",
    });
  });
  it("uses a stable safe code for malformed report dates", () => {
    expect(() => normalizeReportDate("not-a-date", marketplaceProfile("amazon.com"))).toThrow("IMPORT_REPORT_DATE_INVALID");
    expect(() => normalizeReportDate("2025-99-99", marketplaceProfile("amazon.com"))).toThrow("IMPORT_REPORT_DATE_INVALID");
  });
  it("normalizes locale decimals without binary floats", () => {
    expect(normalizedDecimal("21,00")).toBe("21.00000000");
    expect(normalizedDecimal("2,860")).toBe("2860.00000000");
    expect(normalizedDecimal("(1.23)")).toBe("-1.23000000");
    expect(normalizedDecimal("0")).toBe("0.00000000");
    expect(normalizedDecimal("−21,00")).toBe("-21.00000000");
  });
  it("rounds arbitrary-size decimal strings to eight places with exact HALF_UP semantics", () => {
    expect(normalizedDecimal("1.234567894")).toBe("1.23456789");
    expect(normalizedDecimal("1.234567895")).toBe("1.23456790");
    expect(normalizedDecimal("-1.234567895")).toBe("-1.23456790");
    expect(normalizedDecimal("-0.000000004")).toBe("0.00000000");
    expect(normalizedDecimal("-0.000000005")).toBe("-0.00000001");
    expect(normalizedDecimal("+0001.2")).toBe("1.20000000");
    expect(normalizedDecimal("999999999999999999999.999999995")).toBe("1000000000000000000000.00000000");
  });
  it("rejects missing and malformed financial values instead of coercing them to zero", () => {
    expect(() => normalizedDecimal(undefined)).toThrow("IMPORT_FINANCIAL_VALUE_REQUIRED");
    expect(() => normalizedDecimal("")).toThrow("IMPORT_FINANCIAL_VALUE_REQUIRED");
    expect(() => normalizedDecimal("-")).toThrow("IMPORT_FINANCIAL_VALUE_REQUIRED");
    expect(() => normalizedDecimal("N/A")).toThrow("IMPORT_FINANCIAL_VALUE_INVALID");
    expect(() => normalizedDecimal("ABC")).toThrow("IMPORT_FINANCIAL_VALUE_INVALID");
  });
  it("normalizes sparse mapped amount cells without weakening invalid-value checks", () => {
    expect(normalizedSparseDecimal(undefined)).toBe("0.00000000");
    expect(normalizedSparseDecimal("")).toBe("0.00000000");
    expect(normalizedSparseDecimal("-")).toBe("0.00000000");
    expect(normalizedSparseDecimal("1,234.50")).toBe("1234.50000000");
    expect(() => normalizedSparseDecimal("N/A")).toThrow("IMPORT_FINANCIAL_VALUE_INVALID");
  });
  it("maps known and Non-Amazon marketplaces", () => {
    expect(marketplaceProfile("amazon.co.jp").currency).toBe("JPY");
    expect(marketplaceProfile("amazon.ie")).toMatchObject({ code: "IE", timezone: "Europe/Dublin", currency: "EUR" });
    expect(marketplaceProfile("amazon.com.br")).toMatchObject({ code: "BR", timezone: "America/Sao_Paulo", currency: "BRL" });
    expect(marketplaceProfile("Non-Amazon").nonAmazon).toBe(true);
  });
  it("normalizes confirmed Dutch and Swedish Order values", () => {
    expect(normalizeTransactionType("Bestelling")).toBe("ORDER");
    expect(normalizeTransactionType("Beställning")).toBe("ORDER");
  });
  it("rejects unknown or missing marketplaces without inventing timezone and currency", () => {
    expect(() => marketplaceProfile("marketplace.example")).toThrow("IMPORT_UNKNOWN_MARKETPLACE");
    expect(() => marketplaceProfile(" ")).toThrow("IMPORT_UNKNOWN_MARKETPLACE");
  });
  it("infers blank transaction marketplaces only from one unique Amazon site in the same file", () => {
    const unique = new SingleSiteMarketplaceInference();
    for (const value of ["", "Amazon.com", " https://amazon.com/ ", "Non-Amazon", " "]) unique.observe(value);
    expect(unique.resolve()).toMatchObject({ code: "US", timezone: "America/Los_Angeles", currency: "USD" });

    const mixed = new SingleSiteMarketplaceInference();
    for (const value of ["Amazon.com", "Amazon.ca"]) mixed.observe(value);
    expect(mixed.resolve()).toBeUndefined();

    const unknown = new SingleSiteMarketplaceInference();
    for (const value of ["Amazon.com", "marketplace.example"]) unknown.observe(value);
    expect(unknown.resolve()).toMatchObject({ code: "US" });

    const onlyUnknown = new SingleSiteMarketplaceInference();
    for (const value of ["", "marketplace.example", " "]) onlyUnknown.observe(value);
    expect(onlyUnknown.resolve()).toBeUndefined();

    const empty = new SingleSiteMarketplaceInference();
    for (const value of ["", "Non-Amazon", " "]) empty.observe(value);
    expect(empty.resolve()).toBeUndefined();
  });
});
