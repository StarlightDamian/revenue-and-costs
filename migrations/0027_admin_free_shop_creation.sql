BEGIN;

-- 管理员使用启用中的应用时走零实付减免流程；原价、原因和审计仍由店铺事务记录。
INSERT INTO application_role_policy
  (application_id, platform_role, can_create_shop, effective_from)
SELECT id, 'ADMIN', true, clock_timestamp()
  FROM application;

COMMIT;
