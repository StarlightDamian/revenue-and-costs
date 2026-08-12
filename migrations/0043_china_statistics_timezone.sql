BEGIN;

-- Source timezones remain part of report parsing. This policy versions the
-- reporting/statistics timezone only, preserving each marketplace's latest
-- size and every historical policy row.
WITH cutover AS (
  SELECT clock_timestamp() AS effective_from
), current_policy AS (
  SELECT DISTINCT ON (policy.normalized_marketplace)
         policy.marketplace,
         policy.normalized_marketplace,
         policy.marketplace_size
    FROM marketplace_policy_version policy
    CROSS JOIN cutover
   WHERE policy.effective_from <= cutover.effective_from
     AND (policy.effective_to IS NULL OR policy.effective_to > cutover.effective_from)
   ORDER BY policy.normalized_marketplace,policy.effective_from DESC,policy.id DESC
)
INSERT INTO marketplace_policy_version
  (marketplace, normalized_marketplace, iana_timezone, marketplace_size, effective_from, reason)
SELECT current_policy.marketplace,
       current_policy.normalized_marketplace,
       'Asia/Shanghai',
       current_policy.marketplace_size,
       cutover.effective_from,
       '统一按中国时间统计；保留来源时区解析与历史策略，仅对迁移后的新数据版本生效'
  FROM current_policy
 CROSS JOIN cutover
ON CONFLICT (normalized_marketplace, effective_from) DO NOTHING;

COMMIT;
