import { describe, expect, it, vi } from "vitest";
import { structuredLog } from "../../src/shared/structured-logger.js";

describe("structuredLog", () => {
  it("does not let diagnostic fields override the event envelope", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      structuredLog("info", "worker", "actual_event", {
        level: "error",
        time: 0,
        event: "spoofed_event",
        service: "api",
      });
      const line = JSON.parse(String(write.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(line).toMatchObject({ level: "info", event: "actual_event", service: "worker" });
      expect(line.time).toEqual(expect.any(Number));
      expect(line.time).not.toBe(0);
    } finally {
      write.mockRestore();
    }
  });

  it("keeps diagnostics failures isolated from business flow", () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("synthetic diagnostics failure");
    });
    try {
      expect(() => structuredLog("error", "worker", "synthetic_event", { value: 1n })).not.toThrow();
    } finally {
      write.mockRestore();
    }
  });
});
