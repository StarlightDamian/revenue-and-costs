export type SnapshotSliceDisposition = "INCLUDED" | "INCLUDED_WITH_WARNING" | "HARD_EXCLUDED";

export interface CalculationRunSlice {
  readonly sliceId: string;
  readonly datasetVersionId: string;
  readonly hardReasons: readonly string[];
  readonly softWarning: boolean;
  readonly hardExclusionAcknowledgementId?: string;
  readonly softWarningAcknowledgementId?: string;
}

export interface CalculationRunForPublishing {
  readonly id: string;
  readonly shopId: string;
  readonly status: "READY" | "BLOCKED" | "FAILED" | "RUNNING" | "QUEUED";
  readonly applicationPriceVersionId: string;
  readonly mappingVersionIds: readonly string[];
  readonly marketplacePolicyVersionId: string;
  readonly timezonePolicyVersion: string;
  readonly formulaVersion: string;
  readonly codeVersion: string;
  readonly slices: readonly CalculationRunSlice[];
}

export interface SnapshotSliceInput {
  readonly sliceId: string;
  readonly datasetVersionId: string;
  readonly disposition: SnapshotSliceDisposition;
}

export interface SnapshotManifest {
  readonly calculationRunId: string;
  readonly shopId: string;
  readonly slices: readonly SnapshotSliceInput[];
}

export interface PublishStore {
  inTransaction<T>(work: (transaction: PublishTransaction) => Promise<T>): Promise<T>;
}

export interface PublishTransaction {
  lockShop(shopId: string): Promise<void>;
  getCalculationRun(runId: string): Promise<CalculationRunForPublishing | undefined>;
  getCurrentSliceVersions(shopId: string): Promise<ReadonlyMap<string, string>>;
  createSnapshot(input: {
    shopId: string;
    calculationRunId: string;
    actorAccountId: string;
    manifest: SnapshotManifest;
  }): Promise<string>;
  createSnapshotSlices(snapshotId: string, slices: readonly SnapshotSliceInput[]): Promise<void>;
  setCurrentSnapshot(shopId: string, snapshotId: string): Promise<void>;
  appendAudit(input: { actorAccountId: string; action: string; objectId: string }): Promise<void>;
}

function validateManifest(run: CalculationRunForPublishing, manifest: SnapshotManifest, current: ReadonlyMap<string, string>): void {
  if (run.status !== "READY") throw new Error("CALCULATION_RUN_NOT_READY");
  if (run.shopId !== manifest.shopId || run.id !== manifest.calculationRunId) throw new Error("PUBLISH_MANIFEST_MISMATCH");
  if (manifest.slices.length !== current.size || manifest.slices.length !== run.slices.length) {
    throw new Error("PUBLISH_MANIFEST_NOT_FULL_SHOP");
  }
  if (new Set(run.slices.map((slice) => slice.sliceId)).size !== run.slices.length) {
    throw new Error("DUPLICATE_CALCULATION_RUN_SLICE");
  }
  const manifestIds = new Set<string>();
  for (const slice of manifest.slices) {
    if (manifestIds.has(slice.sliceId)) throw new Error("DUPLICATE_PUBLISHED_SLICE");
    manifestIds.add(slice.sliceId);
    const currentVersion = current.get(slice.sliceId);
    const runSlice = run.slices.find((candidate) => candidate.sliceId === slice.sliceId);
    if (!currentVersion || !runSlice) throw new Error("PUBLISHED_SLICE_NOT_CURRENT");
    if (currentVersion !== slice.datasetVersionId || runSlice.datasetVersionId !== slice.datasetVersionId) {
      throw new Error("PUBLISHED_DATASET_VERSION_STALE");
    }

    if (slice.disposition === "HARD_EXCLUDED") {
      if (runSlice.hardReasons.length === 0 || !runSlice.hardExclusionAcknowledgementId) {
        throw new Error("HARD_EXCLUSION_NOT_ACKNOWLEDGED");
      }
    } else {
      if (runSlice.hardReasons.length > 0) throw new Error("HARD_INCOMPLETE_SLICE_INCLUDED");
      if (runSlice.softWarning) {
        if (slice.disposition !== "INCLUDED_WITH_WARNING" || !runSlice.softWarningAcknowledgementId) {
          throw new Error("SOFT_WARNING_NOT_DISCLOSED");
        }
      } else if (slice.disposition !== "INCLUDED") {
        throw new Error("INVALID_SLICE_DISPOSITION");
      }
    }
  }
}

export async function publishSnapshot(
  store: PublishStore,
  input: { readonly actorAccountId: string; readonly manifest: SnapshotManifest },
): Promise<string> {
  return store.inTransaction(async (transaction) => {
    await transaction.lockShop(input.manifest.shopId);
    const run = await transaction.getCalculationRun(input.manifest.calculationRunId);
    if (!run) throw new Error("CALCULATION_RUN_NOT_FOUND");
    const current = await transaction.getCurrentSliceVersions(input.manifest.shopId);
    validateManifest(run, input.manifest, current);

    const snapshotId = await transaction.createSnapshot({
      shopId: input.manifest.shopId,
      calculationRunId: run.id,
      actorAccountId: input.actorAccountId,
      manifest: input.manifest,
    });
    await transaction.createSnapshotSlices(snapshotId, input.manifest.slices);
    // Pointer replacement is deliberately last. A transaction failure leaves the previous pointer intact.
    await transaction.setCurrentSnapshot(run.shopId, snapshotId);
    await transaction.appendAudit({
      actorAccountId: input.actorAccountId,
      action: "PUBLISHED_SNAPSHOT_CREATED",
      objectId: snapshotId,
    });
    return snapshotId;
  });
}
