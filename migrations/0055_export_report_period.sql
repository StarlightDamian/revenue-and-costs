BEGIN;

ALTER TABLE export_request
  ADD COLUMN report_period_start date,
  ADD COLUMN report_period_end date,
  ADD CONSTRAINT export_request_report_period_check CHECK (
    (report_period_start IS NULL AND report_period_end IS NULL)
    OR (
      report_period_start IS NOT NULL
      AND report_period_end IS NOT NULL
      AND extract(day FROM report_period_start) = 1
      AND extract(day FROM report_period_end) = 1
      AND report_period_start <= report_period_end
      AND date_trunc('year', report_period_start) = date_trunc('year', report_period_end)
    )
  );

COMMENT ON COLUMN export_request.report_period_start IS
  'Optional immutable first included month for this report projection; NULL with report_period_end means the full published snapshot scope.';
COMMENT ON COLUMN export_request.report_period_end IS
  'Optional immutable last included month for this report projection; paired with report_period_start.';

COMMIT;
