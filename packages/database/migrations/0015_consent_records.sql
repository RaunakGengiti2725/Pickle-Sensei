-- 0015: first-party consent architecture (STATUS_BOARD external blocker 3)
-- Two separated scopes: video_analysis ("analyze my video") and
-- model_training ("use my video to improve models" — explicit opt-in,
-- never a default). The ledger is append-only and pseudonymous: records
-- carry only a pseudonym; the user mapping lives in consent_subject so the
-- audit trail survives account deletion without staying identifying.

CREATE TABLE consent_subject (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  pseudonym uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Intentionally NO foreign key from consent_record to consent_subject or
-- app_user: the ledger must outlive the mapping row.
CREATE TABLE consent_record (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  subject_pseudonym uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('video_analysis','model_training')),
  action text NOT NULL CHECK (action IN ('granted','withdrawn')),
  consent_version text NOT NULL,
  source text NOT NULL CHECK (source IN ('mobile_settings','onboarding','privacy_center','support')),
  device text,
  capture_mode text CHECK (capture_mode IN ('automatic_pose_trigger','imported_video','all_captures')),
  stroke_intent text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_consent_record_subject_scope
  ON consent_record(subject_pseudonym, scope, seq);

-- Append-only enforcement: withdrawal is a new row, never an edit.
CREATE FUNCTION consent_record_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_record is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_record_append_only
  BEFORE UPDATE OR DELETE ON consent_record
  FOR EACH ROW EXECUTE FUNCTION consent_record_append_only();
