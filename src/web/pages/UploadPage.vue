<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
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
const status = ref<"idle" | "uploading" | "preflight" | "processing" | "ready" | "error" | "cancelled">("idle");
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
const selectedPaths = new WeakMap<File, string>();
let pollingGeneration = 0;
let stateEpoch = 0;
const totalBytes = computed(() => uploadItems.value.reduce((sum, item) => sum + item.size, 0));
const accepted = computed(() => files.value.length > 0 && files.value.length <= 20_000 && totalBytes.value <= 2 * 1024 * 1024 * 1024);
const selectionLocked = computed(() => restoringLatest.value
  || checkingSelection.value
  || resuming.value
  || ["uploading", "preflight", "processing"].includes(status.value)
  || (Boolean(batchId.value) && !preview.value && status.value !== "cancelled"));
const canStartUpload = computed(() => !restoringLatest.value
  && !checkingSelection.value
  && !resuming.value
  && accepted.value
  && !batchId.value
  && ["idle", "error"].includes(status.value));
const uploadConclusion = computed(() => uploadBatchConclusion(uploadItems.value));
const canContinue = computed(() => Boolean(batchId.value) && uploadItems.value.some((item) => item.state === "failed"));
const uploadStateNames = { pending: "等待", uploading: "上传中", complete: "成功", failed: "失败", skipped: "已跳过" } as const;
const ignoredReason = (reason: string) => reason === "UNKNOWN_STRUCTURE" ? "未知结构，已过滤" : reason === "LIST_ONLY" ? "未解析" : reason;
const ignoredPaths = computed(() => new Map((preview.value?.ignored ?? []).map((item) => [item.relativePath, ignoredReason(item.reason)])));
const retryableCommitFailure = computed(() => preview.value?.status === "FAILED"
  && ["IMPORT_DATABASE_CAPACITY_UNAVAILABLE", "IMPORT_DATABASE_CAPACITY_INSUFFICIENT"].includes(preview.value.failureCode ?? ""));
const requiresHardExclusionConfirmation = computed(() => preview.value?.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
const commitCoverageRows = computed(() => projectCommitCoverage(completeness.value));
const hasCompleteness = computed(() => completeness.value.length > 0);
const hardIncompleteSlices = computed(() => commitCoverageRows.value.filter((slice) =>
  slice.datasetVersionId && slice.missingReports.length > 0));
const recognizedFileCount = computed(() => (preview.value?.files ?? []).filter((file) =>
  ["SHIPMENT", "TRANSACTION"].includes(file.classification ?? "")
  && !/FAILED|ERROR|AWAITING_MAPPING/u.test(file.status)).length);
const preflightIssueCount = computed(() => (preview.value?.issues ?? []).reduce((sum, issue) => sum + issue.count, 0));
const preflightFiles = computed(() => {
  const rows = (preview.value?.files ?? []).map((file) => ({
    path: file.relativePath,
    classification: file.classification ?? "未分类",
    status: ignoredPaths.value.has(file.relativePath) ? "忽略" : /FAILED|ERROR/u.test(file.status) ? "失败" : "成功",
    detail: ignoredPaths.value.get(file.relativePath) ?? file.status,
  }));
  for (const ignored of preview.value?.ignored ?? []) {
    if (!rows.some((row) => row.path === ignored.relativePath)) rows.push({ path: ignored.relativePath, classification: "忽略", status: "忽略", detail: ignoredReason(ignored.reason) });
  }
  for (const item of uploadItems.value) {
    if (!rows.some((row) => row.path === item.path)) {
      rows.push({
        path: item.path,
        classification: item.state === "complete" ? "等待分类" : "上传",
        status: item.state === "complete" ? "成功" : item.state === "skipped" ? "失败" : uploadStateNames[item.state],
        detail: item.state === "skipped" ? "上传失败后由做账员跳过，未进入计算" : item.error ?? "等待预检分析",
      });
    }
  }
  return rows;
});
const preflightConclusion = computed(() => {
  if (!preview.value) return "";
  const failed = preflightFiles.value.filter((file) => file.status === "失败").length;
  const usable = preflightFiles.value.filter((file) => file.status === "成功" && ["SHIPMENT", "TRANSACTION"].includes(file.classification)).length;
  if (preflightFiles.value.length > 0 && failed === preflightFiles.value.length) return "无可计算数据：所有文件均处理失败。";
  if (preview.value.status === "AWAITING_MAPPING") return "待管理员确认字段映射；确认前不会把未知结构静默纳入计算。";
  if (usable === 0 && !["QUEUED", "RUNNING", "PROCESSING", "PUBLISHED"].includes(preview.value.status)) return "无可计算数据：当前批次没有成功识别的交易报告或配送货件。";
  if (failed > 0) return `部分完成：${failed} 个文件失败，其余文件已继续预检。`;
  if (preview.value.status === "READY") return "预检完成：可确认正常数据入库；未知结构文件会被过滤并保留诊断。";
  if (preview.value.status === "PROCESSING") return "正在入库、计算并发布安全快照，完成后客户会自动看到新结果。";
  if (preview.value.status === "PUBLISHED") return "已完成入库、计算和发布，客户现在可以看到新结果。";
  if (preview.value.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED") return "发现缺失资料。补充文件，或确认排除缺失切片后即可继续。";
  if (preview.value.failureCode === "CALCULATION_DATE_ATTRIBUTION_MODE_MIXED") return "当前公司仍混有旧日期口径数据；请按相同日期口径完整重传当前数据范围，不能确认绕过。";
  const fxFailure = /^(FX_DATA_GAP|FX_NO_AVAILABLE_QUOTE)(?::([A-Z]{3}):(\d{4}-\d{2}-\d{2}))?$/u.exec(preview.value.failureCode ?? "");
  if (fxFailure) {
    const subject = fxFailure[2] && fxFailure[3] ? `${fxFailure[3]} ${fxFailure[2]}/CNY` : "报表日期对应币种";
    return `计算所需的 ${subject} 汇率缺失，系统已停止而不是继续等待。请先由管理员依据授权来源补齐汇率，再重新导入。`;
  }
  if (preview.value.failureCode === "IMPORT_DATABASE_CAPACITY_UNAVAILABLE") return "数据库容量检查配置不可用；配置恢复后可直接重试，无需重新上传。";
  if (preview.value.failureCode === "IMPORT_DATABASE_CAPACITY_INSUFFICIENT") return "数据库可用空间不足；释放空间后可直接重试，无需重新上传。";
  if (preview.value.status === "FAILED") return "处理未完成，请按本页提示处理后重试。";
  return "预检处理中：页面会自动刷新，并已持久化当前批次。";
});
const previewStatusLabel = computed(() => ({
  DRAFT: "待上传", UPLOADING: "上传中", ANALYZING: "预检中", AWAITING_FILES: "待补文件",
  AWAITING_MAPPING: "待确认映射", READY: "预检完成", PROCESSING: "自动处理中",
  PUBLISHED: "已完成", FAILED: "需要处理", CANCELLED: "已取消",
} as Record<string, string>)[preview.value?.status ?? ""] ?? "处理中");

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
    batchId.value = "";
    preview.value = null;
    completeness.value = [];
    status.value = "idle";
    progress.value = "0";
    const action = previous.length > 0 ? `已追加 ${merged.added} 个文件` : `已选择 ${merged.added} 个文件`;
    const replacement = merged.replaced > 0 ? `，已用最后一次选择替换 ${merged.replaced} 个同路径文件` : "";
    selectionNotice.value = `${action}${replacement}；当前共 ${merged.files.length} 个文件，可继续追加，确认后再开始上传。`;
    if (files.value.length > 20_000) error.value = "单批文件数不能超过 20,000";
    else if (totalBytes.value > 2 * 1024 * 1024 * 1024) error.value = "单批上传不能超过 2GB";
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
  } catch (caught) {
    error.value = caught instanceof Error ? `无法读取拖入的文件夹：${caught.message}` : "无法读取拖入的文件夹";
  }
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
      const detail = caught instanceof Error ? caught.message : "未知网络错误";
      if (consecutiveFailures >= 3) {
        status.value = "error";
        error.value = `自动刷新连续失败，已停止等待：${detail}。请手动刷新；如仍未恢复，请复制顶部诊断 ID 联系管理员。`;
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
    if (preview.value && ["QUEUED", "RUNNING", "PROCESSING"].includes(preview.value.status)) void awaitPreview(latest.id);
  } catch (caught) {
    if (restoreEpoch !== stateEpoch) return;
    const detail = caught instanceof Error ? caught.message : "未知网络错误";
    error.value = `恢复最近批次失败：${detail}。可刷新页面重试；确认没有进行中的批次后，也可继续选择文件。`;
  } finally {
    if (restoreEpoch === stateEpoch) restoringLatest.value = false;
  }
}

async function startUpload() {
  if (restoringLatest.value || !accepted.value) return;
  stateEpoch += 1;
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
    status.value = "preflight";
    const completion = await api.completeUpload(batchId.value);
    await awaitPreview(completion.id);
  } catch (caught) {
    status.value = "error";
    error.value = caught instanceof Error ? caught.message : "上传失败";
  }
}

async function cancel() {
  if (batchId.value) await api.cancelUpload(batchId.value);
  status.value = "cancelled";
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
    const completion = await api.completeUpload(batchId.value);
    await awaitPreview(completion.id);
  } catch (caught) {
    status.value = "error";
    error.value = caught instanceof Error ? caught.message : "跳过失败文件后无法开始预检";
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
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "重试入库失败";
  } finally {
    resuming.value = false;
  }
}

async function confirmHardExclusions() {
  if (checkingSelection.value || restoringLatest.value || resuming.value) return;
  const currentPreview = preview.value;
  const batch = currentPreview?.id;
  if (!currentPreview || !batch || !hardIncompleteSlices.value.length) { error.value = "没有可确认的缺失切片，请刷新状态"; return; }
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
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "无法确认排除并继续计算";
  } finally {
    resuming.value = false;
  }
}

onMounted(() => { void restoreLatestPreview(); });
onUnmounted(() => { pollingGeneration += 1; stateEpoch += 1; });
</script>

<template>
  <section class="workflow-stage-page" data-density="6">
    <PageHeader title="资料准备" description="上传资料后，系统会在本页自动完成预检和入库；如有阻断，也直接在这里处理。" />

    <section id="upload-source" class="surface-section upload-picker">
      <div class="section-heading"><h2>选择来源文件</h2><p>保留相对路径。CSV、有效的制表符 TXT 与结构已确认的配送 XLSX 参与计算；PDF、交易报告 XLSX 和其他文件仅列入预检。</p></div>
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
        <div><strong>拖入文件夹、ZIP 或文件</strong><p>若当前浏览器的原生选择器一次只允许选择一个文件夹，可重复追加；也可一次拖入多个文件夹。直接选择的 PDF 只登记文件名；ZIP 内含 PDF 时会拒绝该 ZIP。</p></div>
        <div class="upload-source-actions">
          <label class="secondary-button file-button" :class="{ 'is-disabled': selectionLocked }">{{ files.length ? "追加文件夹" : "选择文件夹" }}<input type="file" multiple webkitdirectory directory :disabled="selectionLocked" @change="collect" /></label>
          <label class="secondary-button file-button" :class="{ 'is-disabled': selectionLocked }">{{ files.length ? "追加 ZIP 或文件" : "选择 ZIP 或文件" }}<input type="file" multiple accept=".zip,.csv,.txt,.pdf,.xlsx,.xls" :disabled="selectionLocked" @change="collect" /></label>
        </div>
      </div>
      <div v-if="files.length" class="selection-summary"><span>{{ files.length }} 个文件</span><strong>{{ formatBytes(totalBytes) }}</strong><span>上限 20,000 个文件 / 2GB</span></div>
      <p v-if="restoringLatest" class="action-help" role="status">正在检查最近批次，完成前暂不可选择或开始上传。</p>
      <p v-if="selectionNotice" class="action-help" role="status">{{ selectionNotice }}</p>
      <div v-if="uploadItems.length" class="file-manifest" role="region" aria-label="待上传文件" tabindex="0"><div v-for="item in uploadItems.slice(0, 200)" :key="item.key"><span>{{ item.path }}</span><b>{{ /\.pdf$/i.test(item.path) ? "仅登记文件名" : formatBytes(item.size) }}</b><span class="status-chip" :data-state="item.state">{{ /\.pdf$/i.test(item.path) && item.state === "complete" ? "未解析" : uploadStateNames[item.state] }}</span><small v-if="item.error">{{ item.error }}</small></div><p v-if="uploadItems.length > 200">另有 {{ uploadItems.length - 200 }} 个文件，服务端仍会校验完整清单。</p></div>
      <p v-if="error && !preview" class="form-error" role="alert">{{ error }}</p>
      <div v-if="status !== 'idle' && !preview" class="warning-panel" :data-tone="uploadConclusion.tone" role="status"><strong>{{ uploadConclusion.title }}</strong><p>{{ uploadConclusion.detail }}</p></div>
      <div v-if="status === 'uploading'" class="upload-progress" role="status" aria-live="polite"><div><span>分片上传 {{ progress }}%</span><b>可在中断后按服务端 offset 续传</b></div><progress :value="Number(progress)" max="100"></progress></div>
      <div class="form-actions"><button v-if="files.length && !batchId && ['idle','error'].includes(status)" class="primary-button" type="button" :disabled="!canStartUpload" @click="startUpload">{{ status === "error" ? "重试开始上传" : "开始上传" }}</button><button v-if="canContinue" class="primary-button" type="button" @click="startUpload">继续上传</button><button v-if="canContinue" class="secondary-button" type="button" @click="skipFailedFiles">跳过失败并继续</button><button v-if="batchId && ['uploading','preflight','error'].includes(status)" class="secondary-button" type="button" @click="cancel">安全取消</button></div>
    </section>

    <section v-if="preview" class="surface-section workflow-commit-panel">
      <div class="section-heading"><h2>当前批次</h2><p>预检、入库和后续自动处理都在这里原位更新，无需切换子步骤。</p></div>
      <div class="commit-summary">
        <div><span>可识别文件</span><strong>{{ recognizedFileCount }}</strong></div>
        <div><span>过滤文件</span><strong>{{ preview.ignored.length }}</strong></div>
        <div><span>问题数量</span><strong>{{ preflightIssueCount }}</strong></div>
        <div><span>当前状态</span><strong>{{ previewStatusLabel }}</strong></div>
      </div>
      <div class="warning-panel" :data-tone="preview.status === 'FAILED' ? 'error' : preview.status === 'PUBLISHED' ? 'success' : undefined" role="status"><strong>处理结论</strong><p>{{ preflightConclusion }}</p></div>

      <details v-if="preflightFiles.length || preview.issues.length" class="preflight-detail">
        <summary>查看文件与问题明细</summary>
        <div v-if="preflightFiles.length" class="table-scroll" tabindex="0"><table><thead><tr><th>相对路径</th><th>分类</th><th>状态</th><th>说明</th></tr></thead><tbody><tr v-for="file in preflightFiles" :key="file.path"><td>{{ file.path }}</td><td>{{ file.classification }}</td><td><span class="status-chip" :data-state="file.status">{{ file.status }}</span></td><td>{{ file.detail }}</td></tr></tbody></table></div>
        <div v-if="preview.issues.length" class="issue-list"><article v-for="issue in preview.issues" :key="issue.id" :data-severity="issue.severity"><header><strong>{{ issue.message }}</strong><span>{{ issue.exactCount ? `${issue.count} 条` : `${issue.count} 条样例` }}</span></header><p>{{ issue.action }}</p><code>{{ issue.kind }}</code></article></div>
      </details>

      <div class="section-heading"><h2>站点 × 月份资料完整性</h2><p>{{ commitCoverageRows.length ? "仅列出缺少资料的站点月份，完整项已自动收起。" : "系统只提示需要处理的缺失项。" }}</p></div>
      <div v-if="commitCoverageRows.length" class="table-scroll commit-coverage-table" tabindex="0" role="region" aria-label="站点月份资料完整性"><table><thead><tr><th>站点</th><th>月份</th><th>缺失内容</th></tr></thead><tbody><tr v-for="slice in commitCoverageRows" :key="slice.datasetVersionId || `${slice.marketplace}-${slice.month}`" data-missing="true"><td>{{ slice.marketplace }}</td><td>{{ slice.month }}</td><td><span class="missing-data-chip"><b aria-hidden="true">!</b>缺少{{ slice.missingContent }}</span></td></tr></tbody></table></div>
      <div v-else-if="hasCompleteness" class="warning-panel" data-tone="success" role="status"><strong>资料已齐全</strong><p>当前站点与月份均同时包含交易报告和配送货件，可以继续核算。</p></div>
      <div v-else class="inline-empty">正在汇总站点和月份，处理完成后会在本页原位更新。</div>

      <section v-if="requiresHardExclusionConfirmation" class="quality-blocker" aria-labelledby="hard-exclusion-title">
        <h3 id="hard-exclusion-title">需要确认排除缺失切片</h3>
        <p>上表中的站点月份不能按 0 计算。确认后只排除这些缺失切片，其余完整数据继续自动计算和发布。</p>
        <label class="form-field"><span>排除原因（选填）</span><textarea v-model="exclusionReason" rows="3" maxlength="1000" placeholder="可补充说明本次排除原因"></textarea></label>
      </section>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="stage-next-action"><span class="action-help">{{ requiresHardExclusionConfirmation ? '补充文件，或确认排除后继续处理。' : preview.status === 'PUBLISHED' ? '资料处理完成，可以进入计算复核。' : '系统会继续自动处理，当前状态会在本页更新。' }}</span><button v-if="retryableCommitFailure" class="primary-button" type="button" :disabled="checkingSelection || restoringLatest || resuming" @click="retryImport">{{ resuming ? "正在重试" : "重试入库" }}</button><template v-else-if="requiresHardExclusionConfirmation"><a class="secondary-button" href="#upload-source">补充文件</a><button class="primary-button" type="button" :disabled="resuming || checkingSelection || restoringLatest" @click="confirmHardExclusions">{{ resuming ? "正在继续" : "确认排除并继续" }}</button></template><a v-else-if="preview.status === 'FAILED'" class="secondary-button" href="#upload-source">补充文件</a><RouterLink v-else-if="preview.status === 'PUBLISHED'" class="primary-button" :to="`/shops/${shopId}/workflow/calculate`">进入计算复核</RouterLink></div>
    </section>
  </section>
</template>
