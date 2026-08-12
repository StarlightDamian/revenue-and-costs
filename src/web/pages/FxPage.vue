<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { api } from "../api/client";
import type { FxConversionRow, FxOverride, FxOverrideInput, FxQuote } from "../api/types";
import { writeTextToClipboard } from "../clipboard";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";
import { formatFxRateColumn, normalizeCurrencyCode } from "../fx-conversion";
import { defaultFxHistoryRange, FX_CURRENCY_OPTIONS, pivotFxHistory } from "../fx-history";
import { session } from "../session";

const route = useRoute();
const { data: fxStatus, status, error, reload } = useAsyncResource(api.getFxStatus);
const defaultRange = defaultFxHistoryRange();
const start = ref(defaultRange.from); const end = ref(defaultRange.to); const currencies = ref("");
const history = ref<FxQuote[]>([]); const historyState = ref<"idle" | "loading" | "error">("idle"); const historyError = ref("");
const from = ref("CNY"); const to = ref("USD"); const lines = ref(""); const rows = ref<FxConversionRow[]>([]); const convertError = ref(""); const copyMessage = ref(""); const copyFailed = ref(false);
const overrides = ref<FxOverride[]>([]); const overrideState = ref<"loading" | "ready" | "error">("loading"); const overrideListError = ref(""); const overrideMessage = ref("");
const overrideDialog = ref<globalThis.HTMLDialogElement | null>(null); const currencyInput = ref<globalThis.HTMLInputElement | null>(null); const editingOverride = ref<FxOverride | null>(null); const overrideSaving = ref(false); const overrideFormError = ref("");
const overrideCurrency = ref(""); const overrideValidFrom = ref(""); const overrideValidTo = ref(""); const overrideRate = ref(""); const overrideSource = ref(""); const overrideReason = ref("");
const taskLabel = computed(() => fxStatus.value?.taskStatus ?? "未知");
const historyPivot = computed(() => pivotFxHistory(history.value));
const isAdmin = computed(() => Boolean(session.me?.roles.includes("ADMIN")));
const requestedCurrency = computed(() => typeof route.query.currency === "string" && /^[A-Za-z]{3}$/u.test(route.query.currency) ? route.query.currency.toUpperCase() : "");
const requestedDate = computed(() => typeof route.query.date === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(route.query.date) ? route.query.date : "");
const requestedSubject = computed(() => requestedCurrency.value && requestedDate.value ? `${requestedDate.value} ${requestedCurrency.value}/CNY` : "");

async function queryHistory() {
  historyState.value = "loading"; historyError.value = "";
  try {
    const query = new URLSearchParams(); if (start.value) query.set("from", start.value); if (end.value) query.set("to", end.value); if (currencies.value.trim()) query.set("currencies", currencies.value.trim());
    history.value = await api.getFxHistory(query); historyState.value = "idle";
  } catch (caught) { historyState.value = "error"; historyError.value = caught instanceof Error ? caught.message : "查询失败"; }
}

async function loadOverrides() {
  if (!isAdmin.value) return;
  overrideState.value = "loading"; overrideListError.value = "";
  try { overrides.value = await api.listFxOverrides(); overrideState.value = "ready"; }
  catch (caught) { overrideState.value = "error"; overrideListError.value = caught instanceof Error ? caught.message : "读取人工汇率失败"; }
}

onMounted(() => { void queryHistory(); void loadOverrides(); });

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

function resetOverrideForm(existing?: FxOverride) {
  editingOverride.value = existing ?? null;
  overrideCurrency.value = existing?.currency ?? requestedCurrency.value;
  overrideValidFrom.value = existing?.validFrom ?? requestedDate.value;
  overrideValidTo.value = existing?.validTo ?? requestedDate.value;
  overrideRate.value = existing?.cnyPerUnit ?? "";
  overrideSource.value = existing?.sourceReference ?? "";
  overrideReason.value = "";
  overrideFormError.value = "";
}

async function openOverride(existing?: FxOverride) {
  resetOverrideForm(existing);
  overrideDialog.value?.showModal();
  await nextTick();
  currencyInput.value?.focus();
}

function closeOverride() {
  if (overrideDialog.value?.open) overrideDialog.value.close();
}

function validateOverride(): FxOverrideInput | null {
  const currency = normalizeCurrencyCode(overrideCurrency.value);
  overrideCurrency.value = currency;
  if (!/^[A-Z]{3}$/u.test(currency) || currency === "CNY") { overrideFormError.value = "币种必须是 CNY 之外的三位字母代码"; return null; }
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(overrideValidFrom.value) || !/^\d{4}-\d{2}-\d{2}$/u.test(overrideValidTo.value) || overrideValidFrom.value > overrideValidTo.value) {
    overrideFormError.value = "请选择有效的开始和结束日期，且开始日期不能晚于结束日期"; return null;
  }
  const rate = overrideRate.value.trim();
  if (!/^(?:0|[1-9]\d{0,21})(?:\.\d{1,8})?$/u.test(rate) || !/[1-9]/u.test(rate)) { overrideFormError.value = "汇率必须是大于 0 且最多 8 位小数的十进制字符串"; return null; }
  const sourceReference = overrideSource.value.trim(); const reason = overrideReason.value.trim();
  if (!sourceReference) { overrideFormError.value = "请填写可审计的授权来源凭证"; return null; }
  if (!reason) { overrideFormError.value = "请填写新增或修订原因"; return null; }
  return { currency, validFrom: overrideValidFrom.value, validTo: overrideValidTo.value, cnyPerUnit: rate, sourceReference, reason };
}

async function saveOverride() {
  overrideFormError.value = ""; overrideMessage.value = "";
  const input = validateOverride();
  if (!input) return;
  overrideSaving.value = true;
  try {
    const saved = editingOverride.value
      ? await api.reviseFxOverride(editingOverride.value.id, input)
      : await api.createFxOverride(input);
    overrideMessage.value = `${saved.currency}/CNY 人工汇率已${editingOverride.value ? "保存为新修订" : "新增"}；仅影响新计算，请重新导入或发起新计算。`;
    closeOverride();
    await loadOverrides();
  } catch (caught) {
    overrideFormError.value = caught instanceof Error ? caught.message : "保存人工汇率失败";
  } finally { overrideSaving.value = false; }
}

function formatCreatedAt(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <section>
    <PageHeader title="外汇市场" description="查询 ChinaMoney 规范化报价，并按报表显示日期批量换算。" :status="`同步任务：${taskLabel}`" :tone="fxStatus?.gaps.length ? 'warning' : 'official'">
      <template #actions><button v-if="isAdmin" class="primary-button compact" type="button" @click="openOverride()">新增人工汇率</button></template>
    </PageHeader>
    <AsyncState :status="status" :error="error" @retry="reload">
      <section class="status-strip fx-status-strip"><div><span>数据来源</span><strong>{{ fxStatus?.source }}</strong></div><div><span>数据库覆盖</span><strong>{{ fxStatus?.coverageStart || "未回填" }} 至 {{ fxStatus?.coverageEnd || "未回填" }}</strong></div><div><span>已保存报价</span><strong>{{ fxStatus?.quoteCount ?? 0 }} 条</strong></div><div><span>最后同步</span><strong>{{ fxStatus?.lastSucceededAt || "尚未成功" }}</strong></div></section>
      <div v-if="fxStatus && !fxStatus.syncEnabled" class="warning-panel" role="status"><strong>自动汇率同步未启用</strong><p>当前页面展示数据库中最近一次手工同步的数据；管理员可运行 <code>pnpm fx:sync</code> 更新全量历史报价。</p></div>
      <div v-if="fxStatus?.gaps.length" class="warning-panel" role="alert"><strong>存在官方报价缺口</strong><p>开市日缺少目标币对时不会继续寻找其他日期报价，相关切片将阻止发布。</p><ul><li v-for="gap in fxStatus.gaps" :key="`${gap.date}-${gap.currency}`">{{ gap.date }} {{ gap.currency }}：{{ gap.reason }}</li></ul></div>
    </AsyncState>
    <section v-if="isAdmin" class="surface-section fx-override-section" aria-labelledby="fx-override-title">
      <div class="section-heading split-heading"><div><h2 id="fx-override-title">人工授权汇率</h2><p>只用于填补官方报价缺口。新增和修改都保留来源、原因与修订历史，不改写既有计算或正式快照。</p></div><button class="secondary-button compact" type="button" :disabled="overrideState === 'loading'" @click="loadOverrides">刷新</button></div>
      <div v-if="requestedSubject" class="warning-panel" data-tone="error" role="alert"><strong>当前计算缺少 {{ requestedSubject }}</strong><p>请依据授权来源新增覆盖该日期的汇率；保存后返回公司重新导入。</p><button class="primary-button compact" type="button" @click="openOverride()">新增该日期汇率</button></div>
      <p v-if="overrideMessage" class="form-success" role="status">{{ overrideMessage }}</p>
      <div v-if="overrideState === 'loading'" class="skeleton-stack" aria-busy="true"><div class="skeleton-line is-wide"></div><div class="skeleton-line"></div></div>
      <div v-else-if="overrideState === 'error'" class="state-panel state-error" role="alert"><strong>无法读取人工汇率</strong><p>{{ overrideListError }}</p><button class="secondary-button" type="button" @click="loadOverrides">重试</button></div>
      <div v-else-if="overrides.length" class="table-scroll fx-override-table" tabindex="0" role="region" aria-label="人工授权汇率历史"><table><thead><tr><th>币对</th><th>有效期</th><th>1 单位币种对应 CNY</th><th>来源凭证</th><th>原因</th><th>创建时间</th><th>修订</th><th>操作</th></tr></thead><tbody><tr v-for="item in overrides" :key="item.id"><td><strong>{{ item.currency }}/CNY</strong></td><td>{{ item.validFrom }} 至 {{ item.validTo }}</td><td class="numeric">{{ item.cnyPerUnit }}</td><td>{{ item.sourceReference }}</td><td>{{ item.reason }}</td><td>{{ formatCreatedAt(item.createdAt) }}</td><td><span class="status-chip" :data-state="item.isCurrent ? 'COMPLETE' : 'STALE'">{{ item.isCurrent ? "当前" : "历史" }}</span></td><td><button v-if="item.isCurrent" class="secondary-button compact" type="button" @click="openOverride(item)">修改</button><span v-else>—</span></td></tr></tbody></table></div>
      <div v-else class="inline-empty">尚无人工汇率。只有官方报价确实缺失时，才由管理员依据授权来源新增。</div>
    </section>
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
    <dialog ref="overrideDialog" class="confirm-dialog fx-override-dialog" aria-labelledby="fx-override-dialog-title" @cancel.prevent="closeOverride">
      <span>管理员数据治理</span>
      <h2 id="fx-override-dialog-title">{{ editingOverride ? "修订人工汇率" : "新增人工汇率" }}</h2>
      <p>{{ editingOverride ? "保存后会新增修订，旧记录继续保留。" : "人工值只填补官方报价缺口，并只影响后续新计算。" }}</p>
      <form @submit.prevent="saveOverride">
        <div class="form-grid fx-override-form">
          <label class="form-field"><span>币种</span><input ref="currencyInput" v-model.trim="overrideCurrency" maxlength="3" autocomplete="off" placeholder="例如 BRL、INR" :disabled="Boolean(editingOverride)" @blur="overrideCurrency = normalizeCurrencyCode(overrideCurrency)" /></label>
          <label class="form-field"><span>1 单位币种对应 CNY</span><input v-model.trim="overrideRate" inputmode="decimal" autocomplete="off" placeholder="例如 1.33" /></label>
          <label class="form-field"><span>有效开始日</span><input v-model="overrideValidFrom" type="date" /></label>
          <label class="form-field"><span>有效结束日</span><input v-model="overrideValidTo" type="date" /></label>
          <label class="form-field span-two"><span>授权来源凭证</span><input v-model.trim="overrideSource" maxlength="2000" placeholder="来源名称、文件编号或可审计链接" /></label>
          <label class="form-field span-two"><span>新增或修订原因</span><textarea v-model.trim="overrideReason" rows="3" maxlength="1000" placeholder="说明为什么需要补齐或修订该汇率"></textarea></label>
        </div>
        <p v-if="overrideFormError" class="form-error" role="alert">{{ overrideFormError }}</p>
        <div class="form-actions"><button class="secondary-button" type="button" :disabled="overrideSaving" @click="closeOverride">取消</button><button class="primary-button" type="submit" :disabled="overrideSaving">{{ overrideSaving ? "正在保存" : editingOverride ? "保存为新修订" : "新增人工汇率" }}</button></div>
      </form>
    </dialog>
  </section>
</template>
