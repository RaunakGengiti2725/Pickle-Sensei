-- 0019: user-reported bad analyses (Wave I i09). Each report captures the
-- analysis it disputes, version/device provenance, a bounded failure
-- category, and safe numeric/enum diagnostics only — never raw video, frames,
-- or landmark streams (consent for analysis is not consent for sharing
-- footage with triage). Reports enter a structured triage queue keyed by
-- triage_status. A report is a CLAIM by the user, never a gold label.
CREATE TABLE analysis_issue_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  analysis_job_id uuid NOT NULL REFERENCES analysis_job(id) ON DELETE CASCADE,
  failure_category text NOT NULL CHECK (failure_category IN (
    'wrong_shot_type',
    'score_too_low',
    'score_too_high',
    'phase_detection_wrong',
    'checkpoint_wrong',
    'no_shot_detected',
    'analysis_crashed',
    'other'
  )),
  comment text CHECK (char_length(comment) <= 1000),
  app_version text NOT NULL CHECK (char_length(app_version) <= 40),
  device_platform text NOT NULL CHECK (device_platform IN ('ios','android')),
  device_os_version text NOT NULL CHECK (char_length(device_os_version) <= 40),
  device_model text NOT NULL CHECK (char_length(device_model) <= 80),
  version_vector jsonb NOT NULL,
  diagnostics jsonb NOT NULL DEFAULT '{}',
  triage_status text NOT NULL DEFAULT 'open'
    CHECK (triage_status IN ('open','in_review','resolved','dismissed')),
  triage_note text CHECK (char_length(triage_note) <= 2000),
  triaged_by uuid REFERENCES app_user(id),
  triaged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, analysis_job_id)
);
CREATE INDEX idx_analysis_issue_report_queue
  ON analysis_issue_report(triage_status, created_at)
  WHERE triage_status IN ('open','in_review');
CREATE INDEX idx_analysis_issue_report_job
  ON analysis_issue_report(analysis_job_id);
