import type { FastifyInstance } from "fastify";
import type pg from "pg";
import { z } from "zod";
import { AccountBootstrapRequest } from "@pickle/api-contracts";
import type { AppContext } from "../../context.js";
import { sendFailure } from "../../lib/replies.js";
import { audit, many, one, withTransaction } from "../../lib/db.js";
import { accountRejection } from "../../plugins/authPlugin.js";

/** Identity module: bootstrap, me, profile, settings, onboarding, devices. */

const ProfilePatch = z.object({
  displayName: z.string().min(1).max(60).optional(),
  handle: z
    .string()
    .regex(/^[a-z0-9_]{3,24}$/)
    .optional(),
  handedness: z.enum(["right", "left", "ambidextrous"]).optional(),
  skillLevel: z.string().max(20).optional(),
});

const SettingsPatch = z.object({
  voiceEnabled: z.boolean().optional(),
  voiceVerbosity: z.enum(["quiet", "balanced", "chatty"]).optional(),
  units: z.enum(["imperial", "metric"]).optional(),
  cloudSyncEnabled: z.boolean().optional(),
  saveAllLiveClips: z.boolean().optional(),
  pushEnabled: z.boolean().optional(),
  socialVisibility: z.enum(["private", "friends", "public"]).optional(),
  analyticsOptOut: z.boolean().optional(),
});

const OnboardingPut = z.object({
  skillLevel: z.string().max(20),
  handedness: z.enum(["right", "left", "ambidextrous"]),
  goal: z.string().max(40),
  biggestProblem: z.string().max(40),
});

const DeviceRegister = z.object({
  platform: z.enum(["ios", "android"]),
  pushToken: z.string().max(4096).nullable(),
  appVersion: z.string().max(30),
  osVersion: z.string().max(30),
  model: z.string().max(60),
  deviceTier: z.enum(["A", "B", "C"]).nullable(),
});

type AccountRow = { id: string; status: string };

/**
 * Returns the app_user row for `authSubject`, creating it (with its profile,
 * settings and audit entry) when none exists. Concurrent first bootstraps for
 * one subject all race the UNIQUE(auth_subject) index: the insert is
 * ON CONFLICT DO NOTHING, so every loser adopts the winner's committed row
 * instead of failing the transaction.
 */
async function resolveAccount(
  tx: pg.PoolClient,
  authSubject: string,
  body: { locale: string; timezone: string },
  requestId: string,
): Promise<AccountRow> {
  const existing = await one<AccountRow>(
    tx,
    "SELECT id, status FROM app_user WHERE auth_subject = $1",
    [authSubject],
  );
  if (existing) return existing;
  const created = await one<AccountRow>(
    tx,
    `INSERT INTO app_user (auth_subject, locale, timezone) VALUES ($1, $2, $3)
     ON CONFLICT (auth_subject) DO NOTHING
     RETURNING id, status`,
    [authSubject, body.locale, body.timezone],
  );
  if (created) {
    await tx.query("INSERT INTO user_profile (user_id) VALUES ($1)", [created.id]);
    await tx.query("INSERT INTO user_setting (user_id) VALUES ($1)", [created.id]);
    await audit(tx, { actorUserId: created.id, action: "account.created", requestId });
    return created;
  }
  const winner = await one<AccountRow>(
    tx,
    "SELECT id, status FROM app_user WHERE auth_subject = $1",
    [authSubject],
  );
  if (!winner) throw new Error("app_user insert conflicted but no row is visible");
  return winner;
}

async function fetchMe(context: AppContext, userId: string) {
  const pool = context.pool!;
  const user = await one(
    pool,
    "SELECT id, email, status, locale, timezone, created_at FROM app_user WHERE id = $1",
    [userId],
  );
  const profile = await one(
    pool,
    "SELECT display_name, handle, handedness, skill_level, primary_goal, biggest_problem, profile_public FROM user_profile WHERE user_id = $1",
    [userId],
  );
  const settings = await one(
    pool,
    "SELECT voice_enabled, voice_verbosity, units, cloud_sync_enabled, save_all_live_clips, push_enabled, social_visibility, analytics_opt_out FROM user_setting WHERE user_id = $1",
    [userId],
  );
  const entitlements = await many(
    pool,
    "SELECT feature_key, valid_from, valid_to FROM entitlement WHERE user_id = $1 AND (valid_to IS NULL OR valid_to > now())",
    [userId],
  );
  const goals = await many(
    pool,
    "SELECT id, goal_type, title, status FROM user_goal WHERE user_id = $1 AND status = 'active'",
    [userId],
  );
  const onboarded = Boolean(
    profile?.["handedness"] &&
    profile?.["skill_level"] &&
    profile?.["primary_goal"] &&
    profile?.["biggest_problem"],
  );
  return {
    user,
    profile,
    settings,
    entitlements,
    goals,
    onboardingState: onboarded ? "complete" : "pending",
  };
}

export function registerIdentityRoutes(app: FastifyInstance, context: AppContext): void {
  // Create/fetch app user after OIDC auth (spec p. 17).
  app.post("/v1/account/bootstrap", { preHandler: app.verifyToken }, async (request, reply) => {
    if (!context.pool)
      return sendFailure(
        reply,
        request,
        503,
        "retryable",
        "db.unavailable",
        "Database unavailable.",
      );
    const identity = request.identity!;
    const parsed = AccountBootstrapRequest.safeParse(request.body);
    if (!parsed.success) {
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.bootstrap",
        parsed.error.message,
      );
    }
    const body = parsed.data;
    const account = await withTransaction(context.pool, async (tx) => {
      const account = await resolveAccount(tx, identity.authSubject, body, request.id);
      if (account.status === "deleted") {
        throw Object.assign(new Error("account deleted"), { statusCode: 410 });
      }
      // Only an account that may act registers a device; the status reply is
      // sent after the (write-free) transaction ends.
      if (accountRejection(account)) return account;
      await tx.query(
        `INSERT INTO user_device (user_id, platform, app_version, os_version, model, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, now())`,
        [
          account.id,
          body.device.platform,
          body.device.appVersion,
          body.device.osVersion,
          body.device.model,
        ],
      );
      return account;
    });
    const rejection = accountRejection(account);
    if (rejection) {
      return sendFailure(
        reply,
        request,
        rejection.status,
        rejection.kind,
        rejection.code,
        rejection.message,
      );
    }
    return fetchMe(context, account.id);
  });

  app.get("/v1/me", { preHandler: app.authenticate }, async (request) =>
    fetchMe(context, request.user!.id),
  );

  app.patch("/v1/me/profile", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = ProfilePatch.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.profile",
        parsed.error.message,
      );
    const p = parsed.data;
    const userId = request.user!.id;
    if (p.handle !== undefined) {
      const taken = await one(
        context.pool!,
        "SELECT user_id FROM user_profile WHERE handle = $1 AND user_id <> $2",
        [p.handle, userId],
      );
      if (taken)
        return sendFailure(
          reply,
          request,
          409,
          "permanent",
          "profile.handle_taken",
          "Handle already taken.",
        );
    }
    await context.pool!.query(
      `UPDATE user_profile SET
         display_name = COALESCE($2, display_name),
         handle = COALESCE($3, handle),
         handedness = COALESCE($4, handedness),
         skill_level = COALESCE($5, skill_level),
         updated_at = now()
       WHERE user_id = $1`,
      [userId, p.displayName ?? null, p.handle ?? null, p.handedness ?? null, p.skillLevel ?? null],
    );
    return {
      profile: await one(
        context.pool!,
        "SELECT display_name, handle, handedness, skill_level FROM user_profile WHERE user_id = $1",
        [userId],
      ),
    };
  });

  app.patch("/v1/me/settings", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = SettingsPatch.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.settings",
        parsed.error.message,
      );
    const s = parsed.data;
    const userId = request.user!.id;
    // Cloud-sync consent is recorded, not just toggled (spec p. 40).
    if (s.cloudSyncEnabled !== undefined) {
      await context.pool!.query(
        "INSERT INTO user_consent (user_id, consent_type, version, granted, source) VALUES ($1, 'cloud_video_sync', 'v1', $2, 'settings')",
        [userId, s.cloudSyncEnabled],
      );
    }
    await context.pool!.query(
      `UPDATE user_setting SET
         voice_enabled = COALESCE($2, voice_enabled),
         voice_verbosity = COALESCE($3, voice_verbosity),
         units = COALESCE($4, units),
         cloud_sync_enabled = COALESCE($5, cloud_sync_enabled),
         save_all_live_clips = COALESCE($6, save_all_live_clips),
         push_enabled = COALESCE($7, push_enabled),
         social_visibility = COALESCE($8, social_visibility),
         analytics_opt_out = COALESCE($9, analytics_opt_out),
         updated_at = now()
       WHERE user_id = $1`,
      [
        userId,
        s.voiceEnabled ?? null,
        s.voiceVerbosity ?? null,
        s.units ?? null,
        s.cloudSyncEnabled ?? null,
        s.saveAllLiveClips ?? null,
        s.pushEnabled ?? null,
        s.socialVisibility ?? null,
        s.analyticsOptOut ?? null,
      ],
    );
    return {
      settings: await one(context.pool!, "SELECT * FROM user_setting WHERE user_id = $1", [userId]),
    };
  });

  app.put("/v1/me/onboarding", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = OnboardingPut.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.onboarding",
        parsed.error.message,
      );
    const b = parsed.data;
    const userId = request.user!.id;
    await context.pool!.query(
      `UPDATE user_profile SET skill_level = $2, handedness = $3, primary_goal = $4, biggest_problem = $5, updated_at = now()
       WHERE user_id = $1`,
      [userId, b.skillLevel, b.handedness, b.goal, b.biggestProblem],
    );
    // Personalized starting focus: goal → checkpoint mapping (config-driven later).
    const goalFocus: Record<string, string> = {
      dinks: "contact_position",
      drives: "preparation",
      drops: "paddle_set",
      serve: "sequencing",
      return: "athletic_base",
      volleys: "face_wrist_stability",
      footwork: "athletic_base",
      "all-around": "contact_position",
    };
    const focusSlug = goalFocus[b.goal] ?? "contact_position";
    const checkpoint = await one<{ id: string; name: string }>(
      context.pool!,
      "SELECT id, name FROM checkpoint_definition WHERE slug = $1",
      [focusSlug],
    );
    const existing = await one(
      context.pool!,
      "SELECT id FROM user_goal WHERE user_id = $1 AND goal_type = 'onboarding_focus' AND status = 'active'",
      [userId],
    );
    if (!existing && checkpoint) {
      await context.pool!.query(
        "INSERT INTO user_goal (user_id, checkpoint_id, goal_type, title) VALUES ($1, $2, 'onboarding_focus', $3)",
        [userId, checkpoint.id, `Improve ${checkpoint.name}`],
      );
    }
    return { plan: { focusCheckpoint: focusSlug }, recommendedCheckpoint: focusSlug };
  });

  app.post("/v1/devices", { preHandler: app.authenticate }, async (request, reply) => {
    const parsed = DeviceRegister.safeParse(request.body);
    if (!parsed.success)
      return sendFailure(
        reply,
        request,
        400,
        "permanent",
        "validation.device",
        parsed.error.message,
      );
    const d = parsed.data;
    const row = await one<{ id: string }>(
      context.pool!,
      `INSERT INTO user_device (user_id, platform, push_token, app_version, os_version, model, device_tier, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
      [request.user!.id, d.platform, d.pushToken, d.appVersion, d.osVersion, d.model, d.deviceTier],
    );
    return { deviceId: row!.id };
  });
}
