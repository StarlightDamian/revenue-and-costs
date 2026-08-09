BEGIN;

-- 最新身份口径：每个已注册账户只能拥有 ADMIN、USER、CUSTOMER 之一。
ALTER TABLE account_role
  DROP CONSTRAINT account_role_role_check;

ALTER TABLE account_role
  ADD CONSTRAINT account_role_role_check
    CHECK (role IN ('USER', 'ADMIN', 'CUSTOMER'));

-- 历史管理员同时带 USER 的数据收敛为 ADMIN。
DELETE FROM account_role user_role
 USING account_role admin_role
 WHERE user_role.account_id = admin_role.account_id
   AND user_role.role = 'USER'
   AND admin_role.role = 'ADMIN';

-- 现有有效客户授权对应 CUSTOMER；管理员与客户授权冲突时拒绝迁移，避免静默改权。
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM shop_membership sm
      JOIN account_role ar ON ar.account_id = sm.account_id AND ar.role = 'ADMIN'
     WHERE sm.status = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'active customer membership conflicts with ADMIN role';
  END IF;
END;
$$;

DELETE FROM account_role ar
 USING shop_membership sm
 WHERE ar.account_id = sm.account_id
   AND sm.status = 'ACTIVE'
   AND ar.role <> 'CUSTOMER';

INSERT INTO account_role (account_id, role)
SELECT DISTINCT sm.account_id, 'CUSTOMER'
  FROM shop_membership sm
 WHERE sm.status = 'ACTIVE'
ON CONFLICT DO NOTHING;

INSERT INTO account_role (account_id, role)
SELECT a.id, 'USER'
  FROM account a
 WHERE a.registered_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM account_role ar WHERE ar.account_id = a.id)
ON CONFLICT DO NOTHING;

-- account_role 上已有延迟的最后管理员保护触发器。先结算 DML 事件，
-- 再增加唯一约束，避免 PostgreSQL 拒绝修改存在待处理触发事件的表。
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE account_role
  ADD CONSTRAINT account_role_one_per_account UNIQUE (account_id)
  DEFERRABLE INITIALLY IMMEDIATE;

CREATE OR REPLACE FUNCTION enforce_registered_account_single_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id uuid;
BEGIN
  target_account_id := COALESCE(NEW.account_id, OLD.account_id);
  IF EXISTS (
    SELECT 1 FROM account a
     WHERE a.id = target_account_id AND a.registered_at IS NOT NULL
  ) AND (SELECT count(*) FROM account_role ar WHERE ar.account_id = target_account_id) <> 1 THEN
    RAISE EXCEPTION 'registered account must have exactly one role'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER account_role_exactly_one_guard
AFTER INSERT OR DELETE OR UPDATE OF account_id, role ON account_role
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_registered_account_single_role();

CREATE OR REPLACE FUNCTION enforce_registered_account_has_role()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.registered_at IS NOT NULL
     AND (SELECT count(*) FROM account_role ar WHERE ar.account_id = NEW.id) <> 1 THEN
    RAISE EXCEPTION 'registered account must have exactly one role'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER account_registered_role_guard
AFTER INSERT OR UPDATE OF registered_at ON account
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_registered_account_has_role();

-- 管理员不再参与用户侧建店策略；授权函数仍执行最终服务端拒绝。
INSERT INTO application_role_policy
  (application_id, platform_role, can_create_shop, effective_from)
SELECT id, 'ADMIN', false, clock_timestamp()
  FROM application;

COMMIT;
