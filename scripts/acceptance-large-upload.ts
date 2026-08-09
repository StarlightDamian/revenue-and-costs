import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { Pool } from "pg";

const chunkBytes = 16 * 1024 * 1024;
const totalBytes = BigInt(process.env.ACCEPTANCE_BYTES ?? String(2n * 1024n * 1024n * 1024n));
const stopAfterChunks = Number(process.env.STOP_AFTER_CHUNKS ?? "0");
const databaseUrl = process.env.ACCEPTANCE_DATABASE_URL;
const apiOrigin = process.env.ACCEPTANCE_API_ORIGIN ?? "http://127.0.0.1:3011";
const publicOrigin = process.env.ACCEPTANCE_PUBLIC_ORIGIN ?? "http://127.0.0.1:5173";
const statePath = resolve(process.env.ACCEPTANCE_STATE_PATH ?? ".work/acceptance/large-upload-state.json");
if (!databaseUrl) throw new Error("ACCEPTANCE_DATABASE_URL_REQUIRED");
if (totalBytes <= 0n || totalBytes > 2n * 1024n * 1024n * 1024n) throw new Error("ACCEPTANCE_BYTES_INVALID");

interface State { batchId: string; fileId: string; shopId: string; totalBytes: string }

async function requestJson(url: string, init: RequestInit): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await fetch(url, init);
  const text = await response.text();
  const body = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) throw new Error(`HTTP_${response.status}:${String(body.code ?? "UNKNOWN")}`);
  return { response, body };
}

const pool = new Pool({ connectionString: databaseUrl });
try {
  const account = await pool.query<{ phone_e164: string }>(
    `SELECT a.phone_e164 FROM account a JOIN account_role r ON r.account_id=a.id
      WHERE r.role='ADMIN' AND a.status='ACTIVE' ORDER BY a.created_at LIMIT 1`,
  );
  const shop = await pool.query<{ id: string }>("SELECT id FROM shop WHERE status='ACTIVE' ORDER BY created_at LIMIT 1");
  const phone = account.rows[0]?.phone_e164;
  const shopId = shop.rows[0]?.id;
  if (!phone || !shopId) throw new Error("ACCEPTANCE_ACCOUNT_OR_SHOP_MISSING");

  const otp = await requestJson(`${apiOrigin}/api/v1/auth/otp`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone, purpose: "LOGIN", deviceId: "acceptance-large-upload" }),
  });
  const verified = await requestJson(`${apiOrigin}/api/v1/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ challengeId: otp.body.challengeId, phone, purpose: "LOGIN", code: otp.body.sandboxCode }),
  });
  const cookies = verified.response.headers.getSetCookie().map((value) => value.split(";", 1)[0]!);
  const cookie = cookies.join("; ");
  const csrf = decodeURIComponent(cookies.find((value) => value.startsWith("rc_csrf="))?.slice("rc_csrf=".length) ?? "");
  const readHeaders = { cookie };
  const commandHeaders = { cookie, origin: publicOrigin, "x-csrf-token": csrf };
  const jsonCommandHeaders = { ...commandHeaders, "content-type": "application/json" };

  let state: State;
  try {
    state = JSON.parse(await readFile(statePath, "utf8")) as State;
    if (state.totalBytes !== totalBytes.toString() || state.shopId !== shopId) throw new Error("ACCEPTANCE_STATE_MISMATCH");
  } catch (error) {
    if (error instanceof Error && error.message === "ACCEPTANCE_STATE_MISMATCH") throw error;
    const batch = await requestJson(`${apiOrigin}/api/v1/uploads/batches`, {
      method: "POST", headers: { ...jsonCommandHeaders, "idempotency-key": `large-${totalBytes}-${randomUUID()}` }, body: JSON.stringify({ shopId }),
    });
    const file = await requestJson(`${apiOrigin}/api/v1/uploads/batches/${String(batch.body.id)}/files`, {
      method: "POST", headers: jsonCommandHeaders,
      body: JSON.stringify({ relativePath: `synthetic-${totalBytes}.bin`, declaredSize: totalBytes.toString(), contentType: "application/octet-stream" }),
    });
    state = { batchId: String(batch.body.id), fileId: String(file.body.id), shopId, totalBytes: totalBytes.toString() };
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");
  }

  const head = await fetch(`${apiOrigin}/api/v1/uploads/files/${state.fileId}`, { method: "HEAD", headers: readHeaders });
  if (!head.ok) throw new Error(`HEAD_${head.status}`);
  let offset = BigInt(head.headers.get("upload-offset") ?? "0");
  const fullChunk = Buffer.alloc(chunkBytes, 0x30);
  const latencies: number[] = [];
  let sentChunks = 0;
  while (offset < totalBytes) {
    const remaining = totalBytes - offset;
    const body = remaining < BigInt(chunkBytes) ? fullChunk.subarray(0, Number(remaining)) : fullChunk;
    const checksum = createHash("sha256").update(body).digest("base64");
    const started = performance.now();
    const response = await fetch(`${apiOrigin}/api/v1/uploads/files/${state.fileId}`, {
      method: "PATCH",
      headers: { ...commandHeaders, "content-type": "application/offset+octet-stream", "content-length": String(body.byteLength), "upload-offset": offset.toString(), "upload-checksum": `sha256 ${checksum}`, "tus-resumable": "1.0.0" },
      body,
    });
    latencies.push(performance.now() - started);
    if (!response.ok) throw new Error(`PATCH_${response.status}:${await response.text()}`);
    offset = BigInt(response.headers.get("upload-offset") ?? "-1");
    sentChunks += 1;
    if (sentChunks % 32 === 0) process.stdout.write(`${JSON.stringify({ progressBytes: offset.toString(), totalBytes: totalBytes.toString() })}\n`);
    if (stopAfterChunks > 0 && sentChunks >= stopAfterChunks) {
      process.stdout.write(`${JSON.stringify({ paused: true, offset: offset.toString(), statePath })}\n`);
      process.exitCode = 75;
      break;
    }
  }
  if (offset === totalBytes) {
    const completed = await requestJson(`${apiOrigin}/api/v1/uploads/batches/${state.batchId}/complete`, { method: "POST", headers: commandHeaders });
    latencies.sort((left, right) => left - right);
    const percentile = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
    process.stdout.write(`${JSON.stringify({ completed: true, batchId: state.batchId, importBatchId: completed.body.id, bytes: offset.toString(), chunksThisRun: sentChunks, patchP95Ms: Math.round(percentile) })}\n`);
  }
} finally {
  await pool.end();
}
