import { AppError } from "./errors.js";

export interface AccountingPeriodInput {
  readonly periodStart?: string;
  readonly periodEnd?: string;
}

export interface AccountingPeriodScope {
  readonly periodStart: string;
  readonly periodEnd: string;
}

const MONTH_PATTERN = /^(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])$/u;

export function parseAccountingPeriodScope(input: AccountingPeriodInput): AccountingPeriodScope | undefined {
  const periodStart = input.periodStart?.trim() || undefined;
  const periodEnd = input.periodEnd?.trim() || undefined;
  if (!periodStart && !periodEnd) return undefined;
  if (!periodStart || !periodEnd) {
    throw new AppError("ACCOUNTING_PERIOD_SCOPE_INCOMPLETE", "请选择完整的本次核算起止月份", 400);
  }
  if (!MONTH_PATTERN.test(periodStart) || !MONTH_PATTERN.test(periodEnd)) {
    throw new AppError("ACCOUNTING_PERIOD_SCOPE_INVALID", "核算月份必须使用 YYYY-MM 格式", 400);
  }
  if (periodStart > periodEnd) {
    throw new AppError("ACCOUNTING_PERIOD_SCOPE_REVERSED", "核算开始月份不能晚于结束月份", 400);
  }
  if (periodStart.slice(0, 4) !== periodEnd.slice(0, 4)) {
    throw new AppError("ACCOUNTING_PERIOD_SCOPE_CROSS_YEAR", "本次核算起止月份必须位于同一自然年", 400);
  }
  return { periodStart, periodEnd };
}

export function accountingPeriodContains(scope: AccountingPeriodScope | undefined, month: string): boolean {
  return !scope || (month >= scope.periodStart && month <= scope.periodEnd);
}

export function accountingPeriodStartDate(month: string): string {
  return `${month}-01`;
}
