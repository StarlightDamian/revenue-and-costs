BEGIN;

CREATE OR REPLACE FUNCTION enqueue_stored_object_replication()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO outbox_event(topic,business_key,payload)
  VALUES('storage.replicate',NEW.id::text,jsonb_build_object('objectId',NEW.id))
  ON CONFLICT(topic,business_key) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stored_object_replication_outbox
AFTER INSERT ON stored_object
FOR EACH ROW EXECUTE FUNCTION enqueue_stored_object_replication();

-- Existing immutable objects must enter the same durable path on upgrade.
INSERT INTO outbox_event(topic,business_key,payload)
SELECT 'storage.replicate',id::text,jsonb_build_object('objectId',id)
  FROM stored_object
ON CONFLICT(topic,business_key) DO NOTHING;

COMMIT;
