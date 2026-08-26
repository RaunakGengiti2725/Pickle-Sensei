-- 0001: extensions + identity/consent tables (spec pp. 13–14)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_subject text NOT NULL UNIQUE,
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','deleted')),
  locale text NOT NULL DEFAULT 'en-US',
  timezone text NOT NULL DEFAULT 'America/Los_Angeles',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE user_profile (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  display_name text,
  handedness text CHECK (handedness IN ('right','left','ambidextrous')),
  skill_level text,
  age_band text CHECK (age_band IN ('13-15','16-17','18-24','25-34','35-44','45-54','55-64','65+')),
  primary_goal text,
  biggest_problem text,
  profile_public boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_setting (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  voice_enabled boolean NOT NULL DEFAULT true,
  voice_verbosity text NOT NULL DEFAULT 'balanced' CHECK (voice_verbosity IN ('quiet','balanced','chatty')),
  units text NOT NULL DEFAULT 'imperial' CHECK (units IN ('imperial','metric')),
  local_video_retention_days int,
  cloud_sync_enabled boolean NOT NULL DEFAULT false,
  save_all_live_clips boolean NOT NULL DEFAULT true,
  push_enabled boolean NOT NULL DEFAULT false,
  social_visibility text NOT NULL DEFAULT 'friends' CHECK (social_visibility IN ('private','friends','public')),
  analytics_opt_out boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_device (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('ios','android')),
  push_token text,
  app_version text,
  os_version text,
  model text,
  device_tier text CHECK (device_tier IN ('A','B','C')),
  model_bundle_version text,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_device_user ON user_device(user_id);

CREATE TABLE user_consent (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  consent_type text NOT NULL CHECK (consent_type IN ('terms','privacy','cloud_video_sync','analytics','ml_training','marketing')),
  version text NOT NULL,
  granted boolean NOT NULL,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_consent_user_type ON user_consent(user_id, consent_type, created_at DESC);
