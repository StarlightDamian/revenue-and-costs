CREATE TABLE upload_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  created_by uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('OPEN','UPLOADING','FINALIZING','READY','FAILED','EXPIRED')),
  declared_bytes bigint NOT NULL DEFAULT 0 CHECK (declared_bytes BETWEEN 0 AND 2147483648),
  received_bytes bigint NOT NULL DEFAULT 0 CHECK (received_bytes BETWEEN 0 AND 2147483648),
  file_count integer NOT NULL DEFAULT 0 CHECK (file_count BETWEEN 0 AND 20000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX upload_batch_shop_time_idx ON upload_batch (shop_id, created_at DESC);
CREATE INDEX upload_batch_expiry_idx ON upload_batch (expires_at) WHERE status IN ('OPEN','UPLOADING');

CREATE TABLE upload_file (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES upload_batch(id),
  relative_path text NOT NULL,
  declared_size bigint NOT NULL CHECK (declared_size BETWEEN 0 AND 2147483648),
  received_size bigint NOT NULL DEFAULT 0 CHECK (received_size >= 0),
  content_type text,
  plaintext_sha256 text,
  status text NOT NULL CHECK (status IN ('PENDING','UPLOADING','COMPLETE','ENCRYPTING','STORED','FAILED')),
  temp_path text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (batch_id, relative_path),
  CHECK (octet_length(relative_path) <= 1024),
  CHECK (received_size <= declared_size)
);

CREATE INDEX upload_file_batch_status_idx ON upload_file (batch_id, status);

CREATE TABLE upload_chunk_receipt (
  upload_file_id uuid NOT NULL REFERENCES upload_file(id),
  chunk_offset bigint NOT NULL CHECK (chunk_offset >= 0),
  chunk_size integer NOT NULL CHECK (chunk_size BETWEEN 0 AND 16777216),
  sha256 text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (upload_file_id, chunk_offset)
);

CREATE TABLE stored_object (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_kind text NOT NULL CHECK (object_kind IN ('SOURCE','EXPORT','FX_RAW','BACKUP_MANIFEST')),
  owner_shop_id uuid,
  immutable_key text NOT NULL UNIQUE,
  storage_path text NOT NULL UNIQUE,
  plaintext_size bigint NOT NULL CHECK (plaintext_size >= 0),
  plaintext_sha256 text NOT NULL,
  ciphertext_sha256 text NOT NULL,
  encryption_format text NOT NULL CHECK (encryption_format = 'AWS_ESDK_V2_FRAMED'),
  encryption_context jsonb NOT NULL,
  verification_status text NOT NULL CHECK (verification_status IN ('LOCAL_VERIFIED','REMOTE_VERIFIED','FAILED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE stored_object_replica (
  object_id uuid NOT NULL REFERENCES stored_object(id),
  replica_name text NOT NULL,
  storage_path text NOT NULL,
  ciphertext_sha256 text NOT NULL,
  verified_at timestamptz,
  status text NOT NULL CHECK (status IN ('COPYING','VERIFIED','FAILED')),
  PRIMARY KEY (object_id, replica_name)
);

CREATE TABLE original_download_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  object_id uuid NOT NULL REFERENCES stored_object(id),
  account_id uuid NOT NULL,
  shop_id uuid NOT NULL,
  authorization_version bigint NOT NULL,
  reason text,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER stored_object_immutable
BEFORE UPDATE OR DELETE ON stored_object
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
