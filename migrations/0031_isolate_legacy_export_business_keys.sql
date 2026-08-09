LOCK TABLE export_request IN ACCESS EXCLUSIVE MODE;

UPDATE export_request
   SET business_key = 'legacy-export:' || id::text
 WHERE format_version = 'revenue-and-costs-export-v1';
