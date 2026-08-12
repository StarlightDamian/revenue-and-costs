<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api/client";
import { currentEnterprise, enterpriseState, loadEnterprises } from "../enterprise";
import PageHeader from "../components/PageHeader.vue";

const shops = ref<Awaited<ReturnType<typeof api.listShops>>>([]);
const loading = ref(true);
const error = ref("");
const hasEnterprise = computed(() => enterpriseState.items.length > 0);
const hasCompany = computed(() => shops.value.some((shop) => shop.access !== "CUSTOMER"));

async function load() {
  loading.value = true; error.value = "";
  try {
    await loadEnterprises(true);
    shops.value = await api.listShops(currentEnterprise.value?.id);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : "工作台加载失败"; }
  finally { loading.value = false; }
}

onMounted(() => { void load(); });
watch(() => currentEnterprise.value?.id, (next, previous) => { if (next !== previous && !loading.value) void load(); });
</script>

<template>
  <section>
    <PageHeader title="工作台" :description="currentEnterprise ? `${currentEnterprise.name} 的销售成本处理概览` : '从企业建立到第一份销售成本报告，按真实状态继续下一步。'" />
    <p v-if="error" class="form-error">{{ error }}</p>
    <section class="workspace-overview-grid"><article class="surface-section"><span>当前企业</span><strong>{{ currentEnterprise?.name || "尚未创建" }}</strong><p>{{ enterpriseState.items.length }} 个可访问企业</p></article><article class="surface-section"><span>公司</span><strong>{{ shops.length }}</strong><p>{{ shops.filter((shop) => shop.accountingStatus === "SUBMITTED").length }} 个已提交</p></article><article class="surface-section"><span>下一步</span><strong>{{ hasCompany ? "继续做账" : hasEnterprise ? "创建公司" : "创建企业" }}</strong><RouterLink class="primary-button compact" :to="hasEnterprise ? '/sales-cost' : '/organization/enterprise'">前往处理</RouterLink></article></section>
  </section>
</template>
