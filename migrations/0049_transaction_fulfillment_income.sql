ALTER TABLE transaction_fact
  ADD COLUMN fulfillment_mode text;

ALTER TABLE transaction_fact
  ADD CONSTRAINT transaction_fact_fulfillment_mode_check
  CHECK (fulfillment_mode IS NULL OR fulfillment_mode IN ('AMAZON', 'MERCHANT', 'BLANK'));

COMMENT ON COLUMN transaction_fact.fulfillment_mode IS
  'Normalized transaction fulfillment evidence. NULL is legacy and calculates as BLANK; reimport is required to add FMB income.';

INSERT INTO marketplace_policy_version
  (marketplace,normalized_marketplace,iana_timezone,marketplace_size,date_attribution_mode,effective_from,reason)
VALUES
  ('amazon.com.au','AU','Australia/Sydney','LARGE','REPORT_LITERAL_DATE','2000-01-01T00:00:00Z',
   '已验证澳大利亚交易报告：财务日期按报表字面日期，来源时区仅用于审计')
ON CONFLICT (normalized_marketplace,effective_from) DO NOTHING;
