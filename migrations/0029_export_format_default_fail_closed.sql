ALTER TABLE export_request
  ALTER COLUMN format_version DROP DEFAULT;

UPDATE export_request
   SET format_version = 'revenue-and-costs-export-v1'
 WHERE format_version = 'revenue-and-costs-export-v2'
   AND position(':revenue-and-costs-export-v2:' IN business_key) = 0;
