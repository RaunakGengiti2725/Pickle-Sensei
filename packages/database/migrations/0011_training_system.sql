-- 0011: evidence-backed training plans, saved drills, completions, reviewed
-- instructional media, and real practice streak inputs.

-- A mapping becomes plan-eligible only after a coach has authored a complete
-- prescription and an administrator has recorded the approval reference.
-- Legacy/fixture mappings intentionally remain unreviewed and cannot leak into
-- a generated plan.
ALTER TABLE drill_checkpoint_map
  ADD COLUMN plan_role text NOT NULL DEFAULT 'targeted'
    CHECK (plan_role IN ('warmup','targeted')),
  ADD COLUMN fault_directions text[] NOT NULL DEFAULT '{}',
  ADD COLUMN cue_text text,
  ADD COLUMN target_sets smallint CHECK (target_sets BETWEEN 1 AND 20),
  ADD COLUMN target_repetitions_per_set smallint
    CHECK (target_repetitions_per_set BETWEEN 1 AND 500),
  ADD COLUMN target_duration_seconds int
    CHECK (target_duration_seconds BETWEEN 10 AND 7200),
  ADD COLUMN rest_seconds int CHECK (rest_seconds BETWEEN 0 AND 900),
  ADD COLUMN coach_reviewed_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  ADD COLUMN coach_reviewed_at timestamptz,
  ADD COLUMN coach_approval_reference text,
  ADD CONSTRAINT drill_mapping_fault_directions_valid CHECK (
    fault_directions <@ ARRAY[
      'late','early','high','low','long','short','wide','narrow',
      'open','closed','unstable','none'
    ]::text[]
  ),
  ADD CONSTRAINT drill_mapping_review_is_complete CHECK (
    coach_reviewed_at IS NULL OR (
      NULLIF(btrim(coach_approval_reference), '') IS NOT NULL
      AND NULLIF(btrim(cue_text), '') IS NOT NULL
      AND target_sets IS NOT NULL
      AND (
        (target_repetitions_per_set IS NOT NULL AND target_duration_seconds IS NULL)
        OR
        (target_repetitions_per_set IS NULL AND target_duration_seconds IS NOT NULL)
      )
    )
  );

CREATE TABLE user_saved_drill (
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  drill_id uuid NOT NULL REFERENCES drill(id) ON DELETE CASCADE,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, drill_id)
);
CREATE INDEX idx_user_saved_drill_recent
  ON user_saved_drill(user_id, saved_at DESC);

-- Only fully licensed and independently reviewed media is eligible for
-- playback. Discovery candidates can be held as pending without appearing in
-- the product; the catalog route applies the complete publication predicate.
CREATE TABLE drill_instructional_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drill_id uuid NOT NULL REFERENCES drill(id) ON DELETE CASCADE,
  media_asset_id uuid REFERENCES media_asset(id) ON DELETE SET NULL,
  external_provider text CHECK (external_provider IN ('youtube','vimeo')),
  external_video_id text,
  source_url text NOT NULL,
  creator_name text,
  license_name text,
  license_url text,
  attribution text,
  rights_status text NOT NULL DEFAULT 'pending'
    CHECK (rights_status IN ('pending','approved','rejected','expired')),
  rights_reviewed_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  rights_reviewed_at timestamptz,
  rights_review_reference text,
  rights_expires_at timestamptz,
  coach_status text NOT NULL DEFAULT 'pending'
    CHECK (coach_status IN ('pending','approved','rejected')),
  coach_reviewed_by uuid REFERENCES app_user(id) ON DELETE SET NULL,
  coach_reviewed_at timestamptz,
  coach_review_reference text,
  embed_approved_at timestamptz,
  active boolean NOT NULL DEFAULT false,
  display_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (media_asset_id IS NOT NULL AND external_provider IS NULL AND external_video_id IS NULL)
    OR
    (media_asset_id IS NULL AND external_provider IS NOT NULL AND NULLIF(btrim(external_video_id), '') IS NOT NULL)
  ),
  CHECK (
    rights_status <> 'approved' OR (
      rights_reviewed_at IS NOT NULL
      AND NULLIF(btrim(rights_review_reference), '') IS NOT NULL
      AND NULLIF(btrim(creator_name), '') IS NOT NULL
      AND NULLIF(btrim(license_name), '') IS NOT NULL
      AND NULLIF(btrim(attribution), '') IS NOT NULL
    )
  ),
  CHECK (
    coach_status <> 'approved' OR (
      coach_reviewed_at IS NOT NULL
      AND NULLIF(btrim(coach_review_reference), '') IS NOT NULL
    )
  ),
  CHECK (external_provider IS NOT NULL OR embed_approved_at IS NULL)
);
CREATE INDEX idx_drill_instructional_media_published
  ON drill_instructional_media(drill_id, display_order)
  WHERE active AND rights_status = 'approved' AND coach_status = 'approved';

CREATE TABLE training_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  source_shot_id uuid NOT NULL REFERENCES shot(id) ON DELETE RESTRICT,
  shot_type_id uuid NOT NULL REFERENCES shot_type(id),
  priority_checkpoint_id uuid NOT NULL REFERENCES checkpoint_definition(id),
  scoring_model_id uuid NOT NULL REFERENCES scoring_model(id),
  priority_direction text NOT NULL CHECK (priority_direction IN (
    'late','early','high','low','long','short','wide','narrow',
    'open','closed','unstable','none'
  )),
  baseline_score numeric(4,2) NOT NULL CHECK (baseline_score BETWEEN 0 AND 10),
  baseline_checkpoint_score numeric(6,3)
    CHECK (baseline_checkpoint_score BETWEEN 0 AND 100),
  algorithm_version text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','completed','superseded')),
  reassessment_shot_id uuid REFERENCES shot(id) ON DELETE SET NULL,
  score_delta numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (user_id, source_shot_id, algorithm_version),
  CHECK (
    (status = 'completed' AND completed_at IS NOT NULL AND reassessment_shot_id IS NOT NULL)
    OR status <> 'completed'
  )
);
CREATE UNIQUE INDEX idx_training_plan_one_active
  ON training_plan(user_id) WHERE status = 'active';
CREATE INDEX idx_training_plan_user_recent
  ON training_plan(user_id, created_at DESC);

-- Prescriptions are snapshotted when a plan is generated. Subsequent catalog
-- edits never rewrite what the athlete was actually prescribed.
CREATE TABLE training_plan_item (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  training_plan_id uuid NOT NULL REFERENCES training_plan(id) ON DELETE CASCADE,
  position smallint NOT NULL CHECK (position BETWEEN 1 AND 20),
  item_kind text NOT NULL CHECK (item_kind IN ('warmup','targeted','reassessment')),
  drill_id uuid REFERENCES drill(id) ON DELETE RESTRICT,
  cue_text text,
  target_sets smallint CHECK (target_sets BETWEEN 1 AND 20),
  target_repetitions_per_set smallint
    CHECK (target_repetitions_per_set BETWEEN 1 AND 500),
  target_duration_seconds int CHECK (target_duration_seconds BETWEEN 10 AND 7200),
  rest_seconds int CHECK (rest_seconds BETWEEN 0 AND 900),
  prescription_snapshot jsonb NOT NULL DEFAULT '{}',
  UNIQUE (training_plan_id, position),
  CHECK (
    (item_kind = 'reassessment' AND drill_id IS NULL AND cue_text IS NULL
      AND target_sets IS NULL AND target_repetitions_per_set IS NULL
      AND target_duration_seconds IS NULL)
    OR
    (item_kind <> 'reassessment' AND drill_id IS NOT NULL
      AND NULLIF(btrim(cue_text), '') IS NOT NULL
      AND target_sets IS NOT NULL
      AND (
        (target_repetitions_per_set IS NOT NULL AND target_duration_seconds IS NULL)
        OR
        (target_repetitions_per_set IS NULL AND target_duration_seconds IS NOT NULL)
      ))
  )
);

CREATE TABLE drill_completion (
  id uuid PRIMARY KEY, -- client generated for offline idempotency
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  drill_id uuid NOT NULL REFERENCES drill(id) ON DELETE RESTRICT,
  training_plan_item_id uuid REFERENCES training_plan_item(id) ON DELETE SET NULL,
  practice_session_id uuid REFERENCES practice_session(id) ON DELETE SET NULL,
  completed_at timestamptz NOT NULL,
  actual_repetitions int CHECK (actual_repetitions BETWEEN 1 AND 10000),
  actual_duration_seconds int CHECK (actual_duration_seconds BETWEEN 1 AND 14400),
  evidence_kind text NOT NULL CHECK (evidence_kind IN ('user_confirmed','session_linked')),
  qualifies_for_streak boolean NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (actual_repetitions IS NOT NULL OR actual_duration_seconds IS NOT NULL)
);
CREATE INDEX idx_drill_completion_user_time
  ON drill_completion(user_id, completed_at DESC);
CREATE INDEX idx_drill_completion_plan_item
  ON drill_completion(training_plan_item_id, completed_at DESC)
  WHERE training_plan_item_id IS NOT NULL;
