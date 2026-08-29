import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DrillCompletionCreateRequest,
  TrainingPlanCreateRequest,
  TrainingPlanReassessmentRequest,
  TrainingPlanResponse,
} from "@pickle/api-contracts";
import { CHECKPOINTS, FAULT_DIRECTIONS, SHOT_TYPES } from "@pickle/shared-types";
import type { AppContext } from "../../context.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";
import { sendFailure } from "../../lib/replies.js";
import {
  TRAINING_PLAN_ALGORITHM_VERSION,
  externalEmbedUrl,
  meetsCompletionTarget,
  selectPlanPrescriptions,
  validateExternalVideoSource,
  type CompletionTarget,
  type ExternalVideoProvider,
  type PrescriptionCandidate,
} from "./logic.js";

interface PlanCandidateRow extends Record<string, unknown> {
  drill_id: string;
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: unknown;
  difficulty_min: string | null;
  difficulty_max: string | null;
  plan_role: "warmup" | "targeted";
  fault_directions: string[];
  priority: string | number;
  cue_text: string;
  target_sets: number;
  target_repetitions_per_set: number | null;
  target_duration_seconds: number | null;
  rest_seconds: number | null;
  coach_approval_reference: string;
}

interface SourceShotRow extends Record<string, unknown> {
  id: string;
  shot_type_id: string;
  shot_type_slug: (typeof SHOT_TYPES)[number];
  top_fault_checkpoint_id: string;
  checkpoint_slug: (typeof CHECKPOINTS)[number];
  scoring_model_id: string;
  overall_score: string | number;
  checkpoint_score: string | number | null;
  direction: (typeof FAULT_DIRECTIONS)[number];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

async function sendTrainingFailure(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof TrainingRouteError) {
    return sendFailure(reply, request, error.status, "permanent", error.code, error.message);
  }
  throw error;
}

class TrainingRouteError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function trainingPlanView(context: AppContext, userId: string, planId: string) {
  const plan = await one<Record<string, unknown>>(
    context.pool!,
    `SELECT tp.id, tp.status, tp.algorithm_version, tp.source_shot_id,
            st.slug AS shot_type, cd.slug AS priority_checkpoint,
            tp.priority_direction, tp.baseline_score, tp.baseline_checkpoint_score,
            tp.reassessment_shot_id, tp.score_delta, tp.created_at, tp.completed_at
     FROM training_plan tp
     JOIN shot_type st ON st.id = tp.shot_type_id
     JOIN checkpoint_definition cd ON cd.id = tp.priority_checkpoint_id
     WHERE tp.id = $1 AND tp.user_id = $2`,
    [planId, userId],
  );
  if (!plan) return null;

  const rows = await many<Record<string, unknown>>(
    context.pool!,
    `SELECT tpi.id, tpi.position, tpi.item_kind, tpi.cue_text,
            tpi.target_sets, tpi.target_repetitions_per_set,
            tpi.target_duration_seconds, tpi.rest_seconds,
            tpi.prescription_snapshot, d.slug,
            EXISTS (
              SELECT 1 FROM user_saved_drill usd
              WHERE usd.user_id = $2 AND usd.drill_id = tpi.drill_id
            ) AS saved,
            completion.id AS completion_id,
            completion.completed_at AS completion_at,
            completion.actual_repetitions,
            completion.actual_duration_seconds,
            completion.qualifies_for_streak
     FROM training_plan_item tpi
     LEFT JOIN drill d ON d.id = tpi.drill_id
     LEFT JOIN LATERAL (
       SELECT dc.id, dc.completed_at, dc.actual_repetitions,
              dc.actual_duration_seconds, dc.qualifies_for_streak
       FROM drill_completion dc
       WHERE dc.training_plan_item_id = tpi.id AND dc.user_id = $2
       ORDER BY dc.qualifies_for_streak DESC, dc.completed_at DESC LIMIT 1
     ) completion ON true
     WHERE tpi.training_plan_id = $1
     ORDER BY tpi.position`,
    [planId, userId],
  );

  const items = rows.map((row) => {
    const snapshot = (row["prescription_snapshot"] ?? {}) as Record<string, unknown>;
    const isReassessment = row["item_kind"] === "reassessment";
    return {
      id: row["id"],
      position: Number(row["position"]),
      kind: row["item_kind"],
      drill: isReassessment
        ? null
        : {
            slug: row["slug"],
            title: snapshot["title"],
            description: snapshot["description"],
            coachName: snapshot["coachName"],
            equipment: Array.isArray(snapshot["equipment"]) ? snapshot["equipment"] : [],
            saved: Boolean(row["saved"]),
          },
      cueText: (row["cue_text"] as string | null) ?? null,
      targetSets: row["target_sets"] === null ? null : Number(row["target_sets"]),
      targetRepetitionsPerSet:
        row["target_repetitions_per_set"] === null
          ? null
          : Number(row["target_repetitions_per_set"]),
      targetDurationSeconds:
        row["target_duration_seconds"] === null ? null : Number(row["target_duration_seconds"]),
      restSeconds: row["rest_seconds"] === null ? null : Number(row["rest_seconds"]),
      completion: row["completion_id"]
        ? {
            id: row["completion_id"],
            completedAt: iso(row["completion_at"]),
            actualRepetitions:
              row["actual_repetitions"] === null ? null : Number(row["actual_repetitions"]),
            actualDurationSeconds:
              row["actual_duration_seconds"] === null
                ? null
                : Number(row["actual_duration_seconds"]),
            qualifiesForStreak: Boolean(row["qualifies_for_streak"]),
          }
        : null,
    };
  });

  return TrainingPlanResponse.parse({
    plan: {
      id: plan["id"],
      status: plan["status"],
      algorithmVersion: plan["algorithm_version"],
      sourceShotId: plan["source_shot_id"],
      shotType: plan["shot_type"],
      priorityCheckpoint: plan["priority_checkpoint"],
      priorityDirection: plan["priority_direction"],
      baselineScore: Number(plan["baseline_score"]),
      baselineCheckpointScore:
        plan["baseline_checkpoint_score"] === null
          ? null
          : Number(plan["baseline_checkpoint_score"]),
      reassessmentShotId: (plan["reassessment_shot_id"] as string | null) ?? null,
      scoreDelta: plan["score_delta"] === null ? null : Number(plan["score_delta"]),
      createdAt: iso(plan["created_at"]),
      completedAt: iso(plan["completed_at"]),
      items,
    },
  }).plan;
}

async function createTrainingPlan(context: AppContext, userId: string, sourceShotId: string) {
  const planId = await withTransaction(context.pool!, async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [userId]);
    const existing = await one<{ id: string }>(
      tx,
      `SELECT id FROM training_plan
       WHERE user_id = $1 AND source_shot_id = $2 AND algorithm_version = $3`,
      [userId, sourceShotId, TRAINING_PLAN_ALGORITHM_VERSION],
    );
    if (existing) return existing.id;

    const shot = await one<SourceShotRow>(
      tx,
      `SELECT s.id, s.shot_type_id, st.slug AS shot_type_slug,
              s.top_fault_checkpoint_id, cd.slug AS checkpoint_slug,
              s.scoring_model_id, s.overall_score,
              scs.score_0_100 AS checkpoint_score, scs.direction
       FROM shot s
       JOIN shot_type st ON st.id = s.shot_type_id
       JOIN checkpoint_definition cd ON cd.id = s.top_fault_checkpoint_id
       JOIN shot_checkpoint_score scs
         ON scs.shot_id = s.id AND scs.checkpoint_definition_id = s.top_fault_checkpoint_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.source = 'real'
         AND s.result_kind = 'scored' AND s.overall_score IS NOT NULL
         AND s.scoring_model_id IS NOT NULL`,
      [sourceShotId, userId],
    );
    if (!shot) {
      throw new TrainingRouteError(
        404,
        "training.source_shot_not_found",
        "A real scored source shot with a priority checkpoint is required.",
      );
    }

    const profile = await one<{ skill_level: string | null }>(
      tx,
      "SELECT skill_level FROM user_profile WHERE user_id = $1",
      [userId],
    );
    const candidates = await many<PlanCandidateRow>(
      tx,
      `SELECT d.id AS drill_id, d.slug, d.title, d.description, d.coach_name,
              d.equipment, d.difficulty_min, d.difficulty_max,
              m.plan_role, m.fault_directions, m.priority, m.cue_text,
              m.target_sets, m.target_repetitions_per_set,
              m.target_duration_seconds, m.rest_seconds,
              m.coach_approval_reference
       FROM drill_checkpoint_map m
       JOIN drill d ON d.id = m.drill_id
       WHERE m.shot_type_id = $1 AND m.checkpoint_definition_id = $2
         AND d.active AND NOT d.is_dev_fixture
         AND NULLIF(btrim(d.coach_name), '') IS NOT NULL
         AND m.coach_reviewed_at IS NOT NULL
         AND NULLIF(btrim(m.coach_approval_reference), '') IS NOT NULL
         AND NULLIF(btrim(m.cue_text), '') IS NOT NULL
         AND m.target_sets IS NOT NULL
         AND ((m.target_repetitions_per_set IS NOT NULL AND m.target_duration_seconds IS NULL)
           OR (m.target_repetitions_per_set IS NULL AND m.target_duration_seconds IS NOT NULL))`,
      [shot.shot_type_id, shot.top_fault_checkpoint_id],
    );
    const selection = selectPlanPrescriptions(
      candidates.map((row): PrescriptionCandidate => ({
        drillId: row.drill_id,
        slug: row.slug,
        planRole: row.plan_role,
        faultDirections: row.fault_directions,
        priority: Number(row.priority),
        difficultyMin: row.difficulty_min,
        difficultyMax: row.difficulty_max,
      })),
      shot.direction,
      profile?.skill_level ?? null,
    );
    if (!selection) {
      throw new TrainingRouteError(
        409,
        "training.reviewed_catalog_incomplete",
        "This fault does not yet have one reviewed warm-up and two reviewed targeted prescriptions.",
      );
    }

    await tx.query(
      "UPDATE training_plan SET status = 'superseded' WHERE user_id = $1 AND status = 'active'",
      [userId],
    );
    const created = await one<{ id: string }>(
      tx,
      `INSERT INTO training_plan (
         user_id, source_shot_id, shot_type_id, priority_checkpoint_id,
         scoring_model_id, priority_direction, baseline_score,
         baseline_checkpoint_score, algorithm_version
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [
        userId,
        shot.id,
        shot.shot_type_id,
        shot.top_fault_checkpoint_id,
        shot.scoring_model_id,
        shot.direction,
        Number(shot.overall_score),
        shot.checkpoint_score === null ? null : Number(shot.checkpoint_score),
        TRAINING_PLAN_ALGORITHM_VERSION,
      ],
    );
    const rowById = new Map(candidates.map((candidate) => [candidate.drill_id, candidate]));
    for (let index = 0; index < selection.length; index += 1) {
      const selected = selection[index]!;
      const row = rowById.get(selected.drillId)!;
      await tx.query(
        `INSERT INTO training_plan_item (
           training_plan_id, position, item_kind, drill_id, cue_text,
           target_sets, target_repetitions_per_set, target_duration_seconds,
           rest_seconds, prescription_snapshot
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          created!.id,
          index + 1,
          row.plan_role,
          row.drill_id,
          row.cue_text,
          row.target_sets,
          row.target_repetitions_per_set,
          row.target_duration_seconds,
          row.rest_seconds,
          JSON.stringify({
            title: row.title,
            description: row.description,
            coachName: row.coach_name,
            equipment: row.equipment,
            coachApprovalReference: row.coach_approval_reference,
          }),
        ],
      );
    }
    await tx.query(
      `INSERT INTO training_plan_item (training_plan_id, position, item_kind)
       VALUES ($1, 4, 'reassessment')`,
      [created!.id],
    );
    return created!.id;
  });
  return trainingPlanView(context, userId, planId);
}

const PrescriptionPublish = z
  .object({
    shotType: z.enum(SHOT_TYPES),
    checkpoint: z.enum(CHECKPOINTS),
    planRole: z.enum(["warmup", "targeted"]),
    faultDirections: z.array(z.enum(FAULT_DIRECTIONS)).max(12).default([]),
    priority: z.number().min(0).max(10),
    cueText: z.string().min(3).max(240),
    targetSets: z.number().int().min(1).max(20),
    targetRepetitionsPerSet: z.number().int().min(1).max(500).nullable(),
    targetDurationSeconds: z.number().int().min(10).max(7200).nullable(),
    restSeconds: z.number().int().min(0).max(900).nullable(),
    coachApprovalReference: z.string().min(3).max(300),
  })
  .refine(
    (value) => (value.targetRepetitionsPerSet !== null) !== (value.targetDurationSeconds !== null),
    "Provide repetitions or duration, but not both.",
  );

const InstructionalMediaPublish = z.object({
  id: z.uuid(),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("hosted"), mediaAssetId: z.uuid(), sourceUrl: z.url() }),
    z.object({
      kind: z.literal("embed"),
      provider: z.enum(["youtube", "vimeo"]),
      videoId: z.string().min(5).max(32),
      sourceUrl: z.url(),
    }),
  ]),
  creatorName: z.string().min(1).max(120),
  licenseName: z.string().min(1).max(120),
  licenseUrl: z.url().nullable(),
  attribution: z.string().min(1).max(500),
  rightsReviewReference: z.string().min(3).max(300),
  coachReviewReference: z.string().min(3).max(300),
  rightsExpiresAt: z.iso.datetime().nullable(),
  displayOrder: z.number().int().min(0).max(100),
});

export function registerTrainingRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/me/saved-drills", { preHandler: app.authenticate }, async (request) => ({
    items: await many(
      context.pool!,
      `SELECT d.id, d.slug, d.title, d.description, d.coach_name, d.equipment,
              d.difficulty_min, d.difficulty_max, usd.saved_at
       FROM user_saved_drill usd
       JOIN drill d ON d.id = usd.drill_id
       WHERE usd.user_id = $1 AND d.active AND NOT d.is_dev_fixture
       ORDER BY usd.saved_at DESC`,
      [request.user!.id],
    ),
  }));

  app.put("/v1/me/saved-drills/:slug", { preHandler: app.authenticate }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const drill = await one<{ id: string }>(
      context.pool!,
      "SELECT id FROM drill WHERE slug = $1 AND active AND NOT is_dev_fixture",
      [slug],
    );
    if (!drill) {
      return sendFailure(reply, request, 404, "permanent", "drill.not_found", "Drill not found.");
    }
    const saved = await one(
      context.pool!,
      `INSERT INTO user_saved_drill (user_id, drill_id) VALUES ($1,$2)
         ON CONFLICT (user_id, drill_id) DO UPDATE SET saved_at = user_saved_drill.saved_at
         RETURNING saved_at`,
      [request.user!.id, drill.id],
    );
    return { slug, saved: true, savedAt: iso(saved?.["saved_at"]) };
  });

  app.delete(
    "/v1/me/saved-drills/:slug",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      await context.pool!.query(
        `DELETE FROM user_saved_drill usd USING drill d
         WHERE usd.user_id = $1 AND usd.drill_id = d.id AND d.slug = $2`,
        [request.user!.id, slug],
      );
      return reply.status(204).send();
    },
  );

  app.post("/v1/training-plans", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = TrainingPlanCreateRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.training_plan",
        parsed.error.message,
      );
    }
    try {
      return {
        plan: await createTrainingPlan(context, request.user!.id, parsed.data.sourceShotId),
      };
    } catch (error) {
      return sendTrainingFailure(reply, request, error);
    }
  });

  app.get("/v1/training-plans/current", { preHandler: app.authenticate }, async (request) => {
    const current = await one<{ id: string }>(
      context.pool!,
      "SELECT id FROM training_plan WHERE user_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1",
      [request.user!.id],
    );
    return { plan: current ? await trainingPlanView(context, request.user!.id, current.id) : null };
  });

  app.get("/v1/training-plans/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const plan = await trainingPlanView(context, request.user!.id, id);
    if (!plan) {
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "training.plan_not_found",
        "Training plan not found.",
      );
    }
    return { plan };
  });

  app.post("/v1/drill-completions", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = DrillCompletionCreateRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.drill_completion",
        parsed.error.message,
      );
    }
    const body = parsed.data;
    const completedAt = new Date(body.completedAt);
    if (completedAt.getTime() > Date.now() + 5 * 60_000) {
      return sendFailure(
        reply,
        request,
        422,
        "permanent",
        "training.completion_in_future",
        "Completion time cannot be in the future.",
      );
    }
    const drill = await one<{ id: string }>(
      context.pool!,
      "SELECT id FROM drill WHERE slug = $1 AND active AND NOT is_dev_fixture",
      [body.drillSlug],
    );
    if (!drill) {
      return sendFailure(reply, request, 404, "permanent", "drill.not_found", "Drill not found.");
    }

    let targets: CompletionTarget[] = [];
    if (body.trainingPlanItemId) {
      const item = await one<Record<string, unknown>>(
        context.pool!,
        `SELECT tpi.drill_id, tpi.target_sets, tpi.target_repetitions_per_set,
                tpi.target_duration_seconds
         FROM training_plan_item tpi
         JOIN training_plan tp ON tp.id = tpi.training_plan_id
         WHERE tpi.id = $1 AND tp.user_id = $2 AND tpi.drill_id = $3`,
        [body.trainingPlanItemId, request.user!.id, drill.id],
      );
      if (!item) {
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "training.plan_item_not_found",
          "Training-plan item not found for this drill.",
        );
      }
      targets = [
        {
          targetSets: Number(item["target_sets"]),
          targetRepetitionsPerSet:
            item["target_repetitions_per_set"] === null
              ? null
              : Number(item["target_repetitions_per_set"]),
          targetDurationSeconds:
            item["target_duration_seconds"] === null
              ? null
              : Number(item["target_duration_seconds"]),
        },
      ];
    } else {
      const mappedTargets = await many<Record<string, unknown>>(
        context.pool!,
        `SELECT target_sets, target_repetitions_per_set, target_duration_seconds
         FROM drill_checkpoint_map
         WHERE drill_id = $1 AND coach_reviewed_at IS NOT NULL
           AND target_sets IS NOT NULL
           AND ((target_repetitions_per_set IS NOT NULL AND target_duration_seconds IS NULL)
             OR (target_repetitions_per_set IS NULL AND target_duration_seconds IS NOT NULL))`,
        [drill.id],
      );
      targets = mappedTargets.map((target) => ({
        targetSets: Number(target["target_sets"]),
        targetRepetitionsPerSet:
          target["target_repetitions_per_set"] === null
            ? null
            : Number(target["target_repetitions_per_set"]),
        targetDurationSeconds:
          target["target_duration_seconds"] === null
            ? null
            : Number(target["target_duration_seconds"]),
      }));
    }

    let evidenceKind: "user_confirmed" | "session_linked" = "user_confirmed";
    if (body.practiceSessionId) {
      const session = await one(
        context.pool!,
        `SELECT id FROM practice_session
         WHERE id = $1 AND user_id = $2 AND completed`,
        [body.practiceSessionId, request.user!.id],
      );
      if (!session) {
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "training.completed_session_not_found",
          "A completed owned session is required for session-linked evidence.",
        );
      }
      evidenceKind = "session_linked";
    }
    const actualRepetitions = body.actualRepetitions ?? null;
    const actualDurationSeconds = body.actualDurationSeconds ?? null;
    const qualifies = targets.some((target) =>
      meetsCompletionTarget(target, actualRepetitions, actualDurationSeconds),
    );
    await context.pool!.query(
      `INSERT INTO drill_completion (
         id, user_id, drill_id, training_plan_item_id, practice_session_id,
         completed_at, actual_repetitions, actual_duration_seconds,
         evidence_kind, qualifies_for_streak
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [
        body.id,
        request.user!.id,
        drill.id,
        body.trainingPlanItemId ?? null,
        body.practiceSessionId ?? null,
        body.completedAt,
        actualRepetitions,
        actualDurationSeconds,
        evidenceKind,
        qualifies,
      ],
    );
    const completion = await one<Record<string, unknown>>(
      context.pool!,
      `SELECT id, completed_at, actual_repetitions, actual_duration_seconds,
              evidence_kind, qualifies_for_streak
       FROM drill_completion WHERE id = $1 AND user_id = $2`,
      [body.id, request.user!.id],
    );
    if (!completion) {
      return sendFailure(
        reply,
        request,
        409,
        "permanent",
        "training.completion_id_conflict",
        "Completion id belongs to another account.",
      );
    }
    return {
      completion: {
        id: completion["id"],
        completedAt: iso(completion["completed_at"]),
        actualRepetitions: completion["actual_repetitions"],
        actualDurationSeconds: completion["actual_duration_seconds"],
        evidenceKind: completion["evidence_kind"],
        qualifiesForStreak: completion["qualifies_for_streak"],
      },
    };
  });

  app.get("/v1/me/drill-completions", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(50) })
      .safeParse(request.query);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.drill_completions",
        parsed.error.message,
      );
    }
    return {
      items: await many(
        context.pool!,
        `SELECT dc.id, d.slug AS drill_slug, d.title, dc.training_plan_item_id,
                dc.practice_session_id, dc.completed_at, dc.actual_repetitions,
                dc.actual_duration_seconds, dc.evidence_kind, dc.qualifies_for_streak
         FROM drill_completion dc JOIN drill d ON d.id = dc.drill_id
         WHERE dc.user_id = $1 ORDER BY dc.completed_at DESC LIMIT $2`,
        [request.user!.id, parsed.data.limit],
      ),
      cursor: null,
    };
  });

  app.post(
    "/v1/training-plans/:id/reassessment",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = TrainingPlanReassessmentRequest.safeParse(request.body);
      if (!parsed.success) {
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.training_reassessment",
          parsed.error.message,
        );
      }
      try {
        await withTransaction(context.pool!, async (tx) => {
          const plan = await one<Record<string, unknown>>(
            tx,
            `SELECT id, shot_type_id, scoring_model_id, baseline_score, created_at, status
             FROM training_plan WHERE id = $1 AND user_id = $2 FOR UPDATE`,
            [id, request.user!.id],
          );
          if (!plan) {
            throw new TrainingRouteError(
              404,
              "training.plan_not_found",
              "Training plan not found.",
            );
          }
          if (plan["status"] !== "active") {
            throw new TrainingRouteError(
              409,
              "training.plan_not_active",
              "Only the active training plan can be reassessed.",
            );
          }
          const completionCount = await one<{ completed: string }>(
            tx,
            `SELECT count(*)::text AS completed
             FROM training_plan_item tpi
             WHERE tpi.training_plan_id = $1 AND tpi.item_kind <> 'reassessment'
               AND EXISTS (
                 SELECT 1 FROM drill_completion dc
                 WHERE dc.training_plan_item_id = tpi.id AND dc.user_id = $2
                   AND dc.qualifies_for_streak
               )`,
            [id, request.user!.id],
          );
          if (Number(completionCount?.completed ?? 0) !== 3) {
            throw new TrainingRouteError(
              409,
              "training.prescriptions_incomplete",
              "Complete all three prescribed drills before reassessment.",
            );
          }
          const reassessment = await one<Record<string, unknown>>(
            tx,
            `SELECT id, shot_type_id, scoring_model_id, overall_score, captured_at
             FROM shot WHERE id = $1 AND user_id = $2 AND source = 'real'
               AND result_kind = 'scored' AND overall_score IS NOT NULL
               AND shot_type_id = $3 AND captured_at > $4
               AND captured_at <= now() + interval '5 minutes'`,
            [parsed.data.shotId, request.user!.id, plan["shot_type_id"], plan["created_at"]],
          );
          if (!reassessment) {
            throw new TrainingRouteError(
              422,
              "training.invalid_reassessment",
              "Reassessment must be a newer real scored shot of the same stroke.",
            );
          }
          const scoreDelta =
            reassessment["scoring_model_id"] === plan["scoring_model_id"]
              ? Math.round(
                  (Number(reassessment["overall_score"]) - Number(plan["baseline_score"])) * 100,
                ) / 100
              : null;
          await tx.query(
            `UPDATE training_plan SET status = 'completed', reassessment_shot_id = $3,
               score_delta = $4, completed_at = now()
             WHERE id = $1 AND user_id = $2`,
            [id, request.user!.id, parsed.data.shotId, scoreDelta],
          );
        });
        return { plan: await trainingPlanView(context, request.user!.id, id) };
      } catch (error) {
        return sendTrainingFailure(reply, request, error);
      }
    },
  );

  app.put(
    "/v1/admin/training/drills/:slug/prescription",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = PrescriptionPublish.safeParse(request.body);
      if (!parsed.success) {
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.training_prescription",
          parsed.error.message,
        );
      }
      const body = parsed.data;
      const drill = await one<{ id: string; coach_name: string | null }>(
        context.pool!,
        "SELECT id, coach_name FROM drill WHERE slug = $1 AND active AND NOT is_dev_fixture",
        [slug],
      );
      if (!drill) {
        return sendFailure(reply, request, 404, "permanent", "drill.not_found", "Drill not found.");
      }
      if (!drill.coach_name?.trim()) {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "training.coach_attribution_required",
          "A named coach is required before publishing a prescription.",
        );
      }
      const updated = await one(
        context.pool!,
        `INSERT INTO drill_checkpoint_map (
           drill_id, checkpoint_definition_id, shot_type_id, priority,
           plan_role, fault_directions, cue_text, target_sets,
           target_repetitions_per_set, target_duration_seconds, rest_seconds,
           coach_reviewed_by, coach_reviewed_at, coach_approval_reference
         )
         SELECT $1, cd.id, st.id, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13
         FROM checkpoint_definition cd, shot_type st
         WHERE cd.slug = $2 AND st.slug = $3 AND st.enabled
         ON CONFLICT (drill_id, checkpoint_definition_id, shot_type_id)
         DO UPDATE SET priority = EXCLUDED.priority, plan_role = EXCLUDED.plan_role,
           fault_directions = EXCLUDED.fault_directions, cue_text = EXCLUDED.cue_text,
           target_sets = EXCLUDED.target_sets,
           target_repetitions_per_set = EXCLUDED.target_repetitions_per_set,
           target_duration_seconds = EXCLUDED.target_duration_seconds,
           rest_seconds = EXCLUDED.rest_seconds,
           coach_reviewed_by = EXCLUDED.coach_reviewed_by,
           coach_reviewed_at = EXCLUDED.coach_reviewed_at,
           coach_approval_reference = EXCLUDED.coach_approval_reference
         RETURNING drill_id`,
        [
          drill.id,
          body.checkpoint,
          body.shotType,
          body.priority,
          body.planRole,
          body.faultDirections,
          body.cueText,
          body.targetSets,
          body.targetRepetitionsPerSet,
          body.targetDurationSeconds,
          body.restSeconds,
          request.user!.id,
          body.coachApprovalReference,
        ],
      );
      if (!updated) {
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "training.catalog_reference_not_found",
          "Shot type or checkpoint not found.",
        );
      }
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "training.prescription_published",
        targetKind: "drill",
        targetId: drill.id,
        requestId: request.id,
        metadata: { shotType: body.shotType, checkpoint: body.checkpoint },
      });
      return { published: true };
    },
  );

  app.post(
    "/v1/admin/training/drills/:slug/instructional-media",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const parsed = InstructionalMediaPublish.safeParse(request.body);
      if (!parsed.success) {
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.instructional_media",
          parsed.error.message,
        );
      }
      const body = parsed.data;
      const drill = await one<{ id: string }>(
        context.pool!,
        "SELECT id FROM drill WHERE slug = $1 AND active AND NOT is_dev_fixture",
        [slug],
      );
      if (!drill) {
        return sendFailure(reply, request, 404, "permanent", "drill.not_found", "Drill not found.");
      }
      if (body.rightsExpiresAt && new Date(body.rightsExpiresAt).getTime() <= Date.now()) {
        return sendFailure(
          reply,
          request,
          422,
          "permanent",
          "training.media_rights_expired",
          "Instructional media rights are already expired.",
        );
      }
      let mediaAssetId: string | null = null;
      let provider: ExternalVideoProvider | null = null;
      let videoId: string | null = null;
      let embedApproved = false;
      if (body.source.kind === "hosted") {
        const asset = await one(
          context.pool!,
          `SELECT id FROM media_asset WHERE id = $1 AND status = 'ready'
             AND deleted_at IS NULL AND kind IN ('drill_video','reference_video')`,
          [body.source.mediaAssetId],
        );
        if (!asset) {
          return sendFailure(
            reply,
            request,
            409,
            "permanent",
            "training.media_asset_not_ready",
            "A ready instructional media asset is required.",
          );
        }
        mediaAssetId = body.source.mediaAssetId;
      } else {
        provider = body.source.provider;
        videoId = body.source.videoId;
        if (
          !validateExternalVideoSource(provider, body.source.sourceUrl) ||
          !externalEmbedUrl(provider, videoId)
        ) {
          return sendFailure(
            reply,
            request,
            422,
            "permanent",
            "training.invalid_embed_source",
            "Provider, source URL, and external video id do not match an approved embed host.",
          );
        }
        embedApproved = true;
      }
      const inserted = await context.pool!.query(
        `INSERT INTO drill_instructional_media (
           id, drill_id, media_asset_id, external_provider, external_video_id,
           source_url, creator_name, license_name, license_url, attribution,
           rights_status, rights_reviewed_by, rights_reviewed_at, rights_review_reference,
           rights_expires_at, coach_status, coach_reviewed_by, coach_reviewed_at,
           coach_review_reference, embed_approved_at, active, display_order
         ) VALUES (
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
           'approved',$11,now(),$12,$13,'approved',$11,now(),$14,
           CASE WHEN $15 THEN now() ELSE NULL END,true,$16
         ) ON CONFLICT (id) DO NOTHING`,
        [
          body.id,
          drill.id,
          mediaAssetId,
          provider,
          videoId,
          body.source.sourceUrl,
          body.creatorName,
          body.licenseName,
          body.licenseUrl,
          body.attribution,
          request.user!.id,
          body.rightsReviewReference,
          body.rightsExpiresAt,
          body.coachReviewReference,
          embedApproved,
          body.displayOrder,
        ],
      );
      if (inserted.rowCount === 0) {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "training.media_id_conflict",
          "Instructional media id already exists.",
        );
      }
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "training.instructional_media_published",
        targetKind: "instructional_media",
        targetId: body.id,
        requestId: request.id,
        metadata: { drillId: drill.id, provider: provider ?? "hosted" },
      });
      return { instructionalMediaId: body.id, published: true };
    },
  );
}
