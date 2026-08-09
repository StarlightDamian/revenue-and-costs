import { describe, expect, it } from "vitest";
import { publishSnapshot, type PublishStore, type PublishTransaction } from "../../src/modules/publishing";

function store(options?: { failSliceInsert?: boolean; currentVersion?: string; sliceCount?: number }): {
  store: PublishStore;
  state: { current: string; snapshots: string[] };
  calls: { sliceWrites: number };
} {
  const state = { current: "snapshot-old", snapshots: [] as string[] };
  const calls = { sliceWrites: 0 };
  const slices = Array.from({ length: options?.sliceCount ?? 1 }, (_, index) => ({
    sliceId: `slice-${index + 1}`,
    datasetVersionId: `version-${index + 1}`,
    hardReasons: [],
    softWarning: false,
  }));
  const tx: PublishTransaction = {
    lockShop: async () => undefined,
    getCalculationRun: async () => ({
      id: "run-1", shopId: "shop-1", status: "READY", applicationPriceVersionId: "price-1",
      mappingVersionIds: ["map-1"], marketplacePolicyVersionId: "policy-1", timezonePolicyVersion: "tz-1",
      formulaVersion: "formula-1", codeVersion: "code-1",
      slices,
    }),
    getCurrentSliceVersions: async () => new Map(slices.map((slice, index) => [slice.sliceId, index === 0 ? options?.currentVersion ?? slice.datasetVersionId : slice.datasetVersionId])),
    createSnapshot: async () => { state.snapshots.push("snapshot-new"); return "snapshot-new"; },
    createSnapshotSlices: async () => { calls.sliceWrites += 1; if (options?.failSliceInsert) throw new Error("INJECTED_FAILURE"); },
    setCurrentSnapshot: async (_shop, snapshot) => { state.current = snapshot; },
    appendAudit: async () => undefined,
  };
  return {
    state,
    calls,
    store: {
      inTransaction: async (work) => {
        const before = structuredClone(state);
        try { return await work(tx); }
        catch (error) { state.current = before.current; state.snapshots = before.snapshots; throw error; }
      },
    },
  };
}

const manifest = {
  calculationRunId: "run-1",
  shopId: "shop-1",
  slices: [{ sliceId: "slice-1", datasetVersionId: "version-1", disposition: "INCLUDED" as const }],
};

describe("显式发布", () => {
  it("发布全店铺 manifest 后才切换当前指针", async () => {
    const fixture = store();
    await expect(publishSnapshot(fixture.store, { actorAccountId: "owner-1", manifest })).resolves.toBe("snapshot-new");
    expect(fixture.state.current).toBe("snapshot-new");
  });

  it("数据版本已变化时拒绝发布，旧快照保持当前", async () => {
    const fixture = store({ currentVersion: "version-2" });
    await expect(publishSnapshot(fixture.store, { actorAccountId: "owner-1", manifest })).rejects.toThrow("PUBLISHED_DATASET_VERSION_STALE");
    expect(fixture.state.current).toBe("snapshot-old");
  });

  it("快照切片写入失败时事务回滚，旧指针和旧内容不变", async () => {
    const fixture = store({ failSliceInsert: true });
    await expect(publishSnapshot(fixture.store, { actorAccountId: "owner-1", manifest })).rejects.toThrow("INJECTED_FAILURE");
    expect(fixture.state).toEqual({ current: "snapshot-old", snapshots: [] });
  });

  it("一次写入全部快照切片后才切换当前指针", async () => {
    const fixture = store({ sliceCount: 40 });
    const slices = Array.from({ length: 40 }, (_, index) => ({
      sliceId: `slice-${index + 1}`,
      datasetVersionId: `version-${index + 1}`,
      disposition: "INCLUDED" as const,
    }));

    await publishSnapshot(fixture.store, {
      actorAccountId: "owner-1",
      manifest: { calculationRunId: "run-1", shopId: "shop-1", slices },
    });

    expect(fixture.calls.sliceWrites).toBe(1);
    expect(fixture.state.current).toBe("snapshot-new");
  });
});
