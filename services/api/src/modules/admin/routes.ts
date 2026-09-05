import { performance } from "node:perf_hooks";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";
import { StabilityWindowSubmission, createStabilityGuard } from "./stabilityGuard.js";
import {
  buildSupportDiagnostics,
  categorizeAnalysisFailure,
  computeLatency,
  type AnalysisJobDiagnosticsRow,
  type DeviceDiagnosticsRow,
} from "./supportDiagnostics.js";

/**
 * Admin module (directive §45): elevated role required; every access audited.
 * Support lookup exposes account state, never private media.
 */

export function registerAdminRoutes(app: FastifyInstance, context: AppContext): void {
  // Stability SLO guard for the canary machinery (stability-slo-v1). Inactive
  // until a real observed window is submitted; once active, a pause/hold
  // decision blocks ADVANCING rollout percentages below — never a rollback.
  const stabilityGuard = createStabilityGuard();

  app.post(
    "/v1/admin/stability/window",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const parsed = StabilityWindowSubmission.safeParse(request.body);
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.stability_window",
          parsed.error.message,
        );
      const window = stabilityGuard.submitWindow(parsed.data.windowId, parsed.data.events);
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.stability_window_submit",
        targetKind: "stability_window",
        targetId: parsed.data.windowId,
        requestId: request.id,
        metadata: {
          action: window.decision.action,
          breachedSlos: window.decision.breachedSlos,
          notEvaluableSlos: window.decision.notEvaluableSlos,
        },
      });
      return { window };
    },
  );

  app.get("/v1/admin/stability/decision", { preHandler: app.requireAdmin }, async () => ({
    window: stabilityGuard.currentWindow(),
  }));
  app.get("/v1/admin/users/:id", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = await one(
      context.pool!,
      "SELECT id, email, status, locale, created_at, deleted_at FROM app_user WHERE id = $1",
      [id],
    );
    if (!user)
      return sendFailure(
        reply,
        request,
        404,
        "permanent",
        "admin.user_not_found",
        "User not found.",
      );
    await audit(context.pool!, {
      actorUserId: request.user!.id,
      action: "admin.user_lookup",
      targetKind: "app_user",
      targetId: id,
      requestId: request.id,
    });
    const profile = await one(
      context.pool!,
      "SELECT display_name, handle, skill_level FROM user_profile WHERE user_id = $1",
      [id],
    );
    const subscription = await many(
      context.pool!,
      "SELECT platform, product_id, status, current_period_end FROM billing_subscription WHERE user_id = $1",
      [id],
    );
    const counts = await one(
      context.pool!,
      "SELECT (SELECT count(*) FROM shot WHERE user_id = $1 AND source = 'real')::int AS shots, (SELECT count(DISTINCT session_id) FROM shot WHERE user_id = $1 AND source = 'real')::int AS sessions",
      [id],
    );
    return { user, profile, subscription, counts };
  });

  const DrillUpsert = z.object({
    slug: z.string().regex(/^[a-z0-9-]{3,60}$/),
    title: z.string().max(120),
    description: z.string().max(4000),
    coachName: z.string().max(80).nullable(),
    difficultyMin: z.string().max(10).nullable(),
    difficultyMax: z.string().max(10).nullable(),
    active: z.boolean(),
    mappings: z.array(
      z.object({
        checkpoint: z.string(),
        shotType: z.string(),
        priority: z.number().min(0).max(10),
      }),
    ),
  });

  app.put("/v1/admin/drills/:slug", { preHandler: app.requireAdmin }, async (request, reply) => {
    const parsed = DrillUpsert.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.admin_drill",
        parsed.error.message,
      );
    const b = parsed.data;
    const drill = await one<{ id: string }>(
      context.pool!,
      `INSERT INTO drill (slug, title, description, coach_name, difficulty_min, difficulty_max, active, is_dev_fixture)
       VALUES ($1,$2,$3,$4,$5,$6,$7,false)
       ON CONFLICT (slug) DO UPDATE SET title=$2, description=$3, coach_name=$4, difficulty_min=$5, difficulty_max=$6, active=$7
       RETURNING id`,
      [b.slug, b.title, b.description, b.coachName, b.difficultyMin, b.difficultyMax, b.active],
    );
    await context.pool!.query("DELETE FROM drill_checkpoint_map WHERE drill_id = $1", [drill!.id]);
    for (const m of b.mappings) {
      await context.pool!.query(
        `INSERT INTO drill_checkpoint_map (drill_id, checkpoint_definition_id, shot_type_id, priority)
         SELECT $1, cd.id, st.id, $4 FROM checkpoint_definition cd, shot_type st
         WHERE cd.slug = $2 AND st.slug = $3 ON CONFLICT DO NOTHING`,
        [drill!.id, m.checkpoint, m.shotType, m.priority],
      );
    }
    await audit(context.pool!, {
      actorUserId: request.user!.id,
      action: "admin.drill_upsert",
      targetKind: "drill",
      targetId: b.slug,
      requestId: request.id,
    });
    return { drillId: drill!.id };
  });

  const FlagPatch = z.object({
    enabled: z.boolean().optional(),
    rolloutPercent: z.number().int().min(0).max(100).optional(),
    description: z.string().max(400).optional(),
  });
  app.put("/v1/admin/flags/:key", { preHandler: app.requireAdmin }, async (request, reply) => {
    const { key } = request.params as { key: string };
    const parsed = FlagPatch.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.admin_flag",
        parsed.error.message,
      );
    const b = parsed.data;
    if (b.rolloutPercent !== undefined) {
      const existing = await one<{ rollout_percent: number }>(
        context.pool!,
        "SELECT rollout_percent FROM feature_flag WHERE key = $1",
        [key],
      );
      const check = stabilityGuard.checkRolloutChange(
        existing?.rollout_percent ?? 0,
        b.rolloutPercent,
      );
      if (check.active && !check.verdict.allowed) {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "stability.rollout_advance_blocked",
          `Stability SLO decision is '${check.verdict.decision.action}'; rollout may not advance. ` +
            `Breached: [${check.verdict.decision.breachedSlos.join(", ")}]; ` +
            `not evaluable: [${check.verdict.decision.notEvaluableSlos.join(", ")}]. ` +
            "Holding or reducing the rollout is always allowed.",
        );
      }
    }
    await context.pool!.query(
      `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
       VALUES ($1, COALESCE($2,''), COALESCE($3,false), COALESCE($4,100))
       ON CONFLICT (key) DO UPDATE SET
         description = COALESCE($2, feature_flag.description),
         enabled = COALESCE($3, feature_flag.enabled),
         rollout_percent = COALESCE($4, feature_flag.rollout_percent),
         updated_at = now()`,
      [key, b.description ?? null, b.enabled ?? null, b.rolloutPercent ?? null],
    );
    await audit(context.pool!, {
      actorUserId: request.user!.id,
      action: "admin.flag_update",
      targetKind: "feature_flag",
      targetId: key,
      requestId: request.id,
    });
    return {
      flag: await one(
        context.pool!,
        "SELECT key, enabled, rollout_percent FROM feature_flag WHERE key = $1",
        [key],
      ),
    };
  });

  const BundleCreate = z.object({
    version: z.string().max(40),
    manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
    status: z.enum(["draft", "canary", "active", "retired"]),
    rolloutPercent: z.number().int().min(0).max(100),
  });
  app.put(
    "/v1/admin/model-bundles/:version",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const parsed = BundleCreate.safeParse({
        ...(request.body as object),
        version: (request.params as { version: string }).version,
      });
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.admin_bundle",
          parsed.error.message,
        );
      const b = parsed.data;
      const existing = await one<{ rollout_percent: number }>(
        context.pool!,
        "SELECT rollout_percent FROM model_bundle WHERE version = $1",
        [b.version],
      );
      const check = stabilityGuard.checkRolloutChange(
        existing?.rollout_percent ?? 0,
        b.rolloutPercent,
      );
      if (check.active && !check.verdict.allowed) {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "stability.rollout_advance_blocked",
          `Stability SLO decision is '${check.verdict.decision.action}'; rollout may not advance. ` +
            `Breached: [${check.verdict.decision.breachedSlos.join(", ")}]; ` +
            `not evaluable: [${check.verdict.decision.notEvaluableSlos.join(", ")}]. ` +
            "Holding or reducing the rollout is always allowed.",
        );
      }
      await context.pool!.query(
        `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (version) DO UPDATE SET manifest_sha256=$2, status=$3, rollout_percent=$4`,
        [b.version, b.manifestSha256, b.status, b.rolloutPercent],
      );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.model_bundle_update",
        targetKind: "model_bundle",
        targetId: b.version,
        requestId: request.id,
      });
      return {
        bundle: await one(
          context.pool!,
          "SELECT version, status, rollout_percent FROM model_bundle WHERE version = $1",
          [b.version],
        ),
      };
    },
  );

  const ScoringModelRelease = z.object({
    modelBundleVersion: z.string().min(1).max(40),
    datasetSnapshotId: z.string().min(8).max(160),
    evaluationReportSha256: z.string().regex(/^[0-9a-f]{64}$/),
    coachValidationReference: z.string().min(3).max(300),
  });

  // Scoring-model release state machine: draft/validating → active; the
  // previously open-ended active version of the same shot type becomes
  // superseded (active_to = release time). Releases of one shot type are
  // serialised on its shot_type row; the partial unique index
  // scoring_model_single_open_active_per_shot_type (migration 0021) is the
  // schema-level backstop for writers that bypass this route.
  //
  // A release that was already in flight when another version of the same
  // shot type went live is a lost-update race, not a deliberate supersede: it
  // is refused unless it arrived after that activation. Release requests for
  // one shot type that overlap in time form a burst; every member of a burst
  // carries the burst's start as its arrival, so a request that reaches the
  // handler only after the burst's winner committed (TCP connections are
  // accepted one by one) is still refused. Arrival is stamped in onRequest,
  // before auth and body parsing, so queueing inside the process (pool waits,
  // lock waits) cannot move it, and it is expressed on the database clock
  // (the clock active_from is written with) by sampling clock_timestamp()
  // once per burst and shifting it back by the elapsed monotonic time, so
  // API/DB clock skew cannot bias the comparison. A burst ends when its last
  // member responds; a burst older than RELEASE_BURST_MAX_MS is abandoned
  // rather than trusted.
  interface ReleaseBurst {
    startedAt: Promise<number>;
    startedMs: number;
    inflight: Set<FastifyRequest>;
  }
  const RELEASE_BURST_MAX_MS = 60_000;
  const releaseBursts = new Map<string, ReleaseBurst>();
  const releaseArrivals = new WeakMap<FastifyRequest, Promise<number>>();
  // Database epoch seconds at the monotonic instant `atMs`.
  const dbClockAt = async (atMs: number): Promise<number> => {
    const sentMs = performance.now();
    const row = await one<{ epoch: number }>(
      context.pool!,
      "SELECT extract(epoch FROM clock_timestamp())::float8 AS epoch",
      [],
    );
    const sampledMs = (sentMs + performance.now()) / 2;
    return row!.epoch - (sampledMs - atMs) / 1000;
  };
  const releaseBurstKey = (request: FastifyRequest): string => {
    const { shotType } = request.params as { shotType?: unknown };
    return typeof shotType === "string" ? shotType : "";
  };
  const joinReleaseBurst = (request: FastifyRequest): void => {
    const key = releaseBurstKey(request);
    const nowMs = performance.now();
    let burst = releaseBursts.get(key);
    if (!burst || nowMs - burst.startedMs > RELEASE_BURST_MAX_MS) {
      const startedAt = dbClockAt(nowMs);
      startedAt.catch(() => undefined);
      burst = { startedAt, startedMs: nowMs, inflight: new Set() };
      releaseBursts.set(key, burst);
    }
    burst.inflight.add(request);
    releaseArrivals.set(request, burst.startedAt);
  };
  const leaveReleaseBurst = (request: FastifyRequest): void => {
    const key = releaseBurstKey(request);
    const burst = releaseBursts.get(key);
    if (!burst || !burst.inflight.delete(request)) return;
    if (burst.inflight.size === 0) releaseBursts.delete(key);
  };
  type ReleaseOutcome =
    | { kind: "released"; supersededVersion: string | null }
    | { kind: "prerequisite_missing" }
    | { kind: "invalid_state"; status: string }
    | { kind: "conflict"; activeVersion: string | null };
  const SINGLE_ACTIVE_INDEX = "scoring_model_single_open_active_per_shot_type";
  const isSingleActiveViolation = (error: unknown): boolean => {
    const pgError = error as { code?: string; constraint?: string };
    return pgError.code === "23505" && pgError.constraint === SINGLE_ACTIVE_INDEX;
  };

  app.put(
    "/v1/admin/scoring-models/:shotType/:version/release",
    {
      onRequest: (request, reply, done) => {
        joinReleaseBurst(request);
        // ServerResponse 'close' also fires when the connection is torn down
        // before a response could be sent (onResponse does not run then).
        reply.raw.once("close", () => leaveReleaseBurst(request));
        done();
      },
      onResponse: (request, _reply, done) => {
        leaveReleaseBurst(request);
        done();
      },
      preHandler: app.requireAdmin,
    },
    async (request, reply) => {
      const { shotType, version } = request.params as {
        shotType: string;
        version: string;
      };
      const parsed = ScoringModelRelease.safeParse(request.body);
      if (!parsed.success || !/^[a-z0-9_]{3,60}$/.test(shotType) || !version.trim()) {
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.scoring_model_release",
          parsed.success ? "Invalid shot type or scoring version." : parsed.error.message,
        );
      }
      const arrivedAt = await (releaseArrivals.get(request) ?? dbClockAt(performance.now()));
      let outcome: ReleaseOutcome;
      try {
        outcome = await withTransaction(context.pool!, async (tx): Promise<ReleaseOutcome> => {
          const shot = await one<{ id: string }>(
            tx,
            "SELECT id FROM shot_type WHERE slug = $1 FOR NO KEY UPDATE",
            [shotType],
          );
          if (!shot) return { kind: "prerequisite_missing" };
          const target = await one<{
            id: string;
            status: string;
            current_id: string | null;
            current_version: string | null;
            current_activated_after_request: boolean | null;
            release_time: string;
          }>(
            tx,
            `SELECT sm.id, sm.status,
                    cur.id AS current_id, cur.version AS current_version,
                    cur.active_from > to_timestamp($3::float8) AS current_activated_after_request,
                    clock_timestamp()::text AS release_time
             FROM scoring_model sm
             LEFT JOIN scoring_model cur
               ON cur.shot_type_id = sm.shot_type_id AND cur.id <> sm.id
              AND cur.status = 'active' AND cur.active_to IS NULL
             WHERE sm.shot_type_id = $1 AND sm.version = $2`,
            [shot.id, version, arrivedAt],
          );
          if (!target) return { kind: "prerequisite_missing" };
          if (target.status !== "draft" && target.status !== "validating") {
            return { kind: "invalid_state", status: target.status };
          }
          const bundle = await one<{ id: string }>(
            tx,
            `SELECT id FROM model_bundle
             WHERE version = $1 AND status = 'active' AND rollout_percent = 100
               AND manifest_sha256 ~ '^[0-9a-f]{64}$'
             FOR SHARE`,
            [parsed.data.modelBundleVersion],
          );
          if (!bundle) return { kind: "prerequisite_missing" };
          if (target.current_id && target.current_activated_after_request) {
            return { kind: "conflict", activeVersion: target.current_version };
          }
          if (target.current_id) {
            await tx.query(
              `UPDATE scoring_model SET status = 'superseded', active_to = $2::timestamptz
               WHERE id = $1 AND status = 'active' AND active_to IS NULL`,
              [target.current_id, target.release_time],
            );
          }
          const released = await one<{ id: string }>(
            tx,
            `UPDATE scoring_model SET
               model_bundle_id = $2, status = 'active',
               dataset_snapshot_id = $3, evaluation_report_sha256 = $4,
               coach_validation_reference = $5, released_by = $6,
               released_at = $7::timestamptz, active_from = $7::timestamptz, active_to = NULL
             WHERE id = $1 AND status IN ('draft', 'validating')
             RETURNING id`,
            [
              target.id,
              bundle.id,
              parsed.data.datasetSnapshotId,
              parsed.data.evaluationReportSha256,
              parsed.data.coachValidationReference,
              request.user!.id,
              target.release_time,
            ],
          );
          if (!released) return { kind: "invalid_state", status: target.status };
          return { kind: "released", supersededVersion: target.current_version };
        });
      } catch (error) {
        if (!isSingleActiveViolation(error)) throw error;
        outcome = { kind: "conflict", activeVersion: null };
      }
      if (outcome.kind === "prerequisite_missing") {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "scoring.release_prerequisite_missing",
          "Release requires an existing scoring model and a 100% active hashed model bundle.",
        );
      }
      if (outcome.kind === "invalid_state") {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "scoring.release_invalid_state",
          `Scoring model ${version} is ${outcome.status}; only draft or validating versions can be released.`,
        );
      }
      if (outcome.kind === "conflict") {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "scoring.release_conflict",
          outcome.activeVersion
            ? `Scoring model ${outcome.activeVersion} was released for ${shotType} while this request was in flight; review it before releasing again.`
            : `Another release for ${shotType} won a concurrent activation; review the active model before releasing again.`,
        );
      }
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "scoring_model.released",
        targetKind: "scoring_model",
        targetId: `${shotType}:${version}`,
        requestId: request.id,
        metadata: {
          modelBundleVersion: parsed.data.modelBundleVersion,
          datasetSnapshotId: parsed.data.datasetSnapshotId,
          evaluationReportSha256: parsed.data.evaluationReportSha256,
          coachValidationReference: parsed.data.coachValidationReference,
          supersededVersion: outcome.supersededVersion,
        },
      });
      return {
        released: true,
        shotType,
        version,
        supersededVersion: outcome.supersededVersion,
      };
    },
  );

  // Entitlement grant/revoke for support cases — the tested entitlement path.
  const EntitlementPut = z.object({
    featureKey: z.string().max(40),
    validTo: z.iso.datetime().nullable(),
  });
  app.put(
    "/v1/admin/users/:id/entitlements",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = EntitlementPut.safeParse(request.body);
      if (!parsed.success)
        return sendFailure(
          reply,
          request,
          400,
          "permanent",
          "validation.admin_entitlement",
          parsed.error.message,
        );
      const user = await one(context.pool!, "SELECT id FROM app_user WHERE id = $1", [id]);
      if (!user)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "admin.user_not_found",
          "User not found.",
        );
      await context.pool!.query(
        `INSERT INTO entitlement (user_id, feature_key, valid_from, valid_to) VALUES ($1,$2,now(),$3)
       ON CONFLICT (user_id, feature_key) DO UPDATE SET valid_to = EXCLUDED.valid_to`,
        [id, parsed.data.featureKey, parsed.data.validTo],
      );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.entitlement_grant",
        targetKind: "app_user",
        targetId: id,
        requestId: request.id,
        metadata: { featureKey: parsed.data.featureKey },
      });
      return { granted: true };
    },
  );

  // Support diagnostics (privacy-limited): "why did this analysis fail".
  // Allowlisted job/pipeline/device state only — no raw media, no storage
  // coordinates, no account identity beyond the pseudonymous user id.
  app.get(
    "/v1/admin/support/analyses/:id",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const job = await one<AnalysisJobDiagnosticsRow>(
        context.pool!,
        `SELECT j.id, j.user_id, j.status, j.inference_mode, j.failure_code,
                j.requested_at, j.started_at, j.finished_at,
                (j.media_asset_id IS NOT NULL) AS has_media,
                m.status AS media_status,
                (j.session_id IS NOT NULL) AS has_session,
                p.status AS permit_status,
                p.outcome AS permit_outcome,
                s.result_kind AS shot_result_kind,
                s.version_vector AS shot_version_vector
         FROM analysis_job j
         LEFT JOIN media_asset m ON m.id = j.media_asset_id
         LEFT JOIN analysis_permit p ON p.id = j.analysis_permit_id
         LEFT JOIN LATERAL (
           SELECT result_kind, version_vector FROM shot
           WHERE analysis_job_id = j.id ORDER BY created_at DESC LIMIT 1
         ) s ON true
         WHERE j.id = $1`,
        [id],
      );
      if (!job)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "support.analysis_not_found",
          "Analysis not found.",
        );
      const device = await one<DeviceDiagnosticsRow>(
        context.pool!,
        `SELECT platform, app_version, os_version, model, device_tier, model_bundle_version
         FROM user_device WHERE user_id = $1
         ORDER BY COALESCE(last_seen_at, created_at) DESC LIMIT 1`,
        [job.user_id],
      );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.support_analysis_diagnostics",
        targetKind: "analysis_job",
        targetId: id,
        requestId: request.id,
      });
      return { diagnostics: buildSupportDiagnostics(job, device) };
    },
  );

  app.get(
    "/v1/admin/support/users/:id/analyses",
    { preHandler: app.requireAdmin },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = await one(context.pool!, "SELECT id FROM app_user WHERE id = $1", [id]);
      if (!user)
        return sendFailure(
          reply,
          request,
          404,
          "permanent",
          "admin.user_not_found",
          "User not found.",
        );
      const jobs = await many<{
        id: string;
        status: string;
        inference_mode: string;
        failure_code: string | null;
        requested_at: Date;
        started_at: Date | null;
        finished_at: Date | null;
      }>(
        context.pool!,
        `SELECT id, status, inference_mode, failure_code, requested_at, started_at, finished_at
         FROM analysis_job WHERE user_id = $1
         ORDER BY requested_at DESC LIMIT 50`,
        [id],
      );
      await audit(context.pool!, {
        actorUserId: request.user!.id,
        action: "admin.support_analysis_list",
        targetKind: "app_user",
        targetId: id,
        requestId: request.id,
      });
      return {
        analyses: jobs.map((row) => ({
          analysisId: row.id,
          serverJobState: row.status,
          inferenceMode: row.inference_mode,
          failureCode: row.failure_code,
          failureCategory: categorizeAnalysisFailure(row.status, row.failure_code),
          requestedAt: row.requested_at.toISOString(),
          latency: computeLatency(row.requested_at, row.started_at, row.finished_at),
        })),
      };
    },
  );
}
