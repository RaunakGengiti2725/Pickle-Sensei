-- 0019: staged-rollout persistence (Wave I i05 — canary rollout machinery).
--
-- One row per rollout in model_rollout; every state change lands in the
-- append-only model_rollout_transition ledger. Stage percentages and
-- statuses mirror the frozen ladder in @pickle/rollout (1/5/20/50/100).
-- The known-good predecessor is recorded at creation and never updated —
-- rollback always has a concrete landing version.

CREATE TABLE model_rollout (
  rollout_id uuid PRIMARY KEY,
  model_id text NOT NULL,
  candidate_version text NOT NULL,
  known_good_version text NOT NULL,
  active_version text NOT NULL,
  stage_percent integer NOT NULL CHECK (stage_percent IN (0, 1, 5, 20, 50, 100)),
  status text NOT NULL CHECK (status IN ('in_progress', 'paused', 'rolled_back', 'complete')),
  criteria_id text NOT NULL,
  criteria_sha256 text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (candidate_version <> known_good_version),
  -- A rolled-back rollout serves the known-good predecessor at 0% canary;
  -- a completed rollout serves the candidate.
  CHECK (status <> 'rolled_back' OR (active_version = known_good_version AND stage_percent = 0)),
  CHECK (status <> 'complete' OR active_version = candidate_version)
);

-- At most one live rollout per model at a time.
CREATE UNIQUE INDEX idx_model_rollout_live ON model_rollout(model_id)
  WHERE status IN ('in_progress', 'paused');

CREATE TABLE model_rollout_transition (
  rollout_id uuid NOT NULL REFERENCES model_rollout(rollout_id),
  seq integer NOT NULL CHECK (seq >= 0),
  action text NOT NULL CHECK (action IN ('create', 'promote', 'pause', 'resume', 'rollback')),
  from_stage_percent integer NOT NULL CHECK (from_stage_percent IN (0, 1, 5, 20, 50, 100)),
  to_stage_percent integer NOT NULL CHECK (to_stage_percent IN (0, 1, 5, 20, 50, 100)),
  from_status text NOT NULL
    CHECK (from_status IN ('in_progress', 'paused', 'rolled_back', 'complete')),
  to_status text NOT NULL CHECK (to_status IN ('in_progress', 'paused', 'rolled_back', 'complete')),
  health_overall text CHECK (health_overall IN ('HEALTHY', 'UNHEALTHY', 'NOT_EVALUABLE')),
  health_report jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rollout_id, seq),
  -- Only the synthetic create transition and an operator kill switch
  -- (rollback) may lack a health report; promotion always carries one.
  CHECK (health_overall IS NOT NULL OR action IN ('create', 'rollback')),
  CHECK ((health_report IS NULL) = (health_overall IS NULL)),
  -- Promotion/resume is only ever recorded with a HEALTHY report.
  CHECK (action NOT IN ('promote', 'resume') OR health_overall = 'HEALTHY')
);

CREATE FUNCTION model_rollout_transition_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'model_rollout_transition is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_rollout_transition_append_only
  BEFORE UPDATE OR DELETE ON model_rollout_transition
  FOR EACH ROW EXECUTE FUNCTION model_rollout_transition_append_only();

CREATE TRIGGER trg_model_rollout_transition_no_truncate
  BEFORE TRUNCATE ON model_rollout_transition
  FOR EACH STATEMENT EXECUTE FUNCTION model_rollout_transition_append_only();

-- The known-good predecessor is immutable after creation.
CREATE FUNCTION model_rollout_guard_known_good() RETURNS trigger AS $$
BEGIN
  IF NEW.known_good_version <> OLD.known_good_version
     OR NEW.candidate_version <> OLD.candidate_version
     OR NEW.rollout_id <> OLD.rollout_id
     OR NEW.model_id <> OLD.model_id THEN
    RAISE EXCEPTION 'model_rollout identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_model_rollout_guard_known_good
  BEFORE UPDATE ON model_rollout
  FOR EACH ROW EXECUTE FUNCTION model_rollout_guard_known_good();
