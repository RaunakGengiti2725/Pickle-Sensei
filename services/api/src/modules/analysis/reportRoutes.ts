import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { VersionVectorSchema } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one } from "../../lib/db.js";

/**
 * "Report bad analysis": a user disputes a completed analysis. Each report
 * carries version/device provenance, a bounded failure category, and safe
 * diagnostics only — a strict allowlist of numeric/enum runtime facts. Raw
 * video, frames, or landmark streams are never accepted here: consent to
 * analyze footage is not consent to share it with triage. Reports are CLAIMS
 * entering a structured triage queue, never gold labels.
 */

const FAILURE_CATEGORIES = [
  "wrong_shot_type",
  "score_too_low",
  "score_too_high",
  "phase_detection_wrong",
  "checkpoint_wrong",
  "no_shot_detected",
  "analysis_crashed",
  "other",
] as const;

/**
 * Safe diagnostics allowlist. `.strict()` rejects unknown keys, so a client
 * cannot smuggle media (base64 frames, landmark dumps) into the report.
 */
const SafeDiagnostics = z
  .object({
    overallScore: z.number().min(0).max(10).nullable().optional(),
    confidence: z.number().min(0).max(1).nullable().optional(),
    detectedShotType: z.string().max(60).nullable().optional(),
    inferenceLatencyMs: z.number().int().min(0).max(600_000).optional(),
    videoDurationMs: z.number().int().min(0).max(3_600_000).optional(),
    videoFps: z.number().min(0).max(480).optional(),
    frameDropCount: z.number().int().min(0).max(1_000_000).optional(),
    thermalState: z.enum(["nominal", "fair", "serious", "critical"]).optional(),
    lowMemoryWarnings: z.number().int().min(0).max(10_000).optional(),
  })
  .strict();

const ReportCreate = z.object({
  failureCategory: z.enum(FAILURE_CATEGORIES),
  comment: z.string().max(1000).nullable(),
  appVersion: z.string().min(1).max(40),
  device: z.object({
    platform: z.enum(["ios", "android"]),
    osVersion: z.string().min(1).max(40),
    model: z.string().min(1).max(80),
  }),
  versionVector: VersionVectorSchema,
  diagnostics: SafeDiagnostics.default({}),
});

const TriagePatch = z.object({
  status: z.enum(["open", "in_review", "resolved", "dismissed"]),
  note: z.string().max(2000).nullable(),
});

const TriageQuery = z.object({
  status: z.enum(["open", "in_review", "resolved", "dismissed"]).default("open"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export function registerAnalysisReportRoutes(app: FastifyInstance, context: AppContext): void {
  app.post("/v1/analyses/:id/report", { preHandler: app.authenticate }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = ReportCreate.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.analysis_report",
        parsed.error.message,
      );
    const body = parsed.data;
    const userId = request.user!.id;

    // Possession of an analysis UUID never grants the right to report it:
    // only the owner may file, and a missing job is indistinguishable from
    // someone else's job.
    const job = await one(
      context.pool!,
      "SELECT id FROM analysis_job WHERE id = $1 AND user_id = $2",
      [id, userId],
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

    const inserted = await one<{ id: string; triage_status: string; created_at: string }>(
      context.pool!,
      `INSERT INTO analysis_issue_report
         (user_id, analysis_job_id, failure_category, comment, app_version,
          device_platform, device_os_version, device_model, version_vector, diagnostics)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id, analysis_job_id) DO NOTHING
       RETURNING id, triage_status, created_at`,
      [
        userId,
        id,
        body.failureCategory,
        body.comment,
        body.appVersion,
        body.device.platform,
        body.device.osVersion,
        body.device.model,
        JSON.stringify(body.versionVector),
        JSON.stringify(body.diagnostics),
      ],
    );
    if (inserted) {
      return reply.status(201).send({
        report: { id: inserted.id, triageStatus: inserted.triage_status, created: true },
      });
    }
    // Replay: one report per user per analysis. Return the existing report so
    // a retried request is idempotent rather than an error.
    const existing = await one<{ id: string; triage_status: string }>(
      context.pool!,
      "SELECT id, triage_status FROM analysis_issue_report WHERE user_id = $1 AND analysis_job_id = $2",
      [userId, id],
    );
    return { report: { id: existing!.id, triageStatus: existing!.triage_status, created: false } };
  });

  app.get(
    "/v1/admin/analysis-reports",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const parsed = TriageQuery.safeParse(request.query ?? {});
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.analysis_report_query",
          parsed.error.message,
        );
      const { status, limit } = parsed.data;
      const reports = await many(
        context.pool!,
        `SELECT id, analysis_job_id, failure_category, comment, app_version,
                device_platform, device_os_version, device_model, version_vector,
                diagnostics, triage_status, triage_note, triaged_at, created_at
         FROM analysis_issue_report
         WHERE triage_status = $1
         ORDER BY created_at ASC
         LIMIT $2`,
        [status, limit],
      );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.analysis_report_queue",
        targetKind: "analysis_issue_report",
        targetId: status,
        requestId: request.id,
      });
      return { reports };
    },
  );

  app.post(
    "/v1/admin/analysis-reports/:id/triage",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = TriagePatch.safeParse(request.body);
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.analysis_report_triage",
          parsed.error.message,
        );
      const updated = await one<{ id: string; triage_status: string }>(
        context.pool!,
        `UPDATE analysis_issue_report
         SET triage_status = $2, triage_note = $3, triaged_by = $4, triaged_at = now()
         WHERE id = $1
         RETURNING id, triage_status`,
        [id, parsed.data.status, parsed.data.note, request.user!.id],
      );
      if (!updated)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "analysis_report.not_found",
          "Report not found.",
        );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.analysis_report_triage",
        targetKind: "analysis_issue_report",
        targetId: id,
        requestId: request.id,
      });
      return { report: { id: updated.id, triageStatus: updated.triage_status } };
    },
  );
}
