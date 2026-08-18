import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { gunzipSync, gzipSync } from "node:zlib";
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
  it("creates a batch and registers its files atomically in input order", async () => {
    const createBatchWithFiles = vi.fn(async () => ({
      id: "30000000-0000-4000-8000-000000000003",
      files: [
        { id: "40000000-0000-4000-8000-000000000004", relativePath: "part-1.csv", offset: "0" },
        { id: "50000000-0000-4000-8000-000000000005", relativePath: "docs/summary.pdf", offset: "0" },
      ],
    }));
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { createBatchWithFiles } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "bulk-registration-key" },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        periodStart: "2026-04",
        periodEnd: "2026-06",
        fileCount: 2,
        files: [
          { relativePath: "part-1.csv", declaredSize: "12", contentType: "text/csv" },
          { relativePath: "docs/summary.pdf", declaredSize: "0", contentType: "application/pdf", metadataOnly: true },
        ],
      },
    });

    expect(response.statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.anything(), "20000000-0000-4000-8000-000000000002", "upload");
    expect(createBatchWithFiles).toHaveBeenCalledWith(
      "20000000-0000-4000-8000-000000000002",
      actor.accountId,
      "bulk-registration-key",
      [
        { relativePath: "part-1.csv", declaredSize: 12n, contentType: "text/csv" },
        { relativePath: "docs/summary.pdf", declaredSize: 0n, contentType: "application/pdf", metadataOnly: true },
      ],
      { periodStart: "2026-04", periodEnd: "2026-06" },
    );
    expect(response.json()).toEqual({
      id: "30000000-0000-4000-8000-000000000003",
      files: [
        { id: "40000000-0000-4000-8000-000000000004", relativePath: "part-1.csv", offset: "0" },
        { id: "50000000-0000-4000-8000-000000000005", relativePath: "docs/summary.pdf", offset: "0" },
      ],
    });
    await app.close();
  });

  it("rejects mismatched or unbounded bulk registration bodies before authorization", async () => {
    const createBatchWithFiles = vi.fn();
    const authorize = vi.fn(async () => actor);
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: { createBatchWithFiles } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      authorize,
      async auditOriginalDownload() {},
    });

    const mismatch = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "bulk-registration-key" },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        fileCount: 2,
        files: [{ relativePath: "part-1.csv", declaredSize: "12" }],
      },
    });
    const pathTooLong = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "bulk-registration-key" },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        fileCount: 1,
        files: [{ relativePath: "x".repeat(1025), declaredSize: "12" }],
      },
    });
    const fileCountTooLarge = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "bulk-registration-key" },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        fileCount: 20_001,
        files: [{ relativePath: "part-1.csv", declaredSize: "12" }],
      },
    });
    const incompletePeriod = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "bulk-registration-key" },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        periodStart: "2026-04",
        fileCount: 1,
        files: [{ relativePath: "part-1.csv", declaredSize: "12" }],
      },
    });
    const crossYearPeriod = await app.inject({
      method: "POST",
      url: "/api/v1/uploads/batches",
      headers: { "idempotency-key": "bulk-registration-key" },
      payload: {
        shopId: "20000000-0000-4000-8000-000000000002",
        periodStart: "2025-12",
        periodEnd: "2026-01",
        fileCount: 1,
        files: [{ relativePath: "part-1.csv", declaredSize: "12" }],
      },
    });

    expect(mismatch.statusCode).toBe(400);
    expect(pathTooLong.statusCode).toBe(400);
    expect(fileCountTooLarge.statusCode).toBe(400);
    expect(incompletePeriod.statusCode).toBe(400);
    expect(incompletePeriod.json()).toMatchObject({ code: "ACCOUNTING_PERIOD_SCOPE_INCOMPLETE" });
    expect(crossYearPeriod.statusCode).toBe(400);
    expect(crossYearPeriod.json()).toMatchObject({ code: "ACCOUNTING_PERIOD_SCOPE_CROSS_YEAR" });
    expect(authorize).not.toHaveBeenCalled();
    expect(createBatchWithFiles).not.toHaveBeenCalled();
    await app.close();
  });

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

  it("passes bounded gzip transport metadata to the upload service", async () => {
    const raw = Buffer.from("date,amount\n2026-08-10,123.45\n".repeat(100));
    const compressed = gzipSync(raw);
    const appendChunk = vi.fn(async () => BigInt(raw.length));
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: {
        async resolveFileShop() { return "20000000-0000-4000-8000-000000000002"; },
        appendChunk,
      } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      async authorize() { return actor; },
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/uploads/files/30000000-0000-4000-8000-000000000003",
      headers: {
        "content-type": "application/offset+octet-stream",
        "upload-offset": "0",
        "upload-checksum": `sha256 ${createHash("sha256").update(raw).digest("base64")}`,
        "upload-content-encoding": "gzip",
        "upload-uncompressed-length": String(raw.length),
      },
      payload: compressed,
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["upload-offset"]).toBe(String(raw.length));
    expect(appendChunk).toHaveBeenCalledWith(expect.objectContaining({ contentEncoding: "gzip", length: raw.length }));
    await app.close();
  });

  it("rejects incomplete compressed-upload header pairs before appending bytes", async () => {
    const appendChunk = vi.fn();
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: {
        async resolveFileShop() { return "20000000-0000-4000-8000-000000000002"; },
        appendChunk,
      } as unknown as UploadService,
      objectStore: {} as EncryptedObjectStore,
      async authorize() { return actor; },
      async auditOriginalDownload() {},
    });
    const baseHeaders = {
      "content-type": "application/offset+octet-stream",
      "upload-offset": "0",
      "upload-checksum": `sha256 ${Buffer.alloc(32).toString("base64")}`,
    };

    for (const headers of [
      { ...baseHeaders, "upload-content-encoding": "gzip" },
      { ...baseHeaders, "upload-uncompressed-length": "1" },
    ]) {
      const response = await app.inject({ method: "PATCH", url: "/api/v1/uploads/files/30000000-0000-4000-8000-000000000003", headers, payload: Buffer.from("x") });
      expect(response.statusCode).toBe(400);
    }
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

  it("streams compressible original downloads through nginx without response buffering", async () => {
    const raw = Buffer.from("date,amount\n2026-08-10,123.45\n".repeat(1_000));
    const original = {
      shopId: "20000000-0000-4000-8000-000000000002",
      relativePath: "report.csv",
      storagePath: "encrypted.esdk",
      encryptionContext: {},
      plaintextSize: String(raw.length),
    };
    const app = Fastify();
    await registerUploadRoutes(app, {
      service: {
        async original() { return original; },
        async consumeOriginalDownloadGrant() { return original; },
      } as unknown as UploadService,
      objectStore: { createDecryptionStream: () => Readable.from(raw) } as unknown as EncryptedObjectStore,
      async authorize() { return actor; },
      async auditOriginalDownload() {},
    });

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/uploads/files/30000000-0000-4000-8000-000000000003/original?token=${"a".repeat(43)}`,
      headers: { "accept-encoding": "gzip" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["x-accel-buffering"]).toBe("no");
    expect(response.headers["cache-control"]).toBe("private, no-store, max-age=0");
    expect(response.headers.pragma).toBe("no-cache");
    expect(gunzipSync(response.rawPayload)).toEqual(raw);
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
