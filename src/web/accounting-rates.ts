import Decimal from "decimal.js";

Decimal.set({ precision: 50, rounding: Decimal.ROUND_HALF_UP });

export function percentInputToRatio(value: string, label: string): string | null {
  const candidate = value.trim();
  if (candidate === "") return null;
  const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/u.exec(candidate);
  if (!match) throw new Error(`${label}请输入非负十进制百分比`);
  if ((match[1]?.length ?? 0) > 6) throw new Error(`${label}最多保留 6 位小数`);
  const percent = new Decimal(candidate);
  if (percent.greaterThan(100)) throw new Error(`${label}必须在 0% 到 100% 之间`);
  return percent.div(100).toDecimalPlaces(8, Decimal.ROUND_HALF_UP).toFixed(8);
}

export function ratioToPercentInput(value: string | null): string {
  if (value === null) return "";
  return new Decimal(value).mul(100).toFixed(6).replace(/\.?0+$/u, "");
}
