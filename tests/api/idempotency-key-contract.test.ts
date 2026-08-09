import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { exportRoutes } from "../../src/api/routes/exports.js";
import { registerUploadRoutes } from "../../src/api/routes/uploads.js";
import type { Actor } from "../../src/modules/authorization/index.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";
import type { UploadService } from "../../src/modules/uploads/service.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};

describe("idempotency key HTTP contract", () => {
  it("returns 400 for a short upload-batch key", async () => {
    const createBatch = vi.fn();
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { createBatch } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      async authorize() { return actor; },
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "short" },
      payload: { shopId: "20000000-0000-4000-8000-000000000002" },
    });

    expect(response.statusCode).toBe(400);
    expect(createBatch).not.toHaveBeenCalled();
    await app.close();
  });

  it("enforces the shared 8..200 character export-key boundary", async () => {
    const create = vi.fn();
    const app = Fastify();
    await app.register(exportRoutes, {
      service: { create } as never,
      async authenticate() { return actor; },
    });

    const request = (key: string) => app.inject({
      method: "POST",
      url: "/api/v1/exports",
      headers: { "idempotency-key": key },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        snapshotId: "30000000-0000-4000-8000-000000000003",
      },
    });

    expect((await request("short")).statusCode).toBe(400);
    expect((await request(" ".repeat(8))).statusCode).toBe(400);
    expect((await request("x".repeat(201))).statusCode).toBe(400);
    expect((await request("x".repeat(8))).statusCode).toBe(200);
    expect((await request("x".repeat(200))).statusCode).toBe(200);
    expect(create).toHaveBeenCalledTimes(2);
    await app.close();
  });
});
