import Fastify from "fastify";

const app = Fastify({ logger: false });
const enterpriseId = "01000000-0000-4000-8000-000000000001";
const walletId = "02000000-0000-4000-8000-000000000001";
const shopId = "10000000-0000-4000-8000-000000000001";
const sharedShopId = "10000000-0000-4000-8000-000000000002";
const snapshotId = "20000000-0000-4000-8000-000000000001";
const runId = "30000000-0000-4000-8000-000000000001";
const sliceUs = "40000000-0000-4000-8000-000000000001";
const sliceJp = "40000000-0000-4000-8000-000000000002";

const me = {
  id: "50000000-0000-4000-8000-000000000001",
  phoneMasked: "138****0000",
  displayName: "浏览器验收做账员",
  avatarId: 24,
  roles: ["ACCOUNTANT"],
  theme: "comfort",
  customerShopCount: 1,
};

const enterprise = {
  id: enterpriseId,
  name: "浏览器验收企业",
  unifiedSocialCreditCode: "91310110MA1G5X1R2X",
  profileComplete: true,
  memberCount: 1,
  companyCount: 1,
  notStartedCount: 0,
  submittedCount: 1,
  wallet: { id: walletId, balanceCents: "298000", status: "ACTIVE" },
};

const ownCompany = {
  id: shopId, enterpriseId, createdByAccountId: me.id, lastOperatedByAccountId: me.id,
  createdByDisplayName: me.displayName, lastOperatedByDisplayName: me.displayName,
  name: "Northwind US & JP", access: "ENTERPRISE", accountingStatus: "SUBMITTED",
  status: "ACTIVE", termStart: "2026-01-01", termEndExclusive: "2027-01-01", renameAvailable: true,
  publishedSnapshot: { id: snapshotId, publishedAt: "2026-07-28T02:20:04.000Z", stale: false },
};
const sharedCompany = {
  ...ownCompany, id: sharedShopId, name: "客户授权公司", access: "CUSTOMER", customerExportAllowed: false,
  accountingStatus: "SUBMITTED", termStart: "2026-03-01", termEndExclusive: "2027-03-01", renameAvailable: false,
};

const completeness = [
  { sliceId: sliceUs, datasetVersionId: "60000000-0000-4000-8000-000000000001", disposition: "INCLUDED", marketplace: "Amazon.com", month: "2026-05", state: "COMPLETE", transactionQuantity: "1280", shipmentQuantity: "1280", unmatchedAbsolute: "0", unmatchedRatio: "0.00000000" },
  { sliceId: sliceJp, datasetVersionId: "60000000-0000-4000-8000-000000000002", disposition: "INCLUDED_WITH_WARNING", marketplace: "Amazon.co.jp", month: "2026-05", state: "PUBLISHED_WARNING", transactionQuantity: "806", shipmentQuantity: "803", unmatchedAbsolute: "3", unmatchedRatio: "0.00372208", note: "数量存在非零差异，已自动纳入并持续披露" },
  { marketplace: "Amazon.com", month: "2026-06", state: "MISSING_SHIPMENT", transactionQuantity: "942", note: "硬不完整，不进入正式汇总" },
];

const report = {
  shopId, mode: "PUBLISHED", runId, snapshotId, calculatedAt: "2026-07-28T02:16:22.000Z", publishedAt: "2026-07-28T02:20:04.000Z",
  dataVersion: "dataset-manifest-20260728", mappingVersion: "mapping-v3", timezoneVersion: "iana-tzdb-2026a", policyVersion: "marketplace-policy-v2", formulaVersion: "revenue-cost-v1", fxVersion: "fx-sync-20260728",
  metrics: [
    { key: "income", amountCny: "869234.56000000" }, { key: "refund", amountCny: "-43821.33000000" },
    { key: "withheldTax", amountCny: "-7204.88000000" }, { key: "platformFee", amountCny: "-129438.12000000" },
    { key: "fbaDelivery", amountCny: "-84712.95000000" }, { key: "advertising", amountCny: "-56320.18000000" },
    { key: "storage", amountCny: "-18204.50000000" }, { key: "other", amountCny: "-12406.77000000" },
    { key: "balance", amountCny: "517125.84000000" },
  ],
  completeness,
  fees: [
    { category: "PLATFORM_FEE", marketplace: "Amazon.com", month: "2026-05", sourceRows: "1280", amountCny: "-82610.17000000" },
    { category: "FBA_FULFILLMENT_FEE", marketplace: "Amazon.co.jp", month: "2026-05", sourceRows: "803", amountCny: "-31788.92000000" },
  ],
  notices: ["Amazon.co.jp 2026-05 已带软警告发布；数量差异仍在快照和导出中披露。"], canPublish: false,
};

function reportFor(query: { start?: string; end?: string; marketplace?: string }) {
  const startMonth = query.start?.slice(0, 7);
  const endMonth = query.end?.slice(0, 7);
  const marketplace = query.marketplace?.trim().toLowerCase();
  const visible = (row: { marketplace: string; month: string }) =>
    (!startMonth || row.month >= startMonth)
    && (!endMonth || row.month <= endMonth)
    && (!marketplace || row.marketplace.toLowerCase() === marketplace);
  return {
    ...report,
    completeness: report.completeness.filter(visible),
    fees: report.fees.filter(visible),
  };
}

app.get("/health/live", async () => ({ status: "ok", service: "acceptance-api" }));
app.get("/api/v1/me", async (_request, reply) => process.env.ACCEPTANCE_ANONYMOUS === "true" ? reply.code(401).send({ code: "AUTH_REQUIRED", message: "请先登录" }) : me);
app.patch("/api/v1/me/theme", async (request) => ({ ...me, theme: (request.body as { themeId?: string })?.themeId ?? me.theme }));
app.patch("/api/v1/me/avatar", async (request) => ({ ...me, avatarId: (request.body as { avatarId?: number })?.avatarId ?? me.avatarId }));
app.post("/api/v1/auth/logout", async (_request, reply) => reply.code(204).send());
app.get("/api/v1/enterprises", async () => [enterprise]);
app.get("/api/v1/enterprises/:enterpriseId/members", async () => [{
  id: "03000000-0000-4000-8000-000000000001", accountId: me.id, displayName: me.displayName,
  phoneMasked: me.phoneMasked, avatarId: me.avatarId, status: "ACTIVE", createdAt: "2026-07-28T01:00:00.000Z",
}]);
app.get<{ Querystring: { enterpriseId?: string } }>("/api/v1/shops", async (request) =>
  request.query.enterpriseId ? [ownCompany] : [ownCompany, sharedCompany]);
app.get("/api/v1/apps", async () => [{
  id: "70000000-0000-4000-8000-000000000001",
  code: "amazon-sales-cost",
  name: "亚马逊销售成本",
  status: "ACTIVE",
  sortOrder: 10,
  allowedRoles: ["ACCOUNTANT"],
  currentPrice: {
    id: "71000000-0000-4000-8000-000000000001",
    annualPriceCents: "18800",
  },
}]);
app.get("/api/v1/fx/status", async () => ({ id: "fx-run-1", syncKind: "DAILY", status: "SUCCEEDED", syncEnabled: true, quoteCount: 2, coverageFrom: "2025-01-01", coverageTo: "2026-07-28", startedAt: "2026-07-28T02:00:00.000Z", lastSucceededAt: "2026-07-28T02:00:12.000Z", errorCode: null }));
app.get("/api/v1/fx/history", async () => ({ rows: [
  { id: "quote-usd-1", validDate: "2026-07-28", currency: "USD", cnyPerUnit: "7.16880000", officialPair: "USD/CNY", officialRate: "7.16880000" },
  { id: "quote-jpy-1", validDate: "2026-07-28", currency: "JPY", cnyPerUnit: "0.04778100", officialPair: "100JPY/CNY", officialRate: "4.77810000" },
] }));
app.post("/api/v1/fx/convert-batch", async (request) => ({ rows: ((request.body as { rows: Array<{ input: string; fromCurrency: string; toCurrency: string }> }).rows).map((row) => ({ input: row.input, requestedDate: row.input, hitDate: row.input, fromCurrency: row.fromCurrency, toCurrency: row.toCurrency, rate: "7.16880000", fallbackDays: "0", status: /^\d{4}-\d{2}-\d{2}$/.test(row.input) ? "OK" : "INVALID_DATE", quoteIds: ["quote-usd-1"], overrideIds: [], ...(/^\d{4}-\d{2}-\d{2}$/.test(row.input) ? {} : { reason: "日期格式无效" }) })) }));
app.get("/api/v1/imports/completeness", async () => completeness);
app.get<{ Querystring: { start?: string; end?: string; marketplace?: string } }>("/api/v1/reports/shops/:shopId/preview", async (request) => reportFor(request.query));
app.get<{ Querystring: { start?: string; end?: string; marketplace?: string } }>("/api/v1/reports/shops/:shopId/current", async (request) => reportFor(request.query));
app.get("/api/v1/exports", async () => [
  { id: "80000000-0000-4000-8000-000000000001", shopId, snapshotId, status: "SUCCEEDED", progress: "100", format: "XLSX", isCurrentFormat: true, createdAt: "2026-07-28T02:24:00.000Z" },
  { id: "80000000-0000-4000-8000-000000000002", shopId, snapshotId, status: "RUNNING", progress: "64", format: "ZIP", isCurrentFormat: true, createdAt: "2026-07-28T02:26:00.000Z" },
]);
app.get("/api/v1/payments/ledger", async () => [{ id: "90000000-0000-4000-8000-000000000001", type: "RECHARGE", amountCents: "316800", balanceAfterCents: "316800", occurredAt: "2026-07-01T03:00:00.000Z", reason: "沙箱充值" }, { id: "90000000-0000-4000-8000-000000000002", type: "APP_SUBSCRIPTION", amountCents: "-18800", balanceAfterCents: "298000", occurredAt: "2026-07-02T03:00:00.000Z", reason: "Amazon 应用 1 年" }]);
app.get("/api/v1/admin/users", async () => [{ id: me.id, displayName: me.displayName, avatarId: me.avatarId, phoneMasked: me.phoneMasked, roles: me.roles, status: "ACTIVE", enterpriseCount: 1, companyCount: 2 }]);

const port = Number(process.env.ACCEPTANCE_API_PORT ?? "3000");
await app.listen({ host: "127.0.0.1", port });
process.stdout.write(`acceptance-api listening on http://127.0.0.1:${port}\n`);

async function close() { await app.close(); process.exit(0); }
process.once("SIGINT", close);
process.once("SIGTERM", close);
