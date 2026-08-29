import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { QualityDashboardResponse } from "@pickle/api-contracts";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

/**
 * Quality dashboard (Wave I i33). Route-guard tests run without a database;
 * the aggregation itself is exercised against REAL PostgreSQL (skipped
 * visibly without DATABASE_URL_TEST; CI always runs it).
 */

const DEV_SECRET = "quality-secret-0123456789";

function baseConfig(databaseUrl: string | null): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-test",
    databaseUrl,
    devAuthSecret: DEV_SECRET,
    oidcIssuer: undefined,
    oidcAudience: undefined,
    oidcJwksUrl: undefined,
    sqsQueueUrl: undefined,
    consentExportSigningKey: undefined,
    consentExportSigningKeyId: "consent-export-k1",
    appleIapConfigured: false,
    googlePlayConfigured: false,
    adminAuthSubjects: ["auth0|quality-admin"],
  };
}

describe("quality dashboard route guards (no database)", () => {
  const app = buildApp(baseConfig(null));
  afterAll(async () => {
    await app.close();
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/admin/quality-dashboard" });
    expect(res.statusCode).toBe(401);
  });

  it("returns a typed 503 when the database is unavailable (auth requires it)", async () => {
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    const adminToken = await minter.mint("auth0|quality-admin", "admin");
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/quality-dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(503);
    expect((res.json() as { error: { code: string } }).error.code).toBe("auth.db_unavailable");
  });
});

const testUrl = process.env["DATABASE_URL_TEST"];

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

type TrialOverrides = {
  outcomeKind?: string;
  envelopeOverall?: string | null;
  latencyMs?: number | null;
  modelBundleVersion?: string | null;
  strokeLabel?: string | null;
  targetLockStatus?: string;
  resultPresentation?: string | null;
  resultStatus?: string;
  userFlags?: string[];
};

function trialRecord(trialId: string, overrides: TrialOverrides = {}): Record<string, unknown> {
  return {
    schemaVersion: "evaluation-trial-v1",
    trialId,
    captureId: randomUUID(),
    analysisId: null,
    capturedAtIso: new Date().toISOString(),
    recordedAtIso: new Date().toISOString(),
    outcomeKind: overrides.outcomeKind ?? "scored",
    outcomeReason: null,
    envelopeOverall:
      overrides.envelopeOverall === undefined ? "SUPPORTED" : overrides.envelopeOverall,
    latencyMs: overrides.latencyMs === undefined ? null : overrides.latencyMs,
    appVersion: "0.1.0-test",
    engineVersion: null,
    modelBundleVersion:
      overrides.modelBundleVersion === undefined ? "bundle-a" : overrides.modelBundleVersion,
    declaredStroke: null,
    claims: {
      targetLock: { status: overrides.targetLockStatus ?? "presented" },
      eventSelection: { status: "presented", startMs: 0, endMs: 2000 },
      strokeLabel: {
        status:
          overrides.strokeLabel === undefined || overrides.strokeLabel !== null
            ? "presented"
            : "abstained",
        label: overrides.strokeLabel === undefined ? "forehand_drive" : overrides.strokeLabel,
        confidence: 0.9,
      },
      contactMarker: {
        status: "presented",
        estimatedContactMs: 1000,
        ballConfirmed: false,
        paddleConfirmed: false,
      },
      phaseRender: { status: "presented", contactMs: 1000, followThroughEndMs: 1500 },
      resultScore: {
        status: overrides.resultStatus ?? "presented",
        overallScore: 7.1,
        analysisConfidence: 0.9,
        presentation:
          overrides.resultPresentation === undefined ? "normal" : overrides.resultPresentation,
      },
    },
    limitingFactors: [],
    userFlags: overrides.userFlags ?? [],
    dims: {
      userPseudonym: null,
      sessionId: null,
      courtId: null,
      deviceModel: null,
      devicePlatform: "ios",
      osVersion: null,
    },
    consent: { scope: "evaluation_telemetry", consentVersion: "eval-telemetry-v1" },
  };
}

describe.skipIf(!testUrl)("quality dashboard aggregation (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminToken: string;
  let userToken: string;
  const pseudonym = randomUUID();
  const flaggedNormalTrialId = randomUUID();
  const flaggedReviewedTrialId = randomUUID();

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    const insertTrial = async (record: Record<string, unknown>): Promise<void> => {
      await pool.query(
        `INSERT INTO evaluation_trial
           (trial_id, subject_pseudonym, schema_version, consent_version, captured_at, record)
         VALUES ($1, $2, 'evaluation-trial-v1', 'eval-telemetry-v1', now(), $3)`,
        [record["trialId"], pseudonym, JSON.stringify(record)],
      );
    };

    // 6 attempts: 3 scored, 1 low_confidence (abstain), 1 quality_blocked
    // (UNSUPPORTED envelope), 1 unavailable (target lock abstained,
    // unmeasured envelope). Two scored trials are user-flagged.
    await insertTrial(
      trialRecord(flaggedNormalTrialId, {
        latencyMs: 100,
        userFlags: ["score_seems_wrong"],
      }),
    );
    await insertTrial(
      trialRecord(flaggedReviewedTrialId, {
        latencyMs: 200,
        modelBundleVersion: "bundle-b",
        userFlags: ["wrong_stroke_label"],
      }),
    );
    await insertTrial(trialRecord(randomUUID(), { latencyMs: 300, strokeLabel: "backhand_drive" }));
    await insertTrial(
      trialRecord(randomUUID(), {
        outcomeKind: "low_confidence",
        resultStatus: "abstained",
        resultPresentation: "abstain",
        strokeLabel: null,
      }),
    );
    await insertTrial(
      trialRecord(randomUUID(), {
        outcomeKind: "quality_blocked",
        envelopeOverall: "UNSUPPORTED",
        resultStatus: "abstained",
        resultPresentation: "abstain",
        strokeLabel: null,
        modelBundleVersion: null,
      }),
    );
    await insertTrial(
      trialRecord(randomUUID(), {
        outcomeKind: "unavailable",
        envelopeOverall: null,
        targetLockStatus: "abstained",
        resultStatus: "abstained",
        resultPresentation: null,
        strokeLabel: null,
      }),
    );

    // One flagged trial already has a qualified coach review recorded.
    await pool.query(
      `INSERT INTO coach_review
         (review_id, queue_item_id, coach_id, coach_credential_ref, schema_version,
          stroke_taxonomy_version, fault_taxonomy_version, drill_library_version,
          record, qualification_snapshot)
       VALUES ($1, $2, 'coach-real-1', 'credential-ref-1', 3, 'v2', 'v2', 'v1', '{}', '{}')`,
      [`${flaggedReviewedTrialId}.coach-real-1`, flaggedReviewedTrialId],
    );

    await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ('auth0|quality-admin'), ('auth0|quality-user')",
    );
    const user = await pool.query<{ id: string }>(
      "INSERT INTO app_user (auth_subject) VALUES ('auth0|quality-subject') RETURNING id",
    );
    const userId = user.rows[0]!.id;

    // Sessions: 2 started in window, 1 completed.
    await pool.query(
      `INSERT INTO practice_session (id, user_id, mode, started_at, completed)
       VALUES (gen_random_uuid(), $1, 'single', now(), true),
              (gen_random_uuid(), $1, 'single', now(), false)`,
      [userId],
    );

    // Analysis jobs: 3 requested in window (1 failed), 1 queued, 1 processing.
    await pool.query(
      `INSERT INTO analysis_job (user_id, inference_mode, status, requested_at)
       VALUES
         ($1, 'on_device', 'complete', now()),
         ($1, 'on_device', 'failed', now()),
         ($1, 'on_device', 'queued', now() - interval '2 minutes'),
         ($1, 'on_device', 'processing', now())`,
      [userId],
    );

    // Deletion tasks: 1 queued, 1 failed in window.
    await pool.query(
      `INSERT INTO deletion_task (user_id, kind, status)
       VALUES ($1, 'media_purge', 'queued'), ($1, 'social_cleanup', 'failed')`,
      [userId],
    );

    // One not-helpful shot rating on a minimal real shot.
    const shot = await pool.query<{ id: string }>(
      `INSERT INTO shot
         (id, user_id, shot_type_id, captured_at, start_ms, end_ms, confidence,
          result_kind, source, model_bundle_version, version_vector)
       SELECT gen_random_uuid(), $1, id, now(), 0, 2000, 0.4,
              'low_confidence', 'real', 'bundle-a', '{}'::jsonb
       FROM shot_type LIMIT 1
       RETURNING id`,
      [userId],
    );
    await pool.query(
      "INSERT INTO shot_rating (shot_id, user_id, helpful, reason) VALUES ($1, $2, false, 'wrong')",
      [shot.rows[0]!.id, userId],
    );

    app = buildApp(baseConfig(testUrl!));
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint("auth0|quality-admin", "admin");
    userToken = await minter.mint("auth0|quality-user");
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("rejects non-admin tokens", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/quality-dashboard",
      headers: { authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("produces the full aggregate, matches the typed contract, and audits the read", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/quality-dashboard?windowDays=7",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    const parsed = QualityDashboardResponse.safeParse(res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    const body = parsed.data!;

    expect(body.trials.attempts).toBe(6);
    expect(body.trials.outcomeCounts).toEqual({
      scored: 3,
      low_confidence: 1,
      unavailable: 1,
      quality_blocked: 1,
    });
    expect(body.trials.completion).toEqual({ numerator: 4, denominator: 6, rate: 4 / 6 });
    expect(body.trials.usableResult).toEqual({ numerator: 3, denominator: 6, rate: 0.5 });
    expect(body.trials.abstention).toEqual({ numerator: 3, denominator: 6, rate: 0.5 });
    expect(body.trials.envelopeRejection).toEqual({ numerator: 1, denominator: 5, rate: 0.2 });
    expect(body.trials.targetLockSuccess).toEqual({ numerator: 5, denominator: 6, rate: 5 / 6 });
    expect(body.trials.strokeDistribution).toEqual([
      { key: "forehand_drive", count: 2 },
      { key: "backhand_drive", count: 1 },
    ]);
    expect(body.trials.latency).toEqual({ measuredCount: 3, p50Ms: 200, p90Ms: 280, p99Ms: 298 });
    expect(body.trials.modelVersionDistribution).toEqual([
      { key: "bundle-a", count: 4 },
      { key: "bundle-b", count: 1 },
      { key: "unreported", count: 1 },
    ]);
    expect(body.trials.userReportedWrongTrialCount).toBe(2);

    expect(body.sessions).toEqual({
      started: 2,
      completed: 1,
      completion: { numerator: 1, denominator: 2, rate: 0.5 },
    });

    expect(body.crashFree.status).toBe("not_evaluable");

    expect(body.backend.analysisJobs).toEqual({
      requested: 4,
      failed: 1,
      failureRate: { numerator: 1, denominator: 4, rate: 0.25 },
    });
    expect(body.backend.deletionTasksFailed).toBe(1);
    expect(body.backend.apiErrors).toHaveProperty("status", "not_evaluable");

    expect(body.queues.analysisQueued).toBe(1);
    expect(body.queues.analysisProcessing).toBe(1);
    expect(body.queues.oldestAnalysisQueuedAgeSeconds).toBeGreaterThan(60);
    expect(body.queues.deletionQueued).toBe(1);
    expect(body.queues.deletionProcessing).toBe(0);

    expect(body.review.userReportedWrongShotRatings).toBe(1);
    // Two user-flagged trials; one already has a coach review → depth 1.
    expect(body.review.coachReviewQueueDepth).toBe(1);
    // The pending flagged trial presented a scored Result at normal
    // confidence → candidate silent failure.
    expect(body.review.silentFailureQueueDepth).toBe(1);
    expect(body.review.coachReviewsRecorded).toBe(1);

    const audited = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.quality_dashboard_viewed'",
    );
    expect(audited.rows[0]!.n).toBe(1);
  });

  it("rejects an out-of-range window", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/quality-dashboard?windowDays=365",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it("exposes no media URLs, user ids, or per-user rows", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/quality-dashboard",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const raw = res.body;
    expect(raw).not.toContain(pseudonym);
    expect(raw).not.toMatch(/storage_key|https?:\/\//);
    expect(raw).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
