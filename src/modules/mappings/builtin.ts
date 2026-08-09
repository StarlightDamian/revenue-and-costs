import type { FieldMappingDefinition, MappingField } from "./types.js";

const field = (canonical: string, sourceHeaders: readonly string[], required = false): MappingField => ({ canonical, sourceHeaders, required });

const builtinTransactionMappingBase: FieldMappingDefinition = {
  reportKind: "TRANSACTION",
  locale: "amazon-multilingual-v1",
  fields: [
    field("date_time", ["date/time", "Datum/Uhrzeit", "Data/Ora:", "date/heure", "data/godzina", "datum/tid", "datum/tijd", "fecha/hora", "fecha y hora", "tarih/saat", "日付/時間"], true),
    field("type", ["type", "Typ", "Tipo", "tip", "トランザクションの種類"], true),
    field("order_id", ["order id", "Bestellnummer", "Numero ordine", "numéro de la commande", "identyfikator zamówienia", "beställnings-id", "Id. del pedido", "sipariş no.", "注文番号"]),
    field("sku", ["sku"]),
    field("description", ["description", "Beschreibung", "Descrizione", "opis", "beskrivning", "beschrijving", "descripción", "açıklama", "説明"], true),
    field("quantity", ["quantity", "Menge", "Quantità", "quantité", "ilość", "antal", "cantidad", "adet", "数量"]),
    field("marketplace", ["marketplace", "site de vente", "rynek", "marknadsplats", "web de Amazon", "pazar yeri", "Amazon 出品サービス"], true),
    field("fulfillment", [
      "fulfillment", "fulfilment", "Versand", "cumplimiento", "Gestione", "フルフィルメント",
      "traitement", "expédition", "realizacja", "gestión logística", "leverans", "gönderim",
    ], true),
    field("product_sales", ["product sales", "Umsätze", "Vendite", "ventes de produits", "sprzedaż produktów", "försäljning av produkter", "verkoop van producten", "ventas de productos", "ürün satışları", "商品売上"], true),
    field("product_sales_tax", ["product sales tax", "Produktumsatzsteuer", "imposta sulle vendite dei prodotti", "Taxes sur la vente des produits", "impuesto de ventas de productos", "商品の売上税"]),
    field("shipping_credits", ["shipping credits", "Gutschrift für Versandkosten", "Accrediti per le spedizioni", "crédits d'expédition", "crédits d’expédition", "noty kredytowe za wysyłkę", "fraktkrediter", "créditos de envío", "kargo kredileri", "配送料"]),
    field("shipping_credits_tax", ["shipping credits tax", "Steuer auf Versandgutschrift", "imposta accrediti per le spedizioni", "taxe sur les crédits d’expédition", "impuesto de abono de envío", "配送料の税金"]),
    field("gift_wrap_credits", ["gift wrap credits", "Gutschrift für Geschenkverpackung", "Accrediti per confezioni regalo", "crédits sur l'emballage cadeau", "crédits d’emballage-cadeau", "krediter för presentinslagning", "créditos por envoltorio de regalo", "ギフト包装手数料"]),
    field("gift_wrap_credits_tax", ["gift wrap credits tax", "giftwrap credits tax", "Steuer auf Geschenkverpackungsgutschriften", "imposta sui crediti confezione regalo", "Taxes sur les crédits cadeaux", "impuesto de créditos de envoltura", "ギフト包装クレジットの税金"]),
    field("regulatory_fee", ["Regulatory fee", "Tarifa reglamentaria"]),
    field("tax_on_regulatory_fee", ["Tax on regulatory fee", "Impuesto sobre tarifa reglamentaria"]),
    field("promotional_rebates", ["promotional rebates", "Rabatte aus Werbeaktionen", "Sconti promozionali", "Rabais promotionnels", "Total des réductions", "rabaty promocyjne", "kampanjrabatter", "descuentos promocionales", "promosyon indirimleri", "プロモーション割引額"]),
    field("promotional_rebates_tax", ["promotional rebates tax", "Steuer auf Aktionsrabatte", "imposta sugli sconti promozionali", "Taxes sur les remises promotionnelles", "impuesto de reembolsos promocionales", "プロモーション割引の税金"]),
    field("marketplace_withheld_tax", ["marketplace withheld tax", "Einbehaltene Steuer auf Marketplace", "trattenuta IVA del marketplace", "Taxes retenues sur le site de vente", "pobrany podatek od sprzedaży", "Inkasserad moms", "impuesto de retenciones en la plataforma", "源泉徴収税を伴うマーケットプレイス"]),
    field("selling_fees", ["selling fees", "Verkaufsgebühren", "Commissioni di vendita", "frais de vente", "opłaty za sprzedaż", "försäljningsavgifter", "verkoopkosten", "tarifas de venta", "satış ücretleri", "手数料"], true),
    field("fba_fees", ["fba fees", "Gebühren zu Versand durch Amazon", "Costi del servizio Logistica di Amazon", "Frais Expédié par Amazon", "Frais pour le service Expédié par Amazon", "opłaty za fba", "fba-avgifter", "fba-vergoedingen", "tarifas fba", "tarifas de Logística de Amazon", "Amazon Lojistik ücretleri", "FBA 手数料"], true),
    field("other_transaction_fees", ["other transaction fees", "Andere Transaktionsgebühren", "Altri costi relativi alle transazioni", "autres frais de transaction", "inne opłaty transakcyjne", "övriga transaktionsavgifter", "overige transactiekosten", "tarifas de otra transacción", "tarifas de otras transacciones", "diğer işlem ücretleri", "トランザクションに関するその他の手数料"], true),
    field("other", ["other", "Andere", "Altro", "autre", "autres", "inne", "Övrigt", "overige", "otro", "diğer", "その他"], true),
    field("total", ["total", "Gesamt", "totale", "suma", "totalt", "totaal", "toplam", "合計"], true),
  ],
};

const builtinShipmentMappingBase: FieldMappingDefinition = {
  reportKind: "SHIPMENT",
  locale: "amazon-zh-shipment-v1",
  fields: [
    field("order_id", ["亚马逊订单编号"], true),
    field("date_time", ["配送日期"], true),
    field("sku", ["卖家 SKU"], true),
    field("quantity", ["已发货数量"], true),
    field("currency", ["货币"], true),
    field("product_price", ["商品价格"], true),
    field("product_tax", ["商品税"], true),
    field("shipping_price", ["运费"], true),
    field("shipping_tax", ["运费税"], true),
    field("gift_wrap_price", ["礼品包装价格"], true),
    field("gift_wrap_tax", ["礼品包装税费"], true),
    field("product_promotion_discount", ["商品促销折扣"], true),
    field("shipment_promotion_discount", ["货件促销折扣"], true),
    field("sales_channel", ["销售渠道"], true),
  ],
};

function withSourceAliases(
  definition: FieldMappingDefinition,
  aliases: Readonly<Record<string, readonly string[]>>,
): FieldMappingDefinition {
  return {
    ...definition,
    fields: definition.fields.map((mappingField) => ({
      ...mappingField,
      sourceHeaders: [...mappingField.sourceHeaders, ...(aliases[mappingField.canonical] ?? [])],
    })),
  };
}

export const builtinTransactionMapping = withSourceAliases(builtinTransactionMappingBase, {
  date_time: ["data/hora"],
  order_id: ["id do pedido"],
  description: ["descrição"],
  quantity: ["quantidade"],
  marketplace: ["mercado"],
  fulfillment: ["atendimento"],
  product_sales: ["vendas do produto"],
  product_sales_tax: ["imposto de vendas coletados"],
  shipping_credits: ["créditos de remessa"],
  gift_wrap_credits: ["créditos de embalagem de presente"],
  promotional_rebates: ["descontos promocionais"],
  selling_fees: ["tarifas de venda"],
  fba_fees: ["taxas fba"],
  other_transaction_fees: ["taxas de outras transações"],
  other: ["outro"],
});

export const builtinShipmentMapping = withSourceAliases(builtinShipmentMappingBase, {
  order_id: ["Amazon Order Id"],
  date_time: ["Shipment Date"],
  sku: ["Merchant SKU"],
  quantity: ["Shipped Quantity"],
  currency: ["Currency"],
  product_price: ["Item Price"],
  product_tax: ["Item Tax"],
  shipping_price: ["Shipping Price"],
  shipping_tax: ["Shipping Tax"],
  gift_wrap_price: ["Gift Wrap Price"],
  gift_wrap_tax: ["Gift Wrap Tax"],
  product_promotion_discount: ["Item Promo Discount"],
  shipment_promotion_discount: ["Shipment Promo Discount"],
  sales_channel: ["Sales Channel"],
});
