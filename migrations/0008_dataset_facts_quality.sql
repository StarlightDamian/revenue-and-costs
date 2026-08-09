BEGIN;

CREATE TABLE marketplace_policy_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    marketplace text NOT NULL,
    normalized_marketplace text NOT NULL,
    iana_timezone text NOT NULL,
    marketplace_size text NOT NULL CHECK (marketplace_size IN ('LARGE', 'SMALL')),
    effective_from timestamptz NOT NULL,
    effective_to timestamptz,
    created_by uuid REFERENCES account(id) ON DELETE RESTRICT,
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (effective_to IS NULL OR effective_to > effective_from),
    UNIQUE (normalized_marketplace, effective_from)
);

CREATE TABLE dataset_slice (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    normalized_marketplace text NOT NULL,
    local_month date NOT NULL CHECK (extract(day FROM local_month) = 1),
    current_version_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (shop_id, normalized_marketplace, local_month)
);

CREATE TABLE dataset_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_slice_id uuid NOT NULL REFERENCES dataset_slice(id) ON DELETE RESTRICT,
    import_batch_id uuid NOT NULL REFERENCES import_batch(id) ON DELETE RESTRICT,
    version_no integer NOT NULL CHECK (version_no > 0),
    status text NOT NULL CHECK (status IN ('DRAFT', 'INCOMPLETE', 'READY', 'ACTIVE', 'SUPERSEDED')),
    manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
    supersedes_version_id uuid REFERENCES dataset_version(id) ON DELETE RESTRICT,
    activated_at timestamptz,
    created_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (dataset_slice_id, version_no),
    UNIQUE (dataset_slice_id, manifest_sha256)
);

ALTER TABLE dataset_slice
    ADD CONSTRAINT dataset_slice_current_version_fk
    FOREIGN KEY (current_version_id) REFERENCES dataset_version(id) ON DELETE RESTRICT;

CREATE INDEX dataset_version_slice_status_idx ON dataset_version (dataset_slice_id, status, version_no DESC);

CREATE TABLE dataset_source_binding (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    report_kind text NOT NULL CHECK (report_kind IN ('SHIPMENT', 'TRANSACTION')),
    import_file_id uuid NOT NULL REFERENCES import_file(id) ON DELETE RESTRICT,
    mapping_version_id uuid NOT NULL REFERENCES field_mapping_version(id) ON DELETE RESTRICT,
    carried_forward_from_version_id uuid REFERENCES dataset_version(id) ON DELETE RESTRICT,
    coverage_start date NOT NULL,
    coverage_end date NOT NULL,
    official_zero_evidence boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (coverage_start <= coverage_end),
    UNIQUE (dataset_version_id, report_kind, import_file_id)
);

CREATE INDEX dataset_source_binding_version_kind_idx
    ON dataset_source_binding (dataset_version_id, report_kind);

CREATE TABLE shipment_fact (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    source_file_id uuid NOT NULL REFERENCES import_file(id) ON DELETE RESTRICT,
    row_number bigint NOT NULL CHECK (row_number > 0),
    row_hash bytea NOT NULL CHECK (octet_length(row_hash) = 32),
    original_datetime_text text NOT NULL,
    parsed_at timestamptz NOT NULL,
    source_timezone text NOT NULL,
    fx_date date NOT NULL,
    marketplace_local_date date NOT NULL,
    local_month date NOT NULL CHECK (extract(day FROM local_month) = 1),
    normalized_marketplace text NOT NULL,
    original_sales_channel text NOT NULL,
    order_id text,
    sku text,
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    shipped_quantity numeric(30,8) NOT NULL,
    product_price numeric(30,8) NOT NULL DEFAULT 0,
    product_tax numeric(30,8) NOT NULL DEFAULT 0,
    shipping_price numeric(30,8) NOT NULL DEFAULT 0,
    shipping_tax numeric(30,8) NOT NULL DEFAULT 0,
    gift_wrap_price numeric(30,8) NOT NULL DEFAULT 0,
    gift_wrap_tax numeric(30,8) NOT NULL DEFAULT 0,
    product_promotion_discount numeric(30,8) NOT NULL DEFAULT 0,
    shipment_promotion_discount numeric(30,8) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (dataset_version_id, source_file_id, row_number)
);

CREATE INDEX shipment_fact_version_market_month_idx
    ON shipment_fact (dataset_version_id, normalized_marketplace, local_month);

CREATE TABLE transaction_fact (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    source_file_id uuid NOT NULL REFERENCES import_file(id) ON DELETE RESTRICT,
    row_number bigint NOT NULL CHECK (row_number > 0),
    row_hash bytea NOT NULL CHECK (octet_length(row_hash) = 32),
    original_datetime_text text NOT NULL,
    parsed_at timestamptz NOT NULL,
    source_timezone text NOT NULL,
    fx_date date NOT NULL,
    marketplace_local_date date NOT NULL,
    local_month date NOT NULL CHECK (extract(day FROM local_month) = 1),
    normalized_marketplace text NOT NULL,
    normalized_type text NOT NULL,
    normalized_description text NOT NULL,
    order_id text,
    sku text,
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    quantity numeric(30,8) NOT NULL DEFAULT 0,
    product_sales numeric(30,8) NOT NULL DEFAULT 0,
    product_sales_tax numeric(30,8) NOT NULL DEFAULT 0,
    shipping_credits numeric(30,8) NOT NULL DEFAULT 0,
    shipping_credits_tax numeric(30,8) NOT NULL DEFAULT 0,
    gift_wrap_credits numeric(30,8) NOT NULL DEFAULT 0,
    gift_wrap_credits_tax numeric(30,8) NOT NULL DEFAULT 0,
    regulatory_fee numeric(30,8) NOT NULL DEFAULT 0,
    tax_on_regulatory_fee numeric(30,8) NOT NULL DEFAULT 0,
    promotional_rebates numeric(30,8) NOT NULL DEFAULT 0,
    promotional_rebates_tax numeric(30,8) NOT NULL DEFAULT 0,
    marketplace_withheld_tax numeric(30,8) NOT NULL DEFAULT 0,
    selling_fees numeric(30,8) NOT NULL DEFAULT 0,
    fba_fees numeric(30,8) NOT NULL DEFAULT 0,
    other_transaction_fees numeric(30,8) NOT NULL DEFAULT 0,
    other_amount numeric(30,8) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (dataset_version_id, source_file_id, row_number)
);

CREATE INDEX transaction_fact_version_market_month_idx
    ON transaction_fact (dataset_version_id, normalized_marketplace, local_month);

CREATE TABLE transaction_fee_component (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_fact_id bigint NOT NULL REFERENCES transaction_fact(id) ON DELETE RESTRICT,
    source_column text NOT NULL,
    category text NOT NULL CHECK (category IN (
        'PLATFORM_FEE', 'FBA_FULFILLMENT_FEE', 'ADVERTISING_FEE',
        'FBA_STORAGE_FEE', 'OTHER_DEDUCTION', 'EXCLUDED_TRANSFER_DEBT'
    )),
    amount_original numeric(30,8) NOT NULL,
    mapping_version_id uuid NOT NULL REFERENCES field_mapping_version(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (transaction_fact_id, source_column)
);

CREATE TABLE reconciliation_result (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    mapping_version_id uuid NOT NULL REFERENCES field_mapping_version(id) ON DELETE RESTRICT,
    applicable boolean NOT NULL,
    shipment_quantity numeric(30,8),
    transaction_quantity numeric(30,8),
    intersection_quantity numeric(30,8),
    unmatched_absolute numeric(30,8),
    unmatched_ratio numeric(30,8),
    warning boolean NOT NULL,
    sample_differences jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((applicable AND shipment_quantity IS NOT NULL AND transaction_quantity IS NOT NULL AND
            intersection_quantity IS NOT NULL AND unmatched_absolute IS NOT NULL AND unmatched_ratio IS NOT NULL)
           OR (NOT applicable AND shipment_quantity IS NULL AND transaction_quantity IS NULL AND
               intersection_quantity IS NULL AND unmatched_absolute IS NULL AND unmatched_ratio IS NULL)),
    CHECK (NOT warning OR applicable),
    UNIQUE (dataset_version_id, mapping_version_id)
);

CREATE TABLE quality_acknowledgement (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    calculation_run_id uuid,
    marketplace_policy_version_id uuid NOT NULL REFERENCES marketplace_policy_version(id) ON DELETE RESTRICT,
    issue_kind text NOT NULL CHECK (issue_kind IN ('HARD_INCOMPLETE', 'SOFT_RECONCILIATION_WARNING')),
    issue_code text NOT NULL,
    actor_account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    confirmation_count smallint NOT NULL CHECK (confirmation_count IN (1, 2)),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX quality_ack_version_kind_idx
    ON quality_acknowledgement (dataset_version_id, issue_kind, created_at DESC);

CREATE TRIGGER marketplace_policy_version_immutable
BEFORE UPDATE OR DELETE ON marketplace_policy_version
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER dataset_source_binding_immutable
BEFORE UPDATE OR DELETE ON dataset_source_binding
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER shipment_fact_immutable
BEFORE UPDATE OR DELETE ON shipment_fact
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER transaction_fact_immutable
BEFORE UPDATE OR DELETE ON transaction_fact
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER transaction_fee_component_immutable
BEFORE UPDATE OR DELETE ON transaction_fee_component
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER reconciliation_result_immutable
BEFORE UPDATE OR DELETE ON reconciliation_result
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER quality_acknowledgement_immutable
BEFORE UPDATE OR DELETE ON quality_acknowledgement
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();

COMMIT;
