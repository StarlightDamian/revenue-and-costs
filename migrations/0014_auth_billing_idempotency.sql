ALTER TABLE shop_invitation ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX shop_invitation_actor_idempotency_uq
    ON shop_invitation (invited_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

ALTER TABLE application_price_version ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX application_price_actor_idempotency_uq
    ON application_price_version (created_by, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
