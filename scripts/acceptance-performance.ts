import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { PostgresDatabase } from "../src/db/database.js";
import { createPool } from "../src/db/pool.js";
import { PostgresReportService } from "../src/modules/publishing/postgres-service.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");

const baseUrl = (process.env.ACCEPTANCE_BASE_URL ?? "http://127.0.0.1:3011").replace(/\/$/u, "");
const outputPath = resolve(process.env.ACCEPTANCE_PERFORMANCE_OUTPUT ?? ".work/acceptance/performance-final.json");
const pool = createPool(databaseUrl);
const database = new PostgresDatabase(pool);
const reports = new PostgresReportService(database, database);

function summarize(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const valueAt = (fraction: number) => sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
  return {
    requests: sorted.length,
    p50Ms: Number(valueAt(0.5).toFixed(2)),
    p95Ms: Number(valueAt(0.95).toFixed(2)),
    maxMs: Number((sorted.at(-1) ?? 0).toFixed(2)),
  };
}

async function main() {
  const pointer = await database.query<{ shop_id: string }>(
    "SELECT shop_id FROM shop_current_published_snapshot ORDER BY shop_id LIMIT 1",
  );
  const shopId = pointer.rows[0]?.shop_id;
  if (!shopId) throw new Error("A published shop is required");

  await reports.getCurrent(shopId);
  const resultSamples: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const started = performance.now();
    await reports.getCurrent(shopId);
    resultSamples.push(performance.now() - started);
  }

  const apiSamples: number[] = [];
  for (let index = 0; index < 50; index += 1) {
    const started = performance.now();
    const response = await fetch(`${baseUrl}/health/live`);
    if (!response.ok) throw new Error(`Health request failed with ${response.status}`);
    await response.arrayBuffer();
    apiSamples.push(performance.now() - started);
  }

  const ordinaryApi = summarize(apiSamples);
  const resultQuery = summarize(resultSamples);
  const evidence = {
    sampledAt: new Date().toISOString(),
    target: {
      baseUrl,
      shopIdSha256: createHash("sha256").update(shopId).digest("hex"),
    },
    ordinaryApi,
    resultQueryServiceAndDatabase: resultQuery,
    thresholds: { ordinaryApiP95Ms: 300, resultQueryP95Ms: 1000 },
    passed: ordinaryApi.p95Ms <= 300 && resultQuery.p95Ms <= 1000,
  };
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (!evidence.passed) process.exitCode = 1;
}

try {
  await main();
} finally {
  await pool.end();
}
