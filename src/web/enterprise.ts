import { computed, reactive } from "vue";
import { api } from "./api/client";
import type { Enterprise } from "./api/types";

const STORAGE_KEY = "revenueCostsEnterpriseV01";

export const enterpriseState = reactive<{
  items: Enterprise[];
  currentId: string;
  loading: boolean;
  error: string;
}>({ items: [], currentId: "", loading: false, error: "" });

export const currentEnterprise = computed(() =>
  enterpriseState.items.find((enterprise) => enterprise.id === enterpriseState.currentId) ?? null);

export function selectEnterprise(enterpriseId: string) {
  if (!enterpriseState.items.some((enterprise) => enterprise.id === enterpriseId)) return;
  enterpriseState.currentId = enterpriseId;
  try { window.localStorage.setItem(STORAGE_KEY, enterpriseId); } catch { /* optional UI preference */ }
}

export async function loadEnterprises(force = false): Promise<Enterprise[]> {
  if (enterpriseState.loading) return enterpriseState.items;
  if (!force && enterpriseState.items.length) return enterpriseState.items;
  enterpriseState.loading = true;
  enterpriseState.error = "";
  try {
    enterpriseState.items = [...await api.listEnterprises()];
    const saved = (() => { try { return window.localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; } })();
    const next = enterpriseState.items.some((item) => item.id === enterpriseState.currentId)
      ? enterpriseState.currentId
      : enterpriseState.items.some((item) => item.id === saved) ? saved : enterpriseState.items[0]?.id ?? "";
    enterpriseState.currentId = next;
    if (next) selectEnterprise(next);
    return enterpriseState.items;
  } catch (error) {
    enterpriseState.error = error instanceof Error ? error.message : "企业加载失败";
    throw error;
  } finally { enterpriseState.loading = false; }
}
