BEGIN;

CREATE TABLE calculation_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    application_price_version_id uuid NOT NULL REFERENCES application_price_version(id) ON DELETE RESTRICT,
    marketplace_policy_version_id uuid NOT NULL REFERENCES marketplace_policy_version(id) ON DELETE RESTRICT,
    timezone_policy_version text NOT NULL,
    formula_version text NOT NULL,
    code_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'READY', 'BLOCKED', 'FAILED')),
    input_manifest jsonb NOT NULL,
    input_manifest_sha256 bytea NOT NULL CHECK (octet_length(input_manifest_sha256) = 32),
    requested_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    started_at timestamptz,
    finished_at timestamptz,
    failure_code text,
    UNIQUE (shop_id, input_manifest_sha256)
);

CREATE INDEX calculation_run_shop_status_idx ON calculation_run (shop_id, status, created_at DESC);

CREATE TABLE calculation_run_slice (
    calculation_run_id uuid NOT NULL REFERENCES calculation_run(id) ON DELETE RESTRICT,
    dataset_slice_id uuid NOT NULL REFERENCES dataset_slice(id) ON DELETE RESTRICT,
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    disposition text NOT NULL CHECK (disposition IN ('INCLUDED', 'INCLUDED_WITH_WARNING', 'HARD_EXCLUDED')),
    mapping_version_ids uuid[] NOT NULL,
    hard_reason_codes text[] NOT NULL DEFAULT '{}',
    hard_exclusion_acknowledgement_id uuid REFERENCES quality_acknowledgement(id) ON DELETE RESTRICT,
    soft_warning_acknowledgement_id uuid REFERENCES quality_acknowledgement(id) ON DELETE RESTRICT,
    PRIMARY KEY (calculation_run_id, dataset_slice_id),
    CHECK ((disposition = 'HARD_EXCLUDED' AND cardinality(hard_reason_codes) > 0)
        OR (disposition <> 'HARD_EXCLUDED' AND cardinality(hard_reason_codes) = 0 AND hard_exclusion_acknowledgement_id IS NULL)),
    CHECK ((disposition = 'INCLUDED_WITH_WARNING' AND soft_warning_acknowledgement_id IS NOT NULL)
        OR (disposition <> 'INCLUDED_WITH_WARNING' AND soft_warning_acknowledgement_id IS NULL))
);

ALTER TABLE quality_acknowledgement
    ADD CONSTRAINT quality_ack_calculation_run_fk
    FOREIGN KEY (calculation_run_id) REFERENCES calculation_run(id) ON DELETE RESTRICT;

CREATE TABLE calculation_fact_result (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    calculation_run_id uuid NOT NULL REFERENCES calculation_run(id) ON DELETE RESTRICT,
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    fact_kind text NOT NULL CHECK (fact_kind IN ('SHIPMENT', 'TRANSACTION')),
    fact_id bigint NOT NULL,
    source_column text NOT NULL,
    component text NOT NULL CHECK (component IN (
        'INCOME', 'REFUND', 'WITHHELD_TAX', 'PLATFORM_FEE', 'FBA_FULFILLMENT_FEE',
        'ADVERTISING_FEE', 'FBA_STORAGE_FEE', 'OTHER_DEDUCTION'
    )),
    amount_original numeric(30,8) NOT NULL,
    amount_cny numeric(30,8) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (calculation_run_id, fact_kind, fact_id, source_column, component)
);

CREATE INDEX calculation_fact_result_run_component_idx
    ON calculation_fact_result (calculation_run_id, component, id);

CREATE TABLE calculation_fx_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    calculation_fact_result_id bigint NOT NULL UNIQUE REFERENCES calculation_fact_result(id) ON DELETE RESTRICT,
    requested_date date NOT NULL,
    hit_date date NOT NULL,
    fallback_days smallint NOT NULL CHECK (fallback_days BETWEEN 0 AND 10),
    official_quote_ids uuid[] NOT NULL DEFAULT '{}',
    override_ids uuid[] NOT NULL DEFAULT '{}',
    cny_per_unit numeric(30,8) NOT NULL CHECK (cny_per_unit > 0),
    CHECK (cardinality(official_quote_ids) + cardinality(override_ids) > 0 OR cny_per_unit = 1),
    CHECK (hit_date <= requested_date)
);

CREATE TABLE monthly_cost_summary (
    calculation_run_id uuid NOT NULL REFERENCES calculation_run(id) ON DELETE RESTRICT,
    dataset_slice_id uuid NOT NULL REFERENCES dataset_slice(id) ON DELETE RESTRICT,
    income numeric(30,8) NOT NULL,
    refund numeric(30,8) NOT NULL,
    withheld_tax numeric(30,8) NOT NULL,
    platform_fee numeric(30,8) NOT NULL,
    fba_fulfillment_fee numeric(30,8) NOT NULL,
    advertising_fee numeric(30,8) NOT NULL,
    fba_storage_fee numeric(30,8) NOT NULL,
    other_deduction numeric(30,8) NOT NULL,
    platform_balance numeric(30,8) NOT NULL,
    PRIMARY KEY (calculation_run_id, dataset_slice_id),
    CHECK (platform_balance = income - refund - withheld_tax - platform_fee - fba_fulfillment_fee -
           advertising_fee - fba_storage_fee - other_deduction)
);

CREATE TABLE published_snapshot (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    calculation_run_id uuid NOT NULL UNIQUE REFERENCES calculation_run(id) ON DELETE RESTRICT,
    manifest jsonb NOT NULL,
    manifest_sha256 bytea NOT NULL CHECK (octet_length(manifest_sha256) = 32),
    published_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (shop_id, manifest_sha256)
);

CREATE TABLE published_snapshot_slice (
    published_snapshot_id uuid NOT NULL REFERENCES published_snapshot(id) ON DELETE RESTRICT,
    dataset_slice_id uuid NOT NULL REFERENCES dataset_slice(id) ON DELETE RESTRICT,
    dataset_version_id uuid NOT NULL REFERENCES dataset_version(id) ON DELETE RESTRICT,
    disposition text NOT NULL CHECK (disposition IN ('INCLUDED', 'INCLUDED_WITH_WARNING', 'HARD_EXCLUDED')),
    calculation_run_id uuid NOT NULL REFERENCES calculation_run(id) ON DELETE RESTRICT,
    PRIMARY KEY (published_snapshot_id, dataset_slice_id)
);

CREATE TABLE shop_current_published_snapshot (
    shop_id uuid PRIMARY KEY REFERENCES shop(id) ON DELETE RESTRICT,
    published_snapshot_id uuid NOT NULL UNIQUE REFERENCES published_snapshot(id) ON DELETE RESTRICT,
    switched_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TRIGGER calculation_run_slice_immutable
BEFORE UPDATE OR DELETE ON calculation_run_slice
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER calculation_fact_result_immutable
BEFORE UPDATE OR DELETE ON calculation_fact_result
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER calculation_fx_usage_immutable
BEFORE UPDATE OR DELETE ON calculation_fx_usage
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER monthly_cost_summary_immutable
BEFORE UPDATE OR DELETE ON monthly_cost_summary
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER published_snapshot_immutable
BEFORE UPDATE OR DELETE ON published_snapshot
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER published_snapshot_slice_immutable
BEFORE UPDATE OR DELETE ON published_snapshot_slice
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();

COMMIT;
