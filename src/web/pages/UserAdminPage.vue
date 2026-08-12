<script setup lang="ts">
import { ref } from "vue";
import { api } from "../api/client";
import type { AdminUser } from "../api/types";
import { avatarById } from "../avatars";
import AsyncState from "../components/AsyncState.vue";
import PageHeader from "../components/PageHeader.vue";
import PhoneDisplay from "../components/PhoneDisplay.vue";
import { useAsyncResource } from "../composables/useAsyncResource";

const search = ref("");
const { data: users, status, error, reload } = useAsyncResource(() => api.listAdminUsers(search.value));
const reason = ref(""); const actionError = ref(""); const selectedId = ref("");
const roleLabel = (user: AdminUser) => user.roles[0] === "ADMIN" ? "管理员" : "做账员";
async function act(user: AdminUser, action: string) {
  actionError.value = "";
  if (!reason.value.trim()) { selectedId.value = user.id; actionError.value = "角色、状态和调账操作必须填写原因"; return; }
  try { await api.updateAdminUser(user.id, { action, reason: reason.value.trim() }); reason.value = ""; selectedId.value = ""; await reload(); }
  catch (caught) { selectedId.value = user.id; actionError.value = caught instanceof Error ? caught.message : "操作失败"; }
}
</script>

<template>
  <section>
    <PageHeader
      title="做账员管理"
      description="管理做账员状态和平台管理员角色；企业、公司与钱包关系在企业工作台查看。"
    />
    <section class="surface-section">
      <form
        class="filter-bar"
        @submit.prevent="reload"
      >
        <label class="search-field"><span>搜索账号</span><input
          v-model.trim="search"
          type="search"
          placeholder="手机号或账号名称"
        ></label><button
          class="secondary-button compact"
          type="submit"
        >查询</button>
      </form>
      <AsyncState
        :status="status"
        :error="error"
        empty-title="没有匹配账号"
        empty-message="调整搜索条件后重试。"
        @retry="reload"
      >
        <div
          class="table-scroll"
          tabindex="0"
        >
          <table>
            <thead><tr><th>账号</th><th>角色</th><th>状态</th><th>企业</th><th>公司</th><th>治理操作</th></tr></thead><tbody>
              <tr
                v-for="user in users"
                :key="user.id"
              >
                <td>
                  <div class="admin-user-identity">
                    <img
                      :src="avatarById(user.avatarId).src"
                      alt=""
                    ><div><strong>{{ user.displayName || "未设置名称" }}</strong><small><PhoneDisplay :value="user.phoneMasked" /></small></div>
                  </div>
                </td><td>{{ roleLabel(user) }}</td><td>{{ user.status }}</td><td class="numeric">
                  {{ user.enterpriseCount }}
                </td><td class="numeric">
                  {{ user.companyCount }}
                </td><td>
                  <div class="admin-action">
                    <input
                      v-model="reason"
                      placeholder="操作原因"
                      aria-label="操作原因"
                    ><button
                      class="secondary-button compact"
                      type="button"
                      @click="act(user, user.status === 'ACTIVE' ? 'DISABLE' : 'ENABLE')"
                    >
                      {{ user.status === "ACTIVE" ? "禁用" : "启用" }}
                    </button><button
                      class="secondary-button compact"
                      type="button"
                      @click="act(user, user.roles.includes('ADMIN') ? 'REVOKE_ADMIN' : 'GRANT_ADMIN')"
                    >
                      {{ user.roles.includes("ADMIN") ? "改为做账员" : "设为管理员" }}
                    </button>
                  </div><p
                    v-if="selectedId === user.id && actionError"
                    class="form-error"
                  >
                    {{ actionError }}
                  </p>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </AsyncState>
    </section>
  </section>
</template>
