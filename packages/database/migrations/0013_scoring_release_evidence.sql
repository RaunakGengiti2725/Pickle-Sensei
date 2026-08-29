-- 0013: a scoring configuration is not a released model merely because its
-- version exists. Canonical scores require explicit dataset, evaluation, coach,
-- bundle, and administrator release evidence.

ALTER TABLE scoring_model
  ADD COLUMN dataset_snapshot_id text,
  ADD COLUMN evaluation_report_sha256 text,
  ADD COLUMN coach_validation_reference text,
  ADD COLUMN released_by uuid REFERENCES app_user(id) ON DELETE RESTRICT,
  ADD COLUMN released_at timestamptz;

-- Earlier seeds registered hypothesis configs as active without a model
-- bundle. Quarantine them instead of allowing arbitrary client JSON to become
-- canonical progress.
UPDATE scoring_model
SET status = 'validating', active_from = NULL
WHERE status = 'active' AND model_bundle_id IS NULL;

ALTER TABLE scoring_model
  ADD CONSTRAINT scoring_model_active_release_evidence CHECK (
    status <> 'active'
    OR (
      model_bundle_id IS NOT NULL
      AND NULLIF(btrim(dataset_snapshot_id), '') IS NOT NULL
      AND evaluation_report_sha256 ~ '^[0-9a-f]{64}$'
      AND NULLIF(btrim(coach_validation_reference), '') IS NOT NULL
      AND released_by IS NOT NULL
      AND released_at IS NOT NULL
      AND active_from IS NOT NULL
    )
  );

COMMENT ON COLUMN scoring_model.dataset_snapshot_id IS
  'Immutable consent/rights-reviewed dataset snapshot used for the released evaluation.';
COMMENT ON COLUMN scoring_model.evaluation_report_sha256 IS
  'SHA-256 of the locked holdout and subgroup evaluation report approved for release.';
COMMENT ON COLUMN scoring_model.coach_validation_reference IS
  'Reference to the qualified-coach agreement/adjudication review for this release.';
