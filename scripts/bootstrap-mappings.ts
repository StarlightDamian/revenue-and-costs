import { createHash, randomUUID } from "node:crypto";
import { createPool } from "../src/db/pool.js";
import { withTransaction } from "../src/db/pool.js";
import { builtinShipmentMapping, builtinTransactionMapping } from "../src/modules/mappings/builtin.js";
import { refreshUploadPreflight } from "../src/modules/uploads/partial-failure.js";
import { validateMappingDefinition } from "../src/modules/mappings/validate.js";
import { loadConfig } from "../src/shared/config.js";

const definitions = [builtinTransactionMapping, builtinShipmentMapping] as const;

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  for (const definition of definitions) validateMappingDefinition(definition);
  const result = await withTransaction(pool, async (client) => {
    const admin = await client.query<{ actor_id: string | null }>(
      `SELECT COALESCE(completed_by,(
         SELECT a.id FROM account a JOIN account_role role ON role.account_id=a.id
          WHERE role.role='ADMIN' AND a.status='ACTIVE' ORDER BY a.created_at,a.id LIMIT 1
       )) AS actor_id
       FROM identity_bootstrap WHERE singleton=true`,
    );
    const actor = admin.rows[0]?.actor_id;
    if (!actor) return { inserted: 0, requeued: 0, skipped: true };
    let count = 0;
    const revisionParts: string[] = [];
    for (const definition of definitions) {
      const mapping = await client.query<{ id: string }>(
        `INSERT INTO field_mapping (report_kind, locale, name) VALUES ($1,$2,$3)
         ON CONFLICT (report_kind, locale, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [definition.reportKind, definition.locale, `${definition.reportKind} 样例结构`],
      );
      const mappingId = mapping.rows[0]?.id;
      if (!mappingId) throw new Error("MAPPING_CREATE_FAILED");
      const json = JSON.stringify(definition);
      const digest = createHash("sha256").update(json).digest();
      revisionParts.push(digest.toString("hex"));
      const result = await client.query(
        `INSERT INTO field_mapping_version (field_mapping_id, version_no, definition, definition_sha256, created_by, reason)
         SELECT $1, COALESCE(max(version_no),0)+1, $2::jsonb, $3, $4, '依据只读业务样例确认的精确表头映射'
           FROM field_mapping_version WHERE field_mapping_id = $1
         ON CONFLICT (field_mapping_id, definition_sha256) DO NOTHING`,
        [mappingId, json, digest, actor],
      );
      count += result.rowCount ?? 0;
    }
    await client.query(
      `INSERT INTO marketplace_policy_version
        (marketplace, normalized_marketplace, iana_timezone, marketplace_size, effective_from, created_by, reason)
       VALUES ('UNKNOWN','UNKNOWN','UTC','LARGE','2000-01-01T00:00:00Z',$1,'未知站点安全默认：按大站点并采用 UTC，待管理员创建明确版本')
       ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING`,
      [actor],
    );
    const mappingRevision = createHash("sha256").update(revisionParts.sort().join(":"), "utf8").digest("hex");
    const awaiting = count > 0
      ? await client.query<{ import_file_id: string; upload_file_id: string; import_batch_id: string }>(
        `SELECT f.id AS import_file_id,uf.id AS upload_file_id,f.import_batch_id
           FROM import_file f
           JOIN import_batch ib ON ib.id=f.import_batch_id
           JOIN upload_file uf ON uf.batch_id=ib.upload_batch_id AND uf.stored_object_id=f.stored_object_id
          WHERE f.parse_status='AWAITING_MAPPING'
            AND ib.status IN ('AWAITING_MAPPING','FAILED')
          FOR UPDATE OF f,ib`,
      )
      : { rows: [] };
    for (const row of awaiting.rows) {
      await client.query(
        `UPDATE import_file SET parse_status='PENDING',classification='UNKNOWN',detected_encoding=NULL,
           detected_delimiter=NULL,header_line_number=NULL,mapping_version_id=NULL
         WHERE id=$1`,
        [row.import_file_id],
      );
      await client.query(
        `INSERT INTO outbox_event(id,topic,business_key,payload)
         VALUES($1,'import.analyze',$2,$3::jsonb)
         ON CONFLICT(topic,business_key) DO NOTHING`,
        [randomUUID(), `mapping-bootstrap:${mappingRevision}:${row.import_file_id}`, JSON.stringify({ fileId: row.upload_file_id })],
      );
    }
    const missingAnalysis = await client.query<{ upload_file_id: string; import_batch_id: string }>(
      `SELECT uf.id AS upload_file_id,ib.id AS import_batch_id
         FROM upload_file uf
         JOIN import_batch ib ON ib.upload_batch_id=uf.batch_id
        WHERE uf.status='STORED' AND NOT uf.metadata_only AND uf.stored_object_id IS NOT NULL
          AND (ib.status IN ('UPLOADING','ANALYZING','AWAITING_FILES','AWAITING_MAPPING','AWAITING_COMMIT_CONFIRMATION')
               OR (ib.status='FAILED' AND ib.failure_code='NO_USABLE_UPLOAD_FILES'))
          AND NOT EXISTS (
            SELECT 1 FROM import_file f
             WHERE f.import_batch_id=ib.id AND f.stored_object_id=uf.stored_object_id
          )
        FOR UPDATE OF uf,ib`,
    );
    for (const row of missingAnalysis.rows) {
      await client.query(
        `INSERT INTO outbox_event(id,topic,business_key,payload)
         VALUES($1,'import.analyze',$2,$3::jsonb)
         ON CONFLICT(topic,business_key) DO NOTHING`,
        [randomUUID(), `preflight-recovery:${row.upload_file_id}`, JSON.stringify({ fileId: row.upload_file_id })],
      );
    }
    const recoveredBatchIds = [...new Set([
      ...awaiting.rows.map((row) => row.import_batch_id),
      ...missingAnalysis.rows.map((row) => row.import_batch_id),
    ])];
    if (recoveredBatchIds.length > 0) {
      await client.query(
        `UPDATE import_batch SET status='ANALYZING',current_stage='PREFLIGHT',failure_code=NULL,updated_at=clock_timestamp()
          WHERE id=ANY($1::uuid[])`,
        [recoveredBatchIds],
      );
    }
    const candidates = await client.query<{ id: string; upload_batch_id: string }>(
      `SELECT ib.id,ib.upload_batch_id
         FROM import_batch ib
         JOIN upload_batch ub ON ub.id=ib.upload_batch_id
        WHERE ub.status='READY'
          AND ib.status IN ('UPLOADING','ANALYZING','AWAITING_FILES','AWAITING_MAPPING','AWAITING_COMMIT_CONFIRMATION')
        ORDER BY ib.created_at,ib.id
        FOR UPDATE OF ib`,
    );
    let projected = 0;
    for (const batch of candidates.rows) {
      const projection = await refreshUploadPreflight(client, batch.upload_batch_id, batch.id);
      if (projection.status !== "ANALYZING") projected += 1;
    }
    return {
      inserted: count,
      requeued: awaiting.rows.length + missingAnalysis.rows.length,
      projected,
      skipped: false,
    };
  });
  if (result.skipped) {
    process.stdout.write("尚未初始化首位管理员，暂不创建内置映射；管理员初始化后再次启动会自动补齐。\n");
  } else {
    process.stdout.write(`已确保内置精确映射存在：新增 ${result.inserted}，恢复预检文件 ${result.requeued}，收敛批次 ${result.projected}\n`);
  }
} finally {
  await pool.end();
}
