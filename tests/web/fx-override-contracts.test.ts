import { describe, expect, it } from "vitest";
import { normalizeFxOverrideList, normalizeFxOverrideMutation } from "../../src/web/api/financial-contracts.js";

const override = {
  id: "override-2",
  currency: "BRL",
  validFrom: "2025-12-30",
  validTo: "2025-12-30",
  cnyPerUnit: "1.33000000",
  sourceReference: "授权来源 2025-12-30",
  reason: "补齐小站点币种报价",
  createdAt: "2026-08-09T08:00:00.000Z",
  supersedesOverrideId: "override-1",
  isCurrent: true,
};

describe("FX override response contracts", () => {
  it("preserves decimal rates as strings and revision metadata", () => {
    expect(normalizeFxOverrideList({ rows: [override] })).toEqual([override]);
    expect(normalizeFxOverrideMutation({ override })).toEqual(override);
  });

  it("rejects numeric rates instead of accepting floating point values", () => {
    expect(() => normalizeFxOverrideList({ rows: [{ ...override, cnyPerUnit: 1.33 }] })).toThrow("人工汇率接口返回格式无效");
  });

  it("accepts a first revision without a superseded id", () => {
    const first = { ...override, id: "override-1", supersedesOverrideId: null };
    expect(normalizeFxOverrideMutation({ override: first })).toMatchObject({ id: "override-1", supersedesOverrideId: null });
  });
});
