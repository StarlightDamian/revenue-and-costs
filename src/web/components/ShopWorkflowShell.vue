<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute, useRouter } from "vue-router";
import logoUrl from "../../../nas/image/LOGO-transparent.png";
import { api } from "../api/client";
import type { ExportJob, ShopWorkflow, WorkflowStepCode } from "../api/types";
import { avatarById } from "../avatars";
import { clearSession, session } from "../session";
import { compactDiagnosticId, diagnosticClipboardText } from "../diagnostic-id-presentation";
import AsyncState from "./AsyncState.vue";
import ThemeSwitcher from "./ThemeSwitcher.vue";
import WorkflowBlockerDialog from "./WorkflowBlockerDialog.vue";
import { writeTextToClipboard } from "../clipboard";
import { workflowBlockerPresentation } from "../workflow-blocker";

const route = useRoute();
const router = useRouter();
const workflow = ref<ShopWorkflow | null>(null);
const status = ref<"loading" | "ready" | "error">("loading");
const error = ref("");
const avatarMenuOpen = ref(false);
const downloadBusy = ref(false);
const downloadError = ref("");
const diagnosticCopied = ref(false);
const dismissedBlockerKeys = ref<ReadonlySet<string>>(new Set());
const shopId = computed(() => String(route.params.shopId ?? ""));
const accountAvatar = computed(() => avatarById(session.me?.avatarId));
const diagnosticDisplay = computed(() => workflow.value?.diagnosticId ? compactDiagnosticId(workflow.value.diagnosticId) : "读取中");
const diagnosticAccessibleLabel = computed(() => workflow.value?.diagnosticId ? `复制诊断ID: ${workflow.value.diagnosticId}` : "诊断ID读取中");
const blocker = computed(() => workflowBlockerPresentation(workflow.value, Boolean(session.me?.roles.includes("ADMIN"))));
const visibleBlocker = computed(() => blocker.value && !dismissedBlockerKeys.value.has(blocker.value.key) ? blocker.value : null);
const currentPhaseKey = computed(() => ({
  "workflow-commit": "PREPARE",
  "workflow-calculate": "REVIEW",
  "workflow-export": "DELIVER",
} as const)[String(route.name)] ?? null);
let pollTimer: number | undefined;
let workflowLoading = false;
let workflowRequestSequence = 0;

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

async function loadWorkflow(initial = false) {
  if (workflowLoading && !initial) return;
  const sequence = ++workflowRequestSequence;
  const requestedShopId = shopId.value;
  workflowLoading = true;
  if (initial) status.value = "loading";
  error.value = "";
  try {
    const nextWorkflow = await api.getShopWorkflow(requestedShopId);
    if (sequence !== workflowRequestSequence || requestedShopId !== shopId.value) return;
    workflow.value = nextWorkflow;
    status.value = "ready";
  } catch (caught) {
    if (sequence !== workflowRequestSequence || requestedShopId !== shopId.value) return;
    error.value = caught instanceof Error ? caught.message : "无法读取公司流程";
    status.value = "error";
  } finally {
    if (sequence === workflowRequestSequence) workflowLoading = false;
  }
}

async function copyDiagnosticId() {
  const value = workflow.value?.diagnosticId;
  if (!value) return;
  try {
    await writeTextToClipboard(diagnosticClipboardText(value));
    diagnosticCopied.value = true;
    window.setTimeout(() => { diagnosticCopied.value = false; }, 1400);
  } catch {
    downloadError.value = "诊断 ID 复制失败，请手动选择后复制";
  }
}

function dismissBlocker(key: string) {
  dismissedBlockerKeys.value = new Set([...dismissedBlockerKeys.value, key]);
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

watch(shopId, () => {
  dismissedBlockerKeys.value = new Set();
  void loadWorkflow(true);
});
watch(() => blocker.value?.key, (key, previousKey) => {
  if (!key && previousKey) dismissedBlockerKeys.value = new Set();
});
onMounted(() => {
  void loadWorkflow(true);
  pollTimer = window.setInterval(() => {
    if (workflow.value?.processingHealth?.workerAvailable === false || workflow.value?.steps.some((step) => step.state === "IN_PROGRESS")) void loadWorkflow();
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
        <span>
          <strong>{{ workflow?.shop.name || "公司工作台" }}</strong>
          <button
            class="workflow-diagnostic-id"
            type="button"
            title="诊断ID"
            :aria-label="diagnosticAccessibleLabel"
            :disabled="!workflow?.diagnosticId"
            @click="copyDiagnosticId"
          >
            <span aria-hidden="true">ID: {{ diagnosticDisplay }}</span>
            <i
              v-if="diagnosticCopied"
              aria-hidden="true"
            >已复制</i>
          </button>
          <span
            class="sr-only"
            role="status"
            aria-live="polite"
          >{{ diagnosticCopied ? "诊断ID已复制" : "" }}</span>
        </span>
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
            <strong>{{ session.me?.displayName || "未设置名称" }}</strong>
            <span>选择皮肤</span>
            <ThemeSwitcher />
            <RouterLink to="/account" @click="avatarMenuOpen = false">账号设置</RouterLink>
            <button type="button" @click="logout">退出登录</button>
          </div>
        </div>
      </div>
    </header>

    <p v-if="downloadError" class="workflow-global-error" role="alert">{{ downloadError }}</p>
    <WorkflowBlockerDialog :blocker="visibleBlocker" @dismiss="dismissBlocker" />
    <main class="workflow-content">
      <AsyncState :status="status" :error="error" empty-title="无法读取公司" empty-message="请返回公司列表重试。" @retry="loadWorkflow(true)">
        <RouterView :workflow="workflow" @workflow-change="loadWorkflow" />
      </AsyncState>
    </main>
  </div>
</template>
