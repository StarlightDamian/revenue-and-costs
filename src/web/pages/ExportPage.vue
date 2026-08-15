<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { percentInputToRatio, ratioToPercentInput } from "../accounting-rates";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
import type { AccountingPreferences, CostAccountingPreview, ExportJob, ShopWorkflow } from "../api/types";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { formatMoney, formatRatio } from "../format";

const route = useRoute();
const router = useRouter();
const emit = defineEmits<{ workflowChange: [] }>();
const shopId = computed(() => String(route.params.shopId));
const jobs = ref<ExportJob[]>([]);
const workflow = ref<ShopWorkflow | null>(null);
const status = ref<"loading" | "ready" | "empty" | "error">("loading");
const error = ref("");
const actionError = ref("");
const routeError = ref("");
const busy = ref(false);
const previewBusy = ref(false);
const preferencesStatus = ref<"loading" | "ready" | "error">("loading");
const preferencesError = ref("");
const preview = ref<CostAccountingPreview | null>(null);
const profitRate = ref("");
const minimumSalesCostRate = ref("");
const continentPrefixes = ref<AccountingPreferences["continentPrefixes"]>(["EU"]);
const autoDownloaded = ref("");
let timer: number | undefined;
let reloadInFlight = false;
let applyingLoadedDefaults = false;
let profitRateEdited = false;
let minimumSalesCostRateEdited = false;
let assumptionRevision = 0;
let previewRequestSequence = 0;
const assumptionErrorText = (caught: unknown, fallback: string) => caught instanceof Error
  && /利润率|销售成本率/u.test(caught.message)
  ? caught.message
  : userFacingError(caught, fallback);

watch(profitRate, () => {
  if (applyingLoadedDefaults) return;
  profitRateEdited = true;
  assumptionRevision += 1;
  preview.value = null;
}, { flush: "sync" });
watch(minimumSalesCostRate, () => {
  if (applyingLoadedDefaults) return;
  minimumSalesCostRateEdited = true;
  assumptionRevision += 1;
  preview.value = null;
}, { flush: "sync" });

const canCreateExport = computed(() => workflow.value?.download.available === true);
const publishedLabel = computed(() => workflow.value?.publishedSnapshot?.publishedAt
  ? new Date(workflow.value.publishedSnapshot.publishedAt).toLocaleString("zh-CN", { hour12: false })
  : "尚无正式结果");

function currentAssumptions(): AccountingPreferences {
  return {
    profitRate: percentInputToRatio(profitRate.value, "利润率"),
    minimumSalesCostRate: percentInputToRatio(minimumSalesCostRate.value, "最低销售成本率"),
    continentPrefixes: continentPrefixes.value,
  };
}

function periodLabel(period: string): string {
  const month = /^\d{4}-(\d{2})$/u.exec(period)?.[1];
  return month ? `${Number(month)}月` : period;
}

async function reload(silent = false) {
  if (reloadInFlight) return;
  reloadInFlight = true;
  if (!silent) status.value = "loading";
  try {
    const [nextJobs, nextWorkflow] = await Promise.all([api.listExports(shopId.value), api.getShopWorkflow(shopId.value)]);
    jobs.value = [...nextJobs];
    workflow.value = nextWorkflow;
    emit("workflowChange");
    status.value = nextJobs.length ? "ready" : "empty";
    error.value = "";
    const autoId = typeof route.query.auto === "string" ? route.query.auto : "";
    const autoJob = nextJobs.find((job) => job.id === autoId);
    if (autoJob && !autoJob.isCurrentFormat) {
      routeError.value = "该链接指向旧版导出，请使用当前正式版本的下载入口";
      await router.replace({ name: "workflow-export", params: { shopId: shopId.value } });
    } else if (autoJob?.status === "SUCCEEDED" && autoDownloaded.value !== autoJob.id) {
      autoDownloaded.value = autoJob.id;
      await download(autoJob);
      await router.replace({ name: "workflow-export", params: { shopId: shopId.value } });
    } else if (autoId && !autoJob) {
      routeError.value = "未找到该导出任务，请重新生成";
      await router.replace({ name: "workflow-export", params: { shopId: shopId.value } });
    } else if (autoJob && ["FAILED", "CANCELLED", "REVOKED"].includes(autoJob.status)) {
      routeError.value = autoJob.status === "FAILED"
        ? "报告生成失败，请重新生成"
        : autoJob.status === "CANCELLED" ? "导出任务已取消" : "导出授权已撤销";
      await router.replace({ name: "workflow-export", params: { shopId: shopId.value } });
    }
  } catch (caught) {
    error.value = userFacingError(caught, "暂时无法读取下载任务，请检查网络后重试");
    status.value = "error";
  } finally { reloadInFlight = false; }
}

async function refreshPreview() {
  const sequence = ++previewRequestSequence;
  const revision = assumptionRevision;
  actionError.value = "";
  previewBusy.value = true;
  try {
    const nextPreview = await api.previewCostAccounting(shopId.value, currentAssumptions());
    if (sequence !== previewRequestSequence || revision !== assumptionRevision) return;
    preview.value = nextPreview;
  } catch (caught) {
    if (sequence !== previewRequestSequence || revision !== assumptionRevision) return;
    preview.value = null;
    actionError.value = assumptionErrorText(caught, "暂时无法预览成本测算，请检查网络后重试");
  } finally {
    if (sequence === previewRequestSequence) previewBusy.value = false;
  }
}

async function loadAccountingPreferences() {
  preferencesStatus.value = "loading";
  preferencesError.value = "";
  try {
    const defaults = await api.getAccountingPreferences();
    applyingLoadedDefaults = true;
    try {
      if (!profitRateEdited) profitRate.value = ratioToPercentInput(defaults.profitRate);
      if (!minimumSalesCostRateEdited) minimumSalesCostRate.value = ratioToPercentInput(defaults.minimumSalesCostRate);
      continentPrefixes.value = [...defaults.continentPrefixes];
    } finally {
      applyingLoadedDefaults = false;
    }
    await refreshPreview();
    preferencesStatus.value = "ready";
  } catch (caught) {
    preferencesStatus.value = "error";
    preferencesError.value = userFacingError(caught, "暂时无法读取默认测算参数，请手动填写后继续");
  }
}

async function initialize() {
  await reload();
  if (status.value === "error" || !canCreateExport.value) return;
  await loadAccountingPreferences();
}

async function createExport() {
  if (preferencesStatus.value !== "ready") {
    actionError.value = preferencesStatus.value === "loading"
      ? "正在读取默认测算参数，请稍候"
      : "默认测算参数读取失败，请先重试";
    return;
  }
  actionError.value = "";
  busy.value = true;
  try {
    const job = await api.createCurrentExport(shopId.value, currentAssumptions());
    await router.replace({ name: "workflow-export", params: { shopId: shopId.value }, query: { auto: job.id } });
    await reload(true);
  } catch (caught) {
    actionError.value = assumptionErrorText(caught, "暂时无法生成报告，请检查网络后重试");
  } finally { busy.value = false; }
}

async function cancel(job: ExportJob) {
  try { await api.cancelExport(job.id); await reload(true); }
  catch (caught) { actionError.value = userFacingError(caught, "暂时无法取消报告，请稍后重试"); }
}

async function download(job: ExportJob) {
  try {
    const result = await api.getDownloadUrl(job.id);
    window.location.assign(result.url);
  } catch (caught) {
    actionError.value = userFacingError(caught, "暂时无法开始下载，请检查网络后重试");
  }
}

function versionLabel(job: ExportJob): string {
  if (!job.isCurrentFormat) return "旧版导出";
  return job.snapshotId === workflow.value?.publishedSnapshot?.id ? "当前版本" : "历史版本";
}

const exportStageLabels: Readonly<Record<string, string>> = {
  QUEUED: "等待生成",
  VALIDATING: "检查正式结果",
  QUERYING: "整理数据",
  WRITING_NOTES: "整理计算说明",
  WRITING_MONTHLY: "写入月度账单",
  WRITING_QUARTERLY: "写入季度账单",
  WRITING_ANNUAL: "写入年度账单",
  WRITING_COST: "写入成本核算",
  FINALIZING_XLSX: "完成工作簿",
  HASHING: "检查文件",
  PACKAGING: "打包文件",
  ENCRYPTING: "安全保存",
  COMMITTING: "保存结果",
  SUCCEEDED: "已生成",
  FAILED: "生成失败",
  CANCELLED: "已取消",
  REVOKED: "授权已撤销",
};

const exportStatusLabels: Readonly<Record<ExportJob["status"], string>> = {
  QUEUED: "等待生成",
  RUNNING: "正在生成",
  SUCCEEDED: "已生成",
  FAILED: "生成失败",
  CANCELLED: "已取消",
  REVOKED: "授权已撤销",
};

function progressDetails(job: ExportJob): string {
  const stage = exportStageLabels[job.stage] ?? "正在生成";
  if (job.totalRows === null) return stage;
  return `${stage} · ${job.processedRows}/${job.totalRows} 行`;
}

watch(() => route.query.auto, () => { void reload(true); });
onMounted(() => {
  void initialize();
  timer = window.setInterval(() => {
    if (jobs.value.some((job) => ["QUEUED", "RUNNING"].includes(job.status)) || route.query.auto) void reload(true);
  }, 1800);
});
onBeforeUnmount(() => { if (timer) window.clearInterval(timer); });
</script>

<template>
  <section class="workflow-stage-page" data-density="4">
    <PageHeader title="报告交付" description="先预览本次测算参数，再为当前正式结果生成报告。下载时系统还会检查您是否有权限。" />
    <template v-if="canCreateExport">
      <section class="surface-section export-assumption-panel">
        <div class="section-heading"><h2>本次成本测算</h2><p>已带入“做账习惯”的默认值；此处修改只影响本次新导出。</p></div>
        <div class="form-grid accounting-rate-grid">
          <label class="form-field"><span>利润率（可选）</span><span class="suffix-input"><input v-model="profitRate" inputmode="decimal" autocomplete="off" placeholder="留空沿用平台结余" /><b>%</b></span></label>
          <label class="form-field"><span>最低销售成本率（可选）</span><span class="suffix-input"><input v-model="minimumSalesCostRate" inputmode="decimal" autocomplete="off" placeholder="留空不启用下限" /><b>%</b></span></label>
        </div>
        <p v-if="preferencesStatus === 'loading'" class="sandbox-notice" role="status">正在读取默认测算参数，完成后才能生成报告。</p>
        <div v-else-if="preferencesStatus === 'error'" class="warning-panel" role="alert"><span>{{ preferencesError }}</span><button class="secondary-button compact" type="button" @click="loadAccountingPreferences">重试读取默认参数</button></div>
        <div class="form-actions"><button class="secondary-button" type="button" :disabled="previewBusy" @click="refreshPreview">{{ previewBusy ? "正在预览" : "预览调整结果" }}</button></div>
        <div v-if="preview" class="cost-preview">
          <dl class="summary-list">
            <div><dt>{{ preview.year }} 年收入总额</dt><dd>¥{{ formatMoney(preview.total.incomeTotalCny) }}</dd></div>
            <div><dt>采购成本</dt><dd>¥{{ formatMoney(preview.total.procurementCny) }}</dd></div>
            <div><dt>利润</dt><dd>¥{{ formatMoney(preview.total.profitCny) }}</dd></div>
            <div><dt>销售成本率</dt><dd>{{ formatRatio(preview.total.salesCostRate) }}</dd></div>
          </dl>
          <p v-if="preview.total.minimumAdjusted" class="warning-panel">最低销售成本率已触发：采购成本已提高到下限，利润同步降低以保持“收入净额 = 平台支出 + 采购成本 + 利润”。</p>
          <div class="table-scroll" tabindex="0">
            <table>
              <thead><tr><th>月份</th><th>收入总额</th><th>收入净额</th><th>平台支出</th><th>利润</th><th>采购成本</th><th>销售成本率</th><th>下限</th></tr></thead>
              <tbody><tr v-for="row in preview.rows" :key="row.period"><td>{{ periodLabel(row.period) }}</td><td>¥{{ formatMoney(row.incomeTotalCny) }}</td><td>¥{{ formatMoney(row.netIncomeCny) }}</td><td>¥{{ formatMoney(row.platformExpensesCny) }}</td><td>¥{{ formatMoney(row.profitCny) }}</td><td>¥{{ formatMoney(row.procurementCny) }}</td><td>{{ formatRatio(row.salesCostRate) }}</td><td><span class="status-chip" :data-tone="row.minimumAdjusted ? 'warning' : undefined">{{ row.minimumAdjusted ? "已触发" : "—" }}</span></td></tr></tbody>
              <tfoot><tr class="cost-preview-total"><th>全年合计</th><th>¥{{ formatMoney(preview.total.incomeTotalCny) }}</th><th>¥{{ formatMoney(preview.total.netIncomeCny) }}</th><th>¥{{ formatMoney(preview.total.platformExpensesCny) }}</th><th>¥{{ formatMoney(preview.total.profitCny) }}</th><th>¥{{ formatMoney(preview.total.procurementCny) }}</th><th>{{ formatRatio(preview.total.salesCostRate) }}</th><th><span class="status-chip" :data-tone="preview.total.minimumAdjusted ? 'warning' : undefined">{{ preview.total.minimumAdjusted ? "已触发" : "—" }}</span></th></tr></tfoot>
            </table>
          </div>
        </div>
      </section>
      <section class="surface-section export-current-panel">
        <div class="export-current-copy">
          <span>当前正式版本</span>
          <h2>{{ publishedLabel }}</h2>
          <p v-if="workflow?.download.usesPreviousPublishedVersion">新一轮数据仍在处理中。当前流程发布完成前，下载保持禁用。</p>
          <p v-else>生成报告时，系统会记住当前正式结果和本次测算参数。之后再修改设置，也不会改变已经生成的报告。</p>
        </div>
        <button class="primary-button export-main-button" type="button" :disabled="busy || previewBusy || preferencesStatus !== 'ready'" @click="createExport">{{ busy ? "正在准备" : "生成并下载" }}</button>
        <p v-if="routeError" class="form-error" role="alert">{{ routeError }}</p><p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>
        <ol class="sheet-list" aria-label="报告包含的表格"><li>计算说明（默认隐藏）</li><li>月度明细账单</li><li>季度明细账单</li><li>年度明细账单</li><li>成本核算表-人民币</li></ol>
      </section>
    </template>
    <section v-else class="surface-section"><div class="warning-panel">当前没有可导出的正式结果，或客户关系尚未获得导出授权。在线查看权限不受影响。</div></section>

    <section class="surface-section">
      <div class="section-heading"><h2>下载任务</h2><p>如果正式结果、文件格式和两项测算参数都没有变化，系统会直接使用已生成的报告。</p></div>
      <AsyncState :status="status" :error="error" empty-title="暂无下载任务" empty-message="点击“生成并下载”后，生成进度会显示在这里。" @retry="initialize()">
        <div class="table-scroll" tabindex="0"><table><thead><tr><th>创建时间</th><th>正式版本</th><th>测算参数</th><th>格式</th><th>状态</th><th>进度</th><th>操作</th></tr></thead><tbody><tr v-for="job in jobs" :key="job.id" :data-current="job.isCurrentFormat && job.snapshotId === workflow?.publishedSnapshot?.id ? 'true' : 'false'"><td>{{ new Date(job.createdAt).toLocaleString("zh-CN", { hour12: false }) }}</td><td>{{ versionLabel(job) }}</td><td>利润率 {{ formatRatio(job.profitRate ?? undefined) }} / 下限 {{ formatRatio(job.minimumSalesCostRate ?? undefined) }}</td><td>{{ job.format }}<span v-if="!job.isCurrentFormat">（旧版格式）</span></td><td>{{ exportStatusLabels[job.status] }}<small v-if="job.status === 'FAILED'"><br />报告没有生成成功，请重新生成。</small></td><td><strong>{{ job.progress }}%</strong><br /><small>{{ progressDetails(job) }}</small></td><td><div class="table-actions"><button v-if="['QUEUED','RUNNING'].includes(job.status)" class="secondary-button compact" type="button" @click="cancel(job)">取消</button><button v-if="job.status === 'SUCCEEDED'" class="primary-button compact" type="button" @click="download(job)">{{ job.isCurrentFormat ? "下载" : "下载旧版" }}</button><button v-if="job.status === 'FAILED' && canCreateExport" class="secondary-button compact" type="button" :disabled="busy || preferencesStatus !== 'ready'" @click="createExport">重新生成</button><span v-if="job.status === 'REVOKED'">授权已撤销</span></div></td></tr></tbody></table></div>
      </AsyncState>
    </section>
  </section>
</template>
