import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, stat, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { basename, extname, join, relative, resolve } from "node:path";
import { Pool, type PoolClient } from "pg";

import { migrate } from "../src/db/migrate.js";
import {
  capturePerformanceCheckpoint,
  collectRunCorrectness,
  resetPerformanceProfiler,
  summarizePerformanceDelta,
} from "./performance-metrics.js";

const evidenceRoot = resolve(".work/performance-test-drive");
const sampleRoot = resolve("nas/data/1730-玉荣国际/2026年第二季度亚马逊数据");
const companies = ["开模师", "米克", "阿尔金"] as const;
const targetSchema = process.env.PERF_SCHEMA ?? "perf_opt_20260806";

function timestamp(): string {
  return new Date().toISOString().replaceAll(/[:.]/gu, "").replace("Z", "Z");
}

async function emit(kind: string, value: unknown): Promise<void> {
  await mkdir(evidenceRoot, { recursive: true });
  const path = join(evidenceRoot, `${kind}-${timestamp()}.json`);
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ evidence: relative(process.cwd(), path), ...value as object })}\n`);
}

async function inventory(): Promise<void> {
  const results = [];
  for (const company of companies) {
    const root = join(sampleRoot, company);
    const pending = [root];
    const types = new Map<string, number>();
    let files = 0;
    let bytes = 0n;
    while (pending.length) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          pending.push(path);
          continue;
        }
        if (!entry.isFile()) continue;
        const file = await stat(path);
        const extension = extname(entry.name).toLowerCase() || "[none]";
        files += 1;
        bytes += BigInt(file.size);
        types.set(extension, (types.get(extension) ?? 0) + 1);
      }
    }
    results.push({
      company,
      files,
      bytes: bytes.toString(),
      csvTxt: (types.get(".csv") ?? 0) + (types.get(".txt") ?? 0),
      pdf: types.get(".pdf") ?? 0,
      zip: types.get(".zip") ?? 0,
      xlsxXls: (types.get(".xlsx") ?? 0) + (types.get(".xls") ?? 0),
      extensions: Object.fromEntries([...types].sort(([left], [right]) => left.localeCompare(right))),
    });
  }
  await emit("sample-inventory", { sampledAt: new Date().toISOString(), sampleRoot: relative(process.cwd(), sampleRoot), companies: results });
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
}

function targetPool(): Pool {
  return new Pool({
    connectionString: required("DATABASE_URL"),
    options: `-c search_path=${targetSchema},public`,
  });
}

async function assertIsolatedTarget(client: PoolClient): Promise<{ database: string; schema: string }> {
  if (!/^perf_opt_[a-z0-9_]+$/u.test(targetSchema)) throw new Error("PERF_SCHEMA_INVALID");
  const result = await client.query<{ database: string; schema: string }>(
    "SELECT current_database() database,current_schema() schema",
  );
  const row = result.rows[0];
  if (!row || !/test/iu.test(row.database) || row.schema !== targetSchema) {
    throw new Error("PERFORMANCE_TEST_ISOLATION_REQUIRED");
  }
  return row;
}

async function queueState(): Promise<void> {
  const pool = targetPool();
  try {
    const client = await pool.connect();
    try {
      const target = await assertIsolatedTarget(client);
      const table = await client.query<{ exists: string | null }>("SELECT to_regclass('pgboss.job')::text exists");
      const states = table.rows[0]?.exists
        ? (await client.query<{ state: string; count: string }>(
          "SELECT state,count(1)::text count FROM pgboss.job GROUP BY state ORDER BY state",
        )).rows
        : [];
      await emit("isolated-queue", { sampledAt: new Date().toISOString(), target, queueTable: table.rows[0]?.exists ?? null, states });
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function diagnoseLatestExportScope(): Promise<void> {
  const pool = targetPool();
  try {
    const client = await pool.connect();
    try {
      const target = await assertIsolatedTarget(client);
      const latest = await client.query<{ export_id: string; snapshot_id: string }>(
        "SELECT id export_id,published_snapshot_id snapshot_id FROM export_request ORDER BY created_at DESC,id DESC LIMIT 1",
      );
      const row = latest.rows[0];
      if (!row) throw new Error("PERFORMANCE_TEST_EXPORT_NOT_FOUND");
      try {
        const scope = await client.query(
          `SELECT to_char(ds.local_month,'YYYY-MM') AS "period",to_char(ds.local_month,'YYYY-MM') AS "month",
                  ds.normalized_marketplace marketplace,ps.disposition,ps.dataset_version_id::text AS "datasetVersionId",
                  COALESCE((SELECT tf.currency FROM transaction_fact tf WHERE tf.dataset_version_id=ps.dataset_version_id ORDER BY tf.id LIMIT 1),
                           (SELECT sf.currency FROM shipment_fact sf WHERE sf.dataset_version_id=ps.dataset_version_id ORDER BY sf.id LIMIT 1)) currency
             FROM published_snapshot_slice ps JOIN dataset_slice ds ON ds.id=ps.dataset_slice_id
            WHERE ps.published_snapshot_id=$1 ORDER BY ds.local_month,ds.normalized_marketplace`,
          [row.snapshot_id],
        );
        await emit("export-scope-diagnostic", { sampledAt: new Date().toISOString(), target, exportId: row.export_id, status: "SUCCEEDED", rows: scope.rowCount });
      } catch (error) {
        const databaseError = error as { code?: string; message?: string; position?: string };
        await emit("export-scope-diagnostic", {
          sampledAt: new Date().toISOString(), target, exportId: row.export_id, status: "FAILED",
          errorCode: databaseError.code ?? "UNKNOWN", errorMessage: databaseError.message ?? "UNKNOWN", position: databaseError.position ?? null,
        });
        throw error;
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

interface FxSyncRunRow {
  id: string;
  sync_kind: string;
  requested_from: string | null;
  requested_to: string | null;
  status: string;
  coverage_from: string | null;
  coverage_to: string | null;
  attempt_count: number;
  error_code: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface FxRawRow {
  id: string;
  sync_run_id: string;
  source_name: string;
  request_parameters: unknown;
  response_payload: unknown;
  response_sha256: Buffer;
  http_status: number;
  response_headers: unknown;
  fetched_at: Date;
}

interface FxLinkRow {
  sync_run_id: string;
  snapshot_id: string;
  page_number: number;
  linked_at: Date;
  request_parameters: unknown;
}

async function seedFx(): Promise<void> {
  const from = process.env.PERF_FX_FROM ?? "2026-03-20";
  const to = process.env.PERF_FX_TO ?? "2026-07-01";
  const source = new Pool({ connectionString: required("SOURCE_DATABASE_URL"), options: "-c search_path=public" });
  const target = targetPool();
  const targetClient = await target.connect();
  try {
    const isolated = await assertIsolatedTarget(targetClient);
    const sourceIdentity = await source.query<{ database: string }>("SELECT current_database() database");
    if (sourceIdentity.rows[0]?.database === isolated.database) throw new Error("FX_SOURCE_MUST_DIFFER_FROM_TEST_TARGET");
    const quotes = await source.query<Record<string, unknown>>(
      `SELECT id,snapshot_id,valid_date::text,base_currency,quote_currency,base_unit::text,rate::text,
              cny_currency,cny_per_unit::text,created_at
         FROM fx_current_quote WHERE valid_date BETWEEN $1::date AND $2::date
        ORDER BY valid_date,cny_currency`,
      [from, to],
    );
    const marketDays = await source.query<Record<string, unknown>>(
      `SELECT id,valid_date::text,status,evidence_type,snapshot_id,reason,created_at
         FROM fx_market_day WHERE valid_date BETWEEN $1::date AND $2::date
        ORDER BY valid_date,evidence_type`,
      [from, to],
    );
    const snapshotIds = [...new Set([
      ...quotes.rows.map((row) => String(row.snapshot_id)),
      ...marketDays.rows.map((row) => row.snapshot_id ? String(row.snapshot_id) : "").filter(Boolean),
    ])];
    if (!quotes.rowCount || snapshotIds.length === 0) throw new Error("FX_SOURCE_COVERAGE_NOT_FOUND");
    const raw = await source.query<FxRawRow>(
      `SELECT id,sync_run_id,source_name,request_parameters,response_payload,response_sha256,http_status,response_headers,fetched_at
         FROM fx_raw_snapshot WHERE id=ANY($1::uuid[]) ORDER BY fetched_at,id`,
      [snapshotIds],
    );
    const links = await source.query<FxLinkRow>(
      `SELECT DISTINCT ON (link.snapshot_id)
              link.sync_run_id,link.snapshot_id,link.page_number,link.linked_at,link.request_parameters
         FROM fx_sync_run_snapshot link
         JOIN fx_sync_run run ON run.id=link.sync_run_id AND run.status='SUCCEEDED'
        WHERE link.snapshot_id=ANY($1::uuid[])
        ORDER BY link.snapshot_id,run.finished_at DESC,link.linked_at DESC`,
      [snapshotIds],
    );
    if (links.rowCount !== raw.rowCount) throw new Error("FX_SOURCE_SUCCESS_LINK_INCOMPLETE");
    const runIds = [...new Set([
      ...links.rows.map((row) => row.sync_run_id),
      ...raw.rows.map((row) => row.sync_run_id),
    ])];
    const runs = await source.query<FxSyncRunRow>(
      `SELECT id,sync_kind,requested_from::text,requested_to::text,status,coverage_from::text,coverage_to::text,
              attempt_count,error_code,started_at,finished_at
         FROM fx_sync_run WHERE id=ANY($1::uuid[]) ORDER BY started_at,id`,
      [runIds],
    );
    await targetClient.query("BEGIN");
    for (const row of runs.rows) {
      await targetClient.query(
        `INSERT INTO fx_sync_run(id,sync_kind,requested_from,requested_to,status,coverage_from,coverage_to,
           attempt_count,error_code,started_at,finished_at)
         VALUES($1,$2,$3::date,$4::date,$5,$6::date,$7::date,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING`,
        [row.id, row.sync_kind, row.requested_from, row.requested_to, row.status, row.coverage_from, row.coverage_to,
          row.attempt_count, row.error_code, row.started_at, row.finished_at],
      );
    }
    for (const row of raw.rows) {
      await targetClient.query(
        `INSERT INTO fx_raw_snapshot(id,sync_run_id,source_name,request_parameters,response_payload,response_sha256,
           http_status,response_headers,fetched_at)
         VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8::jsonb,$9) ON CONFLICT(id) DO NOTHING`,
        [row.id, row.sync_run_id, row.source_name, JSON.stringify(row.request_parameters), JSON.stringify(row.response_payload),
          row.response_sha256, row.http_status, JSON.stringify(row.response_headers), row.fetched_at],
      );
    }
    for (const row of links.rows) {
      await targetClient.query(
        `INSERT INTO fx_sync_run_snapshot(sync_run_id,snapshot_id,page_number,linked_at,request_parameters)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(sync_run_id,page_number) DO NOTHING`,
        [row.sync_run_id, row.snapshot_id, row.page_number, row.linked_at, JSON.stringify(row.request_parameters)],
      );
    }
    for (const row of quotes.rows) {
      await targetClient.query(
        `INSERT INTO fx_quote(id,snapshot_id,valid_date,base_currency,quote_currency,base_unit,rate,cny_currency,cny_per_unit,created_at)
         VALUES($1,$2,$3::date,$4,$5,$6::numeric,$7::numeric,$8,$9::numeric,$10) ON CONFLICT(id) DO NOTHING`,
        [row.id, row.snapshot_id, row.valid_date, row.base_currency, row.quote_currency, row.base_unit, row.rate,
          row.cny_currency, row.cny_per_unit, row.created_at],
      );
    }
    for (const row of marketDays.rows) {
      await targetClient.query(
        `INSERT INTO fx_market_day(id,valid_date,status,evidence_type,snapshot_id,reason,created_at)
         VALUES($1,$2::date,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,
        [row.id, row.valid_date, row.status, row.evidence_type, row.snapshot_id, row.reason, row.created_at],
      );
    }
    await targetClient.query("COMMIT");
    const coverage = await targetClient.query<{ coverage_from: string; coverage_to: string; quotes: string; currencies: string }>(
      `SELECT min(valid_date)::text coverage_from,max(valid_date)::text coverage_to,count(1)::text quotes,
              count(DISTINCT cny_currency)::text currencies FROM fx_current_quote WHERE valid_date BETWEEN $1::date AND $2::date`,
      [from, to],
    );
    await emit("isolated-fx-seed", {
      sampledAt: new Date().toISOString(),
      sourceDatabaseSha256: createHash("sha256").update(sourceIdentity.rows[0]?.database ?? "").digest("hex"),
      target: isolated,
      range: { from, to },
      copied: { runs: runs.rowCount, snapshots: raw.rowCount, links: links.rowCount, quotes: quotes.rowCount, marketDays: marketDays.rowCount },
      coverage: coverage.rows[0],
    });
  } catch (error) {
    await targetClient.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    targetClient.release();
    await Promise.all([source.end(), target.end()]);
  }
}

async function prepareFreshSchema(): Promise<void> {
  if (!/^perf_opt_[a-z0-9_]+$/u.test(targetSchema)) throw new Error("PERF_SCHEMA_INVALID");
  const bootstrap = new Pool({ connectionString: required("DATABASE_URL") });
  try {
    const identity = await bootstrap.query<{ database: string }>("SELECT current_database() database");
    const database = identity.rows[0]?.database;
    if (!database || !/test/iu.test(database)) throw new Error("PERFORMANCE_TEST_DATABASE_REQUIRED");
    const existing = await bootstrap.query<{ exists: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_namespace WHERE nspname=$1) exists",
      [targetSchema],
    );
    if (existing.rows[0]?.exists) throw new Error("PERFORMANCE_TEST_SCHEMA_ALREADY_EXISTS");
    await bootstrap.query(`CREATE SCHEMA "${targetSchema}"`);
  } finally {
    await bootstrap.end();
  }

  const target = targetPool();
  let applied: string[];
  let migrationCount: string;
  try {
    applied = await migrate(target);
    const client = await target.connect();
    try {
      await assertIsolatedTarget(client);
      migrationCount = (await client.query<{ count: string }>("SELECT count(*)::text count FROM schema_migration")).rows[0]?.count ?? "0";
    } finally {
      client.release();
    }
  } finally {
    await target.end();
  }
  await seedFx();
  await emit("performance-schema-prepared", {
    preparedAt: new Date().toISOString(),
    database: new URL(required("DATABASE_URL")).pathname.replace(/^\//u, ""),
    schema: targetSchema,
    migrationsApplied: applied.length,
    migrationCount,
  });
}

interface LocalInputFile {
  readonly path: string;
  readonly relativePath: string;
  readonly bytes: number;
  readonly contentType: string;
  readonly metadataOnly: boolean;
}

interface ImportPreview {
  readonly id: string;
  readonly status: string;
  readonly stage?: string;
  readonly failureCode?: string | null;
  readonly files: readonly { readonly classification?: string; readonly status: string }[];
  readonly issues: readonly { readonly kind: string; readonly count: number; readonly severity: string }[];
}

interface ExportJob {
  readonly id: string;
  readonly snapshotId: string;
  readonly status: string;
  readonly stage: string;
  readonly progress: string;
  readonly processedRows: string;
  readonly totalRows: string | null;
  readonly heartbeatAt: string | null;
  readonly format: string;
  readonly error?: string;
}

class ApiSession {
  private readonly cookies = new Map<string, string>();

  constructor(private readonly baseUrl: string, private readonly origin: string) {}

  private captureCookies(response: Response): void {
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(";", 1)[0];
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator < 1) continue;
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  private headers(input: {
    readonly method: string;
    readonly contentType?: string;
    readonly idempotencyKey?: string;
    readonly extra?: Readonly<Record<string, string>>;
  }): Record<string, string> {
    const headers: Record<string, string> = { Origin: this.origin, ...input.extra };
    if (input.contentType) headers["Content-Type"] = input.contentType;
    if (input.idempotencyKey) headers["Idempotency-Key"] = input.idempotencyKey;
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    if (!["GET", "HEAD"].includes(input.method) && this.cookies.has("rc_csrf")) {
      headers["x-csrf-token"] = decodeURIComponent(this.cookies.get("rc_csrf")!);
    }
    return headers;
  }

  async raw(path: string, input: {
    readonly method?: string;
    readonly body?: BodyInit;
    readonly contentType?: string;
    readonly idempotencyKey?: string;
    readonly headers?: Readonly<Record<string, string>>;
  } = {}): Promise<Response> {
    const method = input.method ?? "GET";
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers({
        method,
        ...(input.contentType ? { contentType: input.contentType } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
        ...(input.headers ? { extra: input.headers } : {}),
      }),
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    this.captureCookies(response);
    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { code?: string };
      throw new Error(`HTTP_${response.status}:${body.code ?? "UNKNOWN"}`);
    }
    return response;
  }

  async json<T>(path: string, input: {
    readonly method?: string;
    readonly body?: unknown;
    readonly idempotencyKey?: string;
  } = {}): Promise<T> {
    const response = await this.raw(path, {
      ...(input.method ? { method: input.method } : {}),
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body), contentType: "application/json" }),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return await response.json() as T;
  }

  async login(phone: string): Promise<void> {
    const challenge = await this.json<{ challengeId: string; sandboxCode?: string }>("/api/v1/auth/otp", {
      method: "POST",
      body: { phone, purpose: "LOGIN", deviceId: "performance-test-drive" },
    });
    const code = challenge.sandboxCode ?? required("SANDBOX_OTP_CODE");
    await this.json("/api/v1/auth/verify", {
      method: "POST",
      body: { challengeId: challenge.challengeId, phone, code, purpose: "LOGIN" },
    });
  }

  async register(phone: string, displayName: string): Promise<void> {
    const challenge = await this.json<{ challengeId: string; sandboxCode?: string }>("/api/v1/auth/otp", {
      method: "POST",
      body: { phone, purpose: "REGISTER", deviceId: "performance-test-drive" },
    });
    const code = challenge.sandboxCode ?? required("SANDBOX_OTP_CODE");
    await this.json("/api/v1/auth/register", {
      method: "POST",
      body: { challengeId: challenge.challengeId, phone, code, purpose: "REGISTER", displayName },
    });
  }
}

function contentType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".csv") return "text/csv";
  if (extension === ".txt") return "text/plain";
  if (extension === ".pdf") return "application/pdf";
  if (extension === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (extension === ".xls") return "application/vnd.ms-excel";
  if (extension === ".zip") return "application/zip";
  return "application/octet-stream";
}

async function localFiles(company: typeof companies[number]): Promise<LocalInputFile[]> {
  const root = join(sampleRoot, company);
  const pending = [root];
  const files: LocalInputFile[] = [];
  while (pending.length) {
    const directory = pending.pop()!;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      const file = await stat(path);
      files.push({
        path,
        relativePath: relative(root, path).replaceAll("\\", "/"),
        bytes: file.size,
        contentType: contentType(path),
        metadataOnly: extname(path).toLowerCase() === ".pdf",
      });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function ensureTestFixture(
  client: PoolClient,
  api: ApiSession,
  phone: string,
  company: typeof companies[number],
): Promise<{ enterpriseId: string; shopId: string }> {
  const administrator = await client.query<{ registered_at: Date | null }>(
    "SELECT registered_at FROM account WHERE phone_e164=$1",
    [phone],
  );
  if (!administrator.rows[0]?.registered_at) {
    await api.register(phone, "性能测试管理员");
  }
  const accountantPhone = "+8619000000002";
  await client.query("BEGIN");
  try {
    const account = await client.query<{ id: string }>(
      `INSERT INTO account(phone_e164,phone_verified_at,display_name,registered_at)
       VALUES($1,clock_timestamp(),'性能测试做账员',clock_timestamp())
       ON CONFLICT(phone_e164) DO UPDATE
         SET registered_at=COALESCE(account.registered_at,EXCLUDED.registered_at),
             phone_verified_at=COALESCE(account.phone_verified_at,EXCLUDED.phone_verified_at)
       RETURNING id`,
      [accountantPhone],
    );
    const accountId = account.rows[0]?.id;
    if (!accountId) throw new Error("PERFORMANCE_TEST_ACCOUNTANT_CREATE_FAILED");
    const role = await client.query<{ role: string }>("SELECT role FROM account_role WHERE account_id=$1 FOR UPDATE", [accountId]);
    if (role.rows[0]) await client.query("UPDATE account_role SET role='ACCOUNTANT' WHERE account_id=$1", [accountId]);
    else await client.query("INSERT INTO account_role(account_id,role) VALUES($1,'ACCOUNTANT')", [accountId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const accountantApi = new ApiSession(process.env.PERF_API_URL ?? "http://127.0.0.1:3011", process.env.PERF_WEB_URL ?? "http://127.0.0.1:5174");
  await accountantApi.login(accountantPhone);
  const enterpriseName = "上传计算下载性能 Test Drive";
  const enterprises = await accountantApi.json<Array<{ id: string; name: string }>>("/api/v1/enterprises");
  let enterpriseId = enterprises.find((item) => item.name === enterpriseName)?.id;
  if (!enterpriseId) {
    enterpriseId = (await accountantApi.json<{ id: string }>("/api/v1/enterprises", {
      method: "POST",
      body: { name: enterpriseName, unifiedSocialCreditCode: "91330100PERF202608" },
    })).id;
  }
  await api.login(phone);
  const fixtureLabel = process.env.PERF_FIXTURE_LABEL?.trim();
  if (fixtureLabel && !/^[A-Za-z0-9_-]{1,32}$/.test(fixtureLabel)) {
    throw new Error("PERF_FIXTURE_LABEL_INVALID");
  }
  const shopName = `性能-${company}${fixtureLabel ? `-${fixtureLabel}` : ""}`;
  const shops = await api.json<Array<{ id: string; name: string }>>(`/api/v1/shops?enterpriseId=${encodeURIComponent(enterpriseId)}`);
  let shopId = shops.find((item) => item.name === shopName)?.id;
  if (!shopId) {
    const applications = await api.json<Array<{ id: string; code: string; status: string }>>("/api/v1/apps");
    const application = applications.find((item) => item.code === "amazon-sales-cost" && item.status === "ACTIVE");
    if (!application) throw new Error("PERFORMANCE_TEST_APPLICATION_NOT_FOUND");
    shopId = (await api.json<{ id: string }>("/api/v1/shops", {
      method: "POST",
      idempotencyKey: `perf-shop-${createHash("sha256").update(`${company}:${fixtureLabel ?? "default"}`).digest("hex").slice(0, 16)}`,
      body: {
        enterpriseId,
        applicationId: application.id,
        name: shopName,
        startDate: "2026-04-01",
        requestedCloseDate: "2027-04-01",
      },
    })).id;
  }
  return { enterpriseId, shopId };
}

async function uploadCompany(api: ApiSession, shopId: string, files: readonly LocalInputFile[]): Promise<{
  batchId: string;
  wallMs: number;
  bytesTransferred: string;
  resumedBytes: string;
  chunkHashMs: number;
  chunks: number;
  requestRetries: number;
}> {
  const started = performance.now();
  const batch = await api.json<{ id: string }>("/api/v1/uploads/batches", {
    method: "POST",
    idempotencyKey: `perf-upload-${randomUUID()}`,
    body: { shopId },
  });
  const registered = new Map<string, string>();
  for (const file of files) {
    const remote = await api.json<{ id: string }>(`/api/v1/uploads/batches/${batch.id}/files`, {
      method: "POST",
      body: {
        relativePath: file.relativePath,
        declaredSize: String(file.metadataOnly ? 0 : file.bytes),
        contentType: file.contentType,
        ...(file.metadataOnly ? { metadataOnly: true } : {}),
      },
    });
    registered.set(file.relativePath, remote.id);
  }
  let transferred = 0n;
  let resumed = 0n;
  let chunkHashMs = 0;
  let chunks = 0;
  const chunkBytes = 16 * 1024 * 1024;
  for (const file of files) {
    if (file.metadataOnly) continue;
    const remoteId = registered.get(file.relativePath);
    if (!remoteId) throw new Error("PERFORMANCE_TEST_REMOTE_FILE_MISSING");
    const offsetResponse = await api.raw(`/api/v1/uploads/files/${remoteId}`, { method: "HEAD" });
    let offset = Number(offsetResponse.headers.get("upload-offset") ?? "-1");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.bytes) throw new Error("PERFORMANCE_TEST_UPLOAD_OFFSET_INVALID");
    resumed += BigInt(offset);
    const handle = await open(file.path, "r");
    try {
      while (offset < file.bytes) {
        const length = Math.min(chunkBytes, file.bytes - offset);
        const buffer = Buffer.allocUnsafe(length);
        const read = await handle.read(buffer, 0, length, offset);
        if (read.bytesRead !== length) throw new Error("PERFORMANCE_TEST_FILE_TRUNCATED");
        const hashStarted = performance.now();
        const checksum = createHash("sha256").update(buffer).digest("base64");
        chunkHashMs += performance.now() - hashStarted;
        const response = await api.raw(`/api/v1/uploads/files/${remoteId}`, {
          method: "PATCH",
          body: buffer,
          contentType: "application/offset+octet-stream",
          headers: {
            "Upload-Offset": String(offset),
            "Upload-Checksum": `sha256 ${checksum}`,
            "Tus-Resumable": "1.0.0",
            "Content-Length": String(length),
          },
        });
        const next = Number(response.headers.get("upload-offset") ?? "-1");
        if (next !== offset + length) throw new Error("PERFORMANCE_TEST_UPLOAD_OFFSET_MISMATCH");
        transferred += BigInt(length);
        chunks += 1;
        offset = next;
      }
    } finally {
      await handle.close();
    }
  }
  const completion = await api.json<{ id: string }>(`/api/v1/uploads/batches/${batch.id}/complete`, { method: "POST" });
  return {
    batchId: completion.id,
    wallMs: performance.now() - started,
    bytesTransferred: transferred.toString(),
    resumedBytes: resumed.toString(),
    chunkHashMs,
    chunks,
    requestRetries: 0,
  };
}

async function awaitPublished(api: ApiSession, shopId: string, batchId: string): Promise<{
  preview: ImportPreview;
  transitions: Array<{ atMs: number; status: string; stage?: string; failureCode?: string | null }>;
}> {
  const started = performance.now();
  const transitions: Array<{ atMs: number; status: string; stage?: string; failureCode?: string | null }> = [];
  let last = "";
  let confirmed = false;
  let exclusionsConfirmed = false;
  for (let attempt = 0; attempt < 2_400; attempt += 1) {
    const preview = await api.json<ImportPreview>(`/api/v1/imports/shops/${shopId}/batches/${batchId}`);
    const key = `${preview.status}:${preview.stage ?? ""}:${preview.failureCode ?? ""}`;
    if (key !== last) {
      transitions.push({
        atMs: performance.now() - started,
        status: preview.status,
        ...(preview.stage ? { stage: preview.stage } : {}),
        ...(preview.failureCode !== undefined ? { failureCode: preview.failureCode } : {}),
      });
      last = key;
    }
    if (preview.status === "READY" && !confirmed) {
      await api.json(`/api/v1/imports/shops/${shopId}/batches/${batchId}/confirm`, {
        method: "POST",
        idempotencyKey: `perf-confirm-${batchId}`,
      });
      confirmed = true;
    } else if (preview.status === "FAILED" && preview.failureCode === "HARD_INCOMPLETE_CONFIRMATION_REQUIRED" && !exclusionsConfirmed) {
      const slices = await api.json<Array<{ datasetVersionId?: string; missingReports?: readonly string[] }>>(`/api/v1/imports/completeness?shopId=${shopId}`);
      const incomplete = slices.filter((slice) => slice.datasetVersionId && (slice.missingReports?.length ?? 0) > 0);
      if (!incomplete.length) throw new Error("PERFORMANCE_TEST_HARD_INCOMPLETE_SLICE_MISSING");
      for (const slice of incomplete) {
        await api.json(`/api/v1/imports/shops/${shopId}/issues/${slice.datasetVersionId}/acknowledge`, {
          method: "POST",
          idempotencyKey: `perf-exclude-${slice.datasetVersionId}`,
          body: { reason: "性能 Test Drive：确认缺失切片不进入正式结果", confirmations: "2" },
        });
      }
      await api.json(`/api/v1/imports/shops/${shopId}/batches/${batchId}/confirm`, {
        method: "POST",
        idempotencyKey: `perf-resume-${batchId}`,
      });
      exclusionsConfirmed = true;
    } else if (preview.status === "PUBLISHED") {
      return { preview, transitions };
    } else if (["FAILED", "CANCELLED", "AWAITING_MAPPING"].includes(preview.status)) {
      throw new Error(`PERFORMANCE_TEST_IMPORT_TERMINAL:${preview.status}:${preview.failureCode ?? ""}`);
    }
    await delay(500);
  }
  throw new Error("PERFORMANCE_TEST_IMPORT_TIMEOUT");
}

async function exportAndDownload(api: ApiSession, shopId: string, company: string): Promise<{
  job: ExportJob;
  transitions: Array<{ atMs: number; stage: string; progress: string; processedRows: string; totalRows: string | null; heartbeatAt: string | null }>;
  generateMs: number;
  headersMs: number;
  firstByteMs: number;
  downloadMs: number;
  bytes: string;
  sha256: string;
  artifact: string;
}> {
  const started = performance.now();
  const created = await api.json<ExportJob>(`/api/v1/shops/${shopId}/exports/current`, {
    method: "POST",
    idempotencyKey: `perf-export-${randomUUID()}`,
    body: { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] },
  });
  const transitions = [];
  let previous = "";
  let job = created;
  for (let attempt = 0; attempt < 2_400; attempt += 1) {
    const jobs = await api.json<ExportJob[]>(`/api/v1/exports?shopId=${shopId}`);
    job = jobs.find((candidate) => candidate.id === created.id) ?? created;
    const key = `${job.stage}:${job.progress}:${job.processedRows}:${job.totalRows ?? ""}:${job.heartbeatAt ?? ""}`;
    if (key !== previous) {
      transitions.push({
        atMs: performance.now() - started,
        stage: job.stage,
        progress: job.progress,
        processedRows: job.processedRows,
        totalRows: job.totalRows,
        heartbeatAt: job.heartbeatAt,
      });
      previous = key;
    }
    if (job.status === "SUCCEEDED") break;
    if (["FAILED", "CANCELLED", "REVOKED"].includes(job.status)) {
      throw new Error(`PERFORMANCE_TEST_EXPORT_TERMINAL:${job.status}:${job.error ?? ""}`);
    }
    await delay(250);
  }
  if (job.status !== "SUCCEEDED") throw new Error("PERFORMANCE_TEST_EXPORT_TIMEOUT");
  const generateMs = performance.now() - started;
  const download = await downloadSucceededJob(api, job, company);
  return {
    job,
    transitions,
    generateMs,
    ...download,
  };
}

async function reuseExportAndDownload(api: ApiSession, shopId: string, expected: ExportJob, company: string): Promise<{
  job: ExportJob;
  lookupMs: number;
  download: Awaited<ReturnType<typeof downloadSucceededJob>>;
}> {
  const started = performance.now();
  const job = await api.json<ExportJob>(`/api/v1/shops/${shopId}/exports/current`, {
    method: "POST",
    idempotencyKey: `perf-export-reuse-${randomUUID()}`,
    body: { profitRate: null, minimumSalesCostRate: null, continentPrefixes: ["EU"] },
  });
  const lookupMs = performance.now() - started;
  if (job.id !== expected.id || job.status !== "SUCCEEDED") throw new Error("PERFORMANCE_TEST_EXPORT_CACHE_MISS");
  return {
    job,
    lookupMs,
    download: await downloadSucceededJob(api, job, `${company}-cache`),
  };
}

async function downloadSucceededJob(api: ApiSession, job: ExportJob, company: string): Promise<{
  headersMs: number;
  firstByteMs: number;
  downloadMs: number;
  bytes: string;
  sha256: string;
  artifact: string;
}> {
  const token = await api.json<{ url: string }>(`/api/v1/exports/${job.id}/download-token`, { method: "POST" });
  const downloadStarted = performance.now();
  const response = await api.raw(token.url);
  const headersMs = performance.now() - downloadStarted;
  const reader = response.body?.getReader();
  if (!reader) throw new Error("PERFORMANCE_TEST_DOWNLOAD_STREAM_MISSING");
  const artifactPath = join(evidenceRoot, `${timestamp()}-${company}-${job.id}.${job.format === "ZIP" ? "zip" : "xlsx"}`);
  const output = await open(artifactPath, "w");
  const hash = createHash("sha256");
  let firstByteMs = 0;
  let bytes = 0n;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (firstByteMs === 0) firstByteMs = performance.now() - downloadStarted;
      hash.update(chunk.value);
      await output.write(chunk.value);
      bytes += BigInt(chunk.value.byteLength);
    }
  } finally {
    await output.close();
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && BigInt(contentLength) !== bytes) throw new Error("PERFORMANCE_TEST_DOWNLOAD_LENGTH_MISMATCH");
  return {
    headersMs,
    firstByteMs,
    downloadMs: performance.now() - downloadStarted,
    bytes: bytes.toString(),
    sha256: hash.digest("hex"),
    artifact: relative(process.cwd(), artifactPath),
  };
}

async function resumeLatestExport(): Promise<void> {
  const baseUrl = process.env.PERF_API_URL ?? "http://127.0.0.1:3011";
  const origin = process.env.PERF_WEB_URL ?? "http://127.0.0.1:5174";
  const phone = required("PERF_ADMIN_PHONE");
  const pool = targetPool();
  const client = await pool.connect();
  try {
    const target = await assertIsolatedTarget(client);
    await client.query(
      "UPDATE account SET registered_at=COALESCE(registered_at,clock_timestamp()) WHERE phone_e164=$1",
      [phone],
    );
    const api = new ApiSession(baseUrl, origin);
    await api.login(phone);
    const latest = await client.query<{ export_id: string; shop_id: string; shop_name: string }>(
      `SELECT request.id export_id,request.shop_id,shop.name shop_name
         FROM export_request request JOIN shop ON shop.id=request.shop_id
        WHERE request.status='SUCCEEDED' AND shop.name LIKE '性能-%'
        ORDER BY request.finished_at DESC,request.id DESC LIMIT 1`,
    );
    const row = latest.rows[0];
    if (!row) throw new Error("PERFORMANCE_TEST_SUCCEEDED_EXPORT_NOT_FOUND");
    const jobs = await api.json<ExportJob[]>(`/api/v1/exports?shopId=${row.shop_id}`);
    const job = jobs.find((candidate) => candidate.id === row.export_id);
    if (!job) throw new Error("PERFORMANCE_TEST_EXPORT_PROJECTION_NOT_FOUND");
    const queue = await client.query<{
      state: string; retry_count: number; retry_limit: number; created_on: Date;
      started_on: Date | null; completed_on: Date | null;
    }>(
      `SELECT state,retry_count,retry_limit,created_on,started_on,completed_on
         FROM pgboss.job WHERE data->>'exportId'=$1 ORDER BY created_on DESC LIMIT 1`,
      [row.export_id],
    );
    const download = await downloadSucceededJob(api, job, row.shop_name.replace(/^性能-/u, ""));
    await emit("stuck-export-recovery", {
      sampledAt: new Date().toISOString(),
      target,
      exportId: row.export_id,
      projection: job,
      queue: queue.rows[0] ?? null,
      download,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

async function verifyLatestRun(): Promise<void> {
  const pool = targetPool();
  const client = await pool.connect();
  try {
    const target = await assertIsolatedTarget(client);
    const latest = await client.query<{
      export_id: string;
      shop_id: string;
      snapshot_id: string;
      import_batch_id: string;
    }>(
      `SELECT request.id export_id,request.shop_id,request.published_snapshot_id snapshot_id,
              (SELECT batch.id FROM import_batch batch
                WHERE batch.shop_id=request.shop_id AND batch.status='RESULT_PUBLISHED'
                ORDER BY batch.created_at DESC,batch.id DESC LIMIT 1) import_batch_id
         FROM export_request request
        WHERE request.status='SUCCEEDED' AND request.published_snapshot_id IS NOT NULL
        ORDER BY request.finished_at DESC,request.id DESC LIMIT 1`,
    );
    const row = latest.rows[0];
    if (!row?.import_batch_id) throw new Error("PERFORMANCE_TEST_COMPLETED_RUN_NOT_FOUND");
    const correctness = await collectRunCorrectness(client, {
      importBatchId: row.import_batch_id,
      shopId: row.shop_id,
      snapshotId: row.snapshot_id,
      exportId: row.export_id,
    });
    await emit("test-drive-correctness", { sampledAt: new Date().toISOString(), target, ...row, correctness });
  } finally {
    client.release();
    await pool.end();
  }
}

async function explainCalculationFxJoin(): Promise<void> {
  const pool = targetPool();
  const client = await pool.connect();
  try {
    const target = await assertIsolatedTarget(client);
    const latest = await client.query<{ calculation_run_id: string }>(
      "SELECT calculation_run_id FROM published_snapshot ORDER BY published_at DESC,id DESC LIMIT 1",
    );
    const runId = latest.rows[0]?.calculation_run_id;
    if (!runId) throw new Error("PERFORMANCE_TEST_CALCULATION_RUN_NOT_FOUND");
    await client.query("BEGIN");
    try {
      const stageStarted = performance.now();
      await client.query(
        `CREATE TEMP TABLE calculation_stage_plan ON COMMIT DROP AS
         SELECT id result_id,fact_kind,fact_id,source_column,component
           FROM calculation_fact_result WHERE calculation_run_id=$1`,
        [runId],
      );
      await client.query(
        "ALTER TABLE calculation_stage_plan ADD UNIQUE(fact_kind,fact_id,source_column,component)",
      );
      await client.query("ANALYZE calculation_stage_plan");
      const stageBuildMs = performance.now() - stageStarted;
      const join = await client.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
         SELECT r.id
           FROM calculation_stage_plan s
           JOIN calculation_fact_result r
             ON r.calculation_run_id=$1 AND r.fact_kind=s.fact_kind AND r.fact_id=s.fact_id
            AND r.source_column=s.source_column AND r.component=s.component`,
        [runId],
      );
      const direct = await client.query(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT result_id FROM calculation_stage_plan",
      );
      const rowCount = await client.query<{ count: string }>("SELECT count(*)::text count FROM calculation_stage_plan");
      await client.query("ROLLBACK");
      await emit("calculation-fx-join-plan", {
        sampledAt: new Date().toISOString(),
        target,
        runId,
        rows: rowCount.rows[0]?.count ?? "0",
        stageBuildMs,
        currentJoin: join.rows[0]?.["QUERY PLAN"] ?? null,
        directResultId: direct.rows[0]?.["QUERY PLAN"] ?? null,
      });
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function prepareFixtureOnly(): Promise<void> {
  const requestedCompany = process.env.PERF_COMPANY ?? companies[0];
  if (!companies.includes(requestedCompany as typeof companies[number])) throw new Error("PERFORMANCE_TEST_COMPANY_INVALID");
  const company = requestedCompany as typeof companies[number];
  const pool = targetPool();
  const client = await pool.connect();
  try {
    const target = await assertIsolatedTarget(client);
    const api = new ApiSession(
      process.env.PERF_API_URL ?? "http://127.0.0.1:3011",
      process.env.PERF_WEB_URL ?? "http://127.0.0.1:5174",
    );
    const fixture = await ensureTestFixture(client, api, required("PERF_ADMIN_PHONE"), company);
    await emit("performance-fixture-prepared", { preparedAt: new Date().toISOString(), target, company, fixture });
  } finally {
    client.release();
    await pool.end();
  }
}

async function runOne(): Promise<void> {
  const requestedCompany = process.env.PERF_COMPANY ?? companies[0];
  if (!companies.includes(requestedCompany as typeof companies[number])) throw new Error("PERFORMANCE_TEST_COMPANY_INVALID");
  const company = requestedCompany as typeof companies[number];
  const baseUrl = process.env.PERF_API_URL ?? "http://127.0.0.1:3011";
  const origin = process.env.PERF_WEB_URL ?? "http://127.0.0.1:5174";
  const phone = required("PERF_ADMIN_PHONE");
  const pool = targetPool();
  const client = await pool.connect();
  try {
    const target = await assertIsolatedTarget(client);
    const api = new ApiSession(baseUrl, origin);
    const fixture = await ensureTestFixture(client, api, phone, company);
    const mappingCount = (await client.query<{ count: string }>(
      "SELECT count(*)::text count FROM field_mapping_version",
    )).rows[0]?.count ?? "0";
    if (mappingCount === "0") throw new Error("PERFORMANCE_TEST_MAPPINGS_REQUIRED");
    const files = await localFiles(company);
    const physicalBytes = files.reduce((sum, file) => sum + BigInt(file.bytes), 0n);
    const declaredBytes = files.reduce((sum, file) => sum + BigInt(file.metadataOnly ? 0 : file.bytes), 0n);
    const profilerGeneration = await resetPerformanceProfiler();
    const beforeUpload = await capturePerformanceCheckpoint(client, profilerGeneration, "before-upload");
    const runStarted = performance.now();
    const upload = await uploadCompany(api, fixture.shopId, files);
    const processingStarted = performance.now();
    const processing = await awaitPublished(api, fixture.shopId, upload.batchId);
    const processingMs = performance.now() - processingStarted;
    const exported = await exportAndDownload(api, fixture.shopId, company);
    const businessEndToEndMs = performance.now() - runStarted;
    const afterExport = await capturePerformanceCheckpoint(client, profilerGeneration, "after-export");
    const cacheReuse = await reuseExportAndDownload(api, fixture.shopId, exported.job, company);
    const afterCacheReuse = await capturePerformanceCheckpoint(client, profilerGeneration, "after-cache-reuse", {
      reuseStorage: afterExport.storage,
    });
    if (cacheReuse.download.sha256 !== exported.sha256 || cacheReuse.download.bytes !== exported.bytes) {
      throw new Error("PERFORMANCE_TEST_EXPORT_CACHE_ARTIFACT_MISMATCH");
    }
    const correctness = await collectRunCorrectness(client, {
      importBatchId: upload.batchId,
      shopId: fixture.shopId,
      snapshotId: exported.job.snapshotId,
      exportId: exported.job.id,
    });
    await emit("test-drive-run", {
      sampledAt: new Date().toISOString(),
      target,
      company,
      fixture: { enterpriseId: fixture.enterpriseId, shopId: fixture.shopId, batchId: upload.batchId, exportId: exported.job.id },
      input: {
        files: files.length,
        physicalBytes: physicalBytes.toString(),
        declaredBytes: declaredBytes.toString(),
        csvTxt: files.filter((file) => [".csv", ".txt"].includes(extname(file.path).toLowerCase())).length,
        pdfMetadataOnly: files.filter((file) => file.metadataOnly).length,
      },
      upload: {
        ...upload,
        throughputMiBPerSecond: Number(upload.bytesTransferred) / 1_048_576 / (upload.wallMs / 1_000),
      },
      processing: { wallMs: processingMs, terminal: processing.preview.status, transitions: processing.transitions },
      export: exported,
      cacheReuse,
      performance: {
        profilerGeneration,
        cacheReuse: summarizePerformanceDelta(afterExport, afterCacheReuse),
        endToEnd: summarizePerformanceDelta(beforeUpload, afterExport),
        stageAttribution: {
          mode: "business-wall-and-worker-events",
          synchronousIntermediateCheckpoints: 0,
        },
      },
      correctness,
      businessEndToEndMs,
      driverWallMs: performance.now() - runStarted,
    });
  } finally {
    client.release();
    await pool.end();
  }
}

const command = process.argv[2];
if (command === "inventory") await inventory();
else if (command === "queue") await queueState();
else if (command === "diagnose-scope") await diagnoseLatestExportScope();
else if (command === "seed-fx") await seedFx();
else if (command === "prepare-schema") await prepareFreshSchema();
else if (command === "prepare-fixture") await prepareFixtureOnly();
else if (command === "run-one") await runOne();
else if (command === "explain-calculation-fx-join") await explainCalculationFxJoin();
else if (command === "resume-latest-export") await resumeLatestExport();
else if (command === "verify-latest") await verifyLatestRun();
else throw new Error(`PERFORMANCE_TEST_COMMAND_INVALID:${basename(process.argv[1] ?? "performance-test-drive.ts")}:${command ?? ""}`);
