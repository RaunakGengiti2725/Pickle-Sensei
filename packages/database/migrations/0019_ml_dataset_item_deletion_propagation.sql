-- 0019: account-deletion propagation fix (Wave I i30).
-- final_hard_delete removes app_user, which cascades the user's media_asset
-- and shot rows — but ml_dataset_item held plain FKs to both, so the cascade
-- was blocked and the deletion workflow stalled in 'failed' whenever a
-- dataset item had been built from the user's media. Dataset items are
-- pseudonymous bookkeeping rows (source_user_id is already ON DELETE SET
-- NULL, and removal review flags removed_at before the hard delete); severing
-- the asset/shot links the same way lets erasure complete without losing the
-- removed_at trail.
ALTER TABLE ml_dataset_item
  DROP CONSTRAINT ml_dataset_item_media_asset_id_fkey,
  ADD CONSTRAINT ml_dataset_item_media_asset_id_fkey
    FOREIGN KEY (media_asset_id) REFERENCES media_asset(id) ON DELETE SET NULL;

ALTER TABLE ml_dataset_item
  DROP CONSTRAINT ml_dataset_item_feature_asset_id_fkey,
  ADD CONSTRAINT ml_dataset_item_feature_asset_id_fkey
    FOREIGN KEY (feature_asset_id) REFERENCES media_asset(id) ON DELETE SET NULL;

ALTER TABLE ml_dataset_item
  DROP CONSTRAINT ml_dataset_item_source_shot_id_fkey,
  ADD CONSTRAINT ml_dataset_item_source_shot_id_fkey
    FOREIGN KEY (source_shot_id) REFERENCES shot(id) ON DELETE SET NULL;
