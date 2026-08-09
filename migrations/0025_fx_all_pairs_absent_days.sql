-- A completed ChinaMoney XLSX page is an authoritative all-currency result for
-- its requested date range. Preserve every absent date as explicit evidence so
-- weekend and holiday conversions may legally fall back to the previous quote.
INSERT INTO fx_market_day(valid_date,status,evidence_type,snapshot_id,reason)
SELECT day::date,
       'NON_TRADING',
       'ALL_OFFICIAL_PAIRS_ABSENT',
       raw.id,
       'ChinaMoney 官方全币种历史表在请求范围内当日无任何币对报价'
  FROM fx_raw_snapshot raw
  JOIN fx_sync_run_snapshot link ON link.snapshot_id=raw.id
  JOIN fx_sync_run run ON run.id=link.sync_run_id AND run.status='SUCCEEDED'
  CROSS JOIN LATERAL generate_series(
    (raw.request_parameters->>'from')::date,
    (raw.request_parameters->>'to')::date,
    interval '1 day'
  ) AS day
 WHERE raw.source_name='ChinaMoneyXlsx'
   AND raw.request_parameters->>'from' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND raw.request_parameters->>'to' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND NOT EXISTS (
     SELECT 1 FROM fx_quote quote
      WHERE quote.snapshot_id=raw.id AND quote.valid_date=day::date
   )
ON CONFLICT DO NOTHING;
