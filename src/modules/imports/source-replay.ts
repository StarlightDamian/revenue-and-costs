import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../db/pool.js";
import { MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_BATCH_FILES } from "../../shared/upload-limits.js";
import { readEffectiveShopAccess } from "../authorization/shop-access.js";
import type { EncryptedObjectStore } from "../storage/encrypted-object-store.js";
import { confirmImportBatch } from "./postgres-service.js";
import {
  inheritSourceReplayHardAcknowledgements,
  sourceReplayClosureHash,
  type InheritedSourceReplayAcknowledgements,
  type SourceReplayClosureRow,
} from "./source-replay-contract.js";

export { inheritSourceReplayHardAcknowledgements };
export type { InheritedSourceReplayAcknowledgements };

const REPLAY_KEY_PREFIX = "admin-source-replay:";

interface CurrentSourceBindingRow extends SourceReplayClosureRow {
  readonly relative_path: string;
  readonly classification: string;
  readonly parse_status: string;
  readonly detected_encoding: string | null;
  readonly detected_delimiter: string | null;
  readonly header_line_number: string | null;
  readonly binding_mapping_version_id: string;
  readonly mapping_report_kind: string;
  readonly file_sha256: string;
  readonly size_bytes: string;
  readonly object_kind: string;
  readonly owner_shop_id: string | null;
  readonly storage_path: string;
  readonly plaintext_size: string;
  readonly plaintext_sha256: string;
  readonly verification_status: string;
  readonly encryption_context: Record<string, string>;
  readonly content_type: string | null;
  readonly detected_kind: string | null;
}

interface ReplaySource {
  readonly storedObjectId: string;
  readonly relativePath: string;
  readonly classification: "SHIPMENT" | "TRANSACTION";
  readonly detectedEncoding: string | null;
  readonly detectedDelimiter: string | null;
  readonly headerLineNumber: string | null;
  readonly mappingVersionId: string;
  readonly sha256: string;
  readonly sizeBytes: string;
  readonly storagePath: string;
  readonly encryptionContext: Record<string, string>;
  readonly contentType: string | null;
  readonly detectedKind: string | null;
}

export interface ReplayCurrentShopSourcesInput {
  readonly shopId: string;
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface ReplayCurrentShopSourcesResult {
  readonly importBatchId: string;
  readonly uploadBatchId: string;
  readonly status: string;
  readonly sourceObjectCount: number;
  readonly replayed: boolean;
}

export interface SourceReplayDependencies {
  readonly objectStore: EncryptedObjectStore;
}

export interface ResumeFailedSourceReplayInput {
  readonly shopId: string;
  readonly batchId: string;
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
  readonly reason: string;
}

export interface ResumeFailedSourceReplayResult {
  readonly importBatchId: string;
  readonly status: string;
  readonly inheritedAcknowledgementCount: number;
  readonly resumed: boolean;
}

function requestHash(input: ReplayCurrentShopSourcesInput): string {
  return createHash("sha256").update(JSON.stringify({
    shopId: input.shopId,
    actorAccountId: input.actorAccountId,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })).digest("hex");
}

function normalizeInput(input: ReplayCurrentShopSourcesInput): ReplayCurrentShopSourcesInput {
  const idempotencyKey = input.idempotencyKey.trim();
  const reason = input.reason.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) throw new Error("SOURCE_REPLAY_IDEMPOTENCY_KEY_INVALID");
  if (!reason || reason.length > 1_000) throw new Error("SOURCE_REPLAY_REASON_INVALID");
  return { ...input, idempotencyKey, reason };
}

function normalizeResumeInput(input: ResumeFailedSourceReplayInput): ResumeFailedSourceReplayInput {
  const idempotencyKey = input.idempotencyKey.trim();
  const reason = input.reason.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) throw new Error("SOURCE_REPLAY_IDEMPOTENCY_KEY_INVALID");
  if (!reason || reason.length > 1_000) throw new Error("SOURCE_REPLAY_REASON_INVALID");
  return { ...input, idempotencyKey, reason };
}

function resumeRequestHash(input: ResumeFailedSourceReplayInput): string {
  return createHash("sha256").update(JSON.stringify({
    shopId: input.shopId,
    batchId: input.batchId,
    actorAccountId: input.actorAccountId,
    idempotencyKey: input.idempotencyKey,
    reason: input.reason,
  })).digest("hex");
}

async function assertSourceReadable(
  source: ReplaySource,
  objectStore: EncryptedObjectStore,
  verifyEncryption: boolean,
): Promise<void> {
  try {
    await access(source.storagePath, constants.R_OK);
  } catch (error) {
    throw new Error("SOURCE_REPLAY_OBJECT_UNREADABLE", { cause: error });
  }
  if (!verifyEncryption) return;
  const stream = objectStore.createDecryptionStream(source.storagePath, source.encryptionContext);
  let receivedPlaintext = false;
  try {
    for await (const chunk of stream) {
      receivedPlaintext = Buffer.byteLength(chunk) > 0;
      break;
    }
  } catch (error) {
    throw new Error("SOURCE_REPLAY_OBJECT_UNREADABLE", { cause: error });
  } finally {
    stream.destroy();
  }
  if (!receivedPlaintext && BigInt(source.sizeBytes) > 0n) throw new Error("SOURCE_REPLAY_OBJECT_UNREADABLE");
}

function sourceSignature(row: CurrentSourceBindingRow): string {
  return JSON.stringify({
    classification: row.classification,
    detectedEncoding: row.detected_encoding,
    detectedDelimiter: row.detected_delimiter,
    headerLineNumber: row.header_line_number,
    mappingVersionId: row.mapping_version_id,
  });
}

function validateAndDeduplicateSources(
  rows: readonly CurrentSourceBindingRow[],
  shopId: string,
): ReplaySource[] {
  if (rows.length === 0) throw new Error("SOURCE_REPLAY_CURRENT_BINDINGS_EMPTY");
  const byObject = new Map<string, { signature: string; source: ReplaySource }>();
  for (const row of rows) {
    if (
      row.parse_status !== "PARSED"
      || (row.classification !== "SHIPMENT" && row.classification !== "TRANSACTION")
      || row.report_kind !== row.classification
      || row.mapping_report_kind !== row.classification
      || !row.mapping_version_id
      || row.mapping_version_id !== row.binding_mapping_version_id
      || !row.stored_object_id
    ) {
      throw new Error("SOURCE_REPLAY_CURRENT_BINDING_INVALID");
    }
    if (
      row.object_kind !== "SOURCE"
      || row.owner_shop_id !== shopId
      || row.verification_status !== "LOCAL_VERIFIED"
      || row.size_bytes !== row.plaintext_size
      || row.file_sha256.toLowerCase() !== row.plaintext_sha256.toLowerCase()
    ) {
      throw new Error("SOURCE_REPLAY_OBJECT_INVALID");
    }
    const signature = sourceSignature(row);
    const existing = byObject.get(row.stored_object_id);
    if (existing && existing.signature !== signature) throw new Error("SOURCE_REPLAY_MAPPING_CONFLICT");
    if (!existing || row.relative_path.localeCompare(existing.source.relativePath) < 0) {
      byObject.set(row.stored_object_id, {
        signature,
        source: {
          storedObjectId: row.stored_object_id,
          relativePath: row.relative_path,
          classification: row.classification,
          detectedEncoding: row.detected_encoding,
          detectedDelimiter: row.detected_delimiter,
          headerLineNumber: row.header_line_number,
          mappingVersionId: row.mapping_version_id,
          sha256: row.file_sha256,
          sizeBytes: row.size_bytes,
          storagePath: row.storage_path,
          encryptionContext: row.encryption_context,
          contentType: row.content_type,
          detectedKind: row.detected_kind,
        },
      });
    }
  }
  let sources = [...byObject.values()].map((entry) => entry.source)
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath) || left.storedObjectId.localeCompare(right.storedObjectId));
  if (sources.length > MAX_UPLOAD_BATCH_FILES) throw new Error("SOURCE_REPLAY_FILE_LIMIT_EXCEEDED");
  const relativePaths = new Set(sources.map((source) => source.relativePath));
  if (relativePaths.size !== sources.length) {
    sources = sources.map((source, index) => {
      const suffix = source.relativePath.includes(".") ? source.relativePath.slice(source.relativePath.lastIndexOf(".")) : ".source";
      return { ...source, relativePath: `source-replay/${String(index + 1).padStart(5, "0")}-${source.storedObjectId}${suffix}` };
    });
  }
  const totalBytes = sources.reduce((sum, source) => sum + BigInt(source.sizeBytes), 0n);
  if (totalBytes > BigInt(MAX_UPLOAD_BATCH_BYTES)) throw new Error("SOURCE_REPLAY_BYTE_LIMIT_EXCEEDED");
  return sources;
}

async function findExistingReplay(
  client: PoolClient,
  input: ReplayCurrentShopSourcesInput,
  internalKey: string,
  hash: string,
): Promise<ReplayCurrentShopSourcesResult | null> {
  const existing = await client.query<{
    id: string;
    upload_batch_id: string;
    status: string;
    actor_account_id: string | null;
    reason: string | null;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT batch.id,batch.upload_batch_id,batch.status,audit.actor_account_id,audit.reason,audit.metadata
       FROM import_batch batch
       LEFT JOIN LATERAL (
         SELECT event.actor_account_id,event.reason,event.metadata
           FROM audit_event event
          WHERE event.action='ADMIN_SOURCE_REPLAY_CREATED'
            AND event.object_type='import_batch' AND event.object_id=batch.id
          ORDER BY event.occurred_at,event.id LIMIT 1
       ) audit ON true
      WHERE batch.shop_id=$1 AND batch.idempotency_key=$2`,
    [input.shopId, internalKey],
  );
  const row = existing.rows[0];
  if (!row) return null;
  if (
    row.actor_account_id !== input.actorAccountId
    || row.reason !== input.reason
    || row.metadata?.requestHash !== hash
  ) {
    throw new Error("SOURCE_REPLAY_IDEMPOTENCY_CONFLICT");
  }
  const sourceObjectCount = row.metadata.sourceObjectCount;
  if (typeof sourceObjectCount !== "number" || !Number.isSafeInteger(sourceObjectCount) || sourceObjectCount < 1) {
    throw new Error("SOURCE_REPLAY_IDEMPOTENCY_RECORD_INVALID");
  }
  return {
    importBatchId: row.id,
    uploadBatchId: row.upload_batch_id,
    status: row.status,
    sourceObjectCount,
    replayed: true,
  };
}

async function assertOperatorAndShop(
  client: PoolClient,
  input: Pick<ReplayCurrentShopSourcesInput, "shopId" | "actorAccountId">,
): Promise<void> {
  const actor = await client.query<{ status: string }>(
    "SELECT status FROM account WHERE id=$1 FOR SHARE",
    [input.actorAccountId],
  );
  const administrator = actor.rows[0]?.status === "ACTIVE"
    ? await client.query<{ authorized: boolean }>(
      "SELECT true authorized FROM account_role WHERE account_id=$1 AND role='ADMIN' FOR SHARE",
      [input.actorAccountId],
    )
    : { rows: [] };
  if (actor.rows[0]?.status !== "ACTIVE" || administrator.rows[0]?.authorized !== true) {
    throw new Error("SOURCE_REPLAY_ADMIN_REQUIRED");
  }
  const shop = await readEffectiveShopAccess(client, input.shopId, input.actorAccountId, { forUpdate: true });
  if (shop?.status !== "ACTIVE") throw new Error("SOURCE_REPLAY_SHOP_NOT_ACTIVE");
}

async function assertShopIdle(client: PoolClient, shopId: string): Promise<void> {
  const activeImport = await client.query<{ id: string }>(
    `SELECT id FROM import_batch
      WHERE shop_id=$1 AND status NOT IN ('RESULT_PUBLISHED','CANCELLED','FAILED')
      ORDER BY created_at,id LIMIT 1`,
    [shopId],
  );
  if (activeImport.rows[0]) throw new Error("SOURCE_REPLAY_IMPORT_IN_PROGRESS");
  const activeCalculation = await client.query<{ id: string }>(
    `SELECT run.id FROM calculation_run run
      WHERE run.shop_id=$1 AND (
        run.status IN ('QUEUED','RUNNING','BLOCKED')
        OR (run.status='READY' AND NOT EXISTS (
          SELECT 1 FROM published_snapshot snapshot WHERE snapshot.calculation_run_id=run.id
        ))
      ) ORDER BY run.created_at,run.id LIMIT 1`,
    [shopId],
  );
  if (activeCalculation.rows[0]) throw new Error("SOURCE_REPLAY_CALCULATION_IN_PROGRESS");
}

async function assertOperatorAndShopIdle(client: PoolClient, input: ReplayCurrentShopSourcesInput): Promise<void> {
  await assertOperatorAndShop(client, input);
  await assertShopIdle(client, input.shopId);
}

async function loadCurrentSourceBindings(client: PoolClient, shopId: string): Promise<CurrentSourceBindingRow[]> {
  const result = await client.query<CurrentSourceBindingRow>(
    `SELECT version.id AS dataset_version_id,binding.report_kind,file.id AS import_file_id,
            file.stored_object_id,file.relative_path,file.classification,file.parse_status,
            file.detected_encoding,file.detected_delimiter,file.header_line_number::text,
            file.mapping_version_id,binding.mapping_version_id AS binding_mapping_version_id,
            mapping.report_kind AS mapping_report_kind,encode(file.sha256,'hex') AS file_sha256,
            file.size_bytes::text,object.object_kind,object.owner_shop_id,object.storage_path,
            object.plaintext_size::text,object.plaintext_sha256,object.verification_status,
            object.encryption_context,
            upload.content_type,upload.detected_kind
       FROM dataset_slice slice
       JOIN dataset_version version ON version.id=slice.current_version_id
       JOIN dataset_source_binding binding ON binding.dataset_version_id=version.id
       JOIN import_file file ON file.id=binding.import_file_id
       JOIN stored_object object ON object.id=file.stored_object_id
       JOIN field_mapping_version mapping_version ON mapping_version.id=file.mapping_version_id
       JOIN field_mapping mapping ON mapping.id=mapping_version.field_mapping_id
       LEFT JOIN LATERAL (
         SELECT candidate.content_type,candidate.detected_kind
           FROM import_batch source_batch
           JOIN upload_file candidate ON candidate.batch_id=source_batch.upload_batch_id
          WHERE source_batch.id=file.import_batch_id
            AND candidate.stored_object_id=file.stored_object_id
          ORDER BY candidate.created_at DESC,candidate.id DESC LIMIT 1
       ) upload ON true
      WHERE slice.shop_id=$1
      ORDER BY object.id,file.id,binding.id`,
    [shopId],
  );
  return result.rows;
}

async function insertReplayFiles(
  client: PoolClient,
  uploadBatchId: string,
  importBatchId: string,
  sources: readonly ReplaySource[],
): Promise<void> {
  const payload = sources.map((source) => ({
    stored_object_id: source.storedObjectId,
    relative_path: source.relativePath,
    classification: source.classification,
    detected_encoding: source.detectedEncoding,
    detected_delimiter: source.detectedDelimiter,
    header_line_number: source.headerLineNumber,
    mapping_version_id: source.mappingVersionId,
    sha256: source.sha256,
    size_bytes: source.sizeBytes,
    content_type: source.contentType,
    detected_kind: source.detectedKind,
  }));
  await client.query(
    `INSERT INTO upload_file(
       id,batch_id,relative_path,declared_size,received_size,content_type,plaintext_sha256,
       status,temp_path,stored_object_id,detected_kind
     )
     SELECT gen_random_uuid(),$1::uuid,source.relative_path,source.size_bytes,source.size_bytes,
            source.content_type,source.sha256,'STORED','<immutable-source-replay>',source.stored_object_id,source.detected_kind
       FROM jsonb_to_recordset($2::jsonb) AS source(
         stored_object_id uuid,relative_path text,size_bytes bigint,content_type text,sha256 text,detected_kind text
       )`,
    [uploadBatchId, JSON.stringify(payload)],
  );
  await client.query(
    `INSERT INTO import_file(
       id,import_batch_id,stored_object_id,relative_path,classification,parse_status,
       detected_encoding,detected_delimiter,header_line_number,mapping_version_id,sha256,size_bytes
     )
     SELECT gen_random_uuid(),$1::uuid,source.stored_object_id,source.relative_path,source.classification,'PARSED',
            source.detected_encoding,source.detected_delimiter,source.header_line_number,source.mapping_version_id,
            decode(source.sha256,'hex'),source.size_bytes
       FROM jsonb_to_recordset($2::jsonb) AS source(
         stored_object_id uuid,relative_path text,classification text,detected_encoding text,
         detected_delimiter text,header_line_number bigint,mapping_version_id uuid,sha256 text,size_bytes bigint
       )`,
    [importBatchId, JSON.stringify(payload)],
  );
}

export async function replayCurrentShopSources(
  pool: Pool,
  rawInput: ReplayCurrentShopSourcesInput,
  dependencies: SourceReplayDependencies,
): Promise<ReplayCurrentShopSourcesResult> {
  const input = normalizeInput(rawInput);
  const internalKey = `${REPLAY_KEY_PREFIX}${input.idempotencyKey}`;
  const hash = requestHash(input);
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([input.shopId, internalKey])]);
    const existing = await findExistingReplay(client, input, internalKey, hash);
    if (existing) {
      await assertOperatorAndShop(client, input);
      return existing;
    }
    await assertOperatorAndShopIdle(client, input);
    const rows = await loadCurrentSourceBindings(client, input.shopId);
    const sourceClosureHash = sourceReplayClosureHash(rows);
    const sources = validateAndDeduplicateSources(rows, input.shopId);
    for (const [index, source] of sources.entries()) {
      await assertSourceReadable(source, dependencies.objectStore, index === 0);
    }

    const uploadBatchId = randomUUID();
    const importBatchId = randomUUID();
    const totalBytes = sources.reduce((sum, source) => sum + BigInt(source.sizeBytes), 0n);
    const versionCount = new Set(rows.map((row) => row.dataset_version_id)).size;
    await client.query(
      `INSERT INTO upload_batch(
         id,shop_id,created_by,status,declared_bytes,received_bytes,file_count,expires_at
       ) VALUES($1,$2,$3,'READY',$4,$4,$5,clock_timestamp()+interval '7 days')`,
      [uploadBatchId, input.shopId, input.actorAccountId, totalBytes.toString(), sources.length],
    );
    await client.query(
      `INSERT INTO import_batch(
         id,shop_id,upload_batch_id,status,current_stage,idempotency_key,created_by
       ) VALUES($1,$2,$3,'COMMITTING','COPY',$4,$5)`,
      [importBatchId, input.shopId, uploadBatchId, internalKey, input.actorAccountId],
    );
    await insertReplayFiles(client, uploadBatchId, importBatchId, sources);
    await client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
       VALUES($1,'ADMIN_SOURCE_REPLAY_CREATED','import_batch',$2,$3,$4::jsonb)`,
      [input.actorAccountId, importBatchId, input.reason, JSON.stringify({
        requestHash: hash,
        shopId: input.shopId,
        uploadBatchId,
        sourceMode: "CURRENT_BINDING_CLOSURE",
        completenessRuleVersion: "shipment-only-v1",
        sourceDatasetVersionCount: versionCount,
        sourceObjectCount: sources.length,
        sourceClosureHash,
      })],
    );
    await client.query(
      `INSERT INTO outbox_event(id,topic,business_key,payload)
       VALUES($1,'import.commit',$2,$3::jsonb)`,
      [randomUUID(), `source-replay:${importBatchId}`, JSON.stringify({
        batchId: importBatchId,
        shopId: input.shopId,
        actorAccountId: input.actorAccountId,
      })],
    );
    await client.query(
      "UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1",
      [input.shopId, input.actorAccountId],
    );
    return {
      importBatchId,
      uploadBatchId,
      status: "COMMITTING",
      sourceObjectCount: sources.length,
      replayed: false,
    };
  });
}

export async function resumeFailedSourceReplay(
  pool: Pool,
  rawInput: ResumeFailedSourceReplayInput,
): Promise<ResumeFailedSourceReplayResult> {
  const input = normalizeResumeInput(rawInput);
  const hash = resumeRequestHash(input);
  return withTransaction(pool, async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
      [JSON.stringify([input.shopId, input.batchId, "source-replay-resume"])],
    );
    await assertOperatorAndShop(client, input);
    const batch = await client.query<{
      status: string;
      current_stage: string;
      failure_code: string | null;
      source_replay_created: boolean;
      resume_request_hash: string | null;
      inherited_count: number | null;
    }>(
      `SELECT batch.status,batch.current_stage,batch.failure_code,
              EXISTS (
                SELECT 1 FROM audit_event created
                 WHERE created.object_type='import_batch' AND created.object_id=batch.id
                   AND created.action='ADMIN_SOURCE_REPLAY_CREATED'
                   AND created.actor_account_id=batch.created_by
                   AND created.metadata->>'shopId'=batch.shop_id::text
                   AND created.metadata->>'sourceMode'='CURRENT_BINDING_CLOSURE'
                   AND created.metadata->>'completenessRuleVersion'='shipment-only-v1'
              ) source_replay_created,
              resumed.metadata->>'requestHash' resume_request_hash,
              CASE WHEN resumed.metadata ? 'inheritedAcknowledgementCount'
                   THEN (resumed.metadata->>'inheritedAcknowledgementCount')::integer END inherited_count
         FROM import_batch batch
         LEFT JOIN LATERAL (
           SELECT event.metadata
             FROM audit_event event
            WHERE event.object_type='import_batch' AND event.object_id=batch.id
              AND event.action='ADMIN_SOURCE_REPLAY_RESUMED'
            ORDER BY event.occurred_at DESC,event.id DESC LIMIT 1
         ) resumed ON true
        WHERE batch.id=$1 AND batch.shop_id=$2
          AND batch.idempotency_key LIKE 'admin-source-replay:%'
        FOR UPDATE OF batch`,
      [input.batchId, input.shopId],
    );
    const row = batch.rows[0];
    if (!row) throw new Error("SOURCE_REPLAY_BATCH_NOT_FOUND");
    if (!row.source_replay_created) throw new Error("SOURCE_REPLAY_BATCH_NOT_ELIGIBLE");
    const completed = [
      "COMMITTED_WITH_EXCLUSIONS", "CALCULATING", "READY_FOR_REVIEW",
      "RESULT_PUBLISHING", "RESULT_PUBLISHED",
    ].includes(row.status);
    if (completed) {
      if (row.resume_request_hash !== hash) throw new Error("SOURCE_REPLAY_RESUME_IDEMPOTENCY_CONFLICT");
      return {
        importBatchId: input.batchId,
        status: row.status,
        inheritedAcknowledgementCount: row.inherited_count ?? 0,
        resumed: true,
      };
    }
    if (
      row.status !== "FAILED"
      || row.current_stage !== "CALCULATION_REQUEST_BLOCKED"
      || row.failure_code !== "HARD_INCOMPLETE_CONFIRMATION_REQUIRED"
    ) {
      throw new Error("SOURCE_REPLAY_BATCH_NOT_AWAITING_CONFIRMATION");
    }
    if (row.resume_request_hash && row.resume_request_hash !== hash) {
      throw new Error("SOURCE_REPLAY_RESUME_IDEMPOTENCY_CONFLICT");
    }
    await assertShopIdle(client, input.shopId);
    await client.query("SELECT id FROM dataset_slice WHERE shop_id=$1 ORDER BY id FOR UPDATE", [input.shopId]);
    const versionState = await client.query<{
      total_count: string;
      current_count: string;
      later_current_count: string;
    }>(
      `SELECT count(*)::text total_count,
              count(*) FILTER (WHERE slice.current_version_id=version.id)::text current_count,
              (SELECT count(*)::text
                 FROM dataset_slice later_slice
                 JOIN dataset_version later_version ON later_version.id=later_slice.current_version_id
                 JOIN import_batch later_batch ON later_batch.id=later_version.import_batch_id
                 JOIN import_batch target_batch ON target_batch.id=$1
                WHERE later_slice.shop_id=$2
                  AND later_version.import_batch_id<>$1
                  AND (later_batch.created_at,later_batch.id)>(target_batch.created_at,target_batch.id)
              ) later_current_count
         FROM dataset_version version
         JOIN dataset_slice slice ON slice.id=version.dataset_slice_id
        WHERE version.import_batch_id=$1 AND slice.shop_id=$2`,
      [input.batchId, input.shopId],
    );
    const totalVersions = BigInt(versionState.rows[0]?.total_count ?? "0");
    const currentVersions = BigInt(versionState.rows[0]?.current_count ?? "0");
    const laterCurrentVersions = BigInt(versionState.rows[0]?.later_current_count ?? "0");
    if (totalVersions === 0n || currentVersions !== totalVersions || laterCurrentVersions !== 0n) {
      throw new Error("SOURCE_REPLAY_CURRENT_VERSION_CHANGED");
    }
    const inherited = await inheritSourceReplayHardAcknowledgements(client, input.batchId, input.actorAccountId);
    const confirmed = await confirmImportBatch(client, input.shopId, input.batchId, {
      actorAccountId: input.actorAccountId,
      idempotencyKey: input.idempotencyKey,
    });
    if (confirmed.status !== "COMMITTED_WITH_EXCLUSIONS") {
      throw new Error("SOURCE_REPLAY_RESUME_STATUS_INVALID");
    }
    await client.query(
      `INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata)
       SELECT $1,'ADMIN_SOURCE_REPLAY_RESUMED','import_batch',$2,$3,$4::jsonb
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_event event
           WHERE event.object_type='import_batch' AND event.object_id=$2
             AND event.action='ADMIN_SOURCE_REPLAY_RESUMED'
        )`,
      [input.actorAccountId, input.batchId, input.reason, JSON.stringify({
        requestHash: hash,
        shopId: input.shopId,
        inheritedAcknowledgementCount: inherited.acknowledgementIds.length,
        inheritedAcknowledgementIds: inherited.acknowledgementIds,
      })],
    );
    return {
      importBatchId: input.batchId,
      status: confirmed.status,
      inheritedAcknowledgementCount: inherited.acknowledgementIds.length,
      resumed: false,
    };
  });
}
