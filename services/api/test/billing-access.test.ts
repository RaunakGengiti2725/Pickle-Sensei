import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";
import { verifyWebhookAuthorization } from "../src/modules/billing/revenueCat.js";

describe("RevenueCat webhook authorization", () => {
  it("uses exact, constant-time-compatible credential matching", () => {
    expect(verifyWebhookAuthorization("Bearer webhook-secret", "Bearer webhook-secret")).toBe(true);
    expect(verifyWebhookAuthorization("Bearer wrong-secret", "Bearer webhook-secret")).toBe(false);
    expect(verifyWebhookAuthorization(undefined, "Bearer webhook-secret")).toBe(false);
  });
});

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "billing-access-secret-0123456789";
const schemaName = `billing_access_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

function activeRevenueCatCustomer(productId: string) {
  const purchase = new Date(Date.now() - 60_000).toISOString();
  const expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString();
  return {
    subscriber: {
      entitlements: {
        premium: {
          expires_date: expiry,
          product_identifier: productId,
          purchase_date: purchase,
        },
      },
      subscriptions: {
        [productId]: {
          expires_date: expiry,
          is_sandbox: true,
          original_purchase_date: purchase,
          original_transaction_id: `txn-${randomUUID()}`,
          period_type: "trial",
          purchase_date: purchase,
          store: "APP_STORE",
        },
      },
    },
  };
}

function inactiveRevenueCatCustomer(productId: string) {
  const expiry = new Date(Date.now() - 60_000).toISOString();
  return {
    subscriber: {
      entitlements: {},
      subscriptions: {
        [productId]: {
          expires_date: expiry,
          is_sandbox: true,
          original_purchase_date: expiry,
          original_transaction_id: `txn-${randomUUID()}`,
          period_type: "normal",
          purchase_date: expiry,
          store: "APP_STORE",
        },
      },
    },
  };
}

describe.skipIf(!testUrl)("rating access + verified billing (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let queue: InMemoryJobQueue;
  let minter: DevTokenVerifier;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const bootstrapBody = {
    locale: "en-US",
    timezone: "America/Los_Angeles",
    device: {
      platform: "ios" as const,
      osVersion: "18.0",
      appVersion: "0.1.0",
      model: "iPhone16,1",
    },
  };

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    await publishTestScoringRelease(pool);

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: scopedUrl,
      devAuthSecret: secret,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    queue = new InMemoryJobQueue();
    app = buildApp(config, { queue });
    minter = new DevTokenVerifier("test", secret);
  }, 60_000);

  afterEach(() => {
    delete process.env["REVENUECAT_SECRET_API_KEY"];
    delete process.env["REVENUECAT_WEBHOOK_AUTHORIZATION"];
    vi.unstubAllGlobals();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  async function createAccount(label: string): Promise<{ token: string; userId: string }> {
    const token = await minter.mint(`billing|${label}-${randomUUID()}`);
    const response = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: bootstrapBody,
    });
    expect(response.statusCode).toBe(200);
    return { token, userId: (response.json() as { user: { id: string } }).user.id };
  }

  async function reserve(token: string, idempotencyKey = randomUUID()) {
    return app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(token),
      payload: { idempotencyKey },
    });
  }

  function scoredShot(permitId: string, id = randomUUID()) {
    return {
      id,
      analysisPermitId: permitId,
      sessionId: null,
      shotType: "forehand_drive",
      cameraView: "side",
      capturedAt: new Date().toISOString(),
      timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
      overallScore: 7.4,
      confidence: 0.91,
      resultKind: "scored",
      source: "real",
      phases: [],
      checkpoints: [],
      versionVector: {
        appVersion: "0.1.0",
        modelBundleVersion: "test-native-1",
        poseModelVersion: "test-pose-1",
        paddleModelVersion: "test-paddle-1",
        strokeDetectorVersion: "test-stroke-1",
        phaseModelVersion: "test-phase-1",
        scoringModelVersion: "sm-v1",
        shotConfigVersion: "forehand_drive@1",
      },
    };
  }

  async function syncShot(token: string, shot: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(token),
      payload: { shots: [shot] },
    });
  }

  it("rejects a score from a known but unreleased model and releases its permit", async () => {
    const { token } = await createAccount("unreleased-model");
    await pool.query(
      `UPDATE scoring_model sm SET status = 'validating', active_from = NULL
       FROM shot_type st
       WHERE sm.shot_type_id = st.id AND st.slug = 'forehand_drive' AND sm.version = 'sm-v1'`,
    );
    const permitResponse = await reserve(token);
    const permitId = (permitResponse.json() as { permit: { id: string } }).permit.id;
    const rejected = await syncShot(token, scoredShot(permitId));
    expect(rejected.json()).toMatchObject({
      acceptedIds: [],
      rejected: [{ code: "shot.unreleased_model" }],
    });
    const access = await app.inject({
      method: "GET",
      url: "/v1/me/access",
      headers: auth(token),
    });
    expect(access.json()).toMatchObject({
      freeRatings: { used: 0, reserved: 0, remaining: 2 },
    });
    await publishTestScoringRelease(pool);
  });

  it("consumes exactly two lifetime successful ratings and releases every non-score", async () => {
    const { token } = await createAccount("allowance");
    const initial = await app.inject({ method: "GET", url: "/v1/me/access", headers: auth(token) });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toMatchObject({
      premium: false,
      freeRatings: { limit: 2, used: 0, reserved: 0, remaining: 2 },
      canStartRating: true,
      paywallRequired: false,
    });

    const idempotencyKey = randomUUID();
    const first = await reserve(token, idempotencyKey);
    const replay = await reserve(token, idempotencyKey);
    expect(first.statusCode).toBe(200);
    expect((replay.json() as { permit: { id: string } }).permit.id).toBe(
      (first.json() as { permit: { id: string } }).permit.id,
    );
    const released = await app.inject({
      method: "POST",
      url: `/v1/analysis-permits/${(first.json() as { permit: { id: string } }).permit.id}/finalize`,
      headers: auth(token),
      payload: { outcome: "low_confidence", ratingId: null },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toMatchObject({
      permit: { status: "released", outcome: "low_confidence" },
      access: { freeRatings: { used: 0, availableToReserve: 2 } },
    });

    const [permitAResponse, permitBResponse] = await Promise.all([reserve(token), reserve(token)]);
    expect(permitAResponse.statusCode).toBe(200);
    expect(permitBResponse.statusCode).toBe(200);
    const blockedWhileReserved = await reserve(token);
    expect(blockedWhileReserved.statusCode).toBe(402);
    expect((blockedWhileReserved.json() as { error: { code: string } }).error.code).toBe(
      "access.paywall_required",
    );

    const permitA = (permitAResponse.json() as { permit: { id: string } }).permit.id;
    const permitB = (permitBResponse.json() as { permit: { id: string } }).permit.id;
    const ratingA = randomUUID();
    const shotA = scoredShot(permitA, ratingA);
    const scoreA = await syncShot(token, shotA);
    expect(scoreA.statusCode).toBe(200);
    expect(scoreA.json()).toMatchObject({ acceptedIds: [ratingA], rejected: [] });
    expect(
      (await app.inject({ method: "GET", url: "/v1/me/access", headers: auth(token) })).json(),
    ).toMatchObject({ freeRatings: { used: 1 } });
    const scoreReplay = await syncShot(token, shotA);
    expect(scoreReplay.statusCode).toBe(200);
    const conflictingReplay = await app.inject({
      method: "POST",
      url: `/v1/analysis-permits/${permitA}/finalize`,
      headers: auth(token),
      payload: { outcome: "failed", ratingId: null },
    });
    expect(conflictingReplay.statusCode).toBe(409);

    const failureB = await app.inject({
      method: "POST",
      url: `/v1/analysis-permits/${permitB}/finalize`,
      headers: auth(token),
      payload: { outcome: "failed", ratingId: null },
    });
    expect(failureB.statusCode).toBe(200);
    expect(failureB.json()).toMatchObject({ access: { freeRatings: { used: 1, reserved: 0 } } });

    const permitCResponse = await reserve(token);
    expect(permitCResponse.statusCode).toBe(200);
    const permitC = (permitCResponse.json() as { permit: { id: string } }).permit.id;
    const scoreC = await syncShot(token, scoredShot(permitC));
    expect(scoreC.statusCode).toBe(200);
    const exhausted = await app.inject({
      method: "GET",
      url: "/v1/me/access",
      headers: auth(token),
    });
    expect(exhausted.json()).toMatchObject({
      freeRatings: {
        limit: 2,
        used: 2,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: false,
      paywallRequired: true,
    });
    expect((await reserve(token)).statusCode).toBe(402);
  });

  it("atomically binds scored syncs, rejects mismatches, and releases abstentions", async () => {
    const owner = await createAccount("shot-binding-owner");
    const stranger = await createAccount("shot-binding-stranger");
    const [firstPermitResponse, secondPermitResponse] = await Promise.all([
      reserve(owner.token),
      reserve(owner.token),
    ]);
    const firstPermit = (firstPermitResponse.json() as { permit: { id: string } }).permit.id;
    const secondPermit = (secondPermitResponse.json() as { permit: { id: string } }).permit.id;
    const shotId = randomUUID();
    const firstShot = scoredShot(firstPermit, shotId);

    const [firstWrite, exactConcurrentReplay] = await Promise.all([
      syncShot(owner.token, firstShot),
      syncShot(owner.token, firstShot),
    ]);
    expect(firstWrite.json()).toMatchObject({ acceptedIds: [shotId], rejected: [] });
    expect(exactConcurrentReplay.json()).toMatchObject({ acceptedIds: [shotId], rejected: [] });

    const mismatchedPermit = await syncShot(owner.token, scoredShot(secondPermit, shotId));
    expect(mismatchedPermit.json()).toMatchObject({
      acceptedIds: [],
      rejected: [{ id: shotId, code: "shot.id_conflict" }],
    });
    const secondPermitState = await pool.query(
      "SELECT status, outcome FROM analysis_permit WHERE id = $1",
      [secondPermit],
    );
    expect(secondPermitState.rows[0]).toMatchObject({ status: "released", outcome: "failed" });

    const otherShotSamePermit = await syncShot(owner.token, scoredShot(firstPermit));
    expect(otherShotSamePermit.json()).toMatchObject({
      acceptedIds: [],
      rejected: [{ code: "access.permit_not_reserved" }],
    });

    const strangerPermitResponse = await reserve(stranger.token);
    const strangerPermit = (strangerPermitResponse.json() as { permit: { id: string } }).permit.id;

    const arbitraryFinalize = await app.inject({
      method: "POST",
      url: `/v1/analysis-permits/${strangerPermit}/finalize`,
      headers: auth(stranger.token),
      payload: { outcome: "scored", ratingId: randomUUID() },
    });
    expect(arbitraryFinalize.statusCode).toBe(409);
    expect((arbitraryFinalize.json() as { error: { code: string } }).error.code).toBe(
      "access.rating_not_bound",
    );

    const crossUser = await syncShot(stranger.token, scoredShot(strangerPermit, shotId));
    expect(crossUser.json()).toMatchObject({
      acceptedIds: [],
      rejected: [{ id: shotId, code: "shot.id_conflict" }],
    });

    const abstentionPermitResponse = await reserve(owner.token);
    const abstentionPermit = (abstentionPermitResponse.json() as { permit: { id: string } }).permit
      .id;
    const lowConfidenceId = randomUUID();
    const abstention = {
      ...scoredShot(abstentionPermit, lowConfidenceId),
      overallScore: null,
      confidence: 0.42,
      resultKind: "low_confidence",
    };
    const released = await syncShot(owner.token, abstention);
    expect(released.json()).toMatchObject({ acceptedIds: [lowConfidenceId], rejected: [] });
    const ownerAccess = await app.inject({
      method: "GET",
      url: "/v1/me/access",
      headers: auth(owner.token),
    });
    expect(ownerAccess.json()).toMatchObject({
      freeRatings: { used: 1, reserved: 0, availableToReserve: 1 },
    });

    const failedPermitResponse = await reserve(owner.token);
    const failedPermit = (failedPermitResponse.json() as { permit: { id: string } }).permit.id;
    const invalidModel = scoredShot(failedPermit);
    invalidModel.versionVector.scoringModelVersion = "unpublished-model";
    const failed = await syncShot(owner.token, invalidModel);
    expect(failed.json()).toMatchObject({
      acceptedIds: [],
      rejected: [{ code: "shot.unknown_scoring_model" }],
    });
    const afterFailure = await app.inject({
      method: "GET",
      url: "/v1/me/access",
      headers: auth(owner.token),
    });
    expect(afterFailure.json()).toMatchObject({
      freeRatings: { used: 1, reserved: 0, availableToReserve: 1 },
    });
  });

  it("serializes concurrent devices racing different permits for one shot id", async () => {
    const account = await createAccount("shot-binding-race");
    const [permitAResponse, permitBResponse] = await Promise.all([
      reserve(account.token),
      reserve(account.token),
    ]);
    const permitA = (permitAResponse.json() as { permit: { id: string } }).permit.id;
    const permitB = (permitBResponse.json() as { permit: { id: string } }).permit.id;
    const shotId = randomUUID();
    const shotA = scoredShot(permitA, shotId);
    const shotB = scoredShot(permitB, shotId);
    const writes = await Promise.all([
      syncShot(account.token, shotA),
      syncShot(account.token, shotB),
    ]);
    const bodies = writes.map((response) => response.json()) as Array<{
      acceptedIds: string[];
      rejected: Array<{ code: string }>;
    }>;
    expect(bodies.filter((body) => body.acceptedIds.includes(shotId))).toHaveLength(1);
    expect(bodies.filter((body) => body.rejected[0]?.code === "shot.id_conflict")).toHaveLength(1);

    const persisted = await pool.query<{ analysis_permit_id: string }>(
      "SELECT analysis_permit_id FROM shot WHERE id = $1",
      [shotId],
    );
    const winningPermit = persisted.rows[0]!.analysis_permit_id;
    expect([permitA, permitB]).toContain(winningPermit);
    const winningPayload = winningPermit === permitA ? shotA : shotB;
    const exactReplay = await syncShot(account.token, winningPayload);
    expect(exactReplay.json()).toMatchObject({ acceptedIds: [shotId], rejected: [] });

    const access = await app.inject({
      method: "GET",
      url: "/v1/me/access",
      headers: auth(account.token),
    });
    expect(access.json()).toMatchObject({
      freeRatings: { used: 1, reserved: 0, availableToReserve: 1 },
    });
  });

  it("requires a permit and immediately releases it when cloud inference is unavailable", async () => {
    const { token } = await createAccount("cancel");
    const payload = {
      mediaAssetId: null,
      localAnalysisId: randomUUID(),
      expectedShotType: "forehand_drive",
      inferenceMode: "cloud_deep",
      sessionId: null,
    };
    const missing = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(token),
      payload,
    });
    expect(missing.statusCode).toBe(400);

    const permitResponse = await reserve(token);
    const permitId = (permitResponse.json() as { permit: { id: string } }).permit.id;
    const beforeQueue = await queue.size();
    const created = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(token),
      payload: { ...payload, permitId },
    });
    expect(created.statusCode).toBe(501);
    expect((created.json() as { error: { code: string } }).error.code).toBe(
      "analysis.cloud_model_unavailable",
    );
    expect(await queue.size()).toBe(beforeQueue);
    const access = await app.inject({ method: "GET", url: "/v1/me/access", headers: auth(token) });
    expect(access.json()).toMatchObject({ freeRatings: { used: 0, reserved: 0 } });
  });

  it("fails honestly when RevenueCat is unconfigured", async () => {
    const { token } = await createAccount("unconfigured");
    const response = await app.inject({
      method: "POST",
      url: "/v1/billing/sync",
      headers: auth(token),
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe(
      "billing.revenuecat_unconfigured",
    );
  });

  it("persists only server-fetched RevenueCat state and revokes expired provider access", async () => {
    const { token, userId } = await createAccount("revenuecat");
    const productId = "com.picklesensei.premium_monthly_499";
    process.env["REVENUECAT_SECRET_API_KEY"] = "sk_test_server_only";
    process.env["REVENUECAT_WEBHOOK_AUTHORIZATION"] = "Bearer webhook-secret";
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(activeRevenueCatCustomer(productId)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const sync = await app.inject({
      method: "POST",
      url: "/v1/billing/sync",
      headers: auth(token),
      payload: { premium: false, productId: "client-input-is-ignored" },
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json()).toMatchObject({
      billing: { premium: true, productKey: "premium_monthly_499" },
      access: { premium: true, canStartRating: true },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.revenuecat.com/v1/subscribers/${userId}`,
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ Authorization: "Bearer sk_test_server_only" }),
      }),
    );
    const canonical = await pool.query(
      `SELECT bs.provider, bs.product_id, e.source
       FROM billing_subscription bs
       JOIN entitlement e ON e.subscription_id = bs.id
       WHERE bs.user_id = $1 AND e.feature_key = 'premium'`,
      [userId],
    );
    expect(canonical.rows[0]).toMatchObject({
      provider: "revenuecat",
      product_id: productId,
      source: "revenuecat",
    });

    const unauthorized = await app.inject({
      method: "POST",
      url: "/v1/webhooks/revenuecat",
      headers: { authorization: "Bearer wrong" },
      payload: {
        api_version: "1.0",
        event: { id: randomUUID(), app_user_id: userId, original_app_user_id: userId, aliases: [] },
      },
    });
    expect(unauthorized.statusCode).toBe(401);

    const webhook = await app.inject({
      method: "POST",
      url: "/v1/webhooks/revenuecat",
      headers: { authorization: "Bearer webhook-secret" },
      payload: {
        api_version: "1.0",
        event: {
          id: randomUUID(),
          app_user_id: userId,
          original_app_user_id: userId,
          aliases: [],
          // These untrusted claims are deliberately contradictory and ignored.
          product_id: "bogus_lifetime_product",
          expiration_at_ms: 9999999999999,
        },
      },
    });
    expect(webhook.statusCode).toBe(200);
    expect(webhook.json()).toMatchObject({
      received: true,
      mapped: true,
      billing: { premium: true },
    });

    fetchMock.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify(inactiveRevenueCatCustomer(productId)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const expired = await app.inject({
      method: "POST",
      url: "/v1/billing/sync",
      headers: auth(token),
      payload: {},
    });
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toMatchObject({
      billing: { premium: false },
      access: { premium: false },
    });
    const entitlement = await pool.query(
      "SELECT 1 FROM entitlement WHERE user_id = $1 AND feature_key = 'premium'",
      [userId],
    );
    expect(entitlement.rowCount).toBe(0);
  });

  it("seeds only the $4.99 monthly and $39.99 annual products with a 7-day annual trial", async () => {
    const result = await pool.query(
      `SELECT product_key, price_usd_cents, period, trial_days
       FROM billing_offering WHERE active ORDER BY display_order`,
    );
    expect(result.rows).toEqual([
      {
        product_key: "premium_monthly_499",
        price_usd_cents: 499,
        period: "monthly",
        trial_days: 0,
      },
      {
        product_key: "premium_annual_3999",
        price_usd_cents: 3999,
        period: "annual",
        trial_days: 7,
      },
    ]);
  });
});
