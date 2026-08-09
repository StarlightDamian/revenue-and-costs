import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const suitePath = process.argv[2] ? resolve(process.argv[2]) : undefined;
if (!suitePath) throw new Error("PERFORMANCE_SUITE_PATH_REQUIRED");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/u, ""));
}

const suite = readJson(suitePath);
if (suite.status !== "SUCCEEDED") throw new Error("PERFORMANCE_SUITE_INCOMPLETE");

function evidencePath(path) {
  return isAbsolute(path) ? path : join(projectRoot, path);
}

function resource(run, role) {
  return run.performance.endToEnd.resources.find((item) => item.role === role);
}

const metrics = {
  businessEndToEndMs: (run) => run.businessEndToEndMs,
  driverWallMs: (run) => run.driverWallMs,
  observerOverheadMs: (run) => run.driverWallMs - run.businessEndToEndMs,
  uploadWallMs: (run) => run.upload.wallMs,
  uploadThroughputMiBPerSecond: (run) => run.upload.throughputMiBPerSecond,
  processingWallMs: (run) => run.processing.wallMs,
  exportGenerateMs: (run) => run.export.generateMs,
  exportFirstByteMs: (run) => run.export.firstByteMs,
  exportDownloadMs: (run) => run.export.downloadMs,
  cacheLookupMs: (run) => run.cacheReuse.lookupMs,
  cacheFirstByteMs: (run) => run.cacheReuse.download.firstByteMs,
  cacheDownloadMs: (run) => run.cacheReuse.download.downloadMs,
  apiCpuMs: (run) => (resource(run, "api")?.cpuUserMs ?? 0) + (resource(run, "api")?.cpuSystemMs ?? 0),
  workerCpuMs: (run) => (resource(run, "worker")?.cpuUserMs ?? 0) + (resource(run, "worker")?.cpuSystemMs ?? 0),
  apiPeakRssBytes: (run) => resource(run, "api")?.peakRssBytes ?? 0,
  workerPeakRssBytes: (run) => resource(run, "worker")?.peakRssBytes ?? 0,
  sqlCount: (run) => run.performance.endToEnd.sql.count,
  sqlTotalMs: (run) => run.performance.endToEnd.sql.totalMs,
  walBytes: (run) => Number(run.performance.endToEnd.database.walBytes),
  tempBytes: (run) => Number(run.performance.endToEnd.database.tempBytes),
  databaseBytesDelta: (run) => Number(run.performance.endToEnd.database.databaseBytesDelta),
};

function statistics(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    values,
    min: sorted[0],
    median,
    p95Descriptive: sorted[Math.ceil(sorted.length * 0.95) - 1],
    populationStddev: Math.sqrt(variance),
  };
}

function correctnessSignature(run) {
  const financial = { ...run.correctness.financial };
  delete financial.calculationRunId;
  const payload = JSON.stringify({
    input: run.input,
    files: run.correctness.files,
    facts: run.correctness.facts,
    slices: run.correctness.slices,
    financial,
  });
  return createHash("sha256").update(payload).digest("hex");
}

const companies = [...new Set(suite.samples.map((sample) => sample.company))];
const summary = {
  schemaVersion: 1,
  suiteId: suite.suiteId,
  sampledAt: new Date().toISOString(),
  sourceFingerprint: suite.sourceFingerprint,
  p95Qualification: "descriptive-nearest-rank-only-not-reliable-tail-estimate",
  companies: [],
};

for (const company of companies) {
  const warmups = suite.samples.filter((sample) => sample.company === company && sample.phase === "warmup" && sample.status === "SUCCEEDED");
  const measured = suite.samples.filter((sample) => sample.company === company && sample.phase === "measure" && sample.status === "SUCCEEDED")
    .sort((left, right) => left.ordinal - right.ordinal);
  if (warmups.length !== 1 || measured.length !== Number(suite.measurements)) {
    throw new Error(`PERFORMANCE_COMPANY_SAMPLE_COUNT_INVALID:${company}`);
  }
  const runs = measured.map((sample) => readJson(evidencePath(sample.runEvidence)));
  const signatures = runs.map(correctnessSignature);
  const cacheReuseVerified = runs.every((run) =>
    run.export.job.id === run.cacheReuse.job.id
    && run.export.bytes === run.cacheReuse.download.bytes
    && run.export.sha256 === run.cacheReuse.download.sha256);
  summary.companies.push({
    company,
    warmupEvidence: warmups[0].runEvidence,
    measuredEvidence: measured.map((sample) => sample.runEvidence),
    correctness: {
      stable: new Set(signatures).size === 1,
      signatures,
      cacheReuseVerified,
    },
    metrics: Object.fromEntries(Object.entries(metrics).map(([name, select]) => [name, statistics(runs.map(select))])),
  });
}

if (summary.companies.some((company) => !company.correctness.stable || !company.correctness.cacheReuseVerified)) {
  throw new Error("PERFORMANCE_CORRECTNESS_DRIFT");
}
const outputPath = join(dirname(suitePath), `${suite.suiteId}-summary.json`);
writeFileSync(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ summary: relative(projectRoot, outputPath), suite: basename(suitePath) })}\n`);
