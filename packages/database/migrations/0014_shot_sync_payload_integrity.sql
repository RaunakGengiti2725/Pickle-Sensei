-- 0014: bind an accepted offline payload to its canonical write. A client may
-- safely retry the exact payload after a model is retired, but may not reuse a
-- shot id to make a different score appear accepted.

ALTER TABLE shot
  ADD COLUMN sync_payload_sha256 text;

ALTER TABLE shot
  ADD CONSTRAINT shot_sync_payload_sha256_format CHECK (
    sync_payload_sha256 IS NULL OR sync_payload_sha256 ~ '^[0-9a-f]{64}$'
  );

COMMENT ON COLUMN shot.sync_payload_sha256 IS
  'Server-computed SHA-256 of the schema-normalized client sync payload; null only for rows created before migration 0014.';
