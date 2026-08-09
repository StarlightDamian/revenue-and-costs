BEGIN;

ALTER TABLE upload_file
  ADD COLUMN detected_kind text
  CHECK (detected_kind IS NULL OR detected_kind IN ('ZIP','PDF','TEXT','OTHER'));

COMMIT;
