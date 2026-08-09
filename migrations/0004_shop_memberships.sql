BEGIN;

CREATE TABLE shop_invitation (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    invited_phone_e164 text NOT NULL CHECK (invited_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    token_digest bytea NOT NULL UNIQUE,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'REVOKED', 'EXPIRED')),
    export_allowed boolean NOT NULL DEFAULT false,
    invited_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    expires_at timestamptz NOT NULL,
    accepted_by uuid REFERENCES account(id) ON DELETE RESTRICT,
    accepted_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at > created_at)
);

CREATE UNIQUE INDEX shop_invitation_pending_phone_uq
    ON shop_invitation (shop_id, invited_phone_e164)
    WHERE status = 'PENDING';

CREATE TABLE shop_membership (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
    account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    role text NOT NULL DEFAULT 'CUSTOMER' CHECK (role = 'CUSTOMER'),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'REVOKED', 'EXPIRED')),
    export_allowed boolean NOT NULL DEFAULT false,
    authorization_epoch bigint NOT NULL DEFAULT 1 CHECK (authorization_epoch > 0),
    invitation_id uuid UNIQUE REFERENCES shop_invitation(id) ON DELETE RESTRICT,
    granted_by uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    revoke_reason text,
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE (shop_id, account_id),
    CHECK (
        (status = 'ACTIVE' AND revoked_at IS NULL AND revoke_reason IS NULL)
        OR (status IN ('REVOKED', 'EXPIRED') AND revoked_at IS NOT NULL)
    )
);

CREATE INDEX shop_membership_account_active_idx
    ON shop_membership (account_id, shop_id)
    WHERE status = 'ACTIVE';

COMMIT;
