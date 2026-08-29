import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { CONSENT_SCOPES } from "@pickle/shared-types";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

/**
 * First-party consent ledger, end to end against real PostgreSQL:
 * pseudonymous append-only records, independent scopes, model_training
 * opt-in never defaulted, withdrawal preserving the audit trail, and the
 * DB-level append-only trigger.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "consent-secret-0123456789";
const schemaName = `consent_it_${process.pid}_${randomUUID().replaceAll("-", "")}`;

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

interface StatusBody {
  subjectPseudonym: string | null;
  scopes: Array<{
    scope: string;
    active: boolean;
    consentVersion: string | null;
    lastAction: string | null;
  }>;
  records: Array<{ scope: string; action: string; subjectPseudonym: string }>;
}

describe.skipIf(!testUrl)("consent ledger (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userToken: string;
  let userId: string;

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
      databaseUrl: schemaUrl(testUrl!, schemaName),
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
    userToken = await minter.mint("auth0|consent-user");

    const bootstrap = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: { authorization: `Bearer ${userToken}` },
      payload: {
        locale: "en-US",
        timezone: "America/Los_Angeles",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
      },
    });
    expect(bootstrap.statusCode).toBe(200);
    userId = (bootstrap.json() as { user: { id: string } }).user.id;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  const auth = { authorization: `Bearer ` };
  const headers = () => ({ authorization: `Bearer ${userToken}` });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/me/consent/status", headers: auth });
    expect(res.statusCode).toBe(401);
  });

  it("status defaults every scope to NOT consented before any record exists", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/consent/status",
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatusBody;
    expect(body.subjectPseudonym).toBeNull();
    expect(body.records).toHaveLength(0);
    expect(body.scopes.map((s) => s.active)).toEqual(CONSENT_SCOPES.map(() => false));
  });

  it("rejects a malformed grant with a typed envelope", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: { scope: "everything", consentVersion: "x" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe("validation.consent_grant");
  });

  it("grants video_analysis without touching model_training (scopes independent)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: {
        scope: "video_analysis",
        consentVersion: "video-analysis-v1",
        source: "mobile_settings",
        device: "iPhone16,1",
        captureMode: "all_captures",
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as StatusBody;
    expect(body.scopes.find((s) => s.scope === "video_analysis")!.active).toBe(true);
    expect(body.scopes.find((s) => s.scope === "model_training")!.active).toBe(false);
  });

  it("records are pseudonymous: no user id in the ledger row or response", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/me/consent/status",
      headers: headers(),
    });
    const body = res.json() as StatusBody;
    expect(body.subjectPseudonym).not.toBeNull();
    expect(body.subjectPseudonym).not.toBe(userId);
    const columns = await pool.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'consent_record'",
    );
    expect(columns.rows.map((r) => r.column_name)).not.toContain("user_id");
    const raw = await pool.query("SELECT subject_pseudonym FROM consent_record");
    for (const row of raw.rows) expect(row.subject_pseudonym).not.toBe(userId);
  });

  it("model_training grant + withdrawal is append-only: the trail survives", async () => {
    const grant = await app.inject({
      method: "POST",
      url: "/v1/me/consent/grant",
      headers: headers(),
      payload: {
        scope: "model_training",
        consentVersion: "model-training-v1",
        source: "mobile_settings",
        device: "iPhone16,1",
        captureMode: "automatic_pose_trigger",
        strokeIntent: "forehand_drive",
      },
    });
    expect(grant.statusCode).toBe(200);
    expect(
      (grant.json() as StatusBody).scopes.find((s) => s.scope === "model_training")!.active,
    ).toBe(true);

    const withdraw = await app.inject({
      method: "POST",
      url: "/v1/me/consent/withdraw",
      headers: headers(),
      payload: { scope: "model_training", source: "mobile_settings", device: "iPhone16,1" },
    });
    expect(withdraw.statusCode).toBe(200);
    const body = withdraw.json() as StatusBody;
    const training = body.scopes.find((s) => s.scope === "model_training")!;
    expect(training.active).toBe(false);
    expect(training.lastAction).toBe("withdrawn");
    const trainingRecords = body.records.filter((r) => r.scope === "model_training");
    expect(trainingRecords.map((r) => r.action)).toEqual(["granted", "withdrawn"]);

    const review = await pool.query(
      "SELECT count(*)::int AS n FROM deletion_task WHERE user_id = $1 AND kind = 'ml_dataset_review'",
      [userId],
    );
    expect(review.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("the database refuses UPDATE and DELETE on consent_record", async () => {
    await expect(pool.query("UPDATE consent_record SET action = 'granted'")).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("DELETE FROM consent_record")).rejects.toThrow(/append-only/);
  });

  it("audit log carries scoped consent actions", async () => {
    const rows = await pool.query(
      "SELECT action FROM audit_log WHERE actor_user_id = $1 AND action LIKE 'consent.%' ORDER BY created_at",
      [userId],
    );
    expect(rows.rows.map((r) => r.action)).toEqual([
      "consent.video_analysis.granted",
      "consent.model_training.granted",
      "consent.model_training.withdrawn",
    ]);
  });
});
