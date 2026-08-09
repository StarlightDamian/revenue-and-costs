import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it } from "vitest";
import { chinaMoneyRange } from "../../src/worker/register-handlers.js";

const instant = Temporal.Instant.from("2026-07-28T01:30:00Z");

describe("ChinaMoney worker ranges", () => {
  it("uses Shanghai calendar dates for full and rolling seven-day sync", () => {
    expect(chinaMoneyRange({ kind: "FULL_HISTORY" }, "2006-01-04", instant))
      .toEqual({ from: "2006-01-04", to: "2026-07-28" });
    expect(chinaMoneyRange({ kind: "RECENT_SEVEN_DAYS" }, "2006-01-04", instant))
      .toEqual({ from: "2026-07-22", to: "2026-07-28" });
  });

  it("validates explicit manual retry ranges", () => {
    expect(chinaMoneyRange({ kind: "MANUAL_RETRY", from: "2026-07-01", to: "2026-07-02" }, "2006-01-04", instant))
      .toEqual({ from: "2026-07-01", to: "2026-07-02" });
    expect(() => chinaMoneyRange({ kind: "MANUAL_RETRY", from: "2026-07-03", to: "2026-07-02" }, "2006-01-04", instant))
      .toThrow("FX_MANUAL_RANGE_INVALID");
  });
});
