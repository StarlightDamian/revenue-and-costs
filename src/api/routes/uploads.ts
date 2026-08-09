import { Readable } from "node:stream";
import { basename } from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Actor } from "../../modules/authorization";
import type { EncryptedObjectStore } from "../../modules/storage/encrypted-object-store";
import { MAX_CHUNK_BYTES, type UploadService } from "../../modules/uploads/service";
import { CLIENT_UPLOAD_FAILURE_CODES, type ClientUploadFailureCode } from "../../modules/uploads/partial-failure.js";
import { UuidSchema } from "../../shared/contracts.js";
import { requireIdempotencyKey } from "../idempotency.js";

export interface UploadRouteDependencies {
  service: UploadService;
  objectStore: EncryptedObjectStore;
  authorize: (request: unknown, shopId: string, action: "upload" | "offset" | "original", reason?: string) => Promise<Actor>;
  auditOriginalDownload: (actor: Actor, fileId: string, reason?: string) => Promise<void>;
}

const UploadByteCount = Type.String({ pattern: "^(?:0|[1-9][0-9]{0,9})$" });
const BatchParams = Type.Object({ batchId: UuidSchema });
const FileParams = Type.Object({ fileId: UuidSchema });
const OriginalDownloadQuery = Type.Object({ token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) });
const ChunkHeaders = Type.Object({
  "upload-offset": UploadByteCount,
  "content-length": Type.String({ pattern: "^(?:0|[1-9][0-9]{0,7})$" }),
});

export async function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDependencies): Promise<void> {
  app.addContentTypeParser("application/offset+octet-stream", (_request, payload, done) => done(null, payload));
  app.post("/api/v1/uploads/batches", { schema: { body: Type.Object({ shopId: UuidSchema }) } }, async (request) => {
    const body = request.body as { shopId: string };
    const actor = await deps.authorize(request, body.shopId, "upload");
    const key = requireIdempotencyKey(request);
    return { id: await deps.service.createBatch(body.shopId, actor.accountId, key) };
  });
  app.post("/api/v1/uploads/batches/:batchId/files", { schema: { params: BatchParams, body: Type.Object({ relativePath: Type.String(), declaredSize: UploadByteCount, contentType: Type.Optional(Type.String()), metadataOnly: Type.Optional(Type.Boolean()) }) } }, async (request, reply) => {
    const body = request.body as { relativePath: string; declaredSize: string; contentType?: string; metadataOnly?: boolean };
    const batchId = (request.params as { batchId: string }).batchId;
    await deps.authorize(request, await deps.service.resolveBatchShop(batchId), "upload");
    const id = await deps.service.createFile({ batchId, relativePath: body.relativePath, declaredSize: BigInt(body.declaredSize), ...(body.contentType ? { contentType: body.contentType } : {}), ...(body.metadataOnly ? { metadataOnly: true } : {}) });
    return reply.code(201).header("Location", `/api/v1/uploads/files/${id}`).header("Tus-Resumable", "1.0.0").send({ id, offset: "0" });
  });
  app.patch("/api/v1/uploads/files/:fileId", {
    bodyLimit: MAX_CHUNK_BYTES,
    schema: { params: FileParams, headers: ChunkHeaders },
  }, async (request, reply) => {
    const fileId = (request.params as { fileId: string }).fileId;
    await deps.authorize(request, await deps.service.resolveFileShop(fileId), "upload");
    const offset = BigInt(String(request.headers["upload-offset"] ?? "-1"));
    const checksum = String(request.headers["upload-checksum"] ?? "").replace(/^sha256\s+/i, "");
    const length = Number(request.headers["content-length"] ?? -1);
    const body = request.body;
    if (!(body instanceof Readable)) throw new Error("UPLOAD_BODY_STREAM_REQUIRED");
    const next = await deps.service.appendChunk({ fileId, expectedOffset: offset, expectedSha256: checksum, length, body });
    return reply.code(204).header("Tus-Resumable", "1.0.0").header("Upload-Offset", next.toString()).send();
  });
  app.head("/api/v1/uploads/files/:fileId", { schema: { params: FileParams } }, async (request, reply) => {
    const fileId = (request.params as { fileId: string }).fileId;
    await deps.authorize(request, await deps.service.resolveFileShop(fileId), "offset");
    const file = await deps.service.fileOffset(fileId);
    return reply.code(204)
      .header("Tus-Resumable", "1.0.0")
      .header("Upload-Offset", file.offset)
      .header("Upload-Length", file.length)
      .send();
  });
  app.post<{ Params: { fileId: string }; Body: { reasonCode: ClientUploadFailureCode } }>("/api/v1/uploads/files/:fileId/fail", {
    schema: {
      params: FileParams,
      body: Type.Object(
        {
          reasonCode: Type.Union(CLIENT_UPLOAD_FAILURE_CODES.map((code) => Type.Literal(code))),
          reason: Type.Optional(Type.Never()),
        },
        { additionalProperties: false },
      ),
    },
  }, async (request, reply) => {
    await deps.authorize(request, await deps.service.resolveFileShop(request.params.fileId), "upload");
    await deps.service.failFile(request.params.fileId, request.body.reasonCode);
    return reply.code(204).send();
  });
  app.post("/api/v1/uploads/batches/:batchId/complete", { schema: { params: BatchParams } }, async (request) => {
    const batchId = (request.params as { batchId: string }).batchId;
    await deps.authorize(request, await deps.service.resolveBatchShop(batchId), "upload");
    return deps.service.completeBatch(batchId);
  });
  app.post("/api/v1/uploads/batches/:batchId/cancel", { schema: { params: BatchParams } }, async (request, reply) => {
    const batchId = (request.params as { batchId: string }).batchId;
    await deps.authorize(request, await deps.service.resolveBatchShop(batchId), "upload");
    await deps.service.cancelBatch(batchId);
    return reply.code(204).send();
  });
  app.post<{ Params: { fileId: string }; Body: { reason?: string } }>("/api/v1/uploads/files/:fileId/download-token", {
    schema: { params: FileParams, body: Type.Object({ reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })) }) },
  }, async (request) => {
    const original = await deps.service.original(request.params.fileId);
    const actor = await deps.authorize(request, original.shopId, "original", request.body.reason);
    const token = await deps.service.issueOriginalDownloadGrant(request.params.fileId, actor.accountId, original.shopId, request.body.reason);
    return { url: `/api/v1/uploads/files/${request.params.fileId}/original?token=${encodeURIComponent(token)}`, expiresInSeconds: 300 };
  });
  app.get<{ Params: { fileId: string }; Querystring: { token: string } }>("/api/v1/uploads/files/:fileId/original", { schema: { params: FileParams, querystring: OriginalDownloadQuery } }, async (request, reply) => {
    const actor = await deps.authorize(request, (await deps.service.original(request.params.fileId)).shopId, "original", "short-lived grant");
    const original = await deps.service.consumeOriginalDownloadGrant(request.params.fileId, actor.accountId, request.query.token);
    await deps.auditOriginalDownload(actor, request.params.fileId, original.reason);
    const fileName = basename(original.relativePath).replaceAll(/[\r\n"]/g, "_");
    return reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="source"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .send(deps.objectStore.createDecryptionStream(original.storagePath, original.encryptionContext));
  });
}
