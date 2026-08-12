<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { api } from "../api/client";
import type { EnterpriseMember } from "../api/types";
import { currentEnterprise, enterpriseState, loadEnterprises, selectEnterprise } from "../enterprise";
import { hasPlatformRole } from "../navigation";
import { session } from "../session";
import PhoneDisplay from "./PhoneDisplay.vue";

const emit = defineEmits<{ selected: [] }>();
const creating = ref(false);
const editing = ref(false);
const membersOpen = ref(false);
const name = ref("");
const creditCode = ref("");
const memberPhone = ref("");
const memberName = ref("");
const removeReason = ref("");
const members = ref<EnterpriseMember[]>([]);
const busy = ref(false);
const error = ref("");
const canCreateEnterprise = computed(() => hasPlatformRole(session.me, "ACCOUNTANT"));

const walletYuan = computed(() => {
  if (!currentEnterprise.value) return "0.00";
  const cents = BigInt(currentEnterprise.value.wallet.balanceCents);
  const absolute = cents < 0n ? -cents : cents;
  return `${cents < 0n ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
});

function choose(id: string) {
  selectEnterprise(id);
  resetProfileForm();
  emit("selected");
}

function resetProfileForm() {
  name.value = currentEnterprise.value?.name ?? "";
  creditCode.value = currentEnterprise.value?.unifiedSocialCreditCode ?? "";
}

async function saveEnterprise() {
  error.value = "";
  if (!name.value.trim() || (!editing.value && !/^[0-9A-Za-z]{18}$/.test(creditCode.value.trim()))) {
    error.value = "创建企业必须填写企业名称和 18 位统一社会信用代码";
    return;
  }
  busy.value = true;
  try {
    if (currentEnterprise.value && editing.value) {
      const changes: { name?: string; unifiedSocialCreditCode?: string } = {};
      if (currentEnterprise.value.canEditName && name.value.trim() !== currentEnterprise.value.name) changes.name = name.value.trim();
      if (currentEnterprise.value.canEditCreditCode && creditCode.value.trim().toUpperCase() !== (currentEnterprise.value.unifiedSocialCreditCode ?? "")) changes.unifiedSocialCreditCode = creditCode.value.trim().toUpperCase();
      if (!Object.keys(changes).length) { editing.value = false; return; }
      await api.updateEnterprise(currentEnterprise.value.id, changes);
    } else {
      const created = await api.createEnterprise(name.value.trim(), creditCode.value.trim().toUpperCase());
      await loadEnterprises(true);
      selectEnterprise(created.id);
    }
    creating.value = false;
    editing.value = false;
    await loadEnterprises(true);
    resetProfileForm();
    emit("selected");
  } catch (caught) { error.value = caught instanceof Error ? caught.message : "企业保存失败"; }
  finally { busy.value = false; }
}

async function loadMembers() {
  if (!currentEnterprise.value) return;
  error.value = "";
  try { members.value = [...await api.listEnterpriseMembers(currentEnterprise.value.id)]; }
  catch (caught) { error.value = caught instanceof Error ? caught.message : "做账员加载失败"; }
}

async function toggleMembers() {
  membersOpen.value = !membersOpen.value;
  if (membersOpen.value) await loadMembers();
}

async function addMember() {
  if (!currentEnterprise.value || !/^1\d{10}$/.test(memberPhone.value)) { error.value = "请输入有效的 11 位手机号"; return; }
  busy.value = true; error.value = "";
  try {
    await api.addEnterpriseMember(currentEnterprise.value.id, memberPhone.value, memberName.value.trim() || undefined);
    memberPhone.value = ""; memberName.value = "";
    await Promise.all([loadMembers(), loadEnterprises(true)]);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : "新增做账员失败"; }
  finally { busy.value = false; }
}

async function removeMember(member: EnterpriseMember) {
  if (!currentEnterprise.value || !removeReason.value.trim()) { error.value = "删除做账员前请填写原因"; return; }
  busy.value = true; error.value = "";
  try {
    await api.removeEnterpriseMember(currentEnterprise.value.id, member.id, removeReason.value.trim());
    removeReason.value = "";
    await Promise.all([loadMembers(), loadEnterprises(true)]);
  } catch (caught) { error.value = caught instanceof Error ? caught.message : "删除做账员失败"; }
  finally { busy.value = false; }
}

watch(currentEnterprise, resetProfileForm);
onMounted(async () => { await loadEnterprises(); resetProfileForm(); emit("selected"); });
</script>

<template>
  <section class="surface-section enterprise-workspace" aria-labelledby="enterprise-title">
    <div class="enterprise-toolbar">
      <div class="section-heading"><h2 id="enterprise-title">企业工作台</h2><p>企业拥有公司与钱包；有效做账员共享处理权限。</p></div>
      <div class="enterprise-switch-actions">
        <label v-if="enterpriseState.items.length" class="form-field compact-field"><span>当前企业</span><select :value="enterpriseState.currentId" @change="choose(($event.target as HTMLSelectElement).value)"><option v-for="enterprise in enterpriseState.items" :key="enterprise.id" :value="enterprise.id">{{ enterprise.name }}</option></select></label>
        <button v-if="canCreateEnterprise" class="secondary-button compact" type="button" @click="creating = true; editing = false; name = ''; creditCode = ''">创建企业</button>
      </div>
    </div>

    <div v-if="currentEnterprise" class="enterprise-current">
      <div class="enterprise-identity"><div><strong>{{ currentEnterprise.name }}</strong><span>{{ currentEnterprise.unifiedSocialCreditCode || "历史企业资料待补录" }}</span></div><div class="row-actions"><button v-if="currentEnterprise.canEditName || currentEnterprise.canEditCreditCode" class="secondary-button compact" type="button" @click="editing = true; creating = false; resetProfileForm()">编辑资料</button><button class="secondary-button compact" type="button" @click="toggleMembers">{{ membersOpen ? "收起做账员" : "管理做账员" }}</button></div></div>
      <dl class="summary-list enterprise-summary"><div><dt>企业钱包</dt><dd>¥{{ walletYuan }}</dd></div><div><dt>做账员</dt><dd>{{ currentEnterprise.memberCount }}</dd></div><div><dt>公司总数</dt><dd>{{ currentEnterprise.companyCount }}</dd></div><div><dt>未做账 / 已提交</dt><dd>{{ currentEnterprise.notStartedCount }} / {{ currentEnterprise.submittedCount }}</dd></div></dl>
      <p v-if="!currentEnterprise.profileComplete" class="form-error">历史企业需补齐名称和统一社会信用代码后，才能充值、新建公司或新增做账员。</p>
    </div>
    <div v-else-if="!enterpriseState.loading" class="workflow-empty-stage"><strong>{{ canCreateEnterprise ? "先创建企业" : "暂无企业" }}</strong><p>企业是公司、做账员和共享钱包的归属主体。</p><button v-if="canCreateEnterprise" class="primary-button compact" type="button" @click="creating = true">创建企业</button></div>

    <form v-if="creating || editing" class="enterprise-inline-form" @submit.prevent="saveEnterprise">
      <div class="form-grid three"><label class="form-field"><span>企业名称</span><input v-model.trim="name" maxlength="120" :readonly="editing && !currentEnterprise?.canEditName" /></label><label class="form-field"><span>统一社会信用代码</span><input v-model.trim="creditCode" maxlength="18" autocomplete="off" :readonly="editing && !currentEnterprise?.canEditCreditCode" /><small v-if="editing && !currentEnterprise?.canEditCreditCode">创建后仅管理员可修改</small></label><div class="form-actions"><button class="secondary-button" type="button" @click="creating = false; editing = false; resetProfileForm()">取消</button><button class="primary-button" type="submit" :disabled="busy">保存</button></div></div>
    </form>

    <div v-if="membersOpen && currentEnterprise" class="enterprise-members">
      <div class="form-grid three"><label class="form-field"><span>手机号</span><input v-model.trim="memberPhone" maxlength="11" inputmode="numeric" /></label><label class="form-field"><span>姓名或备注（选填）</span><input v-model.trim="memberName" maxlength="80" /></label><button class="primary-button" type="button" :disabled="busy || !currentEnterprise.profileComplete" @click="addMember">新增做账员</button></div>
      <label class="form-field"><span>删除原因</span><input v-model.trim="removeReason" maxlength="1000" placeholder="仅在删除成员时填写" /></label>
      <div v-if="members.length" class="table-scroll" tabindex="0"><table><thead><tr><th>做账员</th><th>手机号</th><th>状态</th><th>操作</th></tr></thead><tbody><tr v-for="member in members" :key="member.id"><td>{{ member.displayName || "未填写姓名" }}</td><td><PhoneDisplay :value="member.phoneMasked" /></td><td>{{ member.status === "ACTIVE" ? "已加入" : member.status === "PENDING" ? "待加入" : "已撤销" }}</td><td><button v-if="member.status !== 'REVOKED'" class="secondary-button compact" type="button" :disabled="busy" @click="removeMember(member)">删除</button></td></tr></tbody></table></div>
    </div>
    <p v-if="enterpriseState.error || error" class="form-error" role="alert">{{ error || enterpriseState.error }}</p>
  </section>
</template>
