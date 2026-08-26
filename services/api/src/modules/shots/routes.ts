import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ShotsSyncRequest, type ShotSyncPayloadT } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one, withTransaction } from "../../lib/db.js";

/**
 * Shots module: idempotent batch upsert of on-device structured results
 * (spec pp. 19, 21–22). The server validates versions are KNOWN but never
 * recomputes client scores — historical results stay attached to the model
 * that produced them.
 */

const RatingBody = z.object({
  helpful: z.boolean(),
  reason: z.string().max(60).optional(),
  comment: z.string().max(2000).optional(),
});

interface CatalogCache {
  shotTypeIdBySlug: Map<string, string>;
  checkpointIdBySlug: Map<string, string>;
  scoringModelIdByShotAndVersion: Map<string, string>;
}

async function loadCatalog(context: AppContext): Promise<CatalogCache> {
  const pool = context.pool!;
  const shotTypes = await many<{ id: string; slug: string }>(
    pool,
    "SELECT id, slug FROM shot_type",
    [],
  );
  const checkpoints = await many<{ id: string; slug: string }>(
    pool,
    "SELECT id, slug FROM checkpoint_definition",
    [],
  );
  const models = await many<{ id: string; version: string; slug: string }>(
    pool,
    "SELECT sm.id, sm.version, st.slug FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id",
    [],
  );
  return {
    shotTypeIdBySlug: new Map(shotTypes.map((r) => [r.slug, r.id])),
    checkpointIdBySlug: new Map(checkpoints.map((r) => [r.slug, r.id])),
    scoringModelIdByShotAndVersion: new Map(models.map((r) => [`${r.slug}:${r.version}`, r.id])),
  };
}

export async function upsertShots(
  context: AppContext,
  userId: string,
  shots: ShotSyncPayloadT[],
): Promise<{
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
}> {
  const catalog = await loadCatalog(context);
  const acceptedIds: string[] = [];
  const rejected: Array<{ id: string; code: string; message: string }> = [];

  for (const shot of shots) {
    const shotTypeId = catalog.shotTypeIdBySlug.get(shot.shotType);
    if (!shotTypeId) {
      rejected.push({
        id: shot.id,
        code: "shot.unknown_type",
        message: `Unknown shot type ${shot.shotType}`,
      });
      continue;
    }
    const scoringModelId =
      catalog.scoringModelIdByShotAndVersion.get(
        `${shot.shotType}:${shot.versionVector.scoringModelVersion}`,
      ) ?? null;
    if (!scoringModelId) {
      rejected.push({
        id: shot.id,
        code: "shot.unknown_scoring_model",
        message: `Unknown scoring model ${shot.versionVector.scoringModelVersion} for ${shot.shotType}`,
      });
      continue;
    }
    if (shot.sessionId) {
      const session = await one(
        context.pool!,
        "SELECT id FROM practice_session WHERE id = $1 AND user_id = $2",
        [shot.sessionId, userId],
      );
      if (!session) {
        rejected.push({
          id: shot.id,
          code: "shot.session_not_found",
          message: "Session not found or not yours.",
        });
        continue;
      }
    }

    // Worst-checkpoint priority for library display: lowest scored applicable.
    const worst = shot.checkpoints
      .filter((c) => c.applicable && c.score !== null)
      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))[0];
    const topFaultId = worst ? (catalog.checkpointIdBySlug.get(worst.key) ?? null) : null;

    await withTransaction(context.pool!, async (tx) => {
      // Idempotent by client-generated PK: reconnection never duplicates.
      const result = await tx.query(
        `INSERT INTO shot (id, user_id, session_id, shot_type_id, scoring_model_id, camera_view,
           captured_at, start_ms, contact_ms, end_ms, overall_score, confidence, result_kind,
           source, top_fault_checkpoint_id, model_bundle_version, version_vector)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (id) DO NOTHING`,
        [
          shot.id,
          userId,
          shot.sessionId,
          shotTypeId,
          scoringModelId,
          shot.cameraView,
          shot.capturedAt,
          shot.timestamps.startMs,
          shot.timestamps.contactMs,
          shot.timestamps.endMs,
          shot.overallScore,
          shot.confidence,
          shot.resultKind,
          shot.source,
          topFaultId,
          shot.versionVector.modelBundleVersion,
          JSON.stringify(shot.versionVector),
        ],
      );
      if (result.rowCount === 0) return; // already synced — idempotent success

      for (const phase of shot.phases) {
        await tx.query(
          `INSERT INTO shot_phase (shot_id, phase_key, start_ms, representative_ms, end_ms, confidence)
           VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (shot_id, phase_key) DO NOTHING`,
          [
            shot.id,
            phase.key,
            phase.startMs,
            phase.representativeMs,
            phase.endMs,
            phase.confidence,
          ],
        );
      }
      for (const cp of shot.checkpoints) {
        const checkpointId = catalog.checkpointIdBySlug.get(cp.key);
        if (!checkpointId) continue;
        await tx.query(
          `INSERT INTO shot_checkpoint_score (shot_id, checkpoint_definition_id, score_0_100, confidence, band, direction, severity)
           VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (shot_id, checkpoint_definition_id) DO NOTHING`,
          [shot.id, checkpointId, cp.score, cp.confidence, cp.band, cp.direction, cp.severity],
        );
      }
      if (shot.sessionId) {
        await tx.query("UPDATE practice_session SET shot_count = shot_count + 1 WHERE id = $1", [
          shot.sessionId,
        ]);
      }
      // Daily progress rollup, scoring-model-version aware (spec p. 16).
      if (shot.resultKind === "scored" && shot.overallScore !== null) {
        await tx.query(
          `INSERT INTO progress_daily (user_id, day, shot_type_id, checkpoint_id, scoring_model_id, shot_count, avg_score, median_score, best_score)
           VALUES ($1, ($2)::date, $3, NULL, $4, 1, $5, $5, $5)
           ON CONFLICT (user_id, day, shot_type_id, checkpoint_id, scoring_model_id) DO UPDATE SET
             avg_score = (progress_daily.avg_score * progress_daily.shot_count + $5) / (progress_daily.shot_count + 1),
             best_score = GREATEST(progress_daily.best_score, $5),
             shot_count = progress_daily.shot_count + 1`,
          [userId, shot.capturedAt, shotTypeId, scoringModelId, shot.overallScore * 10],
        );
      }
    });
    acceptedIds.push(shot.id);
  }
  return { acceptedIds, rejected };
}

export function registerShotRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/shots:sync", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = ShotsSyncRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.shots_sync",
        parsed.error.message,
      );
    }
    return upsertShots(context, request.user!.id, parsed.data.shots);
  });

  app.get("/v1/shots/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const shot = await one(
      context.pool!,
      `SELECT s.*, st.slug AS shot_type_slug FROM shot s
       JOIN shot_type st ON st.id = s.shot_type_id
       WHERE s.id = $1 AND s.user_id = $2`,
      [id, request.user!.id],
    );
    if (!shot)
      return sendFailure(reply, request, 404, "permanent", "shot.not_found", "Shot not found.");
    const phases = await many(
      context.pool!,
      "SELECT phase_key, start_ms, representative_ms, end_ms, confidence FROM shot_phase WHERE shot_id = $1",
      [id],
    );
    const checkpoints = await many(
      context.pool!,
      `SELECT cd.slug, scs.score_0_100, scs.confidence, scs.band, scs.direction, scs.severity
       FROM shot_checkpoint_score scs JOIN checkpoint_definition cd ON cd.id = scs.checkpoint_definition_id
       WHERE scs.shot_id = $1`,
      [id],
    );
    const metrics = await many(
      context.pool!,
      "SELECT metric_key, metric_value, confidence, unit, source FROM shot_metric WHERE shot_id = $1",
      [id],
    );
    // Drill recommendation for the worst checkpoint via coach-authored mapping.
    const recommendedDrill = shot["top_fault_checkpoint_id"]
      ? await one(
          context.pool!,
          `SELECT d.slug, d.title, d.description, d.is_dev_fixture
           FROM drill_checkpoint_map m JOIN drill d ON d.id = m.drill_id
           WHERE m.checkpoint_definition_id = $1 AND m.shot_type_id = $2 AND d.active
           ORDER BY m.priority DESC LIMIT 1`,
          [shot["top_fault_checkpoint_id"], shot["shot_type_id"]],
        )
      : null;
    return { shot, phases, checkpoints, metrics, recommendedDrill };
  });

  app.post("/v1/shots/:id/rating", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = RatingBody.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.rating",
        parsed.error.message,
      );
    const owned = await one(context.pool!, "SELECT id FROM shot WHERE id = $1 AND user_id = $2", [
      id,
      request.user!.id,
    ]);
    if (!owned)
      return sendFailure(reply, request, 404, "permanent", "shot.not_found", "Shot not found.");
    await context.pool!.query(
      `INSERT INTO shot_rating (shot_id, user_id, helpful, reason, comment)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (shot_id) DO UPDATE SET helpful = EXCLUDED.helpful, reason = EXCLUDED.reason, comment = EXCLUDED.comment`,
      [
        id,
        request.user!.id,
        parsed.data.helpful,
        parsed.data.reason ?? null,
        parsed.data.comment ?? null,
      ],
    );
    return { accepted: true };
  });
}
