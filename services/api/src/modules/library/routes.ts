import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many } from "../../lib/db.js";

/** Library module: historical shots and sessions with filters + cursor paging. */

const ShotsQuery = z.object({
  shotType: z.string().optional(),
  favorite: z.coerce.boolean().optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  cursor: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function registerLibraryRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/library/shots", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = ShotsQuery.safeParse(request.query);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.library",
        parsed.error.message,
      );
    const q = parsed.data;
    const items = await many(
      context.pool!,
      `SELECT s.id, s.captured_at, s.overall_score, s.confidence, s.result_kind, s.source,
              s.favorite, st.slug AS shot_type, cd.slug AS top_fault
       FROM shot s
       JOIN shot_type st ON st.id = s.shot_type_id
       LEFT JOIN checkpoint_definition cd ON cd.id = s.top_fault_checkpoint_id
       WHERE s.user_id = $1 AND s.source = 'real'
         AND ($2::text IS NULL OR st.slug = $2)
         AND ($3::boolean IS NULL OR s.favorite = $3)
         AND ($4::timestamptz IS NULL OR s.captured_at >= $4)
         AND ($5::timestamptz IS NULL OR s.captured_at <= $5)
         AND ($6::timestamptz IS NULL OR s.captured_at < $6)
       ORDER BY s.captured_at DESC
       LIMIT $7`,
      [
        request.user!.id,
        q.shotType ?? null,
        q.favorite ?? null,
        q.from ?? null,
        q.to ?? null,
        q.cursor ?? null,
        q.limit,
      ],
    );
    const last = items[items.length - 1];
    return { items, cursor: items.length === q.limit ? last?.["captured_at"] : null };
  });

  app.get("/v1/library/sessions", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = z
      .object({
        cursor: z.iso.datetime().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(30),
      })
      .safeParse(request.query);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.library",
        parsed.error.message,
      );
    const q = parsed.data;
    const items = await many(
      context.pool!,
      `SELECT ps.id, ps.mode, ps.started_at, ps.ended_at, ps.completed, ps.shot_count, ps.avg_score,
              st.slug AS shot_type, ss.best_score, ss.focus_delta
       FROM practice_session ps
       LEFT JOIN shot_type st ON st.id = ps.selected_shot_type_id
       LEFT JOIN session_summary ss ON ss.session_id = ps.id
       WHERE ps.user_id = $1
         AND EXISTS (SELECT 1 FROM shot s WHERE s.session_id = ps.id AND s.source = 'real')
         AND ($2::timestamptz IS NULL OR ps.started_at < $2)
       ORDER BY ps.started_at DESC LIMIT $3`,
      [request.user!.id, q.cursor ?? null, q.limit],
    );
    const last = items[items.length - 1];
    return { items, cursor: items.length === q.limit ? last?.["started_at"] : null };
  });

  app.post(
    "/v1/library/shots/:id/favorite",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = z.object({ favorite: z.boolean() }).safeParse(request.body);
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.favorite",
          parsed.error.message,
        );
      const result = await context.pool!.query(
        "UPDATE shot SET favorite = $3 WHERE id = $1 AND user_id = $2 AND source = 'real'",
        [id, request.user!.id, parsed.data.favorite],
      );
      if (result.rowCount === 0)
        return sendFailure(reply, request, 404, "permanent", "shot.not_found", "Shot not found.");
      return { favorite: parsed.data.favorite };
    },
  );
}
