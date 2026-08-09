<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api/client";
import type { WalletEntry } from "../api/types";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";
import { currentEnterprise, loadEnterprises } from "../enterprise";

const { data: entries, status, error, reload } = useAsyncResource(async () => {
  await loadEnterprises();
  return currentEnterprise.value ? api.listWalletEntries(currentEnterprise.value.id) : [];
});
const amount = ref("");
const quote = ref<{ creditCents: string; payableCents: string } | null>(null);
const actionError = ref("");
const busy = ref(false);

function yuan(cents: string) {
  const value = BigInt(cents); const sign = value < 0n ? "-" : ""; const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

async function getQuote() {
  actionError.value = "";
  if (!currentEnterprise.value) { actionError.value = "请先在销售成本页选择企业"; return; }
  try { quote.value = await api.quoteRecharge(currentEnterprise.value.id, amount.value); }
  catch (caught) { actionError.value = caught instanceof Error ? caught.message : "报价失败"; }
}

async function recharge() {
  busy.value = true; actionError.value = "";
  if (!currentEnterprise.value) { actionError.value = "请先选择企业"; busy.value = false; return; }
  try { await api.createSandboxRecharge(currentEnterprise.value.id, amount.value); quote.value = null; amount.value = ""; await reload(); await loadEnterprises(true); }
  catch (caught) { actionError.value = caught instanceof Error ? caught.message : "充值失败"; }
  finally { busy.value = false; }
}
</script>

<template>
  <section>
    <PageHeader title="企业钱包与流水" :description="currentEnterprise ? `${currentEnterprise.name} 的成员共享此钱包。` : '请先在销售成本页创建或选择企业。'" />
    <section class="surface-section">
      <div class="section-heading"><h2>充值沙箱</h2><p>最低充值 100.00 元。当前页面只调用本地沙箱，不连接真实支付渠道。</p></div>
      <div class="form-grid quote-grid"><label class="form-field"><span>充值金额（元）</span><input v-model.trim="amount" inputmode="decimal" placeholder="100.00" /></label><button class="secondary-button" type="button" :disabled="!currentEnterprise" @click="getQuote">获取报价</button></div>
      <div v-if="quote" class="quote-result"><span>到账 ¥{{ yuan(quote.creditCents) }}</span><strong>实付 ¥{{ yuan(quote.payableCents) }}</strong><button class="primary-button compact" type="button" :disabled="busy" @click="recharge">确认沙箱充值</button></div>
      <p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>
    </section>
    <section class="surface-section">
      <div class="section-heading"><h2>账本流水</h2><p>历史记录不会原地修改，退款、撤销和拒付以反向账本体现。</p></div>
      <AsyncState :status="status" :error="error" empty-title="暂无账本记录" empty-message="完成充值或公司消费后，流水会显示在这里。" @retry="reload">
        <div class="table-scroll" tabindex="0" role="region" aria-label="钱包流水"><table><thead><tr><th>时间</th><th>类型</th><th>变动</th><th>变动后余额</th><th>说明</th></tr></thead><tbody><tr v-for="entry in entries as WalletEntry[]" :key="entry.id"><td>{{ entry.occurredAt }}</td><td>{{ entry.type }}</td><td class="numeric">{{ yuan(entry.amountCents) }}</td><td class="numeric">{{ yuan(entry.balanceAfterCents) }}</td><td>{{ entry.reason || "" }}</td></tr></tbody></table></div>
      </AsyncState>
    </section>
  </section>
</template>
