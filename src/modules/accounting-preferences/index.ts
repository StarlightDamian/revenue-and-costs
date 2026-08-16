import type { Actor, SqlClient, TransactionRunner } from "../authorization/index.js";
import type { CoreTransactionSideEffects } from "../authorization/events.js";
import { decimal, decimal8 } from "../../shared/decimal.js";
import { AppError } from "../../shared/errors.js";

export interface AccountingAssumptions {
  readonly profitRate: string | null;
  readonly minimumSalesCostRate: string | null;
}

export const CONTINENT_PREFIXES = ["AS", "EU", "AF", "AM", "OC"] as const;
export type ContinentPrefix = typeof CONTINENT_PREFIXES[number];

export interface AccountingPreferences extends AccountingAssumptions {
  readonly continentPrefixes: readonly ContinentPrefix[];
}

export interface CostAccountingInput {
  readonly incomeTotalCny: string;
  readonly netIncomeCny: string;
  readonly platformExpensesCny: string;
}

export interface CostAccountingResult {
  readonly targetProfitCny: string | null;
  readonly profitCny: string;
  readonly procurementCny: string;
  readonly salesCostRate: string;
  readonly minimumAdjusted: boolean;
}

export const EMPTY_ACCOUNTING_ASSUMPTIONS: AccountingAssumptions = {
  profitRate: null,
  minimumSalesCostRate: null,
};

export const DEFAULT_CONTINENT_PREFIXES: readonly ContinentPrefix[] = ["EU"];

export function normalizeContinentPrefixes(values: readonly string[]): readonly ContinentPrefix[] {
  const requested = new Set(values);
  if ([...requested].some((value) => !CONTINENT_PREFIXES.includes(value as ContinentPrefix))) {
    throw new Error("INVALID_CONTINENT_PREFIX");
  }
  return CONTINENT_PREFIXES.filter((value) => requested.has(value));
}

const MARKETPLACE_CONTINENT: Readonly<Record<string, ContinentPrefix>> = {
  AE: "AS", IN: "AS", JP: "AS", SA: "AS", SG: "AS",
  BE: "EU", DE: "EU", ES: "EU", FR: "EU", IE: "EU", IT: "EU", NL: "EU", PL: "EU", SE: "EU", TR: "EU", UK: "EU",
  EG: "AF", ZA: "AF",
  BR: "AM", CA: "AM", MX: "AM", US: "AM",
  AU: "OC", NZ: "OC",
};

export function formatMarketplaceForExport(value: string, prefixes: readonly ContinentPrefix[]): string {
  const normalized = value.trim().toUpperCase();
  const continent = MARKETPLACE_CONTINENT[normalized];
  return continent && prefixes.includes(continent) ? `${continent}-${normalized}` : normalized;
}

const RATE_PATTERN = /^(?:0|1)(?:\.\d{1,8})?$/u;

export function normalizeAccountingRate(
  value: string | null,
  field: keyof AccountingAssumptions,
): string | null {
  if (value === null) return null;
  if (!RATE_PATTERN.test(value) || decimal(value).isNegative() || decimal(value).greaterThan(1)) {
    throw new Error(`INVALID_ACCOUNTING_RATE:${field}`);
  }
  return decimal8(value);
}

export function normalizeAccountingAssumptions(input: AccountingAssumptions): AccountingAssumptions {
  return {
    profitRate: normalizeAccountingRate(input.profitRate, "profitRate"),
    minimumSalesCostRate: normalizeAccountingRate(input.minimumSalesCostRate, "minimumSalesCostRate"),
  };
}

export function normalizeAccountingPreferences(
  input: AccountingAssumptions & { readonly continentPrefixes: readonly string[] },
): AccountingPreferences {
  return {
    ...normalizeAccountingAssumptions(input),
    continentPrefixes: normalizeContinentPrefixes(input.continentPrefixes),
  };
}

export function calculateCostAccounting(
  input: CostAccountingInput,
  rawAssumptions: AccountingAssumptions,
): CostAccountingResult {
  const assumptions = normalizeAccountingAssumptions(rawAssumptions);
  const income = decimal(input.incomeTotalCny);
  const net = decimal(input.netIncomeCny);
  const expenses = decimal(input.platformExpensesCny);
  const targetProfit = assumptions.profitRate === null ? null : net.mul(decimal(assumptions.profitRate));
  const baseProcurement = targetProfit === null ? decimal("0") : net.sub(expenses).sub(targetProfit);
  const hasPositiveIncome = income.greaterThan(0);
  const minimumProcurement = assumptions.minimumSalesCostRate !== null && hasPositiveIncome
    ? income.mul(decimal(assumptions.minimumSalesCostRate))
    : null;
  const minimumAdjusted = minimumProcurement !== null && baseProcurement.lessThan(minimumProcurement);
  const procurement = minimumAdjusted ? minimumProcurement : baseProcurement;
  const profit = net.sub(expenses).sub(procurement);
  const salesCostRate = hasPositiveIncome ? procurement.div(income) : decimal("0");
  return {
    targetProfitCny: targetProfit === null ? null : decimal8(targetProfit),
    profitCny: decimal8(profit),
    procurementCny: decimal8(procurement),
    salesCostRate: decimal8(salesCostRate),
    minimumAdjusted,
  };
}

export interface AccountingPreferencesService {
  get(accountId: string): Promise<AccountingPreferences>;
  update(actor: Actor, preferences: AccountingPreferences, requestId: string): Promise<AccountingPreferences>;
}

interface AccountingPreferencesRow extends Record<string, unknown> {
  readonly profit_rate: string | null;
  readonly minimum_sales_cost_rate: string | null;
  readonly continent_prefixes: string[];
}

export async function findAccountingPreferences(
  client: SqlClient,
  accountId: string,
): Promise<AccountingPreferences | null> {
  const result = await client.query<AccountingPreferencesRow>(
    `SELECT accounting_profit_rate::text AS profit_rate,
            minimum_sales_cost_rate::text AS minimum_sales_cost_rate,
            accounting_continent_prefixes AS continent_prefixes
       FROM account
      WHERE id=$1`,
    [accountId],
  );
  const row = result.rows[0];
  return row ? normalizeAccountingPreferences({
    profitRate: row.profit_rate,
    minimumSalesCostRate: row.minimum_sales_cost_rate,
    continentPrefixes: row.continent_prefixes,
  }) : null;
}

export class PostgresAccountingPreferencesService implements AccountingPreferencesService {
  constructor(
    private readonly reader: SqlClient,
    private readonly transactions: TransactionRunner,
    private readonly effects: CoreTransactionSideEffects,
  ) {}

  async get(accountId: string): Promise<AccountingPreferences> {
    const preferences = await findAccountingPreferences(this.reader, accountId);
    if (!preferences) throw new AppError("RESOURCE_NOT_FOUND", "资源不存在或无权访问", 404);
    return preferences;
  }

  async update(actor: Actor, rawPreferences: AccountingPreferences, requestId: string): Promise<AccountingPreferences> {
    const preferences = normalizeAccountingPreferences(rawPreferences);
    return this.transactions.transaction(async (client) => {
      const current = await client.query<{
        profit_rate: string | null;
        minimum_sales_cost_rate: string | null;
        continent_prefixes: string[];
      }>(
        `SELECT accounting_profit_rate::text AS profit_rate,
                minimum_sales_cost_rate::text AS minimum_sales_cost_rate,
                accounting_continent_prefixes AS continent_prefixes
           FROM account
          WHERE id=$1
          FOR UPDATE`,
        [actor.accountId],
      );
      const before = current.rows[0];
      if (!before) throw new AppError("RESOURCE_NOT_FOUND", "资源不存在或无权访问", 404);
      await client.query(
        `UPDATE account
            SET accounting_profit_rate=$2::numeric,
                minimum_sales_cost_rate=$3::numeric,
                accounting_continent_prefixes=$4::text[],
                updated_at=clock_timestamp()
          WHERE id=$1`,
        [actor.accountId, preferences.profitRate, preferences.minimumSalesCostRate, preferences.continentPrefixes],
      );
      await this.effects.audit(client, {
        actorAccountId: actor.accountId,
        actorRoles: [...actor.roles],
        objectType: "account",
        objectId: actor.accountId,
        action: "ACCOUNTING_PREFERENCES_UPDATED",
        result: "SUCCEEDED",
        reason: null,
        requestId,
        before: {
          profitRate: before.profit_rate,
          minimumSalesCostRate: before.minimum_sales_cost_rate,
          continentPrefixes: before.continent_prefixes,
        },
        after: { ...preferences },
      });
      return preferences;
    });
  }
}
