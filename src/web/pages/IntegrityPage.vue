<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { api } from "../api/client";
import type { CompletenessSlice, SliceState } from "../api/types";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";

const route = useRoute(); const shopId = computed(() => String(route.params.shopId));
const { data: slices, status, error, reload } = useAsyncResource(() => api.getCompleteness(shopId.value));
const months = computed(() => [...new Set(slices.value?.map((item) => item.month) ?? [])].sort());
const marketplaces = computed(() => [...new Set(slices.value?.map((item) => item.marketplace) ?? [])].sort());
const stateNames: Record<SliceState, string> = { COMPLETE: "完整", PUBLISHED_WARNING: "已发布有警告", MISSING_TRANSACTION: "缺交易报告", MISSING_SHIPMENT: "缺配送货件", MISSING_FX: "缺汇率", AWAITING_MAPPING: "待映射", CONFLICT: "冲突", EXCLUDED: "已排除", STALE: "旧版本" };
function find(marketplace: string, month: string): CompletenessSlice | undefined { return slices.value?.find((item) => item.marketplace === marketplace && item.month === month); }
</script>

<template>
  <section>
    <PageHeader title="完整性检查" description="以公司、规范化站点、站点当地月份和数据版本检查两类来源覆盖。">
      <template #actions><RouterLink class="secondary-button compact" :to="`/shops/${shopId}/upload`">补传或修正</RouterLink><RouterLink class="primary-button compact" :to="`/shops/${shopId}/results`">查看结果</RouterLink></template>
    </PageHeader>
    <div class="legend" aria-label="完整性状态图例"><span v-for="(label, key) in stateNames" :key="key" :data-state="key">{{ label }}</span></div>
    <AsyncState :status="status" :error="error" empty-title="还没有完整性记录" empty-message="上传并完成预检后，站点与月份覆盖会显示在这里。" @retry="reload">
      <section class="surface-section">
        <div class="section-heading"><h2>站点 × 月份矩阵</h2><p>缺失不按 0。硬不完整切片即使确认排除，也永不进入正式汇总。</p></div>
        <div class="matrix-scroll" tabindex="0" role="region" aria-label="站点月份完整性矩阵"><table class="matrix-table"><thead><tr><th>站点</th><th v-for="month in months" :key="month">{{ month }}</th></tr></thead><tbody><tr v-for="marketplace in marketplaces" :key="marketplace"><th>{{ marketplace }}</th><td v-for="month in months" :key="month"><button v-if="find(marketplace, month)" class="matrix-cell" :data-state="find(marketplace, month)?.state" type="button" :title="find(marketplace, month)?.note"><strong>{{ stateNames[find(marketplace, month)!.state] }}</strong><small v-if="find(marketplace, month)?.unmatchedAbsolute">差异 {{ find(marketplace, month)?.unmatchedAbsolute }}</small></button><span v-else class="matrix-cell is-none">无切片</span></td></tr></tbody></table></div>
      </section>
      <section class="surface-section">
        <div class="section-heading"><h2>数量对账</h2><p>两侧来源完整后才比较可比数量，任意非零差异属于软警告。</p></div>
        <div class="table-scroll" tabindex="0"><table><thead><tr><th>站点</th><th>月份</th><th>交易报告</th><th>配送货件</th><th>未匹配</th><th>说明</th></tr></thead><tbody><tr v-for="slice in slices" :key="`${slice.marketplace}-${slice.month}`"><td>{{ slice.marketplace }}</td><td>{{ slice.month }}</td><td class="numeric">{{ slice.transactionQuantity ?? "不适用" }}</td><td class="numeric">{{ slice.shipmentQuantity ?? "不适用" }}</td><td class="numeric">{{ slice.unmatchedAbsolute ?? "不适用" }}</td><td>{{ slice.note || stateNames[slice.state] }}</td></tr></tbody></table></div>
      </section>
    </AsyncState>
  </section>
</template>
