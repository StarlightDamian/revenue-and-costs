BEGIN;

ALTER TABLE upload_file
  ADD COLUMN metadata_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT upload_file_metadata_only_pdf_check CHECK (
    NOT metadata_only OR (declared_size = 0 AND received_size = 0 AND lower(relative_path) LIKE '%.pdf')
  );

ALTER TABLE import_file
  ALTER COLUMN stored_object_id DROP NOT NULL,
  ADD COLUMN metadata_only boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT import_file_metadata_only_check CHECK (
    NOT metadata_only OR (
      stored_object_id IS NULL AND classification = 'LIST_ONLY' AND parse_status = 'EXCLUDED' AND size_bytes = 0
    )
  );

ALTER TABLE import_file
  DROP CONSTRAINT import_file_import_batch_id_stored_object_id_key;

CREATE UNIQUE INDEX import_file_batch_object_uk
  ON import_file (import_batch_id, stored_object_id)
  WHERE stored_object_id IS NOT NULL;

CREATE UNIQUE INDEX import_file_batch_metadata_path_uk
  ON import_file (import_batch_id, relative_path)
  WHERE metadata_only;

COMMIT;
