import type { ThemeId } from "../theme";

export type MoneyString = string;
export type DecimalString = string;
export type IsoDate = string;
export type IsoDateTime = string;

export interface ApiEnvelope<T> { data: T; requestId?: string }
export interface ApiProblem { code: string; message: string; field?: string; requestId?: string }

export interface Me {
  id: string;
  phoneMasked: string;
  displayName?: string;
  avatarId: number;
  roles: Array<"ACCOUNTANT" | "ADMIN">;
  theme: ThemeId;
  customerShopCount: number;
  customerHomeShopId?: string;
  isFirstLogin: boolean;
}

export interface Shop {
  id: string;
  enterpriseId: string;
  createdByAccountId: string;
  lastOperatedByAccountId: string;
  createdByDisplayName?: string;
  lastOperatedByDisplayName?: string;
  name: string;
  access: "ENTERPRISE" | "CUSTOMER" | "ADMIN";
  accountingStatus: "NOT_STARTED" | "SUBMITTED";
  status: "ACTIVE" | "EXPIRED" | "TRASHED";
  termStart: IsoDate;
  termEndExclusive: IsoDate;
  renameAvailable: boolean;
  publishedSnapshot?: { id: string; publishedAt: IsoDateTime; stale: boolean };
  customerExportAllowed?: boolean;
}

export interface Enterprise {
  id: string;
  createdByAccountId: string;
  name: string;
  unifiedSocialCreditCode?: string;
  profileComplete: boolean;
  memberCount: number;
  companyCount: number;
  notStartedCount: number;
  submittedCount: number;
  wallet: { id: string; balanceCents: string; status: "ACTIVE" | "RESTRICTED_DEBT" | "RESTRICTED_RECONCILIATION" };
  canEditName: boolean;
  canEditCreditCode: boolean;
}

export interface EnterpriseMember {
  id: string;
  accountId?: string;
  displayName?: string;
  phoneMasked: string;
  avatarId?: number;
  status: "PENDING" | "ACTIVE" | "REVOKED";
  createdAt: IsoDateTime;
}

export interface ShopMembership {
  id: string;
  shopId: string;
  accountId: string;
  status: "ACTIVE" | "REVOKED" | "EXPIRED";
  exportAllowed: boolean;
  authorizationEpoch: string;
}

export type WorkflowStepCode = "RECEIVE" | "PREFLIGHT" | "COMMIT" | "CALCULATE" | "PUBLISH" | "EXPORT";

export interface WorkflowStepSummary {
  code: WorkflowStepCode;
  label: string;
  state: "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
  severity: "NONE" | "WARNING" | "BLOCKING";
  progress: string | null;
  warningCount: number;
  blockingCount: number;
  clickable: boolean;
}

export interface ShopWorkflow {
  shop: Pick<Shop, "id" | "name" | "access" | "status"> & { canEdit: boolean };
  diagnosticId: string;
  currentStep: WorkflowStepCode;
  steps: WorkflowStepSummary[];
  latestBatch?: { id: string; status: string; stage: string; failureCode: string | null; calculationRunId?: string };
  publishedSnapshot?: NonNullable<Shop["publishedSnapshot"]>;
  download: {
    available: boolean;
    usesPreviousPublishedVersion: boolean;
    latestExport?: {
      id: string;
      snapshotId: string;
      status: string;
      progress: string | null;
      stage?: string;
      processedRows?: string;
      totalRows?: string | null;
      heartbeatAt?: IsoDateTime | null;
    };
  };
}

export interface FxStatus {
  source: string;
  syncEnabled: boolean;
  quoteCount: number;
  coverageStart?: IsoDate;
  coverageEnd?: IsoDate;
  lastSucceededAt?: IsoDateTime;
  taskStatus: "IDLE" | "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  gaps: Array<{ date: IsoDate; currency: string; reason: string }>;
}

export interface FxQuote {
  date: IsoDate;
  currency: string;
  cnyPerUnit: DecimalString;
  officialPair: string;
  officialRate: DecimalString;
  quoteId: string;
  source: string;
}

export interface FxConversionRow {
  input: string;
  inputDate?: IsoDate;
  quoteDate?: IsoDate;
  from: string;
  to: string;
  rate?: DecimalString;
  fallbackDays?: number;
  status: "OK" | "INVALID_DATE" | "NO_RATE" | "SOURCE_GAP";
  reason?: string;
}

export interface ImportPreview {
  id: string;
  status: "QUEUED" | "RUNNING" | "AWAITING_MAPPING" | "READY" | "PROCESSING" | "PUBLISHED" | "FAILED" | "CANCELLED";
  progress: string;
  stage?: string;
  failureCode?: string | null;
  files: Array<{ id: string; relativePath: string; bytes: string; classification?: string; status: string }>;
  ignored: Array<{ relativePath: string; reason: string }>;
  issues: Array<{
    id: string;
    kind: string;
    severity: "INFO" | "WARNING" | "ERROR";
    count: number;
    exactCount: boolean;
    fieldName?: string;
    marketplace?: string;
    month?: string;
    message: string;
    action: string;
  }>;
  affectedVersions: Array<{ marketplace: string; month: string; currentVersion?: string }>;
}

export interface UploadCompletion {
  id: string;
  status: string;
}

export type SliceState =
  | "COMPLETE"
  | "PUBLISHED_WARNING"
  | "MISSING_TRANSACTION"
  | "MISSING_SHIPMENT"
  | "MISSING_FX"
  | "AWAITING_MAPPING"
  | "CONFLICT"
  | "EXCLUDED"
  | "STALE";

export interface CompletenessSlice {
  sliceId?: string;
  datasetVersionId?: string;
  disposition?: "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED";
  marketplace: string;
  month: string;
  state: SliceState;
  missingReports?: Array<"TRANSACTION" | "SHIPMENT">;
  transactionQuantity?: string;
  shipmentQuantity?: string;
  unmatchedAbsolute?: string;
  unmatchedRatio?: DecimalString;
  note?: string;
}

export interface ReportMetric {
  key: "income" | "refund" | "withheldTax" | "platformFee" | "fbaDelivery" | "advertising" | "storage" | "other" | "balance";
  amountCny: MoneyString;
  ratioOfIncome?: DecimalString;
}

export interface ReportResult {
  shopId: string;
  mode: "DRAFT" | "STALE" | "PUBLISHED";
  runId: string;
  snapshotId?: string;
  calculatedAt: IsoDateTime;
  publishedAt?: IsoDateTime;
  dataVersion: string;
  mappingVersion: string;
  timezoneVersion: string;
  policyVersion: string;
  formulaVersion: string;
  fxVersion: string;
  metrics: ReportMetric[];
  completeness: CompletenessSlice[];
  fees: Array<{ category: string; marketplace: string; month: string; sourceRows: string; amountCny: MoneyString }>;
  notices: string[];
  canPublish: boolean;
}

export interface IntermediateReportPage {
  items: Array<Record<string, string>>;
  nextCursor?: string;
}

export interface IntermediateReportSummary {
  coverage: { start?: IsoDate; end?: IsoDate };
  options: { marketplaces: string[]; currencies: string[] };
  matchedRows: string;
  totalsByCurrency: Array<{ currency: string; values: Record<string, DecimalString> }>;
  cnyTotal: DecimalString;
}

export interface ExportJob {
  id: string;
  shopId: string;
  snapshotId: string;
  status: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "REVOKED";
  progress: string;
  stage: string;
  processedRows: string;
  totalRows: string | null;
  heartbeatAt: IsoDateTime | null;
  format: "XLSX" | "ZIP";
  isCurrentFormat: boolean;
  createdAt: IsoDateTime;
  profitRate?: DecimalString | null;
  minimumSalesCostRate?: DecimalString | null;
  continentPrefixes?: AccountingPreferences["continentPrefixes"];
  error?: string;
}

export interface AccountingPreferences {
  profitRate: DecimalString | null;
  minimumSalesCostRate: DecimalString | null;
  continentPrefixes: Array<"AS" | "EU" | "AF" | "AM" | "OC">;
}

export interface CostAccountingPreviewRow {
  period: string;
  incomeTotalCny: MoneyString;
  netIncomeCny: MoneyString;
  platformExpensesCny: MoneyString;
  targetProfitCny: MoneyString | null;
  profitCny: MoneyString;
  procurementCny: MoneyString;
  salesCostRate: DecimalString;
  minimumAdjusted: boolean;
}

export interface CostAccountingPreview {
  snapshotId: string;
  year: string;
  assumptions: AccountingPreferences;
  rows: CostAccountingPreviewRow[];
  total: Omit<CostAccountingPreviewRow, "period">;
}

export interface WalletEntry {
  id: string;
  type: string;
  amountCents: string;
  balanceAfterCents: string;
  occurredAt: IsoDateTime;
  reason?: string;
}

export interface AdminUser {
  id: string;
  displayName?: string;
  avatarId: number;
  phoneMasked: string;
  roles: Array<"ACCOUNTANT" | "ADMIN">;
  status: "ACTIVE" | "DISABLED";
  enterpriseCount: number;
  companyCount: number;
}

export interface AdminApp {
  id: string;
  name: string;
  status: "PUBLISHED" | "UNPUBLISHED";
  sortOrder: string;
  annualPriceCents: string;
  priceVersion: string;
  allowedRoles: Array<"ACCOUNTANT">;
}

export interface OperationsOverview {
  fxSyncRuns: Array<{ id: string; sync_kind: string; status: string; coverage_from?: IsoDate; coverage_to?: IsoDate; started_at: IsoDateTime; finished_at?: IsoDateTime; error_code?: string }>;
  storage: Array<{ object_kind: string; verification_status: string; object_count: string; plaintext_bytes: string }>;
  backups: Array<{ id: string; backup_kind: string; status: string; target_name: string; started_at: IsoDateTime; finished_at?: IsoDateTime; manifest_sha256?: string; error_code?: string }>;
  recoveryCheckpoints: Array<{ id: string; checkpoint_kind: string; source_version: string; status: string; created_at: IsoDateTime; verified_at?: IsoDateTime }>;
  alerts: Array<{ id: string; severity: string; alert_type: string; status: string; opened_at: IsoDateTime; resolved_at?: IsoDateTime }>;
}

export interface OperationsJob {
  id: string;
  name: string;
  state: string;
  retry_count: string;
  retry_limit: string;
  created_on: IsoDateTime;
  started_on?: IsoDateTime;
  completed_on?: IsoDateTime;
  heartbeat_on?: IsoDateTime;
}
