-- 0004: shots + phases + metrics + checkpoint scores + summaries (spec p. 15)
CREATE TABLE shot (
  id uuid PRIMARY KEY, -- client-generated for offline-first
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  session_id uuid REFERENCES practice_session(id) ON DELETE CASCADE,
  analysis_job_id uuid REFERENCES analysis_job(id) ON DELETE SET NULL,
  media_asset_id uuid REFERENCES media_asset(id),
  feature_asset_id uuid REFERENCES media_asset(id),
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  scoring_model_id uuid REFERENCES scoring_model(id),
  camera_view text CHECK (camera_view IN ('side','rear_oblique')),
  captured_at timestamptz NOT NULL,
  start_ms int NOT NULL,
  contact_ms int,
  end_ms int NOT NULL,
  overall_score numeric(4,2) CHECK (overall_score BETWEEN 0 AND 10),
  confidence numeric(5,4) NOT NULL,
  result_kind text NOT NULL CHECK (result_kind IN ('scored','low_confidence')),
  source text NOT NULL CHECK (source IN ('real','fixture')),
  top_fault_checkpoint_id uuid REFERENCES checkpoint_definition(id),
  favorite boolean NOT NULL DEFAULT false,
  model_bundle_version text NOT NULL,
  -- Complete version vector persisted verbatim (spec p. 22); scores are never
  -- silently rescored under new models.
  version_vector jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scored_shots_have_scores CHECK (
    (result_kind = 'scored' AND overall_score IS NOT NULL)
    OR (result_kind = 'low_confidence' AND overall_score IS NULL)
  )
);
CREATE INDEX idx_shot_user_time ON shot(user_id, captured_at DESC);
CREATE INDEX idx_shot_session ON shot(session_id);
CREATE INDEX idx_shot_user_type ON shot(user_id, shot_type_id, captured_at DESC);

CREATE TABLE shot_phase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id uuid NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  phase_key text NOT NULL CHECK (phase_key IN ('ready','prepare','accelerate','contact','follow_through','recover')),
  start_ms int NOT NULL,
  representative_ms int NOT NULL,
  end_ms int NOT NULL,
  confidence numeric(5,4) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}',
  UNIQUE (shot_id, phase_key)
);

CREATE TABLE shot_metric (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_id uuid NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  checkpoint_definition_id uuid REFERENCES checkpoint_definition(id),
  metric_key text NOT NULL,
  metric_value double precision NOT NULL,
  confidence numeric(5,4) NOT NULL,
  unit text NOT NULL,
  source text NOT NULL CHECK (source IN ('real','fixture')),
  extra jsonb NOT NULL DEFAULT '{}',
  UNIQUE (shot_id, metric_key)
);

CREATE TABLE shot_checkpoint_score (
  shot_id uuid NOT NULL REFERENCES shot(id) ON DELETE CASCADE,
  checkpoint_definition_id uuid NOT NULL REFERENCES checkpoint_definition(id),
  score_0_100 numeric(6,3),
  confidence numeric(5,4) NOT NULL,
  band text NOT NULL CHECK (band IN ('green','yellow','red','unscored')),
  direction text NOT NULL,
  severity numeric(5,4) NOT NULL DEFAULT 0,
  recommended_drill_id uuid REFERENCES drill(id),
  PRIMARY KEY (shot_id, checkpoint_definition_id)
);

CREATE TABLE session_summary (
  session_id uuid PRIMARY KEY REFERENCES practice_session(id) ON DELETE CASCADE,
  valid_shot_count int NOT NULL,
  start_score numeric(4,2),
  end_score numeric(4,2),
  average_score numeric(4,2),
  best_score numeric(4,2),
  focus_checkpoint_id uuid REFERENCES checkpoint_definition(id),
  focus_delta numeric(5,2),
  best_shot_id uuid REFERENCES shot(id),
  summary jsonb NOT NULL DEFAULT '{}',
  generated_at timestamptz NOT NULL DEFAULT now()
);
