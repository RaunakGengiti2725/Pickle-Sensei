-- 0002: catalog + model/scoring configuration (spec pp. 14–15, directive §20/§22)
CREATE TABLE shot_type (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  display_order smallint NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE checkpoint_definition (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  default_explanation_key text,
  display_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_bundle (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  manifest_sha256 text,
  ios_min_app_version text,
  android_min_app_version text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','canary','active','retired')),
  rollout_percent smallint NOT NULL DEFAULT 0 CHECK (rollout_percent BETWEEN 0 AND 100),
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE scoring_model (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  version text NOT NULL,
  model_bundle_id uuid REFERENCES model_bundle(id),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','validating','active','retired')),
  min_analysis_confidence numeric(5,4) NOT NULL DEFAULT 0.65,
  lower_confidence_threshold numeric(5,4) NOT NULL DEFAULT 0.80,
  config jsonb NOT NULL DEFAULT '{}',
  active_from timestamptz,
  active_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shot_type_id, version)
);

CREATE TABLE scoring_model_checkpoint (
  scoring_model_id uuid NOT NULL REFERENCES scoring_model(id) ON DELETE CASCADE,
  checkpoint_definition_id uuid NOT NULL REFERENCES checkpoint_definition(id),
  display_order smallint NOT NULL,
  weight numeric(7,4) NOT NULL,
  applicable boolean NOT NULL DEFAULT true,
  coach_priority numeric(7,4) NOT NULL DEFAULT 1,
  changeability numeric(5,4) NOT NULL DEFAULT 0.8,
  PRIMARY KEY (scoring_model_id, checkpoint_definition_id)
);

CREATE TABLE scoring_target (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scoring_model_id uuid NOT NULL REFERENCES scoring_model(id) ON DELETE CASCADE,
  checkpoint_definition_id uuid NOT NULL REFERENCES checkpoint_definition(id),
  metric_key text NOT NULL,
  target_kind text NOT NULL DEFAULT 'interval' CHECK (target_kind IN ('interval','gaussian','categorical','monotonic','custom')),
  lower_bound double precision,
  upper_bound double precision,
  sigma double precision,
  metric_weight numeric(7,4) NOT NULL DEFAULT 1,
  direction_below text NOT NULL DEFAULT 'none',
  direction_above text NOT NULL DEFAULT 'none',
  params jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scoring_model_id, checkpoint_definition_id, metric_key)
);

CREATE TABLE drill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  coach_name text,
  media_asset_id uuid,
  difficulty_min text,
  difficulty_max text,
  equipment jsonb NOT NULL DEFAULT '[]',
  is_dev_fixture boolean NOT NULL DEFAULT false,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drill_checkpoint_map (
  drill_id uuid NOT NULL REFERENCES drill(id) ON DELETE CASCADE,
  checkpoint_definition_id uuid NOT NULL REFERENCES checkpoint_definition(id),
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  priority numeric(7,4) NOT NULL DEFAULT 1,
  PRIMARY KEY (drill_id, checkpoint_definition_id, shot_type_id)
);
