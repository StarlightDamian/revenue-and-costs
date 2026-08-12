BEGIN;

ALTER TABLE fx_override
    ADD COLUMN supersedes_override_id uuid REFERENCES fx_override(id) ON DELETE RESTRICT,
    ADD CONSTRAINT fx_override_not_self_superseding
        CHECK (supersedes_override_id IS NULL OR supersedes_override_id <> id);

ALTER TABLE fx_override
    DROP CONSTRAINT fx_override_currency_valid_from_valid_to_key;

CREATE UNIQUE INDEX fx_override_single_successor_uq
    ON fx_override (supersedes_override_id)
    WHERE supersedes_override_id IS NOT NULL;

CREATE VIEW fx_current_override AS
SELECT entry.*
  FROM fx_override entry
 WHERE NOT EXISTS (
       SELECT 1
         FROM fx_override successor
        WHERE successor.supersedes_override_id = entry.id
 );

CREATE OR REPLACE FUNCTION reject_fx_override_when_official_exists()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    predecessor_currency text;
BEGIN
    -- Serialize all writes for one currency, including callers outside the API.
    PERFORM pg_advisory_xact_lock(hashtextextended('fx-override:' || NEW.currency, 0));

    IF NEW.supersedes_override_id IS NOT NULL THEN
        SELECT candidate.currency
          INTO predecessor_currency
          FROM fx_current_override candidate
         WHERE candidate.id = NEW.supersedes_override_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'manual FX predecessor is missing or no longer current'
                USING ERRCODE = '23514', CONSTRAINT = 'fx_override_predecessor_current';
        END IF;
        IF predecessor_currency <> NEW.currency THEN
            RAISE EXCEPTION 'manual FX revision may not change currency'
                USING ERRCODE = '23514', CONSTRAINT = 'fx_override_revision_currency';
        END IF;
    END IF;

    IF EXISTS (
        SELECT 1 FROM fx_quote q
         WHERE q.cny_currency = NEW.currency
           AND q.valid_date BETWEEN NEW.valid_from AND NEW.valid_to
    ) THEN
        RAISE EXCEPTION 'manual FX may only fill an official quote gap'
            USING ERRCODE = '23514', CONSTRAINT = 'fx_override_official_gap_only';
    END IF;
    IF EXISTS (
        SELECT 1 FROM fx_current_override candidate
         WHERE candidate.currency = NEW.currency
           AND candidate.id IS DISTINCT FROM NEW.supersedes_override_id
           AND daterange(candidate.valid_from, candidate.valid_to, '[]') && daterange(NEW.valid_from, NEW.valid_to, '[]')
    ) THEN
        RAISE EXCEPTION 'current manual FX validity ranges may not overlap'
            USING ERRCODE = '23514', CONSTRAINT = 'fx_override_current_range_no_overlap';
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
