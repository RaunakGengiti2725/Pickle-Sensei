import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { many, one } from "../../lib/db.js";
import { computePracticeStreak } from "../training/logic.js";

/**
 * Progress + weekly reports. All trend queries group by scoring model version —
 * cross-version "improvement" is never computed without normalization (spec p. 44).
 */

const ProgressQuery = z.object({
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  shotType: z.string().optional(),
});

export function registerProgressRoutes(app: FastifyInstance, context: AppContext): void {
  app.get("/v1/progress", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = ProgressQuery.safeParse(request.query);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.progress",
        parsed.error.message,
      );
    const q = parsed.data;
    const userId = request.user!.id;

    const localToday = await one<{ today: string }>(
      context.pool!,
      `SELECT (now() AT TIME ZONE timezone)::date::text AS today
       FROM app_user WHERE id = $1`,
      [userId],
    );
    const practiceDates = await many<{ day: string }>(
      context.pool!,
      `WITH user_zone AS (
         SELECT timezone FROM app_user WHERE id = $1
       ), evidence AS (
         SELECT (s.captured_at AT TIME ZONE uz.timezone)::date AS day
         FROM shot s CROSS JOIN user_zone uz
         WHERE s.user_id = $1 AND s.source = 'real'
           AND s.result_kind = 'scored' AND s.overall_score IS NOT NULL
         UNION
         SELECT (dc.completed_at AT TIME ZONE uz.timezone)::date AS day
         FROM drill_completion dc CROSS JOIN user_zone uz
         WHERE dc.user_id = $1 AND dc.qualifies_for_streak
         UNION
         SELECT (COALESCE(ps.ended_at, ps.started_at) AT TIME ZONE uz.timezone)::date AS day
         FROM practice_session ps CROSS JOIN user_zone uz
         WHERE ps.user_id = $1 AND ps.mode = 'live' AND ps.completed
           AND (
             SELECT count(*) FROM shot live_shot
             WHERE live_shot.session_id = ps.id AND live_shot.user_id = $1
               AND live_shot.source = 'real' AND live_shot.result_kind = 'scored'
               AND live_shot.overall_score IS NOT NULL
           ) >= 3
       )
       SELECT day::text FROM evidence ORDER BY day`,
      [userId],
    );
    const streak = computePracticeStreak(
      practiceDates.map((row) => row.day),
      localToday?.today ?? new Date().toISOString().slice(0, 10),
    );

    const series = await many(
      context.pool!,
      `WITH user_zone AS (
         SELECT timezone FROM app_user WHERE id = $1
       ), localized_shots AS (
         SELECT (s.captured_at AT TIME ZONE uz.timezone)::date AS day,
                st.slug AS shot_type, sm.version AS scoring_model_version,
                s.overall_score
         FROM shot s
         JOIN shot_type st ON st.id = s.shot_type_id
         JOIN scoring_model sm ON sm.id = s.scoring_model_id
         CROSS JOIN user_zone uz
         WHERE s.user_id = $1 AND s.source = 'real' AND s.result_kind = 'scored'
           AND s.overall_score IS NOT NULL
       )
       SELECT day::text AS day, shot_type, scoring_model_version, count(*)::int AS shot_count,
              round((avg(overall_score) * 10)::numeric, 1) AS avg_score,
              round((max(overall_score) * 10)::numeric, 1) AS best_score
       FROM localized_shots
       WHERE ($2::date IS NULL OR day >= $2::date)
         AND ($3::date IS NULL OR day <= $3::date)
         AND ($4::text IS NULL OR shot_type = $4)
       GROUP BY day, shot_type, scoring_model_version
       ORDER BY day ASC`,
      [userId, q.from ?? null, q.to ?? null, q.shotType ?? null],
    );

    // Improving / needs-attention: per-checkpoint first-half vs second-half of
    // the last 30 days, within a single scoring model version.
    const checkpointTrends = await many<{
      slug: string;
      scoring_model_version: string;
      first_avg: string | null;
      second_avg: string | null;
      n: string;
    }>(
      context.pool!,
      `WITH recent AS (
         SELECT scs.checkpoint_definition_id, scs.score_0_100, s.captured_at, sm.version,
                ntile(2) OVER (PARTITION BY scs.checkpoint_definition_id, sm.version ORDER BY s.captured_at) AS half
         FROM shot_checkpoint_score scs
         JOIN shot s ON s.id = scs.shot_id
         JOIN scoring_model sm ON sm.id = s.scoring_model_id
         WHERE s.user_id = $1 AND s.source = 'real'
           AND s.captured_at > now() - interval '30 days'
           AND scs.score_0_100 IS NOT NULL
       )
       SELECT cd.slug, r.version AS scoring_model_version,
              avg(score_0_100) FILTER (WHERE half = 1)::text AS first_avg,
              avg(score_0_100) FILTER (WHERE half = 2)::text AS second_avg,
              count(*)::text AS n
       FROM recent r JOIN checkpoint_definition cd ON cd.id = r.checkpoint_definition_id
       GROUP BY cd.slug, r.version
       HAVING count(*) >= 6`,
      [userId],
    );
    const improving: Array<{ checkpoint: string; delta: number }> = [];
    const needsAttention: Array<{ checkpoint: string; avg: number }> = [];
    for (const t of checkpointTrends) {
      const first = t.first_avg ? Number(t.first_avg) : null;
      const second = t.second_avg ? Number(t.second_avg) : null;
      if (first !== null && second !== null) {
        const delta = Math.round((second - first) * 10) / 10;
        if (delta >= 3) improving.push({ checkpoint: t.slug, delta });
        if (second < 65)
          needsAttention.push({ checkpoint: t.slug, avg: Math.round(second * 10) / 10 });
      }
    }
    return { series, improving, needsAttention, streak };
  });

  app.get(
    "/v1/progress/checkpoints/:slug",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const { slug } = request.params as { slug: string };
      const checkpoint = await one<{ id: string }>(
        context.pool!,
        "SELECT id FROM checkpoint_definition WHERE slug = $1",
        [slug],
      );
      if (!checkpoint)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "checkpoint.not_found",
          "Unknown checkpoint.",
        );
      const series = await many(
        context.pool!,
        `WITH user_zone AS (
           SELECT timezone FROM app_user WHERE id = $1
         )
         SELECT (s.captured_at AT TIME ZONE uz.timezone)::date::text AS day,
              sm.version AS scoring_model_version,
              round(avg(scs.score_0_100)::numeric, 1) AS avg_score, count(*) AS n
       FROM shot_checkpoint_score scs
       JOIN shot s ON s.id = scs.shot_id
       JOIN scoring_model sm ON sm.id = s.scoring_model_id
       CROSS JOIN user_zone uz
       WHERE s.user_id = $1 AND s.source = 'real'
         AND scs.checkpoint_definition_id = $2 AND scs.score_0_100 IS NOT NULL
       GROUP BY 1, 2 ORDER BY 1 ASC`,
        [request.user!.id, checkpoint.id],
      );
      const current = series[series.length - 1] ?? null;
      return { series, current };
    },
  );

  // Weekly review generated from evidence (spec p. 7): reps, sessions, best
  // stroke, biggest gain, next priority.
  app.get("/v1/weekly-reports/latest", { preHandler: app.authenticate }, async (request) => {
    const userId = request.user!.id;
    const existing = await one(
      context.pool!,
      `SELECT * FROM weekly_report WHERE user_id = $1 AND week_start = date_trunc('week', now() - interval '7 days')::date`,
      [userId],
    );
    if (existing) return { report: existing };

    const stats = await one<Record<string, string | null>>(
      context.pool!,
      `SELECT count(*)::text AS reps,
              count(DISTINCT session_id)::text AS sessions,
              max(overall_score)::text AS best_score,
              (SELECT st.slug FROM shot s2 JOIN shot_type st ON st.id = s2.shot_type_id
                WHERE s2.user_id = $1 AND s2.captured_at >= date_trunc('week', now() - interval '7 days')
                  AND s2.captured_at < date_trunc('week', now())
                  AND s2.source = 'real' AND s2.result_kind = 'scored'
                GROUP BY st.slug ORDER BY avg(s2.overall_score) DESC LIMIT 1) AS best_stroke
       FROM shot
       WHERE user_id = $1 AND source = 'real' AND result_kind = 'scored'
         AND captured_at >= date_trunc('week', now() - interval '7 days')
         AND captured_at < date_trunc('week', now())`,
      [userId],
    );
    const versions = await many<{ version: string }>(
      context.pool!,
      `SELECT DISTINCT sm.version FROM shot s JOIN scoring_model sm ON sm.id = s.scoring_model_id
       WHERE s.user_id = $1 AND s.source = 'real'
         AND s.captured_at >= date_trunc('week', now() - interval '7 days')`,
      [userId],
    );
    const reps = Number(stats?.["reps"] ?? 0);
    if (reps === 0) return { report: null }; // no evidence — no fabricated review
    const report = {
      reps,
      sessions: Number(stats?.["sessions"] ?? 0),
      bestScore: stats?.["best_score"] ? Number(stats["best_score"]) : null,
      bestStroke: stats?.["best_stroke"] ?? null,
    };
    const row = await one(
      context.pool!,
      `INSERT INTO weekly_report (user_id, week_start, scoring_model_versions, report)
       VALUES ($1, date_trunc('week', now() - interval '7 days')::date, $2, $3)
       ON CONFLICT (user_id, week_start) DO UPDATE SET report = EXCLUDED.report
       RETURNING *`,
      [userId, JSON.stringify(versions.map((v) => v.version)), JSON.stringify(report)],
    );
    return { report: row };
  });

  app.get("/v1/weekly-reports", { preHandler: app.authenticate }, async (request) => {
    const items = await many(
      context.pool!,
      "SELECT id, week_start, report, generated_at FROM weekly_report WHERE user_id = $1 ORDER BY week_start DESC LIMIT 26",
      [request.user!.id],
    );
    return { items, cursor: null };
  });
}
