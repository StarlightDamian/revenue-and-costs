import { describe, expect, it, vi } from "vitest";
import { invalidateMembershipExportArtifacts } from "../../src/api/service-graph.js";
import type { SqlClient } from "../../src/modules/authorization/index.js";

describe("membership export artifact invalidation", () => {
  it("revokes active jobs and all unconsumed stale-epoch download tokens in one caller transaction", async () => {
    const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
      void sql; void parameters;
      return { rows: [], rowCount: 1 };
    });

    await invalidateMembershipExportArtifacts({ query } as unknown as SqlClient, "membership", "9");

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toContain("er.status IN ('QUEUED','RUNNING','SUCCEEDED')");
    expect(query.mock.calls[1]?.[0]).toContain("UPDATE export_download_grant");
    expect(query.mock.calls[1]?.[0]).toContain("consumed_at IS NULL");
    expect(query.mock.calls[1]?.[0]).toContain("membership_authorization_version::text <> $2");
    expect(query.mock.calls[1]?.[1]).toEqual(["membership", "9"]);
  });
});
