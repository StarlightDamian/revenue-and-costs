BEGIN;

ALTER TABLE transaction_fee_component
    ADD COLUMN classification_reason text;

ALTER TABLE transaction_fee_component
    DROP CONSTRAINT transaction_fee_component_transaction_fact_id_source_column_key;

CREATE UNIQUE INDEX transaction_fee_component_fact_source_version_uq
    ON transaction_fee_component(transaction_fact_id,source_column,classification_version);

ALTER TABLE transaction_fee_component
    ADD CONSTRAINT transaction_fee_component_reason_check
    CHECK ((classification_version='transaction-fee-v1' AND classification_reason IS NULL)
        OR (classification_version='transaction-fee-v2' AND classification_reason IS NOT NULL));

ALTER TABLE calculation_run
    ADD COLUMN fee_classification_version text NOT NULL DEFAULT 'transaction-fee-v1';

ALTER TABLE calculation_run
    ADD CONSTRAINT calculation_run_fee_classification_version_check
    CHECK (fee_classification_version IN ('transaction-fee-v1', 'transaction-fee-v2'));

COMMIT;
