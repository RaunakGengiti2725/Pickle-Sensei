import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type pg from "pg";
import { z } from "zod";
import type { QualityDashboardResponseT, QualityRateT } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one } from "../../lib/db.js";

/**
 * Production quality dashboard (Wave I i33). One admin-only, audited
 * aggregation over server-side evidence stores:
 *  - evaluation_trial: consented per-attempt claims/abstentions (never
 *    verdicts) → attempts, completion, usable-result, abstention, envelope
 *    rejection, target-lock success, stroke/model-version distributions,
 *    latency percentiles, user-reported-wrong flags;
 *  - practice_session → session completion;
 *  - analysis_job / deletion_task → backend errors and queue health;
 *  - shot_rating → user-reported not-helpful results;
 *  - coach_review → review queue depths (user-flagged trials awaiting a
 *    qualified review; flags are candidate signals, never gold labels).
 * Everything returned is an aggregate count or rate — no raw private media,
 * no media URLs, no user identifiers, no per-user rows. Metrics with no
 * server-side evidence store (crash-free rate, api_failure events) are
 * reported not_evaluable with a reason instead of a fabricated number.
 */

function rate(numerator: number, denominator: number): QualityRateT {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  };
}

function toInt(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : 0;
}

function toFloatOrNull(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : value;
  return typeof parsed === "number" && Number.isFinite(parsed) ? parsed : null;
}

interface TrialAggregateRow extends Record<string, unknown> {
  attempts: string | number;
  scored: string | number;
  low_confidence: string | number;
  unavailable: string | number;
  quality_blocked: string | number;
  abstained: string | number;
  envelope_measured: string | number;
  envelope_unsupported: string | number;
  target_lock_measured: string | number;
  target_lock_presented: string | number;
  latency_count: string | number;
  latency_p50: string | number | null;
  latency_p90: string | number | null;
  latency_p99: string | number | null;
  user_flagged: string | number;
}

interface DistributionRow extends Record<string, unknown> {
  key: string;
  count: string | number;
}

interface SessionAggregateRow extends Record<string, unknown> {
  started: string | number;
  completed: string | number;
}

interface JobAggregateRow extends Record<string, unknown> {
  requested: string | number;
  failed: string | number;
  queued: string | number;
  processing: string | number;
  oldest_queued_age: string | number | null;
}

interface DeletionAggregateRow extends Record<string, unknown> {
  queued: string | number;
  processing: string | number;
  failed: string | number;
}

interface RatingAggregateRow extends Record<string, unknown> {
  not_helpful: string | number;
}

interface ReviewAggregateRow extends Record<string, unknown> {
  pending: string | number;
  pending_silent_failure: string | number;
}

interface CoachReviewCountRow extends Record<string, unknown> {
  recorded: string | number;
}

export async function computeQualityDashboard(
  pool: pg.Pool,
  windowDays: number,
): Promise<QualityDashboardResponseT> {
  const windowStart = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const trialAgg = await one<TrialAggregateRow>(
    pool,
    `SELECT
       count(*)::int AS attempts,
       count(*) FILTER (WHERE record->>'outcomeKind' = 'scored')::int AS scored,
       count(*) FILTER (WHERE record->>'outcomeKind' = 'low_confidence')::int AS low_confidence,
       count(*) FILTER (WHERE record->>'outcomeKind' = 'unavailable')::int AS unavailable,
       count(*) FILTER (WHERE record->>'outcomeKind' = 'quality_blocked')::int AS quality_blocked,
       count(*) FILTER (WHERE record->'claims'->'resultScore'->>'status' = 'abstained'
         OR record->'claims'->'resultScore'->>'presentation' = 'abstain')::int AS abstained,
       count(*) FILTER (WHERE record->>'envelopeOverall' IS NOT NULL)::int AS envelope_measured,
       count(*) FILTER (WHERE record->>'envelopeOverall' = 'UNSUPPORTED')::int AS envelope_unsupported,
       count(*) FILTER (WHERE record->'claims'->'targetLock'->>'status' IN ('presented','abstained'))::int
         AS target_lock_measured,
       count(*) FILTER (WHERE record->'claims'->'targetLock'->>'status' = 'presented')::int
         AS target_lock_presented,
       count(*) FILTER (WHERE jsonb_typeof(record->'latencyMs') = 'number')::int AS latency_count,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY (record->>'latencyMs')::double precision)
         FILTER (WHERE jsonb_typeof(record->'latencyMs') = 'number') AS latency_p50,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY (record->>'latencyMs')::double precision)
         FILTER (WHERE jsonb_typeof(record->'latencyMs') = 'number') AS latency_p90,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY (record->>'latencyMs')::double precision)
         FILTER (WHERE jsonb_typeof(record->'latencyMs') = 'number') AS latency_p99,
       count(*) FILTER (WHERE jsonb_array_length(COALESCE(record->'userFlags', '[]'::jsonb)) > 0)::int
         AS user_flagged
     FROM evaluation_trial
     WHERE received_at >= $1`,
    [windowStart],
  );

  const strokeDistribution = await many<DistributionRow>(
    pool,
    `SELECT record->'claims'->'strokeLabel'->>'label' AS key, count(*)::int AS count
     FROM evaluation_trial
     WHERE received_at >= $1 AND record->'claims'->'strokeLabel'->>'label' IS NOT NULL
     GROUP BY 1 ORDER BY count(*) DESC, 1`,
    [windowStart],
  );

  const modelVersionDistribution = await many<DistributionRow>(
    pool,
    `SELECT COALESCE(record->>'modelBundleVersion', 'unreported') AS key, count(*)::int AS count
     FROM evaluation_trial
     WHERE received_at >= $1
     GROUP BY 1 ORDER BY count(*) DESC, 1`,
    [windowStart],
  );

  const sessionAgg = await one<SessionAggregateRow>(
    pool,
    `SELECT count(*)::int AS started, count(*) FILTER (WHERE completed)::int AS completed
     FROM practice_session WHERE started_at >= $1`,
    [windowStart],
  );

  const jobAgg = await one<JobAggregateRow>(
    pool,
    `SELECT
       count(*) FILTER (WHERE requested_at >= $1)::int AS requested,
       count(*) FILTER (WHERE requested_at >= $1 AND status = 'failed')::int AS failed,
       count(*) FILTER (WHERE status = 'queued')::int AS queued,
       count(*) FILTER (WHERE status = 'processing')::int AS processing,
       extract(epoch FROM now() - min(requested_at) FILTER (WHERE status = 'queued')) AS oldest_queued_age
     FROM analysis_job`,
    [windowStart],
  );

  const deletionAgg = await one<DeletionAggregateRow>(
    pool,
    `SELECT
       count(*) FILTER (WHERE status = 'queued')::int AS queued,
       count(*) FILTER (WHERE status = 'processing')::int AS processing,
       count(*) FILTER (WHERE status = 'failed' AND created_at >= $1)::int AS failed
     FROM deletion_task`,
    [windowStart],
  );

  const ratingAgg = await one<RatingAggregateRow>(
    pool,
    `SELECT count(*)::int AS not_helpful
     FROM shot_rating WHERE helpful = false AND created_at >= $1`,
    [windowStart],
  );

  // User-flagged trials with no coach_review row for the trial's queue item
  // are the pending review queue. Trials whose scored Result was presented at
  // normal confidence are the candidate-silent-failure subset (a flag is a
  // labeling signal, never a verdict).
  const reviewAgg = await one<ReviewAggregateRow>(
    pool,
    `SELECT
       count(*) FILTER (WHERE cr.queue_item_id IS NULL)::int AS pending,
       count(*) FILTER (WHERE cr.queue_item_id IS NULL
         AND et.record->'claims'->'resultScore'->>'status' = 'presented'
         AND et.record->'claims'->'resultScore'->>'presentation' = 'normal')::int
         AS pending_silent_failure
     FROM evaluation_trial et
     LEFT JOIN LATERAL (
       SELECT queue_item_id FROM coach_review WHERE queue_item_id = et.trial_id::text LIMIT 1
     ) cr ON true
     WHERE et.received_at >= $1
       AND jsonb_array_length(COALESCE(et.record->'userFlags', '[]'::jsonb)) > 0`,
    [windowStart],
  );

  const coachReviewCount = await one<CoachReviewCountRow>(
    pool,
    "SELECT count(*)::int AS recorded FROM coach_review WHERE created_at >= $1",
    [windowStart],
  );

  const attempts = toInt(trialAgg?.attempts);
  const scored = toInt(trialAgg?.scored);
  const lowConfidence = toInt(trialAgg?.low_confidence);
  const sessionsStarted = toInt(sessionAgg?.started);
  const sessionsCompleted = toInt(sessionAgg?.completed);
  const jobsRequested = toInt(jobAgg?.requested);
  const jobsFailed = toInt(jobAgg?.failed);

  return {
    schemaVersion: "quality-dashboard-v1",
    generatedAtIso: new Date().toISOString(),
    windowDays,
    trials: {
      attempts,
      outcomeCounts: {
        scored,
        low_confidence: lowConfidence,
        unavailable: toInt(trialAgg?.unavailable),
        quality_blocked: toInt(trialAgg?.quality_blocked),
      },
      completion: rate(scored + lowConfidence, attempts),
      usableResult: rate(scored, attempts),
      abstention: rate(toInt(trialAgg?.abstained), attempts),
      envelopeRejection: rate(
        toInt(trialAgg?.envelope_unsupported),
        toInt(trialAgg?.envelope_measured),
      ),
      targetLockSuccess: rate(
        toInt(trialAgg?.target_lock_presented),
        toInt(trialAgg?.target_lock_measured),
      ),
      strokeDistribution: strokeDistribution.map((row) => ({
        key: row.key,
        count: toInt(row.count),
      })),
      latency: {
        measuredCount: toInt(trialAgg?.latency_count),
        p50Ms: toFloatOrNull(trialAgg?.latency_p50),
        p90Ms: toFloatOrNull(trialAgg?.latency_p90),
        p99Ms: toFloatOrNull(trialAgg?.latency_p99),
      },
      modelVersionDistribution: modelVersionDistribution.map((row) => ({
        key: row.key,
        count: toInt(row.count),
      })),
      userReportedWrongTrialCount: toInt(trialAgg?.user_flagged),
    },
    sessions: {
      started: sessionsStarted,
      completed: sessionsCompleted,
      completion: rate(sessionsCompleted, sessionsStarted),
    },
    crashFree: {
      status: "not_evaluable",
      reason:
        "app_crash analytics events have no server-side store; crash-free rate requires client crash telemetry ingestion that does not exist yet.",
    },
    backend: {
      analysisJobs: {
        requested: jobsRequested,
        failed: jobsFailed,
        failureRate: rate(jobsFailed, jobsRequested),
      },
      deletionTasksFailed: toInt(deletionAgg?.failed),
      apiErrors: {
        status: "not_evaluable",
        reason:
          "api_failure analytics events are emitted client-side and have no server-side store to aggregate from.",
      },
    },
    queues: {
      analysisQueued: toInt(jobAgg?.queued),
      analysisProcessing: toInt(jobAgg?.processing),
      oldestAnalysisQueuedAgeSeconds: toFloatOrNull(jobAgg?.oldest_queued_age),
      deletionQueued: toInt(deletionAgg?.queued),
      deletionProcessing: toInt(deletionAgg?.processing),
    },
    review: {
      userReportedWrongShotRatings: toInt(ratingAgg?.not_helpful),
      coachReviewQueueDepth: toInt(reviewAgg?.pending),
      silentFailureQueueDepth: toInt(reviewAgg?.pending_silent_failure),
      coachReviewsRecorded: toInt(coachReviewCount?.recorded),
    },
  };
}

const QualityDashboardQuery = z.object({
  windowDays: z.coerce.number().int().min(1).max(90).default(7),
});

export function registerQualityRoutes(app: FastifyInstance, context: AppContext): void {
  const requireDb = (request: FastifyRequest, reply: FastifyReply): pg.Pool | null => {
    if (!context.pool) {
      void sendFailure(
        reply,
        request,
        503,
        "retryable",
        "quality.db_unavailable",
        "The quality dashboard requires the database.",
      );
      return null;
    }
    return context.pool;
  };

  app.get(
    "/v1/admin/quality-dashboard",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const pool = requireDb(request, reply);
      if (!pool) return reply;
      const parsed = QualityDashboardQuery.safeParse(request.query);
      if (!parsed.success) {
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.quality_dashboard",
          parsed.error.message,
        );
      }
      const dashboard = await computeQualityDashboard(pool, parsed.data.windowDays);
      await audit(pool, {
        actorUserId: request.user!.id,
        action: "admin.quality_dashboard_viewed",
        targetKind: "quality_dashboard",
        targetId: `window:${parsed.data.windowDays}d`,
        requestId: request.id,
      });
      return dashboard;
    },
  );
}
