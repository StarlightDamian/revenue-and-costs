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
    expect(remote).toContain("session_has_limited_owner_membership");
    expect(remote).toContain("session_membership_count === 0");
    expect(remote).toContain("unset DATABASE_URL PGOPTIONS");
    expect(remote).not.toMatch(/GRANT\s+(?:CREATE|revenue_costs_owner)|ALTER\s+ROLE/iu);
    expect(remote.indexOf('runuser -u postgres -- "$pg_dump_bin"')).toBeLessThan(remote.indexOf("dist/cli/migrate.js"));
    expect(remote.indexOf('source "$migrator_env"')).toBeLessThan(remote.indexOf("dist/cli/migrate.js"));
    expect(remote.indexOf("dist/cli/migrate.js")).toBeLessThan(remote.indexOf('source "$config_root/database-app.env"'));
    expect(remote.indexOf('source "$config_root/database-app.env"')).toBeLessThan(remote.indexOf("dist/cli/bootstrap-mappings.js"));
    expect(remote).toContain("RELEASE_FAILED_AFTER_MIGRATION_SERVICES_STOPPED");
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
    expect(remote).toContain("payload.service !== \"api\"");
    expect(remote).toContain("setfacl -R -m u:www:r-X");
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
