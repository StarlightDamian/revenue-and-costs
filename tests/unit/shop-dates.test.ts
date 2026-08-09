import { describe, expect, it } from 'vitest';
import { anniversary, billedYears } from '../../src/modules/shops/index.js';

describe('店铺周年和向上取整计费 Golden', () => {
  it('2 月 29 日在非闰年取 2 月最后一天', () => {
    expect(anniversary('2024-02-29', 1)).toBe('2025-02-28');
    expect(anniversary('2024-02-29', 4)).toBe('2028-02-29');
    expect(billedYears('2024-02-29', '2025-02-28')).toBe(1);
  });

  it('一个半日历年向上计为两年', () => {
    expect(billedYears('2025-01-01', '2026-07-01')).toBe(2);
  });

  it('周年当日不多计一年，超过一天才进入下一周年', () => {
    expect(billedYears('2025-01-01', '2026-01-01')).toBe(1);
    expect(billedYears('2025-01-01', '2026-01-02')).toBe(2);
  });

  it('关闭日期必须严格晚于开始日期', () => {
    expect(() => billedYears('2025-01-01', '2025-01-01')).toThrow();
  });
});
