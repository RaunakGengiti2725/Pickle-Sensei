import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { one } from "../../lib/db.js";
import { hasEntitlement } from "../billing/entitlements.js";

/**
 * Analysis jobs (spec pp. 18–19). On-device analyses are recorded for
 * traceability; cloud deep analysis is queued to the ml-worker and gated by
 * the free-tier quota (3/month) unless the user has premium entitlements.
 */

const AnalysisCreate = z.object({
  mediaAssetId: z.uuid().nullable(),
  localAnalysisId: z.uuid().nullable(),
  expectedShotType: z.string().nullable(),
  inferenceMode: z.enum(["on_device", "cloud_deep"]),
  sessionId: z.uuid().nullable(),
});

const FREE_MONTHLY_CLOUD_ANALYSES = 3;

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

    if (body.inferenceMode === "cloud_deep") {
      const premium = await hasEntitlement(context, userId, "premium");
      if (!premium) {
        const used = await one<{ n: string }>(
          context.pool!,
          `SELECT count(*)::text AS n FROM analysis_job
           WHERE user_id = $1 AND inference_mode = 'cloud_deep'
             AND requested_at >= date_trunc('month', now())`,
          [userId],
        );
        if (Number(used?.n ?? 0) >= FREE_MONTHLY_CLOUD_ANALYSES) {
          return sendFailure(
            reply,
            request,
            402,
            "permission_denied",
            "analysis.quota_exceeded",
            "Free plan includes 3 full analyses per month. Upgrade for unlimited.",
          );
        }
      }
    }

    const shotType = body.expectedShotType
      ? await one<{ id: string }>(context.pool!, "SELECT id FROM shot_type WHERE slug = $1", [
          body.expectedShotType,
        ])
      : null;
    const job = await one<{ id: string; status: string }>(
      context.pool!,
      `INSERT INTO analysis_job (user_id, media_asset_id, session_id, expected_shot_type_id, inference_mode, status, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, status`,
      [
        userId,
        body.mediaAssetId,
        body.sessionId,
        shotType?.id ?? null,
        body.inferenceMode,
        body.inferenceMode === "cloud_deep" ? "queued" : "complete",
        JSON.stringify({ localAnalysisId: body.localAnalysisId }),
      ],
    );
    if (body.inferenceMode === "cloud_deep") {
      await context.queue.enqueue("analysis.deep", { analysisJobId: job!.id });
    }
    return { analysisId: job!.id, status: job!.status };
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
    const result = await context.pool!.query(
      "UPDATE analysis_job SET status = 'cancelled' WHERE id = $1 AND user_id = $2 AND status = 'queued'",
      [id, request.user!.id],
    );
    if (result.rowCount === 0)
      return sendFailure(
        reply,
        request,
        409,
        "permanent",
        "analysis.not_cancellable",
        "Analysis is not queued.",
      );
    return { status: "cancelled" };
  });
}
