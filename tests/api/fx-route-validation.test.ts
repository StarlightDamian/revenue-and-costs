import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { fxRoutes } from "../../src/api/routes/fx.js";

describe("FX history query validation", () => {
  it("rejects invalid dates and currencies before querying history", async () => {
    const history = vi.fn(async () => ({ rows: [] }));
    const app = Fastify();
    await app.register(fxRoutes, {
      services: { history } as never,
    });

    const invalidDate = await app.inject({
      method: "GET",
      url: "/api/v1/fx/history?from=not-a-date",
    });
    const invalidCurrencies = await app.inject({
      method: "GET",
      url: "/api/v1/fx/history?currencies=USD,INVALID",
    });

    expect(invalidDate.statusCode).toBe(400);
    expect(invalidCurrencies.statusCode).toBe(400);
    expect(history).not.toHaveBeenCalled();
    await app.close();
  });

  it("normalizes a valid comma-separated currency filter", async () => {
    const history = vi.fn(async () => ({ rows: [] }));
    const app = Fastify();
    await app.register(fxRoutes, {
      services: { history } as never,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/fx/history?from=2026-07-01&to=2026-07-28&currencies=usd,%20jpy",
    });

    expect(response.statusCode).toBe(200);
    expect(history).toHaveBeenCalledWith({
      from: "2026-07-01",
      to: "2026-07-28",
      currencies: ["USD", "JPY"],
    });
    await app.close();
  });
});
