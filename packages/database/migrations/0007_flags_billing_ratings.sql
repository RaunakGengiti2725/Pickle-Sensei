-- 0007: feature flags, billing offerings, shot ratings, user handles,
--        deletion workflow queue (spec §35/§36/§58; DECISIONS D-012)
ALTER TABLE user_profile ADD COLUMN handle text UNIQUE;

CREATE TABLE shot_rating (
  shot_id uuid PRIMARY KEY REFERENCES shot(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  helpful boolean NOT NULL,
  reason text,
  comment text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Remote-configurable pricing (spec p. 55): no hard-coded prices in clients.
CREATE TABLE billing_offering (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key text NOT NULL UNIQUE,
  platform_product_ids jsonb NOT NULL DEFAULT '{}',
  display_name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_usd_cents int,
  period text CHECK (period IN ('monthly','annual','lifetime')),
  trial_days int NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT true,
  display_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE feature_flag (
  key text PRIMARY KEY,
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,
  rollout_percent smallint NOT NULL DEFAULT 100 CHECK (rollout_percent BETWEEN 0 AND 100),
  conditions jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Account deletion is a workflow (directive §58): queued tasks executed by the
-- worker, auditable, resumable. Never a single silent cascade.
CREATE TABLE deletion_task (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('media_purge','ml_dataset_review','idp_revoke','social_cleanup','final_hard_delete')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','done','failed')),
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX idx_deletion_task_status ON deletion_task(status) WHERE status IN ('queued','processing');
