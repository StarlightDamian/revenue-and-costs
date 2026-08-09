import { describe, expect, it } from 'vitest';
import {
  cumulativeCreditReversal,
  formatCents,
  parseCnyToCents,
  quoteTopUp,
  roundHalfUp,
} from '../../src/modules/wallet/index.js';

describe('充值 Golden', () => {
  it.each([
    ['10000', '10000', '10000'],
    ['999999', '999999', '10000'],
    ['1000000', '1000000', '10000'],
    ['1999999', '1999999', '10000'],
    ['2000000', '2000000', '10000'],
  ] as const)('到账 %s 分得到应付 %s 分和比例 %s', (credit, payable, basisPoints) => {
    expect(quoteTopUp(credit)).toEqual({
      creditAmountCents: credit,
      payableAmountCents: payable,
      discountBasisPoints: basisPoints,
    });
  });

  it('新充值不打折，历史退款仍可使用 ROUND_HALF_UP', () => {
    expect(quoteTopUp('1000001').payableAmountCents).toBe('1000001');
    expect(roundHalfUp(5n, 2n)).toBe(3n);
    expect(roundHalfUp(-5n, 2n)).toBe(-3n);
  });

  it('拒绝低于 100 元的充值', () => {
    expect(() => quoteTopUp('9999')).toThrow('最低充值');
  });

  it('人民币字符串与分精确互换，不经过 number', () => {
    expect(parseCnyToCents('100.01')).toBe(10001n);
    expect(formatCents(-10001n)).toBe('-100.01');
    expect(() => parseCnyToCents('1.001')).toThrow();
  });
});

describe('渠道累计冲正 Golden', () => {
  it('按累计值计算，最后一次全额冲正精确扣回原到账余额', () => {
    expect(
      cumulativeCreditReversal({
        originalCreditCents: '1000001',
        originalPayableCents: '900001',
        cumulativePayableReversedCents: '300000',
      }),
    ).toBe(333333n);
    expect(
      cumulativeCreditReversal({
        originalCreditCents: '1000001',
        originalPayableCents: '900001',
        cumulativePayableReversedCents: '900001',
      }),
    ).toBe(1000001n);
  });

  it('拒绝超过原支付的退款或倒序负值', () => {
    expect(() =>
      cumulativeCreditReversal({
        originalCreditCents: '10000',
        originalPayableCents: '10000',
        cumulativePayableReversedCents: '10001',
      }),
    ).toThrow();
  });
});
