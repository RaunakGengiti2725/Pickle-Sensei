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

/**
 * i08-user-feedback, end to end against real PostgreSQL: the "Was this
 * analysis accurate?" endpoint stores an append-only failure-mining signal
 * with the shot's version vector, derives review eligibility from the REAL
 * consent ledger (active model_training grant — nothing else), and feeds
 * the hard-case queue view only with negative, review-eligible rows whose
 * consent is STILL active.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "feedback-secret-0123456789";
const schemaName = `feedback_it_${process.pid}_${randomUUID().replaceAll("-", "")}`;

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

const VERSION_VECTOR = {
  appVersion: "0.1.0",
  modelBundleVersion: "bundle-test-1",
  poseModelVersion: "pose-test-1",
  paddleModelVersion: "paddle-test-1",
  strokeDetectorVersion: "stroke-test-1",
  phaseModelVersion: "phase-test-1",
  scoringModelVersion: "scoring-test-1",
  shotConfigVersion: "config-test-1",
};

describe.skipIf(!testUrl)("analysis feedback (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  let otherToken: string;
  let userId: string;
  let otherId: string;

  const headers = () => ({ authorization: `Bearer ${userToken}` });

  async function insertShot(ownerId: string): Promise<string> {
    const shotId = randomUUID();
    const shotType = await pool.query("SELECT id FROM shot_type LIMIT 1");
    const scoringModel = await pool.query(
      "SELECT id FROM scoring_model WHERE shot_type_id = $1 LIMIT 1",
      [shotType.rows[0].id],
    );
    await pool.query(
      `INSERT INTO shot (id, user_id, shot_type_id, scoring_model_id, captured_at, start_ms, contact_ms, end_ms,
         overall_score, confidence, result_kind, source, model_bundle_version, version_vector)
       VALUES ($1,$2,$3,$4,now(),0,450,900,7.2,0.91,'scored','real',$5,$6)`,
      [
        shotId,
        ownerId,
        shotType.rows[0].id,
        scoringModel.rows[0].id,
        VERSION_VECTOR.modelBundleVersion,
        VERSION_VECTOR,
      ],
    );
    return shotId;
  }

  async function grantConsent(scope: string, consentVersion: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: {
        scope,
        consentVersion,
        source: "mobile_settings",
        device: "iPhone16,1",
        captureMode: "all_captures",
      },
    });
    expect(res.statusCode).toBe(200);
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-test",
      databaseUrl: scopedUrl,
      devAuthSecret: DEV_SECRET,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    userToken = await minter.mint("auth0|feedback-user");
    otherToken = await minter.mint("auth0|feedback-other");

    for (const token of [userToken, otherToken]) {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: { authorization: `Bearer ${token}` },
        payload: {
          locale: "en-US",
          timezone: "America/Los_Angeles",
          device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
        },
      });
      expect(bootstrap.statusCode).toBe(200);
      const id = (bootstrap.json() as { user: { id: string } }).user.id;
      if (token === userToken) userId = id;
      else otherId = id;
    }
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  it("requires authentication", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${randomUUID()}/feedback`,
      payload: { rating: "accurate", category: null },
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects a negative rating without a category, and a category on a positive one", async () => {
    const shotId = await insertShot(userId);
    for (const payload of [
      { rating: "not_quite", category: null },
      { rating: "accurate", category: "wrong_stroke" },
      { rating: "not_quite", category: "blurry_video" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: `/v1/analyses/${shotId}/feedback`,
        headers: headers(),
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "validation.analysis_feedback",
      );
    }
  });

  it("404s on an analysis the caller does not own — possession of a UUID grants nothing", async () => {
    const foreignShot = await insertShot(otherId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${foreignShot}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "wrong_player" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("stores feedback with the shot's version vector; no consent ledger means NOT review-eligible", async () => {
    const shotId = await insertShot(userId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "wrong_stroke" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { feedback: { reviewEligible: boolean; analysisId: string } };
    expect(body.feedback.reviewEligible).toBe(false);
    expect(body.feedback.analysisId).toBe(shotId);

    const row = await pool.query(
      "SELECT version_vector, signal_kind, review_eligible FROM analysis_feedback WHERE analysis_id = $1",
      [shotId],
    );
    expect(row.rows[0].version_vector).toEqual(VERSION_VECTOR);
    expect(row.rows[0].signal_kind).toBe("user_feedback_failure_mining");
    expect(row.rows[0].review_eligible).toBe(false);

    const queue = await pool.query(
      "SELECT id FROM analysis_feedback_hard_case_queue WHERE analysis_id = $1",
      [shotId],
    );
    expect(queue.rowCount).toBe(0);
  });

  it("video_analysis consent alone does NOT make feedback review-eligible", async () => {
    await grantConsent("video_analysis", "video-analysis-v1");
    const shotId = await insertShot(userId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "contact_looks_wrong" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { feedback: { reviewEligible: boolean } }).feedback.reviewEligible).toBe(
      false,
    );
    const queue = await pool.query(
      "SELECT id FROM analysis_feedback_hard_case_queue WHERE analysis_id = $1",
      [shotId],
    );
    expect(queue.rowCount).toBe(0);
  });

  it("an active model_training grant makes negative feedback feed the hard-case queue", async () => {
    await grantConsent("model_training", "model-training-v1");
    const shotId = await insertShot(userId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "feedback_mismatch" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { feedback: { reviewEligible: boolean } }).feedback.reviewEligible).toBe(
      true,
    );
    const queue = await pool.query(
      "SELECT category FROM analysis_feedback_hard_case_queue WHERE analysis_id = $1",
      [shotId],
    );
    expect(queue.rowCount).toBe(1);
    expect(queue.rows[0].category).toBe("feedback_mismatch");
  });

  it("positive feedback never enters the hard-case queue, even when review-eligible", async () => {
    const shotId = await insertShot(userId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "accurate", category: null },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { feedback: { reviewEligible: boolean } }).feedback.reviewEligible).toBe(
      true,
    );
    const queue = await pool.query(
      "SELECT id FROM analysis_feedback_hard_case_queue WHERE analysis_id = $1",
      [shotId],
    );
    expect(queue.rowCount).toBe(0);
  });

  it("model_training withdrawal removes queued items WITHOUT rewriting the feedback record", async () => {
    const shotId = await insertShot(userId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "wrong_player" },
    });
    expect(res.statusCode).toBe(201);
    expect(
      (
        await pool.query(
          "SELECT id FROM analysis_feedback_hard_case_queue WHERE analysis_id = $1",
          [shotId],
        )
      ).rowCount,
    ).toBe(1);

    const withdraw = await app.inject({
      method: "POST",
      url: "/v1/me/consent/withdraw",
      headers: headers(),
      payload: { scope: "model_training", source: "mobile_settings" },
    });
    expect(withdraw.statusCode).toBe(200);

    expect(
      (
        await pool.query(
          "SELECT id FROM analysis_feedback_hard_case_queue WHERE analysis_id = $1",
          [shotId],
        )
      ).rowCount,
    ).toBe(0);
    // The append-only record itself is untouched: its at-submission snapshot survives.
    const row = await pool.query(
      "SELECT rating, review_eligible FROM analysis_feedback WHERE analysis_id = $1",
      [shotId],
    );
    expect(row.rows[0]).toEqual({ rating: "not_quite", review_eligible: true });
  });

  it("feedback after withdrawal is stored but NOT review-eligible", async () => {
    const shotId = await insertShot(userId);
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "other" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { feedback: { reviewEligible: boolean } }).feedback.reviewEligible).toBe(
      false,
    );
  });

  it("second submission for the same analysis is rejected — a signal is not rewritten", async () => {
    const shotId = await insertShot(userId);
    const first = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "accurate", category: null },
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "other" },
    });
    expect(second.statusCode).toBe(409);
    expect((second.json() as { error: { code: string } }).error.code).toBe(
      "analysis.feedback_exists",
    );
  });

  it("the table is append-only at the DB level: UPDATE and DELETE are rejected", async () => {
    const shotId = await insertShot(userId);
    await app.inject({
      method: "POST",
      url: `/v1/analyses/${shotId}/feedback`,
      headers: headers(),
      payload: { rating: "not_quite", category: "other" },
    });
    await expect(
      pool.query("UPDATE analysis_feedback SET rating = 'accurate' WHERE analysis_id = $1", [
        shotId,
      ]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM analysis_feedback WHERE analysis_id = $1", [shotId]),
    ).rejects.toThrow(/append-only/);
  });

  it("the DB refuses to re-tag feedback as anything but failure mining", async () => {
    const shotId = await insertShot(userId);
    await expect(
      pool.query(
        `INSERT INTO analysis_feedback (analysis_id, user_id, rating, category, signal_kind, version_vector, review_eligible)
         VALUES ($1,$2,'not_quite','other','gold_label',$3,true)`,
        [shotId, userId, VERSION_VECTOR],
      ),
    ).rejects.toThrow(/signal_kind/);
  });
});
