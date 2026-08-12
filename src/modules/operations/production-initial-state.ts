import type { Pool } from "pg";

const EMPTY_BUSINESS_TABLES = [
  "account_onboarding_state",
  "audit_event",
  "auth_session",
  "calculation_fact_result",
  "calculation_fx_usage",
  "calculation_run",
  "calculation_run_slice",
  "dataset_slice",
  "dataset_source_binding",
  "dataset_version",
  "enterprise",
  "enterprise_member",
  "export_download_grant",
  "export_file_manifest",
  "export_request",
  "fx_batch_conversion",
  "fx_market_day",
  "fx_override",
  "fx_quote",
  "fx_raw_snapshot",
  "fx_sync_run",
  "fx_sync_run_snapshot",
  "idempotency_record",
  "import_batch",
  "import_file",
  "import_issue",
  "monthly_cost_summary",
  "original_download_grant",
  "outbox_event",
  "otp_challenge",
  "payment_event_inbox",
  "payment_order",
  "payment_reversal",
  "phone_change_request",
  "published_snapshot",
  "published_snapshot_integrity",
  "published_snapshot_slice",
  "quality_acknowledgement",
  "reconciliation_result",
  "shipment_fact",
  "shop",
  "shop_charge",
  "shop_current_published_snapshot",
  "shop_invitation",
  "shop_membership",
  "shop_name_history",
  "shop_term",
  "stored_object",
  "stored_object_replica",
  "transaction_fact",
  "transaction_fee_component",
  "upload_batch",
  "upload_chunk_receipt",
  "upload_file",
  "wallet_account",
  "wallet_ledger",
] as const;

const ALLOWED_SYSTEM_TABLES = [
  "account",
  "account_role",
  "application",
  "application_price_version",
  "application_role_policy",
  "backup_run",
  "field_mapping",
  "field_mapping_version",
  "identity_bootstrap",
  "job_operation",
  "marketplace_policy_version",
  "operational_alert",
  "recovery_checkpoint",
  "schema_migration",
] as const;

export interface ProductionInitialStateEvidence {
  readonly database: string;
  readonly role: string;
  readonly administratorId: string;
  readonly checkedEmptyTables: number;
}

export async function assertProductionInitialState(
  pool: Pool,
  expected: { readonly database: string; readonly role: string },
): Promise<ProductionInitialStateEvidence> {
  const identity = await pool.query<{
    database: string;
    schema: string;
    role: string;
    is_superuser: boolean;
    can_create_role: boolean;
    can_create_database: boolean;
    can_replicate: boolean;
    bypasses_rls: boolean;
    can_create_database_object: boolean;
    can_create_public_object: boolean;
    can_use_public: boolean;
    owns_public_objects: boolean;
    inherited_role_count: string;
  }>(
    `SELECT current_database() AS database,current_schema() AS schema,current_user AS role,
            database_role.rolsuper AS is_superuser,database_role.rolcreaterole AS can_create_role,
            database_role.rolcreatedb AS can_create_database,database_role.rolreplication AS can_replicate,
            database_role.rolbypassrls AS bypasses_rls,
            has_database_privilege(current_user,current_database(),'CREATE') AS can_create_database_object,
            has_schema_privilege(current_user,'public','CREATE') AS can_create_public_object,
            has_schema_privilege(current_user,'public','USAGE') AS can_use_public,
            EXISTS (
              SELECT 1 FROM pg_class relation
              JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
              WHERE namespace.nspname='public' AND relation.relowner=database_role.oid
            ) AS owns_public_objects,
            (SELECT count(*)::text FROM pg_auth_members membership
              JOIN pg_roles member_role ON member_role.oid=membership.member
             WHERE member_role.rolname=current_user) AS inherited_role_count
       FROM pg_roles database_role WHERE database_role.rolname=current_user`,
  );
  const databaseIdentity = identity.rows[0];
  if (!databaseIdentity || databaseIdentity.database !== expected.database) {
    throw new Error("PRODUCTION_DATABASE_IDENTITY_MISMATCH");
  }
  if (databaseIdentity.schema !== "public") throw new Error("PRODUCTION_DATABASE_SCHEMA_MISMATCH");
  if (databaseIdentity.role !== expected.role) throw new Error("PRODUCTION_DATABASE_ROLE_MISMATCH");
  if (databaseIdentity.is_superuser || databaseIdentity.can_create_role || databaseIdentity.can_create_database
    || databaseIdentity.can_replicate || databaseIdentity.bypasses_rls
    || databaseIdentity.can_create_database_object || databaseIdentity.can_create_public_object
    || !databaseIdentity.can_use_public || databaseIdentity.owns_public_objects
    || databaseIdentity.inherited_role_count !== "0") {
    throw new Error("PRODUCTION_DATABASE_ROLE_OVERPRIVILEGED");
  }

  const accounts = await pool.query<{
    id: string;
    status: string;
    registered_at: Date | null;
    roles: string[];
  }>(
    `SELECT account.id,account.status,account.registered_at,
            array_remove(array_agg(account_role.role ORDER BY account_role.role),NULL) AS roles
       FROM account LEFT JOIN account_role ON account_role.account_id=account.id
      GROUP BY account.id,account.status,account.registered_at
      ORDER BY account.id`,
  );
  const administrator = accounts.rows[0];
  if (accounts.rows.length !== 1 || !administrator || administrator.status !== "ACTIVE"
    || !administrator.registered_at || administrator.roles.length !== 1 || administrator.roles[0] !== "ADMIN") {
    throw new Error("PRODUCTION_ADMIN_CARDINALITY_INVALID");
  }
  const bootstrap = await pool.query<{ completed_by: string | null; completed_at: Date | null }>(
    "SELECT completed_by,completed_at FROM identity_bootstrap WHERE singleton=true",
  );
  if (bootstrap.rows.length !== 1 || bootstrap.rows[0]?.completed_by !== administrator.id || !bootstrap.rows[0].completed_at) {
    throw new Error("PRODUCTION_ADMIN_BOOTSTRAP_EVIDENCE_INVALID");
  }

  const inventory = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename",
  );
  const classifiedTables = new Set<string>([...ALLOWED_SYSTEM_TABLES, ...EMPTY_BUSINESS_TABLES]);
  const unclassifiedTables = inventory.rows
    .map(({ tablename }) => tablename)
    .filter((table) => !classifiedTables.has(table));
  if (unclassifiedTables.length > 0) {
    throw new Error(`PRODUCTION_TABLE_CLASSIFICATION_INCOMPLETE:${unclassifiedTables.join(",")}`);
  }

  const countSql = EMPTY_BUSINESS_TABLES.map((table, index) =>
    `SELECT $${index + 1}::text AS table_name,count(*)::text AS row_count FROM public.${table}`).join(" UNION ALL ");
  const counts = await pool.query<{ table_name: string; row_count: string }>(countSql, [...EMPTY_BUSINESS_TABLES]);
  const nonempty = counts.rows.filter(({ row_count }) => BigInt(row_count) !== 0n);
  if (counts.rows.length !== EMPTY_BUSINESS_TABLES.length || nonempty.length > 0) {
    throw new Error(`PRODUCTION_BUSINESS_DATA_NOT_EMPTY:${nonempty.map(({ table_name }) => table_name).join(",") || "TABLE_SET_INCOMPLETE"}`);
  }
  return {
    database: databaseIdentity.database,
    role: databaseIdentity.role,
    administratorId: administrator.id,
    checkedEmptyTables: EMPTY_BUSINESS_TABLES.length,
  };
}
