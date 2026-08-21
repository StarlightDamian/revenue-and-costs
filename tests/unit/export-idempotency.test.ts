import { describe, expect, it } from "vitest";
import { assertExportIdempotencyMatch } from "../../src/modules/exports/postgres";

describe("export idempotency request binding", () => {
  const prior = {
    shopId: "shop-a",
    snapshotId: "snapshot-a",
    profitRate: "0.04370000",
    minimumSalesCostRate: "0.15000000",
    periodStart: "2026-04",
    periodEnd: "2026-06",
  };

  it("reuses an identical account/shop/snapshot request", () => {
    expect(() => assertExportIdempotencyMatch(prior, prior)).not.toThrow();
  });

  it("rejects the same key when shop or snapshot differs", () => {
    expect(() => assertExportIdempotencyMatch(prior, { shopId: "shop-b", snapshotId: "snapshot-a" })).toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
    expect(() => assertExportIdempotencyMatch(prior, { shopId: "shop-a", snapshotId: "snapshot-b" })).toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
  });

  it("rejects the same key when either accounting assumption differs", () => {
    expect(() => assertExportIdempotencyMatch(prior, { ...prior, profitRate: null }))
      .toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
    expect(() => assertExportIdempotencyMatch(prior, { ...prior, minimumSalesCostRate: null }))
      .toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
  });

  it("rejects the same key when the report period differs", () => {
    expect(() => assertExportIdempotencyMatch(prior, { ...prior, periodEnd: "2026-05" }))
      .toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
    expect(() => assertExportIdempotencyMatch(prior, { ...prior, periodStart: null, periodEnd: null }))
      .toThrow("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
  });
});
