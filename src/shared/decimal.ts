import Decimal from "decimal.js";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -40, toExpPos: 40 });

export type DecimalString = string & { readonly __decimal: unique symbol };

export function decimal(value: string): Decimal {
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) throw new Error("INVALID_DECIMAL");
  return new Decimal(value);
}

export function decimal8(value: Decimal.Value): DecimalString {
  return new Decimal(value).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8) as DecimalString;
}

export function display2(value: Decimal.Value): string {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}
