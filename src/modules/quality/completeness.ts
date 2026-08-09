import { decimal, decimal8 } from "../fx/decimal.js";

export type SliceIssueKind = "HARD_INCOMPLETE" | "SOFT_RECONCILIATION_WARNING";
export type MarketplaceSize = "LARGE" | "SMALL" | "UNKNOWN";

export interface SourceCoverage {
  readonly shipment: "PRESENT" | "ZERO_EVIDENCE" | "MISSING";
  readonly transaction: "PRESENT" | "ZERO_EVIDENCE" | "MISSING";
  readonly mappingConfirmed: boolean;
  readonly coverageComplete: boolean;
  readonly sourcesConflict: boolean;
  readonly fxAvailable: boolean;
}

export interface ReconciliationInput {
  readonly comparable: boolean;
  readonly shipmentQuantity?: string;
  readonly transactionQuantity?: string;
  readonly intersectionQuantity?: string;
}

export interface SliceQualityResult {
  readonly hardReasons: readonly string[];
  readonly reconciliation: {
    readonly applicable: boolean;
    readonly warning: boolean;
    readonly shipmentQuantity?: string;
    readonly transactionQuantity?: string;
    readonly intersectionQuantity?: string;
    readonly unmatchedAbsolute?: string;
    readonly unmatchedRatio?: string;
  };
  readonly publishDisposition: "INCLUDE" | "BLOCK";
}

function quantity(value: string | undefined) {
  if (value === undefined) throw new Error("INVALID_COMPARABLE_QUANTITY");
  const parsed = decimal(value);
  if (parsed.isNegative()) throw new Error("INVALID_COMPARABLE_QUANTITY");
  return parsed;
}

export function evaluateSliceQuality(
  coverage: SourceCoverage,
  reconciliation: ReconciliationInput,
): SliceQualityResult {
  const hardReasons: string[] = [];
  if (coverage.shipment === "MISSING") hardReasons.push("MISSING_SHIPMENT_REPORT");
  if (coverage.transaction === "MISSING") hardReasons.push("MISSING_TRANSACTION_REPORT");
  if (!coverage.mappingConfirmed) hardReasons.push("UNCONFIRMED_MAPPING");
  if (!coverage.coverageComplete) hardReasons.push("DATE_COVERAGE_GAP");
  if (coverage.sourcesConflict) hardReasons.push("CONFLICTING_SOURCE_COVERAGE");
  if (!coverage.fxAvailable) hardReasons.push("MISSING_FX_QUOTE");

  if (!reconciliation.comparable) {
    return {
      hardReasons,
      reconciliation: { applicable: false, warning: false },
      publishDisposition: hardReasons.length === 0 ? "INCLUDE" : "BLOCK",
    };
  }

  const shipment = quantity(reconciliation.shipmentQuantity);
  const transaction = quantity(reconciliation.transactionQuantity);
  const intersection = quantity(reconciliation.intersectionQuantity);
  if (intersection.greaterThan(shipment) || intersection.greaterThan(transaction)) {
    throw new Error("INVALID_RECONCILIATION_INTERSECTION");
  }
  const unmatched = shipment.sub(intersection).add(transaction.sub(intersection));
  const denominator = shipment.add(transaction);
  const ratio = denominator.isZero() ? "0.00000000" : decimal8(unmatched.div(denominator));
  return {
    hardReasons,
    reconciliation: {
      applicable: true,
      warning: !unmatched.isZero(),
      shipmentQuantity: decimal8(shipment),
      transactionQuantity: decimal8(transaction),
      intersectionQuantity: decimal8(intersection),
      unmatchedAbsolute: decimal8(unmatched),
      unmatchedRatio: ratio,
    },
    publishDisposition: hardReasons.length === 0 ? "INCLUDE" : "BLOCK",
  };
}

export function validateQualityAcknowledgement(input: {
  readonly kind: SliceIssueKind;
  readonly marketplaceSize: MarketplaceSize;
  readonly reason: string;
  readonly confirmations: string;
}): void {
  if (!input.reason.trim()) throw new Error("QUALITY_ACK_REASON_REQUIRED");
  if (!/^\d+$/u.test(input.confirmations)) throw new Error("INVALID_CONFIRMATION_COUNT");
  const required = input.marketplaceSize === "SMALL" ? 1n : 2n;
  if (BigInt(input.confirmations) < required) throw new Error("QUALITY_ACK_SECOND_CONFIRMATION_REQUIRED");
}
