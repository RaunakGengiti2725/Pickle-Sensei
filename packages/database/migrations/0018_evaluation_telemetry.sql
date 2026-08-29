-- 0018: evaluation-telemetry consent scope + append-only evaluation_trial
-- store (Wave G2 h07 — fresh-user evidence collection).
--
-- 1) New independent consent scope `evaluation_telemetry` ("record my
--    analysis attempts for evaluation"). Explicit opt-in like model_training,
--    never a default; the existing append-only ledger machinery is reused
--    unchanged. The CHECK constraint is widened, never narrowed.
ALTER TABLE consent_record DROP CONSTRAINT consent_record_scope_check;
ALTER TABLE consent_record ADD CONSTRAINT consent_record_scope_check
  CHECK (scope IN ('video_analysis','model_training','evaluation_telemetry'));

-- 2) Evaluation trial store. One row per uploaded on-device analysis attempt.
--    Rows carry CLAIMS and abstentions, never verdicts — correctness is
--    decided off-line against gold by the evaluation pipeline. Pseudonymous
--    (consent pseudonym only) and append-only like the consent ledger.
CREATE TABLE evaluation_trial (
  trial_id uuid PRIMARY KEY,
  subject_pseudonym uuid NOT NULL,
  schema_version text NOT NULL,
  consent_version text NOT NULL,
  captured_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  record jsonb NOT NULL
);
CREATE INDEX idx_evaluation_trial_subject
  ON evaluation_trial(subject_pseudonym, received_at);

CREATE FUNCTION evaluation_trial_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'evaluation_trial is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_evaluation_trial_append_only
  BEFORE UPDATE OR DELETE ON evaluation_trial
  FOR EACH ROW EXECUTE FUNCTION evaluation_trial_append_only();

CREATE TRIGGER trg_evaluation_trial_no_truncate
  BEFORE TRUNCATE ON evaluation_trial
  FOR EACH STATEMENT EXECUTE FUNCTION evaluation_trial_append_only();
