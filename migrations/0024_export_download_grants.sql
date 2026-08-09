CREATE TABLE export_download_grant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  export_request_id uuid NOT NULL REFERENCES export_request(id),
  shop_id uuid NOT NULL REFERENCES shop(id) ON DELETE RESTRICT,
  account_id uuid NOT NULL REFERENCES account(id) ON DELETE RESTRICT,
  membership_id uuid REFERENCES shop_membership(id),
  membership_authorization_version bigint,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (expires_at > created_at),
  CHECK ((membership_id IS NULL) = (membership_authorization_version IS NULL))
);

CREATE INDEX export_download_grant_pending_idx
  ON export_download_grant (export_request_id, account_id, expires_at)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

CREATE INDEX export_download_grant_membership_idx
  ON export_download_grant (membership_id, expires_at)
  WHERE membership_id IS NOT NULL AND consumed_at IS NULL AND revoked_at IS NULL;
