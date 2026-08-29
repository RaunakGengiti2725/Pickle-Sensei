import type { Pool } from "pg";
import { CHECKPOINTS, SHOT_TYPES } from "@pickle/shared-types";
import { getAllShotScoringConfigs } from "@pickle/scoring";

/**
 * Deterministic development/production catalog seeds (directive §52).
 * Scoring configuration is generated from packages/scoring/src/config/v1.ts —
 * one source, zero drift (DECISIONS D-010). Idempotent via ON CONFLICT.
 */

const SHOT_TYPE_NAMES: Record<string, { name: string; description: string }> = {
  serve: { name: "Serve", description: "Volley and drop serve mechanics." },
  return: { name: "Return", description: "Forehand/backhand return mechanics and recovery." },
  forehand_drive: {
    name: "Forehand Drive",
    description: "Groundstroke mechanics, contact, rotation, paddle path.",
  },
  backhand_drive: { name: "Backhand Drive", description: "One-handed/generalized backhand drive." },
  third_shot_drop: {
    name: "Third-Shot Drop",
    description: "Controlled baseline/transition-zone drop mechanics.",
  },
  dink: { name: "Dink", description: "Crosscourt and straight-ahead dink fundamentals." },
  volley: { name: "Volley", description: "Punch/block/counter mechanics." },
  overhead: { name: "Overhead", description: "Preparation, positioning, contact and recovery." },
};

const CHECKPOINT_NAMES: Record<string, { name: string; description: string }> = {
  ready_position: { name: "Ready Position", description: "Paddle/body readiness before movement." },
  athletic_base: { name: "Athletic Base", description: "Stance, balance, knee/hip positioning." },
  preparation: { name: "Preparation", description: "Unit turn / movement into the stroke." },
  paddle_set: {
    name: "Paddle Set",
    description: "Paddle location/orientation during preparation.",
  },
  swing_length: {
    name: "Swing Length",
    description: "Backswing amplitude appropriate to the shot.",
  },
  sequencing: { name: "Sequencing", description: "Body/paddle coordination and weight transfer." },
  paddle_path: { name: "Paddle Path", description: "Path into and through contact." },
  contact_position: {
    name: "Contact Position",
    description: "Body-relative contact location/height.",
  },
  face_wrist_stability: {
    name: "Face / Wrist Stability",
    description: "Paddle-face and hand stability.",
  },
  follow_through: { name: "Follow-Through", description: "Appropriate continuation/deceleration." },
  recovery: { name: "Recovery", description: "Return to a stable ready/court position." },
};

/**
 * Seeded feature flags: [key, description, enabled, rollout_percent].
 * Every key must also be declared in the API's versioned flag registry
 * (services/api/src/modules/flags/registry.ts), which carries the schema
 * version, safe default, review-by date, and kill-switch designation — a
 * sync test in services/api keeps the two lists identical.
 */
export const SEEDED_FEATURE_FLAGS: ReadonlyArray<readonly [string, string, boolean, number]> = [
  ["live_court", "Live Court mode", true, 100],
  ["ball_tracking", "Ball tracking metrics", false, 0],
  ["cloud_deep_analysis", "Cloud deep analysis", false, 0],
  ["reference_comparison", "Pro reference comparison", false, 0],
  ["social", "Friends and activity", true, 100],
  ["leaderboards", "Friends leaderboards", true, 100],
  ["experimental_camera_setup", "Experimental camera preflight", false, 0],
  ["paywall_v1", "Launch paywall", true, 100],
  ["stroke_return", "Return stroke analysis", false, 0],
  ["stroke_backhand_drive", "Backhand drive analysis", false, 0],
  ["stroke_volley", "Volley analysis", false, 0],
  ["stroke_overhead", "Overhead analysis", false, 0],
  ["auto_detect", "New AUTO DETECT stroke resolution", true, 100],
  ["contact_model", "Contact-moment model", true, 100],
  ["scoring_engine", "Stroke scoring", true, 100],
  ["drill_ranker", "Training-plan drill ranker", true, 100],
  ["session_processing", "Server-side session finalize/summary", true, 100],
  ["stroke_detector", "Temporal stroke detector", true, 100],
];

export async function seed(pool: Pool, log: (line: string) => void = () => {}): Promise<void> {
  // Shot types
  for (let i = 0; i < SHOT_TYPES.length; i++) {
    const slug = SHOT_TYPES[i];
    if (!slug) continue;
    const meta = SHOT_TYPE_NAMES[slug];
    await pool.query(
      `INSERT INTO shot_type (slug, name, description, display_order, enabled)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
         description = EXCLUDED.description, display_order = EXCLUDED.display_order`,
      [slug, meta?.name ?? slug, meta?.description ?? "", i, true],
    );
  }
  log("seeded shot_type");

  // Checkpoint definitions
  for (let i = 0; i < CHECKPOINTS.length; i++) {
    const slug = CHECKPOINTS[i];
    if (!slug) continue;
    const meta = CHECKPOINT_NAMES[slug];
    await pool.query(
      `INSERT INTO checkpoint_definition (slug, name, description, display_order)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name,
         description = EXCLUDED.description, display_order = EXCLUDED.display_order`,
      [slug, meta?.name ?? slug, meta?.description ?? "", i],
    );
  }
  log("seeded checkpoint_definition");

  // Scoring hypotheses per shot — generated from @pickle/scoring config v1.
  // They stay validating until an administrator binds a reviewed dataset,
  // evaluation, coach approval, and active hashed model bundle.
  for (const config of getAllShotScoringConfigs()) {
    const { rows: shotRows } = await pool.query<{ id: string }>(
      "SELECT id FROM shot_type WHERE slug = $1",
      [config.shotType],
    );
    const shotTypeId = shotRows[0]?.id;
    if (!shotTypeId) throw new Error(`shot_type missing: ${config.shotType}`);

    // Never rewrite the configuration of a released (or retired) model:
    // seeds refresh hypotheses only while a version is still pre-release.
    const { rows: modelRows } = await pool.query<{ id: string }>(
      `INSERT INTO scoring_model (shot_type_id, version, status, min_analysis_confidence,
         lower_confidence_threshold, config)
       VALUES ($1, $2, 'validating', $3, $4, $5)
       ON CONFLICT (shot_type_id, version) DO UPDATE SET config = EXCLUDED.config
       WHERE scoring_model.status IN ('draft', 'validating')
       RETURNING id`,
      [
        shotTypeId,
        config.scoringModelVersion,
        config.minAnalysisConfidence,
        config.lowerConfidenceThreshold,
        JSON.stringify({
          shotConfigVersion: config.shotConfigVersion,
          dependencies: config.dependencies,
          note: "Starting hypothesis for expert validation (spec p. 32); recalibrate with coach panel before launch.",
        }),
      ],
    );
    let scoringModelId = modelRows[0]?.id;
    if (!scoringModelId) {
      // The version exists but is released or retired: leave its config,
      // checkpoints, and targets exactly as the release evidence recorded them.
      const { rows: existing } = await pool.query<{ id: string; status: string }>(
        "SELECT id, status FROM scoring_model WHERE shot_type_id = $1 AND version = $2",
        [shotTypeId, config.scoringModelVersion],
      );
      const model = existing[0];
      if (!model) throw new Error("scoring_model upsert returned no id");
      if (model.status !== "draft" && model.status !== "validating") {
        log(`skipped ${config.shotType} ${config.scoringModelVersion} (status ${model.status})`);
        continue;
      }
      scoringModelId = model.id;
    }

    for (let order = 0; order < config.checkpoints.length; order++) {
      const cp = config.checkpoints[order];
      if (!cp) continue;
      const { rows: cpRows } = await pool.query<{ id: string }>(
        "SELECT id FROM checkpoint_definition WHERE slug = $1",
        [cp.key],
      );
      const checkpointId = cpRows[0]?.id;
      if (!checkpointId) throw new Error(`checkpoint_definition missing: ${cp.key}`);

      await pool.query(
        `INSERT INTO scoring_model_checkpoint (scoring_model_id, checkpoint_definition_id,
           display_order, weight, applicable, coach_priority, changeability)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (scoring_model_id, checkpoint_definition_id) DO UPDATE SET
           weight = EXCLUDED.weight, applicable = EXCLUDED.applicable,
           coach_priority = EXCLUDED.coach_priority, changeability = EXCLUDED.changeability`,
        [
          scoringModelId,
          checkpointId,
          order,
          cp.weight,
          cp.metrics.length > 0,
          cp.coachPriority,
          cp.changeability,
        ],
      );

      for (const metric of cp.metrics) {
        await pool.query(
          `INSERT INTO scoring_target (scoring_model_id, checkpoint_definition_id, metric_key,
             target_kind, lower_bound, upper_bound, sigma, metric_weight,
             direction_below, direction_above)
           VALUES ($1, $2, $3, 'interval', $4, $5, $6, $7, $8, $9)
           ON CONFLICT (scoring_model_id, checkpoint_definition_id, metric_key) DO UPDATE SET
             lower_bound = EXCLUDED.lower_bound, upper_bound = EXCLUDED.upper_bound,
             sigma = EXCLUDED.sigma, metric_weight = EXCLUDED.metric_weight,
             direction_below = EXCLUDED.direction_below, direction_above = EXCLUDED.direction_above`,
          [
            scoringModelId,
            checkpointId,
            metric.metricKey,
            metric.lower,
            metric.upper,
            metric.sigma,
            metric.importance,
            metric.directionBelow,
            metric.directionAbove,
          ],
        );
      }
    }
  }
  log("seeded validating scoring hypotheses + checkpoints + targets (sm-v1)");

  // Retire placeholder catalog entries created by pre-production builds.
  // They remain inactive only where historical foreign keys require them.
  await pool.query(`UPDATE drill SET active = false WHERE is_dev_fixture = true`);
  log("retired legacy fixture drills");

  // Billing offerings — remote-configurable pricing (spec p. 55).
  const offerings: Array<[string, string, string, number | null, string | null, number, number]> = [
    [
      "premium_monthly_499",
      "Premium Monthly",
      "Server-verified monthly membership. Product capabilities appear only after their release gates pass.",
      499,
      "monthly",
      0,
      1,
    ],
    [
      "premium_annual_3999",
      "Premium Annual",
      "Server-verified annual membership. Product capabilities appear only after their release gates pass.",
      3999,
      "annual",
      7,
      2,
    ],
  ];
  await pool.query(
    `UPDATE billing_offering SET active = false
     WHERE product_key NOT IN ('premium_monthly_499', 'premium_annual_3999')`,
  );
  for (const [key, name, desc, cents, period, trial, order] of offerings) {
    await pool.query(
      `INSERT INTO billing_offering (product_key, display_name, description, price_usd_cents, period, trial_days, features, display_order, platform_product_ids)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (product_key) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         price_usd_cents = EXCLUDED.price_usd_cents,
         period = EXCLUDED.period,
         trial_days = EXCLUDED.trial_days,
         features = EXCLUDED.features,
         display_order = EXCLUDED.display_order,
         platform_product_ids = EXCLUDED.platform_product_ids,
         active = true`,
      [
        key,
        name,
        desc,
        cents,
        period,
        trial,
        // Keep the offering record structurally complete without advertising
        // capabilities that do not yet have released models/content. Release
        // gates, not a seed-time feature list, determine product availability.
        JSON.stringify([]),
        order,
        JSON.stringify({ apple: `com.picklesensei.${key}`, google: `${key}` }),
      ],
    );
  }
  log("seeded billing offerings");

  // Feature flags (directive §36).
  for (const [key, description, enabled, rollout] of SEEDED_FEATURE_FLAGS) {
    await pool.query(
      `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
       VALUES ($1,$2,$3,$4) ON CONFLICT (key) DO NOTHING`,
      [key, description, enabled, rollout],
    );
  }
  log("seeded feature flags");

  // Achievements (spec p. 7).
  const achievements: Array<[string, string, string, number]> = [
    ["first_analysis", "First Analysis", "Analyzed your first stroke.", 10],
    ["first_8", "First 8", "Scored an 8.0 or better.", 25],
    ["first_9", "First 9", "Scored a 9.0 or better.", 50],
    ["hundred_dinks", "100 Dinks", "One hundred dinks analyzed.", 25],
    ["thousand_shots", "1,000 Shots", "One thousand strokes analyzed.", 100],
    ["streak_7", "7-Day Streak", "Practiced seven days in a row.", 30],
    ["streak_30", "30-Day Streak", "Practiced thirty days in a row.", 100],
  ];
  for (const [slug, name, description, points] of achievements) {
    await pool.query(
      `INSERT INTO achievement (slug, name, description, points) VALUES ($1,$2,$3,$4)
       ON CONFLICT (slug) DO NOTHING`,
      [slug, name, description, points],
    );
  }
  log("seeded achievements");
}
