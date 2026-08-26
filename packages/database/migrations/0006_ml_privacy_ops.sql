-- 0006: ML training consent/dataset, idempotency, audit (spec pp. 16–17)
CREATE TABLE ml_training_consent (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  granted boolean NOT NULL,
  terms_version text NOT NULL,
  granted_at timestamptz,
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ml_dataset_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  media_asset_id uuid REFERENCES media_asset(id),
  source_shot_id uuid REFERENCES shot(id),
  feature_asset_id uuid REFERENCES media_asset(id),
  consent_version text NOT NULL,
  deidentified boolean NOT NULL DEFAULT false,
  dataset_split text CHECK (dataset_split IN ('train','validation','test','holdout')),
  annotation_version text,
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz
);
CREATE INDEX idx_ml_dataset_item_user ON ml_dataset_item(source_user_id) WHERE removed_at IS NULL;

CREATE TABLE idempotency_record (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  response_code int,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid,
  actor_service text,
  action text NOT NULL,
  target_kind text,
  target_id text,
  ip_hash text,
  request_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_log_actor ON audit_log(actor_user_id, created_at DESC);
CREATE INDEX idx_audit_log_action ON audit_log(action, created_at DESC);
