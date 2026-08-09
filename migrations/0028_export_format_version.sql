ALTER TABLE export_request
  ADD COLUMN format_version text NOT NULL DEFAULT 'revenue-and-costs-export-v1';

ALTER TABLE export_request
  ALTER COLUMN format_version SET DEFAULT 'revenue-and-costs-export-v2';

ALTER TABLE export_request
  ADD CONSTRAINT export_request_format_version_nonempty
  CHECK (length(btrim(format_version)) > 0);
