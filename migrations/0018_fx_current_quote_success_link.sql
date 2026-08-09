BEGIN;

CREATE OR REPLACE VIEW fx_current_quote AS
SELECT DISTINCT ON (q.valid_date, q.cny_currency) q.*
  FROM fx_quote q
  JOIN fx_raw_snapshot raw ON raw.id = q.snapshot_id
  JOIN fx_sync_run_snapshot link ON link.snapshot_id = raw.id
  JOIN fx_sync_run run ON run.id = link.sync_run_id AND run.status = 'SUCCEEDED'
 ORDER BY q.valid_date, q.cny_currency, run.finished_at DESC, raw.fetched_at DESC, q.created_at DESC, q.id DESC;

COMMIT;
