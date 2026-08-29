import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { publishTestScoringRelease } from "./support/scoringRelease.js";
import { findForbiddenKeys } from "../src/modules/admin/supportDiagnostics.js";

/**
 * Support diagnostics against a REAL PostgreSQL database: the audited,
 * privacy-limited "why did this analysis fail" admin lookup.
 * Skipped (visibly) without DATABASE_URL_TEST; CI always runs it.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "support-diagnostics-secret-0123456789";
const schemaName = `support_diag_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

describe.skipIf(!testUrl)("support diagnostics (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  let adminToken: string;
  let userId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function reservePermit(token: string): Promise<string> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/analysis-permits",
      headers: auth(token),
      payload: { idempotencyKey: randomUUID() },
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    return (response.json() as { permit: { id: string } }).permit.id;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    await publishTestScoringRelease(pool);

    const adminSubject = `support|admin-${randomUUID()}`;
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
      adminAuthSubjects: [adminSubject],
    };
    app = buildApp(config);
    const minter = new DevTokenVerifier("test", secret);
    userToken = await minter.mint(`support|user-${randomUUID()}`);
    adminToken = await minter.mint(adminSubject, "admin");
    for (const token of [userToken, adminToken]) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: {
          locale: "en-US",
          timezone: "UTC",
          device: {
            platform: "ios" as const,
            osVersion: "18.0",
            appVersion: "0.1.0",
            model: "iPhone16,1",
          },
        },
      });
      expect(response.statusCode).toBe(200);
    }
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
    userId = (me.json() as { user: { id: string } }).user.id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  it("rejects non-admin callers", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/support/analyses/${randomUUID()}`,
      headers: auth(userToken),
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns a typed 404 for an unknown analysis and 400 for a non-UUID id", async () => {
    const missing = await app.inject({
      method: "GET",
      url: `/v1/admin/support/analyses/${randomUUID()}`,
      headers: auth(adminToken),
    });
    expect(missing.statusCode).toBe(404);
    expect((missing.json() as { error: { code: string } }).error.code).toBe(
      "support.analysis_not_found",
    );

    const invalid = await app.inject({
      method: "GET",
      url: "/v1/admin/support/analyses/not-a-uuid",
      headers: auth(adminToken),
    });
    expect(invalid.statusCode).toBe(400);
    expect((invalid.json() as { error: { code: string } }).error.code).toBe("validation.path_id");
  });

  it("reports a completed on-device analysis with device + pipeline versions and no PII", async () => {
    const permitId = await reservePermit(userToken);
    const created = await app.inject({
      method: "POST",
      url: "/v1/analyses",
      headers: auth(userToken),
      payload: {
        mediaAssetId: null,
        localAnalysisId: randomUUID(),
        expectedShotType: "forehand_drive",
        inferenceMode: "on_device",
        sessionId: null,
        permitId,
      },
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(200);
    const analysisId = (created.json() as { analysisId: string }).analysisId;

    // Link a real synced shot to the job so version-vector projection is exercised.
    const shotId = randomUUID();
    const sync = await app.inject({
      method: "POST",
      url: "/v1/shots:sync",
      headers: auth(userToken),
      payload: {
        shots: [
          {
            id: shotId,
            analysisPermitId: permitId,
            sessionId: null,
            shotType: "forehand_drive",
            cameraView: "side",
            capturedAt: new Date().toISOString(),
            timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
            overallScore: 7.4,
            confidence: 0.94,
            resultKind: "scored",
            source: "real",
            phases: [],
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
          },
        ],
      },
    });
    expect(sync.statusCode, JSON.stringify(sync.json())).toBe(200);
    await pool.query("UPDATE shot SET analysis_job_id = $1 WHERE id = $2", [analysisId, shotId]);

    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/support/analyses/${analysisId}`,
      headers: auth(adminToken),
    });
    expect(response.statusCode, JSON.stringify(response.json())).toBe(200);
    const { diagnostics } = response.json() as {
      diagnostics: {
        analysisId: string;
        userId: string;
        serverJobState: string;
        failureCategory: string;
        failureCode: string | null;
        inferenceMode: string;
        hasMedia: boolean;
        hasSession: boolean;
        shotResultKind: string | null;
        pipelineVersions: Record<string, string>;
        device: { platform: string; appVersion: string | null; osVersion: string | null } | null;
        latency: { totalMs: number | null };
      };
    };
    expect(diagnostics.analysisId).toBe(analysisId);
    expect(diagnostics.userId).toBe(userId);
    expect(diagnostics.serverJobState).toBe("complete");
    expect(diagnostics.failureCategory).toBe("none");
    expect(diagnostics.inferenceMode).toBe("on_device");
    expect(diagnostics.hasMedia).toBe(false);
    expect(diagnostics.shotResultKind).toBe("scored");
    expect(diagnostics.pipelineVersions).toEqual(versionVector());
    expect(diagnostics.device?.platform).toBe("ios");
    expect(diagnostics.device?.appVersion).toBe("0.1.0");
    expect(diagnostics.device?.osVersion).toBe("18.0");
    // Redaction contract: no storage coordinates, tokens, or account identity.
    expect(findForbiddenKeys(response.json())).toEqual([]);
    const raw = response.body;
    expect(raw).not.toContain("object_key");
    expect(raw).not.toContain("email");

    const audited = await pool.query(
      "SELECT count(*)::int AS count FROM audit_log WHERE action = 'admin.support_analysis_diagnostics' AND target_id = $1",
      [analysisId],
    );
    expect(audited.rows[0].count).toBe(1);
  });

  it("categorizes a failed job and reports latency from server timestamps", async () => {
    const failedId = randomUUID();
    await pool.query(
      `INSERT INTO analysis_job
         (id, user_id, inference_mode, status, failure_code, requested_at, started_at, finished_at, metadata)
       VALUES ($1, $2, 'on_device', 'failed', 'media.not_found',
               '2026-01-01T00:00:00Z', '2026-01-01T00:00:01Z', '2026-01-01T00:00:03Z', '{}')`,
      [failedId, userId],
    );
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/support/analyses/${failedId}`,
      headers: auth(adminToken),
    });
    expect(response.statusCode).toBe(200);
    const { diagnostics } = response.json() as {
      diagnostics: {
        serverJobState: string;
        failureCategory: string;
        failureCode: string | null;
        latency: { queueMs: number | null; processingMs: number | null; totalMs: number | null };
        device: unknown;
      };
    };
    expect(diagnostics.serverJobState).toBe("failed");
    expect(diagnostics.failureCategory).toBe("media");
    expect(diagnostics.failureCode).toBe("media.not_found");
    expect(diagnostics.latency).toEqual({ queueMs: 1000, processingMs: 2000, totalMs: 3000 });
  });

  it("lists a user's recent analyses with categories, without media or identity", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/admin/support/users/${userId}/analyses`,
      headers: auth(adminToken),
    });
    expect(response.statusCode).toBe(200);
    const { analyses } = response.json() as {
      analyses: Array<{ serverJobState: string; failureCategory: string }>;
    };
    expect(analyses.length).toBeGreaterThanOrEqual(2);
    expect(analyses.map((entry) => entry.failureCategory)).toEqual(
      expect.arrayContaining(["none", "media"]),
    );
    expect(findForbiddenKeys(response.json())).toEqual([]);

    const missingUser = await app.inject({
      method: "GET",
      url: `/v1/admin/support/users/${randomUUID()}/analyses`,
      headers: auth(adminToken),
    });
    expect(missingUser.statusCode).toBe(404);
  });
});
