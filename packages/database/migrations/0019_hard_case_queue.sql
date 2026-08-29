-- 0019: production hard-case queue (Wave I i10-hard-case-queue).
--
-- One row per deduplicated hard case; recurrences merge into the existing row
-- via the fingerprint unique index. State machine and append-only history are
-- enforced IN the database so no writer — buggy or malicious — can drop a
-- case or take an illegal shortcut:
--   new → triaged → in-review → resolved | regression
--   resolved → regression (recurrence reopens; never silently re-closed)
--   regression → triaged
-- DELETE is forbidden on hard_case; hard_case_event is fully append-only.

CREATE TABLE hard_case (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fingerprint text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN (
    'user_feedback','shadow_disagreement','model_disagreement','high_uncertainty',
    'unexpected_abstention','capture_envelope_failure','coach_disagreement',
    'red_team','anomaly')),
  category text NOT NULL CHECK (category IN (
    'TARGET','EVENT','PADDLE','OWNERSHIP','BALL','CONTACT','PHASE','STROKE',
    'AUTO','CAPTURE','SESSION','COACHING','OTHER')),
  subject_key text NOT NULL,
  state text NOT NULL DEFAULT 'new' CHECK (state IN (
    'new','triaged','in-review','resolved','regression')),
  severity text NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  occurrence_count integer NOT NULL DEFAULT 1 CHECK (occurrence_count >= 1),
  regression_count integer NOT NULL DEFAULT 0 CHECK (regression_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_hard_case_state ON hard_case(state, category);

-- Append-only per-case event history (ingests, merges, transitions).
CREATE TABLE hard_case_event (
  id bigserial PRIMARY KEY,
  hard_case_id uuid NOT NULL REFERENCES hard_case(id),
  event_type text NOT NULL CHECK (event_type IN ('ingested','merged','regression_reopened','transitioned')),
  from_state text,
  to_state text,
  actor text NOT NULL,
  source text,
  evidence_ref text,
  detail text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_hard_case_event_case ON hard_case_event(hard_case_id, at);

CREATE FUNCTION hard_case_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' OR TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'hard_case rows can never be deleted';
  END IF;
  IF NEW.fingerprint <> OLD.fingerprint OR NEW.source <> OLD.source
     OR NEW.category <> OLD.category OR NEW.subject_key <> OLD.subject_key
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'hard_case identity columns are immutable';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
       (OLD.state = 'new'        AND NEW.state = 'triaged')
    OR (OLD.state = 'triaged'    AND NEW.state = 'in-review')
    OR (OLD.state = 'in-review'  AND NEW.state IN ('resolved','regression'))
    OR (OLD.state = 'resolved'   AND NEW.state = 'regression')
    OR (OLD.state = 'regression' AND NEW.state = 'triaged')
  ) THEN
    RAISE EXCEPTION 'illegal hard_case transition % -> %', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hard_case_guard
  BEFORE UPDATE OR DELETE ON hard_case
  FOR EACH ROW EXECUTE FUNCTION hard_case_guard();

CREATE FUNCTION hard_case_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hard_case can never be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hard_case_no_truncate
  BEFORE TRUNCATE ON hard_case
  FOR EACH STATEMENT EXECUTE FUNCTION hard_case_no_truncate();

CREATE FUNCTION hard_case_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'hard_case_event is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_hard_case_event_append_only
  BEFORE UPDATE OR DELETE ON hard_case_event
  FOR EACH ROW EXECUTE FUNCTION hard_case_event_append_only();

CREATE TRIGGER trg_hard_case_event_no_truncate
  BEFORE TRUNCATE ON hard_case_event
  FOR EACH STATEMENT EXECUTE FUNCTION hard_case_event_append_only();
