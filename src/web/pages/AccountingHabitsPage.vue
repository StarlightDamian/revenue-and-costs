<script setup lang="ts">
import { onMounted, ref } from "vue";
import { percentInputToRatio, ratioToPercentInput } from "../accounting-rates";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";

const status = ref<"loading" | "ready" | "error">("loading");
const error = ref("");
const profitRate = ref("");
const minimumSalesCostRate = ref("");
const continentPrefixes = ref<Array<"AS" | "EU" | "AF" | "AM" | "OC">>(["EU"]);
const continentOptions = [
  { code: "AS", label: "亚洲", prefix: "AS-" },
  { code: "EU", label: "欧洲", prefix: "EU-" },
  { code: "AF", label: "非洲", prefix: "AF-" },
  { code: "AM", label: "美洲", prefix: "AM-" },
  { code: "OC", label: "大洋洲", prefix: "OC-" },
] as const;
const saving = ref(false);
const saveMessage = ref("");
const accountingRateErrorText = (caught: unknown) => {
  if (!(caught instanceof Error)) return userFacingError(caught, "暂时无法保存做账习惯，请检查网络后重试");
  const invalidNumber = /^(利润率|最低销售成本率)请输入非负十进制百分比$/u.exec(caught.message);
  if (invalidNumber) return `请为${invalidNumber[1]}输入 0 到 100 之间的数字`;
  return /^(利润率|最低销售成本率)(最多保留 6 位小数|必须在 0% 到 100% 之间)$/u.test(caught.message)
    ? caught.message
    : userFacingError(caught, "暂时无法保存做账习惯，请检查网络后重试");
};

async function load() {
  status.value = "loading";
  error.value = "";
  try {
    const preferences = await api.getAccountingPreferences();
    profitRate.value = ratioToPercentInput(preferences.profitRate);
    minimumSalesCostRate.value = ratioToPercentInput(preferences.minimumSalesCostRate);
    continentPrefixes.value = [...preferences.continentPrefixes];
    status.value = "ready";
  } catch (caught) {
    error.value = userFacingError(caught, "暂时无法读取做账习惯，请检查网络后重试");
    status.value = "error";
  }
}

async function save() {
  saving.value = true;
  saveMessage.value = "";
  try {
    const saved = await api.updateAccountingPreferences({
      profitRate: percentInputToRatio(profitRate.value, "利润率"),
      minimumSalesCostRate: percentInputToRatio(minimumSalesCostRate.value, "最低销售成本率"),
      continentPrefixes: continentPrefixes.value,
    });
    profitRate.value = ratioToPercentInput(saved.profitRate);
    minimumSalesCostRate.value = ratioToPercentInput(saved.minimumSalesCostRate);
    continentPrefixes.value = [...saved.continentPrefixes];
    saveMessage.value = "做账习惯已保存";
  } catch (caught) {
    saveMessage.value = accountingRateErrorText(caught);
  } finally {
    saving.value = false;
  }
}

onMounted(() => { void load(); });
</script>

<template>
  <section>
    <PageHeader title="做账习惯" description="保存当前账号常用的测算参数和导出站点显示习惯。" />
    <AsyncState :status="status" :error="error" @retry="load">
      <section class="surface-section accounting-habits-panel">
        <div class="section-heading">
          <h2>默认测算参数</h2>
          <p>报告交付页会自动带入这些默认值，也可以只为某次导出临时修改。</p>
        </div>
        <fieldset class="continent-prefix-fieldset">
          <legend>导出站点大洲前缀</legend>
          <p>默认仅欧洲开启；只改变导出的站点显示，不影响筛选、计算或历史数据。</p>
          <div class="continent-prefix-grid">
            <label v-for="option in continentOptions" :key="option.code" class="choice-card">
              <input v-model="continentPrefixes" type="checkbox" :value="option.code" />
              <span><b>{{ option.label }}</b><small>{{ option.prefix }}站点代码</small></span>
            </label>
          </div>
        </fieldset>
        <div class="form-grid accounting-rate-grid">
          <label class="form-field">
            <span>利润率（可选）</span>
            <span class="suffix-input"><input v-model="profitRate" inputmode="decimal" autocomplete="off" placeholder="例如 4.37" /><b>%</b></span>
            <small>填写后，目标利润 = 利润率 × 收入净额。</small>
          </label>
          <label class="form-field">
            <span>最低销售成本率（可选）</span>
            <span class="suffix-input"><input v-model="minimumSalesCostRate" inputmode="decimal" autocomplete="off" placeholder="例如 15" /><b>%</b></span>
            <small>算出的销售成本率低于这个数时，系统会把采购成本提高到这个比例，并重新计算利润，保证各项金额能对得上。</small>
          </label>
        </div>
        <div class="form-actions">
          <button class="primary-button" type="button" :disabled="saving" @click="save">{{ saving ? "正在保存" : "保存做账习惯" }}</button>
          <p v-if="saveMessage" :class="saveMessage === '做账习惯已保存' ? 'form-success' : 'form-error'" role="status">{{ saveMessage }}</p>
        </div>
      </section>
      <section class="surface-section">
        <div class="section-heading"><h2>系统怎样计算</h2><p>如果设置了最低销售成本率，系统会先保证采购成本不低于这个比例，再计算最终利润。</p></div>
        <ol class="calculation-steps">
          <li>利润率为空时沿用平台结余作为利润，采购成本保持 0。</li>
          <li>填写利润率后，先计算目标利润与基础采购成本。</li>
          <li>若销售成本率低于已设置下限，提高采购成本到下限并重算利润。</li>
        </ol>
      </section>
    </AsyncState>
  </section>
</template>
