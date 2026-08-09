import { Temporal } from "@js-temporal/polyfill";
import { createPool } from "../src/db/pool.js";
import { CHINAMONEY_XLSX_ENDPOINT, ChinaMoneyXlsxSource, curlFetch, syncChinaMoney } from "../src/modules/fx/index.js";
import { loadConfig } from "../src/shared/config.js";
import { safeErrorDiagnostic } from "../src/shared/diagnostics.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function range(historyStart: string): { from: string; to: string } {
  const today = Temporal.Now.plainDateISO("Asia/Shanghai");
  const from = Temporal.PlainDate.from(argument("--from") ?? historyStart);
  const to = Temporal.PlainDate.from(argument("--to") ?? today.toString());
  if (Temporal.PlainDate.compare(from, to) > 0) throw new Error("FX_MANUAL_RANGE_INVALID");
  return { from: from.toString(), to: to.toString() };
}

function log(level: "info" | "error", event: string, fields: Record<string, unknown>): void {
  const target = level === "error" ? process.stderr : process.stdout;
  target.write(`${JSON.stringify({ level, time: Date.now(), event, service: "fx-sync-cli", pid: process.pid, ...fields })}\n`);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const requested = range(config.chinaMoneyHistoryStart ?? "2006-01-04");
log("info", "fx_sync_started", { kind: "MANUAL_RETRY", source: "ChinaMoneyXlsx", ...requested });
try {
  const runId = await syncChinaMoney(pool, new ChinaMoneyXlsxSource(CHINAMONEY_XLSX_ENDPOINT, curlFetch), "MANUAL_RETRY", requested);
  const coverage = await pool.query<{ coverage_from: string; coverage_to: string; quote_count: string; currency_count: string; trading_day_count: string }>(
    "SELECT min(valid_date)::text AS coverage_from,max(valid_date)::text AS coverage_to,count(*)::text AS quote_count,count(DISTINCT cny_currency)::text AS currency_count,count(DISTINCT valid_date)::text AS trading_day_count FROM fx_current_quote",
  );
  log("info", "fx_sync_succeeded", { runId, ...coverage.rows[0] });
} catch (error) {
  log("error", "fx_sync_failed", { ...requested, ...safeErrorDiagnostic(error) });
  process.exitCode = 1;
} finally {
  await pool.end();
}
