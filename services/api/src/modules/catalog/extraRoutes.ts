import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one } from "../../lib/db.js";

/** Drills, model bundles, references, goals, share cards, achievements. */

export function registerCatalogExtraRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/catalog/drills", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = z
      .object({
        shotType: z.string().optional(),
        checkpoint: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .safeParse(request.query);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.drills",
        parsed.error.message,
      );
    const q = parsed.data;
    const items = await many(
      context.pool!,
      `SELECT DISTINCT d.id, d.slug, d.title, d.description, d.coach_name, d.difficulty_min, d.difficulty_max, d.is_dev_fixture
       FROM drill d
       LEFT JOIN drill_checkpoint_map m ON m.drill_id = d.id
       LEFT JOIN shot_type st ON st.id = m.shot_type_id
       LEFT JOIN checkpoint_definition cd ON cd.id = m.checkpoint_definition_id
       WHERE d.active
         AND ($1::text IS NULL OR st.slug = $1)
         AND ($2::text IS NULL OR cd.slug = $2)
       ORDER BY d.title LIMIT $3`,
      [q.shotType ?? null, q.checkpoint ?? null, q.limit],
    );
    return { items, cursor: null };
  });

  app.get("/v1/catalog/drills/:slug", { preHandler: app.authenticate }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const drill = await one(
      context.pool!,
      "SELECT id, slug, title, description, coach_name, equipment, difficulty_min, difficulty_max, is_dev_fixture FROM drill WHERE slug = $1 AND active",
      [slug],
    );
    if (!drill)
      return sendFailure(reply, request, 404, "permanent", "drill.not_found", "Drill not found.");
    const mappings = await many(
      context.pool!,
      `SELECT cd.slug AS checkpoint, st.slug AS shot_type, m.priority
       FROM drill_checkpoint_map m
       JOIN checkpoint_definition cd ON cd.id = m.checkpoint_definition_id
       JOIN shot_type st ON st.id = m.shot_type_id
       WHERE m.drill_id = $1`,
      [drill["id"] as string],
    );
    return { drill, mappings, mediaPlayback: null };
  });

  // Latest compatible signed model bundle for this device (spec p. 18).
  app.get("/v1/catalog/model-bundle", { preHandler: app.authenticate }, async (request, reply) => {
    const bundle = await one(
      context.pool!,
      `SELECT version, manifest_sha256, status, rollout_percent, metadata
       FROM model_bundle WHERE status IN ('active','canary')
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      [],
    );
    if (!bundle) {
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "model_bundle.none",
        "No model bundle published yet. On-device analysis unavailable until a bundle ships.",
      );
    }
    return { bundle };
  });

  app.get("/v1/references", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = z
      .object({ shotType: z.string().optional(), handedness: z.string().optional() })
      .safeParse(request.query);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.references",
        parsed.error.message,
      );
    const items = await many(
      context.pool!,
      `SELECT pr.id, pr.athlete_name, st.slug AS shot_type, pr.license, pr.metadata
       FROM pro_reference pr JOIN shot_type st ON st.id = pr.shot_type_id
       WHERE pr.active AND ($1::text IS NULL OR st.slug = $1)`,
      [parsed.data.shotType ?? null],
    );
    return { items };
  });

  // Goals CRUD (spec pp. 17–18).
  const GoalCreate = z.object({
    shotType: z.string().nullable(),
    checkpoint: z.string().nullable(),
    goalType: z.string().max(40),
    title: z.string().max(120),
  });
  app.post("/v1/me/goals", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = GoalCreate.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(reply, request, 400, "permanent", "validation.goal", parsed.error.message);
    const b = parsed.data;
    const st = b.shotType
      ? await one<{ id: string }>(context.pool!, "SELECT id FROM shot_type WHERE slug = $1", [
          b.shotType,
        ])
      : null;
    const cd = b.checkpoint
      ? await one<{ id: string }>(
          context.pool!,
          "SELECT id FROM checkpoint_definition WHERE slug = $1",
          [b.checkpoint],
        )
      : null;
    const goal = await one(
      context.pool!,
      `INSERT INTO user_goal (user_id, shot_type_id, checkpoint_id, goal_type, title)
       VALUES ($1,$2,$3,$4,$5) RETURNING id, goal_type, title, status, created_at`,
      [request.user!.id, st?.id ?? null, cd?.id ?? null, b.goalType, b.title],
    );
    return { goal };
  });
  app.patch("/v1/me/goals/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        status: z.enum(["active", "paused", "completed", "abandoned"]).optional(),
        targetValue: z.number().optional(),
        dueAt: z.iso.datetime().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.goal_patch",
        parsed.error.message,
      );
    const result = await context.pool!.query(
      `UPDATE user_goal SET
         status = COALESCE($3, status),
         target_value = COALESCE($4, target_value),
         due_at = COALESCE($5, due_at),
         completed_at = CASE WHEN $3 = 'completed' THEN now() ELSE completed_at END
       WHERE id = $1 AND user_id = $2`,
      [
        id,
        request.user!.id,
        parsed.data.status ?? null,
        parsed.data.targetValue ?? null,
        parsed.data.dueAt ?? null,
      ],
    );
    if (result.rowCount === 0)
      return sendFailure(reply, request, 404, "permanent", "goal.not_found", "Goal not found.");
    return {
      goal: await one(
        context.pool!,
        "SELECT id, goal_type, title, status FROM user_goal WHERE id = $1",
        [id],
      ),
    };
  });
  app.get("/v1/me/goals", { preHandler: app.authenticate }, async (request) => {
    return {
      items: await many(
        context.pool!,
        "SELECT id, goal_type, title, status, created_at FROM user_goal WHERE user_id = $1 ORDER BY created_at DESC",
        [request.user!.id],
      ),
    };
  });

  // Share cards: queued render (worker); face/name privacy options persisted.
  const ShareCreate = z.object({
    shotId: z.uuid().nullable(),
    sessionId: z.uuid().nullable(),
    templateKey: z.string().max(40),
    privacyOptions: z.object({
      hideFace: z.boolean().default(true),
      hideName: z.boolean().default(false),
    }),
  });
  app.post("/v1/share-cards", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = ShareCreate.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.share",
        parsed.error.message,
      );
    const b = parsed.data;
    if (b.shotId) {
      const owned = await one(context.pool!, "SELECT id FROM shot WHERE id = $1 AND user_id = $2", [
        b.shotId,
        request.user!.id,
      ]);
      if (!owned)
        return sendFailure(reply, request, 404, "permanent", "shot.not_found", "Shot not found.");
    }
    const card = await one<{ id: string; status: string }>(
      context.pool!,
      `INSERT INTO share_card (user_id, shot_id, session_id, template_key, privacy_options, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + interval '30 days') RETURNING id, status`,
      [request.user!.id, b.shotId, b.sessionId, b.templateKey, JSON.stringify(b.privacyOptions)],
    );
    await context.queue.enqueue("share.render", { shareCardId: card!.id });
    return { shareCardId: card!.id, status: card!.status };
  });
  app.get("/v1/share-cards/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const card = await one(
      context.pool!,
      "SELECT id, status, template_key, created_at, expires_at FROM share_card WHERE id = $1 AND user_id = $2",
      [id, request.user!.id],
    );
    if (!card)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "share.not_found",
        "Share card not found.",
      );
    return { shareCard: card, playbackUrl: null };
  });

  app.get("/v1/achievements", { preHandler: app.authenticate }, async (request) => {
    const items = await many(
      context.pool!,
      `SELECT a.slug, a.name, a.description, a.points, ua.unlocked_at
       FROM achievement a
       LEFT JOIN user_achievement ua ON ua.achievement_id = a.id AND ua.user_id = $1
       WHERE a.active ORDER BY a.points`,
      [request.user!.id],
    );
    return { items };
  });
}
