import { createHash, randomUUID } from "node:crypto";
import type { TransactionRunner, SqlClient } from "../authorization/index.js";
import { INTERMEDIATE_REPORT_COLUMNS } from "../../shared/intermediate-report.js";

const RETRYABLE_COMMIT_FAILURES = new Set([
  "IMPORT_DATABASE_CAPACITY_UNAVAILABLE",
  "IMPORT_DATABASE_CAPACITY_INSUFFICIENT",
]);

const importFieldNames = new Map<string, string>([
  ["total", "总金额"],
  ["quantity", "数量"],
  ...Object.values(INTERMEDIATE_REPORT_COLUMNS).flat().map((column) => [
    column.key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`),
    column.header,
  ] as const),
]);

export function describeImportIssue(code: string, count: number, fieldName: string | null, exactCount = true): { message: string; action: string } {
  const field = fieldName ? `（${importFieldNames.get(fieldName) ?? "某个金额"}列）` : "";
  const messages: Record<string, [string, string]> = {
    AWAITING_MAPPING: ["系统看不懂这个表格，每一列代表什么还不清楚", "这个文件暂时不会用于计算。请联系管理员确认表格每一列代表什么，然后重新上传。"],
    UNKNOWN_STRUCTURE_EXCLUDED: ["系统看不懂这个表格，每一列代表什么还不清楚", "这个文件没有用于计算。请联系管理员确认表格每一列代表什么，然后重新上传。"],
    DUPLICATE_SOURCE: ["这个文件之前已经上传过", "系统没有重复保存，也不会重复计算，不需要处理。"],
    IMPORT_FINANCIAL_VALUE_REQUIRED: [`有一行没有填写计算所需的金额或数量${field}`, "请补充空白单元格后重新上传。这一行目前没有用于计算。"],
    IMPORT_FINANCIAL_VALUE_INVALID: [`有一行的金额不是系统能识别的数字${field}`, "请把金额改成普通数字，例如 1234.56，然后重新上传。这一行目前没有用于计算。"],
    IMPORT_UNKNOWN_MARKETPLACE: ["有一行的销售站点无法识别", "请填写明确的 Amazon 站点名称。如果是交易报告，同一个文件内只保留一个站点，然后重新上传。这一行目前没有用于计算。"],
    IMPORT_REPORT_DATE_INVALID: ["有一行的日期无法识别", "请把日期改成表格中其他日期使用的格式，然后重新上传。这一行目前没有用于计算。"],
    NO_USABLE_UPLOAD_FILES: ["没有可用于计算的文件", "请补充交易报告或配送货件后重新上传。"],
  };
  const known = messages[code];
  return {
    message: known?.[0] ?? "系统发现一个暂时无法自动说明的问题",
    action: `${known?.[1] ?? "这个文件暂时不会用于计算。请检查文件内容；如果仍不知道怎么处理，请联系管理员。"}${count > 1 ? exactCount ? ` 共 ${count} 条。` : ` 已记录 ${count} 条示例。` : ""}`,
  };
}

export interface ConfirmImportBatchInput {
  readonly actorAccountId: string;
  readonly idempotencyKey: string;
}

export async function confirmImportBatch(
  client: SqlClient,
  shopId: string,
  batchId: string,
  input: ConfirmImportBatchInput,
) {
  const batch = await client.query<{ status: string; failure_code: string | null }>(
    "SELECT status,failure_code FROM import_batch WHERE id=$1 AND shop_id=$2 FOR UPDATE",
    [batchId, shopId],
  );
  const status = batch.rows[0]?.status;
  if (!status) throw new Error("IMPORT_BATCH_NOT_FOUND");
  if ([
    "COMMITTING", "COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING",
    "READY_FOR_REVIEW", "RESULT_PUBLISHING", "RESULT_PUBLISHED",
  ].includes(status)) return { id: batchId, status };
  const awaitingHardExclusion = status === "FAILED"
    && batch.rows[0]?.failure_code === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED";
  if (awaitingHardExclusion) {
    const pending = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM dataset_slice slice
         JOIN dataset_version version ON version.id=slice.current_version_id
        WHERE slice.shop_id=$1 AND version.status='INCOMPLETE'
          AND NOT EXISTS (
            SELECT 1 FROM quality_acknowledgement acknowledgement
             WHERE acknowledgement.dataset_version_id=version.id
               AND acknowledgement.calculation_run_id IS NULL
               AND acknowledgement.issue_kind='HARD_INCOMPLETE'
          )`,
      [shopId],
    );
    if (BigInt(pending.rows[0]?.count ?? "0") > 0n) throw new Error("HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
    await client.query(
      "UPDATE import_batch SET status='COMMITTED_WITH_EXCLUSIONS',current_stage='COMMITTED',failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1",
      [batchId],
    );
    await client.query(
      `INSERT INTO outbox_event (id,topic,business_key,payload) VALUES ($1,'calculation.requested',$2,$3::jsonb)
       ON CONFLICT (topic,business_key) DO NOTHING`,
      [randomUUID(), `resume:${batchId}:${input.idempotencyKey}`, JSON.stringify({ batchId, actorAccountId: input.actorAccountId })],
    );
    await client.query(
      `UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
      [shopId, input.actorAccountId],
    );
    return { id: batchId, status: "COMMITTED_WITH_EXCLUSIONS" };
  }
  const retryableFailure = status === "FAILED" && RETRYABLE_COMMIT_FAILURES.has(batch.rows[0]?.failure_code ?? "");
  if (status !== "AWAITING_COMMIT_CONFIRMATION" && !retryableFailure) throw new Error("IMPORT_BATCH_NOT_READY");
  await client.query(
    "UPDATE import_batch SET status='COMMITTING',current_stage='COPY',failure_code=NULL,updated_at=clock_timestamp() WHERE id=$1",
    [batchId],
  );
  await client.query(
    `INSERT INTO outbox_event (id,topic,business_key,payload) VALUES ($1,'import.commit',$2,$3::jsonb)
     ON CONFLICT (topic,business_key) DO NOTHING`,
    [randomUUID(), `${batchId}:${input.idempotencyKey}`, JSON.stringify({ batchId, shopId, actorAccountId: input.actorAccountId })],
  );
  await client.query(
    `UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
    [shopId, input.actorAccountId],
  );
  return { id: batchId, status: "COMMITTING" };
}

export class PostgresImportService {
  constructor(private readonly transactions: TransactionRunner, private readonly database: SqlClient) {}

  async getLatestBatch(shopId: string) {
    const latest = await this.database.query<{ id: string }>(
      `SELECT id FROM import_batch
        WHERE shop_id=$1 AND status<>'CANCELLED'
        ORDER BY created_at DESC,id DESC LIMIT 1`,
      [shopId],
    );
    const id = latest.rows[0]?.id;
    return id ? this.getBatch(shopId, id) : null;
  }

  async getBatch(shopId: string, batchId: string) {
    const batch = await this.database.query<{
      id: string; status: string; current_stage: string; failure_code: string | null;
      upload_batch_id: string; upload_ready: boolean;
    }>(
      `SELECT batch.id,batch.status,batch.current_stage,batch.failure_code,batch.upload_batch_id,
              NOT EXISTS (SELECT 1 FROM upload_file file
                WHERE file.batch_id=batch.upload_batch_id AND file.status IN ('PENDING','UPLOADING')) AS upload_ready
         FROM import_batch batch WHERE batch.id=$1 AND batch.shop_id=$2`,
      [batchId, shopId],
    );
    const row = batch.rows[0];
    if (!row) throw new Error("IMPORT_BATCH_NOT_FOUND");
    const files = await this.database.query<{
      id: string; relative_path: string; size_bytes: string; classification: string; parse_status: string;
    }>("SELECT id,relative_path,size_bytes::text,classification,parse_status FROM import_file WHERE import_batch_id=$1 ORDER BY relative_path", [batchId]);
    const issues = await this.database.query<{
      id: string; import_file_id: string | null; issue_code: string; severity: string;
      field_name: string | null; issue_count: string; exact_count: boolean;
    }>(
      `SELECT min(id)::text AS id,NULL::text AS import_file_id,issue_code,severity,field_name,
              sum(CASE
                WHEN safe_context->>'exactCount'='true' AND safe_context->>'count' ~ '^[0-9]+$'
                  THEN (safe_context->>'count')::bigint
                ELSE 1 END)::text AS issue_count,
              COALESCE(bool_and(CASE WHEN safe_context->>'phase'='ROW_FILTER'
                THEN safe_context->>'exactCount'='true' ELSE true END),false) AS exact_count
         FROM import_issue WHERE import_batch_id=$1
        GROUP BY issue_code,severity,field_name
        ORDER BY CASE severity WHEN 'ERROR' THEN 0 WHEN 'WARNING' THEN 1 ELSE 2 END,count(*) DESC,min(id)
        LIMIT 200`,
      [batchId],
    );
    const publicStatus = row.status === "AWAITING_COMMIT_CONFIRMATION" ? "READY"
      : ["DRAFT", "UPLOADING", "ANALYZING", "AWAITING_FILES", "RETRYING"].includes(row.status) ? "RUNNING"
        : row.status === "READY_FOR_REVIEW" && row.failure_code ? "FAILED"
          : ["COMMITTING", "COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING", "READY_FOR_REVIEW", "RESULT_PUBLISHING"].includes(row.status) ? "PROCESSING"
          : row.status === "RESULT_PUBLISHED" ? "PUBLISHED"
            : row.status === "CANCELLED" ? "CANCELLED" : row.status === "FAILED" ? "FAILED" : row.status;
    const awaitingPaths = new Set(files.rows.filter((file) => file.parse_status === "AWAITING_MAPPING").map((file) => file.relative_path));
    const visibleIssues = issues.rows.filter((issue) => {
      if (RETRYABLE_COMMIT_FAILURES.has(issue.issue_code) && row.failure_code !== issue.issue_code) return false;
      return issue.issue_code !== "AWAITING_MAPPING" || awaitingPaths.size > 0;
    });
    return {
      id: row.id,
      uploadBatchId: row.upload_batch_id,
      uploadReady: row.upload_ready,
      status: publicStatus,
      progress: publicStatus === "PUBLISHED" || publicStatus === "READY" ? "100" : publicStatus === "PROCESSING" ? "75" : "0",
      stage: row.current_stage,
      failureCode: row.failure_code,
      files: files.rows.map((file) => ({ id: file.id, relativePath: file.relative_path, bytes: file.size_bytes, classification: file.classification,
        status: file.parse_status === "AWAITING_MAPPING" && row.status === "AWAITING_COMMIT_CONFIRMATION" ? "EXCLUDED_UNKNOWN_STRUCTURE" : file.parse_status })),
      ignored: files.rows.filter((file) => ["LIST_ONLY", "TEMPORARY"].includes(file.classification) || file.parse_status === "AWAITING_MAPPING")
        .map((file) => ({ relativePath: file.relative_path, reason: file.parse_status === "AWAITING_MAPPING" ? "UNKNOWN_STRUCTURE" : file.classification })),
      issues: visibleIssues.map((issue) => {
        const filteredUnknown = issue.issue_code === "AWAITING_MAPPING" && row.status !== "AWAITING_MAPPING";
        const kind = filteredUnknown ? "UNKNOWN_STRUCTURE_EXCLUDED" : issue.issue_code;
        const count = Number(issue.issue_count);
        const presentation = describeImportIssue(kind, count, issue.field_name, issue.exact_count);
        const blocking = row.status === "FAILED" && row.failure_code === issue.issue_code;
        return {
          id: issue.id,
          kind,
          message: presentation.message,
          action: presentation.action,
          severity: blocking ? "ERROR" : issue.severity === "INFO" ? "INFO" : "WARNING",
          count,
          exactCount: issue.exact_count,
          ...(issue.field_name ? { fieldName: issue.field_name } : {}),
        };
      }),
      affectedVersions: [],
    };
  }

  async getCompleteness(shopId: string) {
    const result = await this.database.query<{
      slice_id: string; dataset_version_id: string | null; normalized_marketplace: string; local_month: string;
      status: string | null; shipment_count: string; transaction_count: string; warning: boolean | null;
      shipment_quantity: string | null; transaction_quantity: string | null; unmatched_absolute: string | null; unmatched_ratio: string | null;
    }>(
      `SELECT ds.id AS slice_id, ds.current_version_id AS dataset_version_id, ds.normalized_marketplace,
              to_char(ds.local_month,'YYYY-MM') AS local_month, dv.status,
              count(*) FILTER (WHERE b.report_kind='SHIPMENT')::text AS shipment_count,
              count(*) FILTER (WHERE b.report_kind='TRANSACTION')::text AS transaction_count,
              rr.warning, rr.shipment_quantity::text, rr.transaction_quantity::text,
              rr.unmatched_absolute::text, rr.unmatched_ratio::text
         FROM dataset_slice ds
         LEFT JOIN dataset_version dv ON dv.id=ds.current_version_id
         LEFT JOIN dataset_source_binding b ON b.dataset_version_id=dv.id
         LEFT JOIN reconciliation_result rr ON rr.dataset_version_id=dv.id
        WHERE ds.shop_id=$1
        GROUP BY ds.id,dv.id,rr.id ORDER BY ds.local_month,ds.normalized_marketplace`,
      [shopId],
    );
    return result.rows.map((row) => {
      const missingReports: Array<"TRANSACTION" | "SHIPMENT"> = [];
      if (row.status === "INCOMPLETE") {
        if (BigInt(row.transaction_count) === 0n) missingReports.push("TRANSACTION");
        if (BigInt(row.shipment_count) === 0n) missingReports.push("SHIPMENT");
      }
      const state = !row.dataset_version_id ? "AWAITING_MAPPING"
        : missingReports.includes("SHIPMENT") ? "MISSING_SHIPMENT"
          : missingReports.includes("TRANSACTION") ? "MISSING_TRANSACTION"
            : row.warning ? "PUBLISHED_WARNING" : "COMPLETE";
      return {
        sliceId: row.slice_id, datasetVersionId: row.dataset_version_id, marketplace: row.normalized_marketplace,
        month: row.local_month, state, missingReports, shipmentQuantity: row.shipment_quantity, transactionQuantity: row.transaction_quantity,
        unmatchedAbsolute: row.unmatched_absolute, unmatchedRatio: row.unmatched_ratio,
      };
    });
  }

  async confirm(shopId: string, batchId: string, input: { actorAccountId: string; idempotencyKey: string }) {
    return this.transactions.transaction((client) => confirmImportBatch(client, shopId, batchId, input));
  }

  async acknowledge(shopId: string, issueId: string, input: { actorAccountId: string; reason: string; confirmations: string; idempotencyKey: string }) {
    return this.transactions.transaction(async (client) => {
      const issue = await client.query<{ dataset_version_id: string; issue_kind: "HARD_INCOMPLETE" | "SOFT_RECONCILIATION_WARNING"; issue_code: string; policy_id: string }>(
        `SELECT dv.id AS dataset_version_id,
                CASE WHEN dv.status='INCOMPLETE' THEN 'HARD_INCOMPLETE' ELSE 'SOFT_RECONCILIATION_WARNING' END AS issue_kind,
                $2::text AS issue_code,
                policy.id AS policy_id
           FROM dataset_version dv JOIN dataset_slice ds ON ds.id=dv.dataset_slice_id
           JOIN LATERAL (
             SELECT candidate.id
               FROM marketplace_policy_version candidate
              WHERE candidate.normalized_marketplace=ds.normalized_marketplace
                AND candidate.effective_from<=dv.created_at
                AND (candidate.effective_to IS NULL OR candidate.effective_to>dv.created_at)
              ORDER BY candidate.effective_from DESC,candidate.id DESC LIMIT 1
           ) policy ON true
          WHERE dv.id=$1 AND ds.shop_id=$3`,
        [issueId, "ACCOUNTANT_ACKNOWLEDGED", shopId],
      );
      const row = issue.rows[0];
      if (!row?.policy_id) throw new Error("QUALITY_ISSUE_NOT_FOUND");
      const confirmations = BigInt(input.confirmations);
      if (confirmations < 1n || confirmations > 2n) throw new Error("INVALID_CONFIRMATIONS");
      const result = await client.query<{ id: string }>(
        `INSERT INTO quality_acknowledgement
          (dataset_version_id,marketplace_policy_version_id,issue_kind,issue_code,actor_account_id,reason,confirmation_count)
         SELECT $1,$2,$3,$4,$5,$6,$7
          WHERE NOT EXISTS (
            SELECT 1 FROM quality_acknowledgement
             WHERE dataset_version_id=$1 AND calculation_run_id IS NULL AND issue_kind=$3
          )
         RETURNING id`,
        [row.dataset_version_id, row.policy_id, row.issue_kind, row.issue_code, input.actorAccountId, input.reason, confirmations.toString()],
      );
      const acknowledgementId = result.rows[0]?.id ?? (await client.query<{ id: string }>(
        `SELECT id FROM quality_acknowledgement
          WHERE dataset_version_id=$1 AND calculation_run_id IS NULL AND issue_kind=$2
          ORDER BY created_at DESC,id DESC LIMIT 1`,
        [row.dataset_version_id, row.issue_kind],
      )).rows[0]?.id;
      if (!acknowledgementId) throw new Error("QUALITY_ACKNOWLEDGEMENT_CREATE_FAILED");
      await client.query(
        `UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [shopId, input.actorAccountId],
      );
      return { id: acknowledgementId, status: "ACKNOWLEDGED" };
    });
  }

  async rollback(shopId: string, versionId: string, input: { actorAccountId: string; reason: string; idempotencyKey: string }) {
    return this.transactions.transaction(async (client) => {
      const version = await client.query<{ slice_id: string }>(
        `SELECT dv.dataset_slice_id AS slice_id FROM dataset_version dv JOIN dataset_slice ds ON ds.id=dv.dataset_slice_id
          WHERE dv.id=$1 AND ds.shop_id=$2 FOR UPDATE OF ds`,
        [versionId, shopId],
      );
      const sliceId = version.rows[0]?.slice_id;
      if (!sliceId) throw new Error("DATASET_VERSION_NOT_FOUND");
      await client.query("UPDATE dataset_slice SET current_version_id=$2 WHERE id=$1", [sliceId, versionId]);
      await client.query(
        "INSERT INTO audit_event(actor_account_id,action,object_type,object_id,reason,metadata) VALUES($1,'DATASET_ROLLED_BACK','dataset_version',$2,$3,$4::jsonb)",
        [input.actorAccountId, versionId, input.reason, JSON.stringify({ idempotencyKey: createHash("sha256").update(input.idempotencyKey).digest("hex") })],
      );
      await client.query(
        `UPDATE shop SET last_operated_by_account_id=$2,updated_at=clock_timestamp() WHERE id=$1`,
        [shopId, input.actorAccountId],
      );
      return { versionId, status: "ACTIVE" };
    });
  }
}
