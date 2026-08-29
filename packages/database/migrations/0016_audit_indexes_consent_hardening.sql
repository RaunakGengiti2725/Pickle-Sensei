-- 0016: D4-09 migration audit remediations.
--
-- 1) Missing index on the training-plan candidate query path. The API selects
--    drill_checkpoint_map rows by (shot_type_id, checkpoint_definition_id)
--    (services/api/src/modules/training/routes.ts), but the table's only index
--    is the primary key led by drill_id, so every plan generation scans the
--    whole mapping table.
CREATE INDEX idx_drill_checkpoint_map_shot_checkpoint
  ON drill_checkpoint_map(shot_type_id, checkpoint_definition_id);

-- 2) Missing indexes on foreign keys that reference shot / analysis_job /
--    media_asset. The final_hard_delete deletion task issues
--    DELETE FROM app_user, which cascades into shot and media_asset; every
--    referencing table without an index on the FK column is sequentially
--    scanned once per deleted row. Partial WHERE-NOT-NULL indexes keep them
--    small since these columns are mostly null.
CREATE INDEX idx_training_plan_source_shot
  ON training_plan(source_shot_id);
CREATE INDEX idx_training_plan_reassessment_shot
  ON training_plan(reassessment_shot_id) WHERE reassessment_shot_id IS NOT NULL;
CREATE INDEX idx_ml_dataset_item_source_shot
  ON ml_dataset_item(source_shot_id) WHERE source_shot_id IS NOT NULL;
CREATE INDEX idx_ml_dataset_item_media_asset
  ON ml_dataset_item(media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX idx_ml_dataset_item_feature_asset
  ON ml_dataset_item(feature_asset_id) WHERE feature_asset_id IS NOT NULL;
CREATE INDEX idx_session_summary_best_shot
  ON session_summary(best_shot_id) WHERE best_shot_id IS NOT NULL;
CREATE INDEX idx_weekly_report_best_shot
  ON weekly_report(best_shot_id) WHERE best_shot_id IS NOT NULL;
CREATE INDEX idx_share_card_shot
  ON share_card(shot_id) WHERE shot_id IS NOT NULL;
CREATE INDEX idx_share_card_session
  ON share_card(session_id) WHERE session_id IS NOT NULL;
CREATE INDEX idx_shot_analysis_job
  ON shot(analysis_job_id) WHERE analysis_job_id IS NOT NULL;
CREATE INDEX idx_shot_media_asset
  ON shot(media_asset_id) WHERE media_asset_id IS NOT NULL;
CREATE INDEX idx_shot_feature_asset
  ON shot(feature_asset_id) WHERE feature_asset_id IS NOT NULL;

-- 3) Deletion-workflow query paths (services/media-worker/src/worker.ts):
--    media_purge selects media_asset by owner regardless of deleted_at (the
--    existing owner index is partial on deleted_at IS NULL), and idp_revoke
--    counts deletion_task rows by user_id, which has no index.
CREATE INDEX idx_media_asset_owner_object_key
  ON media_asset(owner_user_id) WHERE object_key IS NOT NULL;
CREATE INDEX idx_deletion_task_user
  ON deletion_task(user_id);

-- 4) Consent ledger hardening: 0015 blocks row-level UPDATE/DELETE, but
--    TRUNCATE bypasses row triggers. A statement-level trigger closes the gap
--    so the append-only audit trail cannot be bulk-erased.
CREATE FUNCTION consent_record_no_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'consent_record is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_consent_record_no_truncate
  BEFORE TRUNCATE ON consent_record
  FOR EACH STATEMENT EXECUTE FUNCTION consent_record_no_truncate();
