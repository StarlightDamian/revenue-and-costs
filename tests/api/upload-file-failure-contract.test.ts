import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerUploadRoutes } from "../../src/api/routes/uploads.js";
import type { Actor } from "../../src/modules/authorization/index.js";
import type { EncryptedObjectStore } from "../../src/modules/storage/encrypted-object-store.js";
import type { UploadService } from "../../src/modules/uploads/service.js";

const actor: Actor = {
  accountId: "10000000-0000-4000-8000-000000000001",
  status: "ACTIVE",
  roles: new Set(["ACCOUNTANT"]),
};

describe("upload file failure HTTP contract", () => {
  it("registers a PDF as metadata-only without uploading its bytes", async () => {
    const resolveBatchShop = vi.fn(async () => "20000000-0000-4000-8000-000000000002");
    const createFile = vi.fn(async () => "30000000-0000-4000-8000-000000000003");
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { resolveBatchShop, createFile } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches/30000000-0000-4000-8000-000000000003/files",
      payload: {
        relativePath: "2026Q2/CustomSummary.pdf",
        declaredSize: "0",
        contentType: "application/pdf",
        metadataOnly: true,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "20000000-0000-4000-8000-000000000002", "upload");
    expect(createFile).toHaveBeenCalledWith({
      batchId: "30000000-0000-4000-8000-000000000003",
      relativePath: "2026Q2/CustomSummary.pdf",
      declaredSize: 0n,
      contentType: "application/pdf",
      metadataOnly: true,
    });
    await app.close();
  });

  it("rejects invalid batch and file ids before resolving their shops", async () => {
    const resolveBatchShop = vi.fn(async () => "20000000-0000-4000-8000-000000000002");
    const resolveFileShop = vi.fn(async () => "20000000-0000-4000-8000-000000000002");
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { resolveBatchShop, resolveFileShop } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const invalidBatch = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches/not-a-uuid/files",
      payload: { relativePath: "report.csv", declaredSize: "1" },
    });
    const invalidFile = await app.inject({
      method: "HEAD",
      url: "/api/v1/uploads/files/not-a-uuid",
    });

    expect(invalidBatch.statusCode).toBe(400);
    expect(invalidFile.statusCode).toBe(400);
    expect(resolveBatchShop).not.toHaveBeenCalled();
    expect(resolveFileShop).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid declared size before authorization or file creation", async () => {
    const resolveBatchShop = vi.fn(async () => "20000000-0000-4000-8000-000000000002");
    const createFile = vi.fn();
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { resolveBatchShop, createFile } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches/30000000-0000-4000-8000-000000000003/files",
      payload: { relativePath: "report.csv", declaredSize: "abc" },
    });

    expect(response.statusCode).toBe(400);
    expect(resolveBatchShop).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(createFile).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid upload offset before authorization or chunk append", async () => {
    const resolveFileShop = vi.fn(async () => "20000000-0000-4000-8000-000000000002");
    const appendChunk = vi.fn();
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { resolveFileShop, appendChunk } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/uploads/files/30000000-0000-4000-8000-000000000003",
      headers: {
        "content-type": "application/offset+octet-stream",
        "upload-offset": "abc",
        "upload-checksum": `sha256 ${Buffer.alloc(32).toString("base64")}`,
      },
      payload: Buffer.from("x"),
    });

    expect(response.statusCode).toBe(400);
    expect(resolveFileShop).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(appendChunk).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects an invalid original-download token before reading the file", async () => {
    const original = vi.fn();
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { original } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/uploads/files/30000000-0000-4000-8000-000000000003/original?token=invalid",
    });

    expect(response.statusCode).toBe(400);
    expect(original).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    await app.close();
  });

  it("authorizes the file object and records an allow-listed terminal client failure idempotently", async () => {
    const failFile = vi.fn(async () => undefined);
    const resolveFileShop = vi.fn(async () => "20000000-0000-4000-8000-000000000002");
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { failFile, resolveFileShop } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/files/30000000-0000-4000-8000-000000000003/fail",
      payload: { reasonCode: "CLIENT_NETWORK_RETRY_EXHAUSTED" },
    });

    expect(response.statusCode).toBe(204);
    expect(resolveFileShop).toHaveBeenCalledWith("30000000-0000-4000-8000-000000000003");
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "20000000-0000-4000-8000-000000000002", "upload");
    expect(failFile).toHaveBeenCalledWith("30000000-0000-4000-8000-000000000003", "CLIENT_NETWORK_RETRY_EXHAUSTED");
    await app.close();
  });

  it("rejects internal ZIP codes and arbitrary reason text at the HTTP schema boundary", async () => {
    const failFile = vi.fn(async () => undefined);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: {
        failFile,
        async resolveFileShop() { return "20000000-0000-4000-8000-000000000002"; },
      } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      async authorize() { return actor; },
      async auditOriginalDownload() {},
    });

    for (const payload of [
      { reasonCode: "ZIP_UNSAFE_PATH" },
      { reasonCode: "CLIENT_UPLOAD_ABORTED", reason: "arbitrary raw exception text" },
    ]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/uploads/files/30000000-0000-4000-8000-000000000003/fail",
        payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(failFile).not.toHaveBeenCalled();
    await app.close();
  });
});
