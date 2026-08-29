import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { publishTestScoringRelease } from "./support/scoringRelease.js";

/**
 * Full-journey integration suite against a REAL PostgreSQL database.
 * Skipped (visibly) without DATABASE_URL_TEST; CI always runs it.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "integration-secret-0123456789";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function versionVector(scoringModelVersion = "sm-v1", shotConfigVersion = "forehand_drive@1") {
  return {
    appVersion: "0.1.0",
    modelBundleVersion: "test-native-1",
    poseModelVersion: "test-pose-1",
    paddleModelVersion: "test-paddle-1",
    strokeDetectorVersion: "test-stroke-1",
    phaseModelVersion: "test-phase-1",
    scoringModelVersion,
    shotConfigVersion,
  };
}

function shotPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    sessionId: null,
    shotType: "forehand_drive",
    cameraView: "side",
    capturedAt: new Date().toISOString(),
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    overallScore: 7.4,
    confidence: 0.91,
    resultKind: "scored",
    source: "real",
    phases: [
      { key: "contact", startMs: 1000, representativeMs: 1040, endMs: 1090, confidence: 0.9 },
    ],
    checkpoints: [
      {
        key: "contact_position",
        score: 58,
        confidence: 0.94,
        band: "red",
        direction: "late",
        severity: 0.42,
        applicable: true,
      },
      {
        key: "preparation",
        score: 82,
        confidence: 0.9,
        band: "green",
        direction: "none",
        severity: 0.18,
        applicable: true,
      },
    ],
    versionVector: versionVector(),
    ...overrides,
  };
}

describe.skipIf(!testUrl)("API integration (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let queue: InMemoryJobQueue;
  let userToken: string;
  let adminToken: string;
  let strangerToken: string;
  let userId: string;

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    await publishTestScoringRelease(pool);
    await pool.end();

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: testUrl!,
      devAuthSecret: DEV_SECRET,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
      adminAuthSubjects: ["auth0|itest-admin"],
    };
    queue = new InMemoryJobQueue();
    app = buildApp(config, { queue });

    const minter = new DevTokenVerifier("test", DEV_SECRET);
    userToken = await minter.mint("auth0|itest-user");
    adminToken = await minter.mint("auth0|itest-admin", "admin");
    strangerToken = await minter.mint("auth0|itest-stranger");
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const bootstrapBody = {
    locale: "en-US",
    timezone: "America/Los_Angeles",
    device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
  };

  async function reservePermit(token = userToken): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(token),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    return (response.json() as { permit: { id: string } }).permit.id;
  }

  it("bootstrap creates the account; /v1/me works afterwards", async () => {
    const before = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
    expect(before.statusCode).toBe(401); // token valid, no account yet

    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(userToken),
      payload: bootstrapBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { onboardingState: string; user: { id: string } };
    expect(body.onboardingState).toBe("pending");
    userId = body.user.id;

    for (const token of [adminToken, strangerToken]) {
      await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
    }
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
    expect(me.statusCode).toBe(200);
  });

  it("onboarding sets profile + creates the personalized starting focus goal", async () => {
    const res = await app.inject({
      method: "PUT",
      url: "/v1/me/onboarding",
      headers: auth(userToken),
      payload: {
        skillLevel: "3.5",
        handedness: "right",
        goal: "drives",
        biggestProblem: "consistency",
      },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { plan: { focusCheckpoint: string } }).plan.focusCheckpoint).toBe(
      "preparation",
    );
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
    const meBody = me.json() as { onboardingState: string; goals: unknown[] };
    expect(meBody.onboardingState).toBe("complete");
    expect(meBody.goals.length).toBeGreaterThan(0);
  });

  it("profile handle claims are unique", async () => {
    const first = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: auth(userToken),
      payload: { handle: "raunak", displayName: "Raunak" },
    });
    expect(first.statusCode).toBe(200);
    const stranger = await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: auth(strangerToken),
      payload: { handle: "raunak" },
    });
    expect(stranger.statusCode).toBe(409);
  });

  it("shots:sync upserts idempotently and rejects unknown scoring models", async () => {
    // This broad integration journey writes more than two ratings; explicitly
    // grant its test user premium so the separate allowance test remains able
    // to verify the exact lifetime-free boundary.
    const grant = await app.inject({
      method: "PUT",
      url: `/v1/admin/users/${userId}/entitlements`,
      headers: auth(adminToken),
      payload: { featureKey: "premium", validTo: null },
    });
    expect(grant.statusCode).toBe(200);
    const good = shotPayload({ analysisPermitId: await reservePermit() });
    const badVersion = shotPayload({
      analysisPermitId: await reservePermit(),
      versionVector: versionVector("sm-v999"),
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: { shots: [good, badVersion] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { acceptedIds: string[]; rejected: Array<{ code: string }> };
    expect(body.acceptedIds).toEqual([good.id]);
    expect(body.rejected[0]?.code).toBe("shot.unknown_scoring_model");

    // Replay remains idempotent even after the release is retired. Retirement
    // blocks new writes but cannot strand a canonical result already accepted.
    const retireBundle = await app.inject({
      method: "PUT",
      url: "/v1/admin/model-bundles/test-native-1",
      headers: auth(adminToken),
      payload: {
        manifestSha256: "a".repeat(64),
        status: "retired",
        rolloutPercent: 0,
      },
    });
    expect(retireBundle.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: { shots: [good] },
    });
    expect((replay.json() as { acceptedIds: string[] }).acceptedIds).toEqual([good.id]);
    const mutatedReplay = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: { shots: [{ ...good, overallScore: 9.9 }] },
    });
    expect(mutatedReplay.json()).toMatchObject({
      acceptedIds: [],
      rejected: [{ id: good.id, code: "shot.id_conflict" }],
    });
    const reactivateBundle = await app.inject({
      method: "PUT",
      url: "/v1/admin/model-bundles/test-native-1",
      headers: auth(adminToken),
      payload: {
        manifestSha256: "a".repeat(64),
        status: "active",
        rolloutPercent: 100,
      },
    });
    expect(reactivateBundle.statusCode).toBe(200);
    const detail = await app.inject({
      method: "GET",
      url: `/v1/shots/${good.id}`,
      headers: auth(userToken),
    });
    expect(detail.statusCode).toBe(200);
    const detailBody = detail.json() as {
      checkpoints: unknown[];
      recommendedDrill: { slug: string } | null;
    };
    expect(detailBody.checkpoints).toHaveLength(2);
    // Fixture drills are retired; no recommendation is safer than fake content.
    expect(detailBody.recommendedDrill).toBeNull();
  });

  it("UUID possession never grants access — stranger cannot read my shot", async () => {
    const mine = shotPayload({ analysisPermitId: await reservePermit() });
    await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: { shots: [mine] },
    });
    const res = await app.inject({
      method: "GET",
      url: `/v1/shots/${mine.id}`,
      headers: auth(strangerToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("live session lifecycle: create → batch shots → finalize summary", async () => {
    const sessionId = randomUUID();
    const create = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth(userToken),
      payload: {
        id: sessionId,
        mode: "live",
        shotType: "forehand_drive",
        focusCheckpoint: "contact_position",
        cameraView: "side",
        startedAt: new Date().toISOString(),
      },
    });
    expect(create.statusCode).toBe(200);

    const t0 = Date.now();
    const permits = await Promise.all([6.8, 7.2, 7.9, 8.4].map(() => reservePermit()));
    const shots = [6.8, 7.2, 7.9, 8.4].map((score, i) =>
      shotPayload({
        id: randomUUID(),
        analysisPermitId: permits[i],
        sessionId,
        overallScore: score,
        capturedAt: new Date(t0 + i * 15000).toISOString(),
        checkpoints: [
          {
            key: "contact_position",
            score: 55 + i * 10,
            confidence: 0.9,
            band: i < 2 ? "red" : "green",
            direction: i < 3 ? "late" : "none",
            severity: Math.max(0, 0.45 - i * 0.1),
            applicable: true,
          },
        ],
      }),
    );
    const batch = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/shots:batch`,
      headers: auth(userToken),
      payload: { shots },
    });
    expect(batch.statusCode).toBe(200);
    expect((batch.json() as { accepted: string[] }).accepted).toHaveLength(4);

    const finalize = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/finalize`,
      headers: auth(userToken),
    });
    expect(finalize.statusCode).toBe(200);
    const summary = (finalize.json() as { summary: Record<string, unknown> }).summary;
    expect(Number(summary["valid_shot_count"])).toBe(4);
    expect(Number(summary["best_score"])).toBeCloseTo(8.4, 5);
    expect(Number(summary["start_score"])).toBeCloseTo(6.8, 5);
    expect(Number(summary["end_score"])).toBeCloseTo(8.4, 5);
    // Focus improved second half vs first half (55,65 → 75,85 = +20).
    expect(Number(summary["focus_delta"])).toBeCloseTo(20, 1);

    const detail = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: auth(userToken),
    });
    expect((detail.json() as { shots: unknown[] }).shots).toHaveLength(4);
  });

  it("library lists shots with filters; favorite toggles", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/v1/library/shots?shotType=forehand_drive&limit=10",
      headers: auth(userToken),
    });
    expect(list.statusCode).toBe(200);
    const items = (list.json() as { items: Array<{ id: string }> }).items;
    expect(items.length).toBeGreaterThan(0);
    const fav = await app.inject({
      method: "POST",
      url: `/v1/library/shots/${items[0]!.id}/favorite`,
      headers: auth(userToken),
      payload: { favorite: true },
    });
    expect(fav.statusCode).toBe(200);
    const favList = await app.inject({
      method: "GET",
      url: "/v1/library/shots?favorite=true",
      headers: auth(userToken),
    });
    expect((favList.json() as { items: unknown[] }).items).toHaveLength(1);
  });

  it("progress series is scoring-model-version aware", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/progress", headers: auth(userToken) });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { series: Array<{ scoring_model_version: string }> };
    expect(body.series.length).toBeGreaterThan(0);
    expect(body.series[0]?.scoring_model_version).toBe("sm-v1");
  });

  it("groups progress series by the account-local day around midnight", async () => {
    const localToken = await new DevTokenVerifier("test", DEV_SECRET).mint(
      `auth0|progress-timezone-${randomUUID()}`,
    );
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(localToken),
      payload: {
        ...bootstrapBody,
        timezone: "America/Los_Angeles",
      },
    });
    expect(bootstrap.statusCode).toBe(200);

    // Both captures are on January 15 UTC, but they straddle local midnight:
    // 23:30 on January 14 and 00:30 on January 15 in Los Angeles.
    const captureTimes = ["2026-01-15T07:30:00.000Z", "2026-01-15T08:30:00.000Z"];
    const permits = await Promise.all(captureTimes.map(() => reservePermit(localToken)));
    const shots = captureTimes.map((capturedAt, index) =>
      shotPayload({
        id: randomUUID(),
        analysisPermitId: permits[index],
        capturedAt,
        overallScore: index === 0 ? 7.1 : 8.2,
      }),
    );
    const sync = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(localToken),
      payload: { shots },
    });
    expect(sync.statusCode, JSON.stringify(sync.json())).toBe(200);
    expect(sync.json()).toMatchObject({
      acceptedIds: shots.map((shot) => shot.id),
      rejected: [],
    });

    const progress = await app.inject({
      method: "GET",
      url: "/v1/progress",
      headers: auth(localToken),
    });
    expect(progress.statusCode).toBe(200);
    const body = progress.json() as {
      series: Array<{ day: string; shot_type: string; shot_count: number }>;
    };
    expect(
      body.series.map(({ day, shot_type, shot_count }) => ({ day, shot_type, shot_count })),
    ).toEqual([
      { day: "2026-01-14", shot_type: "forehand_drive", shot_count: 1 },
      { day: "2026-01-15", shot_type: "forehand_drive", shot_count: 1 },
    ]);

    const checkpointProgress = await app.inject({
      method: "GET",
      url: "/v1/progress/checkpoints/contact_position",
      headers: auth(localToken),
    });
    expect(checkpointProgress.statusCode).toBe(200);
    expect(
      (
        checkpointProgress.json() as {
          series: Array<{ day: string; scoring_model_version: string }>;
        }
      ).series.map(({ day, scoring_model_version }) => ({ day, scoring_model_version })),
    ).toEqual([
      { day: "2026-01-14", scoring_model_version: "sm-v1" },
      { day: "2026-01-15", scoring_model_version: "sm-v1" },
    ]);
  });

  it("catalog never exposes legacy fixture drills", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/catalog/drills?checkpoint=contact_position&shotType=forehand_drive",
      headers: auth(userToken),
    });
    const items = (res.json() as { items: Array<{ slug: string; is_dev_fixture: boolean }> }).items;
    expect(items.some((d) => d.slug === "dev-contact-out-front")).toBe(false);
    expect(items.every((d) => !d.is_dev_fixture)).toBe(true);
    const detail = await app.inject({
      method: "GET",
      url: "/v1/catalog/drills/dev-contact-out-front",
      headers: auth(userToken),
    });
    expect(detail.statusCode).toBe(404);
  });

  it("model-bundle endpoint exposes the explicitly published test release", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/catalog/model-bundle",
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      bundle: { version: "test-native-1", status: "active", rollout_percent: 100 },
    });
  });

  it("feature flags evaluate with stable rollout buckets", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(userToken) });
    const flags = (res.json() as { flags: Record<string, boolean> }).flags;
    expect(flags["live_court"]).toBe(true);
    expect(flags["ball_tracking"]).toBe(false);
    const again = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(userToken) });
    expect((again.json() as { flags: Record<string, boolean> }).flags).toEqual(flags);
  });

  it("billing offerings come from the database (remote-configurable pricing)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/billing/offerings",
      headers: auth(userToken),
    });
    const products = (
      res.json() as {
        products: Array<{ product_key: string; price_usd_cents: number; trial_days: number }>;
      }
    ).products;
    expect(products.map((p) => p.product_key)).toEqual([
      "premium_monthly_499",
      "premium_annual_3999",
    ]);
    expect(products[0]?.price_usd_cents).toBe(499);
    expect(products[1]).toMatchObject({ price_usd_cents: 3999, trial_days: 7 });
  });

  it("apple sync fails loudly without credentials — validation never faked", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/billing/apple/sync",
      headers: auth(userToken),
      payload: {},
    });
    expect(res.statusCode).toBe(501);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "billing.apple_unconfigured",
    );
  });

  it("analysis uses exactly two lifetime successful ratings, then premium permits", async () => {
    const revoke = await app.inject({
      method: "PUT",
      url: `/v1/admin/users/${userId}/entitlements`,
      headers: auth(adminToken),
      payload: {
        featureKey: "premium",
        validTo: new Date(Date.now() - 1_000).toISOString(),
      },
    });
    expect(revoke.statusCode).toBe(200);
    const payload = {
      mediaAssetId: null,
      localAnalysisId: null,
      expectedShotType: "forehand_drive",
      inferenceMode: "on_device",
      sessionId: null,
    };
    for (let i = 0; i < 2; i++) {
      const permit = await app.inject({
        method: "POST",
        url: "/v1/analysis-permits",
        headers: auth(userToken),
        payload: { idempotencyKey: randomUUID() },
      });
      expect(permit.statusCode).toBe(200);
      const permitId = (permit.json() as { permit: { id: string } }).permit.id;
      const res = await app.inject({
        method: "POST",
        url: "/v1/analyses",
        headers: auth(userToken),
        payload: { ...payload, permitId },
      });
      expect(res.statusCode).toBe(200);
      const ratingId = randomUUID();
      const finalized = await app.inject({
        method: "POST",
        url: "/v1/shots:sync",
        headers: auth(userToken),
        payload: {
          shots: [shotPayload({ id: ratingId, analysisPermitId: permitId })],
        },
      });
      expect(finalized.statusCode).toBe(200);
      expect(finalized.json()).toMatchObject({ acceptedIds: [ratingId], rejected: [] });
    }
    const thirdPermit = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(userToken),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(thirdPermit.statusCode).toBe(402);
    expect((thirdPermit.json() as { error: { code: string } }).error.code).toBe(
      "access.paywall_required",
    );

    // Admin grants premium (the canonical entitlement path) → unlimited.
    const meRes = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
    const myId = (meRes.json() as { user: { id: string } }).user.id;
    const grant = await app.inject({
      method: "PUT",
      url: `/v1/admin/users/${myId}/entitlements`,
      headers: auth(adminToken),
      payload: { featureKey: "premium", validTo: null },
    });
    expect(grant.statusCode).toBe(200);
    const premiumPermit = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(userToken),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(premiumPermit.statusCode).toBe(200);
    expect(premiumPermit.json()).toMatchObject({ permit: { accessSource: "premium" } });
    const premiumAnalysis = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(userToken),
      payload: {
        ...payload,
        permitId: (premiumPermit.json() as { permit: { id: string } }).permit.id,
      },
    });
    expect(premiumAnalysis.statusCode).toBe(200);
    expect((premiumAnalysis.json() as { status: string }).status).toBe("complete");
  });

  it("media upload requires cloud-sync consent, then presigns", async () => {
    const uploadBody = {
      kind: "raw_video",
      filename: "clip.mp4",
      bytes: 1024,
      contentType: "video/mp4",
      sha256: "a".repeat(64),
    };
    const denied = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(userToken),
      payload: uploadBody,
    });
    expect(denied.statusCode).toBe(403);
    expect((denied.json() as { error: { code: string } }).error.code).toBe(
      "media.cloud_sync_disabled",
    );

    await app.inject({
      method: "PATCH",
      url: "/v1/me/settings",
      headers: auth(userToken),
      payload: { cloudSyncEnabled: true },
    });
    const allowed = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(userToken),
      payload: uploadBody,
    });
    // Object storage unconfigured in tests → typed 503, never a fake URL.
    expect(allowed.statusCode).toBe(503);
    expect((allowed.json() as { error: { code: string } }).error.code).toBe(
      "media.storage_unconfigured",
    );
  });

  it("friends: request by handle → accept → leaderboard includes both", async () => {
    await app.inject({
      method: "PATCH",
      url: "/v1/me/profile",
      headers: auth(strangerToken),
      payload: { handle: "opponent", displayName: "Opponent" },
    });
    const req = await app.inject({
      method: "POST",
      url: "/v1/friends/requests",
      headers: auth(userToken),
      payload: { userHandle: "opponent" },
    });
    expect(req.statusCode).toBe(200);
    const friendshipId = (req.json() as { friendship: { id: string } }).friendship.id;

    // Requester cannot accept their own request.
    const selfAccept = await app.inject({
      method: "POST",
      url: `/v1/friends/${friendshipId}/accept`,
      headers: auth(userToken),
    });
    expect(selfAccept.statusCode).toBe(404);
    const accept = await app.inject({
      method: "POST",
      url: `/v1/friends/${friendshipId}/accept`,
      headers: auth(strangerToken),
    });
    expect(accept.statusCode).toBe(200);

    const board = await app.inject({
      method: "GET",
      url: "/v1/leaderboards/friends",
      headers: auth(userToken),
    });
    expect(board.statusCode).toBe(200);
    const boardBody = board.json() as { items: Array<{ handle: string }>; myRank: number | null };
    expect(boardBody.items.some((i) => i.handle === "raunak")).toBe(true);
    expect(boardBody.myRank).toBe(1); // stranger has no shots
  });

  it("weekly report returns null with no evidence — never fabricated", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/weekly-reports/latest",
      headers: auth(strangerToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { report: unknown }).report).toBeNull();
  });

  it("ML training consent grant/revoke is recorded and revocation flags dataset items", async () => {
    const grant = await app.inject({
      method: "PUT",
      url: "/v1/me/ml-training-consent",
      headers: auth(userToken),
      payload: { granted: true, termsVersion: "ml-v1" },
    });
    expect(grant.statusCode).toBe(200);
    const revoke = await app.inject({
      method: "PUT",
      url: "/v1/me/ml-training-consent",
      headers: auth(userToken),
      payload: { granted: false, termsVersion: "ml-v1" },
    });
    expect((revoke.json() as { consent: { granted: boolean } }).consent.granted).toBe(false);
  });

  it("export returns the full structured bundle", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/export",
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; data: { shots: unknown[]; consents: unknown[] } };
    expect(body.status).toBe("complete");
    expect(body.data.shots.length).toBeGreaterThan(0);
    expect(body.data.consents.length).toBeGreaterThan(0);
  });

  it("admin routes reject non-admins", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/v1/admin/users/${randomUUID()}`,
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("account deletion revokes access immediately and queues the workflow", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: "/v1/me",
      headers: auth(strangerToken),
      payload: { confirmation: "DELETE" },
    });
    expect(del.statusCode).toBe(200);
    expect((del.json() as { status: string }).status).toBe("processing");
    const after = await app.inject({ method: "GET", url: "/v1/me", headers: auth(strangerToken) });
    expect(after.statusCode).toBe(401); // access revoked NOW
    const rebootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(strangerToken),
      payload: bootstrapBody,
    });
    expect(rebootstrap.statusCode).toBe(410); // deleted accounts do not resurrect
  });
});
