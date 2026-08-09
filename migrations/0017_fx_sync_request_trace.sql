BEGIN;

ALTER TABLE fx_sync_run_snapshot
    DROP CONSTRAINT fx_sync_run_snapshot_sync_run_id_snapshot_id_key,
    ADD COLUMN request_parameters jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMIT;
