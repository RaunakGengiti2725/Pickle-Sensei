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

/**
 * "Report bad analysis" integration suite against a REAL PostgreSQL database
 * (isolated schema). Covers auth, ownership, input validation (including the
 * strict safe-diagnostics allowlist that keeps media out of triage),
 * idempotent replay, the admin triage queue, and per-caller rate limiting.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "analysis-report-secret-0123456789";
const ADMIN_SUBJECT = "auth0|report-itest-admin";
const schemaName = `analysis_report_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

function reportPayload(overrides: Record<string, unknown> = {}) {
  return {
    failureCategory: "wrong_shot_type",
    comment: "Scored my backhand as a forehand drive.",
    appVersion: "0.1.0",
    device: { platform: "ios", osVersion: "18.0", model: "iPhone16,1" },
    versionVector: versionVector(),
    diagnostics: {
      overallScore: 7.4,
      confidence: 0.91,
      detectedShotType: "forehand_drive",
      inferenceLatencyMs: 850,
      thermalState: "nominal",
    },
    ...overrides,
  };
}

describe.skipIf(!testUrl)("analysis issue reports (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  let strangerToken: string;
  let adminToken: string;
  let analysisId: string;
  let reportId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function bootstrap(token: string): Promise<void> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(res.statusCode, res.body).toBe(200);
  }

  async function createAnalysis(token: string): Promise<string> {
    const permit = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(token),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(permit.statusCode, permit.body).toBe(200);
    const permitId = (permit.json() as { permit: { id: string } }).permit.id;
    const created = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(token),
      payload: {
        mediaAssetId: null,
        localAnalysisId: randomUUID(),
        expectedShotType: "forehand_drive",
        inferenceMode: "on_device",
        sessionId: null,
        permitId,
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    return (created.json() as { analysisId: string }).analysisId;
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
      devAuthSecret: secret,
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
      adminAuthSubjects: [ADMIN_SUBJECT],
    };
    app = buildApp(config, { queue: new InMemoryJobQueue(), objectStore: null });

    const minter = new DevTokenVerifier("test", secret);
    userToken = await minter.mint(`report-itest|${randomUUID()}`);
    strangerToken = await minter.mint(`report-itest|${randomUUID()}`);
    adminToken = await minter.mint(ADMIN_SUBJECT, "admin");
    await bootstrap(userToken);
    await bootstrap(strangerToken);
    await bootstrap(adminToken);

    analysisId = await createAnalysis(userToken);
  }, 60_000);

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
      url: `/v1/analyses/${analysisId}/report`,
      payload: reportPayload(),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rejects an unknown failure category with a typed 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${analysisId}/report`,
      headers: auth(userToken),
      payload: reportPayload({ failureCategory: "the_model_is_haunted" }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "validation.analysis_report",
    );
  });

  it("rejects diagnostics outside the safe allowlist (no media smuggling)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${analysisId}/report`,
      headers: auth(userToken),
      payload: reportPayload({
        diagnostics: { confidence: 0.5, rawFramesBase64: "AAAA..." },
      }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "validation.analysis_report",
    );
  });

  it("returns 404 when reporting an analysis the caller does not own", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${analysisId}/report`,
      headers: auth(strangerToken),
      payload: reportPayload(),
    });
    expect(res.statusCode, res.body).toBe(404);
    expect((res.json() as { error: { code: string } }).error.code).toBe("analysis.not_found");
  });

  it("stores the report with full provenance and enters the open triage queue", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${analysisId}/report`,
      headers: auth(userToken),
      payload: reportPayload(),
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { report: { id: string; triageStatus: string; created: boolean } };
    expect(body.report.created).toBe(true);
    expect(body.report.triageStatus).toBe("open");
    reportId = body.report.id;

    const row = await pool.query(
      `SELECT failure_category, app_version, device_platform, device_model,
              version_vector, diagnostics, triage_status
       FROM analysis_issue_report WHERE id = $1`,
      [reportId],
    );
    expect(row.rowCount).toBe(1);
    const stored = row.rows[0] as {
      failure_category: string;
      app_version: string;
      device_platform: string;
      device_model: string;
      version_vector: { modelBundleVersion: string; scoringModelVersion: string };
      diagnostics: Record<string, unknown>;
      triage_status: string;
    };
    expect(stored.failure_category).toBe("wrong_shot_type");
    expect(stored.app_version).toBe("0.1.0");
    expect(stored.device_platform).toBe("ios");
    expect(stored.device_model).toBe("iPhone16,1");
    expect(stored.version_vector.modelBundleVersion).toBe("test-native-1");
    expect(stored.version_vector.scoringModelVersion).toBe("sm-v1");
    expect(stored.diagnostics["rawFramesBase64"]).toBeUndefined();
    expect(stored.triage_status).toBe("open");
  });

  it("replaying the report is idempotent — one report per user per analysis", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/v1/analyses/${analysisId}/report`,
      headers: auth(userToken),
      payload: reportPayload({ failureCategory: "score_too_low" }),
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { report: { id: string; created: boolean } };
    expect(body.report.created).toBe(false);
    expect(body.report.id).toBe(reportId);

    const count = await pool.query(
      "SELECT count(*)::int AS n FROM analysis_issue_report WHERE analysis_job_id = $1",
      [analysisId],
    );
    expect((count.rows[0] as { n: number }).n).toBe(1);
  });

  it("the triage queue is admin-only", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/admin/analysis-reports",
      headers: auth(userToken),
    });
    expect(res.statusCode).toBe(403);
  });

  it("admins see the open queue and can triage; resolved reports leave the queue", async () => {
    const queue = await app.inject({
      method: "GET",
      url: "/v1/admin/analysis-reports?status=open",
      headers: auth(adminToken),
    });
    expect(queue.statusCode, queue.body).toBe(200);
    const open = (queue.json() as { reports: Array<{ id: string }> }).reports;
    expect(open.some((r) => r.id === reportId)).toBe(true);

    const triaged = await app.inject({
      method: "POST",
      url: `/v1/admin/analysis-reports/${reportId}/triage`,
      headers: auth(adminToken),
      payload: { status: "resolved", note: "Confirmed detector bug; fix tracked." },
    });
    expect(triaged.statusCode, triaged.body).toBe(200);
    expect((triaged.json() as { report: { triageStatus: string } }).report.triageStatus).toBe(
      "resolved",
    );

    const after = await app.inject({
      method: "GET",
      url: "/v1/admin/analysis-reports?status=open",
      headers: auth(adminToken),
    });
    const stillOpen = (after.json() as { reports: Array<{ id: string }> }).reports;
    expect(stillOpen.some((r) => r.id === reportId)).toBe(false);

    const missing = await app.inject({
      method: "POST",
      url: `/v1/admin/analysis-reports/${randomUUID()}/triage`,
      headers: auth(adminToken),
      payload: { status: "dismissed", note: null },
    });
    expect(missing.statusCode).toBe(404);
  });

  it("report submissions are rate limited per caller on the expensive budget", async () => {
    const limitedApp = buildApp(
      {
        env: "test",
        port: 0,
        host: "127.0.0.1",
        appVersion: "0.1.0-test",
        databaseUrl: schemaUrl(testUrl!, schemaName),
        devAuthSecret: secret,
        oidcIssuer: undefined,
        oidcAudience: undefined,
        oidcJwksUrl: undefined,
        sqsQueueUrl: undefined,
        consentExportSigningKey: undefined,
        consentExportSigningKeyId: "consent-export-k1",
        appleIapConfigured: false,
        googlePlayConfigured: false,
      },
      {
        queue: new InMemoryJobQueue(),
        objectStore: null,
        rateLimit: { enabled: true, windowMs: 60_000, defaultLimit: 50, expensiveLimit: 2 },
      },
    );
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        const res = await limitedApp.inject({
          method: "POST",
          url: `/v1/analyses/${analysisId}/report`,
          headers: auth(userToken),
          payload: reportPayload(),
        });
        statuses.push(res.statusCode);
      }
      // First hit replays the existing report (200); the budget of 2 then
      // exhausts and the remaining calls are typed 429s.
      expect(statuses.slice(0, 2)).toEqual([200, 200]);
      expect(statuses.slice(2)).toEqual([429, 429]);
      const limited = await limitedApp.inject({
        method: "POST",
        url: `/v1/analyses/${analysisId}/report`,
        headers: auth(userToken),
        payload: reportPayload(),
      });
      expect((limited.json() as { error: { code: string } }).error.code).toBe("api.rate_limited");
      expect(limited.headers["retry-after"]).toBeTruthy();
    } finally {
      await limitedApp.close();
    }
  });
});
