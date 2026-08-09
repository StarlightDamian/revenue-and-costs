BEGIN;

ALTER TABLE upload_file
  ADD COLUMN stored_object_id uuid REFERENCES stored_object(id) ON DELETE RESTRICT;

UPDATE upload_file f
   SET stored_object_id = so.id
  FROM stored_object so
 WHERE so.immutable_key = 'source/' || f.id::text;

CREATE INDEX upload_file_stored_object_idx
  ON upload_file (stored_object_id)
  WHERE stored_object_id IS NOT NULL;

CREATE UNIQUE INDEX stored_object_source_shop_content_uk
  ON stored_object (owner_shop_id, plaintext_sha256, plaintext_size)
  WHERE object_kind = 'SOURCE';

COMMIT;
