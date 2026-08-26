-- 0005: progress, reports, achievements, social, notifications, billing (spec pp. 16)
CREATE TABLE progress_daily (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  day date NOT NULL,
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  checkpoint_id uuid REFERENCES checkpoint_definition(id),
  scoring_model_id uuid NOT NULL REFERENCES scoring_model(id),
  shot_count int NOT NULL,
  avg_score numeric(6,3),
  median_score numeric(6,3),
  best_score numeric(6,3),
  PRIMARY KEY (user_id, day, shot_type_id, checkpoint_id, scoring_model_id)
);

CREATE TABLE weekly_report (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  week_start date NOT NULL,
  scoring_model_versions jsonb NOT NULL,
  best_shot_id uuid REFERENCES shot(id),
  next_focus_checkpoint_id uuid REFERENCES checkpoint_definition(id),
  report jsonb NOT NULL,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, week_start)
);

CREATE TABLE achievement (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  points int NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true
);

CREATE TABLE user_achievement (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  achievement_id uuid NOT NULL REFERENCES achievement(id) ON DELETE CASCADE,
  unlocked_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (user_id, achievement_id)
);

CREATE TABLE friendship (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  addressee_user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending','accepted','declined','blocked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (requester_user_id <> addressee_user_id),
  UNIQUE (requester_user_id, addressee_user_id)
);
CREATE INDEX idx_friendship_addressee ON friendship(addressee_user_id, status);

CREATE TABLE share_card (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  shot_id uuid REFERENCES shot(id) ON DELETE SET NULL,
  session_id uuid REFERENCES practice_session(id) ON DELETE SET NULL,
  media_asset_id uuid REFERENCES media_asset(id),
  template_key text NOT NULL,
  privacy_options jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','rendering','ready','failed','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);

CREATE TABLE notification (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  kind text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','cancelled')),
  scheduled_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_notification_user ON notification(user_id, created_at DESC);

CREATE TABLE billing_subscription (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  platform text NOT NULL CHECK (platform IN ('apple','google','web')),
  product_id text NOT NULL,
  external_subscription_id text,
  status text NOT NULL,
  current_period_start timestamptz,
  current_period_end timestamptz,
  environment text,
  raw_last_event jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_billing_subscription_user ON billing_subscription(user_id);

CREATE TABLE entitlement (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  feature_key text NOT NULL,
  subscription_id uuid REFERENCES billing_subscription(id) ON DELETE SET NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  PRIMARY KEY (user_id, feature_key)
);
