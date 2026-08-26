import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";

/**
 * Privacy module (directive §34/§58, spec pp. 39–40).
 * - ML training consent is separate from everything else and revocable.
 * - Export assembles the user's structured data.
 * - Deletion is a real workflow: revoke access now, queue the rest, audit all.
 */

export function registerPrivacyRoutes(app: FastifyInstance, context: AppContext): void {
  app.put(
    "/v1/me/ml-training-consent",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const parsed = z
        .object({ granted: z.boolean(), termsVersion: z.string().max(20) })
        .safeParse(request.body);
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.consent",
          parsed.error.message,
        );
      const { granted, termsVersion } = parsed.data;
      const userId = request.user!.id;
      await withTransaction(context.pool!, async (tx) => {
        await tx.query(
          `INSERT INTO ml_training_consent (user_id, granted, terms_version, granted_at, revoked_at)
         VALUES ($1, $2, $3, CASE WHEN $2 THEN now() END, CASE WHEN NOT $2 THEN now() END)
         ON CONFLICT (user_id) DO UPDATE SET granted = $2, terms_version = $3,
           granted_at = CASE WHEN $2 THEN now() ELSE ml_training_consent.granted_at END,
           revoked_at = CASE WHEN NOT $2 THEN now() END,
           updated_at = now()`,
          [userId, granted, termsVersion],
        );
        await tx.query(
          "INSERT INTO user_consent (user_id, consent_type, version, granted, source) VALUES ($1, 'ml_training', $2, $3, 'privacy_center')",
          [userId, termsVersion, granted],
        );
        if (!granted) {
          // Revocation flags dataset items for removal review (provenance-aware).
          await tx.query(
            "UPDATE ml_dataset_item SET removed_at = now() WHERE source_user_id = $1 AND removed_at IS NULL",
            [userId],
          );
          await tx.query(
            "INSERT INTO deletion_task (user_id, kind, detail) VALUES ($1, 'ml_dataset_review', '{}')",
            [userId],
          );
        }
        await audit(tx, {
          actorUserId: userId,
          action: granted ? "ml_consent.granted" : "ml_consent.revoked",
          requestId: request.id,
        });
      });
      return {
        consent: await one(
          context.pool!,
          "SELECT granted, terms_version, granted_at, revoked_at FROM ml_training_consent WHERE user_id = $1",
          [userId],
        ),
      };
    },
  );

  // Data export (GDPR access/portability). Structured data assembled inline;
  // media exports arrive via signed URLs listed in the bundle.
  app.post("/v1/me/export", { preHandler: app.authenticate }, async (request) => {
    const userId = request.user!.id;
    const pool = context.pool!;
    const [user, profile, settings, consents, goals, sessions, shots, achievements] =
      await Promise.all([
        one(pool, "SELECT id, email, locale, timezone, created_at FROM app_user WHERE id = $1", [
          userId,
        ]),
        one(
          pool,
          "SELECT display_name, handle, handedness, skill_level, primary_goal, biggest_problem FROM user_profile WHERE user_id = $1",
          [userId],
        ),
        one(
          pool,
          "SELECT voice_enabled, voice_verbosity, units, cloud_sync_enabled, social_visibility FROM user_setting WHERE user_id = $1",
          [userId],
        ),
        many(
          pool,
          "SELECT consent_type, version, granted, created_at FROM user_consent WHERE user_id = $1 ORDER BY created_at",
          [userId],
        ),
        many(
          pool,
          "SELECT goal_type, title, status, created_at FROM user_goal WHERE user_id = $1",
          [userId],
        ),
        many(
          pool,
          "SELECT id, mode, started_at, ended_at, shot_count, avg_score FROM practice_session WHERE user_id = $1 ORDER BY started_at",
          [userId],
        ),
        many(
          pool,
          "SELECT id, captured_at, overall_score, confidence, result_kind, source, version_vector FROM shot WHERE user_id = $1 ORDER BY captured_at",
          [userId],
        ),
        many(
          pool,
          "SELECT a.slug, ua.unlocked_at FROM user_achievement ua JOIN achievement a ON a.id = ua.achievement_id WHERE ua.user_id = $1",
          [userId],
        ),
      ]);
    await audit(pool, { actorUserId: userId, action: "account.export", requestId: request.id });
    return {
      requestId: request.id,
      status: "complete",
      exportedAt: new Date().toISOString(),
      data: { user, profile, settings, consents, goals, sessions, shots, achievements },
    };
  });

  // Account deletion workflow (directive §58) — not a single cascade.
  app.delete("/v1/me", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = z.object({ confirmation: z.literal("DELETE") }).safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.delete_confirmation",
        'Body must be {"confirmation":"DELETE"}.',
      );
    }
    const userId = request.user!.id;
    const deletionRequestId = await withTransaction(context.pool!, async (tx) => {
      // 1. Immediately revoke access.
      await tx.query("UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1", [
        userId,
      ]);
      // 2–5. Queue media purge, ML review, IdP revocation; remove social now.
      await tx.query(
        "DELETE FROM friendship WHERE requester_user_id = $1 OR addressee_user_id = $1",
        [userId],
      );
      await tx.query(
        "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE owner_user_id = $1 AND deleted_at IS NULL",
        [userId],
      );
      const tasks = [
        "media_purge",
        "ml_dataset_review",
        "idp_revoke",
        "final_hard_delete",
      ] as const;
      let lastId = "";
      for (const kind of tasks) {
        const row = await one<{ id: string }>(
          tx,
          "INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2) RETURNING id",
          [userId, kind],
        );
        lastId = row!.id;
      }
      // 8. Audit record is the narrowly-justified retained record.
      await audit(tx, {
        actorUserId: userId,
        action: "account.delete_requested",
        requestId: request.id,
      });
      return lastId;
    });
    return { deletionRequestId, status: "processing" };
  });
}
