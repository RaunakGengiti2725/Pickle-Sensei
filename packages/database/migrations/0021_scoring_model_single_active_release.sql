-- 0021: scoring-model release state machine (ADJ-05).
--
-- A shot type has at most ONE open-ended active scoring model. Releasing a new
-- version closes the previous one (`status = 'superseded'`, `active_to = now()`)
-- instead of leaving several versions `active` with `active_to IS NULL`; a
-- release is only valid from `draft`/`validating`. The API enforces the
-- transitions; this migration makes the invariant a property of the schema so
-- direct SQL cannot violate it either.

-- `superseded` distinguishes "replaced by a newer release" from a deliberate
-- `retired` withdrawal.
ALTER TABLE scoring_model DROP CONSTRAINT IF EXISTS scoring_model_status_check;
ALTER TABLE scoring_model ADD CONSTRAINT scoring_model_status_check
  CHECK (status IN ('draft', 'validating', 'active', 'superseded', 'retired'));

-- A superseded row is always closed.
ALTER TABLE scoring_model DROP CONSTRAINT IF EXISTS scoring_model_superseded_is_closed;
ALTER TABLE scoring_model ADD CONSTRAINT scoring_model_superseded_is_closed
  CHECK (status <> 'superseded' OR active_to IS NOT NULL);

-- Upgrade path: databases written before this migration may already hold
-- several open-ended active rows per shot type. Keep the most recent
-- activation open; close the older ones as superseded.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY shot_type_id
           ORDER BY active_from DESC NULLS LAST, released_at DESC NULLS LAST,
                    created_at DESC, id DESC
         ) AS rn
  FROM scoring_model
  WHERE status = 'active' AND active_to IS NULL
)
UPDATE scoring_model sm
SET status = 'superseded', active_to = now()
FROM ranked
WHERE ranked.id = sm.id AND ranked.rn > 1;

CREATE UNIQUE INDEX IF NOT EXISTS scoring_model_single_open_active_per_shot_type
  ON scoring_model (shot_type_id)
  WHERE status = 'active' AND active_to IS NULL;

COMMENT ON INDEX scoring_model_single_open_active_per_shot_type IS
  'At most one open-ended active scoring model per shot type; releases supersede the previous one.';
