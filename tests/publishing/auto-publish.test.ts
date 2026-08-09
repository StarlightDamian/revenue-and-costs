import { describe, expect, it, vi } from "vitest";
import { insertCalculationRunSlices, PostgresReportService } from "../../src/modules/publishing/postgres-service.js";

describe("calculation run slice persistence", () => {
  it("persists every resolved slice with one set-based query", async () => {
    const query = vi.fn(async (...args: [sql: string, parameters?: readonly unknown[]]) => {
      void args;
      return { rows: [], rowCount: 40 };
    });
    const slices = Array.from({ length: 40 }, (_, index) => ({
      sliceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      versionId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      disposition: "INCLUDED" as const,
      mappings: [],
      hardReasonCodes: [],
      hardAcknowledgementId: null,
      softAcknowledgementId: null,
    }));

    await insertCalculationRunSlices({ query } as never, "20000000-0000-4000-8000-000000000001", slices);

    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[0]).toContain("jsonb_to_recordset");
    expect(JSON.parse(String(query.mock.calls[0]?.[1]?.[1]))).toHaveLength(40);
  });
});

describe("calculation rule versioning", () => {
  it("includes the next-business-day FX rule in the immutable run manifest", async () => {
    const calls: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const client = {
      async query(sql: string, parameters?: readonly unknown[]) {
        calls.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.includes("FROM dataset_slice ds")) return { rows: [{
          slice_id: "slice-1", version_id: "version-1", status: "COMPLETE", mappings: [], warning: false,
          hard_ack: null, soft_ack: null, normalized_marketplace: "US", policy_id: "policy-1", iana_timezone: "America/Los_Angeles",
        }] };
        if (sql.includes("price_id") && sql.includes("fx_sync_run_id")) return { rows: [{ price_id: "price-1", fx_sync_run_id: "fx-sync-1" }] };
        if (sql.includes("INSERT INTO calculation_run(")) return { rows: [{ id: "run-1", status: "QUEUED" }] };
        return { rows: [], rowCount: 1 };
      },
    };
    const reports = new PostgresReportService(
      { transaction: async (work: (transactionClient: typeof client) => Promise<unknown>) => work(client) } as never,
      { query: vi.fn() } as never,
    );

    await expect(reports.requestCalculation("shop-1", {
      actorAccountId: "actor-1",
      idempotencyKey: "fx-rule-v2",
    })).resolves.toMatchObject({ runId: "run-1" });

    const insert = calls.find(({ sql }) => sql.includes("INSERT INTO calculation_run("));
    expect(insert?.parameters?.slice(4, 6)).toEqual(["revenue-cost-v2", "local-v4"]);
    expect(JSON.parse(String(insert?.parameters?.[6]))).toMatchObject({
      formulaVersion: "revenue-cost-v2",
      codeVersion: "local-v4",
      fxDateRuleVersion: "next-business-day-v2",
    });
  });
});

describe("import-triggered automatic publishing", () => {
  it("stops before creating a calculation when a hard-incomplete slice was not confirmed", async () => {
    const queries: string[] = [];
    const client = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("FROM dataset_slice")) {
          return { rows: [{
            slice_id: "slice-1", version_id: "version-1", status: "INCOMPLETE", mappings: [], warning: false,
            hard_ack: null, soft_ack: null, normalized_marketplace: "US", policy_id: "policy-1", iana_timezone: "America/Los_Angeles",
          }] };
        }
        return { rows: [{ id: "shop-1" }] };
      },
    };
    const transactions = { transaction: vi.fn(async (work: (tx: typeof client) => Promise<unknown>) => work(client)) };
    const reports = new PostgresReportService(transactions as never, { query: vi.fn() } as never);

    await expect(reports.requestCalculation("shop-1", {
      actorAccountId: "actor-1",
      idempotencyKey: "auto-batch-1",
      sourceImportBatchId: "batch-1",
      autoPublish: true,
    })).rejects.toThrow("HARD_INCOMPLETE_CONFIRMATION_REQUIRED");
    expect(queries.some((sql) => sql.includes("INSERT INTO calculation_run"))).toBe(false);
  });

  it("publishes the immutable run manifest and advances the import batch", async () => {
    const queries: Array<{ sql: string; parameters?: readonly unknown[] }> = [];
    const database = {
      async query(sql: string, parameters?: readonly unknown[]) {
        queries.push({ sql, ...(parameters ? { parameters } : {}) });
        if (sql.startsWith("SELECT shop_id,input_manifest")) {
          return { rows: [{ shop_id: "shop-1", input_manifest: { autoPublish: true, sourceImportBatchId: "batch-1" } }] };
        }
        if (sql.includes("AS authorized")) return { rows: [{ authorized: true }] };
        if (sql.includes("FROM calculation_run_slice")) {
          return { rows: [{ slice_id: "slice-1", dataset_version_id: "version-1", disposition: "INCLUDED" }] };
        }
        return { rows: [], rowCount: 1 };
      },
    };
    const reports = new PostgresReportService({ transaction: vi.fn() } as never, database as never);
    const publish = vi.spyOn(reports, "publish").mockResolvedValue({ snapshotId: "snapshot-1" } as never);

    await expect(reports.autoPublishCalculation("run-1", "actor-1", "batch-1")).resolves.toMatchObject({ snapshotId: "snapshot-1" });

    expect(publish).toHaveBeenCalledWith({
      calculationRunId: "run-1",
      shopId: "shop-1",
      slices: [{ sliceId: "slice-1", datasetVersionId: "version-1", disposition: "INCLUDED" }],
    }, { actorAccountId: "actor-1", idempotencyKey: "auto-import:batch-1" });
    expect(queries.filter((query) => query.sql.includes("UPDATE import_batch")).map((query) => query.sql)).toEqual([
      expect.stringContaining("status='RESULT_PUBLISHING'"),
    ]);
  });

  it("rejects a job whose batch does not match the fixed calculation input", async () => {
    const database = {
      async query() {
        return { rows: [{ shop_id: "shop-1", input_manifest: { autoPublish: true, sourceImportBatchId: "batch-other" } }] };
      },
    };
    const reports = new PostgresReportService({ transaction: vi.fn() } as never, database as never);

    await expect(reports.autoPublishCalculation("run-1", "actor-1", "batch-1")).rejects.toThrow("AUTO_PUBLISH_RUN_MISMATCH");
  });

  it("rechecks owner or administrator authority before exposing a new snapshot", async () => {
    const database = {
      async query(sql: string) {
        if (sql.startsWith("SELECT shop_id,input_manifest")) {
          return { rows: [{ shop_id: "shop-1", input_manifest: { autoPublish: true, sourceImportBatchId: "batch-1" } }] };
        }
        return { rows: [{ authorized: false }] };
      },
    };
    const reports = new PostgresReportService({ transaction: vi.fn() } as never, database as never);

    await expect(reports.autoPublishCalculation("run-1", "actor-1", "batch-1")).rejects.toThrow("AUTO_PUBLISH_ACTOR_NOT_AUTHORIZED");
  });
});
