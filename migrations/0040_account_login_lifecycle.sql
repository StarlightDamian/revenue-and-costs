BEGIN;

ALTER TABLE account
  ADD COLUMN first_login_at timestamptz,
  ADD COLUMN last_login_at timestamptz,
  ADD COLUMN successful_login_count bigint NOT NULL DEFAULT 0 CHECK (successful_login_count >= 0);

UPDATE account a
   SET first_login_at = history.first_login_at,
       last_login_at = history.last_login_at,
       successful_login_count = history.login_count
  FROM (
    SELECT account_id,min(created_at) first_login_at,max(created_at) last_login_at,count(*) login_count
      FROM auth_session GROUP BY account_id
  ) history
 WHERE history.account_id = a.id;

ALTER TABLE account ADD CONSTRAINT account_login_lifecycle_check CHECK (
  (successful_login_count = 0 AND first_login_at IS NULL AND last_login_at IS NULL)
  OR (successful_login_count > 0 AND first_login_at IS NOT NULL AND last_login_at IS NOT NULL AND first_login_at <= last_login_at)
);

ALTER TABLE auth_session ADD COLUMN login_sequence bigint;
UPDATE auth_session SET login_sequence = 0;
ALTER TABLE auth_session
  ALTER COLUMN login_sequence SET NOT NULL,
  ADD CONSTRAINT auth_session_login_sequence_check CHECK (login_sequence >= 0);

CREATE UNIQUE INDEX auth_session_account_login_sequence_idx
  ON auth_session(account_id,login_sequence)
  WHERE login_sequence > 0;

COMMENT ON COLUMN auth_session.login_sequence IS
  'Successful account-login sequence frozen when the session is issued; 0 denotes a pre-migration legacy session.';

COMMIT;
