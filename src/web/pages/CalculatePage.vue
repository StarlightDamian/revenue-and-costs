<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { INTERMEDIATE_REPORT_COLUMNS, type IntermediateReportKind } from "../../shared/intermediate-report";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
import type { CompletenessSlice, IntermediateReportSummary, ShopWorkflow } from "../api/types";
import DateRangePicker from "../components/DateRangePicker.vue";
import PageHeader from "../components/PageHeader.vue";
import { projectCommitCoverage } from "../imports/commit-coverage";
import ResultsPage from "./ResultsPage.vue";

const props = defineProps<{ workflow?: ShopWorkflow | null }>();
const emit = defineEmits<{ workflowChange: [] }>();
const route = useRoute();
const shopId = computed(() => String(route.params.shopId));
const current = ref<ShopWorkflow | null>(props.workflow ?? null);
const error = ref("");
const completeness = ref<CompletenessSlice[]>([]);
const exclusionReason = ref("");
const resuming = ref(false);
const intermediateKind = ref<IntermediateReportKind>("TRANSACTION");
const intermediateItems = ref<Array<Record<string, string>>>([]);
const summary = ref<IntermediateReportSummary>();
const intermediateNext = ref<string>();
const intermediateAfter = ref<string>();
const intermediateHistory = ref<string[]>([]);
const intermediateLoading = ref(false);
const intermediateSummaryLoading = ref(false);
const intermediateSummaryReady = ref(false);
const grain = ref<"MONTH" | "DAY">("MONTH");
const start = ref("");
const end = ref("");
const selectedMarketplaces = ref<string[]>([]);
const selectedCurrencies = ref<string[]>([]);
const selectedColumnKeys = ref<string[]>([]);
const filterBar = ref<globalThis.HTMLElement | null>(null);
const reviewResultDisclosure = ref<globalThis.HTMLDetailsElement | null>(null);
const reviewResultOpen = ref(false);
let timer: number | undefined;
let reloadInFlight = false;
let intermediateSummaryRequestSequence = 0;
let intermediateListRequestSequence = 0;
let intermediateKindChangeSequence = 0;

const calculation = computed(() => current.value?.steps.find((step) => step.code === "CALCULATE"));
const publication = computed(() => current.value?.steps.find((step) => step.code === "PUBLISH"));
const canManage = computed(() => Boolean(current.value && current.value.shop.access !== "CUSTOMER"));
const requiresHardExclusionConfirmation = computed(() => current.value?.latestBatch?.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
const requiresDateAttributionReplay = computed(() => current.value?.latestBatch?.failureCode === "CALCULATION_DATE_ATTRIBUTION_MODE_MIXED");
const fxCoverageFailure = computed(() => /^(FX_DATA_GAP|FX_NO_AVAILABLE_QUOTE)(?::([A-Z]{3}):(\d{4}-\d{2}-\d{2}))?$/u.exec(current.value?.latestBatch?.failureCode ?? ""));
const requiresFxCoverage = computed(() => Boolean(fxCoverageFailure.value));
const fxCoverageSubject = computed(() => fxCoverageFailure.value?.[2] && fxCoverageFailure.value[3]
  ? `${fxCoverageFailure.value[3]} ${fxCoverageFailure.value[2]}/CNY`
  : "报表日期对应币种");
const missingCoverageRows = computed(() => projectCommitCoverage(completeness.value));
const showResults = computed(() => !canManage.value || calculation.value?.state === "COMPLETED" || publication.value?.state === "IN_PROGRESS" || publication.value?.state === "COMPLETED");
const allColumns = computed(() => INTERMEDIATE_REPORT_COLUMNS[intermediateKind.value]);
const visibleColumns = computed(() => allColumns.value.filter((column) => selectedColumnKeys.value.includes(column.key)));
const blockingCount = computed(() => current.value?.steps.reduce((sum, step) => sum + step.blockingCount, 0) ?? 0);
const warningCount = computed(() => current.value?.steps.reduce((sum, step) => sum + step.warningCount, 0) ?? 0);
const stateText = computed(() => requiresHardExclusionConfirmation.value ? "资料缺失待确认" : requiresDateAttributionReplay.value ? "日期计算方式待统一" : requiresFxCoverage.value ? "汇率数据待补齐" : calculation.value?.severity === "BLOCKING" ? "需要先处理问题" : calculation.value?.state === "COMPLETED" ? "计算完成" : calculation.value?.state === "IN_PROGRESS" ? "计算中" : "等待资料");
const intermediateBusy = computed(() => intermediateSummaryLoading.value || intermediateLoading.value);
const intermediateExportReady = computed(() => intermediateSummaryReady.value && !intermediateBusy.value);

function decimalDisplay(value: string, scale = 2): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (!match) return value;
  const fraction = (match[3] ?? "").padEnd(scale + 1, "0");
  const factor = 10n ** BigInt(scale);
  let units = BigInt(match[2]!) * factor + BigInt(fraction.slice(0, scale) || "0");
  if ((fraction[scale] ?? "0") >= "5") units += 1n;
  const whole = (units / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${match[1]}${whole}.${(units % factor).toString().padStart(scale, "0")}`;
}

function intermediateValue(item: Record<string, string>, key: string): string {
  const definition = allColumns.value.find((column) => column.key === key);
  const value = item[key] ?? "";
  if (!definition || ["text", "date"].includes(definition.kind) || value === "") return value;
  return decimalDisplay(value, definition.kind === "rate" ? 8 : 2);
}

function monthEnd(value: string): string {
  const match = /^(\d{4})-(\d{2})$/u.exec(value);
  if (!match) return value;
  const lastDay = new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate();
  return `${value}-${String(lastDay).padStart(2, "0")}`;
}

function filterQuery(): URLSearchParams {
  const query = new URLSearchParams();
  if (selectedMarketplaces.value.length) query.set("marketplaces", [...selectedMarketplaces.value].sort().join(","));
  if (selectedCurrencies.value.length) query.set("currencies", [...selectedCurrencies.value].sort().join(","));
  if (start.value) query.set("start", grain.value === "MONTH" ? `${start.value}-01` : start.value);
  if (end.value) query.set("end", grain.value === "MONTH" ? monthEnd(end.value) : end.value);
  return query;
}

const exportUrl = computed(() => api.intermediateReportExportUrl(shopId.value, intermediateKind.value, filterQuery()));

function restoreColumns(): void {
  const key = `revenue-cost-columns-${intermediateKind.value}`;
  const valid = new Set(allColumns.value.map((column) => column.key));
  try {
    const saved = JSON.parse(window.localStorage.getItem(key) ?? "[]") as string[];
    selectedColumnKeys.value = saved.filter((item) => valid.has(item));
  } catch { selectedColumnKeys.value = []; }
  if (!selectedColumnKeys.value.length) selectedColumnKeys.value = allColumns.value.filter((column) => column.defaultVisible).map((column) => column.key);
}

function saveColumns(): void {
  window.localStorage.setItem(`revenue-cost-columns-${intermediateKind.value}`, JSON.stringify(selectedColumnKeys.value));
}

async function loadSummary(resetCoverage = false) {
  const sequence = ++intermediateSummaryRequestSequence;
  const requestedKind = intermediateKind.value;
  intermediateSummaryLoading.value = true;
  intermediateSummaryReady.value = false;
  let next: IntermediateReportSummary;
  try {
    next = await api.getIntermediateReportSummary(shopId.value, requestedKind, filterQuery());
  } catch (caught) {
    if (sequence !== intermediateSummaryRequestSequence || requestedKind !== intermediateKind.value) return;
    intermediateSummaryLoading.value = false;
    throw caught;
  }
  if (sequence !== intermediateSummaryRequestSequence || requestedKind !== intermediateKind.value) return;
  summary.value = next;
  if (resetCoverage) {
    const startValue = next.coverage.start ?? "";
    const endValue = next.coverage.end ?? "";
    start.value = grain.value === "MONTH" ? startValue.slice(0, 7) : startValue;
    end.value = grain.value === "MONTH" ? endValue.slice(0, 7) : endValue;
  }
  intermediateSummaryReady.value = true;
  intermediateSummaryLoading.value = false;
}

async function loadIntermediate(after?: string) {
  const sequence = ++intermediateListRequestSequence;
  const requestedKind = intermediateKind.value;
  intermediateLoading.value = true;
  error.value = "";
  try {
    const page = await api.getIntermediateReport(shopId.value, requestedKind, filterQuery(), after);
    if (sequence !== intermediateListRequestSequence || requestedKind !== intermediateKind.value) return;
    intermediateItems.value = page.items;
    intermediateNext.value = page.nextCursor;
    intermediateAfter.value = after;
  } catch (caught) {
    if (sequence === intermediateListRequestSequence && requestedKind === intermediateKind.value) error.value = userFacingError(caught, "暂时无法读取计算明细，请检查网络后重试");
  }
  finally { if (sequence === intermediateListRequestSequence) intermediateLoading.value = false; }
}

async function applyFilters() {
  intermediateHistory.value = [];
  try { await Promise.all([loadSummary(), loadIntermediate()]); }
  catch (caught) { error.value = userFacingError(caught, "筛选没有成功，请检查网络后重试"); }
}

async function resetFilters() {
  selectedMarketplaces.value = [];
  selectedCurrencies.value = [];
  grain.value = "MONTH";
  await loadSummary(true);
  await loadIntermediate();
}

async function changeIntermediateKind(kind: IntermediateReportKind) {
  const sequence = ++intermediateKindChangeSequence;
  intermediateListRequestSequence += 1;
  intermediateKind.value = kind;
  intermediateHistory.value = [];
  restoreColumns();
  selectedMarketplaces.value = [];
  selectedCurrencies.value = [];
  intermediateItems.value = [];
  intermediateNext.value = undefined;
  intermediateAfter.value = undefined;
  summary.value = undefined;
  intermediateLoading.value = true;
  error.value = "";
  try {
    await loadSummary(true);
    if (sequence !== intermediateKindChangeSequence || intermediateKind.value !== kind) return;
    await loadIntermediate();
  } catch (caught) {
    if (sequence === intermediateKindChangeSequence && intermediateKind.value === kind) {
      error.value = userFacingError(caught, "暂时无法切换明细类型，请检查网络后重试");
      intermediateLoading.value = false;
    }
  }
}

function changeGrain(next: "MONTH" | "DAY") {
  grain.value = next;
  const coverage = summary.value?.coverage;
  start.value = grain.value === "MONTH" ? (coverage?.start ?? "").slice(0, 7) : coverage?.start ?? "";
  end.value = grain.value === "MONTH" ? (coverage?.end ?? "").slice(0, 7) : coverage?.end ?? "";
}

function closeFilterPopovers(event: globalThis.PointerEvent) {
  if (!(event.target instanceof globalThis.Node)) return;
  for (const details of filterBar.value?.querySelectorAll<globalThis.HTMLDetailsElement>(".filter-popover[open]") ?? []) {
    if (!details.contains(event.target)) details.open = false;
  }
}

function openReviewResult() {
  if (!reviewResultDisclosure.value) return;
  reviewResultDisclosure.value.open = true;
  reviewResultOpen.value = true;
}

function syncReviewResultOpen(event: Event) {
  const disclosure = event.currentTarget;
  if (disclosure instanceof globalThis.HTMLDetailsElement) reviewResultOpen.value = disclosure.open;
}

function guardIntermediateExport(event: globalThis.MouseEvent) {
  if (!intermediateExportReady.value) event.preventDefault();
}

async function nextIntermediate() { if (intermediateNext.value) { intermediateHistory.value.push(intermediateAfter.value ?? ""); await loadIntermediate(intermediateNext.value); } }
async function previousIntermediate() { const prior = intermediateHistory.value.pop(); if (prior !== undefined) await loadIntermediate(prior || undefined); }

async function reload() {
  if (reloadInFlight) return;
  reloadInFlight = true;
  try {
    current.value = await api.getShopWorkflow(shopId.value); error.value = ""; emit("workflowChange");
    const period = current.value.latestBatch?.periodStart && current.value.latestBatch.periodEnd
      ? { periodStart: current.value.latestBatch.periodStart, periodEnd: current.value.latestBatch.periodEnd }
      : undefined;
    completeness.value = requiresHardExclusionConfirmation.value ? await api.getCompleteness(shopId.value, period) : [];
  } catch (caught) { error.value = userFacingError(caught, "暂时无法读取计算状态，请检查网络后重试"); }
  finally { reloadInFlight = false; }
}

async function confirmHardExclusions() {
  const batchId = current.value?.latestBatch?.id;
  const slices = missingCoverageRows.value.filter((slice) => slice.datasetVersionId);
  if (!batchId || slices.length === 0) { error.value = "没有可确认的缺少资料项目，请刷新状态"; return; }
  resuming.value = true;
  error.value = "";
  try {
    const reason = exclusionReason.value.trim();
    for (const slice of slices) await api.acknowledgeImportIssue(shopId.value, slice.datasetVersionId!, reason);
    await api.confirmImport(shopId.value, batchId);
    exclusionReason.value = "";
    await reload();
    if (!requiresHardExclusionConfirmation.value) {
      await loadSummary(true);
      await loadIntermediate();
    }
  } catch (caught) { error.value = userFacingError(caught, "暂时无法保存本次选择，请稍后重试"); }
  finally { resuming.value = false; }
}

watch(() => props.workflow, (next) => { if (next) current.value = next; });
onMounted(async () => {
  document.addEventListener("pointerdown", closeFilterPopovers);
  restoreColumns();
  await reload();
  if (canManage.value && !requiresHardExclusionConfirmation.value) {
    await loadSummary(true);
    await loadIntermediate();
  }
  timer = window.setInterval(() => { if (calculation.value?.state === "IN_PROGRESS" || publication.value?.state === "IN_PROGRESS") void reload(); }, 1800);
});
onBeforeUnmount(() => { if (timer) window.clearInterval(timer); document.removeEventListener("pointerdown", closeFilterPopovers); });
</script>

<template>
  <section class="workflow-stage-page calculation-workbench" data-density="9">
    <PageHeader title="计算复核" description="在一个页面内处理资料问题、核对计算明细并发布正式结果。">
      <template #actions><button class="secondary-button compact" type="button" @click="reload">刷新状态</button></template>
    </PageHeader>

    <section v-if="canManage" class="calculation-status-strip" :data-severity="requiresHardExclusionConfirmation || requiresDateAttributionReplay ? 'BLOCKING' : calculation?.severity">
      <div><span>运行状态</span><b>{{ stateText }}</b></div><div><span>输入版本</span><b>{{ current?.latestBatch?.calculationRunId?.slice(0, 8) || current?.latestBatch?.id.slice(0, 8) || "—" }}</b></div><div><span>覆盖日期</span><b>{{ summary?.coverage.start || "—" }} 至 {{ summary?.coverage.end || "—" }}</b></div>
      <div><span>站点 / 币种</span><b>{{ summary?.options.marketplaces.length ?? 0 }} / {{ summary?.options.currencies.length ?? 0 }}</b></div><div><span>筛选行数</span><b>{{ summary?.matchedRows ?? "0" }}</b></div>
      <div><span>必须处理 / 提醒</span><b>{{ blockingCount }} / {{ warningCount }}</b></div><div><span>正式结果</span><b>{{ publication?.state === "COMPLETED" ? "已发布" : publication?.state === "IN_PROGRESS" ? "发布中" : "待发布" }}</b></div>
      <a v-if="requiresHardExclusionConfirmation" class="primary-button compact" href="#review-blocker">处理资料缺失</a>
      <RouterLink v-else-if="requiresDateAttributionReplay" class="primary-button compact" :to="`/shops/${shopId}/workflow/commit`">按同一种日期方式重传</RouterLink>
      <RouterLink v-else-if="requiresFxCoverage" class="primary-button compact" to="/fx">查看汇率覆盖</RouterLink>
      <a v-else-if="showResults" class="primary-button compact" href="#review-result" @click="openReviewResult">{{ publication?.state === 'COMPLETED' ? "查看正式结果" : "核对并发布" }}</a>
      <RouterLink v-else-if="calculation?.state === 'NOT_STARTED'" class="secondary-button compact" :to="`/shops/${shopId}/workflow/commit`">返回资料准备</RouterLink>
      <span v-else class="status-next">下一步：等待计算完成</span>
    </section>

    <section v-if="requiresDateAttributionReplay" class="surface-section quality-blocker" aria-labelledby="date-attribution-blocker-title">
      <h2 id="date-attribution-blocker-title">当前资料使用了不同的日期计算方式</h2>
      <p>同一份正式结果中的日期必须按同一种方法计算。请返回资料准备，按报表上显示的日期重新上传这一范围内的全部资料。这项问题必须修正后才能继续。</p>
    </section>

    <section v-if="requiresFxCoverage" class="surface-section quality-blocker" aria-labelledby="fx-coverage-blocker-title">
      <h2 id="fx-coverage-blocker-title">计算所需汇率缺失</h2>
      <p>{{ fxCoverageSubject }} 没有可用报价。请由管理员依据授权来源补齐汇率后重新导入；系统不会借用旧报价或猜测汇率。</p>
    </section>

    <section v-if="requiresHardExclusionConfirmation" id="review-blocker" class="surface-section workflow-commit-panel">
      <div class="section-heading"><h2>资料缺失，确认后继续</h2><p>资料缺失会在本页直接处理。您可以补充文件，也可以确认不计算缺少资料的项目。</p></div>
      <div v-if="missingCoverageRows.length" class="table-scroll commit-coverage-table" tabindex="0" role="region" aria-label="计算复核缺失资料"><table><thead><tr><th>站点</th><th>月份</th><th>缺失内容</th></tr></thead><tbody><tr v-for="slice in missingCoverageRows" :key="slice.datasetVersionId || `${slice.marketplace}-${slice.month}`" data-missing="true"><td>{{ slice.marketplace }}</td><td>{{ slice.month }}</td><td><span class="missing-data-chip"><b aria-hidden="true">!</b>缺少{{ slice.missingContent }}</span></td></tr></tbody></table></div>
      <div v-else class="inline-empty">正在读取缺失项，请刷新状态后重试。</div>
      <section class="quality-blocker" aria-labelledby="review-exclusion-title"><h3 id="review-exclusion-title">确认不计算缺少资料的项目</h3><p>缺失资料不能当作 0 计算。确认后，上表项目不会计入结果，其余资料继续计算。</p><label class="form-field"><span>不计算的原因（选填）</span><textarea v-model="exclusionReason" rows="3" maxlength="1000" placeholder="可补充说明为什么不计算这些项目"></textarea></label></section>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <div class="stage-next-action"><span>也可以返回资料准备页补充文件。</span><RouterLink class="secondary-button" :to="`/shops/${shopId}/workflow/commit`">补充文件</RouterLink><button class="primary-button" type="button" :disabled="resuming || !missingCoverageRows.length" @click="confirmHardExclusions">{{ resuming ? "正在继续" : "确认排除并继续" }}</button></div>
    </section>

    <section v-if="canManage && !requiresHardExclusionConfirmation" class="surface-section intermediate-results" aria-labelledby="intermediate-title" :aria-busy="intermediateBusy">
      <div class="section-heading split-heading"><div><h2 id="intermediate-title">系统识别出的明细</h2><p>可按日期、站点和币种查看；合计会计算所有符合条件的明细，不只计算当前这一页。</p></div><a class="primary-button compact intermediate-export-link" role="link" :href="intermediateExportReady ? exportUrl : undefined" :aria-disabled="!intermediateExportReady" :title="intermediateExportReady ? undefined : '明细加载完成后可导出'" tabindex="0" @click="guardIntermediateExport">导出当前{{ intermediateKind === "TRANSACTION" ? "交易报告" : "配送货件" }}</a></div>
      <div class="segmented-control intermediate-kind-control" role="group" aria-label="明细类型"><button type="button" :class="{ active: intermediateKind === 'TRANSACTION' }" :aria-pressed="intermediateKind === 'TRANSACTION'" @click="changeIntermediateKind('TRANSACTION')">交易报告</button><button type="button" :class="{ active: intermediateKind === 'SHIPMENT' }" :aria-pressed="intermediateKind === 'SHIPMENT'" @click="changeIntermediateKind('SHIPMENT')">配送货件</button></div>

      <details class="intermediate-filter-drawer" open>
        <summary>筛选日期和显示内容</summary>
        <div ref="filterBar" class="intermediate-filter-bar">
        <details class="filter-popover"><summary>站点 {{ selectedMarketplaces.length ? `(${selectedMarketplaces.length})` : "全部" }}</summary><div><label v-for="value in summary?.options.marketplaces" :key="value"><input v-model="selectedMarketplaces" type="checkbox" :value="value" />{{ value }}</label></div></details>
        <details class="filter-popover"><summary>币种 {{ selectedCurrencies.length ? `(${selectedCurrencies.length})` : "全部" }}</summary><div><label v-for="value in summary?.options.currencies" :key="value"><input v-model="selectedCurrencies" type="checkbox" :value="value" />{{ value }}</label></div></details>
        <DateRangePicker :grain="grain" :start="start" :end="end" @update:grain="changeGrain" @update:start="start = $event" @update:end="end = $event" />
        <details class="filter-popover field-picker"><summary>显示列 ({{ visibleColumns.length }}/{{ allColumns.length }})</summary><div><label v-for="column in allColumns" :key="column.key"><input v-model="selectedColumnKeys" type="checkbox" :value="column.key" @change="saveColumns" />{{ column.header }}</label></div></details>
          <button class="primary-button compact" type="button" @click="applyFilters">应用筛选</button><button class="secondary-button compact" type="button" @click="resetFilters">重置</button>
        </div>
      </details>

      <p v-if="intermediateLoading" class="inline-empty" role="status" aria-live="polite">正在读取计算明细…</p>
      <div v-else-if="intermediateItems.length" class="intermediate-table-scroll" tabindex="0" role="region" :aria-label="`${intermediateKind === 'TRANSACTION' ? '交易报告' : '配送货件'}明细表`"><table><thead><tr><th v-for="column in visibleColumns" :key="column.key">{{ column.header }}</th></tr></thead><tbody><tr v-for="item in intermediateItems" :key="item.id"><td v-for="column in visibleColumns" :key="column.key" :class="{ numeric: !['text', 'date'].includes(column.kind) }">{{ intermediateValue(item, column.key) }}</td></tr></tbody><tfoot><tr v-for="total in summary?.totalsByCurrency" :key="total.currency"><th v-for="(column, index) in visibleColumns" :key="column.key">{{ index === 0 ? `${total.currency} 合计` : column.total ? decimalDisplay(total.values[column.key] ?? '0', column.kind === 'rate' ? 8 : 2) : "" }}</th></tr></tfoot></table></div>
      <p v-else class="inline-empty">当前筛选没有{{ intermediateKind === "TRANSACTION" ? "交易报告" : "配送货件" }}数据。</p>
      <div class="table-footer-actions"><span>{{ intermediateKind === "SHIPMENT" ? `人民币跨币种总计：${summary?.cnyTotal ? decimalDisplay(summary.cnyTotal) : "汇率不完整"}` : "原币金额按币种分别合计" }}</span><div><button class="secondary-button" type="button" :disabled="intermediateHistory.length === 0 || intermediateLoading" @click="previousIntermediate">上一页</button><button class="secondary-button" type="button" :disabled="!intermediateNext || intermediateLoading" @click="nextIntermediate">下一页</button></div></div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </section>

    <details v-if="showResults && !requiresHardExclusionConfirmation" id="review-result" ref="reviewResultDisclosure" class="review-result-disclosure surface-section" @toggle="syncReviewResultOpen">
      <summary><span class="review-result-summary-copy"><strong>核算结果</strong><small>展开查看九项指标、站点月份和费用来源。</small></span><span class="review-result-summary-action" aria-hidden="true">{{ reviewResultOpen ? "收起" : "展开" }}</span></summary>
      <ResultsPage :workflow="current" embedded @workflow-change="reload" />
    </details>
  </section>
</template>
