import { describe, expect, it, vi } from "vitest";
import { REPORT_EXPORT_FORMAT } from "../../src/modules/exports/export-report.js";
import { PostgresExportService } from "../../src/modules/exports/postgres.js";
import type { Actor } from "../../src/modules/authorization/index.js";

const actor: Actor = { accountId: "account-1", status: "ACTIVE", roles: new Set(["ACCOUNTANT"]), enterpriseIds: new Set(["enterprise-1"]) };
const assumptions = { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] } as const;

describe("current published snapshot export", () => {
  it("resolves the server-side current pointer before creating an export", async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }] })
      .mockResolvedValueOnce({ rows: [{ published_snapshot_id: "snapshot-1" }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const service = new PostgresExportService(pool as never, {} as never, ".work/exports");
    const create = vi.spyOn(service, "create").mockResolvedValue({ id: "export-1", status: "QUEUED" } as never);

    await expect(service.createCurrent(actor, "shop-1", "key-1", "request-1", assumptions)).resolves.toMatchObject({ id: "export-1" });
    expect(create).toHaveBeenCalledWith(actor, "shop-1", "snapshot-1", "key-1", "request-1", assumptions);
  });

  it("returns a stable error when the shop has no published snapshot", async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }] })
      .mockResolvedValueOnce({ rows: [] }) };
    const service = new PostgresExportService(pool as never, {} as never, ".work/exports");

    await expect(service.createCurrent(actor, "shop-1", "key-1", "request-1", assumptions))
      .rejects.toMatchObject({ code: "PUBLISHED_SNAPSHOT_NOT_FOUND", statusCode: 409 });
  });

  it("reuses an unexpired successful export for the current snapshot", async () => {
    const createdAt = new Date("2026-07-28T00:00:00.000Z");
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }] })
      .mockResolvedValueOnce({ rows: [{ published_snapshot_id: "snapshot-1" }] })
      .mockResolvedValueOnce({ rows: [{
        id: "export-1", shop_id: "shop-1", published_snapshot_id: "snapshot-1",
        status: "SUCCEEDED", output_kind: "XLSX", created_at: createdAt,
        requested_by: actor.accountId, membership_authorization_version: null,
      }] }) };
    const service = new PostgresExportService(pool as never, {} as never, ".work/exports");
    const create = vi.spyOn(service, "create");

    await expect(service.createCurrent(actor, "shop-1", "key-2", "request-2", assumptions)).resolves.toMatchObject({
      id: "export-1",
      status: "SUCCEEDED",
      progress: "100",
      isCurrentFormat: true,
    });
    expect(create).not.toHaveBeenCalled();
    const reuseCall = pool.query.mock.calls[2];
    expect(String(reuseCall?.[0])).toContain("format_version=$4");
    expect(String(reuseCall?.[0])).toContain("profit_rate IS NOT DISTINCT FROM $5::numeric");
    expect(reuseCall?.[1]).toEqual(["shop-1", actor.accountId, "snapshot-1", REPORT_EXPORT_FORMAT, null, null, ["EU"], null, null]);
  });

  it("reuses only an export with the same immutable report period", async () => {
    const period = { periodStart: "2026-04", periodEnd: "2026-06" } as const;
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }] })
      .mockResolvedValueOnce({ rows: [{ published_snapshot_id: "snapshot-1" }] })
      .mockResolvedValueOnce({ rows: [{
        id: "export-period", shop_id: "shop-1", published_snapshot_id: "snapshot-1",
        status: "SUCCEEDED", output_kind: "XLSX", created_at: new Date("2026-07-28T00:00:00.000Z"),
        requested_by: actor.accountId, membership_authorization_version: null,
        period_start: period.periodStart, period_end: period.periodEnd,
      }] }) };
    const service = new PostgresExportService(pool as never, {} as never, ".work/exports");

    await expect(service.createCurrent(actor, "shop-1", "key-period", "request-period", { ...assumptions, ...period }))
      .resolves.toMatchObject({ id: "export-period", ...period });

    expect(pool.query.mock.calls[2]?.[1]).toEqual([
      "shop-1", actor.accountId, "snapshot-1", REPORT_EXPORT_FORMAT,
      null, null, ["EU"], "2026-04-01", "2026-06-01",
    ]);
  });

  it.each([
    ["QUEUED", "QUEUED", 0, "0"],
    ["RUNNING", "WRITING_MONTHLY", 37, "37"],
  ] as const)("reuses an unexpired current-format %s export", async (jobStatus, stage, progressPercent, expectedProgress) => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }] })
      .mockResolvedValueOnce({ rows: [{ published_snapshot_id: "snapshot-1" }] })
      .mockResolvedValueOnce({ rows: [{
        id: `export-${jobStatus.toLowerCase()}`, shop_id: "shop-1", published_snapshot_id: "snapshot-1",
        status: jobStatus, output_kind: null, created_at: new Date("2026-07-28T00:00:00.000Z"),
        requested_by: actor.accountId, membership_authorization_version: null,
        stage, progress_percent: progressPercent, processed_rows: "1200", total_rows: "4000",
        heartbeat_at: new Date("2026-07-28T00:02:00.000Z"),
      }] }) };
    const service = new PostgresExportService(pool as never, {} as never, ".work/exports");
    const create = vi.spyOn(service, "create");

    await expect(service.createCurrent(actor, "shop-1", "key-active", "request-active", assumptions)).resolves.toMatchObject({
      status: jobStatus,
      progress: expectedProgress,
      stage,
      processedRows: "1200",
      totalRows: "4000",
      heartbeatAt: "2026-07-28T00:02:00.000Z",
      isCurrentFormat: true,
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("does not select a legacy-format export for the current download", async () => {
    const pool = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "shop-1", enterprise_id: "enterprise-1", status: "ACTIVE", membership_id: null, membership_status: null, export_allowed: null, authorization_epoch: null }] })
      .mockResolvedValueOnce({ rows: [{ published_snapshot_id: "snapshot-1" }] })
      .mockImplementationOnce(async (sql: string, parameters: readonly unknown[]) => {
        expect(sql).toContain("format_version=$4");
        expect(parameters[3]).toBe(REPORT_EXPORT_FORMAT);
        return { rows: [] };
      }) };
    const service = new PostgresExportService(pool as never, {} as never, ".work/exports");
    const create = vi.spyOn(service, "create").mockResolvedValue({ id: "export-v2", status: "QUEUED" } as never);

    await expect(service.createCurrent(actor, "shop-1", "key-v2", "request-v2", assumptions))
      .resolves.toMatchObject({ id: "export-v2" });
    expect(create).toHaveBeenCalledWith(actor, "shop-1", "snapshot-1", "key-v2", "request-v2", assumptions);
  });
});
