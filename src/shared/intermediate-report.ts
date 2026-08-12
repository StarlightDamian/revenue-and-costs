export type IntermediateReportKind = "TRANSACTION" | "SHIPMENT";
export type IntermediateColumnKind = "text" | "date" | "quantity" | "money" | "rate" | "computed-money";

export interface IntermediateColumn {
  readonly key: string;
  readonly header: string;
  readonly kind: IntermediateColumnKind;
  readonly width: number;
  readonly defaultVisible: boolean;
  readonly total: boolean;
}

const column = (
  key: string,
  header: string,
  kind: IntermediateColumnKind,
  width = 16,
  defaultVisible = true,
  total = kind === "quantity" || kind === "money" || kind === "computed-money",
): IntermediateColumn => ({ key, header, kind, width, defaultVisible, total });

export const INTERMEDIATE_REPORT_COLUMNS: Readonly<Record<IntermediateReportKind, readonly IntermediateColumn[]>> = {
  TRANSACTION: [
    column("id", "行号", "text", 12), column("marketplace", "站点", "text", 12), column("localDate", "报表日期", "date", 14),
    column("type", "交易类型", "text", 18), column("description", "交易说明", "text", 28), column("orderId", "订单号", "text", 24),
    column("sku", "SKU", "text", 22), column("currency", "币种", "text", 10), column("quantity", "数量", "quantity", 12),
    column("productSales", "商品销售额", "money"), column("productSalesTax", "商品销售税", "money"),
    column("shippingCredits", "配送收入", "money"), column("shippingCreditsTax", "配送税", "money"),
    column("giftWrapCredits", "礼品包装收入", "money"), column("giftWrapCreditsTax", "礼品包装税", "money"),
    column("regulatoryFee", "监管费", "money"), column("taxOnRegulatoryFee", "监管费税", "money"),
    column("promotionalRebates", "促销折扣", "money"), column("promotionalRebatesTax", "促销折扣税", "money"),
    column("marketplaceWithheldTax", "平台代扣税", "money"), column("sellingFees", "销售佣金", "money"),
    column("fbaFees", "FBA费用", "money"), column("otherTransactionFees", "其他交易费用", "money"),
    column("otherAmount", "其他金额", "money"), column("cnyRate", "人民币汇率", "rate", 16),
  ],
  SHIPMENT: [
    column("id", "行号", "text", 12), column("marketplace", "站点", "text", 12), column("localDate", "报表日期", "date", 14),
    column("orderId", "订单号", "text", 24), column("sku", "SKU", "text", 22), column("currency", "币种", "text", 10),
    column("shippedQuantity", "发货数量", "quantity", 12), column("productPrice", "商品价格", "money"),
    column("productTax", "商品税", "money"), column("shippingPrice", "配送费", "money"), column("shippingTax", "配送税", "money"),
    column("giftWrapPrice", "礼品包装费", "money"), column("giftWrapTax", "礼品包装税", "money"),
    column("productPromotionDiscount", "商品促销折扣", "money"), column("shipmentPromotionDiscount", "配送促销折扣", "money"),
    column("cnyRate", "人民币汇率", "rate", 16, true, false), column("originalTotal", "原币合计", "computed-money", 18),
    column("cnyTotal", "人民币合计", "computed-money", 18),
  ],
};

export const SHIPMENT_AMOUNT_KEYS = [
  "productPrice", "productTax", "shippingPrice", "shippingTax", "giftWrapPrice", "giftWrapTax",
  "productPromotionDiscount", "shipmentPromotionDiscount",
] as const;

export interface IntermediateFilter {
  readonly marketplaces?: readonly string[];
  readonly currencies?: readonly string[];
  readonly start?: string;
  readonly end?: string;
}
