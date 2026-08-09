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
</script>

<template>
  <section>
    <PageHeader title="运营状态" description="查看数据库、队列、存储、汇率同步与恢复证据；生产停止条件不会被页面绕过。" />
    <AsyncState :status="status" :error="error" empty-title="暂无运营数据" empty-message="尚未产生任务或恢复记录。" @retry="reload">
      <div v-if="data" class="dashboard-stack">
        <section class="surface-section">
          <div class="section-heading"><h2>就绪检查</h2><p>{{ data.readiness.ready ? "当前运行模式已就绪" : "存在阻断项" }}</p></div>
          <div class="status-grid"><article v-for="check in data.readiness.checks" :key="check.name" class="status-card"><strong>{{ check.name }}</strong><span class="status-pill" :class="check.status === 'ok' ? 'is-success' : 'is-danger'">{{ check.status }}</span><p>{{ check.detail }}</p></article></div>
        </section>
        <section class="surface-section">
          <div class="section-heading"><h2>最近任务</h2><p>租约、重试和终态以 pg-boss 为准。</p></div>
          <div class="table-scroll" tabindex="0"><table><thead><tr><th>队列</th><th>状态</th><th>重试</th><th>创建</th><th>完成</th></tr></thead><tbody><tr v-for="job in data.jobs" :key="job.id"><td>{{ job.name }}</td><td>{{ job.state }}</td><td>{{ job.retry_count }} / {{ job.retry_limit }}</td><td>{{ job.created_on }}</td><td>{{ job.completed_on || '—' }}</td></tr></tbody></table></div>
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
