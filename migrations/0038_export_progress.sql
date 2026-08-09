BEGIN;

ALTER TABLE export_request
  ADD COLUMN stage text NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN progress_percent smallint NOT NULL DEFAULT 0,
  ADD COLUMN processed_rows bigint NOT NULL DEFAULT 0,
  ADD COLUMN total_rows bigint,
  ADD COLUMN heartbeat_at timestamptz,
  ADD CONSTRAINT export_request_stage_check CHECK (stage IN (
    'QUEUED','VALIDATING','QUERYING','WRITING_NOTES','WRITING_MONTHLY',
    'WRITING_QUARTERLY','WRITING_ANNUAL','WRITING_COST','FINALIZING_XLSX',
    'HASHING','PACKAGING','ENCRYPTING','COMMITTING','SUCCEEDED','FAILED',
    'CANCELLED','REVOKED'
  )),
  ADD CONSTRAINT export_request_progress_percent_check CHECK (progress_percent BETWEEN 0 AND 100),
  ADD CONSTRAINT export_request_processed_rows_check CHECK (processed_rows >= 0),
  ADD CONSTRAINT export_request_total_rows_check CHECK (total_rows IS NULL OR total_rows >= 0),
  ADD CONSTRAINT export_request_progress_rows_check CHECK (total_rows IS NULL OR processed_rows <= total_rows);

UPDATE export_request
   SET stage = CASE status
         WHEN 'RUNNING' THEN 'VALIDATING'
         WHEN 'SUCCEEDED' THEN 'SUCCEEDED'
         WHEN 'FAILED' THEN 'FAILED'
         WHEN 'CANCELLED' THEN 'CANCELLED'
         WHEN 'REVOKED' THEN 'REVOKED'
         ELSE 'QUEUED'
       END,
       progress_percent = CASE status WHEN 'SUCCEEDED' THEN 100 WHEN 'RUNNING' THEN 1 ELSE 0 END,
       heartbeat_at = CASE
         WHEN status = 'RUNNING' THEN COALESCE(started_at, created_at)
         WHEN status IN ('SUCCEEDED','FAILED','CANCELLED','REVOKED') THEN COALESCE(finished_at, started_at, created_at)
         ELSE NULL
       END;

COMMENT ON COLUMN export_request.stage IS
  'Durable UI-facing export stage; pg-boss remains authoritative for queue lease and retries.';
COMMENT ON COLUMN export_request.progress_percent IS
  'Monotonic progress projection derived from durable stage milestones and committed row counts.';
COMMENT ON COLUMN export_request.processed_rows IS
  'Number of report source rows written at the latest durable progress checkpoint.';
COMMENT ON COLUMN export_request.total_rows IS
  'Total report source rows once the frozen export input has been built; NULL while unknown.';
COMMENT ON COLUMN export_request.heartbeat_at IS
  'Business progress heartbeat independent from the pg-boss lease heartbeat.';

COMMIT;
