import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";

/**
 * Admin module (directive §45): elevated role required; every access audited.
 * Support lookup exposes account state, never private media.
 */

export function registerAdminRoutes(app: FastifyInstance, context: AppContext): void {
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
  app.put(
    "/v1/admin/scoring-models/:shotType/:version/release",
    { preHandler: app.requireAdmin },
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
      const released = await withTransaction(context.pool!, async (tx) => {
        const bundle = await one<{ id: string }>(
          tx,
          `SELECT id FROM model_bundle
           WHERE version = $1 AND status = 'active' AND rollout_percent = 100
             AND manifest_sha256 ~ '^[0-9a-f]{64}$'
           FOR UPDATE`,
          [parsed.data.modelBundleVersion],
        );
        if (!bundle) return null;
        return one(
          tx,
          `UPDATE scoring_model sm SET
             model_bundle_id = $3, status = 'active',
             dataset_snapshot_id = $4, evaluation_report_sha256 = $5,
             coach_validation_reference = $6, released_by = $7,
             released_at = now(), active_from = now(), active_to = NULL
           FROM shot_type st
           WHERE sm.shot_type_id = st.id AND st.slug = $1 AND sm.version = $2
           RETURNING sm.id`,
          [
            shotType,
            version,
            bundle.id,
            parsed.data.datasetSnapshotId,
            parsed.data.evaluationReportSha256,
            parsed.data.coachValidationReference,
            request.user!.id,
          ],
        );
      });
      if (!released) {
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "scoring.release_prerequisite_missing",
          "Release requires an existing scoring model and a 100% active hashed model bundle.",
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
        },
      });
      return { released: true, shotType, version };
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
}
