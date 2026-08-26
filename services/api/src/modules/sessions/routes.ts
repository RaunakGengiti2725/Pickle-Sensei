import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SessionCreateRequest, ShotsSyncRequest } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one } from "../../lib/db.js";
import { upsertShots } from "../shots/routes.js";

/** Sessions module: Live Court / guided sessions, batch sync, canonical summary. */

const SessionPatch = z.object({
  endedAt: z.iso.datetime().optional(),
  completed: z.boolean().optional(),
});

async function sessionView(context: AppContext, userId: string, id: string) {
  return one(
    context.pool!,
    `SELECT ps.id, ps.mode, st.slug AS shot_type, cd.slug AS focus_checkpoint, ps.camera_view,
            ps.started_at, ps.ended_at, ps.completed, ps.shot_count, ps.avg_score
     FROM practice_session ps
     LEFT JOIN shot_type st ON st.id = ps.selected_shot_type_id
     LEFT JOIN checkpoint_definition cd ON cd.id = ps.focus_checkpoint_id
     WHERE ps.id = $1 AND ps.user_id = $2`,
    [id, userId],
  );
}

export function registerSessionRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/sessions", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = SessionCreateRequest.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.session",
        parsed.error.message,
      );
    const body = parsed.data;
    const userId = request.user!.id;
    const shotType = body.shotType
      ? await one<{ id: string }>(context.pool!, "SELECT id FROM shot_type WHERE slug = $1", [
          body.shotType,
        ])
      : null;
    const focus = body.focusCheckpoint
      ? await one<{ id: string }>(
          context.pool!,
          "SELECT id FROM checkpoint_definition WHERE slug = $1",
          [body.focusCheckpoint],
        )
      : null;
    // Idempotent by client UUID — offline reconnect never duplicates.
    await context.pool!.query(
      `INSERT INTO practice_session (id, user_id, mode, selected_shot_type_id, focus_checkpoint_id, camera_view, started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      [
        body.id,
        userId,
        body.mode,
        shotType?.id ?? null,
        focus?.id ?? null,
        body.cameraView,
        body.startedAt,
      ],
    );
    const owned = await sessionView(context, userId, body.id);
    if (!owned)
      return sendFailure(
        reply,
        request,
        409,
        "permanent",
        "session.id_conflict",
        "Session id belongs to another user.",
      );
    return { session: owned };
  });

  app.post(
    "/v1/sessions/:id/shots:batch",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const session = await one(
        context.pool!,
        "SELECT id FROM practice_session WHERE id = $1 AND user_id = $2",
        [id, request.user!.id],
      );
      if (!session)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "session.not_found",
          "Session not found.",
        );
      const parsed = ShotsSyncRequest.safeParse(request.body);
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.shots_batch",
          parsed.error.message,
        );
      const withSession = parsed.data.shots.map((s) => ({ ...s, sessionId: id }));
      const result = await upsertShots(context, request.user!.id, withSession);
      return { accepted: result.acceptedIds, rejected: result.rejected, nextCursor: null };
    },
  );

  app.patch("/v1/sessions/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = SessionPatch.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.session_patch",
        parsed.error.message,
      );
    const result = await context.pool!.query(
      `UPDATE practice_session SET
         ended_at = COALESCE($3, ended_at),
         completed = COALESCE($4, completed)
       WHERE id = $1 AND user_id = $2`,
      [id, request.user!.id, parsed.data.endedAt ?? null, parsed.data.completed ?? null],
    );
    if (result.rowCount === 0)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "session.not_found",
        "Session not found.",
      );
    return { session: await sessionView(context, request.user!.id, id) };
  });

  // Canonical server-side summary (spec p. 25): computed from persisted shots.
  app.post(
    "/v1/sessions/:id/finalize",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const userId = request.user!.id;
      const session = await one<{ id: string; focus_checkpoint_id: string | null }>(
        context.pool!,
        "SELECT id, focus_checkpoint_id FROM practice_session WHERE id = $1 AND user_id = $2",
        [id, userId],
      );
      if (!session)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "session.not_found",
          "Session not found.",
        );

      const stats = await one<{
        valid_count: string;
        avg_score: string | null;
        best_score: string | null;
        first_score: string | null;
        last_score: string | null;
        best_shot_id: string | null;
      }>(
        context.pool!,
        `WITH scored AS (
         SELECT id, overall_score, captured_at FROM shot
         WHERE session_id = $1 AND user_id = $2 AND result_kind = 'scored'
       )
       SELECT count(*)::text AS valid_count,
              avg(overall_score)::text AS avg_score,
              max(overall_score)::text AS best_score,
              (SELECT overall_score::text FROM scored ORDER BY captured_at ASC LIMIT 1) AS first_score,
              (SELECT overall_score::text FROM scored ORDER BY captured_at DESC LIMIT 1) AS last_score,
              (SELECT id::text FROM scored ORDER BY overall_score DESC, captured_at ASC LIMIT 1) AS best_shot_id
       FROM scored`,
        [id, userId],
      );

      let focusDelta: number | null = null;
      if (session.focus_checkpoint_id) {
        const focus = await one<{ first_avg: string | null; last_avg: string | null }>(
          context.pool!,
          `WITH cp AS (
           SELECT scs.score_0_100, s.captured_at,
                  ntile(2) OVER (ORDER BY s.captured_at) AS half
           FROM shot_checkpoint_score scs
           JOIN shot s ON s.id = scs.shot_id
           WHERE s.session_id = $1 AND s.user_id = $2
             AND scs.checkpoint_definition_id = $3 AND scs.score_0_100 IS NOT NULL
         )
         SELECT avg(score_0_100) FILTER (WHERE half = 1)::text AS first_avg,
                avg(score_0_100) FILTER (WHERE half = 2)::text AS last_avg
         FROM cp`,
          [id, userId, session.focus_checkpoint_id],
        );
        if (focus?.first_avg && focus.last_avg) {
          focusDelta = Math.round((Number(focus.last_avg) - Number(focus.first_avg)) * 10) / 10;
        }
      }

      const validCount = Number(stats?.valid_count ?? 0);
      const avg = stats?.avg_score ? Number(stats.avg_score) : null;
      await context.pool!.query(
        `INSERT INTO session_summary (session_id, valid_shot_count, start_score, end_score, average_score, best_score, focus_checkpoint_id, focus_delta, best_shot_id, summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (session_id) DO UPDATE SET
         valid_shot_count = EXCLUDED.valid_shot_count, start_score = EXCLUDED.start_score,
         end_score = EXCLUDED.end_score, average_score = EXCLUDED.average_score,
         best_score = EXCLUDED.best_score, focus_delta = EXCLUDED.focus_delta,
         best_shot_id = EXCLUDED.best_shot_id, summary = EXCLUDED.summary, generated_at = now()`,
        [
          id,
          validCount,
          stats?.first_score ? Number(stats.first_score) : null,
          stats?.last_score ? Number(stats.last_score) : null,
          avg,
          stats?.best_score ? Number(stats.best_score) : null,
          session.focus_checkpoint_id,
          focusDelta,
          stats?.best_shot_id ?? null,
          JSON.stringify({ generatedBy: "api", version: 1 }),
        ],
      );
      await context.pool!.query(
        "UPDATE practice_session SET completed = true, ended_at = COALESCE(ended_at, now()), avg_score = $3 WHERE id = $1 AND user_id = $2",
        [id, userId, avg],
      );
      const summary = await one(
        context.pool!,
        "SELECT * FROM session_summary WHERE session_id = $1",
        [id],
      );
      return { summary };
    },
  );

  app.get("/v1/sessions/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = await sessionView(context, request.user!.id, id);
    if (!session)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "session.not_found",
        "Session not found.",
      );
    const shots = await many(
      context.pool!,
      `SELECT id, captured_at, overall_score, confidence, result_kind, source FROM shot
       WHERE session_id = $1 AND user_id = $2 ORDER BY captured_at ASC`,
      [id, request.user!.id],
    );
    const summary = await one(
      context.pool!,
      "SELECT * FROM session_summary WHERE session_id = $1",
      [id],
    );
    return { session, shots, summary };
  });
}
