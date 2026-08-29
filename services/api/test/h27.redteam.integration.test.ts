import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { IObjectStore } from "../src/modules/media/objectStore.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";

/**
 * Wave H h27 red-team regressions against a REAL PostgreSQL schema. Each test
 * here reproduces an attack that broke the release candidate:
 *  - cross-user session attachment through POST /v1/analyses (privilege bypass)
 *  - malformed request/identifier abuse answered with 500 api.internal_error
 *  - a late offline shot leaving a finalized session's summary lying
 *  - an in-flight video completing after the user disabled cloud sync
 *  - a future-dated consent decision resurrecting withdrawn model training
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "h27-redteam-secret-0123456789";
const schemaName = `h27_redteam_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

class FakeObjectStore implements IObjectStore {
  readonly bucket = "h27-bucket";
  objects = new Map<string, number>();
  deletedKeys: string[] = [];

  async presignUpload(key: string): Promise<string> {
    return `https://fake/upload/${key}`;
  }
  async presignDownload(key: string): Promise<string> {
    return `https://fake/download/${key}`;
  }
  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
    this.deletedKeys.push(key);
  }
  async headObject(key: string): Promise<{ sizeBytes: number } | null> {
    const size = this.objects.get(key);
    return size === undefined ? null : { sizeBytes: size };
  }
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

function versionVector() {
  return {
    appVersion: "0.1.0",
    modelBundleVersion: "test-native-1",
    poseModelVersion: "test-pose-1",
    paddleModelVersion: "test-paddle-1",
    strokeDetectorVersion: "test-stroke-1",
    phaseModelVersion: "test-phase-1",
    scoringModelVersion: "sm-v1",
    shotConfigVersion: "forehand_drive@1",
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
    overallScore: 7,
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
    ],
    versionVector: versionVector(),
    ...overrides,
  };
}

describe.skipIf(!testUrl)("h27 product red-team regressions (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let store: FakeObjectStore;
  let victimToken: string;
  let attackerToken: string;
  let victimId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

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
    store = new FakeObjectStore();
    app = buildApp(config, { queue: new InMemoryJobQueue(), objectStore: store });

    const minter = new DevTokenVerifier("test", secret);
    victimToken = await minter.mint(`h27-victim|${randomUUID()}`);
    attackerToken = await minter.mint(`h27-attacker|${randomUUID()}`);
    for (const token of [victimToken, attackerToken]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
      expect(res.statusCode, res.body).toBe(200);
      if (token === victimToken) victimId = (res.json() as { user: { id: string } }).user.id;
    }
    // Premium entitlement: these attacks need more than the free rating credits.
    for (const subject of ["h27-victim", "h27-attacker"]) {
      await pool.query(
        `INSERT INTO entitlement (user_id, feature_key, valid_from)
         SELECT id, 'premium', now() FROM app_user WHERE auth_subject LIKE $1`,
        [`${subject}|%`],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  async function permitFor(token: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(token),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { permit: { id: string } }).permit.id;
  }

  async function createSession(token: string): Promise<string> {
    const id = randomUUID();
    const res = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: auth(token),
      payload: {
        id,
        mode: "live",
        shotType: "forehand_drive",
        focusCheckpoint: "contact_position",
        cameraView: "side",
        startedAt: new Date().toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    return id;
  }

  it("rejects an analysis job attached to another user's session", async () => {
    const victimSession = await createSession(victimToken);
    const permitId = await permitFor(attackerToken);
    const res = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(attackerToken),
      payload: {
        mediaAssetId: null,
        localAnalysisId: randomUUID(),
        expectedShotType: null,
        inferenceMode: "on_device",
        sessionId: victimSession,
        permitId,
      },
    });
    expect(res.statusCode, res.body).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("session.not_found");
    const rows = await pool.query("SELECT id FROM analysis_job WHERE session_id = $1", [
      victimSession,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it("answers malformed path identifiers with a typed 400, never a 500", async () => {
    const routes: Array<[string, string, unknown]> = [
      ["GET", "/v1/sessions/not-a-uuid", undefined],
      ["PATCH", "/v1/sessions/not-a-uuid", { completed: true }],
      ["POST", "/v1/sessions/not-a-uuid/finalize", {}],
      ["GET", "/v1/shots/not-a-uuid", undefined],
      ["GET", "/v1/analyses/not-a-uuid", undefined],
      ["POST", "/v1/analyses/not-a-uuid/cancel", {}],
      ["GET", "/v1/media/not-a-uuid", undefined],
      ["DELETE", "/v1/media/not-a-uuid", undefined],
      ["GET", "/v1/share-cards/not-a-uuid", undefined],
      ["GET", "/v1/training-plans/not-a-uuid", undefined],
      ["PATCH", "/v1/me/goals/not-a-uuid", { status: "completed" }],
      ["POST", "/v1/friends/not-a-uuid/accept", {}],
      ["DELETE", "/v1/friends/not-a-uuid", undefined],
    ];
    for (const [method, url, payload] of routes) {
      const res = await app.inject({
        method: method as "GET" | "POST" | "PATCH" | "DELETE",
        url,
        headers: auth(victimToken),
        ...(payload === undefined ? {} : { payload: payload as object }),
      });
      expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("validation.path_id");
    }
  });

  it("answers malformed request bodies and unsupported content types with typed 4xx", async () => {
    const cases: Array<[string, string, string, number]> = [
      ["malformed json", "{oops", "application/json", 400],
      ["empty json body", "", "application/json", 400],
      ["prototype poisoning", '{"__proto__":{"polluted":true}}', "application/json", 400],
      ["form content type", "handle=x", "application/x-www-form-urlencoded", 415],
      [
        "oversize body",
        JSON.stringify({ displayName: "x".repeat(2 * 1024 * 1024) }),
        "application/json",
        413,
      ],
    ];
    for (const [name, body, contentType, expected] of cases) {
      const res = await app.inject({
        method: "PATCH",
        url: "/v1/me/profile",
        headers: { ...auth(victimToken), "content-type": contentType },
        payload: body,
      });
      expect(res.statusCode, `${name} -> ${res.body}`).toBe(expected);
      const error = (res.json() as { error: { code: string } }).error;
      expect(error.code, name).not.toBe("api.internal_error");
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("recomputes a finalized session summary when a late offline shot arrives", async () => {
    const sessionId = await createSession(victimToken);
    const first = shotPayload({
      sessionId,
      analysisPermitId: await permitFor(victimToken),
      overallScore: 4,
      capturedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const firstSync = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(victimToken),
      payload: { shots: [first] },
    });
    expect((firstSync.json() as { acceptedIds: string[] }).acceptedIds).toHaveLength(1);

    const finalize = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/finalize`,
      headers: auth(victimToken),
      payload: {},
    });
    expect(finalize.statusCode, finalize.body).toBe(200);

    // The device flushes a shot it recorded before finalizing but synced after.
    const late = shotPayload({
      sessionId,
      analysisPermitId: await permitFor(victimToken),
      overallScore: 8,
      capturedAt: new Date().toISOString(),
    });
    const lateSync = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(victimToken),
      payload: { shots: [late] },
    });
    expect((lateSync.json() as { acceptedIds: string[] }).acceptedIds).toHaveLength(1);

    const view = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}`,
      headers: auth(victimToken),
    });
    const body = view.json() as {
      session: { shot_count: number; avg_score: string | number | null };
      shots: unknown[];
      summary: {
        valid_shot_count: number;
        average_score: string | number;
        best_score: string | number;
      };
    };
    expect(body.shots).toHaveLength(2);
    expect(Number(body.summary.valid_shot_count)).toBe(2);
    expect(Number(body.summary.average_score)).toBeCloseTo(6, 5);
    expect(Number(body.summary.best_score)).toBeCloseTo(8, 5);
    expect(Number(body.session.avg_score)).toBeCloseTo(6, 5);
  });

  it("discards an in-flight upload completed after cloud sync is disabled", async () => {
    await app.inject({
      method: "PATCH",
      url: "/v1/me/settings",
      headers: auth(victimToken),
      payload: { cloudSyncEnabled: true },
    });
    const upload = await app.inject({
      method: "POST",
      url: "/v1/media/uploads",
      headers: auth(victimToken),
      payload: {
        kind: "raw_video",
        filename: "clip.mp4",
        bytes: 1024,
        contentType: "video/mp4",
        sha256: "a".repeat(64),
      },
    });
    expect(upload.statusCode, upload.body).toBe(200);
    const { mediaAssetId } = upload.json() as { mediaAssetId: string };
    const keyRow = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
      mediaAssetId,
    ]);
    store.objects.set(keyRow.rows[0].object_key as string, 1024);

    await app.inject({
      method: "PATCH",
      url: "/v1/me/settings",
      headers: auth(victimToken),
      payload: { cloudSyncEnabled: false },
    });
    const complete = await app.inject({
      method: "POST",
      url: `/v1/media/${mediaAssetId}/complete`,
      headers: auth(victimToken),
      payload: {},
    });
    expect(complete.statusCode, complete.body).toBe(403);
    expect((complete.json() as { error: { code: string } }).error.code).toBe(
      "media.cloud_sync_disabled",
    );
    const state = await pool.query(
      "SELECT status, deleted_at IS NOT NULL AS deleted FROM media_asset WHERE id = $1",
      [mediaAssetId],
    );
    expect(state.rows[0].status).toBe("deleted");
    expect(state.rows[0].deleted).toBe(true);
    const playback = await app.inject({
      method: "GET",
      url: `/v1/media/${mediaAssetId}`,
      headers: auth(victimToken),
    });
    expect(playback.statusCode).toBe(404);
  });

  it("refuses a future-dated consent decision that would resurrect withdrawn training consent", async () => {
    const grant = (over: Record<string, unknown> = {}) =>
      app.inject({
        method: "POST",
        url: "/v1/me/consent/grant",
        headers: auth(victimToken),
        payload: {
          scope: "model_training",
          consentVersion: "model-training-v1",
          source: "onboarding",
          captureMode: "all_captures",
          decisionId: randomUUID(),
          decidedAtIso: new Date().toISOString(),
          ...over,
        },
      });

    expect((await grant()).statusCode).toBe(200);
    const withdrawn = await app.inject({
      method: "POST",
      url: "/v1/me/consent/withdraw",
      headers: auth(victimToken),
      payload: { scope: "model_training", source: "mobile_settings" },
    });
    expect(withdrawn.statusCode, withdrawn.body).toBe(200);

    // A device whose clock runs an hour fast must not be able to out-rank the
    // withdrawal it has not seen yet.
    const skewed = await grant({
      decidedAtIso: new Date(Date.now() + 60 * 60_000).toISOString(),
    });
    expect(skewed.statusCode, skewed.body).toBe(409);
    expect((skewed.json() as { error: { code: string } }).error.code).toBe(
      "consent.decision_future_dated",
    );

    const status = await app.inject({
      method: "GET",
      url: "/v1/me/consent/status",
      headers: auth(victimToken),
    });
    const training = (
      status.json() as { scopes: Array<{ scope: string; active: boolean }> }
    ).scopes.find((s) => s.scope === "model_training");
    expect(training?.active).toBe(false);
  });

  it("refuses an admin token claim for a subject outside the admin allowlist", async () => {
    const minter = new DevTokenVerifier("test", secret);
    const forgedSubject = `h27-escalate|${randomUUID()}`;
    const forged = await minter.mint(forgedSubject, "admin");
    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(forged),
      payload: bootstrapBody,
    });
    expect(bootstrap.statusCode, bootstrap.body).toBe(200);
    for (const [method, url, payload] of [
      ["GET", `/v1/admin/users/${victimId}`, undefined],
      ["PUT", "/v1/admin/flags/h27-flag", { enabled: true }],
    ] as const) {
      const res = await app.inject({
        method,
        url,
        headers: auth(forged),
        ...(payload === undefined ? {} : { payload }),
      });
      expect(res.statusCode, `${method} ${url} -> ${res.body}`).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "auth.admin_not_authorized",
      );
    }
    const flag = await pool.query("SELECT key FROM feature_flag WHERE key = $1", ["h27-flag"]);
    expect(flag.rowCount).toBe(0);
  });

  it("still accepts a legitimately late decision inside the tolerated clock skew", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: auth(attackerToken),
      payload: {
        scope: "video_analysis",
        consentVersion: "video-analysis-v1",
        source: "onboarding",
        captureMode: "all_captures",
        decisionId: randomUUID(),
        decidedAtIso: new Date(Date.now() + 30_000).toISOString(),
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  });
});
