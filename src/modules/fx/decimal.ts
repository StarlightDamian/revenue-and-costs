export { decimal, decimal8 } from "../../shared/decimal.js";

export function currencyCode(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw new Error(`INVALID_CURRENCY:${value}`);
  }
  return normalized;
}
