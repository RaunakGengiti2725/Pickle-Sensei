import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ShotsSyncRequest, type ShotSyncPayloadT } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one, withTransaction } from "../../lib/db.js";
import {
  AccessServiceError,
  assertUsablePermit,
  finalizeAnalysisPermit,
  finalizeAnalysisPermitWithDb,
  lockRatingAccessForAtomicWrite,
} from "../billing/access.js";
import { refreshSummaryIfPresent } from "../sessions/summary.js";

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
  knownScoringModels: Set<string>;
  scoringModelIdByRelease: Map<string, string>;
}

interface ExistingShotBinding extends Record<string, unknown> {
  id: string;
  user_id: string;
  analysis_permit_id: string | null;
  result_kind: "scored" | "low_confidence";
  permit_user_id: string | null;
  permit_status: "reserved" | "consumed" | "released" | "expired" | null;
  permit_outcome: string | null;
  permit_rating_id: string | null;
  sync_payload_sha256: string | null;
}

class ShotSyncConflictError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const SHOT_BINDING_QUERY = `SELECT s.id, s.user_id, s.analysis_permit_id, s.result_kind,
       s.sync_payload_sha256,
       p.user_id AS permit_user_id, p.status AS permit_status,
       p.outcome AS permit_outcome, p.rating_id AS permit_rating_id
     FROM shot s
     LEFT JOIN analysis_permit p ON p.id = s.analysis_permit_id
     WHERE s.id = $1`;

function syncPayloadHash(shot: ShotSyncPayloadT): string {
  // ShotSyncPayloadT has already passed through the Zod contract, which emits
  // a deterministic field order. Array order is part of the signed payload.
  return createHash("sha256").update(JSON.stringify(shot)).digest("hex");
}

function assertExactReplay(
  existing: ExistingShotBinding,
  userId: string,
  shot: ShotSyncPayloadT,
): void {
  const scored = shot.resultKind === "scored";
  const exact =
    existing.user_id === userId &&
    existing.analysis_permit_id === shot.analysisPermitId &&
    existing.result_kind === shot.resultKind &&
    existing.permit_user_id === userId &&
    existing.permit_status === (scored ? "consumed" : "released") &&
    existing.permit_outcome === (scored ? "scored" : "low_confidence") &&
    existing.permit_rating_id === (scored ? shot.id : null) &&
    // Legacy rows predate payload binding. Their canonical data stays intact,
    // but an unprovable retry is rejected instead of falsely called exact.
    existing.sync_payload_sha256 === syncPayloadHash(shot);
  if (!exact) {
    throw new ShotSyncConflictError(
      "shot.id_conflict",
      "Shot id is already bound to a different user, permit, or analysis outcome.",
    );
  }
}

async function releasePermitAfterPermanentSyncFailure(
  context: AppContext,
  userId: string,
  permitId: string,
): Promise<void> {
  try {
    await finalizeAnalysisPermit(context, userId, permitId, "failed", null);
  } catch (error) {
    // Preserve the original rejection when the permit was not owned, had
    // already finalized, or disappeared. Unexpected database failures still
    // surface rather than pretending the release succeeded.
    if (error instanceof AccessServiceError) return;
    throw error;
  }
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
  const knownModels = await many<{ version: string; slug: string }>(
    pool,
    "SELECT sm.version, st.slug FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id",
    [],
  );
  const releasedModels = await many<{
    id: string;
    version: string;
    slug: string;
    bundle_version: string;
    shot_config_version: string;
  }>(
    pool,
    `SELECT sm.id, sm.version, st.slug, mb.version AS bundle_version,
            sm.config->>'shotConfigVersion' AS shot_config_version
     FROM scoring_model sm
     JOIN shot_type st ON st.id = sm.shot_type_id
     JOIN model_bundle mb ON mb.id = sm.model_bundle_id
     WHERE sm.status = 'active' AND sm.active_from IS NOT NULL
       AND (sm.active_to IS NULL OR sm.active_to > now())
       AND NULLIF(btrim(sm.dataset_snapshot_id), '') IS NOT NULL
       AND sm.evaluation_report_sha256 ~ '^[0-9a-f]{64}$'
       AND NULLIF(btrim(sm.coach_validation_reference), '') IS NOT NULL
       AND sm.released_by IS NOT NULL AND sm.released_at IS NOT NULL
       AND mb.status = 'active' AND mb.rollout_percent = 100
       AND mb.manifest_sha256 ~ '^[0-9a-f]{64}$'`,
    [],
  );
  return {
    shotTypeIdBySlug: new Map(shotTypes.map((r) => [r.slug, r.id])),
    checkpointIdBySlug: new Map(checkpoints.map((r) => [r.slug, r.id])),
    knownScoringModels: new Set(knownModels.map((r) => `${r.slug}:${r.version}`)),
    scoringModelIdByRelease: new Map(
      releasedModels.map((r) => [
        `${r.slug}:${r.version}:${r.bundle_version}:${r.shot_config_version}`,
        r.id,
      ]),
    ),
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
    // A previously committed exact replay remains valid after its model is
    // retired. Retirement blocks new scores; it must not strand a durable
    // outbox row whose canonical write already succeeded.
    const previouslyCommitted = await one<ExistingShotBinding>(context.pool!, SHOT_BINDING_QUERY, [
      shot.id,
    ]);
    if (previouslyCommitted) {
      try {
        assertExactReplay(previouslyCommitted, userId, shot);
        acceptedIds.push(shot.id);
      } catch (error) {
        if (error instanceof ShotSyncConflictError) {
          await releasePermitAfterPermanentSyncFailure(context, userId, shot.analysisPermitId);
          rejected.push({ id: shot.id, code: error.code, message: error.message });
          continue;
        }
        throw error;
      }
      continue;
    }
    if (shot.source !== "real") {
      rejected.push({
        id: shot.id,
        code: "shot.non_real_source",
        message: "Only analyses produced by a real provider may be synced.",
      });
      continue;
    }
    const shotTypeId = catalog.shotTypeIdBySlug.get(shot.shotType);
    if (!shotTypeId) {
      await releasePermitAfterPermanentSyncFailure(context, userId, shot.analysisPermitId);
      rejected.push({
        id: shot.id,
        code: "shot.unknown_type",
        message: `Unknown shot type ${shot.shotType}`,
      });
      continue;
    }
    const knownScoringKey = `${shot.shotType}:${shot.versionVector.scoringModelVersion}`;
    if (!catalog.knownScoringModels.has(knownScoringKey)) {
      await releasePermitAfterPermanentSyncFailure(context, userId, shot.analysisPermitId);
      rejected.push({
        id: shot.id,
        code: "shot.unknown_scoring_model",
        message: `Unknown scoring model ${shot.versionVector.scoringModelVersion} for ${shot.shotType}`,
      });
      continue;
    }
    const releaseKey = `${knownScoringKey}:${shot.versionVector.modelBundleVersion}:${shot.versionVector.shotConfigVersion}`;
    const scoringModelId = catalog.scoringModelIdByRelease.get(releaseKey) ?? null;
    if (!scoringModelId) {
      await releasePermitAfterPermanentSyncFailure(context, userId, shot.analysisPermitId);
      rejected.push({
        id: shot.id,
        code: "shot.unreleased_model",
        message:
          "That scoring model, model bundle, and shot configuration are not an approved active release.",
      });
      continue;
    }
    // Worst-checkpoint priority for library display: lowest scored applicable.
    const worst = shot.checkpoints
      .filter((c) => c.applicable && c.score !== null)
      .sort((a, b) => (a.score ?? 101) - (b.score ?? 101))[0];
    const topFaultId = worst ? (catalog.checkpointIdBySlug.get(worst.key) ?? null) : null;

    try {
      await withTransaction(context.pool!, async (tx) => {
        // All permit paths use the same account -> permit lock order. This
        // serializes concurrent devices without deadlocking direct releases.
        await lockRatingAccessForAtomicWrite(tx, userId);

        const existing = await one<ExistingShotBinding>(tx, SHOT_BINDING_QUERY, [shot.id]);
        if (existing) {
          assertExactReplay(existing, userId, shot);
          return;
        }

        // The permit must still be reserved at the instant this transaction
        // owns it. A previously finalized permit is only accepted through the
        // exact replay branch above.
        await assertUsablePermit(tx, userId, shot.analysisPermitId);

        if (shot.sessionId) {
          const session = await one(
            tx,
            "SELECT id FROM practice_session WHERE id = $1 AND user_id = $2",
            [shot.sessionId, userId],
          );
          if (!session) {
            throw new ShotSyncConflictError(
              "shot.session_not_found",
              "Session not found or not yours.",
            );
          }
        }

        // Both the client shot id and permit id are unique. ON CONFLICT lets a
        // concurrent cross-user write settle, after which we verify whether it
        // was the one and only exact idempotent replay.
        const result = await tx.query(
          `INSERT INTO shot (id, user_id, session_id, analysis_permit_id, shot_type_id,
             scoring_model_id, camera_view, captured_at, start_ms, contact_ms, end_ms,
             overall_score, confidence, result_kind, source, top_fault_checkpoint_id,
             model_bundle_version, version_vector, sync_payload_sha256)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
           ON CONFLICT DO NOTHING`,
          [
            shot.id,
            userId,
            shot.sessionId,
            shot.analysisPermitId,
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
            syncPayloadHash(shot),
          ],
        );
        if (result.rowCount === 0) {
          const settled = await one<ExistingShotBinding>(tx, SHOT_BINDING_QUERY, [shot.id]);
          if (settled) assertExactReplay(settled, userId, shot);
          else {
            throw new ShotSyncConflictError(
              "shot.permit_conflict",
              "Analysis permit is already bound to a different shot.",
            );
          }
          return;
        }

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
          // A late outbox flush must not leave a finalized session reporting a
          // summary that excludes this shot.
          await refreshSummaryIfPresent(tx, userId, shot.sessionId);
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

        // This is deliberately last: any insert, detail, session, or rollup
        // failure rolls the permit finalization and free-credit count back too.
        await finalizeAnalysisPermitWithDb(
          tx,
          userId,
          shot.analysisPermitId,
          shot.resultKind === "scored" ? "scored" : "low_confidence",
          shot.resultKind === "scored" ? shot.id : null,
        );
      });
      acceptedIds.push(shot.id);
    } catch (error) {
      if (error instanceof AccessServiceError || error instanceof ShotSyncConflictError) {
        if (error instanceof ShotSyncConflictError) {
          await releasePermitAfterPermanentSyncFailure(context, userId, shot.analysisPermitId);
        }
        rejected.push({ id: shot.id, code: error.code, message: error.message });
        continue;
      }
      throw error;
    }
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
       WHERE s.id = $1 AND s.user_id = $2 AND s.source = 'real'`,
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
           WHERE m.checkpoint_definition_id = $1 AND m.shot_type_id = $2
             AND d.active AND NOT d.is_dev_fixture
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
