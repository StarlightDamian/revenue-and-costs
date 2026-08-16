BEGIN;

ALTER TABLE transaction_fee_component
    DROP CONSTRAINT transaction_fee_component_classification_version_check;

ALTER TABLE transaction_fee_component
    ADD CONSTRAINT transaction_fee_component_classification_version_check
    CHECK (classification_version IN ('transaction-fee-v1', 'transaction-fee-v2', 'transaction-fee-v3'));

ALTER TABLE transaction_fee_component
    DROP CONSTRAINT transaction_fee_component_reason_check;

ALTER TABLE transaction_fee_component
    ADD CONSTRAINT transaction_fee_component_reason_check
    CHECK ((classification_version='transaction-fee-v1' AND classification_reason IS NULL)
        OR (classification_version IN ('transaction-fee-v2', 'transaction-fee-v3') AND classification_reason IS NOT NULL));

ALTER TABLE calculation_run
    DROP CONSTRAINT calculation_run_fee_classification_version_check;

ALTER TABLE calculation_run
    ADD CONSTRAINT calculation_run_fee_classification_version_check
    CHECK (fee_classification_version IN ('transaction-fee-v1', 'transaction-fee-v2', 'transaction-fee-v3'));

COMMIT;
