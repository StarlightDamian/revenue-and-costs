import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import type { PoolClient } from "pg";

const evidenceRoot = resolve(".work/performance-test-drive");
const profilerRoot = join(evidenceRoot, "profiler");
const storageRoot = join(evidenceRoot, "storage");

interface SqlMetric {
  readonly hash: string;
  readonly sql: string;
  readonly count: number;
  readonly errorCount: number;
  readonly rowCount: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

interface ResourceSample {
  readonly at: string;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
}

interface ProcessProfilerSnapshot {
  readonly generation: string;
  readonly sampledAt: string;
  readonly role: "api" | "worker";
  readonly pid: number;
  readonly argv: readonly string[];
  readonly process: {
    readonly rssBytes: number;
    readonly peakRssBytes: number;
    readonly cpuUserMs: number;
    readonly cpuSystemMs: number;
  };
  readonly samples: readonly ResourceSample[];
  readonly sql: {
    readonly count: number;
    readonly errorCount: number;
    readonly totalMs: number;
    readonly statements: readonly SqlMetric[];
  };
}

interface DatabaseStats {
  readonly sampledAt: string;
  readonly statsReset: string | null;
  readonly walLsn: string;
  readonly databaseBytes: string;
  readonly xactCommit: string;
  readonly xactRollback: string;
  readonly blocksRead: string;
  readonly blocksHit: string;
  readonly tuplesReturned: string;
  readonly tuplesFetched: string;
  readonly tuplesInserted: string;
  readonly tuplesUpdated: string;
  readonly tuplesDeleted: string;
  readonly conflicts: string;
  readonly tempFiles: string;
  readonly tempBytes: string;
  readonly deadlocks: string;
  readonly blockReadTimeMs: string;
  readonly blockWriteTimeMs: string;
  readonly activeTimeMs: string;
  readonly sessions: string;
}

export interface StorageUsage {
  readonly totalBytes: string;
  readonly temporaryBytes: string;
  readonly fileCount: number;
  readonly temporaryFileCount: number;
}

export interface PerformanceCheckpoint {
  readonly label: string;
  readonly capturedAt: string;
  readonly generation: string;
  readonly processes: readonly ProcessProfilerSnapshot[];
  readonly database: DatabaseStats;
  readonly storage: StorageUsage;
  readonly storageCaptured: boolean;
}

export interface PerformanceCheckpointOptions {
  readonly reuseStorage?: StorageUsage;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isApplicationProcess(snapshot: ProcessProfilerSnapshot): boolean {
  return snapshot.argv.length === 1 && /src[\\/](?:api|worker)[\\/]index\.ts$/iu.test(snapshot.argv[0] ?? "");
}

async function readProfilerProcesses(generation: string): Promise<ProcessProfilerSnapshot[]> {
  let entries;
  try {
    entries = await readdir(profilerRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const snapshots: ProcessProfilerSnapshot[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^(?:api|worker)-\d+\.json$/u.test(entry.name)) continue;
    try {
      const snapshot = JSON.parse(await readFile(join(profilerRoot, entry.name), "utf8")) as ProcessProfilerSnapshot;
      if (snapshot.generation === generation && isApplicationProcess(snapshot)) snapshots.push(snapshot);
    } catch {
      // A writer may be replacing a snapshot; the next 250 ms sample is authoritative.
    }
  }
  return snapshots.sort((left, right) => left.role.localeCompare(right.role));
}

export async function resetPerformanceProfiler(): Promise<string> {
  const generation = randomUUID();
  const requestedAt = new Date().toISOString();
  await mkdir(profilerRoot, { recursive: true });
  await writeFile(join(profilerRoot, "control.json"), `${JSON.stringify({ generation, requestedAt })}\n`, "utf8");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const snapshots = await readProfilerProcesses(generation);
    if (["api", "worker"].every((role) => snapshots.some((snapshot) => snapshot.role === role))) return generation;
    await delay(100);
  }
  throw new Error("PERFORMANCE_PROFILER_NOT_READY");
}

async function databaseStats(client: PoolClient): Promise<DatabaseStats> {
  const result = await client.query<Omit<DatabaseStats, "sampledAt">>(
    `SELECT stats_reset::text AS "statsReset",pg_current_wal_lsn()::text AS "walLsn",
            pg_database_size(current_database())::text AS "databaseBytes",
            xact_commit::text AS "xactCommit",xact_rollback::text AS "xactRollback",
            blks_read::text AS "blocksRead",blks_hit::text AS "blocksHit",
            tup_returned::text AS "tuplesReturned",tup_fetched::text AS "tuplesFetched",
            tup_inserted::text AS "tuplesInserted",tup_updated::text AS "tuplesUpdated",tup_deleted::text AS "tuplesDeleted",
            conflicts::text AS conflicts,temp_files::text AS "tempFiles",temp_bytes::text AS "tempBytes",
            deadlocks::text AS deadlocks,blk_read_time::text AS "blockReadTimeMs",blk_write_time::text AS "blockWriteTimeMs",
            active_time::text AS "activeTimeMs",sessions::text AS sessions
       FROM pg_stat_database WHERE datname=current_database()`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("PERFORMANCE_DATABASE_STATS_MISSING");
  return { sampledAt: new Date().toISOString(), ...row };
}

async function storageUsage(): Promise<StorageUsage> {
  const pending = [storageRoot];
  let totalBytes = 0n;
  let temporaryBytes = 0n;
  let fileCount = 0;
  let temporaryFileCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      let file;
      try {
        file = await stat(path);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
        throw error;
      }
      const temporary = extname(entry.name).toLowerCase() === ".part" || /[\\/]archive[\\/]/iu.test(path);
      totalBytes += BigInt(file.size);
      fileCount += 1;
      if (temporary) {
        temporaryBytes += BigInt(file.size);
        temporaryFileCount += 1;
      }
    }
  }
  return { totalBytes: totalBytes.toString(), temporaryBytes: temporaryBytes.toString(), fileCount, temporaryFileCount };
}

export async function capturePerformanceCheckpoint(
  client: PoolClient,
  generation: string,
  label: string,
  options: PerformanceCheckpointOptions = {},
): Promise<PerformanceCheckpoint> {
  const storageCaptured = options.reuseStorage === undefined;
  const [processes, database, storage] = await Promise.all([
    readProfilerProcesses(generation),
    databaseStats(client),
    storageCaptured ? storageUsage() : Promise.resolve(options.reuseStorage),
  ]);
  if (!["api", "worker"].every((role) => processes.some((process) => process.role === role))) {
    throw new Error("PERFORMANCE_PROFILER_PROCESS_MISSING");
  }
  return { label, capturedAt: new Date().toISOString(), generation, processes, database, storage, storageCaptured };
}

function lsnBytes(value: string): bigint {
  const [high, low] = value.split("/");
  if (!high || !low) return 0n;
  return BigInt(`0x${high}`) * 0x1_0000_0000n + BigInt(`0x${low}`);
}

function integerDelta(before: string, after: string): string {
  return (BigInt(after) - BigInt(before)).toString();
}

function numberDelta(before: string, after: string): number {
  return Number(after) - Number(before);
}

function combineStatements(processes: readonly ProcessProfilerSnapshot[]): Map<string, SqlMetric> {
  const combined = new Map<string, SqlMetric>();
  for (const process of processes) {
    for (const statement of process.sql.statements) {
      const current = combined.get(statement.hash);
      combined.set(statement.hash, current ? {
        ...statement,
        count: current.count + statement.count,
        errorCount: current.errorCount + statement.errorCount,
        rowCount: current.rowCount + statement.rowCount,
        totalMs: current.totalMs + statement.totalMs,
        maxMs: Math.max(current.maxMs, statement.maxMs),
      } : statement);
    }
  }
  return combined;
}

export function summarizePerformanceDelta(before: PerformanceCheckpoint, after: PerformanceCheckpoint): object {
  const fromTime = Date.parse(before.capturedAt);
  const toTime = Date.parse(after.capturedAt);
  const beforeStatements = combineStatements(before.processes);
  const afterStatements = combineStatements(after.processes);
  const sql = [];
  for (const statement of afterStatements.values()) {
    const previous = beforeStatements.get(statement.hash);
    const count = statement.count - (previous?.count ?? 0);
    if (count <= 0) continue;
    sql.push({
      hash: statement.hash,
      sql: statement.sql,
      count,
      errorCount: statement.errorCount - (previous?.errorCount ?? 0),
      rowCount: statement.rowCount - (previous?.rowCount ?? 0),
      totalMs: statement.totalMs - (previous?.totalMs ?? 0),
      observedCumulativeMaxMs: statement.maxMs,
    });
  }
  sql.sort((left, right) => right.totalMs - left.totalMs);
  const resources = after.processes.map((process) => {
    const previous = before.processes.find((candidate) => candidate.role === process.role && candidate.pid === process.pid);
    const samples = process.samples.filter((sample) => Date.parse(sample.at) >= fromTime && Date.parse(sample.at) <= toTime);
    return {
      role: process.role,
      pid: process.pid,
      cpuUserMs: process.process.cpuUserMs - (previous?.process.cpuUserMs ?? 0),
      cpuSystemMs: process.process.cpuSystemMs - (previous?.process.cpuSystemMs ?? 0),
      peakRssBytes: Math.max(process.process.rssBytes, ...samples.map((sample) => sample.rssBytes)),
      peakHeapUsedBytes: Math.max(0, ...samples.map((sample) => sample.heapUsedBytes)),
      peakExternalBytes: Math.max(0, ...samples.map((sample) => sample.externalBytes)),
      sampleCount: samples.length,
    };
  });
  const dbBefore = before.database;
  const dbAfter = after.database;
  return {
    from: before.label,
    to: after.label,
    wallMs: toTime - fromTime,
    resources,
    sql: {
      count: sql.reduce((sum, item) => sum + item.count, 0),
      errorCount: sql.reduce((sum, item) => sum + item.errorCount, 0),
      totalMs: sql.reduce((sum, item) => sum + item.totalMs, 0),
      topByTotalMs: sql.slice(0, 20),
    },
    database: {
      transactionsCommitted: integerDelta(dbBefore.xactCommit, dbAfter.xactCommit),
      transactionsRolledBack: integerDelta(dbBefore.xactRollback, dbAfter.xactRollback),
      blocksRead: integerDelta(dbBefore.blocksRead, dbAfter.blocksRead),
      blocksHit: integerDelta(dbBefore.blocksHit, dbAfter.blocksHit),
      tuplesReturned: integerDelta(dbBefore.tuplesReturned, dbAfter.tuplesReturned),
      tuplesFetched: integerDelta(dbBefore.tuplesFetched, dbAfter.tuplesFetched),
      tuplesInserted: integerDelta(dbBefore.tuplesInserted, dbAfter.tuplesInserted),
      tuplesUpdated: integerDelta(dbBefore.tuplesUpdated, dbAfter.tuplesUpdated),
      tuplesDeleted: integerDelta(dbBefore.tuplesDeleted, dbAfter.tuplesDeleted),
      tempFiles: integerDelta(dbBefore.tempFiles, dbAfter.tempFiles),
      tempBytes: integerDelta(dbBefore.tempBytes, dbAfter.tempBytes),
      walBytes: (lsnBytes(dbAfter.walLsn) - lsnBytes(dbBefore.walLsn)).toString(),
      blockReadTimeMs: numberDelta(dbBefore.blockReadTimeMs, dbAfter.blockReadTimeMs),
      blockWriteTimeMs: numberDelta(dbBefore.blockWriteTimeMs, dbAfter.blockWriteTimeMs),
      activeTimeMs: numberDelta(dbBefore.activeTimeMs, dbAfter.activeTimeMs),
      databaseBytesDelta: integerDelta(dbBefore.databaseBytes, dbAfter.databaseBytes),
      deadlocks: integerDelta(dbBefore.deadlocks, dbAfter.deadlocks),
      conflicts: integerDelta(dbBefore.conflicts, dbAfter.conflicts),
      sessions: integerDelta(dbBefore.sessions, dbAfter.sessions),
    },
    storage: before.storageCaptured && after.storageCaptured ? {
      measured: true,
      totalBytesDelta: integerDelta(before.storage.totalBytes, after.storage.totalBytes),
      temporaryBytesAtEnd: after.storage.temporaryBytes,
      temporaryFileCountAtEnd: after.storage.temporaryFileCount,
      totalFilesAtEnd: after.storage.fileCount,
    } : { measured: false },
  };
}

export async function collectRunCorrectness(
  client: PoolClient,
  input: { readonly importBatchId: string; readonly shopId: string; readonly snapshotId: string; readonly exportId: string },
): Promise<object> {
  const batch = await client.query<{ upload_batch_id: string }>("SELECT upload_batch_id FROM import_batch WHERE id=$1", [input.importBatchId]);
  const uploadBatchId = batch.rows[0]?.upload_batch_id;
  if (!uploadBatchId) throw new Error("PERFORMANCE_IMPORT_BATCH_NOT_FOUND");
  const files = await client.query(
      `SELECT count(*)::text AS files,count(*) FILTER (WHERE parse_status='PARSED')::text AS "parsedFiles",
              count(*) FILTER (WHERE parse_status='EXCLUDED')::text AS "excludedFiles",
              COALESCE(sum(read_row_count),0)::text AS "readRows",COALESCE(sum(inserted_row_count),0)::text AS "insertedRows",
              COALESCE(sum(excluded_row_count),0)::text AS "excludedRows",COALESCE(sum(error_row_count),0)::text AS "errorRows"
         FROM import_file WHERE import_batch_id=$1`,
      [input.importBatchId],
    );
  const facts = await client.query(
      `WITH versions AS (SELECT id FROM dataset_version WHERE import_batch_id=$1),
            all_facts AS (
              SELECT normalized_marketplace,local_month,currency,'TRANSACTION' kind FROM transaction_fact WHERE dataset_version_id IN (SELECT id FROM versions)
              UNION ALL
              SELECT normalized_marketplace,local_month,currency,'SHIPMENT' kind FROM shipment_fact WHERE dataset_version_id IN (SELECT id FROM versions)
            )
       SELECT count(*) FILTER (WHERE kind='TRANSACTION')::text AS "transactionRows",
              count(*) FILTER (WHERE kind='SHIPMENT')::text AS "shipmentRows",
              count(DISTINCT normalized_marketplace)::text AS marketplaces,
              count(DISTINCT local_month)::text AS months,
              count(DISTINCT (normalized_marketplace,local_month))::text AS "marketplaceMonths",
              COALESCE(array_agg(DISTINCT currency ORDER BY currency),'{}') AS currencies
         FROM all_facts`,
      [input.importBatchId],
    );
  const slices = await client.query(
      `SELECT disposition,count(*)::text AS count
         FROM published_snapshot_slice WHERE published_snapshot_id=$1 GROUP BY disposition ORDER BY disposition`,
      [input.snapshotId],
    );
  const totals = await client.query(
      `SELECT ps.calculation_run_id::text AS "calculationRunId",
              COALESCE(sum(m.income),0)::numeric(30,8)::text AS income,
              COALESCE(sum(m.refund),0)::numeric(30,8)::text AS refund,
              COALESCE(sum(m.withheld_tax),0)::numeric(30,8)::text AS "withheldTax",
              COALESCE(sum(m.platform_fee),0)::numeric(30,8)::text AS "platformFee",
              COALESCE(sum(m.fba_fulfillment_fee),0)::numeric(30,8)::text AS "fbaFulfillmentFee",
              COALESCE(sum(m.advertising_fee),0)::numeric(30,8)::text AS "advertisingFee",
              COALESCE(sum(m.fba_storage_fee),0)::numeric(30,8)::text AS "fbaStorageFee",
              COALESCE(sum(m.other_deduction),0)::numeric(30,8)::text AS "otherDeduction",
              COALESCE(sum(m.platform_balance),0)::numeric(30,8)::text AS "platformBalance"
         FROM published_snapshot ps
         LEFT JOIN monthly_cost_summary m ON m.calculation_run_id=ps.calculation_run_id
        WHERE ps.id=$1 GROUP BY ps.calculation_run_id`,
      [input.snapshotId],
    );
  const queue = await client.query(
      `WITH related_ids AS (
          SELECT id::text FROM upload_file WHERE batch_id=$1::uuid
          UNION SELECT id::text FROM import_file WHERE import_batch_id=$2::uuid
          UNION SELECT stored_object_id::text FROM import_file WHERE import_batch_id=$2::uuid AND stored_object_id IS NOT NULL
        ), run_id AS (SELECT calculation_run_id::text id FROM published_snapshot WHERE id=$3::uuid)
       SELECT name,count(*)::text AS jobs,COALESCE(sum(retry_count),0)::text AS retries,
              min(created_on)::text AS "firstCreatedAt",
              min(started_on)::text AS "firstStartedAt",
              max(completed_on)::text AS "lastCompletedAt",
              COALESCE(EXTRACT(EPOCH FROM (max(completed_on)-min(created_on)))*1000,0)::text AS "wallWindowMs",
              COALESCE(EXTRACT(EPOCH FROM (max(completed_on)-min(started_on)))*1000,0)::text AS "activeWindowMs",
              COALESCE(sum(EXTRACT(EPOCH FROM (completed_on-started_on))*1000) FILTER (WHERE completed_on IS NOT NULL AND started_on IS NOT NULL),0)::text AS "summedJobLeaseMs",
              COALESCE(sum(EXTRACT(EPOCH FROM (started_on-created_on))*1000) FILTER (WHERE started_on IS NOT NULL),0)::text AS "summedQueueWaitMs",
              COALESCE(max(EXTRACT(EPOCH FROM (completed_on-started_on))*1000) FILTER (WHERE completed_on IS NOT NULL AND started_on IS NOT NULL),0)::text AS "maxJobLeaseMs"
         FROM pgboss.job
        WHERE data->>'fileId' IN (SELECT id FROM related_ids)
           OR data->>'batchId'=$1::text OR data->>'importBatchId'=$2::text OR data->>'runId' IN (SELECT id FROM run_id)
           OR data->>'exportId'=$4::text OR data->>'shopId'=$5::text
        GROUP BY name ORDER BY name`,
      [uploadBatchId, input.importBatchId, input.snapshotId, input.exportId, input.shopId],
    );
  const financial = totals.rows[0];
  if (!financial) throw new Error("PERFORMANCE_FINANCIAL_TOTALS_MISSING");
  return {
    importBatchId: input.importBatchId,
    uploadBatchId,
    files: files.rows[0],
    facts: facts.rows[0],
    slices: slices.rows,
    financial,
    queue: queue.rows,
  };
}
