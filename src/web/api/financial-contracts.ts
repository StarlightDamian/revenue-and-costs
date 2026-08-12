import type { FxConversionRow, FxOverride, FxQuote, FxStatus, UploadCompletion } from "./types";

type JsonObject = Record<string, unknown>;

function object(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}接口返回格式无效`);
  return value as JsonObject;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label}接口返回格式无效`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function fxOverride(value: unknown): FxOverride {
  const row = object(value, "人工汇率");
  const supersedesOverrideId = row.supersedesOverrideId === null
    ? null
    : string(row.supersedesOverrideId, "人工汇率");
  if (typeof row.isCurrent !== "boolean") throw new Error("人工汇率接口返回格式无效");
  return {
    id: string(row.id, "人工汇率"),
    currency: string(row.currency, "人工汇率"),
    validFrom: string(row.validFrom, "人工汇率"),
    validTo: string(row.validTo, "人工汇率"),
    cnyPerUnit: string(row.cnyPerUnit, "人工汇率"),
    sourceReference: string(row.sourceReference, "人工汇率"),
    reason: string(row.reason, "人工汇率"),
    createdAt: string(row.createdAt, "人工汇率"),
    supersedesOverrideId,
    isCurrent: row.isCurrent,
  };
}

export function normalizeFxStatus(payload: unknown): FxStatus {
  const row = object(payload, "汇率状态");
  const rawStatus = string(row.status, "汇率状态");
  const taskStatus: FxStatus["taskStatus"] = rawStatus === "NEVER_SYNCED" ? "IDLE"
    : rawStatus === "RUNNING" || rawStatus === "STARTED" ? "RUNNING"
      : rawStatus === "QUEUED" ? "QUEUED"
        : rawStatus === "SUCCEEDED" ? "SUCCEEDED" : "FAILED";
  const coverageStart = optionalString(row.coverageFrom);
  const coverageEnd = optionalString(row.coverageTo);
  const lastSucceededAt = rawStatus === "SUCCEEDED" ? optionalString(row.finishedAt) : undefined;
  const persistedSucceededAt = optionalString(row.lastSucceededAt) ?? lastSucceededAt;
  const quoteCount = typeof row.quoteCount === "number" && Number.isSafeInteger(row.quoteCount) && row.quoteCount >= 0 ? row.quoteCount : 0;
  return {
    source: "ChinaMoney",
    syncEnabled: row.syncEnabled === true,
    quoteCount,
    ...(coverageStart ? { coverageStart } : {}),
    ...(coverageEnd ? { coverageEnd } : {}),
    ...(persistedSucceededAt ? { lastSucceededAt: persistedSucceededAt } : {}),
    taskStatus,
    gaps: [],
  };
}

export function normalizeFxHistory(payload: unknown): FxQuote[] {
  const wrapper = object(payload, "历史汇率");
  if (!Array.isArray(wrapper.rows)) throw new Error("历史汇率接口返回格式无效");
  return wrapper.rows.map((value) => {
    const row = object(value, "历史汇率");
    return {
      date: string(row.validDate, "历史汇率"),
      currency: string(row.currency, "历史汇率"),
      cnyPerUnit: string(row.cnyPerUnit, "历史汇率"),
      officialPair: string(row.officialPair, "历史汇率"),
      officialRate: string(row.officialRate, "历史汇率"),
      quoteId: string(row.id, "历史汇率"),
      source: "OFFICIAL",
    };
  });
}

export function normalizeFxOverrideList(payload: unknown): FxOverride[] {
  const wrapper = object(payload, "人工汇率");
  if (!Array.isArray(wrapper.rows)) throw new Error("人工汇率接口返回格式无效");
  return wrapper.rows.map(fxOverride);
}

export function normalizeFxOverrideMutation(payload: unknown): FxOverride {
  return fxOverride(object(payload, "人工汇率").override);
}

export function normalizeFxConversions(payload: unknown): FxConversionRow[] {
  const wrapper = object(payload, "批量换算");
  if (!Array.isArray(wrapper.rows)) throw new Error("批量换算接口返回格式无效");
  return wrapper.rows.map((value) => {
    const row = object(value, "批量换算");
    const rawStatus = string(row.status, "批量换算");
    const fallback = optionalString(row.fallbackDays);
    const status: FxConversionRow["status"] = rawStatus === "OK" || rawStatus === "INVALID_DATE"
      ? rawStatus
      : rawStatus === "NO_AVAILABLE_QUOTE" ? "NO_RATE" : "SOURCE_GAP";
    const inputDate = optionalString(row.requestedDate);
    const quoteDate = optionalString(row.hitDate);
    const rate = optionalString(row.rate);
    const reason = optionalString(row.reason);
    return {
      input: string(row.input, "批量换算"),
      ...(inputDate ? { inputDate } : {}),
      ...(quoteDate ? { quoteDate } : {}),
      from: string(row.fromCurrency, "批量换算"),
      to: string(row.toCurrency, "批量换算"),
      ...(rate ? { rate } : {}),
      ...(fallback && /^\d+$/.test(fallback) ? { fallbackDays: Number(fallback) } : {}),
      status,
      ...(reason ? { reason } : {}),
    };
  });
}

export function normalizeUploadCompletion(payload: unknown): UploadCompletion {
  const row = object(payload, "上传完成");
  return { id: string(row.id, "上传完成"), status: string(row.status, "上传完成") };
}
