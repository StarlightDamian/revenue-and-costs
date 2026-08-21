import { Readable } from "node:stream";
import { basename } from "node:path";
import { createGzip } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { Type } from "@sinclair/typebox";
import type { Actor } from "../../modules/authorization";
import type { EncryptedObjectStore } from "../../modules/storage/encrypted-object-store";
import { MAX_CHUNK_BYTES, MAX_UPLOAD_FILES, type UploadService } from "../../modules/uploads/service";
import { CLIENT_UPLOAD_FAILURE_CODES, type ClientUploadFailureCode } from "../../modules/uploads/partial-failure.js";
import { parseAccountingPeriodScope } from "../../shared/accounting-period.js";
import { UuidSchema } from "../../shared/contracts.js";
import { AppError } from "../../shared/errors.js";
import { requireIdempotencyKey } from "../idempotency.js";

export interface UploadRouteDependencies {
  service: UploadService;
  objectStore: EncryptedObjectStore;
  authorize: (request: unknown, shopId: string, action: "upload" | "offset" | "original", reason?: string) => Promise<Actor>;
  auditOriginalDownload: (actor: Actor, fileId: string, reason?: string) => Promise<void>;
}

const UploadByteCount = Type.String({ pattern: "^(?:0|[1-9][0-9]{0,9})$" });
const UploadRegistrationFile = Type.Object({
  relativePath: Type.String({ minLength: 1, maxLength: 1024 }),
  declaredSize: UploadByteCount,
  contentType: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  metadataOnly: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });
const CreateBatchBody = Type.Object({
  shopId: UuidSchema,
  periodStart: Type.Optional(Type.String({ pattern: "^(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])$" })),
  periodEnd: Type.Optional(Type.String({ pattern: "^(?:19|20|21)[0-9]{2}-(?:0[1-9]|1[0-2])$" })),
  fileCount: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_UPLOAD_FILES })),
  files: Type.Optional(Type.Array(UploadRegistrationFile, { minItems: 1, maxItems: MAX_UPLOAD_FILES })),
}, { additionalProperties: false });
const BatchParams = Type.Object({ batchId: UuidSchema });
const RemoveFilesBody = Type.Object({
  fileIds: Type.Array(UuidSchema, { minItems: 1, maxItems: MAX_UPLOAD_FILES, uniqueItems: true }),
}, { additionalProperties: false });
const FileParams = Type.Object({ fileId: UuidSchema });
const OriginalDownloadQuery = Type.Object({ token: Type.String({ pattern: "^[A-Za-z0-9_-]{43}$" }) });
const ChunkHeaders = Type.Object({
  "upload-offset": UploadByteCount,
  "content-length": Type.String({ pattern: "^(?:0|[1-9][0-9]{0,7})$" }),
  "upload-content-encoding": Type.Optional(Type.Literal("gzip")),
  "upload-uncompressed-length": Type.Optional(UploadByteCount),
});

function acceptsGzip(value: string | string[] | undefined): boolean {
  return String(value ?? "").split(",").some((item) => {
    const [coding, ...parameters] = item.trim().toLowerCase().split(";");
    return coding === "gzip" && !parameters.some((parameter) => /^q=0(?:\.0*)?$/u.test(parameter.trim()));
  });
}

export async function registerUploadRoutes(app: FastifyInstance, deps: UploadRouteDependencies): Promise<void> {
  app.addContentTypeParser("application/offset+octet-stream", (_request, payload, done) => done(null, payload));
  app.post("/api/v1/uploads/batches", {
    // 20k entries at the 1024-byte path and 255-byte content-type limits fit,
    // including JSON escaping, while the request remains explicitly bounded.
    bodyLimit: 64 * 1024 * 1024,
    schema: { body: CreateBatchBody },
  }, async (request) => {
    const body = request.body as { shopId: string; periodStart?: string; periodEnd?: string; fileCount?: number; files?: Array<{ relativePath: string; declaredSize: string; contentType?: string; metadataOnly?: boolean }> };
    if ((body.files === undefined) !== (body.fileCount === undefined)
      || (body.files !== undefined && body.fileCount !== body.files.length)) {
      throw new AppError("UPLOAD_FILE_COUNT_MISMATCH", "文件数量与请求声明不一致", 400);
    }
    const accountingPeriod = parseAccountingPeriodScope({
      ...(body.periodStart ? { periodStart: body.periodStart } : {}),
      ...(body.periodEnd ? { periodEnd: body.periodEnd } : {}),
    });
    const actor = await deps.authorize(request, body.shopId, "upload");
    const key = requireIdempotencyKey(request);
    if (body.files) {
      return deps.service.createBatchWithFiles(body.shopId, actor.accountId, key, body.files.map((file) => ({
        relativePath: file.relativePath,
        declaredSize: BigInt(file.declaredSize),
        ...(file.contentType ? { contentType: file.contentType } : {}),
        ...(file.metadataOnly ? { metadataOnly: true } : {}),
      })), accountingPeriod);
    }
    return { id: await deps.service.createBatch(body.shopId, actor.accountId, key, accountingPeriod) };
  });
  app.post("/api/v1/uploads/batches/:batchId/files", { schema: { params: BatchParams, body: UploadRegistrationFile } }, async (request, reply) => {
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
    const wireLength = Number(request.headers["content-length"] ?? -1);
    const contentEncoding = request.headers["upload-content-encoding"] === "gzip" ? "gzip" : undefined;
    const uncompressedHeader = request.headers["upload-uncompressed-length"];
    if ((contentEncoding && uncompressedHeader === undefined) || (!contentEncoding && uncompressedHeader !== undefined)) {
      throw new AppError("UPLOAD_ENCODING_HEADERS_INVALID", "上传压缩请求头不完整", 400);
    }
    const length = contentEncoding ? Number(uncompressedHeader) : wireLength;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CHUNK_BYTES) {
      throw new AppError("UPLOAD_CHUNK_SIZE_LIMIT", "上传分片超出限额", 413);
    }
    const body = request.body;
    if (!(body instanceof Readable)) throw new Error("UPLOAD_BODY_STREAM_REQUIRED");
    const next = await deps.service.appendChunk({ fileId, expectedOffset: offset, expectedSha256: checksum, length, ...(contentEncoding ? { contentEncoding } : {}), body });
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
  app.post<{ Params: { batchId: string }; Body: { fileIds: string[] } }>("/api/v1/uploads/batches/:batchId/remove-files", {
    schema: { params: BatchParams, body: RemoveFilesBody },
  }, async (request) => {
    const shopId = await deps.service.resolveBatchShop(request.params.batchId);
    const actor = await deps.authorize(request, shopId, "upload");
    return deps.service.removeFiles(request.params.batchId, request.body.fileIds, actor.accountId);
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
    const stream = deps.objectStore.createDecryptionStream(original.storagePath, original.encryptionContext);
    const gzip = /\.(?:csv|txt)$/iu.test(original.relativePath) && acceptsGzip(request.headers["accept-encoding"]);
    const response = reply
      .header("Content-Type", "application/octet-stream")
      .header("Content-Disposition", `attachment; filename="source"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
      .header("Cache-Control", "private, no-store, max-age=0")
      .header("Pragma", "no-cache")
      .header("X-Accel-Buffering", "no");
    if (gzip) {
      return response.header("Content-Encoding", "gzip").header("Vary", "Accept-Encoding").send(stream.pipe(createGzip({ level: 1 })));
    }
    return response.header("Content-Length", original.plaintextSize).send(stream);
  });
}
