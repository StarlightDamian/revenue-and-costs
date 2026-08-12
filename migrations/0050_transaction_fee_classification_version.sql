BEGIN;

-- Historical fee-component rows are immutable. Tag them as v1 and let new
-- imports write v2 so the corrected multilingual routing remains auditable
-- without rewriting an existing fact or published calculation.
ALTER TABLE transaction_fee_component
    ADD COLUMN classification_version text NOT NULL DEFAULT 'transaction-fee-v1';

ALTER TABLE transaction_fee_component
    ADD CONSTRAINT transaction_fee_component_classification_version_check
    CHECK (classification_version IN ('transaction-fee-v1', 'transaction-fee-v2'));

COMMIT;
