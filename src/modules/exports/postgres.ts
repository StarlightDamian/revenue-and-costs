import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, rm, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import { withTransaction } from "../../db/pool.js";
import { AppError } from "../../shared/errors.js";
import { structuredLog } from "../../shared/structured-logger.js";
import { diagnosticReferenceId } from "../../shared/diagnostic-reference.js";
import type { Actor } from "../authorization/index.js";
import { AuthorizationError, authorizeShop, requireAllowed } from "../authorization/index.js";
import { CoreTransactionSideEffects } from "../authorization/events.js";
import {
  calculateCostAccounting,
  DEFAULT_CONTINENT_PREFIXES,
  findAccountingPreferences,
  formatMarketplaceForExport,
  normalizeAccountingAssumptions,
  normalizeAccountingPreferences,
  normalizeContinentPrefixes,
  type AccountingAssumptions,
  type AccountingPreferences,
  type CostAccountingResult,
} from "../accounting-preferences/index.js";
import type { EncryptedObjectStore } from "../storage/encrypted-object-store.js";
import { decimal, decimal8 } from "../../shared/decimal.js";
import {
  assertExportCapacityAvailable,
  estimateExportArtifactBytes,
  exportReport,
  REPORT_EXPORT_FORMAT,
  type ReportExportProgress,
} from "./export-report.js";
import { rowsFromArray, type ColumnDefinition, type ReportExportInput, type ReportRow, type ReportSection } from "./report-types.js";

const SUMMARY_COLUMNS: ColumnDefinition[] = [
  {key:"shop",header:"公司",width:28,kind:"text",maxBytes:512},{key:"period",header:"日期",width:16,kind:"text",maxBytes:24},
  {key:"platform",header:"平台",width:12,kind:"text",maxBytes:32},{key:"marketplace",header:"站点",width:12,kind:"text",maxBytes:512},
  {key:"currency",header:"原币币种",width:12,kind:"text",maxBytes:3},
  {key:"incomeOriginal",header:"收入总额-原币",width:16,kind:"decimal"},{key:"incomeCny",header:"收入总额-人民币",width:16,kind:"decimal"},
  {key:"refundOriginal",header:"退款金额-原币",width:16,kind:"decimal"},{key:"refundCny",header:"退款金额-人民币",width:16,kind:"decimal"},
  {key:"netOriginal",header:"收入净额-原币",width:16,kind:"decimal"},{key:"netCny",header:"收入净额-人民币",width:16,kind:"decimal"},
  {key:"withheldTaxOriginal",header:"商品税-原币",width:16,kind:"decimal"},{key:"withheldTaxCny",header:"商品税-人民币",width:16,kind:"decimal"},
  {key:"platformFeeOriginal",header:"平台费-原币",width:16,kind:"decimal"},{key:"platformFeeCny",header:"平台费-人民币",width:16,kind:"decimal"},
  {key:"fbaOriginal",header:"FBA发货费-原币",width:16,kind:"decimal"},{key:"fbaCny",header:"FBA发货费-人民币",width:16,kind:"decimal"},
  {key:"storageOriginal",header:"FBA仓储费-原币",width:16,kind:"decimal"},{key:"storageCny",header:"FBA仓储费-人民币",width:16,kind:"decimal"},
  {key:"advertisingOriginal",header:"广告费-原币",width:16,kind:"decimal"},{key:"advertisingCny",header:"广告费-人民币",width:16,kind:"decimal"},
  {key:"otherOriginal",header:"其他扣费-原币",width:16,kind:"decimal"},{key:"otherCny",header:"其他扣费-人民币",width:16,kind:"decimal"},
  {key:"expenseOriginal",header:"费用合计-原币",width:16,kind:"decimal"},{key:"expenseCny",header:"费用合计-人民币",width:16,kind:"decimal"},
  {key:"platformFeeRate",header:"平台扣费率",width:14,kind:"decimal"},{key:"salesCostRate",header:"销售成本率",width:14,kind:"decimal"},
  {key:"procurementOriginal",header:"采购成本-原币",width:16,kind:"decimal"},{key:"procurementCny",header:"采购成本-人民币",width:16,kind:"decimal"},
  {key:"profitRate",header:"利润率",width:14,kind:"decimal"},{key:"profitOriginal",header:"利润金额-原币",width:16,kind:"decimal"},{key:"profitCny",header:"利润金额-人民币",width:16,kind:"decimal"},
];
const COMPLETENESS_COLUMNS: ColumnDefinition[] = [
  {key:"marketplace",header:"站点",width:12,kind:"text",maxBytes:512},{key:"month",header:"月份",width:12,kind:"date",maxBytes:16},
  {key:"disposition",header:"完整性/处理",width:24,kind:"status",maxBytes:64},{key:"datasetVersionId",header:"数据版本",width:38,kind:"text",maxBytes:64},
];
const FEE_COLUMNS: ColumnDefinition[] = [
  {key:"marketplace",header:"站点",width:12,kind:"text",maxBytes:512},{key:"month",header:"月份",width:12,kind:"date",maxBytes:16},
  {key:"category",header:"费用类别",width:24,kind:"text",maxBytes:64},{key:"sourceRows",header:"来源行数",width:14,kind:"integer"},
  {key:"amountCny",header:"人民币金额",width:18,kind:"decimal"},
];
const AUDIT_COLUMNS: ColumnDefinition[] = [
  {key:"relativePath",header:"相对路径",width:42,kind:"text",maxBytes:1024},{key:"classification",header:"分类",width:16,kind:"text",maxBytes:64},
  {key:"parseStatus",header:"解析状态",width:18,kind:"status",maxBytes:64},{key:"readRows",header:"读取行数",width:14,kind:"integer"},
  {key:"insertedRows",header:"入库行数",width:14,kind:"integer"},{key:"excludedRows",header:"排除行数",width:14,kind:"integer"},
  {key:"errorRows",header:"错误行数",width:14,kind:"integer"},{key:"conservation",header:"行数守恒",width:14,kind:"status",maxBytes:16},
  {key:"sha256",header:"SHA-256",width:66,kind:"text",maxBytes:64},
];

function section(columns: readonly ColumnDefinition[], rows: readonly ReportRow[]): ReportSection { return { columns, source: rowsFromArray(rows) }; }

const ROLLUP_AMOUNT_KEYS = [
  "incomeOriginal", "incomeCny", "refundOriginal", "refundCny",
  "withheldTaxOriginal", "withheldTaxCny", "platformFeeOriginal", "platformFeeCny",
  "fbaOriginal", "fbaCny", "storageOriginal", "storageCny",
  "advertisingOriginal", "advertisingCny", "otherOriginal", "otherCny",
] as const;

function rollupFinancialRows(
  monthlyRows: readonly Record<string, string>[],
  kind: "quarter" | "year",
): Record<string, string>[] {
  const groups = new Map<string, { period: string; marketplace: string; currency: string; amounts: Map<string, ReturnType<typeof decimal>> }>();
  for (const row of monthlyRows) {
    if (row.currencyCount !== "1" || !row.currency) throw new Error("EXPORT_MULTIPLE_CURRENCIES_PER_SLICE");
    const period = kind === "quarter"
      ? `${row.period?.slice(0, 4)}-Q${Math.floor((Number(row.period?.slice(5, 7)) - 1) / 3) + 1}`
      : row.period?.slice(0, 4);
    if (!period || !row.marketplace) throw new Error("EXPORT_FINANCIAL_PERIOD_INVALID");
    const key = `${period}\0${row.marketplace}`;
    let group = groups.get(key);
    if (!group) {
      group = { period, marketplace: row.marketplace, currency: row.currency, amounts: new Map() };
      groups.set(key, group);
    } else if (group.currency !== row.currency) {
      throw new Error("EXPORT_MULTIPLE_CURRENCIES_PER_SLICE");
    }
    for (const amountKey of ROLLUP_AMOUNT_KEYS) {
      group.amounts.set(amountKey, (group.amounts.get(amountKey) ?? decimal("0")).add(decimal(row[amountKey] ?? "0")));
    }
  }
  return [...groups.values()]
    .sort((left, right) => left.period.localeCompare(right.period) || left.marketplace.localeCompare(right.marketplace))
    .map(({ period, marketplace, currency, amounts }) => {
      const value = (key: typeof ROLLUP_AMOUNT_KEYS[number]) => amounts.get(key) ?? decimal("0");
      const incomeOriginal = value("incomeOriginal");
      const incomeCny = value("incomeCny");
      const refundOriginal = value("refundOriginal");
      const refundCny = value("refundCny");
      const netOriginal = incomeOriginal.sub(refundOriginal);
      const netCny = incomeCny.sub(refundCny);
      const expenseOriginal = value("withheldTaxOriginal").add(value("platformFeeOriginal")).add(value("fbaOriginal"))
        .add(value("storageOriginal")).add(value("advertisingOriginal")).add(value("otherOriginal"));
      const expenseCny = value("withheldTaxCny").add(value("platformFeeCny")).add(value("fbaCny"))
        .add(value("storageCny")).add(value("advertisingCny")).add(value("otherCny"));
      const profitOriginal = netOriginal.sub(expenseOriginal);
      const profitCny = netCny.sub(expenseCny);
      return {
        period, marketplace, currency, currencyCount: "1",
        ...Object.fromEntries(ROLLUP_AMOUNT_KEYS.map((key) => [key, decimal8(value(key))])),
        netOriginal: decimal8(netOriginal), netCny: decimal8(netCny),
        expenseOriginal: decimal8(expenseOriginal), expenseCny: decimal8(expenseCny),
        platformFeeRate: netCny.isZero() ? "0" : decimal8(expenseCny.div(netCny)),
        salesCostRate: "0", procurementOriginal: "0", procurementCny: "0",
        profitRate: netCny.isZero() ? "0" : decimal8(profitCny.div(netCny)),
        profitOriginal: decimal8(profitOriginal), profitCny: decimal8(profitCny),
      };
    });
}
export interface ExportAssumptionInput {
  readonly profitRate?: string | null;
  readonly minimumSalesCostRate?: string | null;
  readonly continentPrefixes?: readonly string[];
}

interface ExportIdentity {
  readonly shopId: string;
  readonly snapshotId: string;
  readonly profitRate?: string | null;
  readonly minimumSalesCostRate?: string | null;
  readonly continentPrefixes?: readonly string[];
}

export interface CostAccountingPreviewRow extends CostAccountingResult {
  readonly period: string;
  readonly incomeTotalCny: string;
  readonly netIncomeCny: string;
  readonly platformExpensesCny: string;
}

export interface CostAccountingPreview {
  readonly snapshotId: string;
  readonly year: string;
  readonly assumptions: AccountingAssumptions;
  readonly rows: readonly CostAccountingPreviewRow[];
  readonly total: Omit<CostAccountingPreviewRow, "period">;
}

export function assertExportIdempotencyMatch(
  prior: ExportIdentity,
  requested: ExportIdentity,
): void {
  if (
    prior.shopId !== requested.shopId
    || prior.snapshotId !== requested.snapshotId
    || (prior.profitRate ?? null) !== (requested.profitRate ?? null)
    || (prior.minimumSalesCostRate ?? null) !== (requested.minimumSalesCostRate ?? null)
    || (prior.continentPrefixes ?? []).join(",") !== (requested.continentPrefixes ?? []).join(",")
  ) {
    throw new Error("IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXPORT");
  }
}
async function unlinkIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
type ShopStatus = "ACTIVE" | "EXPIRED_READONLY" | "TRASHED" | "PURGED";
type MembershipStatus = "ACTIVE" | "REVOKED" | "EXPIRED";
interface ExportAccessRow {
  id: string;
  enterprise_id: string;
  status: ShopStatus;
  membership_id: string | null;
  membership_status: MembershipStatus | null;
  export_allowed: boolean | null;
  authorization_epoch: string | null;
}

function requireExportAccess(actor: Actor, row: ExportAccessRow): void {
  requireAllowed(authorizeShop(
    actor,
    { id: row.id, enterpriseId: row.enterprise_id, state: row.status },
    row.membership_id ? {
      id: row.membership_id,
      shopId: row.id,
      accountId: actor.accountId,
      status: row.membership_status!,
      exportAllowed: row.export_allowed ?? false,
      authorizationEpoch: row.authorization_epoch!,
    } : null,
    "RESULT_EXPORT",
  ));
}

function downloadTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function systemExportRequestId(exportId: string): string {
  return `system:export.generate:${exportId}`;
}

export function exportDownloadFileName(shopName: string, outputKind: string): string {
  const safeName = shopName.normalize("NFKC").replaceAll(/[<>:"/\\|?*\p{Cc}]/gu, "_").trim().slice(0, 100) || "未命名公司";
  return `销售成本表-${safeName}.${outputKind === "ZIP" ? "zip" : "xlsx"}`;
}

export function exportOutputRoot(cwd: string, joinPath: (...parts: string[]) => string = join): string {
  return joinPath(cwd, ".work", "exports");
}

const SAFE_EXPORT_FAILURE_CODES = new Set([
  "EXPORT_GENERATION_FAILED",
  "EXPORT_CAPACITY_EVIDENCE_UNAVAILABLE",
  "EXPORT_CAPACITY_INSUFFICIENT",
  "EXPORT_AUDIT_CONSERVATION_COLUMN_MISSING",
  "EXPORT_CELL_BOUND_EXCEEDED",
  "EXPORT_COMPLETENESS_FAILED",
  "EXPORT_EXCEL_NUMERIC_PRECISION_EXCEEDED",
  "EXPORT_FEE_CONSERVATION_FAILED",
  "EXPORT_FORMAT_VERSION_UNSUPPORTED",
  "EXPORT_IMPORT_CONSERVATION_FAILED",
  "EXPORT_INCLUDED_SCOPE_MISMATCH",
  "EXPORT_NO_INCLUDED_SLICES",
  "EXPORT_OVERFLOW_DIRECTORY_REQUIRED",
  "EXPORT_QUERY_INVALID",
  "INVALID_EXPORT_DECIMAL",
  "INVALID_EXPORT_INTEGER",
  "INVALID_EXPORT_COLUMN_BOUND",
  "INVALID_EXPORT_SIZE_ESTIMATE",
  "INVALID_EXPORT_WORK_ID",
  "EXPORT_MARKETPLACE_CURRENCY_UNKNOWN",
  "EXPORT_MULTIPLE_CURRENCIES_PER_MARKETPLACE",
  "EXPORT_MULTIPLE_CURRENCIES_PER_SLICE",
  "EXPORT_ROW_COUNT_MISMATCH",
  "MEMBERSHIP_REVOKED",
  "SNAPSHOT_NOT_FOUND",
]);

const PERMANENT_EXPORT_FAILURE_CODES = new Set([
  ...SAFE_EXPORT_FAILURE_CODES,
]);
PERMANENT_EXPORT_FAILURE_CODES.delete("EXPORT_GENERATION_FAILED");
PERMANENT_EXPORT_FAILURE_CODES.delete("EXPORT_CAPACITY_EVIDENCE_UNAVAILABLE");

function exportFailureCandidate(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^42[A-Z0-9]{3}$/u.test(error.code)) {
    return "EXPORT_QUERY_INVALID";
  }
  const candidate = typeof error === "string" ? error : error instanceof AppError ? error.code : error instanceof Error ? error.message : "";
  return candidate.startsWith("EXPORT_CELL_BOUND_EXCEEDED:") ? "EXPORT_CELL_BOUND_EXCEEDED" : candidate;
}

export function safeExportFailureCode(error: unknown): string {
  const candidate = exportFailureCandidate(error);
  return SAFE_EXPORT_FAILURE_CODES.has(candidate) ? candidate : "EXPORT_GENERATION_FAILED";
}

export function isPermanentExportFailure(error: unknown): boolean {
  return PERMANENT_EXPORT_FAILURE_CODES.has(exportFailureCandidate(error));
}

type ExportProgressStage =
  | "QUEUED"
  | "VALIDATING"
  | "QUERYING"
  | ReportExportProgress["stage"]
  | "ENCRYPTING"
  | "COMMITTING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "REVOKED";

interface ExportProgressRow {
  readonly status: string;
  readonly stage?: ExportProgressStage;
  readonly progress_percent?: number | string;
  readonly processed_rows?: string;
  readonly total_rows?: string | null;
  readonly heartbeat_at?: Date | null;
}

function exportProgressProjection(row: ExportProgressRow): {
  progress: string;
  stage: ExportProgressStage;
  processedRows: string;
  totalRows: string | null;
  heartbeatAt: string | null;
} {
  const progress = row.status === "SUCCEEDED" ? "100" : String(row.progress_percent ?? 0);
  const fallbackStage = row.status === "RUNNING" ? "VALIDATING" : row.status as ExportProgressStage;
  return {
    progress,
    stage: row.stage ?? fallbackStage,
    processedRows: row.processed_rows ?? "0",
    totalRows: row.total_rows ?? null,
    heartbeatAt: row.heartbeat_at?.toISOString() ?? null,
  };
}

function exportProgressPercent(stage: ExportProgressStage, processedRows: bigint, totalRows: bigint | null): number {
  if (stage === "QUEUED") return 0;
  if (stage === "VALIDATING") return 1;
  if (stage === "QUERYING") return 3;
  if (stage === "WRITING_NOTES") return 5;
  if (["WRITING_MONTHLY", "WRITING_QUARTERLY", "WRITING_ANNUAL"].includes(stage)) {
    if (!totalRows || totalRows === 0n) return 5;
    return 5 + Number((processedRows * 85n) / totalRows);
  }
  if (stage === "WRITING_COST") return 92;
  if (stage === "FINALIZING_XLSX") return 94;
  if (stage === "HASHING") return 96;
  if (stage === "PACKAGING") return 97;
  if (stage === "ENCRYPTING") return 98;
  if (stage === "COMMITTING") return 99;
  if (stage === "SUCCEEDED") return 100;
  return 0;
}

interface CapacityStat {
  readonly bavail: bigint;
  readonly bsize: bigint;
}

export async function assertExportCapacity(
  root: string,
  input: ReportExportInput,
  readStatfs: (path: string) => Promise<CapacityStat> = async (path) => statfs(path, { bigint: true }),
): Promise<void> {
  let stats: CapacityStat;
  try {
    stats = await readStatfs(root);
  } catch {
    throw new Error("EXPORT_CAPACITY_EVIDENCE_UNAVAILABLE");
  }
  assertExportCapacityAvailable(stats.bavail * stats.bsize, estimateExportArtifactBytes(input));
}

export class PostgresExportService {
  private readonly effects = new CoreTransactionSideEffects();

  constructor(private readonly pool: Pool, private readonly store: EncryptedObjectStore, private readonly outputRoot: string) {}

  private async persistProgress(
    exportId: string,
    stage: ExportProgressStage,
    processedRows: bigint,
    totalRows: bigint | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE export_request
          SET stage=$2,processed_rows=$3,total_rows=$4,
              progress_percent=GREATEST(progress_percent,$5),heartbeat_at=clock_timestamp()
        WHERE id=$1 AND status='RUNNING'`,
      [exportId, stage, processedRows.toString(), totalRows?.toString() ?? null, exportProgressPercent(stage, processedRows, totalRows)],
    );
  }

  private async resolveAccountingAssumptions(
    accountId: string,
    input: ExportAssumptionInput,
    client: Pick<Pool, "query"> = this.pool,
  ): Promise<AccountingPreferences> {
    let defaults: AccountingPreferences = { profitRate: null, minimumSalesCostRate: null, continentPrefixes: DEFAULT_CONTINENT_PREFIXES };
    try {
      if (input.profitRate === undefined || input.minimumSalesCostRate === undefined || input.continentPrefixes === undefined) {
        const stored = await findAccountingPreferences(client, accountId);
        if (!stored) throw new AuthorizationError();
        defaults = stored;
      }
      return normalizeAccountingPreferences({
        profitRate: input.profitRate === undefined ? defaults.profitRate : input.profitRate,
        minimumSalesCostRate: input.minimumSalesCostRate === undefined
          ? defaults.minimumSalesCostRate
          : input.minimumSalesCostRate,
        continentPrefixes: normalizeContinentPrefixes(input.continentPrefixes ?? defaults.continentPrefixes),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("INVALID_ACCOUNTING_RATE:")) {
        throw new AppError("INVALID_ACCOUNTING_RATE", "比例必须在 0% 到 100% 之间，且最多保留 6 位百分比小数", 400);
      }
      if (error instanceof Error && error.message === "INVALID_CONTINENT_PREFIX") {
        throw new AppError("INVALID_CONTINENT_PREFIX", "大洲前缀无效", 400, "continentPrefixes");
      }
      throw error;
    }
  }

  private async auditFailure(
    actor: Actor,
    objectType: string,
    objectId: string,
    action: string,
    requestId: string,
    after: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.effects.audit(this.pool, {
      actorAccountId: actor.accountId,
      actorRoles: [...actor.roles],
      objectType,
      objectId,
      action,
      result: "FAILED",
      reason: null,
      requestId,
      before: null,
      after,
    });
  }

  async authorize(actor: Actor, shopId: string, exportId?: string) {
    const result=await this.pool.query<ExportAccessRow>(
      `SELECT s.id,s.enterprise_id,s.status,sm.id membership_id,sm.status membership_status,sm.export_allowed,sm.authorization_epoch::text
       FROM shop s LEFT JOIN shop_membership sm ON sm.shop_id=s.id AND sm.account_id=$2 WHERE s.id=$1`,[shopId,actor.accountId]);
    const row=result.rows[0]; if(!row) throw new AuthorizationError();
    requireExportAccess(actor, row);
    if(exportId){ const exported=await this.pool.query<{requested_by:string;membership_authorization_version:string|null;status:string}>("SELECT requested_by,membership_authorization_version::text,status FROM export_request WHERE id=$1 AND shop_id=$2",[exportId,shopId]); const job=exported.rows[0]; if(!job) throw new AuthorizationError(); this.requireExportJobActor(actor,row,job); }
    return row;
  }

  private async authorizeCreate(client: PoolClient, actor: Actor, shopId: string): Promise<ExportAccessRow> {
    // Membership management locks the parent shop before changing membership.
    // Keep the same order here, then hold both locks until export insertion so
    // a revocation cannot complete before a stale-epoch export is inserted.
    const shop = await client.query<{ id: string; enterprise_id: string; status: ShopStatus }>(
      "SELECT id,enterprise_id,status FROM shop WHERE id=$1 FOR SHARE",
      [shopId],
    );
    const membership = await client.query<{
      id: string;
      status: MembershipStatus;
      export_allowed: boolean;
      authorization_epoch: string;
    }>(
      `SELECT id,status,export_allowed,authorization_epoch::text
         FROM shop_membership
        WHERE shop_id=$1 AND account_id=$2
        FOR SHARE`,
      [shopId, actor.accountId],
    );
    const shopRow = shop.rows[0];
    if (!shopRow) throw new AuthorizationError();
    const membershipRow = membership.rows[0];
    const access: ExportAccessRow = {
      ...shopRow,
      membership_id: membershipRow?.id ?? null,
      membership_status: membershipRow?.status ?? null,
      export_allowed: membershipRow?.export_allowed ?? null,
      authorization_epoch: membershipRow?.authorization_epoch ?? null,
    };
    requireExportAccess(actor, access);
    return access;
  }

  private requireExportJobActor(
    actor: Actor,
    access: ExportAccessRow,
    job: { requested_by: string; membership_authorization_version: string | null; status: string },
  ): void {
    if (job.status === "REVOKED") throw new AuthorizationError();
    if (job.requested_by !== actor.accountId && !actor.roles.has("ADMIN") && !actor.enterpriseIds?.has(access.enterprise_id)) {
      throw new AuthorizationError();
    }
    const usesCustomerMembership = this.usesCustomerMembership(actor, access);
    if (usesCustomerMembership && access.membership_id && job.membership_authorization_version !== access.authorization_epoch) {
      throw new AuthorizationError();
    }
  }

  private usesCustomerMembership(actor: Actor, access: ExportAccessRow): boolean {
    return !actor.enterpriseIds?.has(access.enterprise_id) && !actor.roles.has("ADMIN");
  }

  async create(
    actor: Actor,
    shopId: string,
    snapshotId: string,
    idempotencyKey: string,
    requestId: string,
    assumptionInput: ExportAssumptionInput = {},
  ) {
    try {
      return await withTransaction(this.pool,async(client)=>{
        const access=await this.authorizeCreate(client,actor,shopId);
        const customerBinding=this.usesCustomerMembership(actor,access);
        const assumptions = await this.resolveAccountingAssumptions(actor.accountId, assumptionInput, client);
        const snap=await client.query("SELECT id FROM published_snapshot WHERE id=$1 AND shop_id=$2",[snapshotId,shopId]);
        if(!snap.rows[0]) throw new Error("SNAPSHOT_NOT_FOUND");
        const businessKey=`${actor.accountId}:${REPORT_EXPORT_FORMAT}:${idempotencyKey}`;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended('export.create:' || $1,0))",[businessKey]);
        const prior=await client.query<{id:string;shop_id:string;published_snapshot_id:string;status:string;output_kind:string|null;format_version:string;created_at:Date;profit_rate:string|null;minimum_sales_cost_rate:string|null;continent_prefixes:string[];stage:ExportProgressStage;progress_percent:number;processed_rows:string;total_rows:string|null;heartbeat_at:Date|null}>(
          "SELECT id,shop_id,published_snapshot_id,status,output_kind,format_version,created_at,profit_rate::text,minimum_sales_cost_rate::text,continent_prefixes,stage,progress_percent,processed_rows::text,total_rows::text,heartbeat_at FROM export_request WHERE business_key=$1",
          [businessKey],
        );
        let row=prior.rows[0];
        const replayed=Boolean(row);
        if(row){
          if (row.format_version !== REPORT_EXPORT_FORMAT) {
            throw new AppError("EXPORT_FORMAT_IDEMPOTENCY_CONFLICT", "该幂等键属于旧版导出，请重新发起当前版本下载", 409);
          }
          assertExportIdempotencyMatch(
            {shopId:row.shop_id,snapshotId:row.published_snapshot_id,profitRate:row.profit_rate,minimumSalesCostRate:row.minimum_sales_cost_rate,continentPrefixes:row.continent_prefixes},
            {shopId,snapshotId,...assumptions},
          );
        }else{
          row=(await client.query<{id:string;shop_id:string;published_snapshot_id:string;status:string;output_kind:string|null;format_version:string;created_at:Date;profit_rate:string|null;minimum_sales_cost_rate:string|null;continent_prefixes:string[];stage:ExportProgressStage;progress_percent:number;processed_rows:string;total_rows:string|null;heartbeat_at:Date|null}>(
            `INSERT INTO export_request(shop_id,requested_by,published_snapshot_id,membership_authorization_version,status,business_key,format_version,profit_rate,minimum_sales_cost_rate,continent_prefixes,expires_at)
             VALUES($1,$2,$3,$4,'QUEUED',$5,$6,$7::numeric,$8::numeric,$9::text[],clock_timestamp()+interval '7 days')
             RETURNING id,shop_id,published_snapshot_id,status,output_kind,format_version,created_at,profit_rate::text,minimum_sales_cost_rate::text,continent_prefixes,stage,progress_percent,processed_rows::text,total_rows::text,heartbeat_at`,
            [shopId,actor.accountId,snapshotId,customerBinding?access.authorization_epoch:null,businessKey,REPORT_EXPORT_FORMAT,assumptions.profitRate,assumptions.minimumSalesCostRate,assumptions.continentPrefixes],
          )).rows[0];
        }
        if(!row) throw new Error("EXPORT_CREATE_FAILED");
        await client.query(`INSERT INTO outbox_event(id,topic,business_key,payload) VALUES($1,'export.generate',$2,$3::jsonb) ON CONFLICT(topic,business_key) DO NOTHING`,[randomUUID(),row.id,JSON.stringify({exportId:row.id})]);
        await this.effects.audit(client, {
          actorAccountId: actor.accountId,
          actorRoles: [...actor.roles],
          objectType: "export_request",
          objectId: row.id,
          action: replayed ? "EXPORT_CREATE_REPLAYED" : "EXPORT_CREATED",
          result: "SUCCEEDED",
          reason: null,
          requestId,
          before: null,
          after: { shopId, snapshotId, status: row.status, formatVersion: REPORT_EXPORT_FORMAT, ...assumptions },
        });
        return {id:row.id,shopId:row.shop_id,snapshotId:row.published_snapshot_id,status:row.status,...exportProgressProjection(row),format:row.output_kind??'XLSX',isCurrentFormat:row.format_version===REPORT_EXPORT_FORMAT,createdAt:row.created_at.toISOString(),...assumptions};
      });
    } catch (error) {
      await this.auditFailure(actor, "published_snapshot", snapshotId, "EXPORT_CREATE_FAILED", requestId, { shopId });
      throw error;
    }
  }
  async createCurrent(
    actor: Actor,
    shopId: string,
    idempotencyKey: string,
    requestId: string,
    assumptionInput: ExportAssumptionInput = {},
  ) {
    const startedAt = Date.now();
    try {
      const access = await this.authorize(actor, shopId);
      const assumptions = await this.resolveAccountingAssumptions(actor.accountId, assumptionInput);
      const pointer = await this.pool.query<{ published_snapshot_id: string }>(
        "SELECT published_snapshot_id FROM shop_current_published_snapshot WHERE shop_id=$1",
        [shopId],
      );
      const snapshotId = pointer.rows[0]?.published_snapshot_id;
      if (!snapshotId) throw new AppError("PUBLISHED_SNAPSHOT_NOT_FOUND", "当前公司还没有可导出的正式结果", 409);
      structuredLog("info", "api", "export_current_snapshot_resolved", { durationMs: Date.now() - startedAt });
      const reusable = await this.pool.query<{
        id: string; shop_id: string; published_snapshot_id: string; status: string;
        output_kind: string | null; created_at: Date; requested_by: string;
        membership_authorization_version: string | null;
        profit_rate: string | null; minimum_sales_cost_rate: string | null;
        continent_prefixes: string[];
        stage: ExportProgressStage; progress_percent: number; processed_rows: string;
        total_rows: string | null; heartbeat_at: Date | null;
      }>(
        `SELECT id,shop_id,published_snapshot_id,status,output_kind,created_at,requested_by,
                membership_authorization_version::text,profit_rate::text,minimum_sales_cost_rate::text,continent_prefixes,
                stage,progress_percent,processed_rows::text,total_rows::text,heartbeat_at
           FROM export_request
          WHERE shop_id=$1 AND requested_by=$2 AND published_snapshot_id=$3
            AND format_version=$4
            AND profit_rate IS NOT DISTINCT FROM $5::numeric
            AND minimum_sales_cost_rate IS NOT DISTINCT FROM $6::numeric
            AND continent_prefixes=$7::text[]
            AND expires_at>clock_timestamp()
            AND (status IN ('QUEUED','RUNNING') OR (status='SUCCEEDED' AND output_object_id IS NOT NULL))
          ORDER BY CASE status WHEN 'SUCCEEDED' THEN 0 WHEN 'RUNNING' THEN 1 ELSE 2 END,created_at DESC
          LIMIT 1`,
        [shopId, actor.accountId, snapshotId, REPORT_EXPORT_FORMAT, assumptions.profitRate, assumptions.minimumSalesCostRate, assumptions.continentPrefixes],
      );
      const existing = reusable.rows[0];
      if (existing) {
        this.requireExportJobActor(actor, access, existing);
        structuredLog("info", "api", "export_current_reused", {
          reuseStatus: existing.status,
          durationMs: Date.now() - startedAt,
        });
        return {
          id: existing.id,
          shopId: existing.shop_id,
          snapshotId: existing.published_snapshot_id,
          status: existing.status,
          ...exportProgressProjection(existing),
          format: existing.output_kind ?? "XLSX",
          isCurrentFormat: true,
          createdAt: existing.created_at.toISOString(),
          ...assumptions,
        };
      }
      const result = await this.create(actor, shopId, snapshotId, idempotencyKey, requestId, assumptions);
      structuredLog("info", "api", "export_current_created", { replayStatus: result.status, durationMs: Date.now() - startedAt });
      return result;
    } catch (error) {
      structuredLog("error", "api", "export_current_failed", { errorType: error instanceof Error ? error.name : "UnknownError", durationMs: Date.now() - startedAt });
      throw error;
    }
  }
  async list(actor:Actor,shopId:string){ await this.authorize(actor,shopId); const result=await this.pool.query<{id:string;published_snapshot_id:string;status:string;output_kind:string|null;format_version:string;created_at:Date;error_code:string|null;profit_rate:string|null;minimum_sales_cost_rate:string|null;continent_prefixes:string[];stage:ExportProgressStage;progress_percent:number;processed_rows:string;total_rows:string|null;heartbeat_at:Date|null}>("SELECT id,published_snapshot_id,status,output_kind,format_version,created_at,error_code,profit_rate::text,minimum_sales_cost_rate::text,continent_prefixes,stage,progress_percent,processed_rows::text,total_rows::text,heartbeat_at FROM export_request WHERE shop_id=$1 AND requested_by=$2 ORDER BY created_at DESC LIMIT 100",[shopId,actor.accountId]); return result.rows.map(row=>({id:row.id,shopId,snapshotId:row.published_snapshot_id,status:row.status,...exportProgressProjection(row),format:row.output_kind??'XLSX',isCurrentFormat:row.format_version===REPORT_EXPORT_FORMAT,createdAt:row.created_at.toISOString(),profitRate:row.profit_rate,minimumSalesCostRate:row.minimum_sales_cost_rate,continentPrefixes:row.continent_prefixes,...(row.error_code?{error:safeExportFailureCode(row.error_code)}:{})})); }

  async previewCostAccounting(
    actor: Actor,
    shopId: string,
    assumptionInput: ExportAssumptionInput = {},
  ): Promise<CostAccountingPreview> {
    await this.authorize(actor, shopId);
    const assumptions = await this.resolveAccountingAssumptions(actor.accountId, assumptionInput);
    const pointer = await this.pool.query<{
      published_snapshot_id: string;
      calculation_run_id: string;
      year: string;
    }>(
      `SELECT current.published_snapshot_id,snapshot.calculation_run_id,
              to_char(min(slice.local_month),'YYYY') AS year
         FROM shop_current_published_snapshot current
         JOIN published_snapshot snapshot ON snapshot.id=current.published_snapshot_id
         JOIN published_snapshot_slice published_slice ON published_slice.published_snapshot_id=snapshot.id
         JOIN dataset_slice slice ON slice.id=published_slice.dataset_slice_id
        WHERE current.shop_id=$1
        GROUP BY current.published_snapshot_id,snapshot.calculation_run_id`,
      [shopId],
    );
    const current = pointer.rows[0];
    if (!current) throw new AppError("PUBLISHED_SNAPSHOT_NOT_FOUND", "当前公司还没有可预览的正式结果", 409);
    const actual = await this.aggregateMonthlyFinancialRows(current.calculation_run_id);
    const monthly = new Map<string, {
      income: ReturnType<typeof decimal>;
      net: ReturnType<typeof decimal>;
      expenses: ReturnType<typeof decimal>;
    }>(Array.from({ length: 12 }, (_, index) => {
      const period = `${current.year}-${String(index + 1).padStart(2, "0")}`;
      return [period, {
        income: decimal("0"),
        net: decimal("0"),
        expenses: decimal("0"),
      }];
    }));
    for (const row of actual) {
      if (!row.period) continue;
      const bucket = monthly.get(row.period);
      if (!bucket) continue;
      bucket.income = bucket.income.add(decimal(row.incomeCny ?? "0"));
      bucket.net = bucket.net.add(decimal(row.netCny ?? "0"));
      bucket.expenses = bucket.expenses.add(decimal(row.expenseCny ?? "0"));
    }
    const rows = [...monthly.entries()].map(([period, values]): CostAccountingPreviewRow => {
      const inputs = {
        incomeTotalCny: decimal8(values.income),
        netIncomeCny: decimal8(values.net),
        platformExpensesCny: decimal8(values.expenses),
      };
      return { period, ...inputs, ...calculateCostAccounting(inputs, assumptions) };
    });
    const totals = rows.reduce((sum, row) => ({
      income: sum.income.add(decimal(row.incomeTotalCny)),
      net: sum.net.add(decimal(row.netIncomeCny)),
      expenses: sum.expenses.add(decimal(row.platformExpensesCny)),
      procurement: sum.procurement.add(decimal(row.procurementCny)),
      profit: sum.profit.add(decimal(row.profitCny)),
      targetProfit: sum.targetProfit.add(decimal(row.targetProfitCny ?? "0")),
      minimumAdjusted: sum.minimumAdjusted || row.minimumAdjusted,
    }), {
      income: decimal("0"), net: decimal("0"), expenses: decimal("0"), procurement: decimal("0"),
      profit: decimal("0"), targetProfit: decimal("0"), minimumAdjusted: false,
    });
    return {
      snapshotId: current.published_snapshot_id,
      year: current.year,
      assumptions,
      rows,
      total: {
        incomeTotalCny: decimal8(totals.income),
        netIncomeCny: decimal8(totals.net),
        platformExpensesCny: decimal8(totals.expenses),
        targetProfitCny: assumptions.profitRate === null ? null : decimal8(totals.targetProfit),
        profitCny: decimal8(totals.profit),
        procurementCny: decimal8(totals.procurement),
        salesCostRate: totals.income.greaterThan(0) ? decimal8(totals.procurement.div(totals.income)) : decimal8(0),
        minimumAdjusted: totals.minimumAdjusted,
      },
    };
  }
  async cancel(actor:Actor,id:string,requestId:string){
    try {
      await withTransaction(this.pool,async(client)=>{
        const located=await client.query<{shop_id:string}>("SELECT shop_id FROM export_request WHERE id=$1",[id]);
        const shopId=located.rows[0]?.shop_id;if(!shopId)throw new AuthorizationError();
        const access=await this.authorizeCreate(client,actor,shopId);
        const exported=await client.query<{requested_by:string;membership_authorization_version:string|null;status:string}>("SELECT requested_by,membership_authorization_version::text,status FROM export_request WHERE id=$1 AND shop_id=$2 FOR UPDATE",[id,shopId]);
        const job=exported.rows[0];if(!job)throw new AuthorizationError();this.requireExportJobActor(actor,access,job);
        const updated=await client.query<{status:string}>("UPDATE export_request SET status='CANCELLED',stage='CANCELLED',finished_at=clock_timestamp(),heartbeat_at=clock_timestamp() WHERE id=$1 AND status IN('QUEUED','RUNNING') RETURNING status",[id]);
        const changed=Boolean(updated.rows[0]);
        await this.effects.audit(client, {
          actorAccountId: actor.accountId, actorRoles: [...actor.roles], objectType: "export_request", objectId: id,
          action: changed?"EXPORT_CANCELLED":"EXPORT_CANCEL_NOOP", result: "SUCCEEDED", reason: null, requestId,
          before: { status: job.status }, after: { status: updated.rows[0]?.status ?? job.status },
        });
      });
    } catch (error) {
      await this.auditFailure(actor,"export_request",id,"EXPORT_CANCEL_FAILED",requestId,{});
      throw error;
    }
  }

  async createDownloadToken(actor:Actor,id:string,requestId:string):Promise<string>{
    const token=randomBytes(32).toString("base64url");
    const tokenHash=downloadTokenHash(token);
    try {
      await withTransaction(this.pool,async(client)=>{
        const located=await client.query<{shop_id:string}>("SELECT shop_id FROM export_request WHERE id=$1",[id]);
        const shopId=located.rows[0]?.shop_id;if(!shopId)throw new AuthorizationError();
        const access=await this.authorizeCreate(client,actor,shopId);
        const exported=await client.query<{requested_by:string;membership_authorization_version:string|null;status:string}>("SELECT requested_by,membership_authorization_version::text,status FROM export_request WHERE id=$1 AND shop_id=$2 FOR UPDATE",[id,shopId]);
        const job=exported.rows[0];if(!job)throw new AuthorizationError();this.requireExportJobActor(actor,access,job);
        if(job.status!=="SUCCEEDED")throw new AppError("EXPORT_NOT_READY","导出尚未完成",409);
        const customerBinding=this.usesCustomerMembership(actor,access);
        await client.query(
          `INSERT INTO export_download_grant
            (export_request_id,shop_id,account_id,membership_id,membership_authorization_version,token_hash,expires_at)
           VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '5 minutes')`,
          [id,shopId,actor.accountId,customerBinding?access.membership_id:null,customerBinding?access.authorization_epoch:null,tokenHash],
        );
        await this.effects.audit(client, {
          actorAccountId: actor.accountId, actorRoles: [...actor.roles], objectType: "export_request", objectId: id,
          action: "EXPORT_DOWNLOAD_TOKEN_CREATED", result: "SUCCEEDED", reason: null, requestId,
          before: null, after: { expiresInSeconds: 300 },
        });
      });
      return token;
    } catch (error) {
      await this.auditFailure(actor,"export_request",id,"EXPORT_DOWNLOAD_TOKEN_CREATE_FAILED",requestId,{});
      throw error;
    }
  }

  async download(actor:Actor,id:string,token:string,requestId:string){
    const tokenHash=downloadTokenHash(token);
    try {
      const file=await withTransaction(this.pool,async(client)=>{
        const located=await client.query<{shop_id:string}>("SELECT shop_id FROM export_download_grant WHERE export_request_id=$1 AND token_hash=$2 AND account_id=$3",[id,tokenHash,actor.accountId]);
        const shopId=located.rows[0]?.shop_id;if(!shopId)throw new AuthorizationError();
        const access=await this.authorizeCreate(client,actor,shopId);
        const exported=await client.query<{requested_by:string;membership_authorization_version:string|null;status:string;storage_path:string|null;output_kind:string|null;encryption_context:Record<string,string>|null;plaintext_size:string|null;shop_name:string}>(
          `SELECT er.requested_by,er.membership_authorization_version::text,er.status,so.storage_path,er.output_kind,so.encryption_context,so.plaintext_size,s.name shop_name
             FROM export_request er LEFT JOIN stored_object so ON so.id=er.output_object_id JOIN shop s ON s.id=er.shop_id
            WHERE er.id=$1 AND er.shop_id=$2 FOR SHARE OF er`,[id,shopId]);
        const job=exported.rows[0];if(!job)throw new AuthorizationError();this.requireExportJobActor(actor,access,job);
        if(job.status!=="SUCCEEDED"||!job.storage_path||!job.output_kind||!job.encryption_context||!job.plaintext_size)throw new AuthorizationError();
        const customerBinding=this.usesCustomerMembership(actor,access);
        const consumed=await client.query<{id:string}>(
          `UPDATE export_download_grant SET consumed_at=clock_timestamp()
            WHERE export_request_id=$1 AND token_hash=$2 AND account_id=$3
              AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>clock_timestamp()
              AND (($4::uuid IS NULL AND membership_id IS NULL)
                OR (membership_id=$4 AND membership_authorization_version::text=$5))
            RETURNING id`,
          [id,tokenHash,actor.accountId,customerBinding?access.membership_id:null,customerBinding?access.authorization_epoch:null],
        );
        if(!consumed.rows[0])throw new AuthorizationError();
        await this.effects.audit(client, {
          actorAccountId: actor.accountId, actorRoles: [...actor.roles], objectType: "export_request", objectId: id,
          action: "EXPORT_DOWNLOAD_AUTHORIZED", result: "SUCCEEDED", reason: null, requestId,
          before: { tokenState: "ACTIVE" }, after: { tokenState: "CONSUMED" },
        });
        return {storagePath:job.storage_path,outputKind:job.output_kind,encryptionContext:job.encryption_context,contentLength:job.plaintext_size,shopName:job.shop_name};
      });
      return {stream:this.store.createDecryptionStream(file.storagePath,file.encryptionContext),fileName:exportDownloadFileName(file.shopName,file.outputKind),mediaType:file.outputKind==='ZIP'?'application/zip':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',contentLength:file.contentLength};
    } catch (error) {
      await this.auditFailure(actor,"export_request",id,"EXPORT_DOWNLOAD_FAILED",requestId,{});
      throw error;
    }
  }

  private async cleanupWorkFiles(exportId: string): Promise<void> {
    await Promise.all([
      unlinkIfPresent(join(this.outputRoot, `${exportId}.report`)),
      rm(join(this.outputRoot, `.export-${exportId}`), { recursive: true, force: true }),
    ]);
  }

  private async cleanupUncommittedObject(exportId: string): Promise<void> {
    let referenced = true;
    try {
      const result = await this.pool.query<{ referenced: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM stored_object WHERE id=$1) AS referenced",
        [exportId],
      );
      // Missing or malformed database evidence is uncertainty, not permission
      // to delete an object that may already have committed.
      referenced = result.rows[0]?.referenced ?? true;
    } catch {
      return;
    }
    if (!referenced) await this.store.removeUncommitted(exportId);
  }

  private async cleanupUncommitted(exportId: string): Promise<void> {
    await Promise.all([
      this.cleanupWorkFiles(exportId),
      this.cleanupUncommittedObject(exportId),
    ]);
  }

  async fail(exportId: string, error: unknown): Promise<void> {
    const errorCode = safeExportFailureCode(error);
    await withTransaction(this.pool, async (client) => {
      const current = await client.query<{ status: string; requested_by: string }>(
        "SELECT status,requested_by FROM export_request WHERE id=$1 FOR UPDATE",
        [exportId],
      );
      const row = current.rows[0];
      if (!row || !["QUEUED", "RUNNING"].includes(row.status)) return;
      await client.query(
        "UPDATE export_request SET status='FAILED',stage='FAILED',error_code=$2,finished_at=clock_timestamp(),heartbeat_at=clock_timestamp() WHERE id=$1",
        [exportId, errorCode],
      );
      await this.effects.audit(client, {
        actorAccountId: null,
        actorRoles: ["SYSTEM"],
        objectType: "export_request",
        objectId: exportId,
        action: "EXPORT_GENERATION_FAILED",
        result: "FAILED",
        reason: null,
        requestId: systemExportRequestId(exportId),
        before: { status: row.status },
        after: { status: "FAILED", initiatedBy: row.requested_by, errorCode },
      });
    });
    await this.cleanupUncommitted(exportId);
  }

  async generate(exportId: string): Promise<void> {
    const claimed = await this.pool.query<{ shop_id: string; published_snapshot_id: string; requested_by: string; format_version: string; profit_rate: string | null; minimum_sales_cost_rate: string | null; continent_prefixes: string[] }>(
      "UPDATE export_request SET status='RUNNING',stage='VALIDATING',progress_percent=1,processed_rows=0,total_rows=NULL,heartbeat_at=clock_timestamp(),started_at=COALESCE(started_at,clock_timestamp()),error_code=NULL,finished_at=NULL WHERE id=$1 AND status IN ('QUEUED','RUNNING') RETURNING shop_id,published_snapshot_id,requested_by,format_version,profit_rate::text,minimum_sales_cost_rate::text,continent_prefixes",
      [exportId],
    );
    const job = claimed.rows[0];
    if (!job) {
      const existing = await this.pool.query<{ status: string }>("SELECT status FROM export_request WHERE id=$1", [exportId]);
      if (["FAILED", "CANCELLED", "REVOKED"].includes(existing.rows[0]?.status ?? "")) await this.cleanupUncommitted(exportId);
      return;
    }
    if (job.format_version !== REPORT_EXPORT_FORMAT) {
      await this.fail(exportId, "EXPORT_FORMAT_VERSION_UNSUPPORTED");
      return;
    }
    await this.cleanupUncommitted(exportId);
    const plain = join(this.outputRoot, `${exportId}.report`);
    const objectId = exportId;
    let objectCommitted = false;
    let currentProcessedRows = 0n;
    let currentTotalRows: bigint | null = null;
    let lastPersistedAt = 0;
    let lastPersistedStage: ExportProgressStage | null = null;
    let lastPersistedRows = -1n;
    const reportProgress = async (
      stage: ExportProgressStage,
      processedRows = currentProcessedRows,
      totalRows = currentTotalRows,
    ): Promise<void> => {
      currentProcessedRows = processedRows;
      currentTotalRows = totalRows;
      const now = Date.now();
      const force = stage !== lastPersistedStage
        || processedRows === totalRows
        || processedRows - lastPersistedRows >= 1_000n
        || now - lastPersistedAt >= 1_000;
      if (!force) return;
      await this.persistProgress(exportId, stage, processedRows, totalRows);
      lastPersistedStage = stage;
      lastPersistedRows = processedRows;
      lastPersistedAt = now;
    };
    let heartbeatInFlight: Promise<void> | null = null;
    const heartbeatTimer = setInterval(() => {
      if (heartbeatInFlight) return;
      heartbeatInFlight = this.pool.query(
        "UPDATE export_request SET heartbeat_at=clock_timestamp() WHERE id=$1 AND status='RUNNING'",
        [exportId],
      ).then(() => undefined).catch(() => undefined).finally(() => { heartbeatInFlight = null; });
    }, 5_000);
    heartbeatTimer.unref();
    try {
      await reportProgress("QUERYING");
      const input = await this.buildInput(job.shop_id, job.published_snapshot_id, {
        profitRate: job.profit_rate,
        minimumSalesCostRate: job.minimum_sales_cost_rate,
        continentPrefixes: normalizeContinentPrefixes(job.continent_prefixes),
      }, exportId);
      await mkdir(this.outputRoot, { recursive: true });
      await assertExportCapacity(this.outputRoot, input);
      const result = await exportReport(input, plain, {
        workDirectory: this.outputRoot,
        workId: exportId,
        onProgress: async (progress) => reportProgress(progress.stage, progress.processedRows, progress.totalRows),
      });
      await reportProgress("ENCRYPTING");
      const meta = await this.store.putFile(result.path, objectId, { kind: "EXPORT", exportId, snapshotId: job.published_snapshot_id });
      await reportProgress("COMMITTING");
      objectCommitted = await withTransaction(this.pool, async (client) => {
        const state = await client.query<{ status: string }>("SELECT status FROM export_request WHERE id=$1 FOR UPDATE", [exportId]);
        if (state.rows[0]?.status !== "RUNNING") return false;
        await client.query(
          `INSERT INTO stored_object(id,object_kind,owner_shop_id,immutable_key,storage_path,plaintext_size,plaintext_sha256,ciphertext_sha256,encryption_format,encryption_context,verification_status)
           VALUES($1,'EXPORT',$2,$3,$4,$5,$6,$7,'AWS_ESDK_V2_FRAMED',$8::jsonb,'LOCAL_VERIFIED')`,
          [objectId, job.shop_id, `export/${exportId}`, meta.path, meta.plaintextSize.toString(), meta.plaintextSha256, meta.ciphertextSha256, JSON.stringify(meta.encryptionContext)],
        );
        await client.query(
          "UPDATE export_request SET status='SUCCEEDED',stage='SUCCEEDED',progress_percent=100,processed_rows=COALESCE(total_rows,processed_rows),output_object_id=$2,output_kind=$3,finished_at=clock_timestamp(),heartbeat_at=clock_timestamp() WHERE id=$1",
          [exportId, objectId, result.kind],
        );
        for (const [index, file] of result.files.entries()) {
          await client.query(
            "INSERT INTO export_file_manifest(export_request_id,ordinal,file_name,media_type,byte_size,sha256,row_count) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [exportId, index, file.name, file.mediaType, file.bytes, file.sha256, file.rows ?? null],
          );
        }
        await this.effects.audit(client, {
          actorAccountId: null,
          actorRoles: ["SYSTEM"],
          objectType: "export_request",
          objectId: exportId,
          action: "EXPORT_GENERATED",
          result: "SUCCEEDED",
          reason: null,
          requestId: systemExportRequestId(exportId),
          before: { status: "RUNNING" },
          after: { status: "SUCCEEDED", initiatedBy: job.requested_by, outputKind: result.kind },
        });
        return true;
      });
    } finally {
      clearInterval(heartbeatTimer);
      await heartbeatInFlight;
      if (objectCommitted) {
        await this.cleanupWorkFiles(exportId);
      } else {
        await this.cleanupUncommitted(exportId);
      }
    }
  }

  private async aggregateMonthlyFinancialRows(calculationRunId: string): Promise<Record<string, string>[]> {
    const result = await this.pool.query<Record<string, string>>(
      `WITH component_amount AS (
         SELECT to_char(ds.local_month,'YYYY-MM') period,ds.normalized_marketplace marketplace,
                COALESCE(tf.currency,sf.currency) currency,r.component,
                sum(CASE WHEN r.component='INCOME' THEN r.amount_original ELSE -r.amount_original END) amount_original,
                sum(r.amount_cny) amount_cny
           FROM calculation_fact_result r
           JOIN dataset_version dv ON dv.id=r.dataset_version_id
           JOIN dataset_slice ds ON ds.id=dv.dataset_slice_id
           LEFT JOIN transaction_fact tf ON r.fact_kind='TRANSACTION' AND tf.id=r.fact_id
           LEFT JOIN shipment_fact sf ON r.fact_kind='SHIPMENT' AND sf.id=r.fact_id
          WHERE r.calculation_run_id=$1
          GROUP BY period,ds.normalized_marketplace,COALESCE(tf.currency,sf.currency),r.component
       ), pivot AS (
         SELECT period,marketplace,min(currency) currency,count(DISTINCT currency) currency_count,
           COALESCE(sum(amount_original) FILTER(WHERE component='INCOME'),0) income_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='INCOME'),0) income_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='REFUND'),0) refund_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='REFUND'),0) refund_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='WITHHELD_TAX'),0) tax_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='WITHHELD_TAX'),0) tax_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='PLATFORM_FEE'),0) platform_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='PLATFORM_FEE'),0) platform_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='FBA_FULFILLMENT_FEE'),0) fba_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='FBA_FULFILLMENT_FEE'),0) fba_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='FBA_STORAGE_FEE'),0) storage_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='FBA_STORAGE_FEE'),0) storage_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='ADVERTISING_FEE'),0) advertising_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='ADVERTISING_FEE'),0) advertising_cny,
           COALESCE(sum(amount_original) FILTER(WHERE component='OTHER_DEDUCTION'),0) other_original,
           COALESCE(sum(amount_cny) FILTER(WHERE component='OTHER_DEDUCTION'),0) other_cny
         FROM component_amount GROUP BY period,marketplace
       ), totals AS (
         SELECT *,income_original-refund_original net_original,income_cny-refund_cny net_cny,
           tax_original+platform_original+fba_original+storage_original+advertising_original+other_original expense_original,
           tax_cny+platform_cny+fba_cny+storage_cny+advertising_cny+other_cny expense_cny
         FROM pivot
       )
       SELECT period,marketplace,currency,currency_count::text "currencyCount",
         income_original::text "incomeOriginal",income_cny::text "incomeCny",refund_original::text "refundOriginal",refund_cny::text "refundCny",
         net_original::text "netOriginal",net_cny::text "netCny",tax_original::text "withheldTaxOriginal",tax_cny::text "withheldTaxCny",
         platform_original::text "platformFeeOriginal",platform_cny::text "platformFeeCny",fba_original::text "fbaOriginal",fba_cny::text "fbaCny",
         storage_original::text "storageOriginal",storage_cny::text "storageCny",advertising_original::text "advertisingOriginal",advertising_cny::text "advertisingCny",
         other_original::text "otherOriginal",other_cny::text "otherCny",expense_original::text "expenseOriginal",expense_cny::text "expenseCny",
         CASE WHEN net_cny=0 THEN 0 ELSE round(expense_cny/net_cny,8) END::text "platformFeeRate",
         0::numeric::text "salesCostRate",0::numeric::text "procurementOriginal",0::numeric::text "procurementCny",
         CASE WHEN net_cny=0 THEN 0 ELSE round((net_cny-expense_cny)/net_cny,8) END::text "profitRate",
         (net_original-expense_original)::text "profitOriginal",(net_cny-expense_cny)::text "profitCny"
       FROM totals ORDER BY period,marketplace`,
      [calculationRunId],
    );
    for (const row of result.rows) if (row.currencyCount !== "1") throw new Error("EXPORT_MULTIPLE_CURRENCIES_PER_SLICE");
    return result.rows;
  }

  private async buildInput(
    shopId: string,
    snapshotId: string,
    preferences: AccountingPreferences = { profitRate: null, minimumSalesCostRate: null, continentPrefixes: DEFAULT_CONTINENT_PREFIXES },
    exportId?: string,
  ): Promise<ReportExportInput> {
    const header = await this.pool.query<{ shop_name: string; manifest: Record<string, unknown>; manifest_sha256: string; calculation_run_id: string; published_at: Date }>(
      "SELECT sh.name shop_name,s.manifest,encode(integrity.canonical_manifest_sha256,'hex') manifest_sha256,s.calculation_run_id,s.published_at FROM published_snapshot s JOIN published_snapshot_integrity integrity ON integrity.published_snapshot_id=s.id JOIN shop sh ON sh.id=s.shop_id WHERE s.id=$1 AND s.shop_id=$2",
      [snapshotId, shopId],
    );
    const meta = header.rows[0];
    if (!meta) throw new Error("SNAPSHOT_NOT_FOUND");

    const scope = await this.pool.query<{
      period: string;
      month: string;
      marketplace: string;
      currency: string | null;
      disposition: string;
      datasetVersionId: string;
    }>(
      `SELECT to_char(ds.local_month,'YYYY-MM') AS "period",to_char(ds.local_month,'YYYY-MM') AS "month",
              ds.normalized_marketplace marketplace,ps.disposition,ps.dataset_version_id::text AS "datasetVersionId",
              COALESCE((SELECT tf.currency FROM transaction_fact tf WHERE tf.dataset_version_id=ps.dataset_version_id ORDER BY tf.id LIMIT 1),
                       (SELECT sf.currency FROM shipment_fact sf WHERE sf.dataset_version_id=ps.dataset_version_id ORDER BY sf.id LIMIT 1)) currency
         FROM published_snapshot_slice ps JOIN dataset_slice ds ON ds.id=ps.dataset_slice_id
        WHERE ps.published_snapshot_id=$1 ORDER BY ds.local_month,ds.normalized_marketplace`,
      [snapshotId],
    );
    const includedScope = scope.rows.filter((row) => ["INCLUDED", "INCLUDED_WITH_WARNING"].includes(row.disposition));
    if (includedScope.length === 0) throw new Error("EXPORT_NO_INCLUDED_SLICES");
    const reportPeriods = [...new Set(includedScope.map((row) => row.period))].sort();
    const marketplaceCurrency = new Map<string, string>();
    const fallbackCurrency: Readonly<Record<string, string>> = {
      BE: "EUR", ES: "EUR", FR: "EUR", IE: "EUR", IT: "EUR", NL: "EUR", DE: "EUR",
      UK: "GBP", PL: "PLN", SE: "SEK", TR: "TRY", AE: "AED", SA: "SAR",
      US: "USD", CA: "CAD", MX: "MXN", JP: "JPY", AU: "AUD", SG: "SGD",
    };
    for (const row of includedScope) {
      const currency = row.currency ?? fallbackCurrency[row.marketplace];
      if (!currency) throw new Error("EXPORT_MARKETPLACE_CURRENCY_UNKNOWN");
      const existing = marketplaceCurrency.get(row.marketplace);
      if (existing && existing !== currency) throw new Error("EXPORT_MULTIPLE_CURRENCIES_PER_MARKETPLACE");
      marketplaceCurrency.set(row.marketplace, currency);
    }
    const marketplaceLabel = (value: string): string => formatMarketplaceForExport(value, preferences.continentPrefixes);
    const zeroAmounts = (): Record<string, string> => ({
      incomeOriginal: "0", incomeCny: "0", refundOriginal: "0", refundCny: "0", netOriginal: "0", netCny: "0",
      withheldTaxOriginal: "0", withheldTaxCny: "0", platformFeeOriginal: "0", platformFeeCny: "0", fbaOriginal: "0", fbaCny: "0",
      storageOriginal: "0", storageCny: "0", advertisingOriginal: "0", advertisingCny: "0", otherOriginal: "0", otherCny: "0",
      expenseOriginal: "0", expenseCny: "0", platformFeeRate: "0", salesCostRate: "0", procurementOriginal: "0", procurementCny: "0",
      profitRate: "0", profitOriginal: "0", profitCny: "0",
    });
    const decorate = (period: string, marketplace: string, values: Record<string, string>): ReportRow => {
      const sourceCurrency = values.currency;
      const amounts = Object.fromEntries(Object.entries(values).filter(([key]) => !["period", "marketplace", "currency", "currencyCount"].includes(key)));
      return {
        shop: meta.shop_name, period, platform: "亚马逊", marketplace: marketplaceLabel(marketplace),
        currency: marketplaceCurrency.get(marketplace) ?? sourceCurrency ?? "CNY", ...zeroAmounts(), ...amounts,
      };
    };
    const uniqueScope = (rows: readonly { period: string; marketplace: string }[]): Array<{ period: string; marketplace: string }> => {
      const byKey = new Map(rows.map((row) => [`${row.period}\0${row.marketplace}`, row]));
      return [...byKey.values()].sort((left, right) => left.period.localeCompare(right.period) || left.marketplace.localeCompare(right.marketplace));
    };
    const dense = (
      allowed: readonly { period: string; marketplace: string }[],
      actual: readonly Record<string, string>[],
    ): ReportRow[] => {
      const byKey = new Map(actual.map((row) => [`${row.period}\0${row.marketplace}`, row]));
      const allowedKeys = new Set(allowed.map((row) => `${row.period}\0${row.marketplace}`));
      if (actual.some((row) => !allowedKeys.has(`${row.period}\0${row.marketplace}`))) {
        throw new Error("EXPORT_INCLUDED_SCOPE_MISMATCH");
      }
      return allowed.map(({ period, marketplace }) => decorate(period, marketplace, byKey.get(`${period}\0${marketplace}`) ?? {}));
    };
    const monthlyScope = uniqueScope(includedScope);
    const quarterScope = uniqueScope(includedScope.map((row) => ({
      period: `${row.period.slice(0, 4)}-Q${Math.floor((Number(row.period.slice(5, 7)) - 1) / 3) + 1}`,
      marketplace: row.marketplace,
    })));
    const annualScope = uniqueScope(includedScope.map((row) => ({ period: row.period.slice(0, 4), marketplace: row.marketplace })));
    const monthlyActual = await this.aggregateMonthlyFinancialRows(meta.calculation_run_id);
    const monthlyRows = dense(monthlyScope, monthlyActual);
    const quarterlyRows = dense(quarterScope, rollupFinancialRows(monthlyActual, "quarter"));
    const annualRows = dense(annualScope, rollupFinancialRows(monthlyActual, "year"));
    const fees=await this.pool.query<Record<string,string>>(`SELECT ds.normalized_marketplace AS marketplace,to_char(ds.local_month,'YYYY-MM') AS "month",r.component AS category,count(*)::text AS "sourceRows",sum(r.amount_cny)::text AS "amountCny" FROM calculation_fact_result r JOIN dataset_version dv ON dv.id=r.dataset_version_id JOIN dataset_slice ds ON ds.id=dv.dataset_slice_id WHERE r.calculation_run_id=$1 AND r.component NOT IN('INCOME','REFUND','WITHHELD_TAX') GROUP BY ds.id,r.component ORDER BY ds.local_month,ds.normalized_marketplace,r.component`,[meta.calculation_run_id]);
    const audit=await this.pool.query<Record<string,string>>(`SELECT f.relative_path "relativePath",f.classification,f.parse_status "parseStatus",f.read_row_count::text "readRows",f.inserted_row_count::text "insertedRows",f.excluded_row_count::text "excludedRows",f.error_row_count::text "errorRows",CASE WHEN f.read_row_count=f.inserted_row_count+f.excluded_row_count+f.error_row_count THEN 'PASS' ELSE 'FAIL' END conservation,encode(f.sha256,'hex') sha256 FROM import_file f WHERE f.id IN(SELECT DISTINCT b.import_file_id FROM published_snapshot_slice ps JOIN dataset_source_binding b ON b.dataset_version_id=ps.dataset_version_id WHERE ps.published_snapshot_id=$1) ORDER BY f.relative_path`,[snapshotId]);
    if (audit.rows.some((row) => row.conservation !== "PASS")) throw new Error("EXPORT_IMPORT_CONSERVATION_FAILED");
    const feeTotal = fees.rows.reduce((sum, row) => sum.add(decimal(row.amountCny ?? "0")), decimal("0"));
    const classifiedExpenseTotal = monthlyRows.reduce((sum, row) => sum
      .add(decimal(String(row.platformFeeCny ?? "0")))
      .add(decimal(String(row.fbaCny ?? "0")))
      .add(decimal(String(row.storageCny ?? "0")))
      .add(decimal(String(row.advertisingCny ?? "0")))
      .add(decimal(String(row.otherCny ?? "0"))), decimal("0"));
    if (!feeTotal.equals(classifiedExpenseTotal)) throw new Error("EXPORT_FEE_CONSERVATION_FAILED");
    const manifestSlices = Array.isArray(meta.manifest.slices) ? meta.manifest.slices.filter((slice): slice is Record<string, unknown> => Boolean(slice) && typeof slice === "object") : [];
    const sourceImportBatchId = typeof meta.manifest.sourceImportBatchId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(meta.manifest.sourceImportBatchId)
      ? meta.manifest.sourceImportBatchId
      : undefined;
    const datasetVersions = manifestSlices.map((slice) => slice.versionId).filter((id): id is string => typeof id === "string");
    const mappingVersions = [...new Set(manifestSlices.flatMap((slice) => Array.isArray(slice.mappings) ? slice.mappings.filter((id): id is string => typeof id === "string") : []))].sort();
    const policyVersions=Array.isArray(meta.manifest.marketplacePolicyVersionIds)?meta.manifest.marketplacePolicyVersionIds.filter((id):id is string=>typeof id==='string').sort():[];
    return {
      diagnosticId: diagnosticReferenceId(sourceImportBatchId ? "I" : exportId ? "E" : "P", sourceImportBatchId ?? exportId ?? snapshotId),
      snapshotId,
      publishedAt: meta.published_at.toISOString(),
      generatedAt: new Date().toISOString(),
      shopName: meta.shop_name,
      policyVersion: policyVersions.join(",") || String(meta.manifest.marketplacePolicyVersionId ?? "unknown"),
      formulaVersion: String(meta.manifest.formulaVersion ?? "v1"),
      dataVersion: `snapshot:${snapshotId};versions:${datasetVersions.sort().join(",")}`,
      mappingVersion: mappingVersions.join(",") || "none",
      fxVersion: String(meta.manifest.fxSyncRunId ?? "calculation-fx-usage"),
      timezoneVersion: String(meta.manifest.timezonePolicyVersion ?? "unknown"),
      codeVersion: String(meta.manifest.codeVersion ?? "unknown"),
      priceVersion: String(meta.manifest.applicationPriceVersionId ?? "unknown"),
      manifestSha256: meta.manifest_sha256,
      costAssumptions: normalizeAccountingAssumptions(preferences),
      continentPrefixes: preferences.continentPrefixes,
      reportPeriods,
      monthly: section(SUMMARY_COLUMNS, monthlyRows),
      quarterly: section(SUMMARY_COLUMNS, quarterlyRows),
      annual: section(SUMMARY_COLUMNS, annualRows),
      completeness: section(COMPLETENESS_COLUMNS, scope.rows.map((row) => ({
        marketplace: marketplaceLabel(row.marketplace),
        month: row.month,
        disposition: row.disposition,
        datasetVersionId: row.datasetVersionId,
      }))),
      fees: section(FEE_COLUMNS, fees.rows),
      importAudit: section(AUDIT_COLUMNS, audit.rows),
    };
  }
}
