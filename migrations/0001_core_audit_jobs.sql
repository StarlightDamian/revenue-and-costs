CREATE TABLE audit_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_account_id uuid,
  action text NOT NULL,
  object_type text NOT NULL,
  object_id uuid,
  reason text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_event_object_time_idx ON audit_event (object_type, object_id, occurred_at DESC);
CREATE INDEX audit_event_actor_time_idx ON audit_event (actor_account_id, occurred_at DESC);

CREATE TABLE idempotency_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_account_id uuid,
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL,
  UNIQUE (actor_account_id, scope, idempotency_key)
);

CREATE INDEX idempotency_record_expiry_idx ON idempotency_record (expires_at);

CREATE TABLE outbox_event (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic text NOT NULL,
  business_key text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dispatched_at timestamptz,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error text,
  UNIQUE (topic, business_key)
);

CREATE INDEX outbox_event_pending_idx ON outbox_event (created_at, id) WHERE dispatched_at IS NULL;

CREATE TABLE job_operation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_key text NOT NULL UNIQUE,
  job_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_heartbeat_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz
);

CREATE INDEX job_operation_status_idx ON job_operation (status, updated_at);

CREATE OR REPLACE FUNCTION reject_mutation_of_immutable_row()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable table % does not allow %', TG_TABLE_NAME, TG_OP USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_event_immutable
BEFORE UPDATE OR DELETE ON audit_event
FOR EACH ROW EXECUTE FUNCTION reject_mutation_of_immutable_row();
