import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

async function runPackagePolicy(previousPackage: unknown, nextPackage: unknown) {
  const remote = await readFile("bin/push-remote.sh", "utf8");
  const policy = remote.match(/<<'NODE_PACKAGE_POLICY'\r?\n([\s\S]*?)\r?\nNODE_PACKAGE_POLICY/);
  expect(policy, "embedded package policy must be executable by the pinned Node runtime").not.toBeNull();

  const directory = await mkdtemp(join(tmpdir(), "revenue-costs-package-policy-"));
  const previousPath = join(directory, "previous.json");
  const nextPath = join(directory, "next.json");
  try {
    await writeFile(previousPath, JSON.stringify(previousPackage), "utf8");
    await writeFile(nextPath, JSON.stringify(nextPackage), "utf8");
    return spawnSync(process.execPath, ["-", previousPath, nextPath], {
      input: policy?.[1] ?? "",
      encoding: "utf8",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const baselinePackage = {
  name: "revenue-and-costs",
  version: "0.1.0",
  private: true,
  type: "module",
  packageManager: "pnpm@9.15.4",
  pnpm: { overrides: { "example@<2": "1.9.0" } },
  engines: { node: ">=24 <25", pnpm: ">=9.15 <10" },
  scripts: { build: "old-build", test: "vitest run" },
  dependencies: { fastify: "5.7.4" },
  devDependencies: { typescript: "5.9.3" },
};

describe("one-click code release guardrails", () => {
  it("keeps dry-run entirely before any network operation", async () => {
    const script = await readFile("bin/push.ps1", "utf8");

    expect(script).toContain("[switch]$DryRun");
    expect(script).not.toMatch(/SkipVerify|AllowMigrations|\[switch\]\$Force/);
    expect(script.indexOf("if ($DryRun)")).toBeGreaterThan(script.indexOf("Assert-Archive $dependencyArchive 'dependencies'"));
    expect(script.indexOf("if ($DryRun)")).toBeLessThan(script.indexOf("ssh-keyscan.exe -p"));
    expect(script.indexOf("if ($DryRun)")).toBeLessThan(script.indexOf("Read-EnvFile $credentialSource"));
    expect(script).toContain("Remote SSH/SCP calls: 0");
  });

  it("packages only app inputs and a matching verified Linux dependency baseline", async () => {
    const script = await readFile("bin/push.ps1", "utf8");

    expect(script).toContain("'^app(/(dist|migrations)");
    expect(script).toContain("'package.json', 'pnpm-lock.yaml', 'pnpm-store', 'tools'");
    expect(script).toContain("Find-PinnedArtifact $baseArchiveSha");
    expect(script).not.toContain("release-bundle-*");
    expect(script).toContain("PNPM_BASELINE_VERSION_MISMATCH");
    expect(script).toContain("DEPLOY_CREDENTIAL_SOURCE_MUST_BE_EXTERNAL");
    expect(script).toContain("ARCHIVE_FORBIDDEN_ENTRY");
    expect(script).toContain("DEPLOY_ACTIVE_ARCHIVE_HASH_MISMATCH");
    expect(script).toContain("$program | & node.exe - $ExpectedPath $ActualPath");
  });

  it("binds every release to a clean local main that matches GitHub main", async () => {
    const script = await readFile("bin/push.ps1", "utf8");

    expect(script).toContain("DEPLOY_GIT_WORKTREE_DIRTY");
    expect(script).toContain("DEPLOY_GIT_BRANCH_NOT_MAIN");
    expect(script).toContain("DEPLOY_GIT_REMOTE_MAIN_MISMATCH");
    expect(script).toContain("git.exe status --porcelain=v1 --untracked-files=all");
    expect(script).toContain("git.exe branch --show-current");
    expect(script).toContain("git.exe rev-parse HEAD");
    expect(script).toContain("git.exe ls-remote --exit-code origin refs/heads/main");
    expect(script).toContain("$gitCommit");
    expect(script).toContain("DEPLOY_GIT_COMMIT_CHANGED");
    expect(script.match(/Assert-GitReleaseCommit \$gitCommit/gu)).toHaveLength(2);
  });

  it("persists the Git and archive provenance locally and in the remote release", async () => {
    const script = await readFile("bin/push.ps1", "utf8");
    const remote = await readFile("bin/push-remote.sh", "utf8");

    expect(script).toContain("revenue-costs-release-receipt-v1");
    expect(script).toContain("release-$releaseId.receipt.json");
    expect(script).toContain("release-$releaseId.tar.gz.partial");
    expect(script).toContain("deploymentAcceptance = 'passed'");
    expect(script).toContain("$dependencySha");
    expect(script).toContain("$gitCommit");
    expect(remote).toContain('[[ "$#" -eq 15 ]]');
    expect(remote).toContain('git_commit="${14}"');
    expect(remote).toContain('expected_current_release="${15}"');
    expect(remote).toContain('[[ "$git_commit" =~ ^[a-f0-9]{40}$ ]]');
    expect(remote).toContain('receipt="$staging/.release-receipt.json"');
    expect(remote).toContain("revenue-costs-release-receipt-v1");
    expect(remote).toContain('"deploymentAcceptance":"passed"');
    expect(remote.indexOf('receipt="$staging/.release-receipt.json"')).toBeLessThan(
      remote.indexOf('find "$staging" -type f -exec chmod 0640 {} +'),
    );
  });

  it("marks acceptance passed only after strict auth, worker, capacity, and stability checks", async () => {
    const remote = await readFile("bin/push-remote.sh", "utf8");
    const acceptancePassed = remote.lastIndexOf('"deploymentAcceptance":"passed"');

    expect(remote).toContain('health_once "$public_url/health/ready" degraded');
    expect(remote).toContain("anonymous_me_once");
    expect(remote).toContain("authenticated_me_once");
    expect(remote).toContain("worker_heartbeat_once");
    expect(remote).toContain("connection_budget_once");
    expect(remote).toContain("stability_deadline=$((SECONDS + 90))");
    expect(remote).toContain('await request("/api/v1/me", { headers: { cookie } }, 401);');
    expect(remote).toContain("RELEASE_RUNTIME_LOG_UNAVAILABLE");
    expect(remote).toContain("RELEASE_RUNTIME_ERROR_DETECTED");
    expect(remote).toContain("release_journal_since=\"$(date '+%Y-%m-%d %H:%M:%S')\"");
    expect(remote).toContain('journalctl -u "$api_service" -u "$worker_service" --since "$release_journal_since" --no-pager --output=cat > "$runtime_log"');
    expect(remote).toContain("grep -Eiq");
    expect(remote).not.toContain("--output=cat |\n    grep -Eiq");
    expect(acceptancePassed).toBeGreaterThan(remote.indexOf("stability_deadline=$((SECONDS + 90))"));
    expect(acceptancePassed).toBeGreaterThan(remote.indexOf("authenticated_me_once ||"));
  });

  it("passes the release timestamp to the worker heartbeat query through psql stdin", async () => {
    const remote = await readFile("bin/push-remote.sh", "utf8");
    const heartbeat = remote.slice(
      remote.indexOf("worker_heartbeat_once() {"),
      remote.indexOf("connection_budget_once() {"),
    );

    expect(heartbeat).toContain('-v started_at="$release_started_at" -f - <<\'WORKER_HEARTBEAT_SQL\'');
    expect(heartbeat).toContain("last_heartbeat_at > :'started_at'::timestamptz");
    expect(heartbeat).toContain(')" || return 1');
    expect(heartbeat).not.toMatch(/\s-c\s/gu);
  });

  it("publishes the passed receipt only at an interruption-safe success boundary", async () => {
    const remote = await readFile("bin/push-remote.sh", "utf8");
    const preCommitMetadataCleanup = 'rm -f "$target/.release-migrations"';
    const rollbackEvidenceCleanup = 'if ! rm -f "$target/.previous-migrations"; then';
    const ignoreSignals = "trap '' HUP INT TERM";
    const receiptPreparation = 'receipt_partial="$target/.release-receipt.json.partial"';
    const receiptPublish = 'mv -f "$receipt_partial" "$target/.release-receipt.json"';
    const successMark = "success=1";
    const releaseTraps = "trap - EXIT HUP INT TERM";
    const acceptanceEnd = remote.indexOf('echo "RELEASE_OK:$target/app"');

    for (const marker of [
      preCommitMetadataCleanup,
      rollbackEvidenceCleanup,
      ignoreSignals,
      receiptPreparation,
      receiptPublish,
      successMark,
    ]) {
      expect(remote).toContain(marker);
    }
    expect(remote.indexOf(preCommitMetadataCleanup)).toBeLessThan(remote.indexOf(ignoreSignals));
    expect(remote.indexOf(ignoreSignals)).toBeLessThan(remote.indexOf(receiptPreparation));
    expect(remote.indexOf(receiptPublish)).toBeLessThan(remote.indexOf(successMark));
    expect(
      remote.slice(remote.indexOf(receiptPublish) + receiptPublish.length, remote.indexOf(successMark)).trim(),
    ).toBe("");
    const releaseTrapsIndex = remote.lastIndexOf(releaseTraps, acceptanceEnd);
    expect(remote.indexOf(successMark)).toBeLessThan(releaseTrapsIndex);
    expect(releaseTrapsIndex).toBeLessThan(remote.indexOf(rollbackEvidenceCleanup));
    expect(remote.slice(releaseTrapsIndex, acceptanceEnd)).toContain("RELEASE_METADATA_CLEANUP_WARNING");

    const uninterruptibleCommit = remote.slice(remote.indexOf(ignoreSignals), remote.indexOf(successMark));
    expect(uninterruptibleCommit).not.toContain("trap - EXIT");
    expect(uninterruptibleCommit).not.toContain("trap '' EXIT");
  });

  it("allows only append-only migrations after draining work and taking a recoverable backup", async () => {
    const remote = await readFile("bin/push-remote.sh", "utf8");

    expect(remote).toContain("MIGRATION_HISTORY_REMOVED");
    expect(remote).toContain("MIGRATION_HISTORY_CHANGED");
    expect(remote).toContain("DATABASE_MIGRATION_BASELINE_MISMATCH");
    expect(remote).toContain("DATABASE_MIGRATION_MANIFEST_MISMATCH");
    expect(remote).toContain('[[ -d "$previous_app" && -f "$previous_app/package.json" && -f "$previous_app/pnpm-lock.yaml" ]]');
    expect(remote).toContain('validate_package_change "$previous_app/package.json" "$staging/package.json"');
    expect(remote).toContain('"$node_root/bin/node" - "$1" "$2"');
    expect(remote).not.toContain('cmp -s "$previous_app/package.json" "$staging/package.json"');
    expect(remote).toContain('cmp -s "$staging/package.json" "$staging/app/package.json"');
    expect(remote).toContain('cmp -s "$previous_app/pnpm-lock.yaml" "$staging/pnpm-lock.yaml"');
    expect(remote).toContain('cmp -s "$staging/pnpm-lock.yaml" "$staging/app/pnpm-lock.yaml"');
    expect(remote).not.toContain('previous_release=');
    const executableRestore = 'find "$staging/pnpm-store" -type f -name \'*-exec\' -exec chmod 0750 {} +';
    expect(remote).toContain(executableRestore);
    expect(remote.indexOf(executableRestore)).toBeLessThan(remote.indexOf('--store-dir "$staging/pnpm-store" install'));
    expect(remote).toContain('resolved_target="$(realpath -m -- "$link")"');
    const databaseManifest = '> "$staging/.database-migrations"';
    const permissionNormalization = 'find "$staging" -type f -exec chmod 0640 {} +';
    const stagingMove = 'mv "$staging" "$target"';
    expect(remote).toContain(databaseManifest);
    expect(remote).toContain(permissionNormalization);
    expect(remote.indexOf(permissionNormalization)).toBeGreaterThan(remote.indexOf(databaseManifest));
    expect(remote.indexOf(permissionNormalization)).toBeLessThan(remote.indexOf(stagingMove));
    expect(remote.slice(remote.indexOf(permissionNormalization), remote.indexOf(stagingMove))).not.toContain('> "$staging/');
    expect(remote).toContain('find "$staging" \\( -type f -o -type d \\) -perm /0022');
    expect(remote).not.toContain('find "$staging" -perm /0022');
    expect(remote).toContain("trap cleanup EXIT");
    expect(remote).not.toContain("trap cleanup EXIT ERR");
    expect(remote).toContain("pg_dump");
    expect(remote).toContain("pg_restore_bin");
    expect(remote).toContain("mv -Tf \"$rollback_link\" \"$current_link\"");
    expect(remote).toContain("http://127.0.0.1:$api_port/health/ready");
    expect(remote).toContain("$public_url/health/ready");
    expect(remote).toContain('--resolve "$public_host:443:127.0.0.1"');
    const releaseMetadataCleanup = 'if ! rm -f "$target/.previous-migrations"; then';
    expect(remote.indexOf(releaseMetadataCleanup)).toBeGreaterThan(remote.indexOf("PUBLIC_INDEX_MISMATCH"));
    expect(remote.indexOf(releaseMetadataCleanup)).toBeGreaterThan(remote.indexOf("success=1"));
    expect(remote).not.toMatch(/bootstrap-admin|assert-production-initial-state/);
    expect(remote).toContain("ACTIVE_CALCULATIONS_REQUIRE_DRAIN");
    expect(remote).toContain("ACTIVE_IMPORTS_REQUIRE_DRAIN");
    expect(remote).toContain("dist/cli/migrate.js");
    expect(remote).toContain("dist/cli/bootstrap-mappings.js");
    expect(remote).toContain("REQUIRE_BOOTSTRAP_MAPPINGS=true");
    expect(remote).toContain('migrator_env="$config_root/database-migrator.env"');
    expect(remote).toContain("DATABASE_MIGRATOR_CONFIG_INVALID");
    expect(remote).toContain('assert_database_identity revenue_costs_migrator revenue_costs_owner owner "$database_name" "$database_server_identity"');
    expect(remote).toContain('assert_database_identity revenue_costs_app revenue_costs_app application "$database_name" "$database_server_identity"');
    expect(remote).toContain("DATABASE_RELEASE_IDENTITY_MISMATCH");
    expect(remote).toContain("DATABASE_IDENTITY_EXPECTED_DATABASE");
    expect(remote).toContain("DATABASE_IDENTITY_EXPECTED_SERVER");
    expect(remote).toContain("pg_postmaster_start_time()");
    expect(remote).toContain("server_is_local");
    expect(remote).toContain("row?.server_is_local === true");
    expect(remote).toContain("session_has_limited_owner_membership");
    expect(remote).toContain("session_membership_count === 0");
    expect(remote).toContain("unset DATABASE_URL PGOPTIONS");
    expect(remote).not.toMatch(/GRANT\s+(?:CREATE|revenue_costs_owner)|ALTER\s+ROLE/iu);
    expect(remote.indexOf('runuser -u postgres -- "$pg_dump_bin"')).toBeLessThan(remote.indexOf("dist/cli/migrate.js"));
    expect(remote.indexOf('source "$migrator_env"')).toBeLessThan(remote.indexOf("dist/cli/migrate.js"));
    expect(remote.indexOf("dist/cli/migrate.js")).toBeLessThan(remote.indexOf('source "$config_root/database-app.env"'));
    expect(remote.indexOf('source "$config_root/database-app.env"')).toBeLessThan(remote.indexOf("dist/cli/bootstrap-mappings.js"));
    expect(remote).toContain("RELEASE_FAILED_AFTER_MIGRATION_SERVICES_STOPPED");
    expect(remote).toContain('initial_api_state="$(systemctl show --property=ActiveState --value "$api_service")"');
    expect(remote).toContain('initial_worker_state="$(systemctl show --property=ActiveState --value "$worker_service")"');
    expect(remote).toContain('restore_initial_service_state "$api_service" "$initial_api_state"');
    expect(remote).toContain('restore_initial_service_state "$worker_service" "$initial_worker_state"');
    expect(remote).not.toContain('systemctl restart "$api_service" "$worker_service"');
    const migratedFailure = remote.slice(
      remote.indexOf("# The forward migration is committed and immutable."),
      remote.indexOf("fi\n  fi", remote.indexOf("# The forward migration is committed and immutable.")),
    );
    expect(migratedFailure).toContain('systemctl stop "$api_service" "$worker_service"');
    expect(migratedFailure).toContain("systemctl show --property=ActiveState --value");
    expect(migratedFailure).toContain('"$api_state" =~ ^(inactive|failed)$');
    expect(migratedFailure).toContain("RELEASE_FAILED_AFTER_MIGRATION_SERVICE_STOP_FAILED");
    expect(remote).toContain("database_matches_previous");
    expect(remote).toContain("RESULT_PUBLISHED','FAILED','CANCELLED");
    expect(remote).toContain("tar --no-same-owner --no-same-permissions");
    expect(remote).toContain("umask 027");
    expect(remote.indexOf("umask 027")).toBeLessThan(remote.indexOf('migration_manifest "$previous_app/migrations"'));
    expect(remote).toContain("payload.service !== \"api\"");
    expect(remote).toContain("setfacl -R -m u:www:r-X");
  });

  it("does not stop services or switch current while handling a pre-stop failure", async () => {
    const remote = await readFile("bin/push-remote.sh", "utf8");
    const cleanup = remote.slice(remote.indexOf("cleanup() {"), remote.indexOf("trap cleanup EXIT"));
    const preStopGuard = cleanup.indexOf('if [[ "$services_stopped" != \'1\' ]]; then');
    const databaseRollbackCheck = cleanup.indexOf("database_matches_previous=0");

    expect(preStopGuard).toBeGreaterThan(0);
    expect(preStopGuard).toBeLessThan(databaseRollbackCheck);
    expect(cleanup.slice(preStopGuard, databaseRollbackCheck)).toContain('exit "$status"');
    expect(cleanup.slice(0, databaseRollbackCheck)).not.toContain('systemctl stop "$api_service" "$worker_service"');
    expect(cleanup.slice(0, databaseRollbackCheck)).not.toContain('mv -Tf "$rollback_link" "$current_link"');
  });

  it("reports rollback success only after restoring current and every previously active service", async () => {
    const remote = await readFile("bin/push-remote.sh", "utf8");
    const cleanup = remote.slice(remote.indexOf("cleanup() {"), remote.indexOf("trap cleanup EXIT"));
    const rollback = cleanup.slice(
      cleanup.indexOf('if [[ "$database_matches_previous" == \'1\' ]]; then'),
      cleanup.indexOf("# The forward migration is committed and immutable."),
    );
    const rollbackSuccess = rollback.indexOf('echo "RELEASE_FAILED_ROLLED_BACK:$release_id"');
    const rollbackFailure = rollback.indexOf('echo "RELEASE_FAILED_ROLLBACK_FAILED:$release_id"');

    expect(rollback).toContain("rollback_failed=0");
    expect(rollback).toContain('restore_initial_service_state "$api_service" "$initial_api_state" || rollback_failed=1');
    expect(rollback).toContain('restore_initial_service_state "$worker_service" "$initial_worker_state" || rollback_failed=1');
    expect(rollback).toContain('[[ "$(readlink -f "$current_link" 2>/dev/null)" == "$previous_app" ]] || rollback_failed=1');
    expect(rollback).toContain('if [[ "$initial_api_state" == \'active\' ]] && ! systemctl is-active --quiet "$api_service"; then');
    expect(rollback).toContain('if [[ "$initial_worker_state" == \'active\' ]] && ! systemctl is-active --quiet "$worker_service"; then');
    expect(rollbackSuccess).toBeGreaterThan(rollback.indexOf('if [[ "$rollback_failed" == \'0\' ]]; then'));
    expect(rollbackFailure).toBeGreaterThan(rollbackSuccess);
    expect(rollback.slice(rollbackFailure)).toContain('[[ "$status" != \'0\' ]] || status=1');
  });

  it("fails closed when remote current differs from the expected active release", async () => {
    const script = await readFile("bin/push.ps1", "utf8");
    const remote = await readFile("bin/push-remote.sh", "utf8");
    const currentGate = '[[ "$previous_app" == "$expected_previous_app" ]] || fail \'CURRENT_RELEASE_MISMATCH\'';

    expect(script).toContain("'$gitCommit' '$activeRelease'");
    expect(remote).toContain('expected_previous_app="$root/releases/$expected_current_release/app"');
    expect(remote).toContain(currentGate);
    expect(remote.indexOf(currentGate)).toBeLessThan(remote.indexOf('validate_archive "$app_archive"'));
  });

  it("allows script-only package changes that cannot run during install", async () => {
    const result = await runPackagePolicy(baselinePackage, {
      devDependencies: baselinePackage.devDependencies,
      dependencies: baselinePackage.dependencies,
      scripts: {
        test: "vitest run",
        build: "pnpm typecheck && pnpm build:web && pnpm build:server && pnpm build:cli",
        "build:cli": "tsup scripts/sync-fx.ts --out-dir dist/cli",
        "fx:sync": "node dist/cli/sync-fx.js",
      },
      engines: baselinePackage.engines,
      pnpm: baselinePackage.pnpm,
      packageManager: baselinePackage.packageManager,
      type: baselinePackage.type,
      private: baselinePackage.private,
      version: baselinePackage.version,
      name: baselinePackage.name,
    });

    expect(result.status, result.stderr).toBe(0);
  });

  it.each([
    ["dependencies", { dependencies: { fastify: "5.7.5" } }],
    ["pnpm overrides", { pnpm: { overrides: { "example@<2": "1.8.0" } } }],
    ["package manager", { packageManager: "pnpm@9.15.5" }],
    ["engines", { engines: { node: ">=25 <26", pnpm: ">=9.15 <10" } }],
  ])("rejects a %s change even when scripts are safe", async (_label, replacement) => {
    const result = await runPackagePolicy(baselinePackage, {
      ...baselinePackage,
      ...replacement,
      scripts: { build: "new-build" },
    });

    expect(result.status, result.stderr).toBe(67);
  });

  it.each([
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
    "pnpm:devPreinstall",
  ])("rejects the install-time lifecycle script %s", async (lifecycle) => {
    const result = await runPackagePolicy(baselinePackage, {
      ...baselinePackage,
      scripts: { build: "new-build", [lifecycle]: "node unexpected.js" },
    });

    expect(result.status, result.stderr).toBe(66);
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a non-string command", { build: 7 }],
  ])("rejects scripts represented as %s", async (_label, scripts) => {
    const result = await runPackagePolicy(baselinePackage, { ...baselinePackage, scripts });

    expect(result.status, result.stderr).toBe(65);
  });
});
