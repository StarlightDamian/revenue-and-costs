ALTER TABLE upload_batch DROP CONSTRAINT upload_batch_status_check;
ALTER TABLE upload_batch ADD CONSTRAINT upload_batch_status_check
  CHECK (status IN ('OPEN','UPLOADING','FINALIZING','READY','CANCELLED','FAILED','EXPIRED'));
