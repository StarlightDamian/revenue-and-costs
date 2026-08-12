BEGIN;

-- Historical policies converted instants into their versioned IANA timezone.
-- Keep that meaning explicit, then append a new policy generation whose
-- financial date/month comes directly from the date printed in the report.
ALTER TABLE marketplace_policy_version
  ADD COLUMN date_attribution_mode text NOT NULL DEFAULT 'INSTANT_TO_IANA_TIMEZONE';

ALTER TABLE marketplace_policy_version
  ADD CONSTRAINT marketplace_policy_date_attribution_mode_check
  CHECK (date_attribution_mode IN ('INSTANT_TO_IANA_TIMEZONE', 'REPORT_LITERAL_DATE'));

DO $migration$
DECLARE
  cutover timestamptz := clock_timestamp();
  current_policy_count integer;
  missing_source_timezone_count integer;
BEGIN
  SELECT count(*) INTO current_policy_count
    FROM (
      SELECT DISTINCT ON (policy.normalized_marketplace) policy.normalized_marketplace
        FROM marketplace_policy_version policy
       WHERE policy.effective_from <= cutover
         AND (policy.effective_to IS NULL OR policy.effective_to > cutover)
       ORDER BY policy.normalized_marketplace,policy.effective_from DESC,policy.id DESC
    ) current_policy;

  SELECT count(*) INTO missing_source_timezone_count
    FROM (
      SELECT DISTINCT ON (policy.normalized_marketplace) policy.normalized_marketplace
        FROM marketplace_policy_version policy
       WHERE policy.effective_from <= cutover
         AND (policy.effective_to IS NULL OR policy.effective_to > cutover)
       ORDER BY policy.normalized_marketplace,policy.effective_from DESC,policy.id DESC
    ) current_policy
   WHERE NOT EXISTS (
     SELECT 1
       FROM marketplace_policy_version historical
      WHERE historical.normalized_marketplace=current_policy.normalized_marketplace
        AND historical.effective_from <= cutover
        AND historical.iana_timezone <> 'Asia/Shanghai'
   );

  IF current_policy_count = 0 OR missing_source_timezone_count <> 0 THEN
    RAISE EXCEPTION 'REPORT_LITERAL_DATE_SOURCE_TIMEZONE_INCOMPLETE: current %, missing %',
      current_policy_count, missing_source_timezone_count;
  END IF;

  INSERT INTO marketplace_policy_version
    (marketplace, normalized_marketplace, iana_timezone, marketplace_size,
     date_attribution_mode, effective_from, reason)
  SELECT current_policy.marketplace,
         current_policy.normalized_marketplace,
         source_timezone.iana_timezone,
         current_policy.marketplace_size,
         'REPORT_LITERAL_DATE',
         cutover,
         '财务日期和月份按报表字面日期归属，不执行时区转换；IANA 时区只用于来源时间审计'
    FROM (
      SELECT DISTINCT ON (policy.normalized_marketplace)
             policy.marketplace, policy.normalized_marketplace, policy.marketplace_size
        FROM marketplace_policy_version policy
       WHERE policy.effective_from <= cutover
         AND (policy.effective_to IS NULL OR policy.effective_to > cutover)
       ORDER BY policy.normalized_marketplace,policy.effective_from DESC,policy.id DESC
    ) current_policy
    JOIN LATERAL (
      SELECT policy.iana_timezone
        FROM marketplace_policy_version policy
       WHERE policy.normalized_marketplace = current_policy.normalized_marketplace
         AND policy.effective_from <= cutover
         AND policy.iana_timezone <> 'Asia/Shanghai'
       ORDER BY policy.effective_from DESC,policy.id DESC
       LIMIT 1
    ) source_timezone ON true
  ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING;
END
$migration$;

-- New policy rows must always declare their assignment mode explicitly.
ALTER TABLE marketplace_policy_version
  ALTER COLUMN date_attribution_mode DROP DEFAULT;

COMMENT ON COLUMN marketplace_policy_version.date_attribution_mode IS
  'INSTANT_TO_IANA_TIMEZONE converts the audited instant through iana_timezone; REPORT_LITERAL_DATE groups by the displayed report date without conversion';

COMMIT;
