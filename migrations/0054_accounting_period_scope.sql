BEGIN;

ALTER TABLE import_batch
    ADD COLUMN accounting_period_start date,
    ADD COLUMN accounting_period_end date,
    ADD CONSTRAINT import_batch_accounting_period_scope_check CHECK (
        (accounting_period_start IS NULL AND accounting_period_end IS NULL)
        OR (
            accounting_period_start IS NOT NULL
            AND accounting_period_end IS NOT NULL
            AND extract(day FROM accounting_period_start) = 1
            AND extract(day FROM accounting_period_end) = 1
            AND accounting_period_start <= accounting_period_end
            AND date_trunc('year', accounting_period_start) = date_trunc('year', accounting_period_end)
        )
    );

ALTER TABLE calculation_run_slice
    DROP CONSTRAINT calculation_run_slice_disposition_check,
    ADD CONSTRAINT calculation_run_slice_disposition_check
        CHECK (disposition IN ('INCLUDED', 'INCLUDED_WITH_WARNING', 'HARD_EXCLUDED', 'OUT_OF_SCOPE'));

ALTER TABLE published_snapshot_slice
    DROP CONSTRAINT published_snapshot_slice_disposition_check,
    ADD CONSTRAINT published_snapshot_slice_disposition_check
        CHECK (disposition IN ('INCLUDED', 'INCLUDED_WITH_WARNING', 'HARD_EXCLUDED', 'OUT_OF_SCOPE'));

COMMIT;
