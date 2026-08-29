-- 0019: i12 consented data flywheel — training-eligibility ledger.
--
-- Every training-eligibility decision about a dataset item is an append-only
-- ledger entry keyed by the consent version it was taken under, the
-- consent_record seq that authorizes it, the item's analysis/session
-- provenance, and a timestamp. The DB enforces the core invariant of the
-- flywheel: an 'eligible' entry can cite ONLY an active, un-narrowed
-- model_training grant of the same subject under the same consent version.
-- Analysis consent (video_analysis) can therefore never be smuggled into
-- training eligibility, at any layer above this one.
--
-- Like consent_record, entries carry only the subject pseudonym and no
-- foreign keys to rows that may be deleted (analysis jobs, sessions), so the
-- eligibility audit trail outlives the data it governed. dataset_item_id is
-- likewise a bare uuid: ml_dataset_item rows may be hard-deleted during
-- erasure while the decision trail must survive.

CREATE TABLE training_eligibility_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  subject_pseudonym uuid NOT NULL,
  dataset_item_id uuid NOT NULL,
  analysis_id uuid,
  session_id uuid,
  consent_version text NOT NULL,
  -- The consent_record row this decision is grounded in: the authorizing
  -- grant for 'eligible', the triggering record otherwise.
  consent_seq bigint NOT NULL,
  state text NOT NULL CHECK (state IN ('eligible','ineligible','withdrawn')),
  reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_training_eligibility_item
  ON training_eligibility_ledger(dataset_item_id, seq);
CREATE INDEX idx_training_eligibility_subject
  ON training_eligibility_ledger(subject_pseudonym, seq);

-- Scope guard: the ONLY consent record that can ground an 'eligible' entry
-- is a model_training grant, for the same subject, still un-superseded is
-- checked at read time; here we pin what a grant must be at write time:
-- scope model_training, action granted, capture_mode all_captures (narrowed
-- grants authorize nothing — items carry no capture-mode provenance), and
-- the same consent_version the entry claims. A video_analysis record of any
-- kind is rejected outright for every state: analysis consent is not
-- evidence in the training-eligibility ledger.
CREATE FUNCTION training_eligibility_scope_guard() RETURNS trigger AS $$
DECLARE
  grounding consent_record%ROWTYPE;
BEGIN
  SELECT * INTO grounding FROM consent_record WHERE seq = NEW.consent_seq;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'training_eligibility_ledger: consent_seq % does not exist', NEW.consent_seq;
  END IF;
  IF grounding.subject_pseudonym <> NEW.subject_pseudonym THEN
    RAISE EXCEPTION 'training_eligibility_ledger: consent_seq % belongs to a different subject', NEW.consent_seq;
  END IF;
  IF grounding.scope <> 'model_training' THEN
    RAISE EXCEPTION 'training_eligibility_ledger: consent_seq % has scope %; analysis consent never implies training consent', NEW.consent_seq, grounding.scope;
  END IF;
  IF NEW.state = 'eligible' THEN
    IF grounding.action <> 'granted' THEN
      RAISE EXCEPTION 'training_eligibility_ledger: eligible entry cites a % record', grounding.action;
    END IF;
    IF grounding.capture_mode IS DISTINCT FROM 'all_captures' THEN
      RAISE EXCEPTION 'training_eligibility_ledger: eligible entry cites a capture-mode-narrowed grant';
    END IF;
    IF grounding.consent_version <> NEW.consent_version THEN
      RAISE EXCEPTION 'training_eligibility_ledger: consent_version % does not match the cited grant version %', NEW.consent_version, grounding.consent_version;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_training_eligibility_scope_guard
  BEFORE INSERT ON training_eligibility_ledger
  FOR EACH ROW EXECUTE FUNCTION training_eligibility_scope_guard();

-- Append-only, same regime as consent_record: no row edits, no bulk erase.
CREATE FUNCTION training_eligibility_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'training_eligibility_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_training_eligibility_append_only
  BEFORE UPDATE OR DELETE ON training_eligibility_ledger
  FOR EACH ROW EXECUTE FUNCTION training_eligibility_append_only();

CREATE TRIGGER trg_training_eligibility_no_truncate
  BEFORE TRUNCATE ON training_eligibility_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION training_eligibility_append_only();

-- Withdrawal updates FUTURE eligibility at the database level: a
-- model_training withdrawal appended to the consent ledger automatically
-- appends a 'withdrawn' entry for every dataset item whose latest
-- eligibility entry is 'eligible', citing the withdrawal record. No service
-- path can forget to do this.
CREATE FUNCTION training_eligibility_on_withdrawal() RETURNS trigger AS $$
BEGIN
  IF NEW.scope = 'model_training' AND NEW.action = 'withdrawn' THEN
    INSERT INTO training_eligibility_ledger
      (subject_pseudonym, dataset_item_id, analysis_id, session_id,
       consent_version, consent_seq, state, reason)
    SELECT DISTINCT ON (l.dataset_item_id)
      l.subject_pseudonym, l.dataset_item_id, l.analysis_id, l.session_id,
      NEW.consent_version, NEW.seq, 'withdrawn', 'consent.model_training.withdrawn'
    FROM training_eligibility_ledger l
    WHERE l.subject_pseudonym = NEW.subject_pseudonym
      AND l.state = 'eligible'
      AND NOT EXISTS (
        SELECT 1 FROM training_eligibility_ledger newer
        WHERE newer.dataset_item_id = l.dataset_item_id AND newer.seq > l.seq
      )
    ORDER BY l.dataset_item_id, l.seq DESC;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_training_eligibility_on_withdrawal
  AFTER INSERT ON consent_record
  FOR EACH ROW EXECUTE FUNCTION training_eligibility_on_withdrawal();

-- 0018 least-privilege carve-out: the runtimes may append and read the
-- eligibility ledger but never edit it, defense in depth on the triggers.
DO $$
DECLARE
  s text := current_schema();
BEGIN
  EXECUTE format(
    'REVOKE UPDATE, DELETE ON %I.training_eligibility_ledger FROM pickle_application_runtime, pickle_worker_runtime',
    s);
END;
$$;
