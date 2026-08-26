-- 0003: media, references, goals, sessions, analysis jobs (spec pp. 14–15)
CREATE TABLE media_asset (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid REFERENCES app_user(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('raw_video','normalized_video','thumbnail','share_video','features','model_bundle','drill_video','reference_video')),
  storage_provider text NOT NULL DEFAULT 's3',
  bucket text,
  object_key text,
  content_type text,
  size_bytes bigint,
  width int,
  height int,
  fps numeric(6,2),
  duration_ms int,
  sha256 text,
  encryption_key_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','uploading','ready','processing','failed','deleted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  deleted_at timestamptz
);
CREATE INDEX idx_media_asset_owner ON media_asset(owner_user_id) WHERE deleted_at IS NULL;

ALTER TABLE drill
  ADD CONSTRAINT fk_drill_media FOREIGN KEY (media_asset_id) REFERENCES media_asset(id);

CREATE TABLE pro_reference (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  athlete_name text NOT NULL,
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  media_asset_id uuid REFERENCES media_asset(id),
  feature_asset_id uuid REFERENCES media_asset(id),
  license text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_goal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  shot_type_id uuid REFERENCES shot_type(id),
  checkpoint_id uuid REFERENCES checkpoint_definition(id),
  goal_type text NOT NULL,
  title text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','completed','abandoned')),
  baseline_value double precision,
  target_value double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz,
  completed_at timestamptz
);
CREATE INDEX idx_user_goal_user ON user_goal(user_id) WHERE status = 'active';

CREATE TABLE practice_session (
  id uuid PRIMARY KEY, -- client-generated for offline-first
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('live','guided_drill','single','import')),
  selected_shot_type_id uuid REFERENCES shot_type(id),
  focus_checkpoint_id uuid REFERENCES checkpoint_definition(id),
  scoring_model_id uuid REFERENCES scoring_model(id),
  device_id uuid REFERENCES user_device(id),
  camera_view text CHECK (camera_view IN ('side','rear_oblique')),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  avg_score numeric(4,2),
  shot_count int NOT NULL DEFAULT 0,
  completed boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_practice_session_user ON practice_session(user_id, started_at DESC);

CREATE TABLE analysis_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  media_asset_id uuid REFERENCES media_asset(id),
  session_id uuid REFERENCES practice_session(id) ON DELETE SET NULL,
  expected_shot_type_id uuid REFERENCES shot_type(id),
  inference_mode text NOT NULL CHECK (inference_mode IN ('on_device','cloud_deep')),
  status text NOT NULL CHECK (status IN ('queued','processing','complete','failed','cancelled')),
  failure_code text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_analysis_job_user ON analysis_job(user_id, requested_at DESC);
CREATE INDEX idx_analysis_job_status ON analysis_job(status) WHERE status IN ('queued','processing');
