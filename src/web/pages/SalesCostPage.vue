<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { api } from "../api/client";
import type { Shop, ShopMembership } from "../api/types";
import AsyncState from "../components/AsyncState.vue";
import DataTutorialDialog from "../components/DataTutorialDialog.vue";
import PageHeader from "../components/PageHeader.vue";
import { useAsyncResource } from "../composables/useAsyncResource";
import { hasPlatformRole } from "../navigation";
import { session } from "../session";
import { currentEnterprise, loadEnterprises } from "../enterprise";

async function loadCompanies() {
  await loadEnterprises();
  const selected = currentEnterprise.value ? await api.listShops(currentEnterprise.value.id) : [];
  const shared = (await api.listShops()).filter((shop) => shop.access === "CUSTOMER");
  return [...new Map([...selected, ...shared].map((shop) => [shop.id, shop])).values()];
}
const { data: shops, status, error, reload } = useAsyncResource(loadCompanies);
watch(() => currentEnterprise.value?.id, (next, previous) => { if (next !== previous) void reload(); });
const owned = computed(() => shops.value?.filter((shop) => shop.access !== "CUSTOMER") ?? []);
const shared = computed(() => shops.value?.filter((shop) => shop.access === "CUSTOMER") ?? []);
const shopFilter = ref<"ACTIVE" | "TRASHED">("ACTIVE");
const visibleOwned = computed(() => owned.value.filter((shop) => shopFilter.value === "TRASHED" ? shop.status === "TRASHED" : shop.status !== "TRASHED"));
const selectedShopIds = ref<Set<string>>(new Set());
const selectedCount = computed(() => selectedShopIds.value.size);
const allVisibleSelected = computed(() => visibleOwned.value.length > 0 && visibleOwned.value.every((shop) => selectedShopIds.value.has(shop.id)));
const isAdmin = computed(() => hasPlatformRole(session.me, "ADMIN"));
const canCreate = computed(() => Boolean(currentEnterprise.value?.profileComplete) && (hasPlatformRole(session.me, "ACCOUNTANT") || isAdmin.value));
const showCreate = ref(false);
const creationOffer = ref<{ applicationId: string; applicationName: string; annualPriceCents: string } | null>(null);
const name = ref("");
const termStart = ref(new Date().toISOString().slice(0, 10));
const billingYears = ref("1");
const formError = ref("");
const saving = ref(false);
const managingShopId = ref("");
const manageName = ref("");
const renewCloseDate = ref("");
const manageReason = ref("");
const memberPhone = ref("");
const memberExportAllowed = ref(false);
const members = ref<ShopMembership[]>([]);
const invitationStatusMessage = ref("");
const manageError = ref("");
const managing = ref(false);
const bulkDialogOpen = ref(false);
const bulkReason = ref("");
const bulkError = ref("");
const bulkSaving = ref(false);
const tutorialDialog = ref<{ open: () => void } | null>(null);
const managingShop = computed(() => owned.value.find((shop) => shop.id === managingShopId.value) ?? null);
const creationCost = computed(() => creationOffer.value
  ? (BigInt(creationOffer.value.annualPriceCents) * BigInt(billingYears.value)).toString()
  : "");
const creationCostLabel = computed(() => {
  if (!creationCost.value) return "";
  const cents = BigInt(creationCost.value);
  const yuan = cents % 100n === 0n
    ? (cents / 100n).toString()
    : `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return `${yuan}￥`;
});
const creationButtonLabel = computed(() => isAdmin.value
  ? "创建（管理员免费）"
  : creationCostLabel.value
    ? `创建（消耗${creationCostLabel.value}）`
    : "正在读取价格");

async function openCreateDialog() {
  showCreate.value = true;
  formError.value = "";
  if (creationOffer.value) return;
  try { creationOffer.value = await api.getAmazonShopOffer(); }
  catch (caught) { formError.value = caught instanceof Error ? caught.message : "无法读取当前公司价格"; }
}

function closeCreateDialog() {
  if (saving.value) return;
  showCreate.value = false;
  formError.value = "";
}

function openTutorial() {
  tutorialDialog.value?.open();
}

function toggleShop(shopId: string) {
  const next = new Set(selectedShopIds.value);
  if (next.has(shopId)) next.delete(shopId); else next.add(shopId);
  selectedShopIds.value = next;
}

function toggleVisibleShops() {
  const next = new Set(selectedShopIds.value);
  if (allVisibleSelected.value) visibleOwned.value.forEach((shop) => next.delete(shop.id));
  else visibleOwned.value.forEach((shop) => next.add(shop.id));
  selectedShopIds.value = next;
}

async function bulkTrash() {
  bulkError.value = "";
  if (!bulkReason.value.trim()) { bulkError.value = "请填写批量删除原因"; return; }
  bulkSaving.value = true;
  try {
    await api.bulkTrashShops([...selectedShopIds.value], bulkReason.value.trim());
    selectedShopIds.value = new Set();
    bulkReason.value = "";
    bulkDialogOpen.value = false;
    await reload();
  } catch (caught) { bulkError.value = caught instanceof Error ? caught.message : "批量删除失败"; }
  finally { bulkSaving.value = false; }
}

async function createShop() {
  formError.value = "";
  if (!currentEnterprise.value?.profileComplete) { formError.value = "请先选择并补齐企业资料"; return; }
  if (!name.value.trim()) { formError.value = "请输入公司名称"; return; }
  if (!creationOffer.value) { formError.value = "尚未读取当前公司价格"; return; }
  saving.value = true;
  try {
    await api.createShop({
      enterpriseId: currentEnterprise.value!.id,
      applicationId: creationOffer.value.applicationId,
      name: name.value.trim(),
      termStart: termStart.value,
      billingYears: billingYears.value,
    });
    showCreate.value = false;
    name.value = "";
    await reload();
  } catch (caught) { formError.value = caught instanceof Error ? caught.message : "创建失败"; }
  finally { saving.value = false; }
}

async function copyName(shop: Shop) {
  await navigator.clipboard.writeText(shop.name);
}

function accountantLabel(displayName: string | undefined, accountId: string) {
  return displayName || `做账员 ${accountId.slice(0, 8)}`;
}

async function openManagement(shop: Shop) {
  managingShopId.value = managingShopId.value === shop.id ? "" : shop.id;
  manageName.value = shop.name;
  renewCloseDate.value = shop.termEndExclusive;
  manageReason.value = "";
  invitationStatusMessage.value = "";
  manageError.value = "";
  if (!managingShopId.value || shop.status === "TRASHED") { members.value = []; return; }
  try { members.value = [...await api.listShopMembers(shop.id)]; }
  catch (caught) { manageError.value = caught instanceof Error ? caught.message : "客户成员加载失败"; }
}

function closeManagement() {
  managingShopId.value = "";
  members.value = [];
  manageError.value = "";
}

async function rename(shop: Shop) {
  managing.value = true; manageError.value = "";
  try { await api.renameShop(shop.id, manageName.value); await reload(); managingShopId.value = ""; }
  catch (caught) { manageError.value = caught instanceof Error ? caught.message : "改名失败"; }
  finally { managing.value = false; }
}

async function renew(shop: Shop) {
  managing.value = true; manageError.value = "";
  if (hasPlatformRole(session.me, "ADMIN") && !manageReason.value.trim()) { manageError.value = "管理员免费续期必须填写减免原因"; managing.value = false; return; }
  try { await api.renewShop(shop.id, renewCloseDate.value, manageReason.value.trim() || undefined); await reload(); managingShopId.value = ""; }
  catch (caught) { manageError.value = caught instanceof Error ? caught.message : "续期失败"; }
  finally { managing.value = false; }
}

async function changeLifecycle(shop: Shop, action: "TRASH" | "RESTORE") {
  manageError.value = "";
  if (!manageReason.value.trim()) { manageError.value = "删除或恢复公司必须填写原因"; return; }
  managing.value = true;
  try {
    if (action === "TRASH") await api.trashShop(shop.id, manageReason.value.trim());
    else await api.restoreShop(shop.id, manageReason.value.trim());
    await reload(); managingShopId.value = "";
  } catch (caught) { manageError.value = caught instanceof Error ? caught.message : "公司状态变更失败"; }
  finally { managing.value = false; }
}

async function inviteMember(shop: Shop) {
  manageError.value = "";
  if (!/^1\d{10}$/.test(memberPhone.value)) { manageError.value = "请输入有效的客户手机号"; return; }
  managing.value = true;
  try {
    const invitation = await api.inviteShopMember(shop.id, memberPhone.value, memberExportAllowed.value);
    invitationStatusMessage.value = invitation.status === "ACTIVE"
      ? "客户已授权，下次登录将直接进入该公司。"
      : "邀请已创建，客户使用该手机号注册并登录后将直接进入该公司。";
    memberPhone.value = ""; memberExportAllowed.value = false;
    if (invitation.status === "ACTIVE") members.value = [...await api.listShopMembers(shop.id)];
  } catch (caught) { manageError.value = caught instanceof Error ? caught.message : "创建客户邀请失败"; }
  finally { managing.value = false; }
}

async function updateMember(member: ShopMembership, action: "EXPORT" | "REVOKE") {
  manageError.value = "";
  if (!manageReason.value.trim()) { manageError.value = "客户授权变更必须填写原因"; return; }
  managing.value = true;
  try {
    if (action === "EXPORT") await api.setMemberExport(member.id, !member.exportAllowed, manageReason.value.trim());
    else await api.revokeMember(member.id, manageReason.value.trim());
    members.value = [...await api.listShopMembers(member.shopId)];
  } catch (caught) { manageError.value = caught instanceof Error ? caught.message : "客户授权变更失败"; }
  finally { managing.value = false; }
}
</script>

<template>
  <section>
    <PageHeader title="销售成本" description="按公司查看数据版本、完整性、试算与已发布快照。" />

    <AsyncState :status="status" :error="error" empty-title="还没有可访问的公司" empty-message="请先创建或加入企业；公司客户授权会额外显示在这里。" @retry="reload">
      <template #empty-action><div class="empty-actions"><button v-if="canCreate" class="primary-button compact" type="button" @click="openCreateDialog">创建公司</button><button class="tutorial-trigger compact" type="button" @click="openTutorial">获取资料教程</button></div></template>

      <div v-if="owned.length" class="surface-section shop-index-panel">
        <div class="shop-index-heading">
          <div class="section-heading"><h2>我的公司</h2><p>选择公司后可批量移入30天回收站，打开后进入独立六阶段工作台。</p></div>
          <div class="shop-index-actions"><button v-if="canCreate" class="primary-button compact" type="button" @click="openCreateDialog">创建公司</button><button class="tutorial-trigger compact" type="button" @click="openTutorial">获取资料教程</button></div>
          <div class="shop-filter" role="group" aria-label="公司状态筛选"><button type="button" :class="{ 'is-active': shopFilter === 'ACTIVE' }" @click="shopFilter = 'ACTIVE'; selectedShopIds = new Set()">使用中</button><button type="button" :class="{ 'is-active': shopFilter === 'TRASHED' }" @click="shopFilter = 'TRASHED'; selectedShopIds = new Set()">回收站</button></div>
        </div>

        <div class="shop-selection-bar" :class="{ 'has-selection': selectedCount > 0 }">
          <label><input type="checkbox" :checked="allVisibleSelected" :disabled="visibleOwned.length === 0" @change="toggleVisibleShops" /><span>{{ allVisibleSelected ? "取消全选" : "全选" }}</span></label>
          <span>已选择 {{ selectedCount }} 个公司</span>
          <button v-if="shopFilter === 'ACTIVE'" class="secondary-button compact" type="button" :disabled="selectedCount === 0" @click="bulkDialogOpen = true">批量删除</button>
        </div>

        <div class="shop-list">
          <article v-for="shop in visibleOwned" :key="shop.id" class="shop-row shop-row-redesigned">
            <label class="shop-check"><input type="checkbox" :checked="selectedShopIds.has(shop.id)" :aria-label="`选择公司 ${shop.name}`" @change="toggleShop(shop.id)" /></label>
            <div class="shop-identity"><h3>{{ shop.name }}</h3><button type="button" @click="copyName(shop)">复制名称</button><span class="access-label">{{ shop.access === "ADMIN" ? "管理员访问" : "企业成员" }}</span></div>
            <dl><div><dt>做账状态</dt><dd>{{ shop.accountingStatus === "SUBMITTED" ? "已提交" : "未做账" }}</dd></div><div><dt>期限</dt><dd>{{ shop.termStart }} 至 {{ shop.termEndExclusive }}</dd></div><div><dt>创建做账员</dt><dd>{{ accountantLabel(shop.createdByDisplayName, shop.createdByAccountId) }}</dd></div><div><dt>最近操作</dt><dd>{{ accountantLabel(shop.lastOperatedByDisplayName, shop.lastOperatedByAccountId) }}</dd></div><div><dt>正式结果</dt><dd>{{ shop.publishedSnapshot ? (shop.publishedSnapshot.stale ? "有新数据处理中" : "已发布") : "尚未发布" }}</dd></div></dl>
            <div class="row-actions shop-primary-actions"><button class="secondary-button compact" type="button" @click="openManagement(shop)">设置</button><RouterLink v-if="shop.status !== 'TRASHED'" class="shop-open-button compact" :to="`/shops/${shop.id}/workflow/commit`" target="_blank" rel="noopener">打开</RouterLink><button v-else class="shop-open-button compact" type="button" disabled>打开</button></div>
          </article>
          <div v-if="visibleOwned.length === 0" class="workflow-empty-stage"><strong>{{ shopFilter === "TRASHED" ? "回收站为空" : "没有使用中的公司" }}</strong><p>{{ shopFilter === "TRASHED" ? "删除后的公司会在这里保留30天。" : "可以创建新公司开始数据流程。" }}</p></div>
        </div>
      </div>

      <div v-if="shared.length" class="surface-section shop-index-panel">
        <div class="section-heading"><h2>客户访问</h2><p>客户只能查看正式结果，未授权的草稿、预检和原件不会暴露。</p></div>
        <div class="shop-list">
          <article v-for="shop in shared" :key="shop.id" class="shop-row shop-row-redesigned is-shared">
            <div class="shop-identity"><h3>{{ shop.name }}</h3><button type="button" @click="copyName(shop)">复制名称</button><span class="access-label">客户只读</span></div>
            <dl><div><dt>状态</dt><dd>{{ shop.status }}</dd></div><div><dt>正式结果</dt><dd>{{ shop.publishedSnapshot ? "可查看" : "尚未发布" }}</dd></div></dl>
            <div class="row-actions shop-primary-actions"><RouterLink class="shop-open-button compact" :to="`/shops/${shop.id}/workflow/calculate`" target="_blank" rel="noopener">打开</RouterLink></div>
          </article>
        </div>
      </div>
    </AsyncState>

    <DataTutorialDialog ref="tutorialDialog" />

    <button v-if="managingShop" class="drawer-backdrop" type="button" aria-label="关闭公司设置" @click="closeManagement"></button>
    <aside v-if="managingShop" class="shop-settings-drawer" aria-label="公司设置">
      <header><div><span>公司设置</span><h2>{{ managingShop.name }}</h2></div><button type="button" aria-label="关闭" @click="closeManagement">关闭</button></header>
      <div class="drawer-content">
        <div v-if="managingShop.status === 'TRASHED'" class="drawer-section"><p>该公司位于30天回收站，恢复后保留原期限、数据版本和改名状态。</p><label class="form-field"><span>恢复原因</span><input v-model.trim="manageReason" /></label><button class="primary-button" type="button" :disabled="managing" @click="changeLifecycle(managingShop, 'RESTORE')">从回收站恢复</button></div>
        <template v-else>
          <section class="drawer-section"><h3>基本信息</h3><label class="form-field"><span>公司名称</span><input v-model.trim="manageName" :disabled="!managingShop.renameAvailable" /></label><button class="secondary-button" type="button" :disabled="managing || !managingShop.renameAvailable" @click="rename(managingShop)">使用唯一一次改名</button><label class="form-field"><span>续期至（关闭日）</span><input v-model="renewCloseDate" type="date" /></label><button class="secondary-button" type="button" :disabled="managing" @click="renew(managingShop)">续期</button></section>
          <section class="drawer-section"><h3>客户授权</h3><p>客户默认不可导出，且不能查看草稿或下载原件。已注册客户立即生效，未注册手机号将在注册后自动生效。</p><label class="form-field"><span>客户手机号</span><input v-model.trim="memberPhone" inputmode="numeric" maxlength="11" /></label><label class="form-field"><span>导出权限</span><select v-model="memberExportAllowed"><option :value="false">默认关闭</option><option :value="true">允许无 PII 快照导出</option></select></label><button class="secondary-button" type="button" :disabled="managing" @click="inviteMember(managingShop)">邀请客户</button><div v-if="invitationStatusMessage" class="sandbox-notice" role="status"><strong>邀请状态</strong><span>{{ invitationStatusMessage }}</span></div><div v-if="members.length" class="table-scroll" tabindex="0"><table><thead><tr><th>客户账号</th><th>状态</th><th>导出</th><th>操作</th></tr></thead><tbody><tr v-for="member in members" :key="member.id"><td>{{ member.accountId }}</td><td>{{ member.status }}</td><td>{{ member.exportAllowed ? "允许" : "关闭" }}</td><td><div class="table-actions"><button v-if="member.status === 'ACTIVE'" class="secondary-button compact" type="button" :disabled="managing" @click="updateMember(member, 'EXPORT')">{{ member.exportAllowed ? "关闭导出" : "允许导出" }}</button><button v-if="member.status === 'ACTIVE'" class="secondary-button compact" type="button" :disabled="managing" @click="updateMember(member, 'REVOKE')">撤权</button></div></td></tr></tbody></table></div></section>
          <section class="drawer-section danger-zone"><h3>移入回收站</h3><p>公司在30天内可以恢复，不退款，也不会物理删除财务事实。</p><label class="form-field"><span>删除原因</span><input v-model.trim="manageReason" /></label><button class="secondary-button" type="button" :disabled="managing" @click="changeLifecycle(managingShop, 'TRASH')">删除公司</button></section>
        </template>
        <p v-if="manageError" class="form-error" role="alert">{{ manageError }}</p>
      </div>
    </aside>

    <div v-if="showCreate" class="modal-layer" role="presentation" @keydown.esc="closeCreateDialog">
      <button class="modal-backdrop" type="button" aria-label="关闭创建公司" @click="closeCreateDialog"></button>
      <form class="confirm-dialog create-shop-dialog" role="dialog" aria-modal="true" aria-labelledby="create-shop-title" @submit.prevent="createShop">
        <span>亚马逊销售成本</span>
        <h2 id="create-shop-title">创建公司</h2>
        <p>{{ isAdmin ? "管理员创建公司不扣钱包；系统仍记录原价、实付 0 元、价格版本和操作审计。" : "填写公司信息后从当前企业钱包扣费。取消不会产生任何费用。" }}</p>
        <div class="form-grid three">
          <label class="form-field"><span>公司名称</span><input v-model.trim="name" maxlength="120" autocomplete="off" autofocus /></label>
          <label class="form-field"><span>开始日期</span><input v-model="termStart" type="date" /></label>
          <label class="form-field"><span>计费年数</span><select v-model="billingYears"><option value="1">1 年</option><option value="2">2 年</option><option value="3">3 年</option></select></label>
        </div>
        <div v-if="creationOffer" class="create-shop-price"><span>{{ isAdmin ? "管理员免费" : "当前费用" }}</span><strong>{{ isAdmin ? "0￥" : creationCostLabel }}</strong><small>{{ isAdmin ? `原价 ${creationCostLabel}，提交时写入 ADMIN_FREE 审计` : `${billingYears} 年，提交时按当前价格版本核验` }}</small></div>
        <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
        <div class="form-actions"><button class="secondary-button" type="button" :disabled="saving" @click="closeCreateDialog">取消</button><button class="primary-button" type="submit" :disabled="saving || !creationOffer">{{ saving ? "正在创建" : creationButtonLabel }}</button></div>
      </form>
    </div>

    <div v-if="bulkDialogOpen" class="modal-layer" role="presentation">
      <button class="modal-backdrop" type="button" aria-label="关闭批量删除确认" @click="bulkDialogOpen = false"></button>
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-trash-title"><span>批量操作</span><h2 id="bulk-trash-title">删除 {{ selectedCount }} 个公司</h2><p>所选公司将进入30天回收站。任一公司存在运行任务或权限问题时，本次操作全部取消。</p><label class="form-field"><span>删除原因</span><textarea v-model.trim="bulkReason" rows="3" maxlength="1000"></textarea></label><p v-if="bulkError" class="form-error" role="alert">{{ bulkError }}</p><div class="form-actions"><button class="secondary-button" type="button" @click="bulkDialogOpen = false">取消</button><button class="primary-button" type="button" :disabled="bulkSaving" @click="bulkTrash">{{ bulkSaving ? "正在删除" : "确认删除" }}</button></div></section>
    </div>
  </section>
</template>
