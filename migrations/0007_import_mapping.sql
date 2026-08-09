BEGIN;

CREATE TABLE field_mapping (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    report_kind text NOT NULL CHECK (report_kind IN ('SHIPMENT', 'TRANSACTION')),
    locale text NOT NULL CHECK (length(btrim(locale)) > 0),
    name text NOT NULL CHECK (length(btrim(name)) > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (report_kind, locale, name)
);

CREATE TABLE field_mapping_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    field_mapping_id uuid NOT NULL REFERENCES field_mapping(id) ON DELETE RESTRICT,
    version_no integer NOT NULL CHECK (version_no > 0),
    definition jsonb NOT NULL,
    definition_sha256 bytea NOT NULL CHECK (octet_length(definition_sha256) = 32),
    created_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (field_mapping_id, version_no),
    UNIQUE (field_mapping_id, definition_sha256)
);

CREATE TABLE import_batch (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    upload_batch_id uuid NOT NULL REFERENCES upload_batch(id) ON DELETE RESTRICT,
    status text NOT NULL CHECK (status IN (
        'DRAFT', 'UPLOADING', 'ANALYZING', 'AWAITING_FILES', 'AWAITING_MAPPING',
        'AWAITING_COMMIT_CONFIRMATION', 'COMMITTING', 'COMMITTED',
        'COMMITTED_WITH_EXCLUSIONS', 'CALCULATING', 'READY_FOR_REVIEW',
        'RESULT_PUBLISHING', 'RESULT_PUBLISHED', 'CANCELLED', 'FAILED', 'RETRYING'
    )),
    current_stage text NOT NULL,
    failure_code text,
    idempotency_key text NOT NULL,
    created_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (shop_id, idempotency_key),
    UNIQUE (upload_batch_id)
);

CREATE INDEX import_batch_shop_status_idx ON import_batch (shop_id, status, created_at DESC);

CREATE TABLE import_file (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE RESTRICT,
    stored_object_id uuid NOT NULL REFERENCES stored_object(id) ON DELETE RESTRICT,
    relative_path text NOT NULL CHECK (octet_length(relative_path) <= 1024),
    classification text NOT NULL CHECK (classification IN ('SHIPMENT', 'TRANSACTION', 'LIST_ONLY', 'TEMPORARY', 'UNKNOWN')),
    parse_status text NOT NULL CHECK (parse_status IN ('PENDING', 'PARSED', 'AWAITING_MAPPING', 'EXCLUDED', 'FAILED')),
    detected_encoding text,
    detected_delimiter text CHECK (detected_delimiter IS NULL OR detected_delimiter IN (',', E'\t')),
    header_line_number bigint CHECK (header_line_number IS NULL OR header_line_number > 0),
    mapping_version_id uuid REFERENCES field_mapping_version(id) ON DELETE RESTRICT,
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
    read_row_count bigint NOT NULL DEFAULT 0 CHECK (read_row_count >= 0),
    inserted_row_count bigint NOT NULL DEFAULT 0 CHECK (inserted_row_count >= 0),
    excluded_row_count bigint NOT NULL DEFAULT 0 CHECK (excluded_row_count >= 0),
    error_row_count bigint NOT NULL DEFAULT 0 CHECK (error_row_count >= 0),
    excluded_amount_original numeric(30,8) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (import_batch_id, stored_object_id),
    CHECK (read_row_count = inserted_row_count + excluded_row_count + error_row_count),
    CHECK ((parse_status <> 'PARSED') OR mapping_version_id IS NOT NULL)
);

CREATE INDEX import_file_batch_status_idx ON import_file (import_batch_id, parse_status);

CREATE TABLE import_issue (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE RESTRICT,
    import_file_id uuid REFERENCES import_file(id) ON DELETE RESTRICT,
    severity text NOT NULL CHECK (severity IN ('INFO', 'WARNING', 'ERROR')),
    issue_code text NOT NULL,
    row_number bigint CHECK (row_number IS NULL OR row_number > 0),
    field_name text,
    safe_context jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX import_issue_batch_severity_idx ON import_issue (import_batch_id, severity, id);

CREATE TRIGGER field_mapping_version_immutable
BEFORE UPDATE OR DELETE ON field_mapping_version
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER import_issue_immutable
BEFORE UPDATE OR DELETE ON import_issue
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();

COMMIT;
