ALTER TABLE upload_batch
  ADD COLUMN expanded_bytes bigint NOT NULL DEFAULT 0
  CHECK (expanded_bytes BETWEEN 0 AND 8589934592);

ALTER TABLE upload_file
  ADD COLUMN archive_expanded_bytes bigint NOT NULL DEFAULT 0
  CHECK (archive_expanded_bytes BETWEEN 0 AND 8589934592),
  ADD COLUMN archive_file_count integer NOT NULL DEFAULT 0
  CHECK (archive_file_count BETWEEN 0 AND 20000),
  ADD COLUMN archive_reservation_state text NOT NULL DEFAULT 'NONE'
  CHECK (archive_reservation_state IN ('NONE','RESERVED','COMMITTED')),
  ADD CONSTRAINT upload_file_archive_reservation_shape CHECK (
    (archive_reservation_state = 'NONE' AND archive_expanded_bytes = 0 AND archive_file_count = 0)
    OR archive_reservation_state IN ('RESERVED','COMMITTED')
  );

CREATE INDEX upload_file_archive_reservation_idx
  ON upload_file (batch_id, archive_reservation_state)
  WHERE archive_reservation_state = 'RESERVED';
