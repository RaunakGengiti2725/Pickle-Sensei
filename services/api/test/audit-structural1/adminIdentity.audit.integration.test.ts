import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import type { FastifyInstance, HTTPMethods } from "fastify";
import type { StabilitySloEvent } from "@pickle/shared-types";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildOpenApiDocument } from "@pickle/api-contracts";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import { FLAG_REGISTRY } from "../../src/modules/flags/registry.js";

/**
 * Structural audit (services-api-legacy-admin-web, pass 1) against a REAL
 * PostgreSQL: admin flag mutations vs. the registry and the stability guard,
 * identity bootstrap for suspended/concurrent subjects, admin allowlist
 * semantics in PICKLE_ENV=development, and OpenAPI ⇄ Fastify route coverage.
 * Skipped (visibly) without DATABASE_URL_TEST, exactly like the other
 * integration suites.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "audit-secret-0123456789abcdef";
const AT = "2026-08-29T00:00:00.000Z";

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

function baseConfig(env: ApiConfig["env"], adminAuthSubjects: string[]): ApiConfig {
  return {
    env,
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-audit",
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
    adminAuthSubjects,
  };
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "audit" },
};

function cleanSessions(count: number): StabilitySloEvent[] {
  const events: StabilitySloEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ kind: "session_started", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
    events.push({ kind: "session_ended_clean", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
  }
  return events;
}

/** Evaluable window with one fatal crash → decision `pause`. */
function breachedWindow(): StabilitySloEvent[] {
  const events = cleanSessions(50);
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
    fingerprint: "audit-f1",
    userKey: "u0",
    sessionKey: "s0",
    at: AT,
  });
  return events;
}

describe.skipIf(!testUrl)("admin/identity structural audit (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let app: FastifyInstance;
  let minter: DevTokenVerifier;
  let adminToken: string;
  let userToken: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    app = buildApp(baseConfig("test", ["auth0|audit-admin"]), {
      queue: new InMemoryJobQueue(),
      objectStore: null,
    });
    minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint("auth0|audit-admin", "admin");
    userToken = await minter.mint("auth0|audit-user");
    for (const token of [adminToken, userToken]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: { authorization: `Bearer ${token}` },
        payload: bootstrapBody,
      });
      expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    }
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  describe("PUT /v1/admin/flags/:key", () => {
    it("refuses a key that is not in the versioned flag registry (no silent row creation)", async () => {
      const bogusKey = `audit_typo_${randomUUID().slice(0, 8)}`;
      expect(FLAG_REGISTRY.some((f) => f.key === bogusKey)).toBe(false);

      const res = await app.inject({
        method: "PUT",
        url: `/v1/admin/flags/${bogusKey}`,
        headers: auth(adminToken),
        payload: { enabled: true, rolloutPercent: 100 },
      });
      const rows = await pool.query("SELECT key FROM feature_flag WHERE key = $1", [bogusKey]);

      expect(
        res.statusCode,
        `expected a typed 4xx for unregistered flag key; body=${res.body}`,
      ).toBeGreaterThanOrEqual(400);
      expect(rows.rowCount, "unregistered key must not become a feature_flag row").toBe(0);
    });
  });

  describe("stability guard vs. exposure changes that are not a rolloutPercent increase", () => {
    beforeAll(async () => {
      const res = await app.inject({
        method: "POST",
        url: "/v1/admin/stability/window",
        headers: auth(adminToken),
        payload: { windowId: "audit-breached", events: breachedWindow() },
      });
      expect(res.statusCode, res.body).toBe(200);
      const decision = await app.inject({
        method: "GET",
        url: "/v1/admin/stability/decision",
        headers: auth(adminToken),
      });
      expect(
        (decision.json() as { window: { decision: { action: string } } }).window.decision.action,
      ).toBe("pause");
    });

    it("control: advancing rollout_percent while paused is refused with 409", async () => {
      // ball_tracking is seeded enabled=false, rollout 0.
      const res = await app.inject({
        method: "PUT",
        url: "/v1/admin/flags/ball_tracking",
        headers: auth(adminToken),
        payload: { rolloutPercent: 50 },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "stability.rollout_advance_blocked",
      );
    });

    it("re-enabling a disabled flag at rollout 100 while paused is an advance and must be refused", async () => {
      // Disable an enabled/100% flag (always allowed — a reduction) …
      const off = await app.inject({
        method: "PUT",
        url: "/v1/admin/flags/social",
        headers: auth(adminToken),
        payload: { enabled: false },
      });
      expect(off.statusCode, off.body).toBe(200);
      const before = await pool.query<{ enabled: boolean; rollout_percent: number }>(
        "SELECT enabled, rollout_percent FROM feature_flag WHERE key = 'social'",
      );
      expect(before.rows[0]).toEqual({ enabled: false, rollout_percent: 100 });

      // … then flip it back on without touching rolloutPercent. Effective
      // exposure goes 0% → 100% under a `pause` decision.
      const on = await app.inject({
        method: "PUT",
        url: "/v1/admin/flags/social",
        headers: auth(adminToken),
        payload: { enabled: true },
      });
      const after = await pool.query<{ enabled: boolean }>(
        "SELECT enabled FROM feature_flag WHERE key = 'social'",
      );
      // Restore the seeded state regardless of verdict so later suites see the seed.
      await pool.query("UPDATE feature_flag SET enabled = true WHERE key = 'social'");

      expect(on.statusCode, `PUT {enabled:true} under pause; body=${on.body}`).toBe(409);
      expect(after.rows[0]?.enabled, "flag must stay disabled while paused").toBe(false);
    });

    it("a paused decision survives a process restart / second replica sharing the same database", async () => {
      // Same config, same Postgres — what a restarted pod or a second replica
      // behind the load balancer would see. The observed window must still
      // block the advance; otherwise the guard is bypassed by rescheduling.
      const replica = buildApp(baseConfig("test", ["auth0|audit-admin"]), {
        queue: new InMemoryJobQueue(),
        objectStore: null,
      });
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
        await pool.query("UPDATE feature_flag SET rollout_percent = 0 WHERE key = 'ball_tracking'");

        expect(
          decision.json(),
          "replica must see the paused window observed by its sibling",
        ).toMatchObject({ window: { decision: { action: "pause" } } });
        expect(advance.statusCode, `advance on replica; body=${advance.body}`).toBe(409);
        expect(row.rows[0]?.rollout_percent).toBe(0);
      } finally {
        await replica.close();
      }
    });

    it("re-activating a retired model bundle at its old rollout while paused must be refused", async () => {
      const version = `audit-bundle-${randomUUID().slice(0, 8)}`;
      const sha = "a".repeat(64);
      const create = await app.inject({
        method: "PUT",
        url: `/v1/admin/model-bundles/${version}`,
        headers: auth(adminToken),
        payload: { manifestSha256: sha, status: "retired", rolloutPercent: 100 },
      });
      // Creating a retired bundle at 100 is a 0→100 advance by the guard's
      // own arithmetic and must already be blocked; if it is, seed the row
      // directly so the reactivation step below is still exercised.
      if (create.statusCode !== 200) {
        expect(create.statusCode).toBe(409);
        await pool.query(
          `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent)
           VALUES ($1, $2, 'retired', 100)`,
          [version, sha],
        );
      }

      const reactivate = await app.inject({
        method: "PUT",
        url: `/v1/admin/model-bundles/${version}`,
        headers: auth(adminToken),
        payload: { manifestSha256: sha, status: "active", rolloutPercent: 100 },
      });
      const row = await pool.query<{ status: string }>(
        "SELECT status FROM model_bundle WHERE version = $1",
        [version],
      );
      expect(
        reactivate.statusCode,
        `retired→active at 100% under pause; body=${reactivate.body}`,
      ).toBe(409);
      expect(row.rows[0]?.status).toBe("retired");
    });
  });

  describe("POST /v1/account/bootstrap", () => {
    it("a suspended account cannot bootstrap (it is refused everywhere else with auth.suspended)", async () => {
      const subject = `auth0|audit-suspended-${randomUUID().slice(0, 8)}`;
      const token = await minter.mint(subject);
      const first = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
      expect(first.statusCode).toBe(200);
      await pool.query("UPDATE app_user SET status = 'suspended' WHERE auth_subject = $1", [
        subject,
      ]);

      const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
      expect(me.statusCode, "control: /v1/me refuses a suspended account").toBe(401);
      expect((me.json() as { error: { code: string } }).error.code).toBe("auth.suspended");

      const devicesBefore = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM user_device d JOIN app_user u ON u.id = d.user_id WHERE u.auth_subject = $1",
        [subject],
      );
      const again = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
      const devicesAfter = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM user_device d JOIN app_user u ON u.id = d.user_id WHERE u.auth_subject = $1",
        [subject],
      );

      expect(
        again.statusCode,
        `suspended bootstrap should be refused like every authenticated route; body=${again.body}`,
      ).toBe(401);
      expect(devicesAfter.rows[0]!.n, "no device row may be written for a suspended account").toBe(
        devicesBefore.rows[0]!.n,
      );
    });

    it("two concurrent first bootstraps for one subject both succeed (no 500 from the unique index)", async () => {
      const outcomes: number[] = [];
      const failures: string[] = [];
      for (let round = 0; round < 5; round++) {
        const token = await minter.mint(`auth0|audit-race-${randomUUID()}`);
        const [a, b] = await Promise.all([
          app.inject({
            method: "POST",
            url: "/v1/account/bootstrap",
            headers: auth(token),
            payload: bootstrapBody,
          }),
          app.inject({
            method: "POST",
            url: "/v1/account/bootstrap",
            headers: auth(token),
            payload: bootstrapBody,
          }),
        ]);
        outcomes.push(a.statusCode, b.statusCode);
        for (const res of [a, b]) if (res.statusCode !== 200) failures.push(res.body);
      }
      expect(
        outcomes,
        `every concurrent first bootstrap must be 200 (idempotent); got ${outcomes.join(",")}; ` +
          `bodies=${failures.join(" | ")}`,
      ).toEqual(outcomes.map(() => 200));
    });
  });

  describe("requireAdmin in PICKLE_ENV=development with an EMPTY allowlist", () => {
    let devApp: FastifyInstance;
    let devMinter: DevTokenVerifier;

    beforeAll(async () => {
      devApp = buildApp(baseConfig("development", []), {
        queue: new InMemoryJobQueue(),
        objectStore: null,
      });
      devMinter = new DevTokenVerifier("development", DEV_SECRET);
    });
    afterAll(async () => {
      await devApp?.close();
    });

    it("a user-role dev token is still refused on /v1/admin/*", async () => {
      const token = await devMinter.mint("auth0|audit-user");
      const res = await devApp.inject({
        method: "GET",
        url: "/v1/admin/stability/decision",
        headers: auth(token),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth.admin_required");
    });

    it("an admin-role dev token for ANY subject is honoured (documented development exception)", async () => {
      const token = await devMinter.mint("auth0|audit-admin", "admin");
      const res = await devApp.inject({
        method: "GET",
        url: "/v1/admin/stability/decision",
        headers: auth(token),
      });
      expect(res.statusCode).toBe(200);
    });

    it("in PICKLE_ENV=test the same admin claim without allowlist membership is refused", async () => {
      const strictApp = buildApp(baseConfig("test", []), {
        queue: new InMemoryJobQueue(),
        objectStore: null,
      });
      try {
        const res = await strictApp.inject({
          method: "GET",
          url: "/v1/admin/stability/decision",
          headers: auth(adminToken),
        });
        expect(res.statusCode).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe(
          "auth.admin_not_authorized",
        );
      } finally {
        await strictApp.close();
      }
    });
  });

  describe("OpenAPI document ⇄ Fastify routes", () => {
    it("every documented path+method is actually registered", async () => {
      await app.ready();
      const doc = buildOpenApiDocument("audit") as {
        paths: Record<string, Record<string, unknown>>;
      };
      const missing: string[] = [];
      for (const [path, operations] of Object.entries(doc.paths)) {
        const url = path.replace(/\{([^}]+)\}/g, ":$1");
        for (const method of Object.keys(operations)) {
          const upper = method.toUpperCase() as HTTPMethods;
          if (!app.hasRoute({ method: upper, url })) missing.push(`${upper} ${path}`);
        }
      }
      expect(missing, "documented but unimplemented routes").toEqual([]);
    });
  });
});
