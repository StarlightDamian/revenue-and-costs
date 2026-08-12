import { createHash } from "node:crypto";

export const FEE_CLASSIFICATION_VERSION = "transaction-fee-v2";

const POLICY = {
  refundTypes: ["refund", "erstattung", "remboursement", "rimborso", "reembolso", "zwrot", "återbetalning", "iade", "返金"],
  orderTypes: ["order", "bestellung", "bestelling", "beställning", "commande", "ordine", "pedido", "zamówienie", "sipariş", "注文"],
  transferTypes: ["transfer", "transferir", "trasferir", "übertrag", "übertragung", "transfert", "transférer", "trasferimento", "przelew", "överföring", "overboeking", "transferencia", "aktarım", "振替", "振込み"],
  debtTypes: ["debt", "schuld", "verbindlichkeit", "dette", "debito", "dług", "skuld", "deuda", "saldo descubierto", "saldo negativo", "solde négatif", "borç", "債務", "マイナス残高"],
  inventoryTokens: ["inventory", "lager", "stock", "stockage", "almac", "inventario", "stoccagg", "保管", "在庫"],
  amazonFulfillmentTokens: ["fba", "amazon"],
  advertisingChargeDescriptions: ["cost of advertising", "gastos de publicidad", "costo de la publicidad", "prix de la publicité", "costo della pubblicità", "koszt reklamy", "広告費用"],
} as const;

export const FEE_CLASSIFICATION_POLICY_SHA256 = createHash("sha256").update(JSON.stringify(POLICY)).digest("hex");

export type FeeSourceColumn = "sellingFees" | "fbaFees" | "otherTransactionFees" | "other";
export type FeeClassificationCategory =
  | "PLATFORM_FEE"
  | "FBA_FULFILLMENT_FEE"
  | "ADVERTISING_FEE"
  | "FBA_STORAGE_FEE"
  | "OTHER_DEDUCTION"
  | "EXCLUDED_TRANSFER_DEBT";

export interface FeeClassification {
  readonly category: FeeClassificationCategory;
  readonly reason: string;
}

function words(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("und").replace(/[_\s-]+/gu, " ");
}

const refundTypes = new Set<string>(POLICY.refundTypes);
const orderTypes = new Set<string>(POLICY.orderTypes);
const transferTypes = new Set<string>(POLICY.transferTypes);
const debtTypes = new Set<string>(POLICY.debtTypes);

export function canonicalTransactionType(value: string): string {
  const valueWords = words(value);
  if (refundTypes.has(valueWords)) return "REFUND";
  if (orderTypes.has(valueWords)) return "ORDER";
  if (POLICY.inventoryTokens.some((token) => valueWords.includes(token))
      && POLICY.amazonFulfillmentTokens.some((token) => valueWords.includes(token))) return "FBA_INVENTORY_FEE";
  if (transferTypes.has(valueWords)) return "TRANSFER";
  if (debtTypes.has(valueWords)) return "DEBT";
  return valueWords.replace(/[^\p{L}\p{N}]+/gu, "_").toUpperCase();
}

const advertisingChargeDescriptions = new Set<string>(POLICY.advertisingChargeDescriptions);

export function canonicalTransactionDescription(value: string): string {
  const valueWords = words(value);
  if (advertisingChargeDescriptions.has(valueWords)) return "COST_OF_ADVERTISING";
  return valueWords.replace(/[^\p{L}\p{N}]+/gu, "_").toUpperCase();
}

export function classifyFeeCell(sourceColumn: FeeSourceColumn, type: string, description: string): FeeClassification {
  if (sourceColumn === "sellingFees") return { category: "PLATFORM_FEE", reason: "SOURCE_SELLING_FEES" };
  if (sourceColumn === "fbaFees") return { category: "FBA_FULFILLMENT_FEE", reason: "SOURCE_FBA_FEES" };
  const canonicalType = canonicalTransactionType(type);
  const canonicalDescription = canonicalTransactionDescription(description);
  if (sourceColumn === "otherTransactionFees" && canonicalDescription === "COST_OF_ADVERTISING") {
    return { category: "ADVERTISING_FEE", reason: "DESCRIPTION_ADVERTISING_CHARGE" };
  }
  if (sourceColumn === "other" && canonicalType === "FBA_INVENTORY_FEE") {
    return { category: "FBA_STORAGE_FEE", reason: "TYPE_FBA_INVENTORY_FEE" };
  }
  if (sourceColumn === "other" && (canonicalType === "TRANSFER" || canonicalType === "DEBT")) {
    return { category: "EXCLUDED_TRANSFER_DEBT", reason: `TYPE_${canonicalType}` };
  }
  return { category: "OTHER_DEDUCTION", reason: `UNCLASSIFIED_${sourceColumn.toUpperCase()}` };
}
