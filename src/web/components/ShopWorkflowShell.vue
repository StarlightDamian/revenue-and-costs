<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import logoUrl from "../../../nas/image/LOGO-transparent.png";
import { api } from "../api/client";
import type { ExportJob, ShopWorkflow, WorkflowStepCode } from "../api/types";
import { avatarById } from "../avatars";
import { clearSession, session } from "../session";
import AsyncState from "./AsyncState.vue";
import OnboardingOverlay from "./OnboardingOverlay.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import { writeTextToClipboard } from "../clipboard";

const route = useRoute();
const router = useRouter();
const workflow = ref<ShopWorkflow | null>(null);
const status = ref<"loading" | "ready" | "error">("loading");
const error = ref("");
const avatarMenuOpen = ref(false);
const downloadBusy = ref(false);
const downloadError = ref("");
const guideDismissed = ref(false);
const diagnosticCopied = ref(false);
const shopId = computed(() => String(route.params.shopId ?? ""));
const accountAvatar = computed(() => avatarById(session.me?.avatarId));
const currentPhaseKey = computed(() => ({
  "workflow-commit": "PREPARE",
  "workflow-calculate": "REVIEW",
  "workflow-export": "DELIVER",
} as const)[String(route.name)] ?? null);
let pollTimer: number | undefined;

const phases = computed(() => [
  { key: "PREPARE", label: "资料准备", codes: ["RECEIVE", "PREFLIGHT", "COMMIT"] as WorkflowStepCode[] },
  { key: "REVIEW", label: "计算复核", codes: ["CALCULATE", "PUBLISH"] as WorkflowStepCode[] },
  { key: "DELIVER", label: "报告交付", codes: ["EXPORT"] as WorkflowStepCode[] },
].map((phase) => {
  const steps = phase.codes.map((code) => workflow.value?.steps.find((step) => step.code === code)).filter(Boolean) as NonNullable<ShopWorkflow["steps"][number]>[];
  const target = [...steps].reverse().find((step) => step.clickable) ?? steps[0];
  return {
    ...phase, target,
    current: phase.key === currentPhaseKey.value, clickable: steps.some((step) => step.clickable),
    state: steps.length && steps.every((step) => step.state === "COMPLETED") ? "COMPLETED" : steps.some((step) => step.state === "IN_PROGRESS") ? "IN_PROGRESS" : "NOT_STARTED",
    severity: steps.some((step) => step.severity === "BLOCKING") ? "BLOCKING" : steps.some((step) => step.severity === "WARNING") ? "WARNING" : "NONE",
  };
}));

const phaseRoutes = { PREPARE: "commit", REVIEW: "calculate", DELIVER: "export" } as const;
const shopGuide = computed(() => [
  { title: "上传资料", text: "选择整理好的交易和配送文件。", animal: 24, to: `/shops/${shopId.value}/workflow/commit#upload-source`, actionLabel: "前往上传" },
  { title: "系统自动处理", text: "系统预检、入库、计算并披露异常。", animal: 8, to: `/shops/${shopId.value}/workflow/commit`, actionLabel: "查看进度" },
  { title: "核对并下载", text: "检查结果后生成正式销售成本报告。", animal: 1, to: `/shops/${shopId.value}/workflow/calculate#review-result`, actionLabel: "前往核对" },
]);

async function loadWorkflow(initial = false) {
  if (initial) status.value = "loading";
  error.value = "";
  try {
    workflow.value = await api.getShopWorkflow(shopId.value);
    status.value = "ready";
    if (initial && session.me?.isFirstLogin) {
      try { guideDismissed.value = (await api.getOnboarding("SHOP_WORKFLOW", 2, shopId.value)).dismissed; }
      catch { guideDismissed.value = false; }
    } else if (!session.me?.isFirstLogin) {
      guideDismissed.value = true;
    }
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : "无法读取公司流程";
    status.value = "error";
  }
}

async function setGuide(dismissed: boolean) { guideDismissed.value = (await api.setOnboarding("SHOP_WORKFLOW", 2, dismissed, shopId.value)).dismissed; }

async function copyDiagnosticId() {
  const value = workflow.value?.diagnosticId;
  if (!value) return;
  try {
    await writeTextToClipboard(value);
    diagnosticCopied.value = true;
    window.setTimeout(() => { diagnosticCopied.value = false; }, 1400);
  } catch {
    downloadError.value = "诊断 ID 复制失败，请手动选择后复制";
  }
}

function phaseHref(phase: string): string {
  const path = phaseRoutes[phase as keyof typeof phaseRoutes] ?? "commit";
  return `/shops/${encodeURIComponent(shopId.value)}/workflow/${path}`;
}

function stepStyle(progress: string | null) {
  return { "--stage-progress": `${Math.max(0, Math.min(100, Number(progress ?? 0)))}%` };
}

async function download(job: ExportJob) {
  const result = await api.getDownloadUrl(job.id);
  window.location.assign(result.url);
}

async function quickDownload() {
  if (!workflow.value?.download.available || downloadBusy.value) return;
  downloadBusy.value = true;
  downloadError.value = "";
  try {
    const job = await api.createCurrentExport(shopId.value);
    if (job.status === "SUCCEEDED") {
      await download(job);
      return;
    }
    await router.push({ name: "workflow-export", params: { shopId: shopId.value }, query: { auto: job.id } });
  } catch (caught) {
    downloadError.value = caught instanceof Error ? caught.message : "下载失败";
  } finally {
    downloadBusy.value = false;
  }
}

async function logout() {
  try { await api.logout(); } finally {
    clearSession();
    await router.replace({ name: "login" });
  }
}

watch(shopId, () => loadWorkflow(true));
onMounted(() => {
  void loadWorkflow(true);
  pollTimer = window.setInterval(() => {
    if (workflow.value?.steps.some((step) => step.state === "IN_PROGRESS")) void loadWorkflow();
  }, 2500);
});
onBeforeUnmount(() => { if (pollTimer) window.clearInterval(pollTimer); });
</script>

<template>
  <div class="ambient" aria-hidden="true"><div class="ambient-image"></div><div class="ambient-scrim"></div></div>
  <div class="workflow-shell">
    <header class="workflow-topbar">
      <div class="workflow-brand">
        <RouterLink class="workflow-brand-home" to="/sales-cost" aria-label="返回公司列表"><img :src="logoUrl" alt="跨境电商服务中心" /></RouterLink>
        <span><strong>{{ workflow?.shop.name || "公司工作台" }}</strong><button class="workflow-diagnostic-id" type="button" :title="diagnosticCopied ? '已复制' : '复制诊断 ID'" :disabled="!workflow?.diagnosticId" @click="copyDiagnosticId">{{ `ID:${workflow?.diagnosticId || '读取中'}` }}<i v-if="diagnosticCopied">已复制</i></button></span>
      </div>

      <nav class="workflow-steps workflow-phases" aria-label="公司数据处理阶段">
        <template v-for="(phase, index) in phases" :key="phase.key">
          <RouterLink
            v-if="phase.clickable && phase.target"
            class="workflow-step"
            :class="[`is-${phase.state.toLowerCase()}`, `severity-${phase.severity.toLowerCase()}`, { 'is-current': phase.current }]"
            :to="phaseHref(phase.key)"
            :aria-current="phase.current ? 'page' : undefined"
            :aria-label="`${phase.label}，${phase.state === 'COMPLETED' ? '已完成' : phase.state === 'IN_PROGRESS' ? '进行中' : '未开始'}`"
          >
            <span class="stage-ring" :class="{ 'is-indeterminate': phase.state === 'IN_PROGRESS' }" :style="stepStyle(phase.target.progress)">
              <b>{{ index + 1 }}</b>
            </span>
            <span class="stage-label"><b>{{ phase.label }}</b></span>
          </RouterLink>
          <span
            v-else
            class="workflow-step is-locked"
            :class="[`is-${phase.state.toLowerCase()}`, `severity-${phase.severity.toLowerCase()}`, { 'is-current': phase.current }]"
            :aria-current="phase.current ? 'page' : undefined"
            :aria-label="`${phase.label}，当前不可访问`"
          >
            <span class="stage-ring"><b>{{ index + 1 }}</b></span>
            <span class="stage-label"><b>{{ phase.label }}</b></span>
          </span>
        </template>
      </nav>

      <div class="workflow-actions">
        <button
          class="workflow-download"
          type="button"
          :disabled="!workflow?.download.available || downloadBusy"
          :title="!workflow?.download.available ? '当前流程尚未发布，暂不可下载' : '下载当前正式结果'"
          @click="quickDownload"
        >{{ downloadBusy ? "准备中" : "下载" }}</button>
        <div class="avatar-menu">
          <button class="avatar-menu-trigger" type="button" :aria-expanded="avatarMenuOpen" aria-label="打开账号和主题菜单" @click="avatarMenuOpen = !avatarMenuOpen">
            <img :src="accountAvatar.src" :alt="`${accountAvatar.name}头像`" />
          </button>
          <div v-if="avatarMenuOpen" class="avatar-menu-panel">
            <strong>{{ session.me?.displayName || session.me?.phoneMasked || "当前账号" }}</strong>
            <span>选择皮肤</span>
            <ThemeSwitcher />
            <RouterLink to="/account" @click="avatarMenuOpen = false">账号设置</RouterLink>
            <button type="button" @click="logout">退出登录</button>
          </div>
        </div>
      </div>
    </header>

    <p v-if="downloadError" class="workflow-global-error" role="alert">{{ downloadError }}</p>
    <main class="workflow-content">
      <OnboardingOverlay v-if="session.me?.isFirstLogin && !guideDismissed && status === 'ready'" title="第一次进入公司" description="三个动作完成一次完整销售成本做账；引导不会锁住当前页面。" :steps="shopGuide" dismiss-label="跳过" @dismiss="setGuide(true)" />
      <AsyncState :status="status" :error="error" empty-title="无法读取公司" empty-message="请返回公司列表重试。" @retry="loadWorkflow(true)">
        <RouterView :workflow="workflow" @workflow-change="loadWorkflow" />
      </AsyncState>
    </main>
  </div>
</template>
