<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "../api/client";
import type { FxConversionRow, FxQuote } from "../api/types";
import { writeTextToClipboard } from "../clipboard";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";
import { formatFxRateColumn, normalizeCurrencyCode } from "../fx-conversion";
import { defaultFxHistoryRange, FX_CURRENCY_OPTIONS, pivotFxHistory } from "../fx-history";

const { data: fxStatus, status, error, reload } = useAsyncResource(api.getFxStatus);
const defaultRange = defaultFxHistoryRange();
const start = ref(defaultRange.from); const end = ref(defaultRange.to); const currencies = ref("");
const history = ref<FxQuote[]>([]); const historyState = ref<"idle" | "loading" | "error">("idle"); const historyError = ref("");
const from = ref("CNY"); const to = ref("USD"); const lines = ref(""); const rows = ref<FxConversionRow[]>([]); const convertError = ref(""); const copyMessage = ref(""); const copyFailed = ref(false);
const taskLabel = computed(() => fxStatus.value?.taskStatus ?? "未知");
const historyPivot = computed(() => pivotFxHistory(history.value));

async function queryHistory() {
  historyState.value = "loading"; historyError.value = "";
  try {
    const query = new URLSearchParams(); if (start.value) query.set("from", start.value); if (end.value) query.set("to", end.value); if (currencies.value.trim()) query.set("currencies", currencies.value.trim());
    history.value = await api.getFxHistory(query); historyState.value = "idle";
  } catch (caught) { historyState.value = "error"; historyError.value = caught instanceof Error ? caught.message : "查询失败"; }
}

onMounted(() => { void queryHistory(); });

async function convert() {
  convertError.value = ""; copyMessage.value = "";
  from.value = normalizeCurrencyCode(from.value); to.value = normalizeCurrencyCode(to.value);
  try { rows.value = await api.convertFx({ from: from.value, to: to.value, lines: lines.value.split(/\r?\n/) }); }
  catch (caught) { convertError.value = caught instanceof Error ? caught.message : "换算失败"; }
}

async function copyRates() {
  copyMessage.value = ""; copyFailed.value = false;
  try {
    await writeTextToClipboard(formatFxRateColumn(rows.value));
    copyMessage.value = `已复制 ${rows.value.length} 行汇率，可直接粘贴到 Excel 单列。`;
  } catch (caught) {
    copyFailed.value = true; copyMessage.value = "复制失败，请确认浏览器允许此页面使用剪贴板。";
    globalThis.console.error("fx_rate_column_copy_failed", { errorName: caught instanceof Error ? caught.name : typeof caught, secureContext: globalThis.isSecureContext });
  }
}
</script>

<template>
  <section>
    <PageHeader title="外汇市场" description="查询 ChinaMoney 规范化报价，并按报表显示日期批量换算。" :status="`同步任务：${taskLabel}`" :tone="fxStatus?.gaps.length ? 'warning' : 'official'" />
    <AsyncState :status="status" :error="error" @retry="reload">
      <section class="status-strip fx-status-strip"><div><span>数据来源</span><strong>{{ fxStatus?.source }}</strong></div><div><span>数据库覆盖</span><strong>{{ fxStatus?.coverageStart || "未回填" }} 至 {{ fxStatus?.coverageEnd || "未回填" }}</strong></div><div><span>已保存报价</span><strong>{{ fxStatus?.quoteCount ?? 0 }} 条</strong></div><div><span>最后同步</span><strong>{{ fxStatus?.lastSucceededAt || "尚未成功" }}</strong></div></section>
      <div v-if="fxStatus && !fxStatus.syncEnabled" class="warning-panel" role="status"><strong>自动汇率同步未启用</strong><p>当前页面展示数据库中最近一次手工同步的数据；管理员可运行 <code>pnpm fx:sync</code> 更新全量历史报价。</p></div>
      <div v-if="fxStatus?.gaps.length" class="warning-panel" role="alert"><strong>存在官方报价缺口</strong><p>开市日缺少目标币对时不会继续寻找其他日期报价，相关切片将阻止发布。</p><ul><li v-for="gap in fxStatus.gaps" :key="`${gap.date}-${gap.currency}`">{{ gap.date }} {{ gap.currency }}：{{ gap.reason }}</li></ul></div>
    </AsyncState>
    <section class="surface-section">
      <div class="section-heading"><h2>历史报价</h2><p>默认展示近一个月的官方币对报价，汇率固定显示 8 位小数。</p></div>
      <div class="form-grid four"><label class="form-field"><span>开始日期</span><input v-model="start" type="date" /></label><label class="form-field"><span>结束日期</span><input v-model="end" type="date" /></label><label class="form-field span-two"><span>币种（逗号分隔，留空显示全部）</span><input v-model="currencies" placeholder="例如 USD,JPY,EUR" /></label></div>
      <button class="primary-button compact" type="button" @click="queryHistory">查询</button>
      <div v-if="historyState === 'loading'" class="skeleton-stack" aria-busy="true"><div class="skeleton-line"></div></div>
      <p v-else-if="historyState === 'error'" class="form-error" role="alert">{{ historyError }}</p>
      <div v-else-if="historyPivot.rows.length" class="table-scroll fx-history-table" tabindex="0" role="region" aria-label="官方历史汇率"><table><thead><tr><th>日期</th><th v-for="pair in historyPivot.columns" :key="pair">{{ pair }}</th></tr></thead><tbody><tr v-for="row in historyPivot.rows" :key="row.date"><td>{{ row.date }}</td><td v-for="pair in historyPivot.columns" :key="pair" class="numeric">{{ row.rates[pair] ?? "—" }}</td></tr></tbody></table></div>
      <div v-else class="inline-empty">{{ fxStatus?.quoteCount === 0 ? "数据库尚无历史报价，请先运行 pnpm fx:sync。" : "当前日期或币种范围没有报价。" }}</div>
    </section>
    <section class="surface-section">
      <div class="section-heading"><h2>多行日期批量换算</h2><p>保留输入顺序、重复日期、空行和无效行。歧义日期会被拒绝。</p></div>
      <div class="form-grid convert-grid"><label class="form-field"><span>当前币种</span><input v-model.trim="from" list="fx-currency-options" maxlength="3" autocomplete="off" title="可手工输入或从列表选择" @blur="from = normalizeCurrencyCode(from)" /></label><label class="form-field"><span>目标币种</span><input v-model.trim="to" list="fx-currency-options" maxlength="3" autocomplete="off" title="可手工输入或从列表选择" @blur="to = normalizeCurrencyCode(to)" /></label><label class="form-field span-two"><span>日期，每行一个</span><textarea v-model="lines" rows="8" placeholder="2026-07-28&#10;2026/07/29&#10;2026年7月30日"></textarea></label><datalist id="fx-currency-options"><option v-for="currency in FX_CURRENCY_OPTIONS" :key="currency" :value="currency"></option></datalist></div>
      <div class="form-actions"><button class="primary-button compact" type="button" @click="convert">批量换算</button><button v-if="rows.length" class="secondary-button compact" type="button" @click="copyRates">复制汇率（Excel）</button></div>
      <p v-if="convertError" class="form-error" role="alert">{{ convertError }}</p>
      <p v-if="copyMessage" :class="copyFailed ? 'form-error' : 'form-success'" :role="copyFailed ? 'alert' : 'status'">{{ copyMessage }}</p>
      <div v-if="rows.length" class="table-scroll" tabindex="0"><table><thead><tr><th>输入日期</th><th>命中日期</th><th>币对</th><th>汇率</th><th>顺延天数</th><th>状态</th></tr></thead><tbody><tr v-for="(row, index) in rows" :key="index"><td>{{ row.input }}</td><td>{{ row.quoteDate || "" }}</td><td>{{ row.from }}/{{ row.to }}</td><td class="numeric">{{ row.rate || "" }}</td><td>{{ row.fallbackDays ?? "" }}</td><td>{{ row.reason || row.status }}</td></tr></tbody></table></div>
    </section>
  </section>
</template>
