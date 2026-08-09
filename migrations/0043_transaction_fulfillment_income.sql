ALTER TABLE transaction_fact
    ADD COLUMN fulfillment_mode text;

ALTER TABLE transaction_fact
    ADD CONSTRAINT transaction_fact_fulfillment_mode_check
    CHECK (fulfillment_mode IN ('AMAZON', 'MERCHANT', 'BLANK'));

COMMENT ON COLUMN transaction_fact.fulfillment_mode IS
    'Normalized fulfillment mode. NULL identifies a legacy fact that must be reimported before the merchant-order income formula can run.';
