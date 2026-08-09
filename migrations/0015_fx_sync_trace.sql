BEGIN;

CREATE TABLE fx_sync_run_snapshot (
    sync_run_id uuid NOT NULL REFERENCES fx_sync_run(id) ON DELETE RESTRICT,
    snapshot_id uuid NOT NULL REFERENCES fx_raw_snapshot(id) ON DELETE RESTRICT,
    page_number integer NOT NULL CHECK (page_number > 0),
    linked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (sync_run_id, page_number),
    UNIQUE (sync_run_id, snapshot_id)
);

INSERT INTO fx_sync_run_snapshot(sync_run_id, snapshot_id, page_number)
SELECT raw.sync_run_id,
       raw.id,
       row_number() OVER (PARTITION BY raw.sync_run_id ORDER BY raw.fetched_at, raw.id)::integer
  FROM fx_raw_snapshot raw
ON CONFLICT DO NOTHING;

CREATE INDEX fx_sync_run_snapshot_snapshot_idx
    ON fx_sync_run_snapshot(snapshot_id, sync_run_id);

CREATE TRIGGER fx_sync_run_snapshot_immutable
BEFORE UPDATE OR DELETE ON fx_sync_run_snapshot
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();

COMMIT;
