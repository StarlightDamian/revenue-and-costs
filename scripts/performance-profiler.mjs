import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { setInterval } from "node:timers";

import pg from "pg";

const outputDirectory = process.env.PERF_PROFILER_DIR?.trim();
if (!outputDirectory) process.exitCode = process.exitCode ?? 0;

if (outputDirectory) {
  const resolvedOutput = resolve(outputDirectory);
  const role = process.env.PERF_PROCESS_ROLE?.trim() || "unknown";
  const controlPath = join(resolvedOutput, "control.json");
  const outputPath = join(resolvedOutput, `${role}-${process.pid}.json`);
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  const statements = new Map();
  const samples = [];
  const originalQuery = pg.Client.prototype.query;
  let generation = "startup";
  let resetAt = new Date().toISOString();
  let baselineCpu = process.cpuUsage();
  let peakRssBytes = process.memoryUsage().rss;
  let flushing = false;

  function normalizedSql(input) {
    const text = typeof input === "string" ? input : input && typeof input.text === "string" ? input.text : "[query-object]";
    return text
      .replace(/\/\*[\s\S]*?\*\//gu, " ")
      .replace(/--[^\r\n]*/gu, " ")
      .replace(/'(?:''|[^'])*'/gu, "'?'")
      .replace(/\b\d+(?:\.\d+)?\b/gu, "?")
      .replace(/\s+/gu, " ")
      .trim()
      .slice(0, 2_000);
  }

  function record(input, started, error, result) {
    const sql = normalizedSql(input);
    const hash = createHash("sha256").update(sql).digest("hex").slice(0, 16);
    const durationMs = performance.now() - started;
    const rowCount = Array.isArray(result)
      ? result.reduce((sum, item) => sum + (Number(item?.rowCount) || 0), 0)
      : Number(result?.rowCount) || 0;
    const current = statements.get(hash) ?? {
      hash,
      sql,
      count: 0,
      errorCount: 0,
      rowCount: 0,
      totalMs: 0,
      maxMs: 0,
    };
    current.count += 1;
    current.errorCount += error ? 1 : 0;
    current.rowCount += rowCount;
    current.totalMs += durationMs;
    current.maxMs = Math.max(current.maxMs, durationMs);
    statements.set(hash, current);
  }

  if (!pg.Client.prototype.__performanceProfilerWrapped) {
    Object.defineProperty(pg.Client.prototype, "__performanceProfilerWrapped", { value: true });
    pg.Client.prototype.query = function profiledQuery(...args) {
      const started = performance.now();
      let recorded = false;
      const recordOnce = (error, result) => {
        if (recorded) return;
        recorded = true;
        record(args[0], started, error, result);
      };
      const callbackIndex = typeof args.at(-1) === "function" ? args.length - 1 : -1;
      if (callbackIndex >= 0) {
        const callback = args[callbackIndex];
        args[callbackIndex] = function profiledCallback(error, result) {
          recordOnce(error, result);
          return callback.apply(this, arguments);
        };
      }
      try {
        const query = originalQuery.apply(this, args);
        if (callbackIndex < 0 && query && typeof query.then === "function") {
          return query.then(
            (result) => {
              recordOnce(null, result);
              return result;
            },
            (error) => {
              recordOnce(error);
              throw error;
            },
          );
        }
        if (callbackIndex < 0 && query && typeof query.once === "function") {
          query.once("end", (result) => recordOnce(null, result));
          query.once("error", (error) => recordOnce(error));
        }
        return query;
      } catch (error) {
        recordOnce(error);
        throw error;
      }
    };
  }

  async function refreshControl() {
    let control;
    try {
      control = JSON.parse(await readFile(controlPath, "utf8"));
    } catch {
      return;
    }
    if (typeof control.generation !== "string" || control.generation === generation) return;
    generation = control.generation;
    resetAt = new Date().toISOString();
    baselineCpu = process.cpuUsage();
    peakRssBytes = process.memoryUsage().rss;
    statements.clear();
    samples.length = 0;
  }

  async function flush() {
    if (flushing) return;
    flushing = true;
    try {
      await mkdir(resolvedOutput, { recursive: true });
      await refreshControl();
      const memory = process.memoryUsage();
      const cpu = process.cpuUsage(baselineCpu);
      const resources = process.resourceUsage();
      peakRssBytes = Math.max(peakRssBytes, memory.rss);
      samples.push({
        at: new Date().toISOString(),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        externalBytes: memory.external,
        cpuUserMs: cpu.user / 1_000,
        cpuSystemMs: cpu.system / 1_000,
      });
      if (samples.length > 4_800) samples.splice(0, samples.length - 4_800);
      const metrics = [...statements.values()].sort((left, right) => right.totalMs - left.totalMs);
      const output = {
        schemaVersion: 1,
        generation,
        resetAt,
        sampledAt: new Date().toISOString(),
        role,
        pid: process.pid,
        argv: process.argv.slice(1),
        process: {
          rssBytes: memory.rss,
          peakRssBytes,
          heapUsedBytes: memory.heapUsed,
          externalBytes: memory.external,
          cpuUserMs: cpu.user / 1_000,
          cpuSystemMs: cpu.system / 1_000,
          fsReadOperations: resources.fsRead,
          fsWriteOperations: resources.fsWrite,
          voluntaryContextSwitches: resources.voluntaryContextSwitches,
          involuntaryContextSwitches: resources.involuntaryContextSwitches,
        },
        samples,
        sql: {
          count: metrics.reduce((sum, item) => sum + item.count, 0),
          errorCount: metrics.reduce((sum, item) => sum + item.errorCount, 0),
          totalMs: metrics.reduce((sum, item) => sum + item.totalMs, 0),
          statements: metrics,
        },
      };
      await writeFile(temporaryPath, `${JSON.stringify(output)}\n`, "utf8");
      await rename(temporaryPath, outputPath);
    } finally {
      flushing = false;
    }
  }

  await mkdir(resolvedOutput, { recursive: true });
  await flush();
  const interval = setInterval(() => void flush(), 250);
  interval.unref();
  process.once("beforeExit", () => void flush());
}
