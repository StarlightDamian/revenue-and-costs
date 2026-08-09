CREATE TABLE export_request (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  requested_by uuid NOT NULL,
  published_snapshot_id uuid NOT NULL,
  membership_authorization_version bigint,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','REVOKED')),
  business_key text NOT NULL UNIQUE,
  output_object_id uuid REFERENCES stored_object(id),
  output_kind text CHECK (output_kind IN ('XLSX','ZIP')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz NOT NULL
);

CREATE INDEX export_request_shop_time_idx ON export_request (shop_id, created_at DESC);
CREATE INDEX export_request_status_idx ON export_request (status, created_at);

CREATE TABLE export_file_manifest (
  export_request_id uuid NOT NULL REFERENCES export_request(id),
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  file_name text NOT NULL,
  media_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 text NOT NULL,
  row_count bigint,
  PRIMARY KEY (export_request_id, ordinal),
  UNIQUE (export_request_id, file_name)
);
