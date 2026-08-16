<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api/client";
import { userFacingError } from "../api/http";
import type { AdminApp } from "../api/types";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";

const { data: apps, status, error, reload } = useAsyncResource(api.listAdminApps);
const price = ref(""); const reason = ref(""); const actionError = ref(""); const selectedId = ref("");
async function update(app: AdminApp, action: string, allowedRoles?: Array<"ACCOUNTANT">) {
  selectedId.value = app.id; actionError.value = "";
  if (!reason.value.trim()) { actionError.value = "应用和价格变更必须填写原因"; return; }
  try { await api.updateAdminApp(app, { action, reason: reason.value.trim(), ...(action === "NEW_PRICE" ? { annualPriceYuan: price.value } : {}), ...(allowedRoles ? { allowedRoles } : {}) }); price.value = ""; reason.value = ""; await reload(); }
  catch (caught) { actionError.value = userFacingError(caught); }
}
async function toggleUserCreation(app: AdminApp) {
  const allowedRoles: Array<"ACCOUNTANT"> = app.allowedRoles.includes("ACCOUNTANT") ? [] : ["ACCOUNTANT"];
  await update(app, "SET_ROLES", allowedRoles);
}
const appStatusName = (status: AdminApp["status"]) => status === "PUBLISHED" ? "已上架" : "已下架";
</script>

<template>
  <section>
    <PageHeader
      title="应用管理"
      description="管理应用上下架、顺序、做账员建公司权限和只向前生效的年度价格版本。管理员可为选定企业免费使用启用中的应用。"
    />
    <AsyncState
      :status="status"
      :error="error"
      empty-title="暂无应用"
      empty-message="应用由初始化迁移建立，当前没有可管理记录。"
      @retry="reload"
    >
      <section class="surface-section">
        <div
          class="table-scroll"
          tabindex="0"
        >
          <table>
            <thead><tr><th>应用</th><th>状态</th><th>排序</th><th>年度价格（分）</th><th>价格版本</th><th>做账员建公司</th><th>操作</th></tr></thead><tbody>
              <tr
                v-for="app in apps"
                :key="app.id"
              >
                <td>
                  <input
                    v-model.trim="app.name"
                    class="compact-input"
                    aria-label="应用名称"
                  >
                </td><td>{{ appStatusName(app.status) }}</td><td>
                  <input
                    v-model.trim="app.sortOrder"
                    class="compact-input"
                    inputmode="numeric"
                    aria-label="应用排序"
                  >
                </td><td class="numeric">
                  {{ app.annualPriceCents }}
                </td><td>{{ app.priceVersion }}</td><td>
                  <button
                    class="secondary-button compact"
                    type="button"
                    :aria-pressed="app.allowedRoles.includes('ACCOUNTANT')"
                    @click="toggleUserCreation(app)"
                  >{{ app.allowedRoles.includes("ACCOUNTANT") ? "已允许" : "已禁止" }}</button>
                </td><td>
                  <div class="table-actions">
                    <input
                      v-model.trim="reason"
                      class="compact-input"
                      placeholder="变更原因"
                      aria-label="变更原因"
                    ><button
                      class="secondary-button compact"
                      type="button"
                      @click="update(app, 'SET_DETAILS')"
                    >保存名称与排序</button><button
                      class="secondary-button compact"
                      type="button"
                      @click="update(app, app.status === 'PUBLISHED' ? 'UNPUBLISH' : 'PUBLISH')"
                    >
                      {{ app.status === "PUBLISHED" ? "下架" : "上架" }}
                    </button><input
                      v-model.trim="price"
                      class="compact-input"
                      placeholder="新年价（元）"
                      aria-label="新年度价格"
                    ><button
                      class="secondary-button compact"
                      type="button"
                      @click="update(app, 'NEW_PRICE')"
                    >新建价格版本</button>
                  </div><p
                    v-if="selectedId === app.id && actionError"
                    class="form-error"
                  >
                    {{ actionError }}
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="governance-links">
          <span>确认表格每一列的含义</span><span>站点名称、时间和重要程度</span><span>人工汇率</span><span>失败任务</span><span>操作记录</span><p>管理员对这些内容的每次修改都会保留记录，方便以后核对。</p>
        </div>
      </section>
    </AsyncState>
  </section>
</template>
