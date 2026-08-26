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

/** Drill seeds — real coaching content pending; clearly marked dev fixtures. */
const DEV_DRILLS: Array<{
  slug: string;
  title: string;
  description: string;
  checkpoint: string;
  shotTypes: string[];
}> = [
  {
    slug: "dev-contact-out-front",
    title: "Contact Out Front (dev fixture)",
    description:
      "DEV FIXTURE — placeholder pending coach-authored content. Shadow reps freezing contact ahead of the front hip.",
    checkpoint: "contact_position",
    shotTypes: ["forehand_drive", "dink", "third_shot_drop", "serve"],
  },
  {
    slug: "dev-compact-backswing",
    title: "Compact Backswing Wall Drill (dev fixture)",
    description:
      "DEV FIXTURE — placeholder pending coach-authored content. Wall proximity limits backswing length.",
    checkpoint: "swing_length",
    shotTypes: ["dink", "third_shot_drop"],
  },
  {
    slug: "dev-unit-turn",
    title: "Unit Turn Shadow Reps (dev fixture)",
    description:
      "DEV FIXTURE — placeholder pending coach-authored content. Shoulder-led preparation without a ball.",
    checkpoint: "preparation",
    shotTypes: ["forehand_drive", "serve"],
  },
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

  // Scoring model v1 per shot — generated from @pickle/scoring config v1.
  for (const config of getAllShotScoringConfigs()) {
    const { rows: shotRows } = await pool.query<{ id: string }>(
      "SELECT id FROM shot_type WHERE slug = $1",
      [config.shotType],
    );
    const shotTypeId = shotRows[0]?.id;
    if (!shotTypeId) throw new Error(`shot_type missing: ${config.shotType}`);

    const { rows: modelRows } = await pool.query<{ id: string }>(
      `INSERT INTO scoring_model (shot_type_id, version, status, min_analysis_confidence,
         lower_confidence_threshold, config, active_from)
       VALUES ($1, $2, 'active', $3, $4, $5, now())
       ON CONFLICT (shot_type_id, version) DO UPDATE SET config = EXCLUDED.config
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
    const scoringModelId = modelRows[0]?.id;
    if (!scoringModelId) throw new Error("scoring_model upsert returned no id");

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
  log("seeded scoring_model + checkpoints + targets (sm-v1)");

  // Dev fixture drills
  for (const d of DEV_DRILLS) {
    const { rows: drillRows } = await pool.query<{ id: string }>(
      `INSERT INTO drill (slug, title, description, is_dev_fixture, active)
       VALUES ($1, $2, $3, true, true)
       ON CONFLICT (slug) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description
       RETURNING id`,
      [d.slug, d.title, d.description],
    );
    const drillId = drillRows[0]?.id;
    if (!drillId) continue;
    for (const shotSlug of d.shotTypes) {
      await pool.query(
        `INSERT INTO drill_checkpoint_map (drill_id, checkpoint_definition_id, shot_type_id, priority)
         SELECT $1, cd.id, st.id, 1
         FROM checkpoint_definition cd, shot_type st
         WHERE cd.slug = $2 AND st.slug = $3
         ON CONFLICT DO NOTHING`,
        [drillId, d.checkpoint, shotSlug],
      );
    }
  }
  log("seeded dev fixture drills");
}
