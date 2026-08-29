-- 0019: score-version governance (spec pp. 22, 44).
-- Every canonical score is bound to the scoring model version that produced
-- it; analysis runs are an append-only ledger (reprocessing under a new model
-- creates a NEW run and never touches the old one); cross-version
-- comparability exists only as an explicit, evidence-backed declaration.

-- Every scored shot must carry its scoring model binding and a non-empty
-- scoringModelVersion in the persisted version vector. NOT VALID: historical
-- rows are immutable evidence and are never rewritten to satisfy a new rule;
-- every new or updated scored row is enforced from here on.
ALTER TABLE shot
  ADD CONSTRAINT scored_shots_have_scoring_version CHECK (
    result_kind <> 'scored'
    OR (
      scoring_model_id IS NOT NULL
      AND NULLIF(btrim(version_vector->>'scoringModelVersion'), '') IS NOT NULL
    )
  ) NOT VALID;

-- Append-only analysis run ledger. One row per scoring pass over a shot.
CREATE TABLE analysis_run (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  shot_id uuid NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  scoring_model_id uuid NOT NULL REFERENCES scoring_model(id),
  scoring_model_version text NOT NULL CHECK (btrim(scoring_model_version) <> ''),
  overall_score numeric(4,2) CHECK (overall_score BETWEEN 0 AND 10),
  result_kind text NOT NULL CHECK (result_kind IN ('scored','low_confidence')),
  supersedes_run_id uuid REFERENCES analysis_run(id),
  produced_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_run_scored_has_score CHECK (
    (result_kind = 'scored' AND overall_score IS NOT NULL)
    OR (result_kind = 'low_confidence' AND overall_score IS NULL)
  ),
  CONSTRAINT analysis_run_no_self_supersede CHECK (supersedes_run_id <> id)
);
CREATE INDEX idx_analysis_run_shot ON analysis_run(shot_id, created_at);

-- Runs are immutable history: no UPDATE, no DELETE, ever. Reprocessing is a
-- new INSERT with supersedes_run_id set.
CREATE FUNCTION analysis_run_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'analysis_run rows are immutable; reprocessing must insert a new run';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER analysis_run_block_update
  BEFORE UPDATE ON analysis_run
  FOR EACH ROW EXECUTE FUNCTION analysis_run_immutable();
CREATE TRIGGER analysis_run_block_delete
  BEFORE DELETE ON analysis_run
  FOR EACH ROW EXECUTE FUNCTION analysis_run_immutable();

-- Cross-version comparability is never assumed. A row here is an explicit
-- calibration declaration with evidence; without one, progress rendering must
-- show a version transition instead of a continuous line.
CREATE TABLE scoring_version_comparability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  from_version text NOT NULL CHECK (btrim(from_version) <> ''),
  to_version text NOT NULL CHECK (btrim(to_version) <> ''),
  calibration_evidence_ref text NOT NULL CHECK (btrim(calibration_evidence_ref) <> ''),
  declared_by uuid NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
  declared_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT comparability_not_reflexive CHECK (from_version <> to_version),
  -- One declaration per unordered pair: store lexicographically ordered.
  CONSTRAINT comparability_ordered_pair CHECK (from_version < to_version),
  UNIQUE (shot_type_id, from_version, to_version)
);
