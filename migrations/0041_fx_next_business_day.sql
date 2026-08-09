BEGIN;

ALTER TABLE calculation_fx_usage
    DROP CONSTRAINT IF EXISTS calculation_fx_usage_check1;

ALTER TABLE calculation_fx_usage
    ADD CONSTRAINT calculation_fx_usage_hit_date_offset_check
    CHECK (abs(hit_date - requested_date) = fallback_days);

COMMENT ON COLUMN calculation_fx_usage.fallback_days IS
    'Compatibility field: absolute calendar-day offset between requested_date and hit_date. New next-business-day-v2 runs use future hit dates; historical runs remain unchanged.';

COMMIT;
