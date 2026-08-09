import type { ReportKind } from "../mappings/types.js";
import { Temporal } from "@js-temporal/polyfill";

export type DatasetVersionStatus = "INCOMPLETE" | "READY";

export interface DatasetSourceBinding {
  readonly reportKind: ReportKind;
  readonly importFileIds: readonly string[];
  readonly mappingVersionId: string;
  readonly carriedForwardFromVersionId?: string;
  readonly coverageStart: string;
  readonly coverageEnd: string;
}

export interface DatasetVersionManifest {
  readonly id: string;
  readonly sliceId: string;
  readonly shopId: string;
  readonly marketplace: string;
  readonly localMonth: string;
  readonly status: DatasetVersionStatus;
  readonly sources: readonly DatasetSourceBinding[];
}

export function createDatasetVersionManifest(
  input: Omit<DatasetVersionManifest, "status">,
): Readonly<DatasetVersionManifest> {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(input.localMonth)) throw new Error("INVALID_LOCAL_MONTH");
  if (!input.marketplace.trim()) throw new Error("MARKETPLACE_REQUIRED");
  const kinds = new Set(input.sources.map((source) => source.reportKind));
  if (kinds.size !== input.sources.length) throw new Error("DUPLICATE_SOURCE_BINDING");
  const monthStart = Temporal.PlainDate.from(`${input.localMonth}-01`);
  const monthEnd = monthStart.add({ months: 1 }).subtract({ days: 1 }).toString();
  for (const source of input.sources) {
    if (source.importFileIds.length === 0) throw new Error(`SOURCE_FILE_REQUIRED:${source.reportKind}`);
    if (new Set(source.importFileIds).size !== source.importFileIds.length) {
      throw new Error(`DUPLICATE_SOURCE_FILE:${source.reportKind}`);
    }
    if (source.coverageStart > source.coverageEnd) throw new Error(`INVALID_COVERAGE:${source.reportKind}`);
    if (source.coverageStart > monthStart.toString() || source.coverageEnd < monthEnd) {
      throw new Error(`SOURCE_DOES_NOT_COVER_LOCAL_MONTH:${source.reportKind}`);
    }
  }
  const status: DatasetVersionStatus = kinds.has("SHIPMENT") && kinds.has("TRANSACTION") ? "READY" : "INCOMPLETE";
  return Object.freeze({
    ...input,
    status,
    sources: Object.freeze(input.sources.map((source) => Object.freeze({
      ...source,
      importFileIds: Object.freeze([...source.importFileIds]),
    }))),
  });
}
