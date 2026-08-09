BEGIN;

CREATE TABLE fx_sync_run (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_kind text NOT NULL CHECK (sync_kind IN ('FULL_HISTORY', 'RECENT_SEVEN_DAYS', 'MANUAL_RETRY')),
    requested_from date,
    requested_to date,
    status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
    coverage_from date,
    coverage_to date,
    attempt_count integer NOT NULL DEFAULT 1 CHECK (attempt_count > 0),
    error_code text,
    started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finished_at timestamptz,
    CHECK (requested_from IS NULL OR requested_to IS NULL OR requested_from <= requested_to),
    CHECK (coverage_from IS NULL OR coverage_to IS NULL OR coverage_from <= coverage_to),
    CHECK ((status = 'RUNNING' AND finished_at IS NULL) OR (status <> 'RUNNING' AND finished_at IS NOT NULL))
);

CREATE INDEX fx_sync_run_status_time_idx ON fx_sync_run (status, started_at DESC);

CREATE TABLE fx_raw_snapshot (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    sync_run_id uuid NOT NULL REFERENCES fx_sync_run(id) ON DELETE RESTRICT,
    source_name text NOT NULL DEFAULT 'ChinaMoney',
    request_parameters jsonb NOT NULL,
    response_payload jsonb NOT NULL,
    response_sha256 bytea NOT NULL CHECK (octet_length(response_sha256) = 32),
    http_status integer NOT NULL CHECK (http_status BETWEEN 100 AND 599),
    response_headers jsonb NOT NULL DEFAULT '{}'::jsonb,
    fetched_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (source_name, response_sha256)
);

CREATE TABLE fx_quote (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_id uuid NOT NULL REFERENCES fx_raw_snapshot(id) ON DELETE RESTRICT,
    valid_date date NOT NULL,
    base_currency text NOT NULL CHECK (base_currency ~ '^[A-Z]{3}$'),
    quote_currency text NOT NULL CHECK (quote_currency ~ '^[A-Z]{3}$'),
    base_unit numeric(30,8) NOT NULL CHECK (base_unit > 0),
    rate numeric(30,8) NOT NULL CHECK (rate > 0),
    cny_currency text NOT NULL CHECK (cny_currency ~ '^[A-Z]{3}$' AND cny_currency <> 'CNY'),
    cny_per_unit numeric(30,8) NOT NULL CHECK (cny_per_unit > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((quote_currency = 'CNY' AND base_currency = cny_currency) OR
           (base_currency = 'CNY' AND quote_currency = cny_currency)),
    UNIQUE (snapshot_id, valid_date, base_currency, quote_currency, base_unit),
    UNIQUE (snapshot_id, valid_date, cny_currency)
);

CREATE INDEX fx_quote_currency_date_idx ON fx_quote (cny_currency, valid_date DESC);
CREATE INDEX fx_quote_date_idx ON fx_quote (valid_date, cny_currency);

CREATE VIEW fx_current_quote AS
SELECT DISTINCT ON (q.valid_date, q.cny_currency) q.*
  FROM fx_quote q
  JOIN fx_raw_snapshot raw ON raw.id = q.snapshot_id
  JOIN fx_sync_run run ON run.id = raw.sync_run_id AND run.status = 'SUCCEEDED'
 ORDER BY q.valid_date, q.cny_currency, raw.fetched_at DESC, q.created_at DESC, q.id DESC;

CREATE TABLE fx_market_day (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    valid_date date NOT NULL,
    status text NOT NULL CHECK (status IN ('OPEN', 'NON_TRADING')),
    evidence_type text NOT NULL CHECK (evidence_type IN ('OFFICIAL_CALENDAR', 'ALL_OFFICIAL_PAIRS_ABSENT')),
    snapshot_id uuid REFERENCES fx_raw_snapshot(id) ON DELETE RESTRICT,
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (valid_date, evidence_type)
);

CREATE TABLE fx_override (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$' AND currency <> 'CNY'),
    valid_from date NOT NULL,
    valid_to date NOT NULL,
    cny_per_unit numeric(30,8) NOT NULL CHECK (cny_per_unit > 0),
    source_reference text NOT NULL CHECK (length(btrim(source_reference)) > 0),
    reason text NOT NULL CHECK (length(btrim(reason)) > 0),
    created_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (valid_from <= valid_to),
    UNIQUE (currency, valid_from, valid_to)
);

CREATE OR REPLACE FUNCTION reject_fx_override_when_official_exists()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM fx_quote q
         WHERE q.cny_currency = NEW.currency
           AND q.valid_date BETWEEN NEW.valid_from AND NEW.valid_to
    ) THEN
        RAISE EXCEPTION 'manual FX may only fill an official quote gap' USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
        SELECT 1 FROM fx_override o
         WHERE o.currency = NEW.currency
           AND daterange(o.valid_from, o.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')
    ) THEN
        RAISE EXCEPTION 'manual FX validity ranges may not overlap' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER fx_override_official_gap_only
BEFORE INSERT ON fx_override
FOR EACH ROW EXECUTE FUNCTION reject_fx_override_when_official_exists();

CREATE TABLE fx_batch_conversion (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    input_sha256 bytea NOT NULL CHECK (octet_length(input_sha256) = 32),
    from_currency text NOT NULL CHECK (from_currency ~ '^[A-Z]{3}$'),
    to_currency text NOT NULL CHECK (to_currency ~ '^[A-Z]{3}$'),
    row_count bigint NOT NULL CHECK (row_count >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (account_id, input_sha256, from_currency, to_currency)
);

CREATE TRIGGER fx_raw_snapshot_immutable
BEFORE UPDATE OR DELETE ON fx_raw_snapshot
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER fx_quote_immutable
BEFORE UPDATE OR DELETE ON fx_quote
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER fx_market_day_immutable
BEFORE UPDATE OR DELETE ON fx_market_day
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
CREATE TRIGGER fx_override_immutable
BEFORE UPDATE OR DELETE ON fx_override
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();

COMMIT;
