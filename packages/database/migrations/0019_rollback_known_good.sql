-- Wave I (i06-rollback-drill): durable known-good snapshots for operational
-- rollback. One row per subsystem; recording overwrites the previous
-- known-good (the previous snapshot's content remains reconstructable from
-- audit_log metadata written by the API on every record/rollback).
CREATE TABLE rollback_known_good (
  subsystem text PRIMARY KEY,
  snapshot jsonb NOT NULL,
  recorded_by uuid REFERENCES app_user(id),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
