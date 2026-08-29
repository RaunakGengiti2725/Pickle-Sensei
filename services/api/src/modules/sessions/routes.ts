import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { SessionCreateRequest, ShotsSyncRequest } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one } from "../../lib/db.js";
import { killSwitchPulled } from "../flags/registry.js";
import { upsertShots } from "../shots/routes.js";
import { computeSessionSummaryStats, writeSessionSummary } from "./summary.js";

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
      if (killSwitchPulled("session_processing", process.env))
        return sendFailure(
          reply,
          request,
          503,
          "retryable",
          "api.feature_disabled",
          "Session processing is temporarily disabled.",
        );
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

      const stats = await computeSessionSummaryStats(
        context.pool!,
        userId,
        id,
        session.focus_checkpoint_id,
      );
      await writeSessionSummary(context.pool!, id, session.focus_checkpoint_id, stats);
      await context.pool!.query(
        "UPDATE practice_session SET completed = true, ended_at = COALESCE(ended_at, now()), avg_score = $3 WHERE id = $1 AND user_id = $2",
        [id, userId, stats.avg],
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
       WHERE session_id = $1 AND user_id = $2 AND source = 'real' ORDER BY captured_at ASC`,
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
