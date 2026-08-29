-- 0018: coach review records (Wave G2 h02-review-schema, GATE A readiness)
-- Server-side home for qualified-coach reviews mirroring the schema-v3
-- record used by the coach-review lab (packages/swing-lab coachReview.ts).
-- Truth model:
--  - base reviews are append-only: never updated, never deleted;
--  - amendments are separate append-only rows carrying a FULL replacement
--    snapshot at sequential revisions >= 2 — history is never rewritten;
--  - adjudication is a separate append-only record per queue item;
--  - one review per (queue_item_id, coach_id); the coach identity and the
--    qualification snapshot captured at review time are stored verbatim.
-- These tables start EMPTY and stay empty until real qualified coaches
-- exist; nothing here weakens BLOCKED_ON_VALIDATION.

CREATE TABLE coach_review (
  review_id text PRIMARY KEY,
  queue_item_id text NOT NULL,
  coach_id text NOT NULL CHECK (coach_id !~* 'synthetic'),
  coach_credential_ref text NOT NULL CHECK (btrim(coach_credential_ref) <> ''),
  schema_version integer NOT NULL CHECK (schema_version >= 3),
  stroke_taxonomy_version text NOT NULL,
  fault_taxonomy_version text NOT NULL,
  drill_library_version text NOT NULL,
  record jsonb NOT NULL,
  qualification_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coach_review_id_shape CHECK (review_id = queue_item_id || '.' || coach_id),
  CONSTRAINT coach_review_one_per_coach UNIQUE (queue_item_id, coach_id)
);

CREATE TABLE coach_review_amendment (
  amendment_id text PRIMARY KEY,
  review_id text NOT NULL REFERENCES coach_review(review_id),
  revision integer NOT NULL CHECK (revision >= 2),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT coach_review_amendment_id_shape
    CHECK (amendment_id = review_id || '.r' || revision::text),
  CONSTRAINT coach_review_amendment_sequential UNIQUE (review_id, revision)
);
CREATE INDEX idx_coach_review_amendment_review ON coach_review_amendment(review_id, revision);

CREATE TABLE coach_review_adjudication (
  queue_item_id text PRIMARY KEY,
  adjudicator_id text NOT NULL CHECK (adjudicator_id !~* 'synthetic'),
  adjudicator_credential_ref text NOT NULL CHECK (btrim(adjudicator_credential_ref) <> ''),
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION coach_review_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_coach_review_append_only
  BEFORE UPDATE OR DELETE ON coach_review
  FOR EACH ROW EXECUTE FUNCTION coach_review_append_only();
CREATE TRIGGER trg_coach_review_truncate_append_only
  BEFORE TRUNCATE ON coach_review
  FOR EACH STATEMENT EXECUTE FUNCTION coach_review_append_only();

CREATE TRIGGER trg_coach_review_amendment_append_only
  BEFORE UPDATE OR DELETE ON coach_review_amendment
  FOR EACH ROW EXECUTE FUNCTION coach_review_append_only();
CREATE TRIGGER trg_coach_review_amendment_truncate_append_only
  BEFORE TRUNCATE ON coach_review_amendment
  FOR EACH STATEMENT EXECUTE FUNCTION coach_review_append_only();

CREATE TRIGGER trg_coach_review_adjudication_append_only
  BEFORE UPDATE OR DELETE ON coach_review_adjudication
  FOR EACH ROW EXECUTE FUNCTION coach_review_append_only();
CREATE TRIGGER trg_coach_review_adjudication_truncate_append_only
  BEFORE TRUNCATE ON coach_review_adjudication
  FOR EACH STATEMENT EXECUTE FUNCTION coach_review_append_only();

COMMENT ON TABLE coach_review IS
  'Append-only qualified-coach review records (schema v3). Empty until real coaches are provisioned.';
COMMENT ON TABLE coach_review_amendment IS
  'Append-only full-replacement amendment snapshots at sequential revisions >= 2; base rows are never rewritten.';
COMMENT ON TABLE coach_review_adjudication IS
  'Append-only third-coach adjudication record per queue item; disagreements are preserved, never averaged.';
