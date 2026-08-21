import { AppError } from '../../shared/errors.js';

export interface PlainDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

export function parsePlainDate(value: string): PlainDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new AppError('DATE_INVALID', '日期必须是 YYYY-MM-DD', 400);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new AppError('DATE_INVALID', '日期无效', 400);
  }
  return { year, month, day };
}

export function formatPlainDate(date: PlainDate): string {
  return `${date.year.toString().padStart(4, '0')}-${date.month.toString().padStart(2, '0')}-${date.day
    .toString()
    .padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function anniversary(startDate: string, years: number): string {
  if (!Number.isSafeInteger(years) || years < 1) throw new AppError('BILLING_YEARS_INVALID', '计费年数必须为正整数', 400);
  const start = parsePlainDate(startDate);
  const year = start.year + years;
  return formatPlainDate({ year, month: start.month, day: Math.min(start.day, daysInMonth(year, start.month)) });
}

export function comparePlainDate(left: string, right: string): number {
  parsePlainDate(left);
  parsePlainDate(right);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function billedYears(startDate: string, requestedCloseDate: string): number {
  if (comparePlainDate(requestedCloseDate, startDate) <= 0) {
    throw new AppError('SHOP_TERM_INVALID', '关闭日期必须晚于开始日期', 400);
  }
  for (let years = 1; years <= 100; years += 1) {
    if (comparePlainDate(requestedCloseDate, anniversary(startDate, years)) <= 0) return years;
  }
  throw new AppError('SHOP_TERM_LIMIT', '单次店铺期限不能超过 100 个计费年', 400);
}
