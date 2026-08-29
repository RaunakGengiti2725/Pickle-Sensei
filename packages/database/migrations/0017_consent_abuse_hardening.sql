-- 0017: f23 consent red-team remediations (Wave F).
--
-- Findings this closes at the schema level; the service-layer halves live in
-- services/api/src/modules/consent/routes.ts and
-- services/media-worker/src/trainingConsent.ts.
--
-- F23-1  Replayed consent decisions. A grant request carries no decision
--        identity, so an offline-queued or captured grant replayed AFTER a
--        withdrawal silently resurrects consent. A grant may now carry a
--        single-use decision_id; the partial unique index is the authority so
--        two concurrent replays cannot both append.
ALTER TABLE consent_record ADD COLUMN decision_id uuid;
ALTER TABLE consent_record ADD COLUMN decided_at timestamptz;
CREATE UNIQUE INDEX ux_consent_record_decision_id
  ON consent_record(decision_id) WHERE decision_id IS NOT NULL;

-- F23-2  Pseudonym repointing. consent_subject was fully mutable through the
--        service role, so the mapping could be pointed at a different
--        pseudonym, silently re-attributing (or detaching) an append-only
--        ledger. The pseudonym is now immutable for the life of the row;
--        re-mapping means deleting the row, which is recorded below.
CREATE FUNCTION consent_subject_pseudonym_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.pseudonym <> OLD.pseudonym THEN
    RAISE EXCEPTION 'consent_subject.pseudonym is immutable';
  END IF;
  IF NEW.user_id <> OLD.user_id THEN
    RAISE EXCEPTION 'consent_subject.user_id is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_subject_pseudonym_immutable
  BEFORE UPDATE ON consent_subject
  FOR EACH ROW EXECUTE FUNCTION consent_subject_pseudonym_immutable();

-- F23-3  Silent attribution erasure. Deleting the mapping row orphans the
--        subject's ledger: /status and /export then report an empty history
--        while the rows remain, and a re-grant starts a fresh pseudonym.
--        Legitimately this happens exactly once per account deletion (the
--        app_user cascade), so the erasure is now tombstoned automatically.
--        Orphaned ledger subjects WITHOUT a tombstone are evidence of an
--        out-of-band deletion (see findOrphanedLedgerSubjects).
CREATE TABLE consent_subject_erasure (
  pseudonym uuid PRIMARY KEY,
  erased_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION consent_subject_tombstone() RETURNS trigger AS $$
BEGIN
  INSERT INTO consent_subject_erasure (pseudonym)
  VALUES (OLD.pseudonym)
  ON CONFLICT (pseudonym) DO NOTHING;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_subject_tombstone
  BEFORE DELETE ON consent_subject
  FOR EACH ROW EXECUTE FUNCTION consent_subject_tombstone();

-- The tombstone table is itself append-only: it is the only record that an
-- orphaned ledger was orphaned lawfully.
CREATE FUNCTION consent_subject_erasure_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_subject_erasure is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_subject_erasure_append_only
  BEFORE UPDATE OR DELETE ON consent_subject_erasure
  FOR EACH ROW EXECUTE FUNCTION consent_subject_erasure_append_only();

CREATE TRIGGER trg_consent_subject_erasure_no_truncate
  BEFORE TRUNCATE ON consent_subject_erasure
  FOR EACH STATEMENT EXECUTE FUNCTION consent_record_no_truncate();
