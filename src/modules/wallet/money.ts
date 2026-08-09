import { AppError } from '../../shared/errors.js';

const CNY_PATTERN = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,2}))?$/;

export function parseCnyToCents(value: string): bigint {
  const match = CNY_PATTERN.exec(value.trim());
  if (!match) throw new AppError('MONEY_INVALID', '金额必须是最多两位小数的非负十进制字符串', 400);
  const yuan = BigInt(match[1] ?? '0');
  const fraction = (match[2] ?? '').padEnd(2, '0');
  return yuan * 100n + BigInt(fraction || '0');
}

export function formatCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const absolute = cents < 0n ? -cents : cents;
  return `${sign}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('除数必须为正数');
  const sign = numerator < 0n ? -1n : 1n;
  const absolute = numerator < 0n ? -numerator : numerator;
  const quotient = absolute / denominator;
  const remainder = absolute % denominator;
  return sign * (quotient + (remainder * 2n >= denominator ? 1n : 0n));
}

export interface TopUpQuote {
  readonly creditAmountCents: string;
  readonly payableAmountCents: string;
  readonly discountBasisPoints: '10000';
}

export function quoteTopUp(creditAmountCents: string): TopUpQuote {
  const credit = BigInt(creditAmountCents);
  if (credit < 10_000n) throw new AppError('TOP_UP_MINIMUM', '最低充值到账金额为 100.00 元', 400);
  return {
    creditAmountCents: credit.toString(),
    payableAmountCents: credit.toString(),
    discountBasisPoints: '10000',
  };
}

export function cumulativeCreditReversal(input: {
  readonly originalCreditCents: string;
  readonly originalPayableCents: string;
  readonly cumulativePayableReversedCents: string;
}): bigint {
  const originalCredit = BigInt(input.originalCreditCents);
  const originalPayable = BigInt(input.originalPayableCents);
  const cumulativePayable = BigInt(input.cumulativePayableReversedCents);
  if (originalPayable <= 0n || cumulativePayable <= 0n || cumulativePayable > originalPayable) {
    throw new AppError('REVERSAL_AMOUNT_INVALID', '累计冲正金额超出原支付金额', 409);
  }
  return cumulativePayable === originalPayable
    ? originalCredit
    : roundHalfUp(originalCredit * cumulativePayable, originalPayable);
}
