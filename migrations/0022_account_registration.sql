BEGIN;

ALTER TABLE account
  ADD COLUMN display_name text,
  ADD COLUMN registered_at timestamptz;

-- 迁移前账户已通过旧登录流程建立，保持其可登录状态；新流程始终要求姓名。
UPDATE account
   SET registered_at = created_at
 WHERE registered_at IS NULL;

ALTER TABLE account
  ADD CONSTRAINT account_display_name_ck
    CHECK (display_name IS NULL OR (display_name = btrim(display_name) AND char_length(display_name) BETWEEN 1 AND 80));

ALTER TABLE otp_challenge
  DROP CONSTRAINT otp_challenge_purpose_check,
  ADD CONSTRAINT otp_challenge_purpose_check
    CHECK (purpose IN ('REGISTER', 'LOGIN', 'PHONE_CHANGE_OLD', 'PHONE_CHANGE_NEW'));

COMMIT;
