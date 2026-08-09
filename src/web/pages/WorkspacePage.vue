<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api/client";
import { currentEnterprise, enterpriseState, loadEnterprises } from "../enterprise";
import OnboardingOverlay from "../components/OnboardingOverlay.vue";
import PageHeader from "../components/PageHeader.vue";
import { session } from "../session";

const shops = ref<Awaited<ReturnType<typeof api.listShops>>>([]);
const dismissed = ref(false);
const loading = ref(true);
const error = ref("");
const hasEnterprise = computed(() => enterpriseState.items.length > 0);
const hasCompany = computed(() => shops.value.some((shop) => shop.access !== "CUSTOMER"));
const guide = computed(() => hasEnterprise.value
  ? [
      { title: "选择或创建公司", text: hasCompany.value ? "已有公司，可以继续准备资料。" : "先建立销售成本核算主体。", done: hasCompany.value, to: "/sales-cost", animal: 8 },
      { title: "准备资料", text: "按站点整理交易报告和配送货件。", done: shops.value.some((shop) => shop.accountingStatus === "SUBMITTED"), to: "/sales-cost", animal: 24 },
      { title: "打开做账", text: "进入公司后按资料准备、计算复核、报告交付推进。", done: shops.value.some((shop) => shop.accountingStatus === "SUBMITTED"), to: "/sales-cost", animal: 1 },
    ]
  : [
      { title: "创建企业", text: "登记企业名称和统一社会信用代码。", done: false, to: "/organization/enterprise", animal: 24 },
      { title: "创建公司", text: "企业建立后创建销售成本核算主体。", done: false, to: "/sales-cost", animal: 8 },
      { title: "开始做账", text: "上传资料，系统自动处理并生成报告。", done: false, to: "/sales-cost", animal: 1 },
    ]);

async function load() {
  loading.value = true; error.value = "";
  try {
    await loadEnterprises(true);
    shops.value = await api.listShops(currentEnterprise.value?.id);
    if (session.me?.isFirstLogin) {
      try { dismissed.value = (await api.getOnboarding("WORKSPACE", 2)).dismissed; }
      catch { dismissed.value = false; }
    } else dismissed.value = true;
  } catch (caught) { error.value = caught instanceof Error ? caught.message : "工作台加载失败"; }
  finally { loading.value = false; }
}

async function setGuide(value: boolean) { dismissed.value = (await api.setOnboarding("WORKSPACE", 2, value)).dismissed; }
onMounted(() => { void load(); });
watch(() => currentEnterprise.value?.id, (next, previous) => { if (next !== previous && !loading.value) void load(); });
</script>

<template>
  <section>
    <PageHeader title="工作台" :description="currentEnterprise ? `${currentEnterprise.name} 的销售成本处理概览` : '从企业建立到第一份销售成本报告，按真实状态继续下一步。'" />
    <p v-if="error" class="form-error">{{ error }}</p>
    <OnboardingOverlay
      v-if="session.me?.isFirstLogin && !dismissed && !loading"
      :title="hasEnterprise ? '开始本次做账' : '第一次使用'"
      description="引导悬浮在系统之上；你仍可直接操作下面的页面。"
      :steps="guide"
      @dismiss="setGuide(true)"
    />
    <section class="workspace-overview-grid"><article class="surface-section"><span>当前企业</span><strong>{{ currentEnterprise?.name || "尚未创建" }}</strong><p>{{ enterpriseState.items.length }} 个可访问企业</p></article><article class="surface-section"><span>公司</span><strong>{{ shops.length }}</strong><p>{{ shops.filter((shop) => shop.accountingStatus === "SUBMITTED").length }} 个已提交</p></article><article class="surface-section"><span>下一步</span><strong>{{ hasCompany ? "继续做账" : hasEnterprise ? "创建公司" : "创建企业" }}</strong><RouterLink class="primary-button compact" :to="hasEnterprise ? '/sales-cost' : '/organization/enterprise'">前往处理</RouterLink></article></section>
  </section>
</template>
