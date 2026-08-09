BEGIN;

CREATE TABLE enterprise (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 120),
    unified_social_credit_code text,
    created_by_account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    legacy_source_account_id uuid UNIQUE REFERENCES account(id) ON DELETE RESTRICT,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (
      unified_social_credit_code IS NULL
      OR unified_social_credit_code ~ '^[0-9A-Z]{18}$'
    )
);

CREATE UNIQUE INDEX enterprise_credit_code_uq
    ON enterprise (unified_social_credit_code)
    WHERE unified_social_credit_code IS NOT NULL;

CREATE TABLE enterprise_member (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    enterprise_id uuid NOT NULL REFERENCES enterprise(id) ON DELETE RESTRICT,
    account_id uuid REFERENCES account(id) ON DELETE RESTRICT,
    phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    display_name text,
    status text NOT NULL CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED')),
    authorization_epoch bigint NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
    invited_by_account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    activated_at timestamptz,
    revoked_at timestamptz,
    revoke_reason text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (display_name IS NULL OR (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 80)),
    CHECK (
      (status = 'PENDING' AND account_id IS NULL AND activated_at IS NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (status = 'ACTIVE' AND account_id IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL AND revoke_reason IS NULL)
      OR (status = 'REVOKED' AND revoked_at IS NOT NULL AND length(btrim(revoke_reason)) > 0)
    )
);

CREATE UNIQUE INDEX enterprise_member_live_phone_uq
    ON enterprise_member (enterprise_id, phone_e164)
    WHERE status IN ('PENDING', 'ACTIVE');

CREATE UNIQUE INDEX enterprise_member_active_account_uq
    ON enterprise_member (enterprise_id, account_id)
    WHERE status = 'ACTIVE';

CREATE INDEX enterprise_member_account_active_idx
    ON enterprise_member (account_id, enterprise_id)
    WHERE status = 'ACTIVE';

-- Platform identities become ACCOUNTANT or ADMIN. Customer access remains in shop_membership.
ALTER TABLE account_role DROP CONSTRAINT account_role_role_check;
UPDATE account_role SET role = 'ACCOUNTANT' WHERE role IN ('USER', 'CUSTOMER');
ALTER TABLE account_role
  ADD CONSTRAINT account_role_role_check CHECK (role IN ('ACCOUNTANT', 'ADMIN'));

ALTER TABLE application_role_policy DROP CONSTRAINT application_role_policy_platform_role_check;
UPDATE application_role_policy SET platform_role = 'ACCOUNTANT' WHERE platform_role = 'USER';
ALTER TABLE application_role_policy
  ADD CONSTRAINT application_role_policy_platform_role_check CHECK (platform_role IN ('ACCOUNTANT', 'ADMIN'));

-- One legacy enterprise per existing company/wallet owner preserves all current local data.
INSERT INTO enterprise
  (name, normalized_name, unified_social_credit_code, created_by_account_id, legacy_source_account_id)
SELECT '历史数据待补录', '历史数据待补录', NULL, source.account_id, source.account_id
  FROM (
    SELECT owner_account_id AS account_id FROM shop
    UNION
    SELECT account_id FROM wallet_account
  ) source
ON CONFLICT (legacy_source_account_id) DO NOTHING;

INSERT INTO enterprise_member
  (enterprise_id, account_id, phone_e164, display_name, status,
   invited_by_account_id, activated_at)
SELECT e.id, a.id, a.phone_e164, a.display_name, 'ACTIVE', a.id, clock_timestamp()
  FROM enterprise e
  JOIN account a ON a.id = e.legacy_source_account_id
ON CONFLICT DO NOTHING;

ALTER TABLE shop
  ADD COLUMN enterprise_id uuid REFERENCES enterprise(id) ON DELETE RESTRICT,
  ADD COLUMN created_by_account_id uuid REFERENCES account(id) ON DELETE RESTRICT,
  ADD COLUMN last_operated_by_account_id uuid REFERENCES account(id) ON DELETE RESTRICT;

UPDATE shop s
   SET enterprise_id = e.id,
       created_by_account_id = s.owner_account_id,
       last_operated_by_account_id = s.owner_account_id
  FROM enterprise e
 WHERE e.legacy_source_account_id = s.owner_account_id;

ALTER TABLE shop
  ALTER COLUMN enterprise_id SET NOT NULL,
  ALTER COLUMN created_by_account_id SET NOT NULL,
  ALTER COLUMN last_operated_by_account_id SET NOT NULL;

DROP INDEX shop_owner_live_name_uq;
CREATE UNIQUE INDEX shop_enterprise_live_name_uq
    ON shop (enterprise_id, normalized_name)
    WHERE status IN ('ACTIVE', 'EXPIRED_READONLY', 'TRASHED');
CREATE INDEX shop_enterprise_status_idx
    ON shop (enterprise_id, status, updated_at DESC, id DESC);

-- Generalize the wallet primary key while preserving every existing ledger row and amount.
ALTER TABLE wallet_account DROP CONSTRAINT wallet_account_account_id_fkey;
ALTER TABLE wallet_account RENAME COLUMN account_id TO id;
ALTER TABLE wallet_account ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE wallet_account
  ADD COLUMN owner_account_id uuid REFERENCES account(id) ON DELETE RESTRICT,
  ADD COLUMN enterprise_id uuid UNIQUE REFERENCES enterprise(id) ON DELETE RESTRICT;

UPDATE wallet_account SET owner_account_id = id;
UPDATE wallet_account w
   SET enterprise_id = e.id, owner_account_id = NULL
  FROM enterprise e
 WHERE e.legacy_source_account_id = w.id;

ALTER TABLE wallet_account
  ADD CONSTRAINT wallet_account_one_owner_ck CHECK (
    (owner_account_id IS NOT NULL AND enterprise_id IS NULL)
    OR (owner_account_id IS NULL AND enterprise_id IS NOT NULL)
  );

ALTER TABLE wallet_ledger RENAME COLUMN account_id TO wallet_id;

ALTER TABLE payment_order ADD COLUMN wallet_id uuid;
UPDATE payment_order SET wallet_id = account_id;
ALTER TABLE payment_order
  ALTER COLUMN wallet_id SET NOT NULL,
  ADD CONSTRAINT payment_order_wallet_id_fkey
    FOREIGN KEY (wallet_id) REFERENCES wallet_account(id) ON DELETE RESTRICT;
ALTER TABLE payment_order DROP CONSTRAINT payment_order_account_id_idempotency_key_key;
ALTER TABLE payment_order
  ADD CONSTRAINT payment_order_wallet_actor_idempotency_uq
    UNIQUE (wallet_id, account_id, idempotency_key);

-- The new price affects only future creation and renewal; historical charges keep their price version.
INSERT INTO application_price_version (application_id, annual_price_cents, effective_from)
SELECT id, 18800, clock_timestamp()
  FROM application
 WHERE code = 'amazon-sales-cost';

COMMIT;
