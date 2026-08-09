import { Temporal } from "@js-temporal/polyfill";

export function parseUnambiguousDate(input: string): string | undefined {
  const value = input.trim();
  let canonical: string | undefined;

  const dashed = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  const slashed = /^(\d{4})\/(\d{2})\/(\d{2})$/u.exec(value);
  const chinese = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(value);
  const match = dashed ?? slashed ?? chinese;
  if (match) {
    canonical = `${match[1]}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  }
  if (!canonical) return undefined;

  try {
    return Temporal.PlainDate.from(canonical).toString();
  } catch {
    return undefined;
  }
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}
