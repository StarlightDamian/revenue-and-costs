CREATE FUNCTION notify_outbox_event_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    PERFORM pg_notify('revenue_costs_outbox', '');
    RETURN NULL;
END;
$$;

CREATE TRIGGER outbox_event_notify_insert
AFTER INSERT ON outbox_event
FOR EACH STATEMENT EXECUTE FUNCTION notify_outbox_event_insert();
