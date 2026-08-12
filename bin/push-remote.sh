#!/usr/bin/env bash
set -Eeuo pipefail

[[ "$#" -eq 13 ]] || { echo 'REMOTE_ARGUMENTS_INVALID' >&2; exit 64; }
release_id="$1"; app_archive="$2"; app_sha="$3"; dependency_archive="$4"; dependency_sha="$5"
root="$6"; config_root="$7"; node_root="$8"; api_service="$9"; worker_service="${10}"
database_name="${11}"; api_port="${12}"; public_url="${13%/}"

[[ "$(id -u)" == '0' ]] || { echo 'REMOTE_ROOT_REQUIRED' >&2; exit 77; }
[[ "$release_id" =~ ^[0-9]{8}-[0-9]{6}$ ]] || { echo 'RELEASE_ID_INVALID' >&2; exit 64; }
[[ "$root" == '/opt/revenue-costs' ]] || { echo 'REMOTE_ROOT_INVALID' >&2; exit 64; }
[[ "$config_root" =~ ^/[A-Za-z0-9._/-]+$ && "$node_root" =~ ^/[A-Za-z0-9._/-]+$ ]] || { echo 'REMOTE_PATH_INVALID' >&2; exit 64; }
[[ "$api_service" =~ ^[A-Za-z0-9_.@-]+\.service$ && "$worker_service" =~ ^[A-Za-z0-9_.@-]+\.service$ ]] || { echo 'SERVICE_INVALID' >&2; exit 64; }
[[ "$database_name" =~ ^[a-z_][a-z0-9_]*$ && "$api_port" =~ ^[0-9]{2,5}$ ]] || { echo 'DATABASE_OR_PORT_INVALID' >&2; exit 64; }
[[ "$public_url" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~/-]*)?$ ]] || { echo 'PUBLIC_URL_INVALID' >&2; exit 64; }
[[ "$app_sha" =~ ^[a-f0-9]{64}$ && "$dependency_sha" =~ ^[a-f0-9]{64}$ ]] || { echo 'ARCHIVE_SHA_INVALID' >&2; exit 64; }

target="$root/releases/$release_id"
staging="$root/releases/.$release_id.partial"
current_link="$root/current"
backup_root='/var/backups/revenue-and-costs'
backup_path="$backup_root/pre-release-$release_id.dump"
backup_partial="$backup_path.partial"
previous_app="$(readlink -f "$current_link")"
next_link="$root/.current-$release_id"
rollback_link="$root/.current-rollback-$release_id"
services_stopped=0; switched=0; success=0; cleanup_running=0

cleanup() {
  status=$?
  [[ "$cleanup_running" == '0' ]] || exit "$status"
  cleanup_running=1
  trap - EXIT ERR HUP INT TERM
  set +e
  rm -f "$next_link" "$rollback_link" "$backup_partial"
  if [[ "$success" != '1' ]]; then
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
      if [[ "$(readlink -f "$current_link" 2>/dev/null)" == "$target/app" ]]; then
        ln -s "$previous_app" "$rollback_link" && mv -Tf "$rollback_link" "$current_link"
      fi
      if [[ "$services_stopped" == '1' ]]; then systemctl restart "$api_service" "$worker_service"; fi
      echo "RELEASE_FAILED_ROLLED_BACK:$release_id" >&2
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
rm -f "$target/.previous-migrations" "$target/.release-migrations" "$target/.release-migration-prefix" \
  "$target/.pending-migrations" "$target/.database-migrations"

ln -s "$target/app" "$next_link"
switched=1
mv -Tf "$next_link" "$current_link"
systemctl start "$api_service" "$worker_service"

health_once() {
  local url="$1" kind="$2" body
  shift 2
  body="$(mktemp)"
  if ! curl --fail --silent --show-error --max-time 5 "$@" "$url" > "$body"; then rm -f "$body"; return 1; fi
  "$node_root/bin/node" -e '
    const fs = require("node:fs");
    const payload = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const kind = process.argv[2];
    if (payload.service !== "api") process.exit(1);
    if (kind === "live" ? payload.status !== "ok" : !["ok", "degraded"].includes(payload.status)) process.exit(1);
  ' "$body" "$kind"
  result=$?; rm -f "$body"; return "$result"
}

healthy=0
public_host="${public_url#https://}"
public_host="${public_host%%/*}"
for _ in $(seq 1 30); do
  if health_once "http://127.0.0.1:$api_port/health/live" live &&
     health_once "http://127.0.0.1:$api_port/health/ready" ready &&
     health_once "$public_url/health/live" live --resolve "$public_host:443:127.0.0.1" &&
     health_once "$public_url/health/ready" ready --resolve "$public_host:443:127.0.0.1"; then healthy=1; break; fi
  sleep 2
done
[[ "$healthy" == '1' ]] || fail 'HEALTH_CHECK_FAILED'
systemctl is-active --quiet "$api_service"; systemctl is-active --quiet "$worker_service"
curl --fail --silent --show-error --compressed --resolve "$public_host:443:127.0.0.1" "$public_url/" |
  cmp -s - "$target/app/dist/web/index.html" || fail 'PUBLIC_INDEX_MISMATCH'

success=1
trap - EXIT HUP INT TERM
echo "RELEASE_OK:$target/app"
echo "DATABASE_BACKUP:$backup_path"
