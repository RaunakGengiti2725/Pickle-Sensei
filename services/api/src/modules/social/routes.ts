import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one } from "../../lib/db.js";

/**
 * Social module: opt-in friends, friends-only leaderboards by default,
 * teen-safe defaults (spec pp. 40–41). Discovery is by handle only — never by
 * phone/email without explicit opt-in (not implemented at all here).
 */

export function registerSocialRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/friends/requests", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = z
      .object({ userHandle: z.string().regex(/^[a-z0-9_]{3,24}$/) })
      .safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.friend_request",
        parsed.error.message,
      );
    const target = await one<{ user_id: string }>(
      context.pool!,
      "SELECT user_id FROM user_profile WHERE handle = $1",
      [parsed.data.userHandle],
    );
    // Same response whether the handle exists or not — no account enumeration.
    if (!target || target.user_id === request.user!.id) {
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "friend.not_found",
        "No such user handle.",
      );
    }
    const existing = await one(
      context.pool!,
      `SELECT id FROM friendship WHERE (requester_user_id = $1 AND addressee_user_id = $2)
        OR (requester_user_id = $2 AND addressee_user_id = $1)`,
      [request.user!.id, target.user_id],
    );
    if (existing)
      return sendFailure(
        reply,
        request,
        409,
        "permanent",
        "friend.exists",
        "Friendship or request already exists.",
      );
    const friendship = await one(
      context.pool!,
      "INSERT INTO friendship (requester_user_id, addressee_user_id, status) VALUES ($1, $2, 'pending') RETURNING id, status",
      [request.user!.id, target.user_id],
    );
    return { friendship };
  });

  app.post("/v1/friends/:id/accept", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    // Only the ADDRESSEE can accept.
    const result = await context.pool!.query(
      "UPDATE friendship SET status = 'accepted', updated_at = now() WHERE id = $1 AND addressee_user_id = $2 AND status = 'pending'",
      [id, request.user!.id],
    );
    if (result.rowCount === 0)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "friend.not_found",
        "No pending request.",
      );
    return {
      friendship: await one(context.pool!, "SELECT id, status FROM friendship WHERE id = $1", [id]),
    };
  });

  app.delete("/v1/friends/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const result = await context.pool!.query(
      "DELETE FROM friendship WHERE id = $1 AND (requester_user_id = $2 OR addressee_user_id = $2)",
      [id, request.user!.id],
    );
    if (result.rowCount === 0)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "friend.not_found",
        "Friendship not found.",
      );
    return reply.status(204).send();
  });

  app.get("/v1/friends", { preHandler: app.authenticate }, async (request) => {
    const userId = request.user!.id;
    const items = await many(
      context.pool!,
      `SELECT f.id, f.status, f.requester_user_id = $1 AS outgoing,
              up.display_name, up.handle
       FROM friendship f
       JOIN user_profile up ON up.user_id = CASE WHEN f.requester_user_id = $1 THEN f.addressee_user_id ELSE f.requester_user_id END
       WHERE (f.requester_user_id = $1 OR f.addressee_user_id = $1) AND f.status IN ('pending','accepted')
       ORDER BY f.created_at DESC`,
      [userId],
    );
    return { items };
  });

  // Friends-only leaderboard (never an official rating; spec p. 7).
  app.get("/v1/leaderboards/friends", { preHandler: app.authenticate }, async (request) => {
    const userId = request.user!.id;
    const items = await many(
      context.pool!,
      `WITH circle AS (
         SELECT CASE WHEN requester_user_id = $1 THEN addressee_user_id ELSE requester_user_id END AS friend_id
         FROM friendship
         WHERE (requester_user_id = $1 OR addressee_user_id = $1) AND status = 'accepted'
         UNION SELECT $1
       )
       SELECT up.display_name, up.handle,
              round(avg(s.overall_score)::numeric, 1) AS avg_score,
              count(*) AS reps,
              (c.friend_id = $1) AS is_me
       FROM circle c
       JOIN user_setting us ON us.user_id = c.friend_id AND us.social_visibility <> 'private'
       JOIN user_profile up ON up.user_id = c.friend_id
       JOIN shot s ON s.user_id = c.friend_id
         AND s.source = 'real' AND s.result_kind = 'scored'
         AND s.captured_at > now() - interval '7 days'
       GROUP BY up.display_name, up.handle, c.friend_id
       ORDER BY avg_score DESC LIMIT 50`,
      [userId],
    );
    const myRankIndex = items.findIndex((i) => i["is_me"] === true);
    return { items, myRank: myRankIndex >= 0 ? myRankIndex + 1 : null };
  });
}
