import { Readable } from "node:stream";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { exportRoutes } from "../../src/api/routes/exports.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};
const exportId = "20000000-0000-4000-8000-000000000002";
const token = "a".repeat(43);

describe("export download token HTTP contract", () => {
  it("requires the exact base64url token shape before authentication", async () => {
    const authenticate = vi.fn(async () => actor);
    const download = vi.fn();
    const app = Fastify();
    await app.register(exportRoutes, { service: { download } as never, authenticate });

    expect((await app.inject({ method: "GET", url: `/api/v1/exports/${exportId}/download` })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/v1/exports/${exportId}/download?token=short` })).statusCode).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    await app.close();
  });

  it("issues a tokenized URL and passes request IDs through issuance and consumption", async () => {
    const authenticate = vi.fn(async () => actor);
    const createDownloadToken = vi.fn(async () => token);
    const download = vi.fn(async () => ({
      stream: Readable.from("report"),
      fileName: "report.xlsx",
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }));
    const app = Fastify();
    await app.register(exportRoutes, { service: { createDownloadToken, download } as never, authenticate });

    const issued = await app.inject({ method: "POST", url: `/api/v1/exports/${exportId}/download-token` });
    expect(issued.statusCode).toBe(200);
    expect(issued.json()).toEqual({ url: `/api/v1/exports/${exportId}/download?token=${token}` });
    expect(createDownloadToken).toHaveBeenCalledWith(actor, exportId, expect.any(String));

    const consumed = await app.inject({ method: "GET", url: `/api/v1/exports/${exportId}/download?token=${token}` });
    expect(consumed.statusCode).toBe(200);
    expect(download).toHaveBeenCalledWith(actor, exportId, token, expect.any(String));
    await app.close();
  });
});
