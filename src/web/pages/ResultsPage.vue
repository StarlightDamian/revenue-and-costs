<script setup lang="ts">
import { computed, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
import type { ReportMetric, ShopWorkflow, SliceState } from "../api/types";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";
import { formatMoney, formatRatio } from "../format";
import { projectCommitCoverage } from "../imports/commit-coverage";
import { canAccessShopPage } from "../navigation";

const route = useRoute(); const shopId = computed(() => String(route.params.shopId));
const props = withDefaults(defineProps<{ workflow?: ShopWorkflow | null; embedded?: boolean }>(), { embedded: false });
const emit = defineEmits<{ workflowChange: [] }>();
const start = ref(""); const end = ref(""); const marketplace = ref("");
const query = () => { const value = new URLSearchParams(); if (start.value) value.set("start", start.value); if (end.value) value.set("end", end.value); if (marketplace.value) value.set("marketplace", marketplace.value); return value; };
const { data: report, status, error, reload } = useAsyncResource(() => api.getReport(shopId.value, query()));
const { data: shops } = useAsyncResource(api.listShops);
const selectedShop = computed(() => shops.value?.find((candidate) => candidate.id === shopId.value));
const canManage = computed(() => canAccessShopPage(selectedShop.value, "MANAGE_IMPORT"));
const canExport = computed(() => canAccessShopPage(selectedShop.value, "EXPORT"));
const publishing = ref(false); const actionError = ref("");
const metricNames: Record<ReportMetric["key"], string> = { income: "收入总额", refund: "退款金额", withheldTax: "平台代扣税", platformFee: "平台费", fbaDelivery: "FBA 发货费", advertising: "广告费", storage: "FBA 仓储费", other: "其他扣费", balance: "平台结余" };
const stateNames: Record<SliceState, string> = { COMPLETE: "资料齐全", PUBLISHED_WARNING: "已计入，有数量差异", MISSING_TRANSACTION: "缺交易报告", MISSING_SHIPMENT: "缺配送货件", MISSING_FX: "缺汇率", AWAITING_MAPPING: "需要确认表格每列的含义", CONFLICT: "数量差异待确认", EXCLUDED: "已确认不计算", STALE: "需要刷新资料" };
const feeCategoryNames: Readonly<Record<string, string>> = {
  PLATFORM_FEE: "平台服务费",
  FBA_FULFILLMENT_FEE: "FBA 发货配送费",
  ADVERTISING_FEE: "广告费",
  FBA_STORAGE_FEE: "FBA 仓储费",
  OTHER_DEDUCTION: "其他扣费",
  EXCLUDED_TRANSFER_DEBT: "不计入结果的转账或欠款",
};
const feeCategoryName = (category: string) => feeCategoryNames[category] ?? "其他费用";
const modeLabel = computed(() => report.value?.mode === "PUBLISHED" ? "正式结果" : report.value?.mode === "STALE" ? "计算未完成" : "试算结果");
const modeTone = computed(() => report.value?.mode === "PUBLISHED" ? "official" : "warning");
const completenessDisclosures = computed(() => projectCommitCoverage(
  report.value?.completeness ?? [],
  { includeNonMissing: true },
));

async function publish() {
  if (!report.value?.canPublish || report.value.mode === "STALE") return;
  if (report.value.completeness.some((slice) => !slice.sliceId || !slice.datasetVersionId || !slice.disposition)) {
    actionError.value = "本次计算缺少发布需要的资料信息，暂时不能发布。请刷新页面重试；如果仍然出现，请联系管理员。";
    return;
  }
  publishing.value = true; actionError.value = "";
  try {
    report.value = await api.publishReport(shopId.value, report.value);
    emit("workflowChange");
  }
  catch (caught) { actionError.value = userFacingError(caught, "暂时无法发布正式结果，请检查网络后重试"); }
  finally { publishing.value = false; }
}
</script>

<template>
  <section :class="props.embedded ? 'review-result-panel' : 'workflow-stage-page'" data-density="7">
    <PageHeader v-if="!props.embedded" title="计算复核" description="核对试算结果，确认无误后保存为正式结果。" :status="modeLabel" :tone="modeTone" />
    <div v-else class="section-heading"><h2>核算结果</h2><p><span class="status-chip" :data-state="report?.mode === 'PUBLISHED' ? 'COMPLETE' : 'STALE'">{{ modeLabel }}</span> 核对九项指标、缺失资料和费用来源后，在本页发布正式结果。</p></div>
    <div class="filter-bar"><label><span>开始日期</span><input v-model="start" type="date" /></label><label><span>结束日期</span><input v-model="end" type="date" /></label><label><span>站点</span><input v-model.trim="marketplace" placeholder="全部站点" /></label><button class="secondary-button compact" type="button" @click="reload">应用筛选</button></div>
    <p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>
    <AsyncState :status="status" :error="error" empty-title="暂无可查看结果" empty-message="负责人需要先完成资料准备和计算；客户只能看到正式结果。" @retry="reload">
      <div v-if="report?.mode === 'STALE'" class="warning-panel" role="alert"><strong>本次计算还没有完成</strong><p>为避免把不完整的金额当成正式结果，这里暂不显示金额。请稍后刷新页面；如果一直没有完成，请回到资料准备查看提示并重试。</p></div>
      <template v-else>
        <div v-if="report?.notices.length" class="notice-stack"><div v-for="notice in report.notices" :key="notice" class="warning-panel">{{ notice }}</div></div>
        <div class="metric-grid" aria-label="九项核心指标"><article v-for="metric in report?.metrics" :key="metric.key" :class="{ 'is-balance': metric.key === 'balance' }"><span>{{ metricNames[metric.key] }}</span><strong>¥ {{ formatMoney(metric.amountCny) }}</strong><small>占收入 {{ formatRatio(metric.ratioOfIncome) }}</small></article></div>
        <p class="scope-notice">平台结余尚未扣除采购成本、人工和税费等，不等同于净利润。</p>
        <section class="surface-section">
          <div class="section-heading"><h2>需要注意的站点和月份</h2><p>已确认不计算的资料不会计入总额；已计入结果的数量差异也会一直显示，方便以后核对。</p></div>
          <div v-if="completenessDisclosures.length" class="table-scroll commit-coverage-table" tabindex="0"><table><thead><tr><th>站点</th><th>月份</th><th>资料情况</th><th>状态</th><th>这代表什么</th></tr></thead><tbody><tr v-for="slice in completenessDisclosures" :key="`${slice.marketplace}-${slice.month}`" data-missing="true"><td>{{ slice.marketplace }}</td><td>{{ slice.month }}</td><td><span class="missing-data-chip"><b aria-hidden="true">!</b>{{ slice.summary }}</span></td><td><span class="status-chip" :data-state="slice.state">{{ stateNames[slice.state] }}</span></td><td>{{ slice.explanation }}</td></tr></tbody></table></div>
          <div v-else-if="report?.completeness.length" class="warning-panel" data-tone="success" role="status"><strong>资料已可核算</strong><p>配送货件或纯 FMB 交易资料已覆盖当前站点和月份，可以继续发布。</p></div>
          <div v-else class="inline-empty">当前结果没有可展示的站点和月份。</div>
        </section>
        <section class="surface-section">
          <div class="section-heading"><h2>费用明细与来源</h2><p>每一笔费用只会算到一个类别中，并保留它来自原表的哪一行，方便核对。</p></div>
          <div v-if="report?.fees.length" class="table-scroll" tabindex="0"><table><thead><tr><th>类别</th><th>站点</th><th>月份</th><th>涉及原表行数</th><th>人民币金额</th></tr></thead><tbody><tr v-for="fee in report.fees" :key="`${fee.category}-${fee.marketplace}-${fee.month}`"><td>{{ feeCategoryName(fee.category) }}</td><td>{{ fee.marketplace }}</td><td>{{ fee.month }}</td><td class="numeric">{{ fee.sourceRows }}</td><td class="numeric">{{ formatMoney(fee.amountCny) }}</td></tr></tbody></table></div><div v-else class="inline-empty">当前筛选范围内没有费用明细。</div>
        </section>
        <section class="version-strip" aria-label="本次结果使用的内容"><div><span>资料</span><b>{{ report?.dataVersion }}</b></div><div><span>表格规则</span><b>{{ report?.mappingVersion }}</b></div><div><span>日期</span><b>{{ report?.timezoneVersion }}</b></div><div><span>站点规则</span><b>{{ report?.policyVersion }}</b></div><div><span>计算公式</span><b>{{ report?.formulaVersion }}</b></div><div><span>汇率</span><b>{{ report?.fxVersion }}</b></div><div><span>计算时间</span><b>{{ report?.calculatedAt }}</b></div></section>
      </template>
    </AsyncState>
    <div v-if="report" class="stage-next-action"><span>{{ report.mode === 'STALE' ? '本次计算还没有完成，暂时不能发布' : props.workflow?.download.available ? '正式结果已发布，可以进入报告交付' : '当前流程尚未产生可下载的正式结果' }}</span><button v-if="canManage && report.mode !== 'STALE' && report.canPublish" class="primary-button" type="button" :disabled="publishing" @click="publish">{{ publishing ? "正在发布" : "发布正式结果" }}</button><RouterLink v-if="props.workflow?.download.available && canExport" class="primary-button" :to="`/shops/${shopId}/workflow/export`">进入报告交付</RouterLink></div>
  </section>
</template>
