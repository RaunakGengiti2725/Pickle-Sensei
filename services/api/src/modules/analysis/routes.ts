import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { one, withTransaction } from "../../lib/db.js";
import {
  AccessServiceError,
  assertUsablePermit,
  finalizeAnalysisPermit,
  finalizeAnalysisPermitWithDb,
} from "../billing/access.js";

/**
 * Analysis jobs (spec pp. 18–19). On-device analyses are recorded for
 * traceability; every rating starts with an idempotent access permit. A free
 * permit is consumed only when a confidence-qualified score is finalized.
 */

const AnalysisCreate = z.object({
  mediaAssetId: z.uuid().nullable(),
  localAnalysisId: z.uuid().nullable(),
  expectedShotType: z.string().nullable(),
  inferenceMode: z.enum(["on_device", "cloud_deep"]),
  sessionId: z.uuid().nullable(),
  permitId: z.uuid(),
});

export function registerAnalysisRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/analyses", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = AnalysisCreate.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.analysis",
        parsed.error.message,
      );
    const body = parsed.data;
    const userId = request.user!.id;

    if (body.inferenceMode === "cloud_deep") {
      try {
        // No cloud model worker is deployed in this repository. Release the
        // reservation immediately so an unavailable feature can never strand
        // one of the user's two lifetime ratings for 24 hours.
        await finalizeAnalysisPermit(context, userId, body.permitId, "failed", null);
      } catch (error) {
        if (error instanceof AccessServiceError) {
          return sendFailure(
            reply,
            request,
            error.statusCode,
            "permanent",
            error.code,
            error.message,
          );
        }
        throw error;
      }
      return sendFailure(
        reply,
        request,
        501,
        "not_implemented",
        "analysis.cloud_model_unavailable",
        "Cloud deep analysis is unavailable until a validated model worker is deployed.",
      );
    }

    if (body.mediaAssetId) {
      const owned = await one(
        context.pool!,
        "SELECT id FROM media_asset WHERE id = $1 AND owner_user_id = $2 AND deleted_at IS NULL",
        [body.mediaAssetId, userId],
      );
      if (!owned)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "media.not_found",
          "Media asset not found.",
        );
    }

    if (body.sessionId) {
      // Possession of a session UUID never grants access to it: an analysis may
      // only be attached to a practice session the caller owns.
      const owned = await one(
        context.pool!,
        "SELECT id FROM practice_session WHERE id = $1 AND user_id = $2",
        [body.sessionId, userId],
      );
      if (!owned)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "session.not_found",
          "Session not found.",
        );
    }

    const shotType = body.expectedShotType
      ? await one<{ id: string }>(context.pool!, "SELECT id FROM shot_type WHERE slug = $1", [
          body.expectedShotType,
        ])
      : null;
    let job: { id: string; status: string; created: boolean };
    try {
      job = await withTransaction(context.pool!, async (tx) => {
        const replay = await one<{ id: string; status: string }>(
          tx,
          `SELECT id, status FROM analysis_job
           WHERE user_id = $1 AND analysis_permit_id = $2 FOR UPDATE`,
          [userId, body.permitId],
        );
        if (replay) return { ...replay, created: false };
        await assertUsablePermit(tx, userId, body.permitId);
        const inserted = await one<{ id: string; status: string }>(
          tx,
          `INSERT INTO analysis_job
             (user_id, media_asset_id, session_id, expected_shot_type_id, inference_mode,
              status, metadata, analysis_permit_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, status`,
          [
            userId,
            body.mediaAssetId,
            body.sessionId,
            shotType?.id ?? null,
            body.inferenceMode,
            "complete",
            JSON.stringify({ localAnalysisId: body.localAnalysisId }),
            body.permitId,
          ],
        );
        if (!inserted) throw new Error("analysis job insert returned no row");
        return { ...inserted, created: true };
      });
    } catch (error) {
      if (error instanceof AccessServiceError) {
        return sendFailure(
          reply,
          request,
          error.statusCode,
          error.statusCode === 402 ? "permission_denied" : "permanent",
          error.code,
          error.message,
        );
      }
      throw error;
    }
    return { analysisId: job.id, status: job.status, permitId: body.permitId };
  });

  app.get("/v1/analyses/:id", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = await one(
      context.pool!,
      "SELECT id, status, inference_mode, failure_code, requested_at, started_at, finished_at FROM analysis_job WHERE id = $1 AND user_id = $2",
      [id, request.user!.id],
    );
    if (!job)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "analysis.not_found",
        "Analysis not found.",
      );
    return { analysis: job };
  });

  app.post("/v1/analyses/:id/cancel", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const cancelled = await withTransaction(context.pool!, async (tx) => {
        const job = await one<{ analysis_permit_id: string | null; status: string }>(
          tx,
          `SELECT analysis_permit_id, status FROM analysis_job
           WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, request.user!.id],
        );
        if (!job || job.status !== "queued") return null;
        await tx.query(
          "UPDATE analysis_job SET status = 'cancelled', finished_at = now() WHERE id = $1",
          [id],
        );
        if (job.analysis_permit_id) {
          await finalizeAnalysisPermitWithDb(
            tx,
            request.user!.id,
            job.analysis_permit_id,
            "cancelled",
            null,
          );
        }
        return { status: "cancelled" as const };
      });
      if (!cancelled) {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "analysis.not_cancellable",
          "Analysis is not queued.",
        );
      }
      return cancelled;
    } catch (error) {
      if (error instanceof AccessServiceError) {
        return sendFailure(
          reply,
          request,
          error.statusCode,
          "permanent",
          error.code,
          error.message,
        );
      }
      throw error;
    }
  });
}
