import { describe, expect, it } from "vitest";
import { analyzeDelimitedPrefix, assertRowConservation, classifyInput, parseMappedDelimitedStream } from "../../src/modules/imports";
import { builtinShipmentMapping, builtinTransactionMapping, matchHeader, type FieldMappingDefinition } from "../../src/modules/mappings";

const shipment: FieldMappingDefinition = {
  reportKind: "SHIPMENT",
  locale: "zh-CN",
  fields: [
    { canonical: "sales_channel", sourceHeaders: ["销售渠道"], required: true },
    { canonical: "order_id", sourceHeaders: ["亚马逊订单编号"], required: true },
    { canonical: "sku", sourceHeaders: ["卖家 SKU"], required: true },
  ],
};

describe("导入前缀分析", () => {
  it("不假定首行是表头，并识别 UTF-8 BOM 与中文 CSV", () => {
    const text = "\uFEFF配送报告说明\r\n生成时间,2026-07-28\r\n销售渠道,亚马逊订单编号,卖家 SKU\r\nAmazon.com,脱敏订单,SKU-1\r\n";
    const result = analyzeDelimitedPrefix(new TextEncoder().encode(text), [{ id: "mapping-v1", definition: shipment }]);
    expect(result).toMatchObject({
      status: "MATCHED",
      encoding: "utf-8",
      delimiter: ",",
      headerLineNumber: "3",
      mappingVersionId: "mapping-v1",
    });
  });

  it("未知表头停在 AWAITING_MAPPING", () => {
    const result = analyzeDelimitedPrefix(new TextEncoder().encode("unknown,fields\n1,2"), [{ id: "mapping-v1", definition: shipment }]);
    expect(result.status).toBe("AWAITING_MAPPING");
  });

  it.each([
    ["BE", ["date/heure", "type", "description", "site de vente", "ventes de produits", "frais de vente", "Frais pour le service Expédié par Amazon", "autres frais de transaction", "autres", "total"]],
    ["ES", ["fecha y hora", "tipo", "descripción", "web de Amazon", "ventas de productos", "tarifas de venta", "tarifas de Logística de Amazon", "tarifas de otras transacciones", "otro", "total"]],
    ["NL", ["datum/tijd", "type", "beschrijving", "marketplace", "verkoop van producten", "verkoopkosten", "fba-vergoedingen", "overige transactiekosten", "overige", "totaal"]],
  ])("精确匹配 %s 本地化交易表头", (_site, headers) => {
    expect(matchHeader(headers, builtinTransactionMapping)).toBeDefined();
  });

  it.each([
    "fulfillment", "fulfilment", "Versand", "cumplimiento", "Gestione", "フルフィルメント",
    "traitement", "realizacja", "gestión logística", "expédition", "leverans", "gönderim", "atendimento",
  ])("把已验证配送表头 %s 精确映射为可选 fulfillment", (fulfillmentHeader) => {
    const headers = [
      "date/time", "type", "description", "marketplace", "product sales", "selling fees",
      "fba fees", "other transaction fees", "other", "total", fulfillmentHeader,
    ];
    expect(matchHeader(headers, builtinTransactionMapping)?.get("fulfillment")).toBe(10);
  });

  it("配送表头缺失时仍匹配普通交易模板", () => {
    const headers = [
      "date/time", "type", "description", "marketplace", "product sales", "selling fees",
      "fba fees", "other transaction fees", "other", "total",
    ];
    const matched = matchHeader(headers, builtinTransactionMapping);
    expect(matched).toBeDefined();
    expect(matched?.has("fulfillment")).toBe(false);
  });

  it("按样本语义匹配 AU、PL、ES、NL 和 UK 的 FMB 金额列", () => {
    const aliases = new Map(builtinTransactionMapping.fields.map((mappingField) => [mappingField.canonical, mappingField.sourceHeaders]));
    expect(aliases.get("fba_fees")).toContain("fulfilment by amazon fees");
    expect(aliases.get("product_sales_tax")).toContain("pobrany podatek od sprzedaży");
    expect(aliases.get("marketplace_withheld_tax")).toContain("Podatek od transakcji Marketplace Facilitator");
    expect(aliases.get("shipping_credits")).toEqual(expect.arrayContaining(["postage credits", "Verzendtegoeden", "abonos de envío"]));
    expect(aliases.get("gift_wrap_credits")).toEqual(expect.arrayContaining(["kredietpunten cadeauverpakking", "abonos de envoltorio para regalo"]));
    expect(aliases.get("promotional_rebates")).toEqual(expect.arrayContaining(["promotiekortingen", "devoluciones promocionales"]));
    expect(aliases.get("product_sales_tax")).not.toEqual(expect.arrayContaining(["sales tax collected", "geïnde omzetbelasting"]));
  });

  it("精确匹配 Amazon 英文配送报告的必需表头", () => {
    const headers = [
      "Amazon Order Id", "Shipment Date", "Merchant SKU", "Shipped Quantity", "Currency",
      "Item Price", "Item Tax", "Shipping Price", "Shipping Tax", "Gift Wrap Price",
      "Gift Wrap Tax", "Item Promo Discount", "Shipment Promo Discount", "Sales Channel",
    ];
    expect(matchHeader(headers, builtinShipmentMapping)).toBeDefined();
  });

  it("精确匹配 Amazon 巴西葡语交易报告的必需表头", () => {
    const headers = [
      "data/hora", "tipo", "id do pedido", "sku", "descrição", "quantidade", "mercado",
      "vendas do produto", "créditos de remessa", "créditos de embalagem de presente",
      "descontos promocionais", "imposto de vendas coletados", "tarifas de venda", "taxas fba",
      "taxas de outras transações", "outro", "total",
    ];
    expect(matchHeader(headers, builtinTransactionMapping)).toBeDefined();
  });

  it("合法 UTF-8 意大利语表头不会因 Windows-1252 兼容解码产生假歧义", () => {
    const header = ["Data/Ora:", "Tipo", "Descrizione", "Quantità", "Marketplace", "Vendite", "Commissioni di vendita", "Costi del servizio Logistica di Amazon", "Altri costi relativi alle transazioni", "Altro", "totale"].join(",");
    const result = analyzeDelimitedPrefix(new TextEncoder().encode(`${header}\n`), [{ id: "mapping-it", definition: builtinTransactionMapping }]);
    expect(result).toMatchObject({ status: "MATCHED", encoding: "utf-8", mappingVersionId: "mapping-it" });
  });

  it("只按内容识别 PDF，Office 临时文件不解析", () => {
    expect(classifyInput("报告.csv", new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBe("LIST_ONLY");
    expect(classifyInput("folder/~$报告.csv", new Uint8Array())).toBe("TEMPORARY");
    expect(classifyInput("数据.txt", new TextEncoder().encode("a\tb"))).toBe("PARSE");
  });

  it("强制读取行数守恒", () => {
    expect(() => assertRowConservation({ read: "10", inserted: "7", excluded: "2", errored: "1" })).not.toThrow();
    expect(() => assertRowConservation({ read: "10", inserted: "7", excluded: "1", errored: "1" })).toThrow("ROW_CONSERVATION_VIOLATION");
  });

  it("以背压逐行解析并跳过重复表头，不累积原始行", async () => {
    const text = "说明\n销售渠道,亚马逊订单编号,卖家 SKU\nAmazon.de,ORDER-1,SKU-1\n销售渠道,亚马逊订单编号,卖家 SKU\nAmazon.de,ORDER-2,SKU-2\n";
    const bytes = new TextEncoder().encode(text);
    const analysis = analyzeDelimitedPrefix(bytes, [{ id: "mapping-v1", definition: shipment }]);
    const rows: Array<Readonly<Record<string, string>>> = [];
    const result = await parseMappedDelimitedStream({
      chunks: (async function* () {
        yield bytes.subarray(0, 17);
        yield bytes.subarray(17, 49);
        yield bytes.subarray(49);
      })(),
      analysis,
      mapping: shipment,
      onRow: async (row) => { rows.push(row.values); },
    });
    expect(result).toEqual({ parsedRows: "2", repeatedHeaders: "1" });
    expect(rows).toEqual([
      { sales_channel: "Amazon.de", order_id: "ORDER-1", sku: "SKU-1" },
      { sales_channel: "Amazon.de", order_id: "ORDER-2", sku: "SKU-2" },
    ]);
  });

  it("只在显式启用时返回不含行内容的解析分段计时", async () => {
    const text = "销售渠道,亚马逊订单编号,卖家 SKU\nAmazon.de,ORDER-1,SKU-1\n";
    const bytes = new TextEncoder().encode(text);
    const analysis = analyzeDelimitedPrefix(bytes, [{ id: "mapping-v1", definition: shipment }]);
    const result = await parseMappedDelimitedStream({
      chunks: (async function* () { yield bytes; })(),
      analysis,
      mapping: shipment,
      profile: true,
      onRow: async () => undefined,
    });
    expect(result).toMatchObject({
      parsedRows: "1",
      repeatedHeaders: "0",
      profiling: {
        headerCellsExamined: expect.any(Number),
        headerMatchMs: expect.any(Number),
        projectionMs: expect.any(Number),
        rowHashMs: expect.any(Number),
        onRowMs: expect.any(Number),
      },
    });
    expect(Object.keys(result.profiling ?? {})).toEqual(["headerCellsExamined", "headerMatchMs", "projectionMs", "rowHashMs", "onRowMs"]);
  });

  it("每个文件只编译一次重复表头匹配，映射定义读取次数不随数据行增长", async () => {
    let fieldReads = 0;
    const mapping = {
      ...shipment,
      get fields() {
        fieldReads += 1;
        return shipment.fields;
      },
    };
    const lines = ["销售渠道,亚马逊订单编号,卖家 SKU"];
    for (let index = 0; index < 200; index += 1) lines.push(`Amazon.de,ORDER-${index},SKU-${index}`);
    const bytes = new TextEncoder().encode(`${lines.join("\n")}\n`);
    const analysis = analyzeDelimitedPrefix(bytes, [{ id: "mapping-v1", definition: shipment }]);
    const result = await parseMappedDelimitedStream({
      chunks: (async function* () { yield bytes; })(),
      analysis,
      mapping,
      profile: true,
      onRow: async () => undefined,
    });
    expect(result.parsedRows).toBe("200");
    expect(fieldReads).toBeLessThan(10);
    expect(result.profiling?.headerCellsExamined).toBe(200);
  });
  it("rejects a logical record larger than the bounded parser budget", async () => {
    const header = shipment.fields.map((field) => field.sourceHeaders[0]).join(",");
    const text = `${header}\nAmazon.de,"${"x".repeat(16 * 1024 * 1024)}",SKU-1\n`;
    const bytes = new TextEncoder().encode(text);
    const analysis = analyzeDelimitedPrefix(bytes.subarray(0, 512 * 1024), [{ id: "mapping-v1", definition: shipment }]);
    await expect(parseMappedDelimitedStream({
      chunks: (async function* () {
        for (let offset = 0; offset < bytes.length; offset += 64 * 1024) yield bytes.subarray(offset, offset + 64 * 1024);
      })(),
      analysis,
      mapping: shipment,
      onRow: async () => undefined,
    })).rejects.toThrow("IMPORT_DELIMITED_RECORD_TOO_LARGE");
  });
});
