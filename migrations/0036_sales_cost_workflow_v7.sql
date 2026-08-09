BEGIN;

ALTER TABLE account
  ADD COLUMN accounting_continent_prefixes text[] NOT NULL DEFAULT ARRAY['EU']::text[],
  ADD CONSTRAINT account_accounting_continent_prefixes_check CHECK (
    accounting_continent_prefixes <@ ARRAY['AS','EU','AF','AM','OC']::text[]
    AND cardinality(accounting_continent_prefixes) <= 5
  );

COMMENT ON COLUMN account.accounting_continent_prefixes IS
  'Canonical account-level continent prefixes used only when rendering marketplace labels in exports.';

LOCK TABLE export_request IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE export_request
  ADD COLUMN continent_prefixes text[];
UPDATE export_request SET continent_prefixes = ARRAY['EU']::text[] WHERE continent_prefixes IS NULL;
ALTER TABLE export_request
  ALTER COLUMN continent_prefixes SET NOT NULL,
  ADD CONSTRAINT export_request_continent_prefixes_check CHECK (
    continent_prefixes <@ ARRAY['AS','EU','AF','AM','OC']::text[]
    AND cardinality(continent_prefixes) <= 5
  );

COMMENT ON COLUMN export_request.continent_prefixes IS
  'Immutable canonical continent-prefix snapshot used by this export request.';

CREATE TABLE account_onboarding_state (
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  guide_key text NOT NULL CHECK (guide_key IN ('WORKSPACE', 'SHOP_WORKFLOW')),
  resource_key text NOT NULL,
  guide_version integer NOT NULL CHECK (guide_version > 0),
  dismissed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id, guide_key, resource_key, guide_version),
  CHECK (
    (guide_key = 'WORKSPACE' AND resource_key = 'GLOBAL')
    OR (guide_key = 'SHOP_WORKFLOW' AND resource_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
  )
);

COMMENT ON TABLE account_onboarding_state IS
  'Cross-device, versioned dismissal state for non-blocking workspace and per-shop onboarding guides.';

ALTER TABLE shop_charge DROP CONSTRAINT shop_charge_check;
ALTER TABLE shop_charge ADD CONSTRAINT shop_charge_amount_waiver_check CHECK (
  (charged_amount_cents = original_amount_cents AND waiver_type IS NULL AND waiver_reason IS NULL AND wallet_ledger_id IS NOT NULL)
  OR (charged_amount_cents = 0 AND original_amount_cents = 0 AND waiver_type IS NULL AND waiver_reason IS NULL AND wallet_ledger_id IS NULL)
  OR (charged_amount_cents = 0 AND waiver_type = 'ADMIN_FREE' AND (waiver_reason IS NULL OR length(btrim(waiver_reason)) > 0) AND wallet_ledger_id IS NULL)
);

COMMIT;
