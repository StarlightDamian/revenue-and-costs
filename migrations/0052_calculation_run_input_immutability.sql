BEGIN;

CREATE FUNCTION protect_calculation_run_inputs() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF ROW(
        NEW.shop_id,
        NEW.application_price_version_id,
        NEW.marketplace_policy_version_id,
        NEW.timezone_policy_version,
        NEW.formula_version,
        NEW.code_version,
        NEW.fee_classification_version,
        NEW.input_manifest,
        NEW.input_manifest_sha256,
        NEW.requested_by,
        NEW.created_at
    ) IS DISTINCT FROM ROW(
        OLD.shop_id,
        OLD.application_price_version_id,
        OLD.marketplace_policy_version_id,
        OLD.timezone_policy_version,
        OLD.formula_version,
        OLD.code_version,
        OLD.fee_classification_version,
        OLD.input_manifest,
        OLD.input_manifest_sha256,
        OLD.requested_by,
        OLD.created_at
    ) THEN
        RAISE EXCEPTION 'IMMUTABLE_CALCULATION_RUN_INPUTS';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER calculation_run_inputs_immutable
BEFORE UPDATE ON calculation_run
FOR EACH ROW EXECUTE FUNCTION protect_calculation_run_inputs();

COMMIT;
