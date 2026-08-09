BEGIN;

-- Brazil is a newly recognized marketplace. Saudi Arabia and Sweden keep
-- their historical LARGE policies; later dataset versions select these new
-- SMALL rows by effective_from, so published runs remain reproducible.
INSERT INTO marketplace_policy_version
  (marketplace, normalized_marketplace, iana_timezone, marketplace_size, effective_from, reason)
VALUES
  ('amazon.com.br', 'BR', 'America/Sao_Paulo', 'LARGE', '2026-08-07T08:25:00Z',
   '补充巴西站点版本化时区；缺少历史规模证据，按大站点安全默认且仅向前生效'),
  ('amazon.sa', 'SA', 'Asia/Riyadh', 'SMALL', '2026-08-07T08:25:00Z',
   '用户确认沙特站为小站点；仅向前新增策略版本，保留历史运行引用'),
  ('amazon.se', 'SE', 'Europe/Stockholm', 'SMALL', '2026-08-07T08:25:00Z',
   '用户确认瑞典站为小站点；仅向前新增策略版本，保留历史运行引用')
ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING;

COMMIT;
