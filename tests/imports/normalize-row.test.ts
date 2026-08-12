import { describe, expect, it } from "vitest";
import { marketplaceProfile, normalizedDecimal, normalizedSparseDecimal, normalizeFulfillment, normalizeReportDate, normalizeTransactionType, SingleSiteMarketplaceInference } from "../../src/modules/imports/normalize-row.js";

describe("import row normalization", () => {
  it("uses the report display date directly for date and month assignment", () => {
    const date = normalizeReportDate("30.09.2025 22:20:17 UTC", marketplaceProfile("amazon.de"));
    expect(date.parsedAt).toBe("2025-09-30T22:20:17Z");
    expect(date.localDate).toBe("2025-09-30");
    expect(date.fxDate).toBe("2025-09-30");
    expect(date.localMonth).toBe("2025-09-01");
  });
  it("does not change the report date across a timezone boundary", () => {
    const date = normalizeReportDate("2025-01-01 01:00:00 UTC", marketplaceProfile("amazon.com"));
    expect(date).toMatchObject({
      parsedAt: "2025-01-01T01:00:00Z",
      sourceTimezone: "UTC",
      fxDate: "2025-01-01",
      localDate: "2025-01-01",
      localMonth: "2025-01-01",
    });
  });
  it("assigns the literal report date independently of marketplace timezone", () => {
    const us = normalizeReportDate("2025-01-01 17:00:00 UTC", marketplaceProfile("amazon.com"));
    const japan = normalizeReportDate("2025-01-01 17:00:00 UTC", marketplaceProfile("amazon.co.jp"));
    expect(us.localDate).toBe("2025-01-01");
    expect(japan.localDate).toBe(us.localDate);
  });
  it("still interprets a wall time for the audit instant without changing its report date", () => {
    expect(normalizeReportDate("2025-01-01 23:30:00", marketplaceProfile("amazon.com"))).toMatchObject({
      parsedAt: "2025-01-02T07:30:00Z",
      sourceTimezone: "America/Los_Angeles",
      fxDate: "2025-01-01",
      localDate: "2025-01-01",
      localMonth: "2025-01-01",
    });
  });
  it("parses localized textual months without using the file name", () => {
    expect(normalizeReportDate("1 Eki 2025 14:28:51 UTC", marketplaceProfile("amazon.com.tr")).fxDate).toBe("2025-10-01");
    expect(normalizeReportDate("1 paź 2025 00:00:00 UTC", marketplaceProfile("amazon.pl")).fxDate).toBe("2025-10-01");
  });
  it("parses an ISO numeric offset for the audit instant but keeps the literal report month", () => {
    expect(normalizeReportDate("2026-04-30T23:48:44-07:00", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-05-01T06:48:44Z",
      sourceTimezone: "-07:00",
      fxDate: "2026-04-30",
      localDate: "2026-04-30",
      localMonth: "2026-04-01",
    });
  });
  it("parses Amazon dotted meridiem timestamps without changing their literal report date", () => {
    expect(normalizeReportDate("Apr 30, 2026 9:35:30 p.m. PDT", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-05-01T04:35:30Z",
      sourceTimezone: "America/Los_Angeles",
      fxDate: "2026-04-30",
      localDate: "2026-04-30",
      localMonth: "2026-04-01",
    });
    expect(normalizeReportDate("Apr 30, 2026 12:13:01 a.m. PDT", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-04-30T07:13:01Z",
      localDate: "2026-04-30",
    });
    expect(normalizeReportDate("Apr 30, 2026 12:13:01 p.m. PDT", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-04-30T19:13:01Z",
      localDate: "2026-04-30",
    });
  });
  it("honors trailing numeric offsets after Amazon dotted meridiem timestamps", () => {
    expect(normalizeReportDate("Apr 30, 2026 9:35:30 p.m. -07:00", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-05-01T04:35:30Z",
      sourceTimezone: "-07:00",
      localDate: "2026-04-30",
    });
    expect(normalizeReportDate("Apr 30, 2026 12:13:01 a.m. -0700", marketplaceProfile("amazon.ca"))).toMatchObject({
      parsedAt: "2026-04-30T07:13:01Z",
      sourceTimezone: "-07:00",
      localDate: "2026-04-30",
    });
  });
  it("parses Brazilian Portuguese dates with a numeric GMT offset", () => {
    expect(normalizeReportDate("1 de jul. de 2025 23:36:22 GMT-7", marketplaceProfile("amazon.com.br"))).toMatchObject({
      parsedAt: "2025-07-02T06:36:22Z",
      sourceTimezone: "-07:00",
      fxDate: "2025-07-01",
      localDate: "2025-07-01",
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
    expect(marketplaceProfile("amazon.ie")).toMatchObject({ code: "IE", sourceTimezone: "Europe/Dublin", currency: "EUR" });
    expect(marketplaceProfile("amazon.com.br")).toMatchObject({ code: "BR", sourceTimezone: "America/Sao_Paulo", currency: "BRL" });
    expect(marketplaceProfile("amazon.com.au")).toMatchObject({ code: "AU", sourceTimezone: "Australia/Sydney", currency: "AUD" });
    expect(marketplaceProfile("Non-Amazon").nonAmazon).toBe(true);
  });
  it("normalizes fulfillment without guessing localized merchant values", () => {
    expect(normalizeFulfillment(undefined)).toBe("BLANK");
    expect(normalizeFulfillment("　 ")).toBe("BLANK");
    expect(normalizeFulfillment(" AMAZON ")).toBe("AMAZON");
    expect(normalizeFulfillment("Ａｍａｚｏｎ")).toBe("AMAZON");
    expect(normalizeFulfillment("Seller")).toBe("MERCHANT");
    expect(normalizeFulfillment("Verkäufer")).toBe("MERCHANT");
  });
  it("normalizes confirmed Dutch and Swedish Order values", () => {
    expect(normalizeTransactionType("Bestelling")).toBe("ORDER");
    expect(normalizeTransactionType("Beställning")).toBe("ORDER");
  });
  it.each([
    ["Transfer", "TRANSFER"],
    ["振込み", "TRANSFER"],
    ["Overboeking", "TRANSFER"],
    ["Överföring", "TRANSFER"],
    ["Przelew", "TRANSFER"],
    ["Transfert", "TRANSFER"],
    ["Transférer", "TRANSFER"],
    ["Trasferimento", "TRANSFER"],
    ["Transferir", "TRANSFER"],
    ["Trasferir", "TRANSFER"],
    ["Übertrag", "TRANSFER"],
    ["FBA 在庫関連の手数料", "FBA_INVENTORY_FEE"],
    ["Frais de stock Expédié par Amazon", "FBA_INVENTORY_FEE"],
    ["Costo di stoccaggio Logistica di Amazon", "FBA_INVENTORY_FEE"],
    ["Tarifas de inventario de Logística de Amazon", "FBA_INVENTORY_FEE"],
    ["Versand durch Amazon Lagergebühr", "FBA_INVENTORY_FEE"],
    ["Debt", "DEBT"],
    ["Dług", "DEBT"],
    ["Schuld", "DEBT"],
    ["Skuld", "DEBT"],
    ["マイナス残高", "DEBT"],
    ["Solde négatif", "DEBT"],
    ["Saldo negativo", "DEBT"],
    ["Saldo descubierto", "DEBT"],
    ["Verbindlichkeit", "DEBT"],
  ])("normalizes confirmed localized fee type %s", (input, expected) => {
    expect(normalizeTransactionType(input)).toBe(expected);
    expect(normalizeTransactionType(expected)).toBe(expected);
  });
  it("rejects unknown or missing marketplaces without inventing timezone and currency", () => {
    expect(() => marketplaceProfile("marketplace.example")).toThrow("IMPORT_UNKNOWN_MARKETPLACE");
    expect(() => marketplaceProfile(" ")).toThrow("IMPORT_UNKNOWN_MARKETPLACE");
  });
  it("infers blank transaction marketplaces only from one unique Amazon site in the same file", () => {
    const unique = new SingleSiteMarketplaceInference();
    for (const value of ["", "Amazon.com", " https://amazon.com/ ", "Non-Amazon", " "]) unique.observe(value);
    expect(unique.resolve()).toMatchObject({ code: "US", sourceTimezone: "America/Los_Angeles", currency: "USD" });

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
