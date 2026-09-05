import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import type { StabilitySloEvent } from "@pickle/shared-types";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * ADJUDICATION reproductions (area: services-api-legacy-admin-web) against a
 * REAL PostgreSQL database at the pinned commit. Each `it` states the
 * expected (correct) behaviour; a failing assertion is the reproduced defect.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "adjudicate-secret-0123456789abcdef";
const ADMIN_SUBJECT = "auth0|adjudicate-admin";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adjudicate" },
};

function config(): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-adjudicate",
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
    adminAuthSubjects: [ADMIN_SUBJECT],
  };
}

const AT = "2026-08-29T00:00:00.000Z";
/** Healthy evaluable window plus one fatal crash → decision `pause` (see test/stabilityGuard.test.ts). */
function breachedWindow(): StabilitySloEvent[] {
  const events: StabilitySloEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push({ kind: "session_started", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
    events.push({ kind: "session_ended_clean", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
  }
  for (let i = 0; i < 20; i++) {
    events.push({ kind: "analysis_started", userKey: "u0", sessionKey: "s0", at: AT });
    events.push({ kind: "analysis_completed", userKey: "u0", sessionKey: "s0", at: AT });
    events.push({ kind: "camera_startup_succeeded", userKey: "u0", sessionKey: "s0", at: AT });
  }
  for (let i = 0; i < 10; i++) {
    events.push({ kind: "try_again_rearmed", userKey: "u0", sessionKey: "s0", at: AT });
  }
  events.push({
    kind: "crash",
    fatal: true,
    fingerprint: "adjudicate-f1",
    userKey: "u0",
    sessionKey: "s0",
    at: AT,
  });
  return events;
}

describe.skipIf(!testUrl)("ADJUDICATE legacy services/api (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let minter: DevTokenVerifier;
  let adminToken: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    app = buildApp(config(), { queue: new InMemoryJobQueue() });
    await app.ready();
    minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint(ADMIN_SUBJECT, "admin");
    const boot = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(adminToken),
      payload: bootstrapBody,
    });
    expect(boot.statusCode).toBe(200);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  // ---------------------------------------------------------------------------
  // ADJ-BOOT-RACE: concurrent first bootstraps for one auth_subject
  // ---------------------------------------------------------------------------
  it("ADJ-BOOT-RACE: concurrent first bootstraps for one subject all succeed (no 500)", async () => {
    const outcomes: Array<{ attempt: number; status: number; code: string | undefined }> = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const token = await minter.mint(`auth0|race-${randomUUID()}`);
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          app.inject({
            method: "POST",
            url: "/v1/account/bootstrap",
            headers: auth(token),
            payload: bootstrapBody,
          }),
        ),
      );
      for (const r of responses) {
        const body = r.json() as { error?: { code?: string } };
        outcomes.push({ attempt, status: r.statusCode, code: body.error?.code });
      }
    }
    const failures = outcomes.filter((o) => o.status >= 500);
    // Surface the underlying pg error class for the record (logger is off in env=test).
    const audit = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_log WHERE action = 'account.created' AND actor_user_id IN (SELECT id FROM app_user WHERE auth_subject LIKE 'auth0|race-%')",
    );
    const users = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app_user WHERE auth_subject LIKE 'auth0|race-%'",
    );
    console.log(
      `ADJ-BOOT-RACE: app_user rows for race subjects=${users.rows[0]!.n} (5 subjects), account.created audits=${audit.rows[0]!.n}`,
    );
    console.log(
      `ADJ-BOOT-RACE outcomes: ${JSON.stringify(
        outcomes.reduce<Record<string, number>>((acc, o) => {
          const k = `${o.status}${o.code ? `:${o.code}` : ""}`;
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      )}`,
    );
    expect(failures, `bootstrap race produced ${failures.length} 5xx responses`).toEqual([]);
  }, 60_000);

  // ---------------------------------------------------------------------------
  // ADJ-BOOT-SUSPENDED: suspended account must not bootstrap
  // ---------------------------------------------------------------------------
  it("ADJ-BOOT-SUSPENDED: a suspended account is refused by bootstrap and writes no device row", async () => {
    const subject = `auth0|suspended-${randomUUID()}`;
    const token = await minter.mint(subject);
    const first = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: bootstrapBody,
    });
    expect(first.statusCode).toBe(200);
    const userId = (first.json() as { user: { id: string } }).user.id;
    await pool.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [userId]);

    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
    expect(me.statusCode, "control: authenticate() refuses suspended").toBe(401);
    expect((me.json() as { error: { code: string } }).error.code).toBe("auth.suspended");

    const devicesBefore = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM user_device WHERE user_id = $1",
      [userId],
    );
    const again = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: { ...bootstrapBody, device: { ...bootstrapBody.device, model: "after-suspend" } },
    });
    const devicesAfter = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM user_device WHERE user_id = $1",
      [userId],
    );
    console.log(
      `ADJ-BOOT-SUSPENDED: bootstrap after suspend → ${again.statusCode} ${again.body.slice(0, 200)}; user_device rows ${devicesBefore.rows[0]!.n} → ${devicesAfter.rows[0]!.n}`,
    );
    expect(again.statusCode, "suspended account must not bootstrap (expected 401/403)").not.toBe(
      200,
    );
    expect(devicesAfter.rows[0]!.n).toBe(devicesBefore.rows[0]!.n);
  });

  // ---------------------------------------------------------------------------
  // ADJ-STABILITY-LOCAL: guard state is per-process, not shared/persisted
  // ---------------------------------------------------------------------------
  it("ADJ-STABILITY-LOCAL: a paused stability decision blocks rollout advances on every replica / after restart", async () => {
    const submit = await app.inject({
      method: "POST",
      url: "/v1/admin/stability/window",
      headers: auth(adminToken),
      payload: { windowId: "adjudicate-w1", events: breachedWindow() },
    });
    expect(submit.statusCode, submit.body).toBe(200);
    expect(
      (submit.json() as { window: { decision: { action: string } } }).window.decision.action,
    ).toBe("pause");

    await pool.query(
      `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
       VALUES ('ball_tracking', 'Ball tracking metrics', true, 10)
       ON CONFLICT (key) DO UPDATE SET enabled = true, rollout_percent = 10`,
    );

    // Control: the same process refuses the advance.
    const sameProcess = await app.inject({
      method: "PUT",
      url: "/v1/admin/flags/ball_tracking",
      headers: auth(adminToken),
      payload: { rolloutPercent: 50 },
    });
    expect(sameProcess.statusCode, "control: same process blocks").toBe(409);

    // Second replica (or the same service after a restart) sharing the SAME database.
    const replica = buildApp(config(), { queue: new InMemoryJobQueue() });
    await replica.ready();
    try {
      const decision = await replica.inject({
        method: "GET",
        url: "/v1/admin/stability/decision",
        headers: auth(adminToken),
      });
      const advance = await replica.inject({
        method: "PUT",
        url: "/v1/admin/flags/ball_tracking",
        headers: auth(adminToken),
        payload: { rolloutPercent: 50 },
      });
      const row = await pool.query<{ rollout_percent: number }>(
        "SELECT rollout_percent FROM feature_flag WHERE key = 'ball_tracking'",
      );
      console.log(
        `ADJ-STABILITY-LOCAL: replica decision=${decision.body}; replica PUT rollout 10→50 → ${advance.statusCode}; DB rollout_percent now ${row.rows[0]!.rollout_percent}`,
      );
      expect(decision.json(), "replica must see the submitted window").not.toEqual({
        window: null,
      });
      expect(advance.statusCode, "replica must block the advance while paused").toBe(409);
      expect(row.rows[0]!.rollout_percent).toBe(10);
    } finally {
      await replica.close();
      await pool.query("UPDATE feature_flag SET rollout_percent = 10 WHERE key = 'ball_tracking'");
    }
  });

  // ---------------------------------------------------------------------------
  // ADJ-STABILITY-ENABLED: enabling a disabled 100% flag is an exposure advance
  // ---------------------------------------------------------------------------
  it("ADJ-STABILITY-ENABLED: while paused, flipping enabled=false→true on a 100% flag is refused", async () => {
    // Guard is still paused in `app` from the previous test (same process).
    const decision = await app.inject({
      method: "GET",
      url: "/v1/admin/stability/decision",
      headers: auth(adminToken),
    });
    expect(
      (decision.json() as { window: { decision: { action: string } } }).window.decision.action,
    ).toBe("pause");
    await pool.query(
      `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
       VALUES ('cloud_deep_analysis', 'Cloud deep analysis', false, 100)
       ON CONFLICT (key) DO UPDATE SET enabled = false, rollout_percent = 100`,
    );
    const flip = await app.inject({
      method: "PUT",
      url: "/v1/admin/flags/cloud_deep_analysis",
      headers: auth(adminToken),
      payload: { enabled: true },
    });
    const row = await pool.query<{ enabled: boolean; rollout_percent: number }>(
      "SELECT enabled, rollout_percent FROM feature_flag WHERE key = 'cloud_deep_analysis'",
    );
    console.log(
      `ADJ-STABILITY-ENABLED: PUT {enabled:true} while paused → ${flip.statusCode}; DB now ${JSON.stringify(row.rows[0])}`,
    );
    await pool.query("UPDATE feature_flag SET enabled = false WHERE key = 'cloud_deep_analysis'");
    expect(flip.statusCode, "0%→100% effective exposure must be blocked while paused").toBe(409);
  });

  // ---------------------------------------------------------------------------
  // ADJ-FLAG-UNKNOWN: ad-hoc keys are materialised and served to clients
  // ---------------------------------------------------------------------------
  it("ADJ-FLAG-UNKNOWN: an undeclared flag key is rejected by the admin PUT and never served by /v1/flags", async () => {
    // Fresh instance: its stability guard is inactive, so only registry
    // validation (or its absence) decides the outcome.
    const fresh = buildApp(config(), { queue: new InMemoryJobQueue() });
    await fresh.ready();
    const key = `adjudicate_unknown_${Date.now()}`;
    let put: Awaited<ReturnType<FastifyInstance["inject"]>>;
    let served: { flags: Record<string, boolean>; flagState: { versions: Record<string, number> } };
    try {
      put = await fresh.inject({
        method: "PUT",
        url: `/v1/admin/flags/${key}`,
        headers: auth(adminToken),
        payload: { enabled: true, rolloutPercent: 100, description: "adjudication probe" },
      });
      const flags = await fresh.inject({
        method: "GET",
        url: "/v1/flags",
        headers: auth(adminToken),
      });
      served = flags.json();
    } finally {
      await fresh.close();
    }
    console.log(
      `ADJ-FLAG-UNKNOWN: PUT ${key} → ${put.statusCode}; /v1/flags.flags[${key}]=${served.flags[key]}; version=${served.flagState.versions[key]}`,
    );
    await pool.query("DELETE FROM feature_flag WHERE key = $1", [key]);
    expect(put.statusCode, "undeclared key must be rejected (expected 400/404)").not.toBe(200);
    expect(served.flags[key]).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // ADJ-SCORING-RELEASE: retired model re-activation + multiple active versions
  // ---------------------------------------------------------------------------
  describe("scoring release governance", () => {
    const shotType = "forehand_drive";
    const releaseBody = {
      modelBundleVersion: "adjudicate-bundle-1",
      datasetSnapshotId: "adjudicate-dataset-snapshot",
      evaluationReportSha256: "b".repeat(64),
      coachValidationReference: "adjudicate-coach-review",
    };
    let shotTypeId: string;

    beforeAll(async () => {
      shotTypeId = (
        await pool.query<{ id: string }>("SELECT id FROM shot_type WHERE slug = $1", [shotType])
      ).rows[0]!.id;
      await pool.query(
        `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent, metadata)
         VALUES ($1, $2, 'active', 100, '{}')
         ON CONFLICT (version) DO UPDATE SET status='active', rollout_percent=100, manifest_sha256=EXCLUDED.manifest_sha256`,
        [releaseBody.modelBundleVersion, "a".repeat(64)],
      );
      for (const version of ["adj-v1", "adj-v2", "adj-retired"]) {
        await pool.query(
          `INSERT INTO scoring_model (shot_type_id, version, status)
           VALUES ($1, $2, $3) ON CONFLICT (shot_type_id, version) DO NOTHING`,
          [shotTypeId, version, version === "adj-retired" ? "retired" : "validating"],
        );
      }
    });

    async function release(version: string) {
      return app.inject({
        method: "PUT",
        url: `/v1/admin/scoring-models/${shotType}/${version}/release`,
        headers: auth(adminToken),
        payload: releaseBody,
      });
    }
    async function statuses() {
      const { rows } = await pool.query<{
        version: string;
        status: string;
        active_to: string | null;
      }>(
        `SELECT version, status, active_to FROM scoring_model
         WHERE shot_type_id = $1 AND version LIKE 'adj-%' ORDER BY version`,
        [shotTypeId],
      );
      return rows;
    }

    it("ADJ-SCORING-RETIRED: releasing a `retired` scoring model is refused", async () => {
      const res = await release("adj-retired");
      const rows = await statuses();
      console.log(
        `ADJ-SCORING-RETIRED: release adj-retired → ${res.statusCode}; rows=${JSON.stringify(rows)}`,
      );
      expect(res.statusCode, "retired model must not be re-activated").not.toBe(200);
      expect(rows.find((r) => r.version === "adj-retired")!.status).toBe("retired");
    });

    it("ADJ-SCORING-MULTI-ACTIVE: releasing v2 supersedes the active v1 for the same shot type", async () => {
      const v1 = await release("adj-v1");
      expect(v1.statusCode, v1.body).toBe(200);
      const v2 = await release("adj-v2");
      expect(v2.statusCode, v2.body).toBe(200);
      const rows = await statuses();
      const active = rows.filter((r) => r.status === "active" && r.active_to === null);
      console.log(
        `ADJ-SCORING-MULTI-ACTIVE: rows=${JSON.stringify(rows)}; open-ended active=${active.length}`,
      );
      expect(
        active.map((r) => r.version),
        "exactly one open-ended active version per shot type",
      ).toEqual(["adj-v2"]);
    });
  });
});
