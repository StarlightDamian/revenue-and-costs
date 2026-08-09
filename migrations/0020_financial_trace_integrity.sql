BEGIN;

INSERT INTO marketplace_policy_version
  (marketplace, normalized_marketplace, iana_timezone, marketplace_size, effective_from, reason)
VALUES
  ('amazon.com',    'US', 'America/Los_Angeles', 'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.ca',     'CA', 'America/Toronto',     'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.com.mx', 'MX', 'America/Mexico_City', 'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.co.uk',  'UK', 'Europe/London',       'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.de',     'DE', 'Europe/Berlin',       'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.fr',     'FR', 'Europe/Paris',        'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.it',     'IT', 'Europe/Rome',         'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.es',     'ES', 'Europe/Madrid',       'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.nl',     'NL', 'Europe/Amsterdam',    'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.com.be', 'BE', 'Europe/Brussels',     'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.se',     'SE', 'Europe/Stockholm',    'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.pl',     'PL', 'Europe/Warsaw',       'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.co.jp',  'JP', 'Asia/Tokyo',          'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.ae',     'AE', 'Asia/Dubai',          'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.sa',     'SA', 'Asia/Riyadh',         'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('amazon.com.tr', 'TR', 'Europe/Istanbul',     'LARGE', '2000-01-01T00:00:00Z', '首版安全默认：已知站点版本化时区；站点规模待有证据时以前向版本调整'),
  ('UNKNOWN',       'UNKNOWN', 'UTC',             'LARGE', '2000-01-01T00:00:00Z', '未知站点安全默认：按大站点并采用版本化 UTC；完整性门禁仍须披露')
ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING;

ALTER TABLE fx_market_day
  DROP CONSTRAINT IF EXISTS fx_market_day_valid_date_evidence_type_key;
ALTER TABLE fx_market_day
  ADD CONSTRAINT fx_market_day_snapshot_date_evidence_key
  UNIQUE NULLS NOT DISTINCT (snapshot_id, valid_date, evidence_type);

CREATE OR REPLACE VIEW fx_current_market_day AS
SELECT DISTINCT ON (day.valid_date) day.*
  FROM fx_market_day day
  JOIN fx_raw_snapshot raw ON raw.id=day.snapshot_id
  JOIN fx_sync_run_snapshot link ON link.snapshot_id=raw.id
  JOIN fx_sync_run run ON run.id=link.sync_run_id AND run.status='SUCCEEDED'
 ORDER BY day.valid_date,run.finished_at DESC,raw.fetched_at DESC,day.created_at DESC,day.id DESC;

CREATE TABLE published_snapshot_integrity (
  published_snapshot_id uuid PRIMARY KEY REFERENCES published_snapshot(id) ON DELETE RESTRICT,
  hash_format text NOT NULL CHECK (hash_format='PG_JSONB_TEXT_V1'),
  canonical_manifest_sha256 bytea NOT NULL CHECK (octet_length(canonical_manifest_sha256)=32),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

INSERT INTO published_snapshot_integrity(published_snapshot_id,hash_format,canonical_manifest_sha256)
SELECT id,'PG_JSONB_TEXT_V1',digest(manifest::text,'sha256') FROM published_snapshot;

CREATE TRIGGER published_snapshot_integrity_immutable
BEFORE UPDATE OR DELETE ON published_snapshot_integrity
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();

ALTER TABLE published_snapshot
  ADD CONSTRAINT published_snapshot_manifest_hash_matches
  CHECK (manifest_sha256=digest(manifest::text,'sha256')) NOT VALID;

COMMIT;
