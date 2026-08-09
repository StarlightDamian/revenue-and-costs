BEGIN;

ALTER TABLE account
  ADD COLUMN accounting_profit_rate numeric(9,8),
  ADD COLUMN minimum_sales_cost_rate numeric(9,8),
  ADD CONSTRAINT account_accounting_profit_rate_check
    CHECK (accounting_profit_rate BETWEEN 0 AND 1),
  ADD CONSTRAINT account_minimum_sales_cost_rate_check
    CHECK (minimum_sales_cost_rate BETWEEN 0 AND 1);

COMMENT ON COLUMN account.accounting_profit_rate IS
  'Optional account-level default target profit ratio used only for export cost projections.';
COMMENT ON COLUMN account.minimum_sales_cost_rate IS
  'Optional account-level minimum procurement cost ratio used only for export cost projections.';

ALTER TABLE export_request
  ADD COLUMN profit_rate numeric(9,8),
  ADD COLUMN minimum_sales_cost_rate numeric(9,8),
  ADD CONSTRAINT export_request_profit_rate_check
    CHECK (profit_rate BETWEEN 0 AND 1),
  ADD CONSTRAINT export_request_minimum_sales_cost_rate_check
    CHECK (minimum_sales_cost_rate BETWEEN 0 AND 1);

COMMENT ON COLUMN export_request.profit_rate IS
  'Immutable per-export target profit ratio; NULL preserves the legacy zero-procurement projection.';
COMMENT ON COLUMN export_request.minimum_sales_cost_rate IS
  'Immutable per-export minimum procurement cost ratio; NULL disables the floor.';

COMMIT;
