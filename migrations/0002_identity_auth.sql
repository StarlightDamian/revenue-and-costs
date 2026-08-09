BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE account (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_e164 text NOT NULL UNIQUE CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
    theme_id text NOT NULL DEFAULT 'comfort' CHECK (theme_id IN ('comfort', 'tech', 'light', 'dark')),
    phone_verified_at timestamptz NOT NULL,
    session_generation bigint NOT NULL DEFAULT 1 CHECK (session_generation > 0),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE account_role (
    account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    role text NOT NULL CHECK (role IN ('USER', 'ADMIN')),
    granted_by uuid REFERENCES account(id) ON DELETE RESTRICT,
    granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (account_id, role)
);

CREATE INDEX account_role_role_idx ON account_role (role, account_id);

CREATE TABLE otp_challenge (
    id uuid PRIMARY KEY,
    phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    purpose text NOT NULL CHECK (purpose IN ('LOGIN', 'PHONE_CHANGE_OLD', 'PHONE_CHANGE_NEW')),
    code_hmac bytea NOT NULL,
    ip_digest bytea NOT NULL,
    device_digest bytea NOT NULL,
    failed_attempts smallint NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
    max_attempts smallint NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    expires_at timestamptz NOT NULL,
    consumed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at > created_at)
);

CREATE INDEX otp_challenge_phone_rate_idx ON otp_challenge (phone_e164, purpose, created_at DESC);
CREATE INDEX otp_challenge_ip_rate_idx ON otp_challenge (ip_digest, created_at DESC);
CREATE INDEX otp_challenge_device_rate_idx ON otp_challenge (device_digest, created_at DESC);

CREATE TABLE auth_session (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    token_digest bytea NOT NULL UNIQUE,
    csrf_digest bytea NOT NULL,
    account_generation bigint NOT NULL CHECK (account_generation > 0),
    expires_at timestamptz NOT NULL,
    last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    revoked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (expires_at > created_at)
);

CREATE INDEX auth_session_active_account_idx
    ON auth_session (account_id, expires_at)
    WHERE revoked_at IS NULL;

CREATE TABLE phone_change_request (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
    old_phone_e164 text NOT NULL,
    new_phone_e164 text NOT NULL CHECK (new_phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
    old_challenge_id uuid NOT NULL UNIQUE REFERENCES otp_challenge(id) ON DELETE RESTRICT,
    new_challenge_id uuid NOT NULL UNIQUE REFERENCES otp_challenge(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'COMPLETED', 'EXPIRED')),
    expires_at timestamptz NOT NULL,
    completed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK (old_phone_e164 <> new_phone_e164)
);

CREATE TABLE identity_bootstrap (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    completed_at timestamptz,
    completed_by uuid REFERENCES account(id) ON DELETE RESTRICT
);

INSERT INTO identity_bootstrap (singleton) VALUES (true);

CREATE OR REPLACE FUNCTION protect_last_active_admin()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
          FROM account_role ar
          JOIN account a ON a.id = ar.account_id
         WHERE ar.role = 'ADMIN'
           AND a.status = 'ACTIVE'
    ) AND EXISTS (SELECT 1 FROM identity_bootstrap WHERE completed_at IS NOT NULL) THEN
        RAISE EXCEPTION 'last active administrator cannot be removed or disabled'
            USING ERRCODE = '23514';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER account_role_last_admin_guard
AFTER DELETE OR UPDATE OF role, account_id ON account_role
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION protect_last_active_admin();

CREATE CONSTRAINT TRIGGER account_status_last_admin_guard
AFTER UPDATE OF status ON account
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION protect_last_active_admin();

COMMIT;
