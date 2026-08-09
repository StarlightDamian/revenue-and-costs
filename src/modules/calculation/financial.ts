import Decimal from "decimal.js";
import { decimal, decimal8 } from "../fx/decimal.js";
import {
  REFUND_FIELDS,
  SHIPMENT_INCOME_FIELDS,
  type CalculationFactResult,
  type FactFxConversion,
  type FinancialComponent,
  type FinancialSummary,
  type ShipmentFact,
  type TransactionFact,
} from "./types.js";

const ZERO = "0.00000000";

type SummaryKey = Exclude<keyof FinancialSummary, "platformBalance">;

const SUMMARY_KEY: Readonly<Record<FinancialComponent, SummaryKey>> = {
  INCOME: "income",
  REFUND: "refund",
  WITHHELD_TAX: "withheldTax",
  PLATFORM_FEE: "platformFee",
  FBA_FULFILLMENT_FEE: "fbaFulfillmentFee",
  ADVERTISING_FEE: "advertisingFee",
  FBA_STORAGE_FEE: "fbaStorageFee",
  OTHER_DEDUCTION: "otherDeduction",
};

function canonical(value: string): string {
  return value.normalize("NFKC").trim().replace(/[\s-]+/gu, "_").toUpperCase();
}

function assertConversion(fact: ShipmentFact | TransactionFact, fx: FactFxConversion): void {
  if (fx.requestedDate !== fact.fxDate) throw new Error(`FX_DATE_MISMATCH:${fact.id}`);
  if (fx.hitDate < fx.requestedDate) throw new Error(`INVALID_FX_HIT_DATE:${fact.id}`);
  if (!/^\d+$/u.test(fx.fallbackDays) || BigInt(fx.fallbackDays) > 10n) {
    throw new Error(`INVALID_FX_FALLBACK:${fact.id}`);
  }
  if (!decimal(fx.rate).isPositive()) throw new Error(`INVALID_FX_RATE:${fact.id}`);
}

function makeResult(
  fact: ShipmentFact | TransactionFact,
  sourceColumn: string,
  component: FinancialComponent,
  amount: string,
  fx: FactFxConversion,
  costDirection: boolean,
): CalculationFactResult | null {
  const original = decimal(amount);
  if (original.isZero()) return null;
  const cny = original.mul(decimal(fx.rate));
  return {
    factKind: fact.kind,
    factId: fact.id,
    datasetVersionId: fact.datasetVersionId,
    sourceColumn,
    component,
    amountOriginal: decimal8(original),
    amountCny: decimal8(costDirection ? cny.neg() : cny),
    fx,
  };
}

function pushResult(
  results: CalculationFactResult[],
  fact: ShipmentFact | TransactionFact,
  sourceColumn: string,
  component: FinancialComponent,
  amount: string,
  fx: FactFxConversion,
  costDirection: boolean,
): void {
  const result = makeResult(fact, sourceColumn, component, amount, fx, costDirection);
  if (result) results.push(result);
}

function transactionResults(fact: TransactionFact, fx: FactFxConversion): CalculationFactResult[] {
  const results: CalculationFactResult[] = [];
  const type = canonical(fact.type);
  const description = canonical(fact.description);

  if (type === "ORDER" && fact.fulfillmentMode === "MERCHANT") {
    // The merchant-order income contract uses the same nine semantic amount
    // columns as refunds; keeping one field list prevents locale/column drift.
    for (const field of REFUND_FIELDS) {
      pushResult(results, fact, field, "INCOME", fact.amounts[field], fx, false);
    }
  }

  if (type === "REFUND") {
    for (const field of REFUND_FIELDS) {
      pushResult(results, fact, field, "REFUND", fact.amounts[field], fx, true);
    }
  }

  // Withheld tax is independent and applies to every transaction type.
  pushResult(
    results,
    fact,
    "marketplaceWithheldTax",
    "WITHHELD_TAX",
    fact.amounts.marketplaceWithheldTax,
    fx,
    true,
  );
  pushResult(results, fact, "sellingFees", "PLATFORM_FEE", fact.amounts.sellingFees, fx, true);
  pushResult(results, fact, "fbaFees", "FBA_FULFILLMENT_FEE", fact.amounts.fbaFees, fx, true);

  const otherTransactionComponent = description === "COST_OF_ADVERTISING"
    ? "ADVERTISING_FEE"
    : "OTHER_DEDUCTION";
  pushResult(
    results,
    fact,
    "otherTransactionFees",
    otherTransactionComponent,
    fact.amounts.otherTransactionFees,
    fx,
    true,
  );

  if (type === "FBA_INVENTORY_FEE") {
    pushResult(results, fact, "other", "FBA_STORAGE_FEE", fact.amounts.other, fx, true);
  } else if (type !== "TRANSFER" && type !== "DEBT") {
    pushResult(results, fact, "other", "OTHER_DEDUCTION", fact.amounts.other, fx, true);
  }
  return results;
}

export class FinancialAccumulator {
  private readonly totals: Record<SummaryKey, Decimal> = {
    income: new Decimal(0),
    refund: new Decimal(0),
    withheldTax: new Decimal(0),
    platformFee: new Decimal(0),
    fbaFulfillmentFee: new Decimal(0),
    advertisingFee: new Decimal(0),
    fbaStorageFee: new Decimal(0),
    otherDeduction: new Decimal(0),
  };

  private append(result: CalculationFactResult): void {
    const key = SUMMARY_KEY[result.component];
    this.totals[key] = this.totals[key].add(decimal(result.amountCny));
  }

  addShipment(fact: ShipmentFact, fx: FactFxConversion): readonly CalculationFactResult[] {
    assertConversion(fact, fx);
    const results: CalculationFactResult[] = [];
    for (const field of SHIPMENT_INCOME_FIELDS) {
      // Each amount is already a row total; shipped quantity is intentionally not used.
      const result = makeResult(fact, field, "INCOME", fact.amounts[field], fx, false);
      if (!result) continue;
      results.push(result);
      this.append(result);
    }
    return results;
  }

  addTransaction(fact: TransactionFact, fx: FactFxConversion): readonly CalculationFactResult[] {
    assertConversion(fact, fx);
    const results = transactionResults(fact, fx);
    results.forEach((result) => this.append(result));
    return results;
  }

  summary(): FinancialSummary {
    const balance = this.totals.income
      .sub(this.totals.refund)
      .sub(this.totals.withheldTax)
      .sub(this.totals.platformFee)
      .sub(this.totals.fbaFulfillmentFee)
      .sub(this.totals.advertisingFee)
      .sub(this.totals.fbaStorageFee)
      .sub(this.totals.otherDeduction);
    return {
      income: decimal8(this.totals.income) || ZERO,
      refund: decimal8(this.totals.refund) || ZERO,
      withheldTax: decimal8(this.totals.withheldTax) || ZERO,
      platformFee: decimal8(this.totals.platformFee) || ZERO,
      fbaFulfillmentFee: decimal8(this.totals.fbaFulfillmentFee) || ZERO,
      advertisingFee: decimal8(this.totals.advertisingFee) || ZERO,
      fbaStorageFee: decimal8(this.totals.fbaStorageFee) || ZERO,
      otherDeduction: decimal8(this.totals.otherDeduction) || ZERO,
      platformBalance: decimal8(balance),
    };
  }
}

/** Convenience helper for Golden/small-batch callers. Production workers should
 * persist each `add*` result before reading `summary()` so memory stays bounded. */
export function calculateFinancials(input: {
  readonly shipments: Iterable<readonly [ShipmentFact, FactFxConversion]>;
  readonly transactions: Iterable<readonly [TransactionFact, FactFxConversion]>;
}): { readonly results: readonly CalculationFactResult[]; readonly summary: FinancialSummary } {
  const accumulator = new FinancialAccumulator();
  const results: CalculationFactResult[] = [];
  for (const [fact, fx] of input.shipments) results.push(...accumulator.addShipment(fact, fx));
  for (const [fact, fx] of input.transactions) results.push(...accumulator.addTransaction(fact, fx));
  return { results, summary: accumulator.summary() };
}
