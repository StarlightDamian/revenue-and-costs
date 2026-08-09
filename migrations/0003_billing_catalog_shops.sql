BEGIN;

CREATE TABLE wallet_account (
    account_id uuid PRIMARY KEY REFERENCES account(id) ON DELETE RESTRICT,
    balance_cents bigint NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'RESTRICTED_DEBT', 'RESTRICTED_RECONCILIATION')),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (balance_cents < 0 AND status = 'RESTRICTED_DEBT')
        OR (balance_cents >= 0 AND status IN ('ACTIVE', 'RESTRICTED_RECONCILIATION'))
    )
);

CREATE TABLE wallet_ledger (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    account_id uuid NOT NULL REFERENCES wallet_account(account_id) ON DELETE RESTRICT,
    entry_type text NOT NULL CHECK (entry_type IN (
        'TOP_UP', 'TOP_UP_REVERSAL', 'SHOP_CHARGE', 'ADMIN_ADJUSTMENT', 'DEBT_SETTLEMENT'
    )),
    delta_cents bigint NOT NULL CHECK (delta_cents <> 0),
    balance_after_cents bigint NOT NULL,
    business_key text NOT NULL,
    reference_type text NOT NULL,
    reference_id uuid,
    actor_account_id uuid REFERENCES account(id) ON DELETE RESTRICT,
    reason text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (account_id, business_key),
    CHECK (entry_type <> 'ADMIN_ADJUSTMENT' OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

CREATE INDEX wallet_ledger_account_created_idx ON wallet_ledger (account_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION wallet_ledger_append_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'wallet ledger is append-only' USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER wallet_ledger_no_update_delete
BEFORE UPDATE OR DELETE ON wallet_ledger
FOR EACH ROW EXECUTE FUNCTION wallet_ledger_append_only();

CREATE TABLE payment_order (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    provider text NOT NULL CHECK (provider IN ('WECHAT', 'ALIPAY', 'SANDBOX')),
    merchant_id text NOT NULL,
    credit_amount_cents bigint NOT NULL CHECK (credit_amount_cents >= 10000),
    payable_amount_cents bigint NOT NULL CHECK (payable_amount_cents > 0),
    discount_basis_points integer NOT NULL CHECK (discount_basis_points IN (10000, 9000, 8000)),
    currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
    status text NOT NULL DEFAULT 'CREATED' CHECK (status IN (
        'CREATED', 'PENDING', 'PAID', 'FAILED', 'CLOSED',
        'PARTIALLY_REVERSED', 'REVERSED', 'CHARGEBACK', 'RECONCILIATION_REQUIRED'
    )),
    provider_transaction_id text,
    idempotency_key text NOT NULL,
    paid_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (account_id, idempotency_key),
    UNIQUE (provider, provider_transaction_id),
    CHECK (provider_transaction_id IS NOT NULL OR status IN ('CREATED', 'PENDING', 'FAILED', 'CLOSED'))
);

CREATE TABLE payment_event_inbox (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider text NOT NULL CHECK (provider IN ('WECHAT', 'ALIPAY', 'SANDBOX')),
    provider_event_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('PAID', 'REFUND', 'REVERSAL', 'CHARGEBACK')),
    provider_transaction_id text NOT NULL,
    payment_order_id uuid REFERENCES payment_order(id) ON DELETE RESTRICT,
    payload_sha256 bytea NOT NULL,
    signature_verified boolean NOT NULL CHECK (signature_verified),
    status text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED', 'PROCESSED', 'DUPLICATE', 'RECONCILIATION_REQUIRED')),
    failure_code text,
    received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    processed_at timestamptz,
    UNIQUE (provider, provider_event_id)
);

CREATE INDEX payment_event_transaction_idx
    ON payment_event_inbox (provider, provider_transaction_id, received_at);

CREATE TABLE payment_reversal (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_order_id uuid NOT NULL REFERENCES payment_order(id) ON DELETE RESTRICT,
    payment_event_id uuid NOT NULL UNIQUE REFERENCES payment_event_inbox(id) ON DELETE RESTRICT,
    reversal_type text NOT NULL CHECK (reversal_type IN ('REFUND', 'REVERSAL', 'CHARGEBACK')),
    cumulative_payable_reversed_cents bigint NOT NULL CHECK (cumulative_payable_reversed_cents > 0),
    cumulative_credit_reversed_cents bigint NOT NULL CHECK (cumulative_credit_reversed_cents > 0),
    ledger_delta_cents bigint NOT NULL CHECK (ledger_delta_cents <= 0),
    wallet_ledger_id bigint UNIQUE REFERENCES wallet_ledger(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (payment_order_id, cumulative_payable_reversed_cents)
);

CREATE TABLE application (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code text NOT NULL UNIQUE,
    name text NOT NULL,
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
    sort_order integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE application_price_version (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid NOT NULL REFERENCES application(id) ON DELETE RESTRICT,
    annual_price_cents bigint NOT NULL CHECK (annual_price_cents >= 0),
    effective_from timestamptz NOT NULL,
    created_by uuid REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (application_id, effective_from)
);

CREATE INDEX application_price_current_idx
    ON application_price_version (application_id, effective_from DESC);

CREATE TABLE application_role_policy (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid NOT NULL REFERENCES application(id) ON DELETE RESTRICT,
    platform_role text NOT NULL CHECK (platform_role IN ('USER', 'ADMIN')),
    can_create_shop boolean NOT NULL,
    effective_from timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (application_id, platform_role, effective_from)
);

CREATE TABLE shop (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    application_id uuid NOT NULL REFERENCES application(id) ON DELETE RESTRICT,
    owner_account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'EXPIRED_READONLY', 'TRASHED', 'PURGED')),
    start_date date NOT NULL,
    close_date date NOT NULL CHECK (close_date > start_date),
    rename_count smallint NOT NULL DEFAULT 0 CHECK (rename_count BETWEEN 0 AND 1),
    trashed_at timestamptz,
    purge_after timestamptz,
    purged_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
        (status = 'TRASHED' AND trashed_at IS NOT NULL AND purge_after IS NOT NULL AND purged_at IS NULL)
        OR (status = 'PURGED' AND purged_at IS NOT NULL)
        OR (status IN ('ACTIVE', 'EXPIRED_READONLY') AND trashed_at IS NULL AND purge_after IS NULL AND purged_at IS NULL)
    )
);

CREATE UNIQUE INDEX shop_owner_live_name_uq
    ON shop (owner_account_id, normalized_name)
    WHERE status IN ('ACTIVE', 'EXPIRED_READONLY', 'TRASHED');
CREATE INDEX shop_owner_status_idx ON shop (owner_account_id, status, created_at DESC);

CREATE TABLE shop_name_history (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    old_name text NOT NULL,
    new_name text NOT NULL,
    changed_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (shop_id)
);

CREATE TABLE shop_term (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    start_date date NOT NULL,
    close_date date NOT NULL CHECK (close_date > start_date),
    charged_years integer NOT NULL CHECK (charged_years > 0),
    price_version_id uuid NOT NULL REFERENCES application_price_version(id) ON DELETE RESTRICT,
    supersedes_term_id uuid REFERENCES shop_term(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (shop_id, close_date)
);

CREATE TABLE shop_charge (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    shop_term_id uuid NOT NULL UNIQUE REFERENCES shop_term(id) ON DELETE RESTRICT,
    price_version_id uuid NOT NULL REFERENCES application_price_version(id) ON DELETE RESTRICT,
    original_amount_cents bigint NOT NULL CHECK (original_amount_cents >= 0),
    charged_amount_cents bigint NOT NULL CHECK (charged_amount_cents >= 0),
    waiver_type text CHECK (waiver_type IN ('ADMIN_FREE')),
    waiver_reason text,
    wallet_ledger_id bigint UNIQUE REFERENCES wallet_ledger(id) ON DELETE RESTRICT,
    idempotency_key text NOT NULL,
    created_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (created_by, idempotency_key),
    CHECK (
        (charged_amount_cents = original_amount_cents AND waiver_type IS NULL AND waiver_reason IS NULL AND wallet_ledger_id IS NOT NULL)
        OR (charged_amount_cents = 0 AND original_amount_cents = 0 AND waiver_type IS NULL AND waiver_reason IS NULL AND wallet_ledger_id IS NULL)
        OR (charged_amount_cents = 0 AND waiver_type = 'ADMIN_FREE' AND length(btrim(waiver_reason)) > 0 AND wallet_ledger_id IS NULL)
    )
);

WITH app AS (
    INSERT INTO application (code, name, status, sort_order)
    VALUES ('amazon-sales-cost', '亚马逊销售成本', 'ACTIVE', 10)
    ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
)
INSERT INTO application_price_version (application_id, annual_price_cents, effective_from)
SELECT id, 2000, '-infinity'::timestamptz FROM app
ON CONFLICT (application_id, effective_from) DO NOTHING;

COMMIT;
