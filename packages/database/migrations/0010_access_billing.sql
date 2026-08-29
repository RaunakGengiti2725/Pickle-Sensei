-- 0010: lifetime rating access ledger + verified billing-provider state.
--
-- A rating credit is reserved before inference and consumed only by a
-- successful, confidence-qualified score.  Reservations serialize per user so
-- concurrent devices can never reserve more than the two lifetime free ratings.

CREATE TABLE analysis_access_account (
  user_id uuid PRIMARY KEY REFERENCES app_user(id) ON DELETE CASCADE,
  free_successful_ratings smallint NOT NULL DEFAULT 0
    CHECK (free_successful_ratings BETWEEN 0 AND 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE analysis_permit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  idempotency_key uuid NOT NULL,
  access_source text NOT NULL CHECK (access_source IN ('free','premium')),
  status text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved','consumed','released','expired')),
  outcome text CHECK (
    outcome IS NULL OR outcome IN (
      'scored','low_confidence','cancelled','failed','unsupported','incorrect_recognition','expired'
    )
  ),
  rating_id uuid UNIQUE,
  reserved_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  finalized_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key),
  CHECK (expires_at > reserved_at),
  CHECK (
    (status = 'reserved' AND outcome IS NULL AND finalized_at IS NULL) OR
    (status <> 'reserved' AND outcome IS NOT NULL AND finalized_at IS NOT NULL)
  ),
  CHECK ((outcome = 'scored' AND status = 'consumed' AND rating_id IS NOT NULL) OR outcome <> 'scored' OR outcome IS NULL)
);
CREATE INDEX idx_analysis_permit_user_status
  ON analysis_permit(user_id, status, expires_at);

ALTER TABLE analysis_job
  ADD COLUMN analysis_permit_id uuid UNIQUE REFERENCES analysis_permit(id) ON DELETE SET NULL;

-- Provider provenance prevents an unverified client payload from masquerading
-- as canonical subscription state. Existing/admin-created rows retain their
-- explicit legacy/admin source.
ALTER TABLE billing_subscription
  ADD COLUMN provider text NOT NULL DEFAULT 'direct_store'
    CHECK (provider IN ('direct_store','revenuecat')),
  ADD COLUMN provider_customer_id text,
  ADD COLUMN provider_verified_at timestamptz;

ALTER TABLE entitlement
  ADD COLUMN source text NOT NULL DEFAULT 'admin'
    CHECK (source IN ('admin','direct_store','revenuecat'));

CREATE TABLE billing_provider_event (
  provider text NOT NULL CHECK (provider IN ('revenuecat')),
  event_id text NOT NULL,
  user_id uuid REFERENCES app_user(id) ON DELETE SET NULL,
  payload_sha256 text NOT NULL,
  status text NOT NULL DEFAULT 'received'
    CHECK (status IN ('received','processed','failed')),
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  failure_code text,
  PRIMARY KEY (provider, event_id)
);
CREATE INDEX idx_billing_provider_event_status
  ON billing_provider_event(provider, status, received_at);

-- Lifetime products are not part of the launch catalog. Seeding will install
-- the two current products and their exact prices/trial configuration.
UPDATE billing_offering SET active = false WHERE period = 'lifetime';
