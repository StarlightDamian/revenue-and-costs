import Decimal from "decimal.js";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export function formatMoney(value: string): string {
  const fixed = new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
  const [integer = "0", decimals = "00"] = fixed.split(".");
  const sign = integer.startsWith("-") ? "-" : "";
  const digits = sign ? integer.slice(1) : integer;
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${decimals}`;
}

export function formatRatio(value?: string): string {
  if (value === undefined || value === null || value === "") return "—";
  return `${new Decimal(value).times("100").toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2)}%`;
}

export function formatBytes(value: string | number): string {
  let bytes = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "未知";
  const units = ["B", "KiB", "MiB", "GiB"];
  let unit = 0;
  while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit += 1; }
  return `${bytes.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
