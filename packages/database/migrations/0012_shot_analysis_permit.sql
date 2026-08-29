-- 0012: bind every newly synced shot to the rating permit reserved before
-- inference. The API writes this association and finalizes the permit in one
-- transaction, closing the direct shot-sync quota bypass.
--
-- Nullable preserves provenance for historical rows created before permits
-- existed. All current API sync contracts require the value.

ALTER TABLE shot
  ADD COLUMN analysis_permit_id uuid
    REFERENCES analysis_permit(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX uq_shot_analysis_permit
  ON shot(analysis_permit_id)
  WHERE analysis_permit_id IS NOT NULL;

-- Existing deployments may contain legacy permit rows whose client-supplied
-- rating UUID never referred to a persisted shot. NOT VALID preserves those
-- historical rows while PostgreSQL enforces the relationship for every new
-- or updated successful permit immediately.
ALTER TABLE analysis_permit
  ADD CONSTRAINT fk_analysis_permit_rating_shot
  FOREIGN KEY (rating_id) REFERENCES shot(id) ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED NOT VALID;

COMMENT ON COLUMN shot.analysis_permit_id IS
  'Server-issued permit atomically consumed for a score or released for an abstention when this shot was inserted.';
