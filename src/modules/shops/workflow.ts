export type WorkflowStepCode = "RECEIVE" | "PREFLIGHT" | "COMMIT" | "CALCULATE" | "PUBLISH" | "EXPORT";
export type WorkflowStepState = "NOT_STARTED" | "IN_PROGRESS" | "COMPLETED";
export type WorkflowSeverity = "NONE" | "WARNING" | "BLOCKING";

export interface WorkflowBatchState {
  readonly id?: string;
  readonly status: string;
  readonly stage: string;
  readonly failureCode: string | null;
  readonly declaredBytes: string;
  readonly receivedBytes: string;
  readonly fileCount: number;
  readonly processedFileCount: number;
  readonly warningCount: number;
  readonly blockingCount: number;
  readonly publishedSnapshotMatchesBatch: boolean;
}

export interface WorkflowCalculationState {
  readonly id?: string;
  readonly status: string;
  readonly failureCode: string | null;
}

export interface WorkflowExportState {
  readonly id: string;
  readonly snapshotId: string;
  readonly status: string;
  readonly progress: string | null;
  readonly stage?: string;
  readonly processedRows?: string;
  readonly totalRows?: string | null;
  readonly heartbeatAt?: string | null;
}

export interface WorkflowInput {
  readonly access: "ENTERPRISE" | "CUSTOMER" | "ADMIN";
  readonly shopStatus: "ACTIVE" | "EXPIRED" | "TRASHED";
  readonly hasPublishedSnapshot: boolean;
  readonly canExport: boolean;
  readonly batch?: WorkflowBatchState;
  readonly calculation?: WorkflowCalculationState;
  readonly latestExport?: WorkflowExportState;
}

export function workflowDownloadAvailable(input: WorkflowInput): boolean {
  if (!input.hasPublishedSnapshot || !input.canExport) return false;
  return !input.batch || input.batch.publishedSnapshotMatchesBatch;
}

export interface WorkflowStepSummary {
  readonly code: WorkflowStepCode;
  readonly label: string;
  readonly state: WorkflowStepState;
  readonly severity: WorkflowSeverity;
  readonly progress: string | null;
  readonly warningCount: number;
  readonly blockingCount: number;
  readonly clickable: boolean;
}

const LABELS: Record<WorkflowStepCode, string> = {
  RECEIVE: "数据接收",
  PREFLIGHT: "预检解析",
  COMMIT: "确认入库",
  CALCULATE: "业务计算",
  PUBLISH: "结果发布",
  EXPORT: "报告下载",
};

const COMMIT_STARTED = new Set([
  "COMMITTING", "COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING", "READY_FOR_REVIEW", "RESULT_PUBLISHING", "RESULT_PUBLISHED",
]);
const COMMIT_COMPLETED = new Set([
  "COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING", "READY_FOR_REVIEW", "RESULT_PUBLISHING", "RESULT_PUBLISHED",
]);
const PREFLIGHT_COMPLETED = new Set([
  "AWAITING_COMMIT_CONFIRMATION", ...COMMIT_STARTED,
]);

function percent(numerator: string | number, denominator: string | number): string | null {
  const total = BigInt(denominator);
  if (total <= 0n) return null;
  const value = BigInt(numerator);
  const result = value * 100n / total;
  return (result > 100n ? 100n : result).toString();
}

function step(
  code: WorkflowStepCode,
  state: WorkflowStepState,
  severity: WorkflowSeverity,
  progress: string | null,
  clickable: boolean,
  warningCount = 0,
  blockingCount = 0,
): WorkflowStepSummary {
  return { code, label: LABELS[code], state, severity, progress, clickable, warningCount, blockingCount };
}

export function deriveWorkflowSteps(input: WorkflowInput): { currentStep: WorkflowStepCode; steps: WorkflowStepSummary[] } {
  const batch = input.batch;
  const canManage = input.shopStatus === "ACTIVE" && input.access !== "CUSTOMER";
  const historicalPublished = !batch && input.hasPublishedSnapshot;

  const receiveComplete = Boolean(batch) || historicalPublished;
  const receiveInProgress = Boolean(batch && ["DRAFT", "UPLOADING"].includes(batch.status));
  const receiveProgress = receiveComplete
    ? (receiveInProgress && batch ? percent(batch.receivedBytes, batch.declaredBytes) : "100")
    : null;

  const failedAfterPreflight = Boolean(batch && batch.status === "FAILED" && /COMMIT|COPY|CALCULAT|PUBLISH/u.test(`${batch.stage}:${batch.failureCode ?? ""}`));
  const preflightComplete = historicalPublished || Boolean(batch && (PREFLIGHT_COMPLETED.has(batch.status) || failedAfterPreflight));
  const preflightInProgress = Boolean(batch && ["ANALYZING", "AWAITING_FILES", "AWAITING_MAPPING", "RETRYING"].includes(batch.status));
  const preflightBlocking = Boolean(batch && (
    ["AWAITING_FILES", "AWAITING_MAPPING"].includes(batch.status)
    || batch.blockingCount > 0
    || (batch.status === "FAILED" && !/COMMIT|CALCULAT|PUBLISH/u.test(`${batch.stage}:${batch.failureCode ?? ""}`))
  ));
  const preflightWarnings = batch?.warningCount ?? 0;
  const preflightSeverity: WorkflowSeverity = preflightBlocking ? "BLOCKING" : preflightWarnings > 0 ? "WARNING" : "NONE";
  const preflightProgress = preflightComplete ? "100" : batch ? percent(batch.processedFileCount, batch.fileCount) : null;

  const hardExclusionConfirmationRequired = batch?.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED";
  const failedAfterCommit = Boolean(batch && !hardExclusionConfirmationRequired
    && batch.status === "FAILED" && /CALCULAT|PUBLISH/u.test(`${batch.stage}:${batch.failureCode ?? ""}`));
  const commitComplete = historicalPublished || Boolean(batch && (COMMIT_COMPLETED.has(batch.status) || failedAfterCommit));
  const commitInProgress = Boolean(batch && batch.status === "COMMITTING");
  const commitBlocking = Boolean(hardExclusionConfirmationRequired
    || (batch && batch.status === "FAILED" && /COMMIT|COPY|DATABASE_CAPACITY/u.test(`${batch.stage}:${batch.failureCode ?? ""}`)));

  const calculationComplete = historicalPublished || Boolean(batch && ["READY_FOR_REVIEW", "RESULT_PUBLISHING", "RESULT_PUBLISHED"].includes(batch.status));
  const calculationInProgress = Boolean(batch && ["COMMITTED", "COMMITTED_WITH_EXCLUSIONS", "CALCULATING"].includes(batch.status));
  const calculationBlocking = !hardExclusionConfirmationRequired && (input.calculation?.status === "BLOCKED" || input.calculation?.status === "FAILED"
    || Boolean(batch && batch.status === "FAILED" && /CALCULAT/u.test(`${batch.stage}:${batch.failureCode ?? ""}`)));

  const publishComplete = historicalPublished || batch?.status === "RESULT_PUBLISHED";
  const publishInProgress = Boolean(batch && ["READY_FOR_REVIEW", "RESULT_PUBLISHING"].includes(batch.status) && !batch.failureCode);
  const publishBlocking = Boolean(batch && (
    batch.failureCode === "AUTO_PUBLISH_FAILED"
    || (batch.status === "FAILED" && /PUBLISH/u.test(`${batch.stage}:${batch.failureCode ?? ""}`))
  ));

  const downloadReady = workflowDownloadAvailable(input);

  const steps: WorkflowStepSummary[] = [
    step("RECEIVE", receiveInProgress ? "IN_PROGRESS" : receiveComplete ? "COMPLETED" : "NOT_STARTED", "NONE", receiveProgress, canManage),
    step("PREFLIGHT", preflightInProgress ? "IN_PROGRESS" : preflightComplete ? "COMPLETED" : "NOT_STARTED", preflightSeverity,
      preflightProgress, canManage && Boolean(batch), preflightWarnings, preflightBlocking ? Math.max(1, batch?.blockingCount ?? 0) : 0),
    step("COMMIT", commitInProgress ? "IN_PROGRESS" : commitComplete ? "COMPLETED" : "NOT_STARTED", commitBlocking ? "BLOCKING" : "NONE",
      commitComplete ? "100" : null, canManage && (preflightComplete || commitInProgress), 0, commitBlocking ? 1 : 0),
    step("CALCULATE", calculationInProgress ? "IN_PROGRESS" : calculationComplete ? "COMPLETED" : "NOT_STARTED", calculationBlocking ? "BLOCKING" : "NONE",
      calculationComplete ? "100" : null, canManage && (commitComplete || calculationInProgress), 0, calculationBlocking ? 1 : 0),
    step("PUBLISH", publishInProgress ? "IN_PROGRESS" : publishComplete ? "COMPLETED" : "NOT_STARTED", publishBlocking ? "BLOCKING" : "NONE",
      publishComplete ? "100" : null, input.hasPublishedSnapshot || (canManage && (calculationComplete || publishInProgress)), 0, publishBlocking ? 1 : 0),
    step("EXPORT", downloadReady ? "COMPLETED" : "NOT_STARTED", "NONE",
      downloadReady ? "100" : null, downloadReady),
  ];

  const active = steps.find((candidate) => candidate.state !== "COMPLETED" && candidate.clickable)
    ?? [...steps].reverse().find((candidate) => candidate.clickable)
    ?? steps[0]!;
  return { currentStep: active.code, steps };
}
