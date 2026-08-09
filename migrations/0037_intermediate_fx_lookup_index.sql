BEGIN;

CREATE INDEX calculation_fact_result_run_kind_fact_idx
  ON calculation_fact_result (calculation_run_id, fact_kind, fact_id)
  INCLUDE (id);

COMMIT;
