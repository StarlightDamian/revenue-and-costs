BEGIN;

ALTER TABLE backup_run
  ADD COLUMN target_kind text NOT NULL DEFAULT 'LOCAL_VALIDATION'
    CHECK (target_kind IN ('LOCAL_VALIDATION', 'OFFSITE')),
  ADD COLUMN target_reference_sha256 text
    CHECK (target_reference_sha256 IS NULL OR target_reference_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN manifest_hmac_sha256 text
    CHECK (manifest_hmac_sha256 IS NULL OR manifest_hmac_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE backup_run
  ADD CONSTRAINT backup_run_offsite_reference_ck
  CHECK (target_kind <> 'OFFSITE' OR target_reference_sha256 IS NOT NULL);

CREATE INDEX backup_run_offsite_success_idx
  ON backup_run (target_reference_sha256, finished_at DESC)
  WHERE status = 'SUCCEEDED' AND target_kind = 'OFFSITE';

ALTER TABLE recovery_checkpoint
  ADD COLUMN target_kind text NOT NULL DEFAULT 'LOCAL_VALIDATION'
    CHECK (target_kind IN ('LOCAL_VALIDATION', 'OFFSITE')),
  ADD COLUMN target_reference_sha256 text
    CHECK (target_reference_sha256 IS NULL OR target_reference_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN manifest_sha256 text
    CHECK (manifest_sha256 IS NULL OR manifest_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN manifest_hmac_sha256 text
    CHECK (manifest_hmac_sha256 IS NULL OR manifest_hmac_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN error_code text;

CREATE INDEX recovery_checkpoint_verified_offsite_idx
  ON recovery_checkpoint (verified_at DESC, target_reference_sha256)
  WHERE status = 'VERIFIED' AND target_kind = 'OFFSITE';

ALTER TABLE stored_object_replica
  ADD COLUMN replica_kind text NOT NULL DEFAULT 'LOCAL_VALIDATION'
    CHECK (replica_kind IN ('LOCAL_VALIDATION', 'OFFSITE')),
  ADD COLUMN target_reference_sha256 text
    CHECK (target_reference_sha256 IS NULL OR target_reference_sha256 ~ '^[0-9a-f]{64}$');

ALTER TABLE stored_object_replica
  ADD CONSTRAINT stored_object_replica_offsite_reference_ck
  CHECK (replica_kind <> 'OFFSITE' OR target_reference_sha256 IS NOT NULL);

CREATE INDEX stored_object_replica_verified_offsite_idx
  ON stored_object_replica (object_id, target_reference_sha256)
  WHERE status = 'VERIFIED' AND replica_kind = 'OFFSITE';

CREATE OR REPLACE FUNCTION protect_stored_object_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'stored_object is immutable' USING ERRCODE = '55000';
  END IF;
  IF to_jsonb(NEW) - 'verification_status' IS DISTINCT FROM to_jsonb(OLD) - 'verification_status' THEN
    RAISE EXCEPTION 'stored_object immutable fields cannot change' USING ERRCODE = '55000';
  END IF;
  IF OLD.verification_status = 'LOCAL_VERIFIED' AND NEW.verification_status = 'REMOTE_VERIFIED' THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'invalid stored_object verification transition % -> %',
    OLD.verification_status, NEW.verification_status USING ERRCODE = '55000';
END;
$$;

DROP TRIGGER stored_object_immutable ON stored_object;
CREATE TRIGGER stored_object_immutable
BEFORE UPDATE OR DELETE ON stored_object
FOR EACH ROW EXECUTE FUNCTION protect_stored_object_row();

COMMIT;
