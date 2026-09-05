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
import {
  AnalysisRunError,
  recordReprocessedAnalysisRun,
  runsForShot,
  type AnalysisRunRow,
} from "../src/modules/shots/analysisRuns.js";

/**
 * Score-version governance (spec pp. 22, 44) against a REAL PostgreSQL
 * database: every score is bound to its scoring model version, analysis runs
 * are immutable append-only history, and progress series never silently span
 * incomparable versions — boundaries surface as explicit version transitions.
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

function versionVector(scoringModelVersion: string) {
  return {
    appVersion: "0.1.0",
    modelBundleVersion: "test-native-1",
    poseModelVersion: "test-pose-1",
    paddleModelVersion: "test-paddle-1",
    strokeDetectorVersion: "test-stroke-1",
    phaseModelVersion: "test-phase-1",
    scoringModelVersion,
    shotConfigVersion: "forehand_drive@1",
  };
}

function shotPayload(
  permitId: string,
  scoringModelVersion: string,
  capturedAt: string,
  overallScore: number,
) {
  return {
    id: randomUUID(),
    sessionId: null,
    analysisPermitId: permitId,
    shotType: "forehand_drive",
    cameraView: "side",
    capturedAt,
    timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
    overallScore,
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
    versionVector: versionVector(scoringModelVersion),
  };
}

/**
 * Test-only second scoring model version (sm-v2) for forehand_drive: staged as
 * `validating`, then released through the audited admin release route, which
 * supersedes the live sm-v1 (status `superseded`, `active_to` set) so exactly
 * one open-ended active model remains — the same path production releases take.
 */
async function publishTestSmV2(
  app: FastifyInstance,
  pool: pg.Pool,
  adminToken: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO scoring_model (shot_type_id, version, status,
       min_analysis_confidence, lower_confidence_threshold, config)
     SELECT st.id, 'sm-v2', 'validating', 0.65, 0.80,
            jsonb_build_object('shotConfigVersion', 'forehand_drive@1')
     FROM shot_type st WHERE st.slug = 'forehand_drive'`,
  );
  const released = await app.inject({
    method: "PUT",
    url: "/v1/admin/scoring-models/forehand_drive/sm-v2/release",
    headers: { authorization: `Bearer ${adminToken}` },
    payload: {
      modelBundleVersion: "test-native-1",
      datasetSnapshotId: "test-only-dataset-snapshot",
      evaluationReportSha256: "b".repeat(64),
      coachValidationReference: "test-only-coach-review",
    },
  });
  expect(released.statusCode, released.body).toBe(200);
}

describe.skipIf(!testUrl)("score-version governance (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let userToken: string;
  let adminToken: string;

  beforeAll(async () => {
    const setupPool = new pg.Pool({ connectionString: testUrl });
    await setupPool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(setupPool, migrationsDir);
    await seed(setupPool);
    await publishTestScoringRelease(setupPool);
    await setupPool.end();

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
      adminAuthSubjects: ["auth0|sv-admin"],
    };
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    pool = new pg.Pool({ connectionString: testUrl });

    const minter = new DevTokenVerifier("test", DEV_SECRET);
    userToken = await minter.mint("auth0|sv-user");
    adminToken = await minter.mint("auth0|sv-admin", "admin");
    for (const token of [userToken, adminToken]) {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          locale: "en-US",
          timezone: "UTC",
          device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
        },
      });
      expect(bootstrap.statusCode).toBe(200);
    }
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const auth = () => ({ authorization: `Bearer ${userToken}` });

  async function reservePermit(): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    return (response.json() as { permit: { id: string } }).permit.id;
  }

  async function syncShot(payload: ReturnType<typeof shotPayload>): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(),
      payload: { shots: [payload] },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { acceptedIds: string[]; rejected: unknown[] };
    expect(body.rejected, JSON.stringify(body.rejected)).toHaveLength(0);
    expect(body.acceptedIds).toContain(payload.id);
  }

  let smV1ShotId: string;
  let smV1RunId: string;

  it("every synced score creates an analysis run bound to its scoring model version", async () => {
    const payload = shotPayload(await reservePermit(), "sm-v1", "2026-08-20T12:00:00.000Z", 6.2);
    smV1ShotId = payload.id;
    await syncShot(payload);

    const runs = await runsForShot(pool, smV1ShotId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.scoring_model_version).toBe("sm-v1");
    expect(runs[0]!.result_kind).toBe("scored");
    expect(Number(runs[0]!.overall_score)).toBeCloseTo(6.2);
    expect(runs[0]!.supersedes_run_id).toBeNull();
    smV1RunId = runs[0]!.id;
  });

  it("analysis runs can never be updated or deleted", async () => {
    await expect(
      pool.query("UPDATE analysis_run SET overall_score = 9.9 WHERE id = $1", [smV1RunId]),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("DELETE FROM analysis_run WHERE id = $1", [smV1RunId])).rejects.toThrow(
      /immutable/,
    );
    const runs = await runsForShot(pool, smV1ShotId);
    expect(runs).toHaveLength(1);
    expect(Number(runs[0]!.overall_score)).toBeCloseTo(6.2);
  });

  it("a scored shot cannot exist without a scoring model version binding", async () => {
    await expect(
      pool.query(
        `INSERT INTO shot (id, user_id, shot_type_id, scoring_model_id, captured_at,
           start_ms, end_ms, overall_score, confidence, result_kind, source,
           model_bundle_version, version_vector)
         SELECT $1, s.user_id, s.shot_type_id, NULL, now(), 0, 100, 5.0, 0.9,
                'scored', 'real', 'test-native-1', '{}'::jsonb
         FROM shot s WHERE s.id = $2`,
        [randomUUID(), smV1ShotId],
      ),
    ).rejects.toThrow(/scored_shots_have_scoring_version/);
  });

  it("releasing sm-v2 supersedes sm-v1 — one open-ended active model per shot type", async () => {
    await publishTestSmV2(app, pool, adminToken);

    const models = await pool.query<{
      version: string;
      status: string;
      active_to: Date | null;
    }>(
      `SELECT sm.version, sm.status, sm.active_to
       FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
       WHERE st.slug = 'forehand_drive' ORDER BY sm.version`,
    );
    expect(models.rows.map((m) => [m.version, m.status, m.active_to === null])).toEqual([
      ["sm-v1", "superseded", false],
      ["sm-v2", "active", true],
    ]);
  });

  it("progress series stay per-version and the version boundary is an explicit transition", async () => {
    const payload = shotPayload(await reservePermit(), "sm-v2", "2026-08-25T12:00:00.000Z", 9.1);
    await syncShot(payload);

    const response = await app.inject({ method: "GET", url: "/v1/progress", headers: auth() });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      series: Array<{
        day: string;
        shot_type: string;
        scoring_model_version: string;
        shot_count: number;
        avg_score: string;
      }>;
      versionTransitions: Array<{
        shotType: string;
        day: string;
        fromVersion: string;
        toVersion: string;
        comparable: boolean;
      }>;
    };

    // No aggregate row ever mixes versions: each day/type/version is separate.
    expect(body.series).toHaveLength(2);
    const v1Point = body.series.find((p) => p.scoring_model_version === "sm-v1");
    const v2Point = body.series.find((p) => p.scoring_model_version === "sm-v2");
    expect(v1Point?.avg_score).toBe("62.0");
    expect(v2Point?.avg_score).toBe("91.0");

    // The sm-v1 → sm-v2 boundary is rendered, and — with no calibration
    // declaration — marked incomparable. A continuous "improvement" line
    // across the recalibration is impossible to fabricate.
    expect(body.versionTransitions).toEqual([
      {
        shotType: "forehand_drive",
        day: "2026-08-25",
        fromVersion: "sm-v1",
        toVersion: "sm-v2",
        comparable: false,
      },
    ]);
  });

  it("an explicit calibration declaration is the only way a transition becomes comparable", async () => {
    await pool.query(
      `INSERT INTO scoring_version_comparability
         (shot_type_id, from_version, to_version, calibration_evidence_ref, declared_by)
       SELECT st.id, 'sm-v1', 'sm-v2', 'test-only-calibration-report',
              (SELECT id FROM app_user WHERE auth_subject = 'test-only|scoring-release-actor')
       FROM shot_type st WHERE st.slug = 'forehand_drive'`,
    );
    const response = await app.inject({ method: "GET", url: "/v1/progress", headers: auth() });
    const body = response.json() as {
      versionTransitions: Array<{ comparable: boolean }>;
    };
    expect(body.versionTransitions).toHaveLength(1);
    expect(body.versionTransitions[0]!.comparable).toBe(true);
  });

  it("reprocessing creates a NEW run preserving the old run's score, version, and timestamps", async () => {
    const before = await runsForShot(pool, smV1ShotId);
    const original = before.find((run) => run.id === smV1RunId)!;

    const smV2ModelId = await pool.query<{ id: string }>(
      `SELECT sm.id FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
       WHERE st.slug = 'forehand_drive' AND sm.version = 'sm-v2'`,
    );
    const reprocessed = await recordReprocessedAnalysisRun(pool, {
      supersededRunId: smV1RunId,
      scoringModelId: smV2ModelId.rows[0]!.id,
      scoringModelVersion: "sm-v2",
      overallScore: 5.4,
      resultKind: "scored",
      producedAt: "2026-08-27T12:00:00.000Z",
    });
    expect(reprocessed.id).not.toBe(smV1RunId);
    expect(reprocessed.supersedes_run_id).toBe(smV1RunId);
    expect(reprocessed.scoring_model_version).toBe("sm-v2");

    const after = await runsForShot(pool, smV1ShotId);
    expect(after).toHaveLength(2);
    const preserved = after.find((run: AnalysisRunRow) => run.id === smV1RunId)!;
    expect(preserved.scoring_model_version).toBe("sm-v1");
    expect(Number(preserved.overall_score)).toBeCloseTo(6.2);
    expect(preserved.produced_at).toEqual(original.produced_at);
    expect(preserved.created_at).toEqual(original.created_at);
  });

  it("rejects reprocessing under the same version or of unknown runs", async () => {
    const smV1ModelId = await pool.query<{ id: string }>(
      `SELECT sm.id FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
       WHERE st.slug = 'forehand_drive' AND sm.version = 'sm-v1'`,
    );
    await expect(
      recordReprocessedAnalysisRun(pool, {
        supersededRunId: smV1RunId,
        scoringModelId: smV1ModelId.rows[0]!.id,
        scoringModelVersion: "sm-v1",
        overallScore: 8.8,
        resultKind: "scored",
        producedAt: "2026-08-27T12:00:00.000Z",
      }),
    ).rejects.toThrow(AnalysisRunError);
    await expect(
      recordReprocessedAnalysisRun(pool, {
        supersededRunId: randomUUID(),
        scoringModelId: smV1ModelId.rows[0]!.id,
        scoringModelVersion: "sm-v2",
        overallScore: 8.8,
        resultKind: "scored",
        producedAt: "2026-08-27T12:00:00.000Z",
      }),
    ).rejects.toThrow(/unknown analysis run/);
  });
});
