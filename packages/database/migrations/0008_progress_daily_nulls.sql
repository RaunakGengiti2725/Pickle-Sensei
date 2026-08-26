-- 0008: progress_daily rollup rows use checkpoint_id NULL for the overall
-- (non-checkpoint) series; a PRIMARY KEY cannot hold NULLs. Replace with a
-- NULLS-NOT-DISTINCT unique constraint (PG15+) so upserts stay idempotent.
ALTER TABLE progress_daily DROP CONSTRAINT progress_daily_pkey;
ALTER TABLE progress_daily ALTER COLUMN checkpoint_id DROP NOT NULL;
ALTER TABLE progress_daily
  ADD CONSTRAINT progress_daily_unique
  UNIQUE NULLS NOT DISTINCT (user_id, day, shot_type_id, checkpoint_id, scoring_model_id);
