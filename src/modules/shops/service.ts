import { createHash } from 'node:crypto';
import type {
  Actor,
  SqlClient,
  TransactionRunner,
  TransactionSideEffects,
} from '../authorization/index.js';
import { authorizePlatform, authorizeShop, requireAllowed } from '../authorization/index.js';
import { appendWalletEntry, lockWallet } from '../wallet/service.js';
import { AppError } from '../../shared/errors.js';
import { structuredLog } from '../../shared/structured-logger.js';
import { diagnosticReferenceId } from '../../shared/diagnostic-reference.js';
import { REPORT_EXPORT_FORMAT } from '../exports/export-report.js';
import { anniversary, billedYears, comparePlainDate } from './dates.js';
import { deriveWorkflowSteps, workflowDownloadAvailable, type WorkflowBatchState, type WorkflowCalculationState, type WorkflowExportState } from './workflow.js';

export interface ShopView {
  readonly id: string;
  readonly applicationId: string;
  readonly enterpriseId: string;
  readonly createdByAccountId: string;
  readonly lastOperatedByAccountId: string;
  readonly createdByDisplayName?: string;
  readonly lastOperatedByDisplayName?: string;
  readonly name: string;
  readonly state: 'ACTIVE' | 'EXPIRED_READONLY' | 'TRASHED' | 'PURGED';
  readonly startDate: string;
  readonly closeDate: string;
  readonly lastUsableDate: string;
  readonly renameAvailable: boolean;
  readonly access: 'ENTERPRISE' | 'CUSTOMER' | 'ADMIN';
  readonly accountingStatus: 'NOT_STARTED' | 'SUBMITTED';
  readonly status: 'ACTIVE' | 'EXPIRED' | 'TRASHED';
  readonly termStart: string;
  readonly termEndExclusive: string;
  readonly publishedSnapshot?: { readonly id: string; readonly publishedAt: string; readonly stale: boolean };
  readonly customerExportAllowed?: boolean;
}

interface ShopRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  owner_account_id: string;
  enterprise_id: string;
  created_by_account_id: string;
  last_operated_by_account_id: string;
  created_by_display_name?: string | null;
  last_operated_by_display_name?: string | null;
  name: string;
  status: ShopView['state'];
  start_date: string;
  close_date: string;
  rename_count: number;
  published_snapshot_id?: string | null;
  published_at?: Date | null;
  published_snapshot_stale?: boolean | null;
  export_allowed?: boolean | null;
}

interface IdempotentShopChargeRow extends ShopRow {
  charge_start_date: string;
  charge_close_date: string;
  supersedes_term_id: string | null;
  waiver_type: 'ADMIN_FREE' | null;
  waiver_reason: string | null;
  original_name: string;
}

function normalizeShopName(name: string): { name: string; normalized: string } {
  const visible = name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const length = [...visible].length;
  if (length < 1 || length > 120) {
    throw new AppError('SHOP_NAME_INVALID', '店铺名称长度必须为 1–120 个字符', 400, 'name');
  }
  return { name: visible, normalized: visible.toLocaleLowerCase('zh-CN') };
}

function previousDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year!, month! - 1, day!));
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function view(row: ShopRow, access: ShopView['access']): ShopView {
  return {
    id: row.id,
    applicationId: row.application_id,
    enterpriseId: row.enterprise_id,
    createdByAccountId: row.created_by_account_id,
    lastOperatedByAccountId: row.last_operated_by_account_id,
    ...(row.created_by_display_name ? { createdByDisplayName: row.created_by_display_name } : {}),
    ...(row.last_operated_by_display_name ? { lastOperatedByDisplayName: row.last_operated_by_display_name } : {}),
    name: row.name,
    state: row.status,
    startDate: row.start_date,
    closeDate: row.close_date,
    lastUsableDate: previousDate(row.close_date),
    renameAvailable: row.rename_count === 0,
    access,
    accountingStatus: row.published_snapshot_id && !row.published_snapshot_stale ? 'SUBMITTED' : 'NOT_STARTED',
    status: row.status === 'EXPIRED_READONLY' ? 'EXPIRED' : row.status === 'PURGED' ? 'TRASHED' : row.status,
    termStart: row.start_date,
    termEndExclusive: row.close_date,
    ...(row.published_snapshot_id && row.published_at
      ? { publishedSnapshot: { id: row.published_snapshot_id, publishedAt: row.published_at.toISOString(), stale: row.published_snapshot_stale ?? false } }
      : {}),
    ...(row.export_allowed !== undefined ? { customerExportAllowed: row.export_allowed ?? false } : {}),
  };
}

function sameChargeWaiver(
  row: IdempotentShopChargeRow,
  isAdmin: boolean,
  waiverReason: string | undefined,
): boolean {
  return isAdmin
    ? row.waiver_type === 'ADMIN_FREE' && row.waiver_reason === waiverReason!.trim()
    : row.waiver_type === null && row.waiver_reason === null;
}

function idempotencyConflict(): never {
  throw new AppError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同店铺操作', 409);
}

function rethrowShopNameConflict(error: unknown): never {
  if (
    typeof error === 'object'
    && error !== null
    && 'code' in error
    && error.code === '23505'
    && 'constraint' in error
    && error.constraint === 'shop_enterprise_live_name_uq'
  ) {
    throw new AppError('SHOP_NAME_CONFLICT', '已有同名店铺（包括回收站），请更换店铺名称', 409, 'name');
  }
  throw error;
}

export class ShopService {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly reader: SqlClient,
    private readonly effects: TransactionSideEffects,
  ) {}

  async listAccessible(actor: Actor, enterpriseId?: string): Promise<readonly ShopView[]> {
    if (enterpriseId && !actor.roles.has('ADMIN') && !actor.enterpriseIds?.has(enterpriseId)) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    }
    await this.refreshExpiredShops();
    const result = await this.reader.query<ShopRow & { access: ShopView['access'] }>(
      `SELECT * FROM (
        SELECT DISTINCT ON (s.id) s.*,creator.display_name AS created_by_display_name,
         operator.display_name AS last_operated_by_display_name,
         sm.export_allowed,ps.id AS published_snapshot_id,ps.published_at,
         CASE WHEN ps.id IS NULL THEN false ELSE EXISTS (
           SELECT 1 FROM dataset_slice ds
            WHERE ds.shop_id=s.id AND ds.current_version_id IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM published_snapshot_slice pss
                 WHERE pss.published_snapshot_id=ps.id AND pss.dataset_slice_id=ds.id
                   AND pss.dataset_version_id=ds.current_version_id
              )
         ) END AS published_snapshot_stale,
         CASE WHEN $2 THEN 'ADMIN'
              WHEN em.id IS NOT NULL THEN 'ENTERPRISE' ELSE 'CUSTOMER' END AS access
         FROM shop s
         LEFT JOIN account creator ON creator.id=s.created_by_account_id
         LEFT JOIN account operator ON operator.id=s.last_operated_by_account_id
         LEFT JOIN enterprise_member em
           ON em.enterprise_id=s.enterprise_id AND em.account_id=$1 AND em.status='ACTIVE'
         LEFT JOIN shop_membership sm
           ON sm.shop_id = s.id AND sm.account_id = $1 AND sm.status = 'ACTIVE'
         LEFT JOIN shop_current_published_snapshot scps ON scps.shop_id=s.id
         LEFT JOIN published_snapshot ps ON ps.id=scps.published_snapshot_id
        WHERE s.status <> 'PURGED'
          AND ($3::uuid IS NULL OR s.enterprise_id=$3)
          AND (
             em.id IS NOT NULL OR $2
             OR (sm.id IS NOT NULL AND s.status IN ('ACTIVE', 'EXPIRED_READONLY'))
           )
        ORDER BY s.id
      ) accessible
      ORDER BY accessible.updated_at DESC, accessible.created_at DESC, accessible.id DESC`,
      [actor.accountId, actor.roles.has('ADMIN'), enterpriseId ?? null],
    );
    return result.rows.map((row) => view(row, row.access));
  }

  async getWorkflow(actor: Actor, shopId: string) {
    const startedAt = Date.now();
    try {
      const shop = (await this.listAccessible(actor)).find((candidate) => candidate.id === shopId);
      if (!shop || shop.status === 'TRASHED') {
        throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      }
      const canExport = shop.access !== 'CUSTOMER' || shop.customerExportAllowed === true;
      let batch: WorkflowBatchState | undefined;
      let calculation: WorkflowCalculationState | undefined;
      let latestExport: WorkflowExportState | undefined;
      let workerAvailable = true;
      let terminalRecoveryBlocked = false;

      if (shop.access !== 'CUSTOMER') {
        const batches = await this.reader.query<{
          id: string; status: string; current_stage: string; failure_code: string | null;
          declared_bytes: string; received_bytes: string; file_count: number;
          processed_file_count: string; warning_count: string; blocking_count: string;
          published_snapshot_matches_batch: boolean;
          accounting_period_start: string | null; accounting_period_end: string | null;
        }>(
          `SELECT ib.id,ib.status,ib.current_stage,ib.failure_code,
                  to_char(ib.accounting_period_start,'YYYY-MM') accounting_period_start,
                  to_char(ib.accounting_period_end,'YYYY-MM') accounting_period_end,
                  ub.declared_bytes::text,ub.received_bytes::text,ub.file_count,
                  (SELECT count(*) FROM import_file f WHERE f.import_batch_id=ib.id AND f.parse_status<>'PENDING')::text AS processed_file_count,
                  (SELECT count(*) FROM import_issue issue
                    WHERE issue.import_batch_id=ib.id
                      AND issue.severity IN ('WARNING','ERROR')
                      AND NOT (ib.status='FAILED' AND issue.issue_code=ib.failure_code))::text AS warning_count,
                  (SELECT count(*) FROM import_issue issue
                    WHERE issue.import_batch_id=ib.id AND issue.severity='ERROR'
                      AND ib.status='FAILED' AND issue.issue_code=ib.failure_code)::text AS blocking_count,
                  EXISTS (
                    SELECT 1 FROM shop_current_published_snapshot current_snapshot
                    JOIN published_snapshot snapshot ON snapshot.id=current_snapshot.published_snapshot_id
                    JOIN calculation_run run ON run.id=snapshot.calculation_run_id
                    WHERE current_snapshot.shop_id=ib.shop_id
                      AND run.input_manifest->>'sourceImportBatchId'=ib.id::text
                  ) AS published_snapshot_matches_batch
             FROM import_batch ib
             JOIN upload_batch ub ON ub.id=ib.upload_batch_id
            WHERE ib.shop_id=$1 AND ib.status<>'CANCELLED'
            ORDER BY ib.created_at DESC,ib.id DESC LIMIT 1`,
          [shopId],
        );
        const row = batches.rows[0];
        if (row) {
          batch = {
            id: row.id,
            status: row.status,
            stage: row.current_stage,
            failureCode: row.failure_code,
            declaredBytes: row.declared_bytes,
            receivedBytes: row.received_bytes,
            fileCount: row.file_count,
            processedFileCount: Number(row.processed_file_count),
            warningCount: Number(row.warning_count),
            blockingCount: Number(row.blocking_count),
            publishedSnapshotMatchesBatch: row.published_snapshot_matches_batch,
            ...(row.accounting_period_start && row.accounting_period_end
              ? { periodStart: row.accounting_period_start, periodEnd: row.accounting_period_end }
              : {}),
          };
          const calculations = await this.reader.query<{ id: string; status: string; failure_code: string | null }>(
            `SELECT id,status,failure_code FROM calculation_run
              WHERE shop_id=$1 AND input_manifest->>'sourceImportBatchId'=$2
              ORDER BY created_at DESC,id DESC LIMIT 1`,
            [shopId, row.id],
          );
          if (calculations.rows[0]) {
            calculation = { id: calculations.rows[0].id, status: calculations.rows[0].status, failureCode: calculations.rows[0].failure_code };
          }
        }
      }

      if (shop.publishedSnapshot && canExport) {
        const exports = await this.reader.query<{
          id: string; published_snapshot_id: string; status: string; stage: string;
          progress_percent: number; processed_rows: string; total_rows: string | null;
          heartbeat_at: Date | null;
        }>(
          `SELECT id,published_snapshot_id,status,stage,progress_percent,
                  processed_rows::text,total_rows::text,heartbeat_at FROM export_request
            WHERE shop_id=$1 AND requested_by=$2 AND published_snapshot_id=$3 AND format_version=$4
              AND profit_rate IS NOT DISTINCT FROM (SELECT accounting_profit_rate FROM account WHERE id=$2)
              AND minimum_sales_cost_rate IS NOT DISTINCT FROM (SELECT minimum_sales_cost_rate FROM account WHERE id=$2)
              AND continent_prefixes = (SELECT accounting_continent_prefixes FROM account WHERE id=$2)
            ORDER BY created_at DESC,id DESC LIMIT 1`,
          [shopId, actor.accountId, shop.publishedSnapshot.id, REPORT_EXPORT_FORMAT],
        );
        const row = exports.rows[0];
        if (row) latestExport = {
          id: row.id,
          snapshotId: row.published_snapshot_id,
          status: row.status,
          progress: row.status === "SUCCEEDED" ? "100" : String(row.progress_percent),
          stage: row.stage,
          processedRows: row.processed_rows,
          totalRows: row.total_rows,
          heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
        };
      }

      const workerRequired = Boolean(
        batch && ["ANALYZING", "RETRYING", "COMMITTING", "COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING", "READY_FOR_REVIEW", "RESULT_PUBLISHING"].includes(batch.status)
      ) || Boolean(latestExport && ["QUEUED", "RUNNING"].includes(latestExport.status));
      if (workerRequired || batch || calculation || latestExport) {
        const processing = await this.reader.query<{ available: boolean; terminal_recovery_blocked: boolean }>(
          `SELECT COALESCE((SELECT status='RUNNING'
                                  AND last_heartbeat_at >= clock_timestamp() - interval '60 seconds'
                             FROM job_operation
                            WHERE business_key='service:worker'),false) AS available,
                  EXISTS(
                    SELECT 1
                      FROM job_operation recovery
                      LEFT JOIN pgboss.job terminal_job
                        ON recovery.business_key='terminal-reconcile:' || terminal_job.id::text
                       AND terminal_job.state='failed'
                      CROSS JOIN LATERAL (
                        SELECT COALESCE(recovery.progress->>'queueName',terminal_job.name) AS queue_name,
                               COALESCE(
                                 recovery.progress->>'businessField',
                                 CASE terminal_job.name
                                   WHEN 'upload.finalize' THEN 'fileId'
                                   WHEN 'import.analyze' THEN 'fileId'
                                   WHEN 'import.commit' THEN 'batchId'
                                   WHEN 'calculation.requested' THEN 'batchId'
                                   WHEN 'calculation.run' THEN 'runId'
                                   WHEN 'report.auto-publish' THEN 'sourceImportBatchId'
                                   WHEN 'export.generate' THEN 'exportId'
                                 END
                               ) AS business_field,
                               COALESCE(
                                 recovery.progress->>'businessId',
                                 terminal_job.data->>CASE terminal_job.name
                                   WHEN 'upload.finalize' THEN 'fileId'
                                   WHEN 'import.analyze' THEN 'fileId'
                                   WHEN 'import.commit' THEN 'batchId'
                                   WHEN 'calculation.requested' THEN 'batchId'
                                   WHEN 'calculation.run' THEN 'runId'
                                   WHEN 'report.auto-publish' THEN 'sourceImportBatchId'
                                   WHEN 'export.generate' THEN 'exportId'
                                 END
                               ) AS business_id
                      ) recovery_identity
                     WHERE recovery.job_name='worker.terminal-reconcile'
                       AND recovery.business_key LIKE 'terminal-reconcile:%'
                       AND (
                         (recovery.status='RUNNING' AND recovery.progress->>'outcome'='ACTIVE_CALLBACK')
                         OR (recovery.status='FAILED' AND recovery.progress->>'outcome'='RECOVERY_FAILED')
                       )
                       AND (
                         (recovery_identity.queue_name='upload.finalize'
                           AND recovery_identity.business_field='fileId'
                           AND EXISTS(
                           SELECT 1
                             FROM upload_file source
                             JOIN import_batch current_batch ON current_batch.upload_batch_id=source.batch_id
                            WHERE current_batch.id=$1::uuid
                              AND source.id::text=recovery_identity.business_id
                              AND source.status IN ('COMPLETE','ENCRYPTING')
                         ))
                         OR (recovery_identity.queue_name='import.analyze'
                           AND recovery_identity.business_field='fileId'
                           AND EXISTS(
                           SELECT 1
                             FROM upload_file source
                             JOIN import_batch current_batch ON current_batch.upload_batch_id=source.batch_id
                             LEFT JOIN import_file analyzed
                              ON analyzed.import_batch_id=current_batch.id
                              AND analyzed.stored_object_id=source.stored_object_id
                            WHERE current_batch.id=$1::uuid
                              AND source.id::text=recovery_identity.business_id
                              AND current_batch.status IN ('ANALYZING','RETRYING')
                              AND (analyzed.id IS NULL OR analyzed.parse_status='PENDING')
                         ))
                         OR (recovery_identity.queue_name='import.commit'
                           AND recovery_identity.business_field='batchId'
                           AND recovery_identity.business_id=$1::text
                           AND EXISTS(SELECT 1 FROM import_batch current_batch
                                      WHERE current_batch.id=$1::uuid AND current_batch.status='COMMITTING'))
                         OR (recovery_identity.queue_name='calculation.requested'
                           AND recovery_identity.business_field='batchId'
                           AND recovery_identity.business_id=$1::text
                           AND EXISTS(SELECT 1 FROM import_batch current_batch
                                      WHERE current_batch.id=$1::uuid
                                        AND current_batch.status IN ('COMMITTED','COMMITTED_WITH_EXCLUSIONS','CALCULATING')))
                         OR (recovery_identity.queue_name='calculation.run'
                           AND recovery_identity.business_field='runId'
                           AND recovery_identity.business_id=$2::text
                           AND EXISTS(SELECT 1 FROM calculation_run current_run
                                      WHERE current_run.id=$2::uuid
                                        AND current_run.status IN ('QUEUED','RUNNING','BLOCKED')))
                         OR (recovery_identity.queue_name='report.auto-publish'
                           AND recovery_identity.business_field='sourceImportBatchId'
                           AND recovery_identity.business_id=$1::text
                           AND EXISTS(SELECT 1 FROM import_batch current_batch
                                      WHERE current_batch.id=$1::uuid
                                        AND current_batch.status IN ('CALCULATING','READY_FOR_REVIEW','RESULT_PUBLISHING')))
                         OR (recovery_identity.queue_name='export.generate'
                           AND recovery_identity.business_field='exportId'
                           AND recovery_identity.business_id=$3::text
                           AND EXISTS(SELECT 1 FROM export_request current_export
                                      WHERE current_export.id=$3::uuid
                                        AND current_export.status IN ('QUEUED','RUNNING')))
                       )
                  ) AS terminal_recovery_blocked`,
          [batch?.id ?? null, calculation?.id ?? null, latestExport?.id ?? null],
        );
        if (workerRequired) workerAvailable = processing.rows[0]?.available === true;
        terminalRecoveryBlocked = processing.rows[0]?.terminal_recovery_blocked === true;
      }

      const workflow = deriveWorkflowSteps({
        access: shop.access,
        shopStatus: shop.status,
        hasPublishedSnapshot: Boolean(shop.publishedSnapshot),
        canExport,
        ...(batch ? { batch } : {}),
        ...(calculation ? { calculation } : {}),
        ...(latestExport ? { latestExport } : {}),
        workerAvailable,
        terminalRecoveryBlocked,
      });
      const downloadAvailable = workflowDownloadAvailable({
        access: shop.access,
        shopStatus: shop.status,
        hasPublishedSnapshot: Boolean(shop.publishedSnapshot),
        canExport,
        ...(batch ? { batch } : {}),
        ...(calculation ? { calculation } : {}),
        ...(latestExport ? { latestExport } : {}),
        workerAvailable,
        terminalRecoveryBlocked,
      });
      const diagnosticId = batch?.id
        ? diagnosticReferenceId('I', batch.id)
        : latestExport
          ? diagnosticReferenceId('E', latestExport.id)
          : shop.publishedSnapshot
            ? diagnosticReferenceId('P', shop.publishedSnapshot.id)
            : diagnosticReferenceId('C', shop.id);
      structuredLog('info', 'api', 'shop_workflow_resolved', {
        access: shop.access,
        diagnosticDigest: createHash('sha256').update(diagnosticId).digest('hex').slice(0, 16),
        batchStatus: batch?.status ?? null,
        batchStage: batch?.stage ?? null,
        failureCode: batch?.failureCode ?? calculation?.failureCode ?? null,
        calculationStatus: calculation?.status ?? null,
        exportStatus: latestExport?.status ?? null,
        workerAvailable,
        terminalRecoveryBlocked,
        currentStep: workflow.currentStep,
        warningCount: workflow.steps.reduce((sum, item) => sum + item.warningCount, 0),
        blockingCount: workflow.steps.reduce((sum, item) => sum + item.blockingCount, 0),
        durationMs: Date.now() - startedAt,
      });
      return {
        shop: { id: shop.id, name: shop.name, access: shop.access, status: shop.status, canEdit: shop.access !== 'CUSTOMER' && shop.status === 'ACTIVE' },
        diagnosticId,
        ...workflow,
        processingHealth: { workerAvailable, terminalRecoveryBlocked },
        ...(shop.access !== 'CUSTOMER' && batch ? { latestBatch: { id: batch.id, status: batch.status, stage: batch.stage, failureCode: batch.failureCode,
          ...(batch.periodStart && batch.periodEnd ? { periodStart: batch.periodStart, periodEnd: batch.periodEnd } : {}),
          ...(calculation?.id ? { calculationRunId: calculation.id } : {}) } } : {}),
        ...(shop.publishedSnapshot ? { publishedSnapshot: shop.publishedSnapshot } : {}),
        download: {
          available: downloadAvailable,
          usesPreviousPublishedVersion: Boolean(shop.publishedSnapshot && batch && !batch.publishedSnapshotMatchesBatch),
          ...(latestExport ? { latestExport } : {}),
        },
      };
    } catch (error) {
      structuredLog('error', 'api', 'shop_workflow_failed', { errorType: error instanceof Error ? error.name : 'UnknownError', durationMs: Date.now() - startedAt });
      throw error;
    }
  }

  async bulkTrash(input: {
    readonly actor: Actor;
    readonly shopIds: readonly string[];
    readonly reason: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<{ readonly count: number; readonly status: 'TRASHED' }> {
    const startedAt = Date.now();
    const shopIds = [...new Set(input.shopIds)].sort();
    const reason = input.reason.trim();
    if (!reason) throw new AppError('REASON_REQUIRED', '批量删除店铺必须填写原因', 400, 'reason');
    const requestHash = createHash('sha256').update(JSON.stringify({ shopIds, reason })).digest('hex');
    try {
      const result = await this.transactions.transaction(async (client) => {
        const scope = 'shop.bulk-trash';
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('idempotency:' || $1 || ':' || $2 || ':' || $3, 0))",
          [input.actor.accountId, scope, input.idempotencyKey],
        );
        const prior = await client.query<{ request_hash: string; response_body: { count: number; status: 'TRASHED' } | null }>(
          `SELECT request_hash,response_body FROM idempotency_record
            WHERE actor_account_id=$1 AND scope=$2 AND idempotency_key=$3`,
          [input.actor.accountId, scope, input.idempotencyKey],
        );
        if (prior.rows[0]) {
          if (prior.rows[0].request_hash !== requestHash) throw new AppError('IDEMPOTENCY_KEY_REUSED', '同一幂等键不能用于不同批量删除操作', 409);
          if (!prior.rows[0].response_body) throw new Error('IDEMPOTENT_BULK_TRASH_RESPONSE_MISSING');
          return prior.rows[0].response_body;
        }

        const selected = await client.query<ShopRow>(
          'SELECT * FROM shop WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [shopIds],
        );
        if (selected.rows.length !== shopIds.length) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
        for (const shop of selected.rows) {
          requireAllowed(authorizeShop(input.actor, { id: shop.id, enterpriseId: shop.enterprise_id, state: shop.status }, null, 'SHOP_TRASH'));
          if (!['ACTIVE', 'EXPIRED_READONLY'].includes(shop.status)) throw new AppError('SHOP_STATE_CONFLICT', '所选店铺当前状态不允许删除', 409);
        }
        const active = await client.query<{ shop_id: string }>(
          `SELECT DISTINCT shop_id FROM (
             SELECT shop_id FROM import_batch WHERE shop_id=ANY($1::uuid[]) AND status IN
               ('UPLOADING','ANALYZING','RETRYING','COMMITTING','CALCULATING','RESULT_PUBLISHING')
             UNION ALL
             SELECT shop_id FROM calculation_run WHERE shop_id=ANY($1::uuid[]) AND status IN ('QUEUED','RUNNING')
             UNION ALL
             SELECT shop_id FROM export_request WHERE shop_id=ANY($1::uuid[]) AND status IN ('QUEUED','RUNNING')
           ) active`,
          [shopIds],
        );
        if (active.rows.length) throw new AppError('SHOP_HAS_ACTIVE_WORKFLOW', '所选店铺存在运行中的任务，请完成或取消后再删除', 409);

        const updated = await client.query<ShopRow>(
          `UPDATE shop SET status='TRASHED',trashed_at=clock_timestamp(),purge_after=clock_timestamp()+interval '30 days',
                   last_operated_by_account_id=$2,updated_at=clock_timestamp()
            WHERE id=ANY($1::uuid[]) RETURNING *`,
          [shopIds, input.actor.accountId],
        );
        for (const shop of updated.rows) {
          await this.effects.audit(client, {
            actorAccountId: input.actor.accountId,
            actorRoles: [...input.actor.roles],
            objectType: 'shop',
            objectId: shop.id,
            action: 'SHOP_TRASHED',
            result: 'SUCCEEDED',
            reason,
            requestId: input.requestId,
            before: { state: selected.rows.find((candidate) => candidate.id === shop.id)?.status ?? null },
            after: { state: 'TRASHED' },
          });
        }
        const response = { count: updated.rows.length, status: 'TRASHED' as const };
        await client.query(
          `INSERT INTO idempotency_record(actor_account_id,scope,idempotency_key,request_hash,response_status,response_body,expires_at)
           VALUES($1,$2,$3,$4,200,$5::jsonb,clock_timestamp()+interval '7 days')`,
          [input.actor.accountId, scope, input.idempotencyKey, requestHash, JSON.stringify(response)],
        );
        return response;
      });
      structuredLog('info', 'api', 'shop_bulk_trash_succeeded', { count: result.count, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      structuredLog('error', 'api', 'shop_bulk_trash_failed', { count: shopIds.length, errorType: error instanceof Error ? error.name : 'UnknownError', durationMs: Date.now() - startedAt });
      throw error;
    }
  }

  async create(input: {
    readonly actor: Actor;
    readonly enterpriseId: string;
    readonly applicationId: string;
    readonly name: string;
    readonly startDate: string;
    readonly requestedCloseDate?: string;
    readonly idempotencyKey: string;
    readonly waiverReason?: string;
    readonly requestId: string;
  }): Promise<ShopView> {
    requireAllowed(authorizePlatform(input.actor, 'SHOP_CREATE'));
    const isAdmin = input.actor.roles.has('ADMIN');
    if (!isAdmin && !input.actor.enterpriseIds?.has(input.enterpriseId)) {
      throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
    }
    const names = normalizeShopName(input.name);
    const closeDate = input.requestedCloseDate ?? anniversary(input.startDate, 1);
    const years = billedYears(input.startDate, closeDate);

    return this.transactions.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shop-charge:' || $1 || ':' || $2, 0))",
        [input.actor.accountId, input.idempotencyKey],
      );
      const existing = await client.query<IdempotentShopChargeRow>(
        `SELECT s.*, st.start_date AS charge_start_date, st.close_date AS charge_close_date,
                st.supersedes_term_id, sc.waiver_type, sc.waiver_reason,
                COALESCE((
                  SELECT snh.old_name FROM shop_name_history snh
                   WHERE snh.shop_id = s.id ORDER BY snh.changed_at LIMIT 1
                ), s.name) AS original_name
           FROM shop_charge sc
           JOIN shop s ON s.id = sc.shop_id
           JOIN shop_term st ON st.id = sc.shop_term_id
          WHERE sc.created_by = $1 AND sc.idempotency_key = $2`,
        [input.actor.accountId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.supersedes_term_id !== null ||
          prior.application_id !== input.applicationId ||
          prior.enterprise_id !== input.enterpriseId ||
          prior.original_name !== names.name ||
          prior.charge_start_date !== input.startDate ||
          prior.charge_close_date !== closeDate ||
          !(isAdmin
            ? prior.waiver_type === 'ADMIN_FREE'
            : sameChargeWaiver(prior, false, undefined))
        ) {
          idempotencyConflict();
        }
        return view(prior, isAdmin ? 'ADMIN' : 'ENTERPRISE');
      }
      const enterprise = await client.query<{ wallet_id: string; unified_social_credit_code: string | null }>(
        `SELECT w.id wallet_id,e.unified_social_credit_code
           FROM enterprise e JOIN wallet_account w ON w.enterprise_id=e.id
          WHERE e.id=$1 FOR SHARE OF e,w`,
        [input.enterpriseId],
      );
      const enterpriseRow = enterprise.rows[0];
      if (!enterpriseRow) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      if (!enterpriseRow.unified_social_credit_code) {
        throw new AppError('ENTERPRISE_PROFILE_INCOMPLETE', '请先补齐企业名称和统一社会信用代码', 409);
      }
      const price = await client.query<{ id: string; annual_price_cents: string }>(
        `SELECT pv.id, pv.annual_price_cents
           FROM application a
           JOIN LATERAL (
             SELECT id, annual_price_cents FROM application_price_version
              WHERE application_id = a.id AND effective_from <= clock_timestamp()
              ORDER BY effective_from DESC LIMIT 1
           ) pv ON true
          WHERE a.id = $1 AND a.status = 'ACTIVE'
            AND ($3 OR ($2 AND EXISTS (
              SELECT 1
                FROM (
                  SELECT DISTINCT ON (platform_role) platform_role, can_create_shop
                    FROM application_role_policy
                   WHERE application_id = a.id AND effective_from <= clock_timestamp()
                   ORDER BY platform_role, effective_from DESC
                ) policy
               WHERE policy.can_create_shop
                 AND policy.platform_role = 'ACCOUNTANT'
            )))
          FOR SHARE OF a`,
        [input.applicationId, input.actor.roles.has('ACCOUNTANT'), input.actor.roles.has('ADMIN')],
      );
      const currentPrice = price.rows[0];
      if (!currentPrice) {
        throw new AppError('APPLICATION_UNAVAILABLE', '应用不可用、没有生效价格或未授权当前角色', 409);
      }
      const original = BigInt(currentPrice.annual_price_cents) * BigInt(years);
      let ledgerId: string | null = null;
      if (!isAdmin && original > 0n) {
        const wallet = await lockWallet(client, enterpriseRow.wallet_id);
        if (wallet.status !== 'ACTIVE' || BigInt(wallet.balanceCents) < original) {
          throw new AppError('WALLET_INSUFFICIENT_OR_RESTRICTED', '钱包余额不足或限制消费', 409);
        }
      }
      let shop: ShopRow | undefined;
      try {
        const shopResult = await client.query<ShopRow>(
          `INSERT INTO shop
            (application_id,owner_account_id,enterprise_id,created_by_account_id,last_operated_by_account_id,
             name,normalized_name,start_date,close_date,status)
           VALUES ($1,$2,$3,$2,$2,$4,$5,$6,$7,
             CASE WHEN $7::date <= timezone('Asia/Shanghai', clock_timestamp())::date
                  THEN 'EXPIRED_READONLY' ELSE 'ACTIVE' END)
           RETURNING *`,
          [input.applicationId, input.actor.accountId, input.enterpriseId, names.name, names.normalized, input.startDate, closeDate],
        );
        shop = shopResult.rows[0];
      } catch (error) {
        rethrowShopNameConflict(error);
      }
      if (!shop) throw new Error('创建店铺失败');
      if (!isAdmin && original > 0n) {
        const ledger = await appendWalletEntry(client, {
          walletId: enterpriseRow.wallet_id,
          entryType: 'SHOP_CHARGE',
          deltaCents: -original,
          businessKey: `shop-create:${input.idempotencyKey}`,
          referenceType: 'SHOP',
          referenceId: shop.id,
          actorAccountId: input.actor.accountId,
          reason: null,
        });
        ledgerId = ledger.ledgerId;
      }
      const term = await client.query<{ id: string }>(
        `INSERT INTO shop_term
          (shop_id, start_date, close_date, charged_years, price_version_id)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [shop.id, input.startDate, closeDate, years, currentPrice.id],
      );
      const termId = term.rows[0]?.id;
      if (!termId) throw new Error('创建店铺期限失败');
      await client.query(
        `INSERT INTO shop_charge
          (shop_id, shop_term_id, price_version_id, original_amount_cents, charged_amount_cents,
           waiver_type, waiver_reason, wallet_ledger_id, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          shop.id,
          termId,
          currentPrice.id,
          original.toString(),
          isAdmin ? '0' : original.toString(),
          isAdmin ? 'ADMIN_FREE' : null,
          null,
          ledgerId,
          input.idempotencyKey,
          input.actor.accountId,
        ],
      );
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop',
        objectId: shop.id,
        action: 'SHOP_CREATED',
        result: 'SUCCEEDED',
        reason: null,
        requestId: input.requestId,
        before: null,
        after: {
          originalAmountCents: original.toString(),
          chargedAmountCents: isAdmin ? '0' : original.toString(),
          waiverType: isAdmin ? 'ADMIN_FREE' : null,
          priceVersionId: currentPrice.id,
          closeDate,
        },
      });
      return view(shop, isAdmin ? 'ADMIN' : 'ENTERPRISE');
    });
  }

  async renew(input: {
    readonly actor: Actor;
    readonly shopId: string;
    readonly requestedCloseDate: string;
    readonly idempotencyKey: string;
    readonly waiverReason?: string;
    readonly requestId: string;
  }): Promise<ShopView> {
    const isAdmin = input.actor.roles.has('ADMIN');
    if (isAdmin && !input.waiverReason?.trim()) {
      throw new AppError('REASON_REQUIRED', '管理员免费续期必须填写减免原因', 400, 'waiverReason');
    }
    return this.transactions.transaction(async (client) => {
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('shop-charge:' || $1 || ':' || $2, 0))",
        [input.actor.accountId, input.idempotencyKey],
      );
      const existing = await client.query<IdempotentShopChargeRow>(
        `SELECT s.*, st.start_date AS charge_start_date, st.close_date AS charge_close_date,
                st.supersedes_term_id, sc.waiver_type, sc.waiver_reason,
                COALESCE((
                  SELECT snh.old_name FROM shop_name_history snh
                   WHERE snh.shop_id = s.id ORDER BY snh.changed_at LIMIT 1
                ), s.name) AS original_name
           FROM shop_charge sc
           JOIN shop s ON s.id = sc.shop_id
           JOIN shop_term st ON st.id = sc.shop_term_id
          WHERE sc.created_by = $1 AND sc.idempotency_key = $2`,
        [input.actor.accountId, input.idempotencyKey],
      );
      const prior = existing.rows[0];
      if (prior) {
        if (
          prior.supersedes_term_id === null ||
          prior.id !== input.shopId ||
          prior.charge_close_date !== input.requestedCloseDate ||
          !sameChargeWaiver(prior, isAdmin, input.waiverReason)
        ) {
          idempotencyConflict();
        }
        return view(prior, isAdmin ? 'ADMIN' : 'ENTERPRISE');
      }
      const result = await client.query<ShopRow>('SELECT * FROM shop WHERE id = $1 FOR UPDATE', [input.shopId]);
      const shop = result.rows[0];
      if (!shop) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      requireAllowed(authorizeShop(input.actor, { id: shop.id, enterpriseId: shop.enterprise_id, state: shop.status }, null, 'SHOP_RENEW'));
      if (comparePlainDate(input.requestedCloseDate, shop.close_date) <= 0) {
        throw new AppError('SHOP_TERM_INVALID', '续期关闭日期必须晚于当前关闭日期', 400, 'requestedCloseDate');
      }
      const totalYears = billedYears(shop.start_date, input.requestedCloseDate);
      const currentYears = billedYears(shop.start_date, shop.close_date);
      const addedYears = totalYears - currentYears;
      if (addedYears < 1) throw new AppError('SHOP_TERM_INVALID', '续期必须增加至少一个计费周年', 400);
      const price = await client.query<{ id: string; annual_price_cents: string }>(
        `SELECT pv.id, pv.annual_price_cents
           FROM application a JOIN LATERAL (
             SELECT id, annual_price_cents FROM application_price_version
              WHERE application_id = a.id AND effective_from <= clock_timestamp()
              ORDER BY effective_from DESC LIMIT 1
           ) pv ON true WHERE a.id = $1 AND a.status = 'ACTIVE' FOR SHARE OF a`,
        [shop.application_id],
      );
      const currentPrice = price.rows[0];
      if (!currentPrice) throw new AppError('APPLICATION_UNAVAILABLE', '应用不可用或没有生效价格', 409);
      const original = BigInt(currentPrice.annual_price_cents) * BigInt(addedYears);
      let ledgerId: string | null = null;
      if (!isAdmin && original > 0n) {
        const enterpriseWallet = await client.query<{ id: string }>('SELECT id FROM wallet_account WHERE enterprise_id=$1', [shop.enterprise_id]);
        const walletId = enterpriseWallet.rows[0]?.id;
        if (!walletId) throw new AppError('WALLET_NOT_FOUND', '钱包不存在或无权访问', 404);
        const wallet = await lockWallet(client, walletId);
        if (wallet.status !== 'ACTIVE' || BigInt(wallet.balanceCents) < original) {
          throw new AppError('WALLET_INSUFFICIENT_OR_RESTRICTED', '钱包余额不足或限制消费', 409);
        }
        const ledger = await appendWalletEntry(client, {
          walletId,
          entryType: 'SHOP_CHARGE',
          deltaCents: -original,
          businessKey: `shop-renew:${input.idempotencyKey}`,
          referenceType: 'SHOP',
          referenceId: shop.id,
          actorAccountId: input.actor.accountId,
          reason: null,
        });
        ledgerId = ledger.ledgerId;
      }
      const previousTerm = await client.query<{ id: string }>(
        'SELECT id FROM shop_term WHERE shop_id = $1 ORDER BY created_at DESC LIMIT 1',
        [shop.id],
      );
      const term = await client.query<{ id: string }>(
        `INSERT INTO shop_term
          (shop_id, start_date, close_date, charged_years, price_version_id, supersedes_term_id)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [shop.id, shop.start_date, input.requestedCloseDate, totalYears, currentPrice.id, previousTerm.rows[0]?.id ?? null],
      );
      const termId = term.rows[0]?.id;
      if (!termId) throw new Error('创建续期期限失败');
      await client.query(
        `INSERT INTO shop_charge
          (shop_id, shop_term_id, price_version_id, original_amount_cents, charged_amount_cents,
           waiver_type, waiver_reason, wallet_ledger_id, idempotency_key, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          shop.id,
          termId,
          currentPrice.id,
          original.toString(),
          isAdmin ? '0' : original.toString(),
          isAdmin ? 'ADMIN_FREE' : null,
          isAdmin ? input.waiverReason!.trim() : null,
          ledgerId,
          input.idempotencyKey,
          input.actor.accountId,
        ],
      );
      const updated = await client.query<ShopRow>(
        `UPDATE shop SET close_date = $2, status = 'ACTIVE', last_operated_by_account_id=$3, updated_at = clock_timestamp()
          WHERE id = $1 RETURNING *`,
        [shop.id, input.requestedCloseDate, input.actor.accountId],
      );
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop',
        objectId: shop.id,
        action: 'SHOP_RENEWED',
        result: 'SUCCEEDED',
        reason: isAdmin ? input.waiverReason!.trim() : null,
        requestId: input.requestId,
        before: { closeDate: shop.close_date },
        after: {
          closeDate: input.requestedCloseDate,
          originalAmountCents: original.toString(),
          chargedAmountCents: isAdmin ? '0' : original.toString(),
        },
      });
      const row = updated.rows[0];
      if (!row) throw new Error('续期失败');
      return view(row, isAdmin ? 'ADMIN' : 'ENTERPRISE');
    });
  }

  async rename(input: {
    readonly actor: Actor;
    readonly shopId: string;
    readonly name: string;
    readonly requestId: string;
  }): Promise<ShopView> {
    const names = normalizeShopName(input.name);
    return this.transactions.transaction(async (client) => {
      const result = await client.query<ShopRow>('SELECT * FROM shop WHERE id = $1 FOR UPDATE', [input.shopId]);
      const shop = result.rows[0];
      if (!shop) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      requireAllowed(authorizeShop(input.actor, { id: shop.id, enterpriseId: shop.enterprise_id, state: shop.status }, null, 'SHOP_RENAME'));
      if (shop.rename_count !== 0) throw new AppError('SHOP_RENAME_LIMIT', '每个店铺只能成功改名一次', 409);
      const updated = await client.query<ShopRow>(
        `UPDATE shop
            SET name = $2, normalized_name = $3, rename_count = 1,
                last_operated_by_account_id=$4, updated_at = clock_timestamp()
          WHERE id = $1 AND rename_count = 0 RETURNING *`,
        [shop.id, names.name, names.normalized, input.actor.accountId],
      );
      const row = updated.rows[0];
      if (!row) throw new AppError('SHOP_RENAME_CONFLICT', '店铺改名冲突', 409);
      await client.query(
        'INSERT INTO shop_name_history (shop_id, old_name, new_name, changed_by) VALUES ($1,$2,$3,$4)',
        [shop.id, shop.name, names.name, input.actor.accountId],
      );
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop',
        objectId: shop.id,
        action: 'SHOP_RENAMED',
        result: 'SUCCEEDED',
        reason: null,
        requestId: input.requestId,
        before: { name: shop.name },
        after: { name: names.name },
      });
      return view(row, input.actor.roles.has('ADMIN') ? 'ADMIN' : 'ENTERPRISE');
    });
  }

  async changeLifecycle(input: {
    readonly actor: Actor;
    readonly shopId: string;
    readonly action: 'TRASH' | 'RESTORE' | 'PURGE';
    readonly reason?: string;
    readonly requestId: string;
  }): Promise<ShopView> {
    return this.transactions.transaction(async (client) => {
      const result = await client.query<ShopRow>('SELECT * FROM shop WHERE id = $1 FOR UPDATE', [input.shopId]);
      const shop = result.rows[0];
      if (!shop) throw new AppError('RESOURCE_NOT_FOUND', '资源不存在或无权访问', 404);
      const capability = input.action === 'TRASH' ? 'SHOP_TRASH' : input.action === 'RESTORE' ? 'SHOP_RESTORE' : 'SHOP_PURGE';
      requireAllowed(
        authorizeShop(input.actor, { id: shop.id, enterpriseId: shop.enterprise_id, state: shop.status }, null, capability),
      );
      let updated: { rows: ShopRow[] };
      if (input.action === 'TRASH') {
        updated = await client.query<ShopRow>(
          `UPDATE shop SET status = 'TRASHED', trashed_at = clock_timestamp(),
             purge_after = clock_timestamp() + interval '30 days', last_operated_by_account_id=$2, updated_at = clock_timestamp()
           WHERE id = $1 AND status IN ('ACTIVE','EXPIRED_READONLY') RETURNING *`,
          [shop.id, input.actor.accountId],
        );
      } else if (input.action === 'RESTORE') {
        updated = await client.query<ShopRow>(
          `UPDATE shop SET status = CASE
             WHEN close_date <= timezone('Asia/Shanghai', clock_timestamp())::date THEN 'EXPIRED_READONLY'
               ELSE 'ACTIVE' END,
             trashed_at = NULL, purge_after = NULL, last_operated_by_account_id=$2, updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'TRASHED' AND purge_after > clock_timestamp() RETURNING *`,
          [shop.id, input.actor.accountId],
        );
      } else {
        updated = await client.query<ShopRow>(
          `UPDATE shop SET status = 'PURGED', purged_at = clock_timestamp(), last_operated_by_account_id=$2, updated_at = clock_timestamp()
           WHERE id = $1 AND status = 'TRASHED' AND purge_after <= clock_timestamp() RETURNING *`,
          [shop.id, input.actor.accountId],
        );
      }
      const row = updated.rows[0];
      if (!row) throw new AppError('SHOP_STATE_CONFLICT', '店铺当前状态不允许该操作', 409);
      await this.effects.audit(client, {
        actorAccountId: input.actor.accountId,
        actorRoles: [...input.actor.roles],
        objectType: 'shop',
        objectId: shop.id,
        action: `SHOP_${input.action}ED`,
        result: 'SUCCEEDED',
        reason: input.reason?.trim() || null,
        requestId: input.requestId,
        before: { state: shop.status },
        after: { state: row.status },
      });
      return view(row, input.actor.roles.has('ADMIN') ? 'ADMIN' : 'ENTERPRISE');
    });
  }

  private async refreshExpiredShops(): Promise<void> {
    await this.transactions.transaction(async (client) => {
      const expired = await client.query<{ id: string; close_date: string }>(
        `UPDATE shop SET status = 'EXPIRED_READONLY', updated_at = clock_timestamp()
          WHERE status = 'ACTIVE'
            AND close_date <= timezone('Asia/Shanghai', clock_timestamp())::date
          RETURNING id, close_date`,
      );
      for (const shop of expired.rows) {
        await this.effects.audit(client, {
          actorAccountId: null,
          actorRoles: [],
          objectType: 'shop',
          objectId: shop.id,
          action: 'SHOP_EXPIRED_READONLY',
          result: 'SUCCEEDED',
          reason: null,
          requestId: 'system:shop-expiry-refresh',
          before: { state: 'ACTIVE', closeDate: shop.close_date },
          after: { state: 'EXPIRED_READONLY' },
        });
      }
    });
  }
}
