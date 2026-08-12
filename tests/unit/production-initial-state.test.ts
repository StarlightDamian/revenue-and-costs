import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { assertProductionInitialState } from "../../src/modules/operations/production-initial-state.js";

const administratorId = "11111111-1111-4111-8111-111111111111";

function productionPool(options: {
  readonly extraAccount?: boolean;
  readonly nonemptyTable?: string;
  readonly unclassifiedTable?: string;
  readonly overprivileged?: boolean;
} = {}): Pool {
  const query = vi.fn(async (sql: string, parameters?: readonly unknown[]) => {
    if (sql.includes("current_database()")) {
      return {
        rows: [{
          database: "revenue_and_costs",
          schema: "public",
          role: "revenue_costs_app",
          is_superuser: false,
          can_create_role: false,
          can_create_database: false,
          can_replicate: false,
          bypasses_rls: false,
          can_create_database_object: false,
          can_create_public_object: options.overprivileged ?? false,
          can_use_public: true,
          owns_public_objects: false,
          inherited_role_count: "0",
        }],
        rowCount: 1,
      };
    }
    if (sql.includes("FROM account LEFT JOIN")) {
      return {
        rows: [
          { id: administratorId, status: "ACTIVE", registered_at: new Date(), roles: ["ADMIN"] },
          ...(options.extraAccount
            ? [{ id: "22222222-2222-4222-8222-222222222222", status: "ACTIVE", registered_at: new Date(), roles: ["ACCOUNTANT"] }]
            : []),
        ],
        rowCount: options.extraAccount ? 2 : 1,
      };
    }
    if (sql.includes("FROM identity_bootstrap")) {
      return { rows: [{ completed_by: administratorId, completed_at: new Date() }], rowCount: 1 };
    }
    if (sql.includes("FROM pg_tables")) {
      return {
        rows: options.unclassifiedTable ? [{ tablename: options.unclassifiedTable }] : [],
        rowCount: options.unclassifiedTable ? 1 : 0,
      };
    }
    if (sql.includes("AS table_name")) {
      const tables = (parameters ?? []) as readonly string[];
      return {
        rows: tables.map((table) => ({
          table_name: table,
          row_count: table === options.nonemptyTable ? "1" : "0",
        })),
        rowCount: tables.length,
      };
    }
    throw new Error(`unexpected production-state query: ${sql}`);
  });
  return { query } as unknown as Pool;
}

describe("production initial-state assertion", () => {
  it("accepts one registered administrator and empty business tables", async () => {
    await expect(assertProductionInitialState(productionPool(), {
      database: "revenue_and_costs",
      role: "revenue_costs_app",
    })).resolves.toEqual(expect.objectContaining({
      administratorId,
      checkedEmptyTables: expect.any(Number),
    }));
  });

  it("rejects any additional account", async () => {
    await expect(assertProductionInitialState(productionPool({ extraAccount: true }), {
      database: "revenue_and_costs",
      role: "revenue_costs_app",
    })).rejects.toThrow("PRODUCTION_ADMIN_CARDINALITY_INVALID");
  });

  it("rejects a runtime role that can create objects in public", async () => {
    await expect(assertProductionInitialState(productionPool({ overprivileged: true }), {
      database: "revenue_and_costs",
      role: "revenue_costs_app",
    })).rejects.toThrow("PRODUCTION_DATABASE_ROLE_OVERPRIVILEGED");
  });

  it("rejects nonempty business data", async () => {
    await expect(assertProductionInitialState(productionPool({ nonemptyTable: "stored_object" }), {
      database: "revenue_and_costs",
      role: "revenue_costs_app",
    })).rejects.toThrow("PRODUCTION_BUSINESS_DATA_NOT_EMPTY:stored_object");
  });

  it("fails closed when a future public table has not been classified", async () => {
    await expect(assertProductionInitialState(productionPool({ unclassifiedTable: "future_business_table" }), {
      database: "revenue_and_costs",
      role: "revenue_costs_app",
    })).rejects.toThrow("PRODUCTION_TABLE_CLASSIFICATION_INCOMPLETE:future_business_table");
  });
});
