LOCK TABLE export_request IN ACCESS EXCLUSIVE MODE;

ALTER TABLE export_request
  ALTER COLUMN format_version DROP DEFAULT;

UPDATE export_request
   SET format_version = 'revenue-and-costs-export-v1'
 WHERE format_version = 'revenue-and-costs-export-v2';
