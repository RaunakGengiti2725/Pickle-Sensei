-- 0019: lightweight user feedback on delivered analyses (Wave I,
-- i08-user-feedback).
-- Truth model:
--  - feedback is a FAILURE-MINING signal, never gold: signal_kind is fixed
--    at 'user_feedback_failure_mining' by a CHECK so no writer can re-tag a
--    user tap as a label source;
--  - rows are append-only (trigger enforced) — a user changing their mind is
--    a product decision for later, never an UPDATE that rewrites a signal;
--  - review_eligible is derived from the real consent ledger at submission
--    time (active model_training grant); consent for analysis is separate
--    from consent for model improvement;
--  - the hard-case queue view exposes only negative, review-eligible rows.

CREATE TABLE analysis_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  analysis_id uuid NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  rating text NOT NULL CHECK (rating IN ('accurate','not_quite')),
  category text CHECK (category IN (
    'wrong_stroke','wrong_player','contact_looks_wrong','feedback_mismatch','other')),
  signal_kind text NOT NULL DEFAULT 'user_feedback_failure_mining'
    CHECK (signal_kind = 'user_feedback_failure_mining'),
  -- Version vector copied verbatim from the shot row at submission time;
  -- never taken from the client request.
  version_vector jsonb NOT NULL,
  review_eligible boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analysis_feedback_category_shape CHECK (
    (rating = 'not_quite' AND category IS NOT NULL)
    OR (rating = 'accurate' AND category IS NULL)
  ),
  CONSTRAINT analysis_feedback_one_per_user UNIQUE (analysis_id, user_id)
);
CREATE INDEX idx_analysis_feedback_hard_case
  ON analysis_feedback(created_at) WHERE rating = 'not_quite' AND review_eligible;

CREATE FUNCTION analysis_feedback_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'analysis_feedback is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_analysis_feedback_append_only
  BEFORE UPDATE OR DELETE ON analysis_feedback
  FOR EACH ROW EXECUTE FUNCTION analysis_feedback_append_only();
CREATE TRIGGER trg_analysis_feedback_truncate_append_only
  BEFORE TRUNCATE ON analysis_feedback
  FOR EACH STATEMENT EXECUTE FUNCTION analysis_feedback_append_only();

-- Hard-case queue feed: only negative, review-eligible feedback surfaces.
-- Eligibility is double-checked LIVE against the consent ledger so a
-- model_training withdrawal after submission removes the row from the
-- queue without rewriting the append-only feedback record. Consumers treat
-- rows as review NOMINATIONS, never labels.
CREATE VIEW analysis_feedback_hard_case_queue AS
  SELECT f.id, f.analysis_id, f.category, f.version_vector, f.created_at
  FROM analysis_feedback f
  JOIN consent_subject cs ON cs.user_id = f.user_id
  JOIN LATERAL (
    SELECT cr.action
    FROM consent_record cr
    WHERE cr.subject_pseudonym = cs.pseudonym AND cr.scope = 'model_training'
    ORDER BY cr.seq DESC LIMIT 1
  ) latest ON true
  WHERE f.rating = 'not_quite' AND f.review_eligible AND latest.action = 'granted';

COMMENT ON TABLE analysis_feedback IS
  'Append-only user feedback on delivered analyses. Failure-mining signal only — never gold labels.';
COMMENT ON VIEW analysis_feedback_hard_case_queue IS
  'Hard-case review nominations: negative feedback whose footage has active model_training consent.';
