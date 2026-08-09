BEGIN;

INSERT INTO marketplace_policy_version
  (marketplace, normalized_marketplace, iana_timezone, marketplace_size, effective_from, reason)
VALUES
  ('amazon.ie', 'IE', 'Europe/Dublin', 'LARGE', '2000-01-01T00:00:00Z',
   '补充爱尔兰站点版本化时区；站点规模待有证据时以前向版本调整')
ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING;

COMMIT;
