CREATE TABLE recovery_checkpoint (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_kind text NOT NULL CHECK (checkpoint_kind IN ('DATABASE_BASE','DATABASE_WAL','OBJECT_MANIFEST','FULL_RESTORE_TEST')),
  source_version text NOT NULL,
  manifest_object_id uuid REFERENCES stored_object(id),
  status text NOT NULL CHECK (status IN ('CREATED','VERIFIED','FAILED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  verified_at timestamptz
);

CREATE INDEX recovery_checkpoint_kind_time_idx ON recovery_checkpoint (checkpoint_kind, created_at DESC);

CREATE TABLE backup_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_key text NOT NULL UNIQUE,
  backup_kind text NOT NULL CHECK (backup_kind IN ('BASE','INCREMENTAL','RESTORE_DRILL')),
  status text NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED')),
  target_name text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  manifest_sha256 text,
  error_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX backup_run_status_time_idx ON backup_run (status, started_at DESC);

CREATE TABLE operational_alert (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  severity text NOT NULL CHECK (severity IN ('INFO','WARNING','CRITICAL')),
  alert_type text NOT NULL,
  deduplication_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  resolved_at timestamptz,
  UNIQUE (alert_type, deduplication_key, status)
);
