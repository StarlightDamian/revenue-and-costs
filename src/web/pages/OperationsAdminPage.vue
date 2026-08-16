<script setup lang="ts">
import { api } from "../api/client";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";

const load = async () => {
  const [readiness, jobs, overview] = await Promise.all([
    api.getOperationsReadiness(),
    api.getOperationsJobs(),
    api.getOperationsOverview(),
  ]);
  return { readiness, jobs, overview };
};
const { data, status, error, reload } = useAsyncResource(load);
const checkStatusLabel = (value: string) => value === "ok" ? "正常" : value === "degraded" ? "功能受限" : "需要处理";
const jobStateLabel = (value: string) => ({ created: "等待处理", retry: "等待重试", active: "正在处理", completed: "已完成", cancelled: "已取消", failed: "失败" } as Record<string, string>)[value] ?? "状态未知";
</script>

<template>
  <section>
    <PageHeader title="运营状态" description="管理员可在这里查看系统能否正常工作、最近任务和数据保护情况。" />
    <AsyncState :status="status" :error="error" empty-title="暂无运营数据" empty-message="尚未产生任务或恢复记录。" @retry="reload">
      <div v-if="data" class="dashboard-stack">
        <section class="surface-section">
          <div class="section-heading"><h2>系统检查</h2><p>{{ data.readiness.ready ? "系统可以正常工作" : "有项目需要管理员处理" }}</p></div>
          <div class="status-grid"><article v-for="check in data.readiness.checks" :key="check.name" class="status-card"><strong>{{ check.name }}</strong><span class="status-pill" :class="check.status === 'ok' ? 'is-success' : 'is-danger'">{{ checkStatusLabel(check.status) }}</span><p>{{ check.detail }}</p></article></div>
        </section>
        <section class="surface-section">
          <div class="section-heading"><h2>最近任务</h2><p>查看后台任务是否完成，以及失败后已经重试了几次。</p></div>
          <div class="table-scroll" tabindex="0"><table><thead><tr><th>任务</th><th>状态</th><th>已重试 / 最多重试</th><th>创建</th><th>完成</th></tr></thead><tbody><tr v-for="job in data.jobs" :key="job.id"><td>{{ job.name }}</td><td>{{ jobStateLabel(job.state) }}</td><td>{{ job.retry_count }} / {{ job.retry_limit }}</td><td>{{ job.created_on }}</td><td>{{ job.completed_on || '—' }}</td></tr></tbody></table></div>
        </section>
        <section class="surface-section">
          <div class="section-heading"><h2>对象存储</h2><p>生产环境必须全部达到远端验证要求。</p></div>
          <div class="table-scroll" tabindex="0"><table><thead><tr><th>对象类型</th><th>验证状态</th><th>对象数</th><th>明文字节</th></tr></thead><tbody><tr v-for="row in data.overview.storage" :key="`${row.object_kind}:${row.verification_status}`"><td>{{ row.object_kind }}</td><td>{{ row.verification_status }}</td><td>{{ row.object_count }}</td><td>{{ row.plaintext_bytes }}</td></tr></tbody></table></div>
        </section>
        <section class="surface-section">
          <div class="section-heading"><h2>汇率、备份与告警</h2><p>缺少生产外部目标时只允许本地验收，不得宣称生产就绪。</p></div>
          <dl class="summary-list"><div><dt>最近汇率同步</dt><dd>{{ data.overview.fxSyncRuns[0]?.status || '无记录' }}</dd></div><div><dt>最近备份</dt><dd>{{ data.overview.backups[0]?.status || '无记录' }}</dd></div><div><dt>最近恢复检查点</dt><dd>{{ data.overview.recoveryCheckpoints[0]?.status || '无记录' }}</dd></div><div><dt>未解决告警</dt><dd>{{ data.overview.alerts.length }}</dd></div></dl>
        </section>
      </div>
    </AsyncState>
  </section>
</template>
