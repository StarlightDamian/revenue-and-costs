<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { MAX_UPLOAD_BATCH_BYTES, MAX_UPLOAD_BATCH_FILES } from "../../shared/upload-limits";
import { api } from "../api/client";
import type { CompletenessSlice, ImportPreview } from "../api/types";
import PageHeader from "../components/PageHeader.vue";
import { formatBytes } from "../format";
import { projectCommitCoverage } from "../imports/commit-coverage";
import { prepareUploadChecksum } from "../uploads/checksum";
import { collectDroppedFiles, mergeFileSelections, type DroppedFile } from "../uploads/dropped-files";
import { uploadBatchConclusion, uploadFailureMessage, uploadFilesContinuing, type UploadFileItem } from "../uploads/upload-flow";
import { preflightZipForPdf } from "../uploads/zip-preflight";

const route = useRoute();
const emit = defineEmits<{ workflowChange: [] }>();
const shopId = computed(() => String(route.params.shopId));
const files = ref<File[]>([]);
const uploadItems = ref<UploadFileItem[]>([]);
const status = ref<"idle" | "uploading" | "uploaded" | "preflight" | "processing" | "ready" | "error" | "cancelled">("idle");
const progress = ref("0");
const error = ref("");
const batchId = ref("");
const preview = ref<ImportPreview | null>(null);
const completeness = ref<CompletenessSlice[]>([]);
const exclusionReason = ref("");
const resuming = ref(false);
const dragActive = ref(false);
const checkingSelection = ref(false);
const restoringLatest = ref(true);
const selectionNotice = ref("");
const selectedUploadPaths = ref<string[]>([]);
const removingFiles = ref(false);
const detailView = ref<"FILES" | "COVERAGE">("FILES");
const restoredStagedManifest = ref(false);
const selectedPaths = new WeakMap<File, string>();
let pollingGeneration = 0;
let stateEpoch = 0;
const totalBytes = computed(() => uploadItems.value.reduce((sum, item) => sum + item.size, 0));
const accepted = computed(() => files.value.length > 0
  && files.value.length <= MAX_UPLOAD_BATCH_FILES
  && totalBytes.value <= MAX_UPLOAD_BATCH_BYTES);
const selectionLocked = computed(() => restoringLatest.value
  || checkingSelection.value
  || resuming.value
  || removingFiles.value
  || ["uploading", "preflight", "processing"].includes(status.value)
  || Boolean(batchId.value));
const selectedUploadCount = computed(() => selectedUploadPaths.value.length);
const allUploadItemsSelected = computed(() => uploadItems.value.length > 0
  && selectedUploadCount.value === uploadItems.value.length);
const someUploadItemsSelected = computed(() => selectedUploadCount.value > 0
  && !allUploadItemsSelected.value);
const canStartUpload = computed(() => !restoringLatest.value
  && !checkingSelection.value
  && !resuming.value
  && accepted.value
  && !batchId.value
  && ["idle", "error"].includes(status.value));
const uploadConclusion = computed(() => uploadBatchConclusion(uploadItems.value));
const canContinue = computed(() => !restoredStagedManifest.value
  && Boolean(batchId.value)
  && uploadItems.value.some((item) => item.state === "failed"));
const canRetryCompletion = computed(() => Boolean(batchId.value)
  && status.value === "error"
  && ((preview.value?.uploadReady === true
    && (preview.value.stagedUploadFiles === undefined
      || preview.value.stagedUploadFiles.every((file) => ["COMPLETE", "FAILED"].includes(file.status))))
    || (uploadItems.value.length > 0
    && uploadItems.value.every((item) => ["complete", "skipped"].includes(item.state)
      || (restoredStagedManifest.value && item.state === "failed")))));
const canRemoveUploadedFiles = computed(() => Boolean(batchId.value)
  && !preview.value
  && (status.value === "uploaded" || (status.value === "error" && !canRetryCompletion.value)));
const canEditUploadSelection = computed(() => !restoringLatest.value
  && !checkingSelection.value
  && !resuming.value
  && !removingFiles.value
  && ((!batchId.value && ["idle", "error"].includes(status.value)) || canRemoveUploadedFiles.value));
const hasConfirmableUploadedFiles = computed(() => uploadItems.value.some((item) => item.state === "complete"));
const uploadStateNames = { pending: "等待", uploading: "上传中", complete: "成功", failed: "失败", skipped: "已跳过" } as const;
const uploadErrorText = (message?: string) => /read|读取|notreadable/iu.test(message ?? "")
  ? "浏览器无法读取这个文件，请重新选择文件后再试"
  : "这个文件上传失败，请检查网络后点击“继续上传”";
const uploadStartErrorText = (message?: string) => /read|读取|notreadable/iu.test(message ?? "")
  ? "浏览器无法读取所选文件，请重新选择后再试"
  : "现在无法开始上传。已选文件仍保留，请稍后点击“重试开始上传”。";
const uploadAttemptErrorText = (message?: string) => uploadItems.value.some((item) => item.state === "failed")
  ? uploadErrorText(message)
  : "服务器没有正确接收文件清单。请点击“安全取消”，再重新选择文件。";
const progressErrorText = (message?: string) => /401|403|登录|权限|unauth|forbidden/iu.test(message ?? "")
  ? "登录已失效或您没有权限。请重新登录；如果仍无法继续，请联系管理员。"
  : "暂时无法取得最新进度。请检查网络后刷新页面。";
const classificationNames: Record<string, string> = {
  TRANSACTION: "交易报告",
  SHIPMENT: "配送货件",
  LIST_ONLY: "只保留文件信息",
  TEMPORARY: "临时文件，不参与计算",
  UNKNOWN: "无法识别",
};
type RecognizedFileKind = "TRANSACTION" | "SHIPMENT";
type PreflightFileTone = "complete" | "failed" | "neutral" | "pending" | "skipped" | "uploading" | "warning";
interface PreflightFileRow {
  path: string;
  classification: string;
  classificationKind?: RecognizedFileKind;
  status: string;
  tone: PreflightFileTone;
  detail: string;
}
const recognizedFileKind = (value?: string): RecognizedFileKind | undefined =>
  value === "TRANSACTION" || value === "SHIPMENT" ? value : undefined;
const preflightFileTone = (status: string, ignored: boolean): PreflightFileTone => {
  if (/FAILED|ERROR/u.test(status)) return "failed";
  if (status === "AWAITING_MAPPING") return "warning";
  if (ignored || ["LIST_ONLY", "EXCLUDED", "EXCLUDED_UNKNOWN_STRUCTURE"].includes(status)) return "skipped";
  if (status === "PARSED") return "complete";
  if (status === "PENDING") return "pending";
  return "neutral";
};
const fileStatusNames: Record<string, string> = {
  PARSED: "可用于计算",
  LIST_ONLY: "未参与计算",
  EXCLUDED: "未参与计算",
  EXCLUDED_UNKNOWN_STRUCTURE: "未参与计算",
  AWAITING_MAPPING: "等待管理员确认表格内容",
  PENDING: "等待检查",
  FAILED: "处理失败",
};
const ignoredReason = (reason: string) => reason === "UNKNOWN_STRUCTURE"
  ? "系统看不懂这个表格，暂时不会用于计算"
  : reason === "LIST_ONLY" ? "只保留文件信息，不读取正文，也不用于计算" : "该文件不会用于计算";
const ignoredPaths = computed(() => new Map((preview.value?.ignored ?? []).map((item) => [item.relativePath, ignoredReason(item.reason)])));
const retryableCommitFailure = computed(() => preview.value?.status === "FAILED"
  && ["IMPORT_DATABASE_CAPACITY_UNAVAILABLE", "IMPORT_DATABASE_CAPACITY_INSUFFICIENT"].includes(preview.value.failureCode ?? ""));
const requiresHardExclusionConfirmation = computed(() => preview.value?.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
const commitCoverageRows = computed(() => projectCommitCoverage(completeness.value));
const coverageMatrixRows = computed(() => [...completeness.value]
  .sort((left, right) => left.marketplace.localeCompare(right.marketplace) || left.month.localeCompare(right.month)));
const hasCompleteness = computed(() => completeness.value.length > 0);
const hardIncompleteSlices = computed(() => commitCoverageRows.value.filter((slice) =>
  slice.datasetVersionId && slice.missingReports.length > 0));
const recognizedFileCount = computed(() => (preview.value?.files ?? []).filter((file) =>
  ["SHIPMENT", "TRANSACTION"].includes(file.classification ?? "")
  && !/FAILED|ERROR|AWAITING_MAPPING/u.test(file.status)).length);
const preflightIssueCount = computed(() => (preview.value?.issues ?? []).reduce((sum, issue) => sum + issue.count, 0));
const preflightFiles = computed<PreflightFileRow[]>(() => {
  const rows: PreflightFileRow[] = (preview.value?.files ?? []).map((file) => {
    const classificationKind = recognizedFileKind(file.classification);
    const ignored = ignoredPaths.value.has(file.relativePath);
    const exceptionalStatus = /FAILED|ERROR/u.test(file.status) || file.status === "AWAITING_MAPPING";
    const statusText = fileStatusNames[file.status] ?? (/FAILED|ERROR/u.test(file.status) ? "处理失败" : "已检查");
    return {
      path: file.relativePath,
      classification: classificationNames[file.classification ?? ""] ?? "无法识别",
      ...(classificationKind ? { classificationKind } : {}),
      status: exceptionalStatus ? statusText : ignored ? "未参与计算" : statusText,
      tone: preflightFileTone(file.status, ignored),
      detail: exceptionalStatus ? statusText : ignoredPaths.value.get(file.relativePath) ?? statusText,
    };
  });
  for (const ignored of preview.value?.ignored ?? []) {
    if (!rows.some((row) => row.path === ignored.relativePath)) rows.push({ path: ignored.relativePath, classification: classificationNames[ignored.reason] ?? "无法识别", status: "未参与计算", tone: "skipped", detail: ignoredReason(ignored.reason) });
  }
  for (const item of uploadItems.value) {
    if (!rows.some((row) => row.path === item.path)) {
      rows.push({
        path: item.path,
        classification: item.state === "complete" ? "等待系统识别" : "正在上传",
        status: item.state === "complete" ? "等待检查" : item.state === "skipped" ? "未参与计算" : uploadStateNames[item.state],
        tone: item.state === "complete" ? "pending" : item.state,
        detail: item.state === "skipped" ? "这个文件上传失败后被跳过，其他文件不受影响" : item.error ? uploadErrorText(item.error) : "上传后系统会检查文件内容",
      });
    }
  }
  return rows;
});
const preflightConclusion = computed(() => {
  if (!preview.value) return "";
  const failed = preflightFiles.value.filter((file) => file.status === "处理失败").length;
  const usable = recognizedFileCount.value;
  if (preflightFiles.value.length > 0 && failed === preflightFiles.value.length) return "无可计算数据：所有文件均处理失败。";
  if (preview.value.status === "AWAITING_MAPPING") return "有表格的列名无法识别，暂时不会用于计算。请联系管理员确认每一列代表什么，然后重新上传。";
  if (usable === 0 && !["QUEUED", "RUNNING", "PROCESSING", "PUBLISHED"].includes(preview.value.status)) return "没有可用于计算的资料。请补充交易报告或配送货件后重新上传。";
  if (failed > 0) return `有 ${failed} 个文件处理失败，其他文件仍会继续检查。请打开明细查看失败文件并重新上传。`;
  if (preview.value.status === "READY") return "文件检查完成。系统会保存能用于计算的资料，看不懂的表格不会参与计算。";
  if (preview.value.status === "PROCESSING") return "系统正在保存资料并计算结果。完成后客户会自动看到新的正式结果。";
  if (preview.value.status === "PUBLISHED") return "资料已保存并计算完成，客户现在可以看到新的正式结果。";
  if (preview.value.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED") return "有些站点或月份缺少资料。请补充文件；如果确定不需要计算这些项目，也可以确认不计算后继续。";
  if (preview.value.failureCode === "CALCULATION_DATE_ATTRIBUTION_MODE_MIXED") return "同一批资料使用了不同的日期计算方式，系统无法正确合并。请统一日期格式和计算方式后，重新上传这一范围的全部资料。";
  if (preview.value.failureCode === "NO_ACTIVE_DATASET_IN_ACCOUNTING_PERIOD") return "所选月份内没有已识别的交易报告或配送货件。请核对本次核算月份，并补充该范围内的资料。";
  const fxFailure = /^(FX_DATA_GAP|FX_NO_AVAILABLE_QUOTE)(?::([A-Z]{3}):(\d{4}-\d{2}-\d{2}))?$/u.exec(preview.value.failureCode ?? "");
  if (fxFailure) {
    const subject = fxFailure[2] && fxFailure[3] ? `${fxFailure[3]} ${fxFailure[2]}/CNY` : "报表日期对应币种";
    return `计算所需的 ${subject} 汇率缺失，系统已停止而不是继续等待。请先由管理员依据授权来源补齐汇率，再重新导入。`;
  }
  if (preview.value.failureCode === "IMPORT_DATABASE_CAPACITY_UNAVAILABLE") return "系统暂时无法确认服务器是否有足够空间，因此没有继续保存资料。恢复后可直接重试，无需重新上传。";
  if (preview.value.failureCode === "IMPORT_DATABASE_CAPACITY_INSUFFICIENT") return "服务器可用空间不足，资料暂时无法保存。管理员释放空间后可直接重试，无需重新上传。";
  if (preview.value.status === "FAILED") return "处理未完成，请按本页提示处理后重试。";
  return "系统正在检查文件，页面会自动刷新。当前进度已经保存，离开后也可以继续。";
});
const previewStatusLabel = computed(() => ({
  DRAFT: "待上传", UPLOADING: "上传中", ANALYZING: "正在检查文件", AWAITING_FILES: "等待补充文件",
  AWAITING_MAPPING: "等待管理员确认表格内容", READY: "文件检查完成", PROCESSING: "正在保存和计算",
  PUBLISHED: "已完成", FAILED: "需要处理", CANCELLED: "已取消",
} as Record<string, string>)[preview.value?.status ?? ""] ?? "处理中");
const matrixSourceState = (slice: CompletenessSlice, kind: RecognizedFileKind): "MISSING" | "PRESENT" | "NOT_REQUIRED" => {
  const sourceCount = kind === "TRANSACTION" ? slice.transactionSourceCount : slice.shipmentSourceCount;
  if (/^[1-9][0-9]*$/u.test(sourceCount ?? "")) return "PRESENT";
  const missingByState = kind === "TRANSACTION"
    ? slice.state === "MISSING_TRANSACTION"
    : slice.state === "MISSING_SHIPMENT";
  if (slice.missingReports?.includes(kind) || missingByState) return "MISSING";
  if (sourceCount === "0") return "NOT_REQUIRED";
  const quantity = kind === "TRANSACTION" ? slice.transactionQuantity : slice.shipmentQuantity;
  return quantity !== undefined && quantity !== null ? "PRESENT" : "NOT_REQUIRED";
};
const matrixSourceLabel = (slice: CompletenessSlice, kind: RecognizedFileKind): string => ({
  MISSING: "缺失",
  PRESENT: "已收到",
  NOT_REQUIRED: "无需补充",
})[matrixSourceState(slice, kind)];
const matrixNote = (slice: CompletenessSlice): string => {
  const missing = (["TRANSACTION", "SHIPMENT"] as const).filter((kind) => matrixSourceState(slice, kind) === "MISSING");
  if (missing.length > 0) return `请补充${missing.map((kind) => classificationNames[kind]).join("、")}`;
  if (["CONFLICT", "PUBLISHED_WARNING"].includes(slice.state)) return "两份资料数量需要复核";
  if (slice.state === "AWAITING_MAPPING") return "表格列名等待确认";
  if (slice.state === "MISSING_FX") return "缺少人民币换算汇率";
  if (slice.state === "EXCLUDED") return "已确认不计算";
  return "";
};

async function acceptSelection(selection: readonly DroppedFile[]) {
  if (selectionLocked.value || selection.length === 0) return;
  stateEpoch += 1;
  checkingSelection.value = true;
  error.value = "";
  try {
    for (const item of selection) {
      if (!/\.zip$/iu.test(item.relativePath) && !/zip/iu.test(item.file.type)) continue;
      const result = await preflightZipForPdf(item.file);
      if (!result.allowed) {
        error.value = result.message;
        return;
      }
    }

    pollingGeneration += 1;
    const previous = files.value.map((file) => ({ file, relativePath: relativePath(file) }));
    const merged = mergeFileSelections(previous, selection);
    files.value = merged.files.map((item) => item.file);
    for (const item of merged.files) selectedPaths.set(item.file, item.relativePath);
    uploadItems.value = merged.files.map(({ file, relativePath: path }) => ({
      key: `${path}\0${file.size}\0${file.lastModified}`,
      path,
      size: isMetadataPdf(file) ? 0 : file.size,
      remoteId: "",
      source: file,
      state: "pending",
    }));
    selectedUploadPaths.value = [];
    restoredStagedManifest.value = false;
    batchId.value = "";
    preview.value = null;
    completeness.value = [];
    status.value = "idle";
    progress.value = "0";
    const action = previous.length > 0 ? `已追加 ${merged.added} 个文件` : `已选择 ${merged.added} 个文件`;
    const replacement = merged.replaced > 0 ? `，已用最后一次选择替换 ${merged.replaced} 个同路径文件` : "";
    selectionNotice.value = `${action}${replacement}；当前共 ${merged.files.length} 个文件，可继续追加，确认后再开始上传。`;
    if (files.value.length > MAX_UPLOAD_BATCH_FILES) error.value = "单批文件数不能超过 20,000";
    else if (totalBytes.value > MAX_UPLOAD_BATCH_BYTES) error.value = "单批上传不能超过 2GB";
  } finally {
    checkingSelection.value = false;
  }
}

async function collect(event: Event) {
  const input = event.target as HTMLInputElement;
  const selection = Array.from(input.files ?? []).map((file) => ({ file, relativePath: file.webkitRelativePath || file.name }));
  input.value = "";
  await acceptSelection(selection);
}

async function collectDrop(event: globalThis.DragEvent) {
  dragActive.value = false;
  if (selectionLocked.value || !event.dataTransfer) return;
  try {
    await acceptSelection(await collectDroppedFiles(event.dataTransfer));
  } catch {
    error.value = "浏览器无法读取拖入的文件夹。请改用“选择文件夹”，或重新拖入后再试。";
  }
}

function toggleAllUploadItems() {
  if (!canEditUploadSelection.value) return;
  selectedUploadPaths.value = allUploadItemsSelected.value
    ? []
    : uploadItems.value.map((item) => item.path);
}

async function removeSelectedUploadItems() {
  if (!canEditUploadSelection.value || selectedUploadCount.value === 0) return;
  const selected = new Set(selectedUploadPaths.value);
  const removed = uploadItems.value.filter((item) => selected.has(item.path)).length;
  const removingUploadedFiles = Boolean(batchId.value);
  let cancelledByRemoval = false;
  if (batchId.value) {
    const remoteIds = uploadItems.value
      .filter((item) => selected.has(item.path))
      .map((item) => item.remoteId)
      .filter(Boolean);
    if (remoteIds.length !== removed) {
      error.value = "文件清单还没有完整保存，请刷新后重试。";
      return;
    }
    removingFiles.value = true;
    error.value = "";
    try {
      const result = await api.removeUploadFiles(batchId.value, remoteIds);
      if (result.removedCount !== removed) throw new Error("UPLOAD_FILE_REMOVAL_COUNT_MISMATCH");
      if (result.cancelled) {
        cancelledByRemoval = true;
        batchId.value = "";
        restoredStagedManifest.value = false;
      }
    } catch {
      error.value = "暂时无法移除所选文件。文件不会只从页面隐藏，请刷新后重试；已进入归档的文件需要通过新批次修正。";
      return;
    } finally {
      removingFiles.value = false;
    }
  }
  files.value = cancelledByRemoval ? [] : files.value.filter((file) => !selected.has(relativePath(file)));
  uploadItems.value = cancelledByRemoval ? [] : uploadItems.value.filter((item) => !selected.has(item.path));
  selectedUploadPaths.value = [];
  stateEpoch += 1;
  pollingGeneration += 1;
  status.value = uploadItems.value.length
    ? uploadItems.value.some((item) => item.state === "failed") ? "error" : batchId.value ? "uploaded" : "idle"
    : "idle";
  progress.value = batchId.value ? "100" : "0";
  error.value = "";
  selectionNotice.value = cancelledByRemoval
    ? "本批次已没有可处理文件，已清空，可以重新选择资料。"
    : uploadItems.value.length
    ? `${removingUploadedFiles ? "已删除" : "已从待上传清单移除"} ${removed} 个文件；当前还剩 ${uploadItems.value.length} 个文件。`
    : `${removingUploadedFiles ? "已删除" : "已从待上传清单移除"}全部 ${removed} 个文件。`;
}

function isMetadataPdf(file: Pick<File, "name" | "type">): boolean {
  return file.type.toLowerCase() === "application/pdf" || /\.pdf$/iu.test(file.name);
}

function relativePath(file: File): string {
  return selectedPaths.get(file) || file.webkitRelativePath || file.name;
}

function wait(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function refreshPreview(importBatchId = preview.value?.id, expectedEpoch?: number) {
  if (!importBatchId) return false;
  const next = await api.getImportPreview(shopId.value, importBatchId);
  if (expectedEpoch !== undefined && expectedEpoch !== stateEpoch) return false;
  const nextCompleteness = await api.getCompleteness(shopId.value);
  if (expectedEpoch !== undefined && expectedEpoch !== stateEpoch) return false;
  preview.value = next;
  completeness.value = nextCompleteness;
  if (["QUEUED", "RUNNING"].includes(next.status)) status.value = "preflight";
  else if (next.status === "PROCESSING") status.value = "processing";
  else if (next.status === "FAILED") status.value = "error";
  else if (next.status === "CANCELLED") status.value = "cancelled";
  else status.value = "ready";
  emit("workflowChange");
  return true;
}

async function awaitPreview(importBatchId: string) {
  const generation = ++pollingGeneration;
  let consecutiveFailures = 0;
  while (generation === pollingGeneration) {
    try {
      await refreshPreview(importBatchId);
      consecutiveFailures = 0;
      error.value = "";
    } catch (caught) {
      consecutiveFailures += 1;
      const detail = progressErrorText(caught instanceof Error ? caught.message : undefined);
      if (consecutiveFailures >= 3) {
        status.value = "error";
        error.value = `页面连续 3 次无法取得最新进度：${detail}。请手动刷新；如仍未恢复，请把页面顶部的处理编号发给管理员。`;
        emit("workflowChange");
        return;
      }
      error.value = `自动刷新失败，正在重试（${consecutiveFailures}/3）：${detail}`;
      await wait(1_500);
      continue;
    }
    if (!preview.value || !["QUEUED", "RUNNING", "PROCESSING"].includes(preview.value.status)) return;
    await wait(1_000);
  }
}

async function restoreLatestPreview() {
  const restoreEpoch = stateEpoch;
  try {
    const latest = await api.getLatestImportPreview(shopId.value);
    if (restoreEpoch !== stateEpoch) return;
    if (!latest) return;
    if (!await refreshPreview(latest.id, restoreEpoch)) return;
    if (preview.value?.status === "RUNNING" && preview.value.stage === "UPLOAD" && preview.value.uploadBatchId) {
      batchId.value = preview.value.uploadBatchId;
      const stagedFiles = preview.value.stagedUploadFiles ?? [];
      const stagedManifestAvailable = preview.value.stagedUploadFiles !== undefined;
      if (preview.value.uploadReady
        && stagedManifestAvailable
        && stagedFiles.every((file) => ["COMPLETE", "FAILED"].includes(file.status))) {
        const restoredFiles = stagedFiles.map((staged) => {
          const size = Number(staged.bytes);
          if (!Number.isSafeInteger(size) || size < 0 || size > MAX_UPLOAD_BATCH_BYTES) {
            throw new Error("UPLOAD_STAGED_FILE_SIZE_INVALID");
          }
          const name = staged.relativePath.split("/").at(-1) || "staged-file";
          const source = new File([], name, { type: staged.metadataOnly ? "application/pdf" : "application/octet-stream" });
          selectedPaths.set(source, staged.relativePath);
          return { staged, size, source };
        });
        files.value = restoredFiles.map((file) => file.source);
        uploadItems.value = restoredFiles.map(({ staged, size, source }) => ({
          key: staged.id,
          path: staged.relativePath,
          size,
          remoteId: staged.id,
          source,
          state: staged.status === "FAILED" ? "failed" : "complete",
        }));
        selectedUploadPaths.value = [];
        preview.value = null;
        completeness.value = [];
        restoredStagedManifest.value = true;
        status.value = "uploaded";
        progress.value = "100";
        error.value = "";
        selectionNotice.value = hasConfirmableUploadedFiles.value
          ? "已恢复服务器上的暂存文件。仍可单选、多选或全选删除；确认后才会归档并开始计算。"
          : "已恢复服务器上的暂存清单，但没有可处理文件。请删除失败文件后重新选择资料。";
        return;
      }
      status.value = "error";
      error.value = preview.value.uploadReady
        ? "文件已经上传，但系统还没有开始检查。请点击“重新检查已上传文件”；不需要重新选择文件。"
        : "上次上传还没有完成。刷新页面后，浏览器无法继续读取原来的本地文件；请点击“安全取消”，再重新选择文件。";
      return;
    }
    if (preview.value && ["QUEUED", "RUNNING", "PROCESSING"].includes(preview.value.status)) void awaitPreview(latest.id);
  } catch (caught) {
    if (restoreEpoch !== stateEpoch) return;
    const detail = progressErrorText(caught instanceof Error ? caught.message : undefined);
    error.value = `无法取得上次上传的进度：${detail}。请刷新页面重试；确认没有正在处理的文件后，也可以重新选择文件。`;
  } finally {
    if (restoreEpoch === stateEpoch) restoringLatest.value = false;
  }
}

async function completeCurrentUpload() {
  if (!batchId.value) return;
  status.value = "preflight";
  error.value = "";
  try {
    const completion = await api.completeUpload(batchId.value);
    await awaitPreview(completion.id);
  } catch {
    status.value = "error";
    error.value = "文件已经上传，但系统暂时无法开始检查。请点击“重新检查已上传文件”；不需要重新选择文件。";
  }
}

async function startUpload() {
  if (restoringLatest.value || !accepted.value) return;
  stateEpoch += 1;
  selectedUploadPaths.value = [];
  selectionNotice.value = "";
  status.value = "uploading"; error.value = ""; progress.value = "0";
  try {
    if (!batchId.value) {
      await prepareUploadChecksum();
      const batch = await api.createUploadBatch(shopId.value, files.value.map((file) => ({ relativePath: relativePath(file), bytes: String(isMetadataPdf(file) ? 0 : file.size), contentType: file.type || "application/octet-stream", ...(isMetadataPdf(file) ? { metadataOnly: true } : {}) })));
      batchId.value = batch.id;
      for (const item of uploadItems.value) {
        const remote = batch.files.find((candidate) => candidate.relativePath === item.path);
        if (!remote) throw new Error(`服务端未返回文件清单：${item.path}`);
        item.remoteId = remote.id;
        item.initialOffset = remote.offset;
      }
    }
    const result = await uploadFilesContinuing(uploadItems.value, {
      chunkBytes: 16 * 1024 * 1024,
      fileConcurrency: 4,
      getOffset: async (remoteId) => (await api.getUploadOffset(remoteId)).offset,
      uploadChunk: api.uploadChunk,
      onProgress: (sent) => { progress.value = totalBytes.value === 0 ? "100" : String(Math.min(100, Math.floor((sent / totalBytes.value) * 100))); },
    });
    if (result.failed > 0) {
      status.value = "error";
      error.value = uploadFailureMessage(result.failed);
      return;
    }
    status.value = "uploaded";
    progress.value = "100";
    selectionNotice.value = "文件字节已上传。请最后核对清单；可单选、多选或全选移除，确认后系统才会归档并开始计算。";
  } catch (caught) {
    status.value = "error";
    const detail = caught instanceof Error ? caught.message : undefined;
    error.value = batchId.value ? uploadAttemptErrorText(detail) : uploadStartErrorText(detail);
  }
}

async function confirmUploadedFiles() {
  if (status.value !== "uploaded" || !batchId.value || !hasConfirmableUploadedFiles.value || removingFiles.value) return;
  selectedUploadPaths.value = [];
  selectionNotice.value = "";
  await completeCurrentUpload();
}

async function cancel() {
  if (!batchId.value) return;
  try {
    await api.cancelUpload(batchId.value);
    batchId.value = "";
    files.value = [];
    uploadItems.value = [];
    selectedUploadPaths.value = [];
    preview.value = null;
    completeness.value = [];
    progress.value = "0";
    restoredStagedManifest.value = false;
    status.value = "idle";
    error.value = "";
    selectionNotice.value = "本次上传已安全取消，可以重新选择文件。";
  } catch {
    error.value = "暂时无法安全取消本次上传，请刷新后重试。";
  }
}

function clientFailureCode(message: string | undefined): "CLIENT_NETWORK_RETRY_EXHAUSTED" | "CLIENT_FILE_READ_FAILED" {
  return /read|读取|notreadable/iu.test(message ?? "") ? "CLIENT_FILE_READ_FAILED" : "CLIENT_NETWORK_RETRY_EXHAUSTED";
}

async function skipFailedFiles() {
  const failed = uploadItems.value.filter((item) => item.state === "failed");
  if (!batchId.value || failed.length === 0) return;
  status.value = "preflight";
  error.value = "";
  try {
    for (const item of failed) {
      await api.failUploadFile(item.remoteId, clientFailureCode(item.error));
      item.state = "skipped";
    }
    status.value = "uploaded";
    selectionNotice.value = "其余文件字节已上传。请最后核对清单；确认后系统才会归档并开始计算。";
  } catch {
    status.value = "error";
    error.value = "系统暂时无法继续检查其他文件。请刷新页面后重试；已上传成功的文件不需要重新选择。";
  }
}

async function retryImport() {
  const currentPreview = preview.value;
  if (checkingSelection.value || restoringLatest.value || resuming.value || !currentPreview || !retryableCommitFailure.value) return;
  resuming.value = true;
  try {
    await api.confirmImport(shopId.value, currentPreview.id);
    currentPreview.status = "PROCESSING";
    status.value = "processing";
    emit("workflowChange");
    void awaitPreview(currentPreview.id);
  } catch {
    error.value = "资料暂时无法重新保存。请稍后再试；已上传成功的文件不会丢失。";
  } finally {
    resuming.value = false;
  }
}

async function confirmHardExclusions() {
  if (checkingSelection.value || restoringLatest.value || resuming.value) return;
  const currentPreview = preview.value;
  const batch = currentPreview?.id;
  if (!currentPreview || !batch || !hardIncompleteSlices.value.length) { error.value = "目前没有可确认不计算的项目，请刷新页面查看最新状态"; return; }
  resuming.value = true;
  error.value = "";
  try {
    const reason = exclusionReason.value.trim();
    for (const slice of hardIncompleteSlices.value) {
      await api.acknowledgeImportIssue(shopId.value, slice.datasetVersionId!, reason);
    }
    await api.confirmImport(shopId.value, batch);
    exclusionReason.value = "";
    currentPreview.status = "PROCESSING";
    status.value = "processing";
    emit("workflowChange");
    void awaitPreview(batch);
  } catch {
    error.value = "系统暂时无法保存本次选择。请稍后重试；在保存成功前，缺少资料的项目不会进入正式结果。";
  } finally {
    resuming.value = false;
  }
}

onMounted(() => { void restoreLatestPreview(); });
onUnmounted(() => { pollingGeneration += 1; stateEpoch += 1; });
</script>

<template>
  <section class="workflow-stage-page" data-density="6">
    <PageHeader title="资料准备" description="上传资料后，系统会自动检查文件、保存可用资料并开始计算。遇到问题时，本页会说明影响和下一步怎么做。" />

    <section id="upload-source" class="surface-section upload-picker">
      <div class="section-heading"><h2>选择来源文件</h2><p>请选择完整文件夹，系统会记住文件在文件夹中的位置。CSV、从表格软件导出的 TXT 和系统已确认列名的配送货件 XLSX 可以用于计算；PDF 只登记文件名，交易报告 XLSX 和其他文件只保留文件信息。</p></div>
      <div
        class="upload-drop-zone"
        :class="{ 'is-active': dragActive, 'is-disabled': selectionLocked }"
        role="region"
        aria-label="拖放文件夹或文件"
        @dragenter.prevent="dragActive = true"
        @dragover.prevent="dragActive = true"
        @dragleave.prevent="dragActive = false"
        @drop.prevent="collectDrop"
      >
        <div aria-hidden="true" class="upload-drop-icon">＋</div>
        <div><strong>拖入文件夹、ZIP 或文件</strong><p>如果原生窗口一次只能选择一个文件夹，请选完后继续点击“追加文件夹”；也可以一次拖入多个文件夹，或选择它们共同的上一级文件夹。直接选择的 PDF 只登记文件名；ZIP 中有 PDF 时，整个 ZIP 都不会上传。</p></div>
        <div class="upload-source-actions">
          <label class="secondary-button file-button" :class="{ 'is-disabled': selectionLocked }">{{ files.length ? "追加文件夹" : "选择文件夹" }}<input type="file" multiple webkitdirectory directory :disabled="selectionLocked" @change="collect" /></label>
          <label class="secondary-button file-button" :class="{ 'is-disabled': selectionLocked }">{{ files.length ? "追加 ZIP 或文件" : "选择 ZIP 或文件" }}<input type="file" multiple accept=".zip,application/zip,application/x-zip-compressed,.csv,text/csv,.txt,text/plain,.pdf,application/pdf,.xlsx,.xls" :disabled="selectionLocked" @change="collect" /></label>
        </div>
      </div>
      <div v-if="files.length" class="selection-summary"><span>{{ files.length }} 个文件</span><strong>{{ formatBytes(totalBytes) }}</strong><span>上限 20,000 个文件 / 2GB</span></div>
      <p v-if="restoringLatest" class="action-help" role="status">正在查看上次上传的进度，完成前暂时不能选择文件或开始上传。</p>
      <p v-if="selectionNotice" class="action-help" role="status">{{ selectionNotice }}</p>
      <div v-if="uploadItems.length" class="file-manifest" role="region" :aria-label="batchId ? '已上传文件' : '待上传文件'" tabindex="0">
        <header v-if="canEditUploadSelection" class="file-manifest-actions">
          <label class="file-manifest-select-all"><input type="checkbox" :aria-label="batchId ? '全选已上传文件' : '全选待上传文件'" :checked="allUploadItemsSelected" :indeterminate="someUploadItemsSelected" :aria-checked="allUploadItemsSelected ? 'true' : someUploadItemsSelected ? 'mixed' : 'false'" @change="toggleAllUploadItems" /><span>{{ allUploadItemsSelected ? "取消全选" : `全选全部 ${uploadItems.length} 个` }}</span></label>
          <span class="file-manifest-selected-count">已选 {{ selectedUploadCount }} 个</span>
          <button class="secondary-button compact" type="button" :disabled="selectedUploadCount === 0 || removingFiles" @click="removeSelectedUploadItems">{{ removingFiles ? "正在删除" : batchId ? "删除已选文件" : "移除已选文件" }}</button>
        </header>
        <div v-for="item in uploadItems.slice(0, 200)" :key="item.key" class="file-manifest-item">
          <input v-if="canEditUploadSelection" v-model="selectedUploadPaths" class="file-manifest-checkbox" type="checkbox" :value="item.path" :aria-label="`选择${batchId ? '已上传' : '待上传'}文件 ${item.path}`" />
          <span class="status-chip" :data-state="item.state">{{ /\.pdf$/i.test(item.path) && item.state === "complete" ? "未读取正文" : uploadStateNames[item.state] }}</span>
          <span class="file-manifest-path" :title="item.path">{{ item.path }}</span>
          <b class="file-manifest-size">{{ /\.pdf$/i.test(item.path) ? "仅登记文件名" : formatBytes(item.size) }}</b>
          <small v-if="item.error">{{ uploadErrorText(item.error) }}</small>
        </div>
        <p v-if="uploadItems.length > 200">当前显示前 200 个文件，另有 {{ uploadItems.length - 200 }} 个；全选会作用于完整清单。</p>
      </div>
      <p v-if="error && !preview" class="form-error" role="alert">{{ error }}</p>
      <div v-if="status !== 'idle' && !preview" class="warning-panel" :data-tone="uploadConclusion.tone" role="status"><strong>{{ status === "uploaded" ? "等待确认文件清单" : uploadConclusion.title }}</strong><p>{{ status === "uploaded" ? hasConfirmableUploadedFiles ? "当前仍是可撤回暂存文件。删除所选文件后端会同步排除；点击确认后才会进入不可变归档和计算。" : "当前没有可处理文件。请删除失败项并重新选择资料，系统不会生成空结果。" : uploadConclusion.detail }}</p></div>
      <div v-if="status === 'uploading'" class="upload-progress" role="status" aria-live="polite"><div><span>正在上传 {{ progress }}%</span><b>网络中断后，可从上次成功的位置继续</b></div><progress :value="Number(progress)" max="100"></progress></div>
      <div class="form-actions"><button v-if="files.length && !batchId && ['idle','error'].includes(status)" class="primary-button" type="button" :disabled="!canStartUpload" @click="startUpload">{{ status === "error" ? "重试开始上传" : "开始上传" }}</button><button v-if="canContinue" class="primary-button" type="button" @click="startUpload">继续上传</button><button v-if="canContinue" class="secondary-button" type="button" @click="skipFailedFiles">跳过失败并继续</button><button v-if="status === 'uploaded'" class="primary-button" type="button" :disabled="removingFiles || !hasConfirmableUploadedFiles" @click="confirmUploadedFiles">确认文件并开始检查</button><button v-if="canRetryCompletion" class="primary-button" type="button" @click="completeCurrentUpload">重新检查已上传文件</button><button v-if="batchId && (status === 'uploading' || status === 'uploaded' || (status === 'error' && !canRetryCompletion))" class="secondary-button" type="button" @click="cancel">安全取消</button></div>
    </section>

    <section v-if="preview" class="surface-section workflow-commit-panel">
      <div class="section-heading"><h2>本次资料</h2><p>文件检查、保存和计算进度都会在这里自动更新，不需要切换页面。</p></div>
      <div class="commit-summary">
        <div><span>可用于计算</span><strong>{{ recognizedFileCount }}</strong></div>
        <div><span>未参与计算</span><strong>{{ preview.ignored.length }}</strong></div>
        <div><span>问题数量</span><strong>{{ preflightIssueCount }}</strong></div>
        <div><span>当前状态</span><strong>{{ previewStatusLabel }}</strong></div>
      </div>
      <div class="warning-panel" :data-tone="preview.status === 'FAILED' ? 'error' : preview.status === 'PUBLISHED' ? 'success' : undefined" role="status"><strong>处理结论</strong><p>{{ preflightConclusion }}</p></div>

      <details v-if="preflightFiles.length || coverageMatrixRows.length || preview.issues.length" class="preflight-detail">
        <summary>查看文件与问题明细</summary>
        <div class="segmented-control compact preflight-dimension-switch" role="group" aria-label="资料明细查看维度"><button type="button" :class="{ active: detailView === 'FILES' }" :aria-pressed="detailView === 'FILES'" @click="detailView = 'FILES'">按文件查看</button><button type="button" :class="{ active: detailView === 'COVERAGE' }" :aria-pressed="detailView === 'COVERAGE'" @click="detailView = 'COVERAGE'">按站点和月份</button></div>
        <div v-if="detailView === 'FILES' && preflightFiles.length" class="table-scroll" tabindex="0" role="region" aria-label="文件检查结果"><table><thead><tr><th>文件在所选文件夹中的位置</th><th>文件内容</th><th>处理结果</th><th>说明</th></tr></thead><tbody><tr v-for="file in preflightFiles" :key="file.path"><td>{{ file.path }}</td><td><span v-if="file.classificationKind" class="file-kind-chip" :data-kind="file.classificationKind">{{ file.classification }}</span><span v-else>{{ file.classification }}</span></td><td><span class="status-chip" :data-state="file.tone">{{ file.status }}</span></td><td>{{ file.detail }}</td></tr></tbody></table></div>
        <div v-else-if="detailView === 'COVERAGE' && coverageMatrixRows.length" class="table-scroll source-coverage-matrix" tabindex="0" role="region" aria-label="按站点和月份查看资料"><table><thead><tr><th>站点</th><th>日期</th><th>交易报告</th><th>配送货件</th><th>备注</th></tr></thead><tbody><tr v-for="slice in coverageMatrixRows" :key="slice.datasetVersionId || `${slice.marketplace}-${slice.month}`" :data-missing="(slice.missingReports?.length ?? 0) > 0"><td>{{ slice.marketplace }}</td><td>{{ slice.month }}</td><td><span class="status-chip" :data-state="matrixSourceState(slice, 'TRANSACTION') === 'MISSING' ? 'failed' : matrixSourceState(slice, 'TRANSACTION') === 'PRESENT' ? 'complete' : 'neutral'">{{ matrixSourceLabel(slice, 'TRANSACTION') }}</span></td><td><span class="status-chip" :data-state="matrixSourceState(slice, 'SHIPMENT') === 'MISSING' ? 'failed' : matrixSourceState(slice, 'SHIPMENT') === 'PRESENT' ? 'complete' : 'neutral'">{{ matrixSourceLabel(slice, 'SHIPMENT') }}</span></td><td>{{ matrixNote(slice) || "暂无备注" }}</td></tr></tbody></table></div>
        <div v-else-if="detailView === 'COVERAGE'" class="inline-empty">站点和月份仍在汇总，完成后会在这里更新。</div>
        <div v-if="preview.issues.length" class="issue-list"><article v-for="issue in preview.issues" :key="issue.id" :data-severity="issue.severity"><header><strong>{{ issue.message }}</strong><span>{{ issue.exactCount ? `${issue.count} 条` : `${issue.count} 条示例` }}</span></header><p>{{ issue.action }}</p></article></div>
      </details>

      <div class="section-heading"><h2>缺少资料的站点和月份</h2><p>{{ commitCoverageRows.length ? "这里只列出需要补资料的站点和月份；资料齐全的项目已经自动收起。" : "系统只会显示需要处理的缺失项目。" }}</p></div>
      <div v-if="commitCoverageRows.length" class="table-scroll commit-coverage-table" tabindex="0" role="region" aria-label="缺少资料的站点和月份"><table><thead><tr><th>站点</th><th>月份</th><th>缺少什么</th></tr></thead><tbody><tr v-for="slice in commitCoverageRows" :key="slice.datasetVersionId || `${slice.marketplace}-${slice.month}`" data-missing="true"><td>{{ slice.marketplace }}</td><td>{{ slice.month }}</td><td><span class="missing-data-chips"><span v-for="report in slice.missingReports" :key="report" class="missing-data-chip" :data-kind="report"><b aria-hidden="true">!</b>缺少{{ classificationNames[report] }}</span></span></td></tr></tbody></table></div>
      <div v-else-if="hasCompleteness" class="warning-panel" data-tone="success" role="status"><strong>资料已可核算</strong><p>配送货件或纯 FMB 交易资料已覆盖当前站点和月份，可以继续核算。</p></div>
      <div v-else class="inline-empty">正在汇总站点和月份，处理完成后会在本页原位更新。</div>

      <section v-if="requiresHardExclusionConfirmation" class="quality-blocker" aria-labelledby="hard-exclusion-title">
        <h3 id="hard-exclusion-title">确认不计算缺少资料的项目</h3>
        <p>上表中的站点和月份不能当作 0 计算。确认后，系统不会计算这些缺少资料的项目；其他资料齐全的项目会继续计算并生成正式结果。</p>
        <label class="form-field"><span>为什么不计算（选填）</span><textarea v-model="exclusionReason" rows="3" maxlength="1000" placeholder="例如：该站点本月没有经营，确认不需要计算"></textarea></label>
      </section>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="stage-next-action"><span class="action-help">{{ requiresHardExclusionConfirmation ? '补充文件，或确认不计算这些项目后继续。' : preview.status === 'PUBLISHED' ? '资料处理完成，可以进入计算复核。' : '系统会继续自动处理，当前状态会在本页更新。' }}</span><button v-if="retryableCommitFailure" class="primary-button" type="button" :disabled="checkingSelection || restoringLatest || resuming" @click="retryImport">{{ resuming ? "正在重试" : "重新保存资料" }}</button><template v-else-if="requiresHardExclusionConfirmation"><a class="secondary-button" href="#upload-source">补充文件</a><button class="primary-button" type="button" :disabled="resuming || checkingSelection || restoringLatest" @click="confirmHardExclusions">{{ resuming ? "正在继续" : "确认不计算并继续" }}</button></template><a v-else-if="preview.status === 'FAILED'" class="secondary-button" href="#upload-source">补充文件</a><RouterLink v-else-if="preview.status === 'PUBLISHED'" class="primary-button" :to="`/shops/${shopId}/workflow/calculate`">进入计算复核</RouterLink></div>
    </section>
  </section>
</template>
