import { ApiError, apiFetch, apiRequest, withAppBasePath } from "./http";
import type {
  AdminApp,
  AdminUser,
  AccountingPreferences,
  CompletenessSlice,
  CostAccountingPreview,
  Enterprise,
  EnterpriseMember,
  ExportJob,
  FxOverrideInput,
  ImportPreview,
  IntermediateReportPage,
  IntermediateReportSummary,
  Me,
  ReportResult,
  ReportPeriod,
  Shop,
  ShopMembership,
  ShopWorkflow,
  WalletEntry,
  OperationsJob,
  OperationsOverview,
} from "./types";
import type { ThemeId } from "../theme";
import {
  normalizeFxConversions,
  normalizeFxHistory,
  normalizeFxOverrideList,
  normalizeFxOverrideMutation,
  normalizeFxStatus,
  normalizeUploadCompletion,
} from "./financial-contracts";
import { sha256Base64 } from "../uploads/checksum";

const json = (value: unknown) => JSON.stringify(value);

function commandIdempotencyKey(prefix: string): string {
  return globalThis.crypto?.randomUUID?.() ?? `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function createUploadBatchRequest<T>(body: string): Promise<T> {
  const idempotencyKey = commandIdempotencyKey("upload");
  const request = () => apiRequest<T>("/api/v1/uploads/batches", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body,
  });
  try {
    return await request();
  } catch (error) {
    // A transport failure can happen after the server committed. One replay
    // with the same key retrieves that committed batch without duplicating it.
    if (!(error instanceof TypeError)) throw error;
    return request();
  }
}

async function createRechargeRequest(enterpriseId: string, creditAmountCents: string) {
  const idempotencyKey = commandIdempotencyKey("recharge");
  const body = json({ enterpriseId, creditAmountCents });
  const request = () => apiRequest<{ orderId: string; status: string }>("/api/v1/payments/manual/orders", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body,
  });
  try {
    return await request();
  } catch (error) {
    // The server may have committed before the response was lost. Replay once
    // with the same key so the existing order is returned instead of credited twice.
    if (!(error instanceof TypeError)) throw error;
    return request();
  }
}

export function cnyToCents(value: string): string {
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error("金额必须是最多两位小数的非负十进制数");
  return (BigInt(match[1] ?? "0") * 100n + BigInt((match[2] ?? "").padEnd(2, "0") || "0")).toString();
}

function addBillingYears(startDate: string, yearsText: string): string {
  const years = Number(yearsText);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!match || !Number.isSafeInteger(years) || years < 1 || years > 100) throw new Error("店铺期限无效");
  const year = Number(match[1]) + years;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${Math.min(day, lastDay).toString().padStart(2, "0")}`;
}

export const api = {
  requestOtp: (phone: string, purpose: "REGISTER" | "LOGIN") => apiRequest<{ challengeId: string; expiresAt: string; sandboxCode?: string }>("/api/v1/auth/otp", { method: "POST", body: json({ phone: `+86${phone}`, purpose, deviceId: `web-${phone.slice(-4)}-${purpose.toLowerCase()}` }) }),
  registerAccount: async (challengeId: string, phone: string, code: string, displayName?: string) => {
    await apiRequest("/api/v1/auth/register", { method: "POST", body: json({ challengeId, phone: `+86${phone}`, code, purpose: "REGISTER", ...(displayName ? { displayName } : {}) }) });
    return apiRequest<Me>("/api/v1/me");
  },
  verifyOtp: async (challengeId: string, phone: string, code: string) => {
    await apiRequest("/api/v1/auth/verify", { method: "POST", body: json({ challengeId, phone: `+86${phone}`, code, purpose: "LOGIN" }) });
    return apiRequest<Me>("/api/v1/me");
  },
  logout: () => apiRequest<void>("/api/v1/auth/logout", { method: "POST" }),
  getMe: () => apiRequest<Me>("/api/v1/me"),
  updateProfile: (displayName: string) => apiRequest<Me>("/api/v1/me/profile", { method: "PATCH", body: json({ displayName }) }),
  updateTheme: (theme: ThemeId) => apiRequest<Me>("/api/v1/me/theme", { method: "PATCH", body: json({ themeId: theme }) }),
  updateAvatar: (avatarId: number) => apiRequest<Me>("/api/v1/me/avatar", { method: "PATCH", body: json({ avatarId }) }),
  getAccountingPreferences: () => apiRequest<AccountingPreferences>("/api/v1/me/accounting-preferences"),
  updateAccountingPreferences: (preferences: AccountingPreferences) => apiRequest<AccountingPreferences>("/api/v1/me/accounting-preferences", { method: "PATCH", body: json(preferences) }),
  getOnboarding: (guide: "WORKSPACE" | "SHOP_WORKFLOW", version: number, shopId?: string) => apiRequest<{ dismissed: boolean }>(`/api/v1/me/onboarding?guide=${guide}&version=${version}${shopId ? `&shopId=${encodeURIComponent(shopId)}` : ""}`),
  setOnboarding: (guide: "WORKSPACE" | "SHOP_WORKFLOW", version: number, dismissed: boolean, shopId?: string) => apiRequest<{ dismissed: boolean }>("/api/v1/me/onboarding", { method: "PATCH", body: json({ guide, version, dismissed, ...(shopId ? { shopId } : {}) }) }),
  listEnterprises: () => apiRequest<Enterprise[]>("/api/v1/enterprises"),
  createEnterprise: (name: string, unifiedSocialCreditCode: string) => apiRequest<Enterprise>("/api/v1/enterprises", { method: "POST", body: json({ name, unifiedSocialCreditCode }) }),
  updateEnterprise: (enterpriseId: string, changes: { name?: string; unifiedSocialCreditCode?: string }) => apiRequest<void>(`/api/v1/enterprises/${encodeURIComponent(enterpriseId)}`, { method: "PATCH", body: json(changes) }),
  listEnterpriseMembers: (enterpriseId: string) => apiRequest<EnterpriseMember[]>(`/api/v1/enterprises/${encodeURIComponent(enterpriseId)}/members`),
  addEnterpriseMember: (enterpriseId: string, phone: string, displayName?: string) => apiRequest<EnterpriseMember>(`/api/v1/enterprises/${encodeURIComponent(enterpriseId)}/members`, { method: "POST", body: json({ phone: `+86${phone}`, ...(displayName ? { displayName } : {}) }) }),
  removeEnterpriseMember: (enterpriseId: string, memberId: string, reason: string) => apiRequest<void>(`/api/v1/enterprises/${encodeURIComponent(enterpriseId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE", body: json({ reason }) }),
  listShops: (enterpriseId?: string) => apiRequest<Shop[]>(`/api/v1/shops${enterpriseId ? `?enterpriseId=${encodeURIComponent(enterpriseId)}` : ""}`),
  getAmazonShopOffer: async () => {
    const applications = await apiRequest<Array<{ id: string; code: string; name: string; status: "ACTIVE" | "INACTIVE"; currentPrice: { annualPriceCents: string } | null }>>("/api/v1/apps");
    const amazon = applications.find((application) => application.code === "amazon-sales-cost" && application.status === "ACTIVE");
    if (!amazon?.currentPrice) throw new Error("亚马逊销售成本应用尚未启用或缺少价格");
    return { applicationId: amazon.id, applicationName: amazon.name, annualPriceCents: amazon.currentPrice.annualPriceCents };
  },
  createShop: async (input: { enterpriseId: string; applicationId: string; name: string; termStart: string; billingYears: string }) => {
    return apiRequest<Shop>("/api/v1/shops", { method: "POST", body: json({ enterpriseId: input.enterpriseId, applicationId: input.applicationId, name: input.name, startDate: input.termStart, requestedCloseDate: addBillingYears(input.termStart, input.billingYears) }) });
  },
  renameShop: (shopId: string, name: string) => apiRequest<Shop>(`/api/v1/shops/${encodeURIComponent(shopId)}/name`, { method: "PATCH", body: json({ name }) }),
  renewShop: (shopId: string, requestedCloseDate: string, waiverReason?: string) => apiRequest<Shop>(`/api/v1/shops/${encodeURIComponent(shopId)}/renew`, { method: "POST", body: json({ requestedCloseDate, ...(waiverReason ? { waiverReason } : {}) }) }),
  trashShop: (shopId: string, reason: string) => apiRequest<Shop>(`/api/v1/shops/${encodeURIComponent(shopId)}/trash`, { method: "POST", body: json({ reason }) }),
  restoreShop: (shopId: string, reason: string) => apiRequest<Shop>(`/api/v1/shops/${encodeURIComponent(shopId)}/restore`, { method: "POST", body: json({ reason }) }),
  bulkTrashShops: (shopIds: readonly string[], reason: string) => apiRequest<{ count: number; status: "TRASHED" }>("/api/v1/shops/bulk-trash", { method: "POST", body: json({ shopIds, reason }) }),
  getShopWorkflow: (shopId: string) => apiRequest<ShopWorkflow>(`/api/v1/shops/${encodeURIComponent(shopId)}/workflow`),
  listShopMembers: (shopId: string) => apiRequest<ShopMembership[]>(`/api/v1/shops/${encodeURIComponent(shopId)}/members`),
  inviteShopMember: (shopId: string, phone: string, exportAllowed: boolean) => apiRequest<{ invitationId: string; status: "PENDING" | "ACTIVE"; expiresAt: string }>(`/api/v1/shops/${encodeURIComponent(shopId)}/invitations`, { method: "POST", body: json({ phone: `+86${phone}`, exportAllowed }) }),
  setMemberExport: (membershipId: string, allowed: boolean, reason: string) => apiRequest<ShopMembership>(`/api/v1/shops/memberships/${encodeURIComponent(membershipId)}/export`, { method: "PATCH", body: json({ allowed, reason }) }),
  revokeMember: (membershipId: string, reason: string) => apiRequest<ShopMembership>(`/api/v1/shops/memberships/${encodeURIComponent(membershipId)}/revoke`, { method: "POST", body: json({ reason }) }),
  getFxStatus: async () => normalizeFxStatus(await apiRequest<unknown>("/api/v1/fx/status")),
  getFxHistory: async (query: URLSearchParams) => normalizeFxHistory(await apiRequest<unknown>(`/api/v1/fx/history?${query}`)),
  convertFx: async (input: { from: string; to: string; lines: string[] }) => normalizeFxConversions(await apiRequest<unknown>("/api/v1/fx/convert-batch", { method: "POST", body: json({ rows: input.lines.map((line) => ({ input: line, fromCurrency: input.from.toUpperCase(), toCurrency: input.to.toUpperCase() })) }) })),
  listFxOverrides: async () => normalizeFxOverrideList(await apiRequest<unknown>("/api/v1/admin/fx-overrides")),
  createFxOverride: async (input: FxOverrideInput) => normalizeFxOverrideMutation(await apiRequest<unknown>("/api/v1/admin/fx-overrides", { method: "POST", body: json(input) })),
  reviseFxOverride: async (overrideId: string, input: FxOverrideInput) => normalizeFxOverrideMutation(await apiRequest<unknown>(`/api/v1/admin/fx-overrides/${encodeURIComponent(overrideId)}/revisions`, { method: "POST", body: json(input) })),
  createUploadBatch: async (shopId: string, files: Array<{ relativePath: string; bytes: string; contentType: string; metadataOnly?: boolean }>, period?: { periodStart: string; periodEnd: string }) => {
    if (files.length === 0) {
      const batch = await createUploadBatchRequest<{ id: string }>(json({ shopId, ...period }));
      return { id: batch.id, files: [] };
    }
    return createUploadBatchRequest<{ id: string; files: Array<{ id: string; relativePath: string; offset: string }> }>(json({
        shopId,
        ...period,
        fileCount: files.length,
        files: files.map((file) => ({
          relativePath: file.relativePath,
          declaredSize: file.bytes,
          contentType: file.contentType,
          ...(file.metadataOnly ? { metadataOnly: true } : {}),
        })),
      }));
  },
  uploadChunk: async (fileId: string, offset: string, chunk: Blob) => {
    const bytes = await chunk.arrayBuffer();
    const checksum = await sha256Base64(bytes);
    const headers: Record<string, string> = { "Upload-Offset": offset, "Upload-Checksum": `sha256 ${checksum}`, "Tus-Resumable": "1.0.0", "Content-Type": "application/offset+octet-stream" };
    let body = chunk;
    if (chunk.size >= 64 * 1024 && typeof CompressionStream === "function" && !/(?:^image\/|^audio\/|^video\/|zip|gzip|pdf|officedocument)/iu.test(chunk.type)) {
      try {
        const compressed = await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
        if (compressed.size < chunk.size) {
          body = compressed;
          headers["Upload-Content-Encoding"] = "gzip";
          headers["Upload-Uncompressed-Length"] = String(chunk.size);
        }
      } catch {
        // Compression is only a transport optimization; raw resumable upload remains the compatibility path.
      }
    }
    const response = await apiFetch(`/api/v1/uploads/files/${encodeURIComponent(fileId)}`, { method: "PATCH", headers, body });
    return { offset: response.headers.get("Upload-Offset") ?? "" };
  },
  getUploadOffset: async (fileId: string) => {
    const response = await apiFetch(`/api/v1/uploads/files/${encodeURIComponent(fileId)}`, { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" } });
    return { offset: response.headers.get("Upload-Offset") ?? "" };
  },
  failUploadFile: (fileId: string, reasonCode: "CLIENT_NETWORK_RETRY_EXHAUSTED" | "CLIENT_FILE_READ_FAILED" | "CLIENT_UPLOAD_ABORTED") =>
    apiRequest<void>(`/api/v1/uploads/files/${encodeURIComponent(fileId)}/fail`, { method: "POST", body: json({ reasonCode }) }),
  completeUpload: async (batchId: string) => normalizeUploadCompletion(await apiRequest<unknown>(`/api/v1/uploads/batches/${encodeURIComponent(batchId)}/complete`, { method: "POST" })),
  removeUploadFiles: (batchId: string, fileIds: readonly string[]) => apiRequest<{ removedCount: number; remainingCount: number; cancelled: boolean }>(
    `/api/v1/uploads/batches/${encodeURIComponent(batchId)}/remove-files`,
    { method: "POST", body: json({ fileIds }) },
  ),
  cancelUpload: (batchId: string) => apiRequest<void>(`/api/v1/uploads/batches/${encodeURIComponent(batchId)}/cancel`, { method: "POST" }),
  getImportPreview: (shopId: string, batchId: string) => apiRequest<ImportPreview>(`/api/v1/imports/shops/${encodeURIComponent(shopId)}/batches/${encodeURIComponent(batchId)}`),
  getLatestImportPreview: (shopId: string) => apiRequest<ImportPreview | null>(`/api/v1/imports/shops/${encodeURIComponent(shopId)}/batches/latest`),
  confirmImport: (shopId: string, previewId: string) => apiRequest<{ id: string; status: string }>(`/api/v1/imports/shops/${encodeURIComponent(shopId)}/batches/${encodeURIComponent(previewId)}/confirm`, { method: "POST" }),
  acknowledgeImportIssue: (shopId: string, datasetVersionId: string, reason: string) => apiRequest<{ id: string; status: string }>(
    `/api/v1/imports/shops/${encodeURIComponent(shopId)}/issues/${encodeURIComponent(datasetVersionId)}/acknowledge`,
    { method: "POST", body: json({ reason, confirmations: "2" }) },
  ),
  getCompleteness: (shopId: string, period?: { periodStart?: string; periodEnd?: string }) => {
    const query = new URLSearchParams({ shopId });
    if (period?.periodStart) query.set("periodStart", period.periodStart);
    if (period?.periodEnd) query.set("periodEnd", period.periodEnd);
    return apiRequest<CompletenessSlice[]>(`/api/v1/imports/completeness?${query}`);
  },
  getReport: async (shopId: string, query: URLSearchParams) => {
    try { return await apiRequest<ReportResult>(`/api/v1/reports/shops/${encodeURIComponent(shopId)}/preview?${query}`); }
    catch (error) {
      if (!(error instanceof ApiError) || ![403, 404].includes(error.status)) throw error;
      return apiRequest<ReportResult>(`/api/v1/reports/shops/${encodeURIComponent(shopId)}/current?${query}`);
    }
  },
  getIntermediateReport: (shopId: string, kind: "TRANSACTION" | "SHIPMENT", filters: URLSearchParams, after?: string) => {
    const query = new URLSearchParams(filters); query.set("kind", kind); query.set("limit", "100"); if (after) query.set("after", after);
    return apiRequest<IntermediateReportPage>(`/api/v1/reports/shops/${encodeURIComponent(shopId)}/intermediate?${query}`);
  },
  getIntermediateReportSummary: (shopId: string, kind: "TRANSACTION" | "SHIPMENT", filters: URLSearchParams) => {
    const query = new URLSearchParams(filters); query.set("kind", kind);
    return apiRequest<IntermediateReportSummary>(`/api/v1/reports/shops/${encodeURIComponent(shopId)}/intermediate/summary?${query}`);
  },
  intermediateReportExportUrl: (shopId: string, kind: "TRANSACTION" | "SHIPMENT", filters: URLSearchParams) => {
    const query = new URLSearchParams(filters); query.set("kind", kind);
    return withAppBasePath(`/api/v1/reports/shops/${encodeURIComponent(shopId)}/intermediate/export?${query}`);
  },
  publishReport: (shopId: string, report: ReportResult) => apiRequest<ReportResult>(`/api/v1/reports/shops/${encodeURIComponent(shopId)}/publish`, { method: "POST", body: json({ calculationRunId: report.runId, slices: (report.publishSlices ?? report.completeness).map((slice) => ({ sliceId: slice.sliceId, datasetVersionId: slice.datasetVersionId, disposition: slice.disposition })) }) }),
  listExports: (shopId: string) => apiRequest<ExportJob[]>(`/api/v1/exports?shopId=${encodeURIComponent(shopId)}`),
  previewCostAccounting: (shopId: string, preferences: AccountingPreferences, period?: ReportPeriod) => {
    const query = new URLSearchParams({
      profitRate: preferences.profitRate ?? "",
      minimumSalesCostRate: preferences.minimumSalesCostRate ?? "",
    });
    if (period) {
      query.set("periodStart", period.periodStart);
      query.set("periodEnd", period.periodEnd);
    }
    return apiRequest<CostAccountingPreview>(`/api/v1/shops/${encodeURIComponent(shopId)}/exports/cost-preview?${query}`);
  },
  createExport: (shopId: string, snapshotId: string, preferences?: AccountingPreferences, period?: ReportPeriod) => apiRequest<ExportJob>("/api/v1/exports", { method: "POST", body: json({ shopId, snapshotId, ...preferences, ...period }) }),
  createCurrentExport: (shopId: string, preferences?: AccountingPreferences, period?: ReportPeriod) => apiRequest<ExportJob>(`/api/v1/shops/${encodeURIComponent(shopId)}/exports/current`, { method: "POST", body: json({ ...(preferences ?? {}), ...(period ?? {}) }) }),
  cancelExport: (id: string) => apiRequest<void>(`/api/v1/exports/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  getDownloadUrl: async (id: string) => {
    const result = await apiRequest<{ url: string }>(`/api/v1/exports/${encodeURIComponent(id)}/download-token`, { method: "POST" });
    return { url: withAppBasePath(result.url) };
  },
  getOperationsReadiness: () => apiRequest<{ ready: boolean; checks: Array<{ name: string; status: "ok" | "blocked"; detail: string }> }>("/api/v1/admin/operations/readiness"),
  getOperationsJobs: async () => (await apiRequest<{ items: OperationsJob[] }>("/api/v1/admin/operations/jobs")).items,
  getOperationsOverview: () => apiRequest<OperationsOverview>("/api/v1/admin/operations/status"),
  listWalletEntries: (enterpriseId: string) => apiRequest<WalletEntry[]>(`/api/v1/payments/ledger?enterpriseId=${encodeURIComponent(enterpriseId)}`),
  quoteRecharge: async (enterpriseId: string, amountYuan: string) => {
    const quote = await apiRequest<{ creditAmountCents: string; payableAmountCents: string; discountBasisPoints: "10000" }>("/api/v1/payments/quote", { method: "POST", body: json({ enterpriseId, creditAmountCents: cnyToCents(amountYuan) }) });
    return { creditCents: quote.creditAmountCents, payableCents: quote.payableAmountCents };
  },
  createRecharge: (enterpriseId: string, amountYuan: string) => createRechargeRequest(enterpriseId, cnyToCents(amountYuan)),
  listAdminUsers: (search: string) => apiRequest<AdminUser[]>(`/api/v1/admin/users?search=${encodeURIComponent(search)}`),
  updateAdminUser: (id: string, input: { action: string; reason: string }) => {
    if (input.action === "DISABLE" || input.action === "ENABLE") return apiRequest<void>(`/api/v1/admin/users/${encodeURIComponent(id)}/status`, { method: "PATCH", body: json({ status: input.action === "DISABLE" ? "DISABLED" : "ACTIVE", reason: input.reason }) });
    if (input.action === "GRANT_ADMIN" || input.action === "REVOKE_ADMIN") return apiRequest<void>(`/api/v1/admin/users/${encodeURIComponent(id)}/admin-role`, { method: "PATCH", body: json({ enabled: input.action === "GRANT_ADMIN", reason: input.reason }) });
    throw new Error("不支持的做账员治理操作");
  },
  listAdminWalletEntries: (enterpriseId: string) => apiRequest<WalletEntry[]>(`/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/wallet-ledger`),
  adjustAdminWallet: (enterpriseId: string, deltaCents: string, reason: string) => apiRequest<{ balanceCents: string }>(`/api/v1/admin/enterprises/${encodeURIComponent(enterpriseId)}/wallet-adjustments`, { method: "POST", body: json({ deltaCents, reason }) }),
  listAdminApps: async () => (await apiRequest<Array<{ id: string; name: string; status: "ACTIVE" | "INACTIVE"; sortOrder: number; allowedRoles: Array<"ACCOUNTANT">; currentPrice: { id: string; annualPriceCents: string } | null }>>("/api/v1/apps")).map((app): AdminApp => ({ id: app.id, name: app.name, status: app.status === "ACTIVE" ? "PUBLISHED" : "UNPUBLISHED", sortOrder: app.sortOrder.toString(), annualPriceCents: app.currentPrice?.annualPriceCents ?? "0", priceVersion: app.currentPrice?.id ?? "尚无价格", allowedRoles: app.allowedRoles })),
  updateAdminApp: async (app: AdminApp, input: { action: string; annualPriceYuan?: string; reason: string; allowedRoles?: Array<"ACCOUNTANT"> }) => {
    if (input.action === "NEW_PRICE") {
      if (!input.annualPriceYuan) throw new Error("请输入新年度价格");
      await apiRequest(`/api/v1/apps/${encodeURIComponent(app.id)}/prices`, { method: "POST", body: json({ annualPriceCents: cnyToCents(input.annualPriceYuan), reason: input.reason }) });
      return;
    }
    await apiRequest(`/api/v1/apps/${encodeURIComponent(app.id)}`, { method: "PATCH", body: json({ name: app.name, status: input.action === "PUBLISH" ? "ACTIVE" : input.action === "UNPUBLISH" ? "INACTIVE" : app.status === "PUBLISHED" ? "ACTIVE" : "INACTIVE", sortOrder: Number(app.sortOrder), allowedRoles: input.allowedRoles ?? app.allowedRoles, reason: input.reason }) });
  },
};
