INSERT INTO application_role_policy
    (application_id, platform_role, can_create_shop, effective_from)
SELECT application.id, role_name, true, '-infinity'::timestamptz
  FROM application
 CROSS JOIN (VALUES ('USER'), ('ADMIN')) AS roles(role_name)
ON CONFLICT (application_id, platform_role, effective_from) DO NOTHING;
