<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
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
const actionError = ref("");
const busy = ref(false);
const rechargeErrorText = (caught: unknown) => caught instanceof Error
  && caught.message === "金额必须是最多两位小数的非负十进制数"
  ? "请输入正确的充值金额，最多保留两位小数，例如 100.00"
  : userFacingError(caught, "暂时无法充值，请检查网络后重试");

function yuan(cents: string) {
  const value = BigInt(cents); const sign = value < 0n ? "-" : ""; const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

async function recharge() {
  if (busy.value) return;
  busy.value = true; actionError.value = "";
  if (!currentEnterprise.value) { actionError.value = "请先选择企业"; busy.value = false; return; }
  try { await api.createRecharge(currentEnterprise.value.id, amount.value); amount.value = ""; await reload(); await loadEnterprises(true); }
  catch (caught) { actionError.value = rechargeErrorText(caught); }
  finally { busy.value = false; }
}

function shopReferenceDescription(entry: WalletEntry) {
  if (entry.reference?.type !== "SHOP") return entry.reason ?? "";
  const name = entry.reference.name;
  const annotations: string[] = [];
  if (entry.reference.status === "EXPIRED_READONLY") annotations.push("已到期");
  if (entry.reference.status === "TRASHED") annotations.push("回收站");
  if (entry.reference.status === "PURGED") annotations.push("已清除");
  return name ? `公司：${name}${annotations.length ? `（${annotations.join("；")}）` : ""}` : `公司记录：${entry.reference.id}`;
}

const walletEntryTypeNames: Record<string, string> = {
  TOP_UP: "充值",
  TOP_UP_REVERSAL: "充值退回",
  SHOP_CHARGE: "公司费用",
  ADMIN_ADJUSTMENT: "管理员调整",
  DEBT_SETTLEMENT: "补足欠款",
};
</script>

<template>
  <section>
    <PageHeader title="企业钱包与流水" :description="currentEnterprise ? `${currentEnterprise.name} 的成员共享此钱包。` : '请先在销售成本页创建或选择企业。'" />
    <section class="surface-section">
      <div class="section-heading"><h2>账户充值</h2><p>最低充值 100.00 元。当前试用期间，点击充值后由系统直接记入企业钱包，不会跳转到微信或支付宝。</p></div>
      <div class="form-grid quote-grid"><label class="form-field"><span>充值金额（元）</span><input v-model.trim="amount" inputmode="decimal" placeholder="10000.00" /></label><button class="secondary-button" type="button" :disabled="busy || !currentEnterprise" @click="recharge">充值</button></div>
      <p v-if="actionError" class="form-error" role="alert">{{ actionError }}</p>
    </section>
    <section class="surface-section">
      <div class="section-heading"><h2>钱包明细</h2><p>每次充值、扣费和退款都会新增一条记录，旧记录不会被改掉，方便以后核对。</p></div>
      <AsyncState :status="status" :error="error" empty-title="暂无钱包记录" empty-message="完成充值或公司消费后，记录会显示在这里。" @retry="reload">
        <div class="table-scroll" tabindex="0" role="region" aria-label="钱包流水"><table><thead><tr><th>时间</th><th>类型</th><th>变动</th><th>变动后余额</th><th>说明</th></tr></thead><tbody><tr v-for="entry in entries as WalletEntry[]" :key="entry.id"><td>{{ entry.occurredAt }}</td><td>{{ walletEntryTypeNames[entry.type] ?? "其他变动" }}</td><td class="numeric">{{ yuan(entry.amountCents) }}</td><td class="numeric">{{ yuan(entry.balanceAfterCents) }}</td><td>{{ shopReferenceDescription(entry) }}</td></tr></tbody></table></div>
      </AsyncState>
    </section>
  </section>
</template>
