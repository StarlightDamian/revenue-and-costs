#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$#" -eq 15 ]] || { echo 'REMOTE_ARGUMENTS_INVALID' >&2; exit 64; }
release_id="$1"; app_archive="$2"; app_sha="$3"; dependency_archive="$4"; dependency_sha="$5"
root="$6"; config_root="$7"; node_root="$8"; api_service="$9"; worker_service="${10}"
database_name="${11}"; api_port="${12}"; public_url="${13%/}"
git_commit="${14}"
expected_current_release="${15}"

[[ "$(id -u)" == '0' ]] || { echo 'REMOTE_ROOT_REQUIRED' >&2; exit 77; }
[[ "$release_id" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo 'RELEASE_ID_INVALID' >&2; exit 64; }
[[ "$root" == '/opt/revenue-costs' ]] || { echo 'REMOTE_ROOT_INVALID' >&2; exit 64; }
[[ "$config_root" =~ ^/[A-Za-z0-9._/-]+$ && "$node_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'REMOTE_PATH_INVALID' >&2; exit 64; }
[[ "$api_service" =~ ^[A-Za-z0-9_.@-]+\.service$ && "$worker_service" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || { echo 'SERVICE_INVALID' >&2; exit 64; }
[[ "$database_name" =~ ^[a-z_][a-z0-9_]*$ && "$api_port" =~ ^[0-9]{2,5}$ ]] || { echo 'DATABASE_OR_PORT_INVALID' >&2; exit 64; }
[[ "$public_url" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] || { echo 'PUBLIC_URL_INVALID' >&2; exit 64; }
[[ "$app_sha" =~ ^[a-f0-9]{64}$ && "$dependency_sha" =~ ^[a-f0-9]{64}$ ]] || { echo 'ARCHIVE_SHA_INVALID' >&2; exit 64; }
[[ "$git_commit" =~ ^[a-f0-9]{40}$ ]] || { echo 'GIT_COMMIT_INVALID' >&2; exit 64; }
[[ "$expected_current_release" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo 'EXPECTED_CURRENT_RELEASE_INVALID' >&2; exit 64; }
umask 027

release_lock='/run/lock/revenue-costs-release.lock'
command -v flock >/dev/null 2>&1 && command -v stat >/dev/null 2>&1 ||
  { echo 'RELEASE_LOCK_UNAVAILABLE' >&2; exit 69; }
exec 9>>"$release_lock" || { echo 'RELEASE_LOCK_UNAVAILABLE' >&2; exit 69; }
if flock -n -E 75 9; then
  release_lock_owner="$(stat -Lc '%u' -- "/proc/$$/fd/9" 2>/dev/null || true)"
  [[ "$release_lock_owner" == '0' ]] || { echo 'RELEASE_LOCK_OWNER_INVALID' >&2; exit 77; }
else
  release_lock_status=$?
  exec 9>&-
  if [[ "$release_lock_status" == '75' ]]; then
    echo 'RELEASE_ALREADY_IN_PROGRESS' >&2
    exit 75
  fi
  echo 'RELEASE_LOCK_UNAVAILABLE' >&2
  exit 69
fi

target="$root/releases/$release_id"
staging="$root/releases/.$release_id.partial"
current_link="$root/current"
backup_root='/var/backups/revenue-and-costs'
backup_path="$backup_root/pre-release-$release_id.dump"
backup_partial="$backup_path.partial"
previous_app="$(readlink -f "$current_link" 2>/dev/null || true)"
expected_previous_app="$root/releases/$expected_current_release/app"
next_link="$root/.current-$release_id"
rollback_link="$root/.current-rollback-$release_id"
services_stopped=0; switched=0; success=0; cleanup_running=0
initial_api_state="$(systemctl show --property=ActiveState --value "$api_service")"
initial_worker_state="$(systemctl show --property=ActiveState --value "$worker_service")"
[[ "$initial_api_state" =~ ^(active|inactive|failed)$ && "$initial_worker_state" =~ ^(active|inactive|failed)$ ]] ||
  { echo 'INITIAL_SERVICE_STATE_INVALID' >&2; exit 69; }

restore_initial_service_state() {
  local service="$1" initial_state="$2"
  if [[ "$initial_state" == 'active' ]]; then
    systemctl restart "$service"
  else
    systemctl stop "$service"
  fi
}

cleanup() {
  status=$?
  [[ "$cleanup_running" == '0' ]] || exit "$status"
  cleanup_running=1
  trap - EXIT ERR HUP INT TERM
  set +e
  rm -f "$next_link" "$rollback_link" "$backup_partial"
  if [[ "$success" != '1' ]]; then
    if [[ "$services_stopped" != '1' ]]; then
      echo "RELEASE_FAILED_BEFORE_SERVICE_STOP:$release_id" >&2
      exit "$status"
    fi
    database_matches_previous=0
    if [[ -f "$staging/.previous-migrations" || -f "$target/.previous-migrations" ]]; then
      release_state="$staging"
      [[ -f "$release_state/.previous-migrations" ]] || release_state="$target"
      current_database_manifest="$(mktemp)"
      if runuser -u postgres -- /usr/pgsql-17/bin/psql -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
          -c "SELECT filename || ' ' || checksum FROM schema_migration ORDER BY filename" > "$current_database_manifest" &&
          cmp -s "$release_state/.previous-migrations" "$current_database_manifest"; then
        database_matches_previous=1
      fi
      rm -f "$current_database_manifest"
    fi
    if [[ "$database_matches_previous" == '1' ]]; then
      rollback_failed=0
      if [[ "$(readlink -f "$current_link" 2>/dev/null)" == "$target/app" ]]; then
        if ln -s "$previous_app" "$rollback_link"; then
          mv -Tf "$rollback_link" "$current_link" || rollback_failed=1
        else
          rollback_failed=1
        fi
      fi
      if [[ "$services_stopped" == '1' ]]; then
        restore_initial_service_state "$api_service" "$initial_api_state" || rollback_failed=1
        restore_initial_service_state "$worker_service" "$initial_worker_state" || rollback_failed=1
      fi
      [[ "$(readlink -f "$current_link" 2>/dev/null)" == "$previous_app" ]] || rollback_failed=1
      if [[ "$initial_api_state" == 'active' ]] && ! systemctl is-active --quiet "$api_service"; then
        rollback_failed=1
      fi
      if [[ "$initial_worker_state" == 'active' ]] && ! systemctl is-active --quiet "$worker_service"; then
        rollback_failed=1
      fi
      if [[ "$rollback_failed" == '0' ]]; then
        echo "RELEASE_FAILED_ROLLED_BACK:$release_id" >&2
      else
        echo "RELEASE_FAILED_ROLLBACK_FAILED:$release_id" >&2
        [[ "$status" != '0' ]] || status=1
      fi
    else
    # The forward migration is committed and immutable. Keep both services
    # stopped; starting the previous code against the new schema is unsafe.
      stop_status=0; api_state_status=0; worker_state_status=0
      systemctl stop "$api_service" "$worker_service" >/dev/null 2>&1 || stop_status=$?
      api_state="$(systemctl show --property=ActiveState --value "$api_service" 2>/dev/null)" || api_state_status=$?
      worker_state="$(systemctl show --property=ActiveState --value "$worker_service" 2>/dev/null)" || worker_state_status=$?
      if [[ "$stop_status" == '0' && "$api_state_status" == '0' && "$worker_state_status" == '0' &&
            "$api_state" =~ ^(inactive|failed)$ && "$worker_state" =~ ^(inactive|failed)$ ]]; then
        echo "RELEASE_FAILED_AFTER_MIGRATION_SERVICES_STOPPED:$release_id:$backup_path" >&2
      else
        echo "RELEASE_FAILED_AFTER_MIGRATION_SERVICE_STOP_FAILED:$release_id:$backup_path" >&2
      fi
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

fail() { echo "$1" >&2; return 1; }
[[ -d "$previous_app" && -f "$previous_app/package.json" && -f "$previous_app/pnpm-lock.yaml" ]] || fail 'CURRENT_RELEASE_MISSING'
[[ "$previous_app" == "$expected_previous_app" ]] || fail 'CURRENT_RELEASE_MISMATCH'
[[ ! -e "$target" && ! -e "$staging" ]] || fail 'TARGET_RELEASE_EXISTS'
[[ -f "$app_archive" && -f "$dependency_archive" ]] || fail 'UPLOAD_PARTIAL_MISSING'
[[ "$(sha256sum "$app_archive" | awk '{print $1}')" == "$app_sha" ]] || fail 'APP_ARCHIVE_HASH_MISMATCH'
[[ "$(sha256sum "$dependency_archive" | awk '{print $1}')" == "$dependency_sha" ]] || fail 'DEPENDENCY_ARCHIVE_HASH_MISMATCH'

validate_archive() {
  local archive="$1" kind="$2" raw entry type
  while IFS= read -r raw; do
    [[ "$raw" != /* && ! "$raw" =~ ^[A-Za-z]:/ && ! "$raw" =~ ^// && ! "$raw" =~ (^|/)\.\.(/|$) ]] || return 1
    entry="${raw#./}"
    if [[ "$kind" == 'app' ]]; then
      [[ "$entry" =~ ^app/?$|^app/(dist|migrations)(/.*)?$|^app/(package\.json|pnpm-lock\.yaml)$ ]] || return 1
    else
      [[ "$entry" =~ ^(pnpm-store|tools)/?$|^(pnpm-store|tools)/.*$|^(package\.json|pnpm-lock\.yaml)$ ]] || return 1
      [[ ! "$entry" =~ (^|/)node_modules(/|$) ]] || return 1
    fi
    [[ ! "$entry" =~ (^|/)\.env($|\.) && ! "$entry" =~ (^|/)\.git(/|$) && ! "$entry" =~ (^|/)nas/data(/|$) ]] || return 1
  done < <(tar -tzf "$archive")
  while IFS= read -r raw; do
    type="${raw:0:1}"
    [[ "$type" == '-' || "$type" == 'd' ]] || return 1
  done < <(tar -tvzf "$archive")
}

validate_package_change() {
  "$node_root/bin/node" - "$1" "$2" <<'NODE_PACKAGE_POLICY'
const fs = require("node:fs");

const [previousPath, nextPath] = process.argv.slice(2);
const installLifecycleScripts = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepublish",
  "preprepare",
  "prepare",
  "postprepare",
  "pnpm:devPreinstall",
]);

function readPackage(path) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(path, "utf8"));
  } catch {
    process.exit(65);
  }
  if (value === null || Array.isArray(value) || typeof value !== "object") process.exit(65);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function withoutScripts(packageJson) {
  return Object.fromEntries(Object.entries(packageJson).filter(([key]) => key !== "scripts"));
}

const previousPackage = readPackage(previousPath);
const nextPackage = readPackage(nextPath);
const scripts = nextPackage.scripts === undefined ? {} : nextPackage.scripts;
if (scripts === null || Array.isArray(scripts) || typeof scripts !== "object") process.exit(65);
for (const [name, command] of Object.entries(scripts)) {
  if (typeof command !== "string") process.exit(65);
  if (installLifecycleScripts.has(name)) process.exit(66);
}
if (canonical(withoutScripts(previousPackage)) !== canonical(withoutScripts(nextPackage))) process.exit(67);
NODE_PACKAGE_POLICY
}

validate_archive "$app_archive" app || fail 'APP_ARCHIVE_REJECTED'
validate_archive "$dependency_archive" dependencies || fail 'DEPENDENCY_ARCHIVE_REJECTED'

install -d -m 0750 -o root -g revenue-costs "$staging"
tar --no-same-owner --no-same-permissions -xzf "$dependency_archive" -C "$staging"
tar --no-same-owner --no-same-permissions -xzf "$app_archive" -C "$staging"
[[ -f "$staging/app/dist/server/api/index.js" && -f "$staging/app/dist/server/worker/index.js" && -f "$staging/app/dist/web/index.html" ]] || fail 'APPLICATION_ARTIFACT_MISSING'
[[ -f "$staging/tools/pnpm-min/pnpm.cjs" ]] || fail 'PNPM_TOOL_MISSING'
cmp -s "$staging/package.json" "$staging/app/package.json" || fail 'DEPENDENCY_PACKAGE_MISMATCH'
cmp -s "$staging/pnpm-lock.yaml" "$staging/app/pnpm-lock.yaml" || fail 'DEPENDENCY_LOCK_MISMATCH'
cmp -s "$previous_app/pnpm-lock.yaml" "$staging/pnpm-lock.yaml" || fail 'DEPENDENCY_CHANGE_REQUIRES_REVIEW'
package_policy_status=0
validate_package_change "$previous_app/package.json" "$staging/package.json" || package_policy_status=$?
case "$package_policy_status" in
  0) ;;
  65) fail 'PACKAGE_JSON_INVALID' ;;
  66) fail 'INSTALL_LIFECYCLE_SCRIPT_REJECTED' ;;
  67) fail 'DEPENDENCY_CHANGE_REQUIRES_REVIEW' ;;
  *) fail 'PACKAGE_POLICY_CHECK_FAILED' ;;
esac

find "$staging/pnpm-store" -type f -name '*-exec' -exec chmod 0750 {} +
PATH="$node_root/bin:$PATH" "$node_root/bin/node" "$staging/tools/pnpm-min/pnpm.cjs" \
  --dir "$staging/app" --store-dir "$staging/pnpm-store" install --offline --frozen-lockfile --prod
find "$staging" \( -type b -o -type c -o -type p \) -print -quit | grep -q . && fail 'NON_REGULAR_RELEASE_ENTRY'
while IFS= read -r -d '' link; do
  [[ "$link" == "$staging/app/node_modules/"* ]] || fail 'SYMLINK_OUTSIDE_NODE_MODULES'
  link_target="$(readlink "$link")"
  [[ "$link_target" != /* ]] || fail 'ABSOLUTE_SYMLINK_REJECTED'
  resolved_target="$(realpath -m -- "$link")"
  [[ "$resolved_target" == "$staging/app/node_modules/"* ]] || fail 'SYMLINK_ESCAPE_REJECTED'
done < <(find "$staging" -type l -print0)

migration_manifest() {
  local directory="$1"
  find "$directory" -maxdepth 1 -type f -name '[0-9][0-9][0-9][0-9]_*.sql' -printf '%f\n' | LC_ALL=C sort |
    while IFS= read -r filename; do printf '%s %s\n' "$filename" "$(sha256sum "$directory/$filename" | awk '{print $1}')"; done
}

assert_database_identity() {
  local expected_session="$1" expected_current="$2" expected_mode="$3" expected_database="$4" expected_server="$5"
  (
    cd "$target/app"
    DATABASE_IDENTITY_EXPECTED_SESSION="$expected_session" \
    DATABASE_IDENTITY_EXPECTED_CURRENT="$expected_current" \
    DATABASE_IDENTITY_EXPECTED_MODE="$expected_mode" \
    DATABASE_IDENTITY_EXPECTED_DATABASE="$expected_database" \
    DATABASE_IDENTITY_EXPECTED_SERVER="$expected_server" \
      "$node_root/bin/node" --input-type=module - <<'NODE_DATABASE_IDENTITY'
import pg from "pg";

const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  application_name: "revenue-costs-release-identity-check",
  connectionTimeoutMillis: 5_000,
});
await client.connect();
try {
  const result = await client.query(`
    SELECT session_user,current_user,current_database() AS database_name,
           COALESCE(inet_server_addr() IN (inet '127.0.0.1',inet '::1'),true) AS server_is_local,
           current_setting('port') || '|' || pg_postmaster_start_time()::text AS server_identity,
           session_database_role.rolsuper OR session_database_role.rolcreaterole OR session_database_role.rolcreatedb OR
             session_database_role.rolreplication OR session_database_role.rolbypassrls AS session_elevated,
           active_database_role.rolsuper OR active_database_role.rolcreaterole OR active_database_role.rolcreatedb OR
             active_database_role.rolreplication OR active_database_role.rolbypassrls AS current_elevated,
           current_user=pg_get_userbyid(database_info.datdba) AS owns_database,
           current_user=pg_get_userbyid(public_namespace.nspowner) AS owns_public_schema,
           has_database_privilege(current_user,current_database(),'CREATE') AS can_create_database_object,
           has_schema_privilege(current_user,'public','CREATE') AS can_create_public_object,
           (SELECT count(*)::int FROM pg_auth_members membership
             WHERE membership.member=active_database_role.oid) AS current_membership_count,
           (SELECT count(*)::int FROM pg_auth_members membership
             WHERE membership.member=session_database_role.oid) AS session_membership_count,
           EXISTS (
             SELECT 1 FROM pg_auth_members membership
              WHERE membership.member=session_database_role.oid
                AND membership.roleid=active_database_role.oid
                AND membership.set_option AND NOT membership.inherit_option AND NOT membership.admin_option
           ) AS session_has_limited_owner_membership,
           EXISTS (
             SELECT 1 FROM pg_class relation
              WHERE relation.relnamespace=public_namespace.oid AND relation.relowner=active_database_role.oid
           ) AS owns_public_objects
      FROM pg_roles active_database_role
      JOIN pg_roles session_database_role ON session_database_role.rolname=session_user
      JOIN pg_database database_info ON database_info.datname=current_database()
      JOIN pg_namespace public_namespace ON public_namespace.nspname='public'
     WHERE active_database_role.rolname=current_user`);
  const row = result.rows[0];
  const identityMatches = row?.session_user === process.env.DATABASE_IDENTITY_EXPECTED_SESSION
    && row?.current_user === process.env.DATABASE_IDENTITY_EXPECTED_CURRENT
    && row?.database_name === process.env.DATABASE_IDENTITY_EXPECTED_DATABASE
    && row?.server_is_local === true
    && row?.server_identity === process.env.DATABASE_IDENTITY_EXPECTED_SERVER
    && row?.session_elevated === false && row?.current_elevated === false;
  const privilegeMatches = process.env.DATABASE_IDENTITY_EXPECTED_MODE === "owner"
    ? row?.owns_database === true && row?.owns_public_schema === true
      && row?.can_create_database_object === true && row?.can_create_public_object === true
      && row?.current_membership_count === 0 && row?.session_membership_count === 1
      && row?.session_has_limited_owner_membership === true
    : row?.owns_database === false && row?.owns_public_schema === false
      && row?.can_create_database_object === false && row?.can_create_public_object === false
      && row?.owns_public_objects === false && row?.current_membership_count === 0
      && row?.session_membership_count === 0 && row?.session_has_limited_owner_membership === false;
  if (!identityMatches || !privilegeMatches) throw new Error("DATABASE_RELEASE_IDENTITY_MISMATCH");
} finally {
  await client.end();
}
NODE_DATABASE_IDENTITY
  )
}

migration_manifest "$previous_app/migrations" > "$staging/.previous-migrations"
migration_manifest "$staging/app/migrations" > "$staging/.release-migrations"
previous_migration_count="$(wc -l < "$staging/.previous-migrations")"
release_migration_count="$(wc -l < "$staging/.release-migrations")"
[[ "$release_migration_count" -ge "$previous_migration_count" ]] || fail 'MIGRATION_HISTORY_REMOVED'
head -n "$previous_migration_count" "$staging/.release-migrations" > "$staging/.release-migration-prefix"
cmp -s "$staging/.previous-migrations" "$staging/.release-migration-prefix" || fail 'MIGRATION_HISTORY_CHANGED'
tail -n "+$((previous_migration_count + 1))" "$staging/.release-migrations" > "$staging/.pending-migrations"
psql_bin='/usr/pgsql-17/bin/psql'; pg_dump_bin='/usr/pgsql-17/bin/pg_dump'; pg_restore_bin='/usr/pgsql-17/bin/pg_restore'
[[ -x "$psql_bin" && -x "$pg_dump_bin" && -x "$pg_restore_bin" ]] || fail 'POSTGRES_17_TOOLS_MISSING'
database_server_identity="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT current_setting('port') || '|' || pg_postmaster_start_time()::text")"
[[ -n "$database_server_identity" ]] || fail 'DATABASE_SERVER_IDENTITY_MISSING'
runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT filename || ' ' || checksum FROM schema_migration ORDER BY filename" > "$staging/.database-migrations"
cmp -s "$staging/.previous-migrations" "$staging/.database-migrations" || fail 'DATABASE_MIGRATION_BASELINE_MISMATCH'

receipt="$staging/.release-receipt.json"
printf '{"format":"revenue-costs-release-receipt-v1","releaseId":"%s","gitCommit":"%s","appSha256":"%s","dependencySha256":"%s","migrationCount":%s,"deploymentAcceptance":"pending"}\n' \
  "$release_id" "$git_commit" "$app_sha" "$dependency_sha" "$release_migration_count" > "$receipt"

# Normalize after creating the release metadata as well as installing production
# dependencies. Otherwise these manifest files inherit 0644 from the shell and
# trip the non-static world-readable gate after the staging directory is moved.
chown -R root:revenue-costs "$staging"
find "$staging" -type d -exec chmod 0750 {} +
find "$staging" -type f -exec chmod 0640 {} +
find "$staging" \( -type f -o -type d \) -perm /0022 -print -quit | grep -q . && fail 'GROUP_OR_OTHER_WRITABLE_REJECTED'

mv "$staging" "$target"
setfacl -m u:www:--x "$target" "$target/app" "$target/app/dist"
setfacl -R -m u:www:r-X "$target/app/dist/web"
find "$target" -path "$target/app/dist/web" -prune -o -type f -perm -0004 -print -quit | grep -q . && fail 'NON_STATIC_WORLD_READABLE'
nginx -t

install -d -m 0700 -o root -g root "$backup_root"
[[ ! -e "$backup_path" && ! -e "$backup_partial" ]] || fail 'BACKUP_TARGET_EXISTS'
umask 077
: > "$backup_partial"
chmod 0600 "$backup_partial"
services_stopped=1
systemctl stop "$api_service" "$worker_service"
active_calculations="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT count(*) FROM calculation_run WHERE status IN ('QUEUED','RUNNING','BLOCKED')")"
[[ "$active_calculations" == '0' ]] || fail 'ACTIVE_CALCULATIONS_REQUIRE_DRAIN'
active_imports="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT count(*) FROM import_batch WHERE status NOT IN ('RESULT_PUBLISHED','FAILED','CANCELLED')")"
[[ "$active_imports" == '0' ]] || fail 'ACTIVE_IMPORTS_REQUIRE_DRAIN'
active_exports="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT count(*) FROM export_request WHERE status IN ('QUEUED','RUNNING')")"
[[ "$active_exports" == '0' ]] || fail 'ACTIVE_EXPORTS_REQUIRE_DRAIN'
active_uploads="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT count(*) FROM upload_file WHERE status IN ('PENDING','UPLOADING','COMPLETE','ENCRYPTING')")"
[[ "$active_uploads" == '0' ]] || fail 'ACTIVE_UPLOADS_REQUIRE_DRAIN'
pending_business_outbox="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT count(*) FROM outbox_event WHERE dispatched_at IS NULL AND topic IN ('upload.finalize','import.analyze','import.commit','calculation.requested','calculation.run','report.auto-publish','export.generate')")"
[[ "$pending_business_outbox" == '0' ]] || fail 'PENDING_BUSINESS_OUTBOX_REQUIRE_DRAIN'
runuser -u postgres -- "$pg_dump_bin" --format=custom "$database_name" > "$backup_partial"
[[ -s "$backup_partial" ]] || fail 'DATABASE_BACKUP_EMPTY'
"$pg_restore_bin" --list "$backup_partial" >/dev/null
mv "$backup_partial" "$backup_path"
chown root:root "$backup_path"; chmod 0600 "$backup_path"

migrator_env="$config_root/database-migrator.env"
[[ -f "$migrator_env" && "$(stat -c '%U:%G:%a' "$migrator_env")" == 'root:root:600' ]] ||
  fail 'DATABASE_MIGRATOR_CONFIG_INVALID'
(
  unset DATABASE_URL PGOPTIONS
  set -a
  source "$migrator_env"
  set +a
  [[ -n "${DATABASE_URL:-}" ]] || fail 'DATABASE_MIGRATOR_URL_MISSING'
  export NODE_ENV=production
  assert_database_identity revenue_costs_migrator revenue_costs_owner owner "$database_name" "$database_server_identity"
  cd "$target/app"
  PATH="$node_root/bin:$PATH" "$node_root/bin/node" dist/cli/migrate.js
)
(
  unset DATABASE_URL PGOPTIONS
  set -a
  source "$config_root/database-app.env"
  source "$config_root/revenue-costs.env"
  set +a
  [[ -n "${DATABASE_URL:-}" ]] || fail 'DATABASE_APP_URL_MISSING'
  export NODE_ENV=production
  assert_database_identity revenue_costs_app revenue_costs_app application "$database_name" "$database_server_identity"
  cd "$target/app"
  REQUIRE_BOOTSTRAP_MAPPINGS=true PATH="$node_root/bin:$PATH" \
    "$node_root/bin/node" dist/cli/bootstrap-mappings.js
)
runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
  -c "SELECT filename || ' ' || checksum FROM schema_migration ORDER BY filename" > "$target/.database-migrations"
cmp -s "$target/.release-migrations" "$target/.database-migrations" || fail 'DATABASE_MIGRATION_MANIFEST_MISMATCH'

ln -s "$target/app" "$next_link"
switched=1
mv -Tf "$next_link" "$current_link"
release_journal_since="$(date '+%Y-%m-%d %H:%M:%S')"
release_started_at="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" -c 'SELECT clock_timestamp()')"
systemctl start "$api_service" "$worker_service"

health_once() {
  local url="$1" expected_status="$2" body
  shift 2
  body="$(mktemp)"
  if ! curl --fail --silent --show-error --max-time 5 "$@" "$url" > "$body"; then rm -f "$body"; return 1; fi
  "$node_root/bin/node" -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const expectedStatus = process.argv[2];
    if (payload.service !== "api") process.exit(1);
    if (payload.status !== expectedStatus) process.exit(1);
  ' "$body" "$expected_status"
  result=$?; rm -f "$body"; return "$result"
}

anonymous_me_once() {
  local url="$1" status
  shift
  status="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' \
    "$@" "$url")" || return 1
  [[ "$status" == '401' ]]
}

worker_heartbeat_once() {
  local heartbeat_status
  heartbeat_status="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" \
    -v started_at="$release_started_at" -f - <<'WORKER_HEARTBEAT_SQL'
SELECT EXISTS (SELECT 1 FROM job_operation WHERE business_key='service:worker' AND status='RUNNING' AND last_heartbeat_at > :'started_at'::timestamptz AND last_heartbeat_at >= clock_timestamp()-interval '30 seconds');
WORKER_HEARTBEAT_SQL
  )" || return 1
  [[ "$heartbeat_status" == 't' ]]
}

connection_budget_once() {
  [[ "$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" -c \
    "SELECT (role.rolconnlimit >= 7 AND count(activity.pid) <= 6) FROM pg_roles role LEFT JOIN pg_stat_activity activity ON activity.usename=role.rolname WHERE role.rolname='revenue_costs_app' GROUP BY role.rolconnlimit")" == 't' ]]
}

services_stable_once() {
  systemctl is-active --quiet "$api_service" && systemctl is-active --quiet "$worker_service" &&
    [[ "$(systemctl show --property=NRestarts --value "$api_service")" == '0' ]] &&
    [[ "$(systemctl show --property=NRestarts --value "$worker_service")" == '0' ]]
}

authenticated_me_once() {
  local acceptance_phone
  acceptance_phone="$(runuser -u postgres -- "$psql_bin" -X -v ON_ERROR_STOP=1 -At -d "$database_name" -c \
    "SELECT account.phone_e164 FROM account JOIN account_role role ON role.account_id=account.id WHERE account.status='ACTIVE' AND role.role='ADMIN' ORDER BY account.created_at,account.id LIMIT 1")"
  [[ "$acceptance_phone" =~ ^\+[1-9][0-9]{7,14}$ ]] || return 1
  (
    set -a
    source "$config_root/revenue-costs.env"
    set +a
    [[ "${TEMPORARY_ADMIN_OTP_CODE:-}" =~ ^[0-9]{6}$ && "${PUBLIC_ORIGIN:-}" =~ ^https://[A-Za-z0-9.-]+$ ]] || return 1
    RELEASE_ACCEPTANCE_API_ORIGIN="http://127.0.0.1:$api_port" \
    RELEASE_ACCEPTANCE_PHONE="$acceptance_phone" \
    RELEASE_ACCEPTANCE_ID="$release_id" \
      "$node_root/bin/node" --input-type=module - <<'NODE_AUTH_ACCEPTANCE'
const apiOrigin = process.env.RELEASE_ACCEPTANCE_API_ORIGIN;
const publicOrigin = process.env.PUBLIC_ORIGIN;
const phone = process.env.RELEASE_ACCEPTANCE_PHONE;
const code = process.env.TEMPORARY_ADMIN_OTP_CODE;
const releaseId = process.env.RELEASE_ACCEPTANCE_ID;

async function request(path, init, expectedStatus) {
  const response = await fetch(`${apiOrigin}${path}`, { ...init, signal: AbortSignal.timeout(5_000) });
  if (response.status !== expectedStatus) throw new Error(`RELEASE_AUTH_HTTP_${response.status}`);
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : {} };
}

const headers = { origin: publicOrigin, "content-type": "application/json" };
const otp = await request("/api/v1/auth/otp", {
  method: "POST", headers,
  body: JSON.stringify({ phone, purpose: "LOGIN", deviceId: `release-${releaseId}` }),
}, 200);
if (typeof otp.body.challengeId !== "string") throw new Error("RELEASE_AUTH_CHALLENGE_INVALID");
const verified = await request("/api/v1/auth/verify", {
  method: "POST", headers,
  body: JSON.stringify({ challengeId: otp.body.challengeId, phone, purpose: "LOGIN", code }),
}, 200);
const cookies = new Map();
for (const value of verified.response.headers.getSetCookie()) {
  const pair = value.split(";", 1)[0];
  const separator = pair.indexOf("=");
  if (separator < 1) continue;
  const name = pair.slice(0, separator);
  const cookieValue = pair.slice(separator + 1);
  if (cookieValue) cookies.set(name, cookieValue); else cookies.delete(name);
}
const session = cookies.get("rc_session");
const csrf = cookies.get("rc_csrf");
if (!session || !csrf) throw new Error("RELEASE_AUTH_COOKIE_MISSING");
const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
const me = await request("/api/v1/me", { headers: { cookie } }, 200);
if (me.body.id !== verified.body.account?.id || me.body.status !== "ACTIVE" || !me.body.roles?.includes("ADMIN")) {
  throw new Error("RELEASE_AUTH_ME_INVALID");
}
await request("/api/v1/auth/logout", {
  method: "POST",
  headers: { cookie, origin: publicOrigin, "x-csrf-token": decodeURIComponent(csrf) },
}, 200);
await request("/api/v1/me", { headers: { cookie } }, 401);
NODE_AUTH_ACCEPTANCE
  )
}

healthy=0
public_host="${public_url#https://}"
public_host="${public_host%%/*}"
for _ in $(seq 1 30); do
  if health_once "http://127.0.0.1:$api_port/health/live" ok &&
     health_once "http://127.0.0.1:$api_port/health/ready" degraded &&
     health_once "$public_url/health/live" ok --resolve "$public_host:443:127.0.0.1" &&
     health_once "$public_url/health/ready" degraded --resolve "$public_host:443:127.0.0.1" &&
     anonymous_me_once "http://127.0.0.1:$api_port/api/v1/me" &&
     anonymous_me_once "$public_url/api/v1/me" --resolve "$public_host:443:127.0.0.1" &&
     worker_heartbeat_once && connection_budget_once && services_stable_once; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == '1' ]] || fail 'HEALTH_CHECK_FAILED'
curl --fail --silent --show-error --compressed --resolve "$public_host:443:127.0.0.1" "$public_url/" |
  cmp -s - "$target/app/dist/web/index.html" || fail 'PUBLIC_INDEX_MISMATCH'
authenticated_me_once || fail 'AUTHENTICATED_ME_ACCEPTANCE_FAILED'

stability_deadline=$((SECONDS + 90))
while (( SECONDS < stability_deadline )); do
  health_once "http://127.0.0.1:$api_port/health/live" ok &&
    health_once "http://127.0.0.1:$api_port/health/ready" degraded &&
    health_once "$public_url/health/live" ok --resolve "$public_host:443:127.0.0.1" &&
    health_once "$public_url/health/ready" degraded --resolve "$public_host:443:127.0.0.1" &&
    anonymous_me_once "http://127.0.0.1:$api_port/api/v1/me" &&
    anonymous_me_once "$public_url/api/v1/me" --resolve "$public_host:443:127.0.0.1" &&
    worker_heartbeat_once && connection_budget_once && services_stable_once ||
    fail 'STABILITY_WINDOW_FAILED'
  sleep 5
done
services_stable_once && worker_heartbeat_once && connection_budget_once || fail 'FINAL_RUNTIME_CHECK_FAILED'
runtime_log="$(mktemp)"
if ! journalctl -u "$api_service" -u "$worker_service" --since "$release_journal_since" --no-pager --output=cat > "$runtime_log"; then
  rm -f "$runtime_log"
  fail 'RELEASE_RUNTIME_LOG_UNAVAILABLE'
fi
if grep -Eiq '53300|remaining connection slots|pool[- ]?timeout|timeout exceeded when trying to connect|ERR_UNHANDLED_ERROR|Unhandled .error. event|Main process exited' "$runtime_log"; then
  rm -f "$runtime_log"
  fail 'RELEASE_RUNTIME_ERROR_DETECTED'
fi
rm -f "$runtime_log"

rm -f "$target/.release-migrations" "$target/.release-migration-prefix" \
  "$target/.pending-migrations" "$target/.database-migrations"

# Once the passed receipt becomes visible the release must not be rolled back.
# Ignore termination until the receipt and cleanup success flag agree; command
# failures still exit through the existing EXIT cleanup trap.
trap '' HUP INT TERM
receipt_partial="$target/.release-receipt.json.partial"
printf '{"format":"revenue-costs-release-receipt-v1","releaseId":"%s","gitCommit":"%s","appSha256":"%s","dependencySha256":"%s","migrationCount":%s,"deploymentAcceptance":"passed"}\n' \
  "$release_id" "$git_commit" "$app_sha" "$dependency_sha" "$release_migration_count" > "$receipt_partial"
chown root:revenue-costs "$receipt_partial"; chmod 0640 "$receipt_partial"
mv -f "$receipt_partial" "$target/.release-receipt.json"
success=1
trap - EXIT HUP INT TERM
if ! rm -f "$target/.previous-migrations"; then
  echo "RELEASE_METADATA_CLEANUP_WARNING:$target/.previous-migrations" >&2
fi
echo "RELEASE_OK:$target/app"
echo "DATABASE_BACKUP:$backup_path"
echo "RELEASE_RECEIPT:$target/.release-receipt.json"
