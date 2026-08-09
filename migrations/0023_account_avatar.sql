ALTER TABLE account
  ADD COLUMN avatar_id integer NOT NULL DEFAULT 1;

ALTER TABLE account
  ADD CONSTRAINT account_avatar_id_check
  CHECK (avatar_id BETWEEN 1 AND 59);

COMMENT ON COLUMN account.avatar_id IS 'Stable identifier for the approved 59-avatar asset set.';
