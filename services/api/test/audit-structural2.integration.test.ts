import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import { FLAG_REGISTRY } from "../src/modules/flags/registry.js";
import { buildOpenApiDocument } from "@pickle/api-contracts";
import type { StabilitySloEvent } from "@pickle/shared-types";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

/**
 * Structural audit probes (auditor #2) that need a REAL PostgreSQL:
 * admin allowlist semantics per environment, unregistered flag writes,
 * concurrent first bootstrap, and model-bundle rollout gating.
 * Skipped (visibly) without DATABASE_URL_TEST.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "audit-structural2-secret-0123456789";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function configFor(env: ApiConfig["env"], adminAuthSubjects: string[]): ApiConfig {
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
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe.skipIf(!testUrl)("structural audit #2 (real PostgreSQL)", () => {
  let pool: pg.Pool;
  /** PICKLE_ENV=test, allowlist = [admin subject]. The reference configuration. */
  let testApp: FastifyInstance;
  /** PICKLE_ENV=test, EMPTY allowlist. */
  let testAppNoAllowlist: FastifyInstance;
  /** PICKLE_ENV=development, EMPTY allowlist (the e2e / local-dev configuration). */
  let devApp: FastifyInstance;
  let minter: DevTokenVerifier;
  let adminToken: string;
  let claimedAdminToken: string;
  let userToken: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);

    testApp = buildApp(configFor("test", ["auth0|audit-admin"]), { queue: new InMemoryJobQueue() });
    testAppNoAllowlist = buildApp(configFor("test", []), { queue: new InMemoryJobQueue() });
    devApp = buildApp(configFor("development", []), { queue: new InMemoryJobQueue() });

    minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint("auth0|audit-admin", "admin");
    claimedAdminToken = await minter.mint("auth0|audit-claimed-admin", "admin");
    userToken = await minter.mint("auth0|audit-user");
    for (const token of [adminToken, claimedAdminToken, userToken]) {
      const res = await testApp.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
      expect(res.statusCode).toBe(200);
    }
  }, 60_000);

  afterAll(async () => {
    await testApp?.close();
    await testAppNoAllowlist?.close();
    await devApp?.close();
    await pool?.end();
  });

  describe("requireAdmin allowlist semantics", () => {
    const probe = (app: FastifyInstance, token: string) =>
      app.inject({ method: "GET", url: "/v1/admin/quality-dashboard", headers: auth(token) });

    it("PICKLE_ENV=test: allowlisted admin claim → 200", async () => {
      expect((await probe(testApp, adminToken)).statusCode).toBe(200);
    });

    it("PICKLE_ENV=test: admin claim NOT in allowlist → 403 auth.admin_not_authorized", async () => {
      const res = await probe(testApp, claimedAdminToken);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "auth.admin_not_authorized",
      );
    });

    it("PICKLE_ENV=test with EMPTY allowlist: admin claim alone is refused (allowlist mandatory)", async () => {
      const res = await probe(testAppNoAllowlist, adminToken);
      expect(res.statusCode).toBe(403);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        "auth.admin_not_authorized",
      );
    });

    it("user-role token → 403 auth.admin_required in every environment", async () => {
      for (const app of [testApp, testAppNoAllowlist, devApp]) {
        const res = await probe(app, userToken);
        expect(res.statusCode).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe("auth.admin_required");
      }
    });

    it("PICKLE_ENV=development with EMPTY allowlist: ANY admin-claim dev token is an administrator (documented exception)", async () => {
      // Pins the behaviour the mapper flagged (authPlugin.ts allowlistRequired = env !== 'development').
      // Reachable only with DEV_AUTH_SECRET in hand and PICKLE_ENV=development.
      expect((await probe(devApp, adminToken)).statusCode).toBe(200);
      expect((await probe(devApp, claimedAdminToken)).statusCode).toBe(200);
    });

    it("PICKLE_ENV=development with a NON-EMPTY allowlist still enforces it", async () => {
      const devAllowlisted = buildApp(configFor("development", ["auth0|audit-admin"]), {
        queue: new InMemoryJobQueue(),
      });
      try {
        expect((await probe(devAllowlisted, adminToken)).statusCode).toBe(200);
        const res = await probe(devAllowlisted, claimedAdminToken);
        expect(res.statusCode).toBe(403);
        expect((res.json() as { error: { code: string } }).error.code).toBe(
          "auth.admin_not_authorized",
        );
      } finally {
        await devAllowlisted.close();
      }
    });
  });

  describe("authenticate account-state paths", () => {
    it("valid token, no app_user → 401 auth.no_account", async () => {
      const token = await minter.mint("auth0|audit-never-bootstrapped");
      const res = await testApp.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth.no_account");
    });

    it("suspended app_user → 401 auth.suspended; bootstrap of a deleted account → 410 account.deleted", async () => {
      const suspended = await minter.mint("auth0|audit-suspended");
      const deleted = await minter.mint("auth0|audit-deleted");
      for (const token of [suspended, deleted]) {
        expect(
          (
            await testApp.inject({
              method: "POST",
              url: "/v1/account/bootstrap",
              headers: auth(token),
              payload: bootstrapBody,
            })
          ).statusCode,
        ).toBe(200);
      }
      await pool.query("UPDATE app_user SET status = 'suspended' WHERE auth_subject = $1", [
        "auth0|audit-suspended",
      ]);
      await pool.query("UPDATE app_user SET status = 'deleted' WHERE auth_subject = $1", [
        "auth0|audit-deleted",
      ]);

      const me = await testApp.inject({ method: "GET", url: "/v1/me", headers: auth(suspended) });
      expect(me.statusCode).toBe(401);
      expect((me.json() as { error: { code: string } }).error.code).toBe("auth.suspended");

      const deletedMe = await testApp.inject({
        method: "GET",
        url: "/v1/me",
        headers: auth(deleted),
      });
      expect(deletedMe.statusCode).toBe(401);
      expect((deletedMe.json() as { error: { code: string } }).error.code).toBe("auth.no_account");

      const rebootstrap = await testApp.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(deleted),
        payload: bootstrapBody,
      });
      expect(rebootstrap.statusCode).toBe(410);
      expect((rebootstrap.json() as { error: { code: string } }).error.code).toBe(
        "account.deleted",
      );
    });
  });

  describe("bootstrap concurrency", () => {
    it("SUSPECTED DEFECT: concurrent FIRST bootstraps for one subject must never 500 (select-then-insert race)", async () => {
      // fastify.inject on a warm pool serialises enough that the race does not surface; a
      // real TCP listener on a COLD pool (fresh app) makes the transactions overlap in
      // PostgreSQL exactly like a first launch after a deploy (see the .probe.ts reproducer).
      const coldApp = buildApp(configFor("test", []), { queue: new InMemoryJobQueue() });
      const address = await coldApp.listen({ port: 0, host: "127.0.0.1" });
      const subject = `auth0|audit-race-${randomUUID()}`;
      const token = await minter.mint(subject);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          fetch(`${address}/v1/account/bootstrap`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(bootstrapBody),
          }).then(async (r) => ({
            status: r.status,
            body: (await r.json()) as { error?: { code: string; kind: string } },
          })),
        ),
      );
      const statuses = results.map((r) => r.status);
      const codes = results.map((r) => r.body.error?.code ?? null);
      console.info(
        `[audit] concurrent bootstrap statuses=${JSON.stringify(statuses)} codes=${JSON.stringify(codes)}`,
      );
      // Exactly one account row must exist afterwards regardless of outcome.
      const { rows } = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM app_user WHERE auth_subject = $1",
        [subject],
      );
      await coldApp.close();
      expect(Number(rows[0]!.n)).toBe(1);
      expect(
        statuses,
        `statuses=${JSON.stringify(statuses)} codes=${JSON.stringify(codes)}`,
      ).not.toContain(500);
    });
  });

  describe("feature-flag admin writes vs registry", () => {
    it("SUSPECTED DEFECT: PUT /v1/admin/flags/:key with a key NOT in FLAG_REGISTRY must be rejected", async () => {
      const typo = "socail"; // typo of the registered key `social`
      expect(FLAG_REGISTRY.some((f) => f.key === typo)).toBe(false);
      const res = await testApp.inject({
        method: "PUT",
        url: `/v1/admin/flags/${typo}`,
        headers: auth(adminToken),
        payload: { enabled: true, rolloutPercent: 100 },
      });
      const row = await pool.query("SELECT key FROM feature_flag WHERE key = $1", [typo]);
      const flags = await testApp.inject({
        method: "GET",
        url: "/v1/flags",
        headers: auth(userToken),
      });
      const exposed = (flags.json() as { flags: Record<string, boolean> }).flags;
      expect(
        res.statusCode,
        `row created=${row.rowCount} exposed to clients=${String(typo in exposed)}`,
      ).toBeGreaterThanOrEqual(400);
      expect(row.rowCount).toBe(0);
    });

    it("registered flag: admin write is honoured and audited", async () => {
      const res = await testApp.inject({
        method: "PUT",
        url: "/v1/admin/flags/social",
        headers: auth(adminToken),
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const flags = await testApp.inject({
        method: "GET",
        url: "/v1/flags",
        headers: auth(userToken),
      });
      expect((flags.json() as { flags: Record<string, boolean> }).flags["social"]).toBe(false);
      const audits = await pool.query(
        "SELECT count(*)::int AS n FROM audit_log WHERE action = 'admin.flag_update' AND target_id = 'social'",
      );
      expect((audits.rows[0] as { n: number }).n).toBeGreaterThan(0);
    });

    it("/v1/flags exposes every registered flag with a version", async () => {
      const flags = await testApp.inject({
        method: "GET",
        url: "/v1/flags",
        headers: auth(userToken),
      });
      expect(flags.statusCode).toBe(200);
      const body = flags.json() as {
        flags: Record<string, boolean>;
        versions?: Record<string, number>;
      };
      for (const flag of FLAG_REGISTRY) {
        expect(flag.key in body.flags, flag.key).toBe(true);
      }
    });
  });

  describe("model bundle rollout gating (admin UI copy says 'Never straight to 100%')", () => {
    it("OBSERVATION: a brand-new version can be published directly as status=active rollout=100", async () => {
      const version = `audit-${Date.now()}`;
      const res = await testApp.inject({
        method: "PUT",
        url: `/v1/admin/model-bundles/${version}`,
        headers: auth(adminToken),
        payload: { manifestSha256: "c".repeat(64), status: "active", rolloutPercent: 100 },
      });
      // The API has no staged-rollout rule; only the stability guard (inactive until a
      // window is observed) can block. Recorded as an observation, not asserted as a defect.
      expect([200, 409]).toContain(res.statusCode);
      if (res.statusCode === 200) {
        const body = res.json() as { bundle: { status: string; rollout_percent: number } };
        expect(body.bundle.status).toBe("active");
        expect(body.bundle.rollout_percent).toBe(100);
      }
    });
  });

  describe("stability guard persistence across processes/replicas", () => {
    const AT = "2026-08-29T00:00:00.000Z";
    function breachedWindow(): StabilitySloEvent[] {
      const events: StabilitySloEvent[] = [];
      for (let i = 0; i < 50; i += 1) {
        events.push({ kind: "session_started", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
        events.push({ kind: "session_ended_clean", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
      }
      for (let i = 0; i < 20; i += 1) {
        events.push({ kind: "analysis_started", userKey: "u0", sessionKey: "s0", at: AT });
        events.push({ kind: "analysis_completed", userKey: "u0", sessionKey: "s0", at: AT });
        events.push({ kind: "camera_startup_succeeded", userKey: "u0", sessionKey: "s0", at: AT });
      }
      for (let i = 0; i < 10; i += 1) {
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

    it("SUSPECTED DEFECT: a 'pause' window submitted to one API process does not block rollout advancement on a second process sharing the same database", async () => {
      const version = `audit-guard-${Date.now()}`;
      const bundleBody = { manifestSha256: "d".repeat(64), status: "canary", rolloutPercent: 10 };
      expect(
        (
          await testApp.inject({
            method: "PUT",
            url: `/v1/admin/model-bundles/${version}`,
            headers: auth(adminToken),
            payload: bundleBody,
          })
        ).statusCode,
      ).toBe(200);

      const submitted = await testApp.inject({
        method: "POST",
        url: "/v1/admin/stability/window",
        headers: auth(adminToken),
        payload: { windowId: "audit-w1", events: breachedWindow() },
      });
      expect(submitted.statusCode).toBe(200);
      expect(
        (submitted.json() as { window: { decision: { action: string } } }).window.decision.action,
      ).toBe("pause");

      // Same process: the advance is blocked — the guard works within one replica.
      const sameProcess = await testApp.inject({
        method: "PUT",
        url: `/v1/admin/model-bundles/${version}`,
        headers: auth(adminToken),
        payload: { ...bundleBody, rolloutPercent: 50 },
      });
      expect(sameProcess.statusCode).toBe(409);
      expect((sameProcess.json() as { error: { code: string } }).error.code).toBe(
        "stability.rollout_advance_blocked",
      );

      // Second process (restart / second replica), same DB, same admin, same allowlist.
      const replica = buildApp(configFor("test", ["auth0|audit-admin"]), {
        queue: new InMemoryJobQueue(),
      });
      try {
        const decision = await replica.inject({
          method: "GET",
          url: "/v1/admin/stability/decision",
          headers: auth(adminToken),
        });
        const replicaWindow = (decision.json() as { window: unknown }).window;
        const advance = await replica.inject({
          method: "PUT",
          url: `/v1/admin/model-bundles/${version}`,
          headers: auth(adminToken),
          payload: { ...bundleBody, rolloutPercent: 50 },
        });
        expect(
          advance.statusCode,
          `replica sees window=${JSON.stringify(replicaWindow)}; advance response=${advance.body.slice(0, 200)}`,
        ).toBe(409);
      } finally {
        await replica.close();
      }
    });
  });

  describe("scoring model release lifecycle", () => {
    const releaseBody = {
      datasetSnapshotId: "audit-snapshot-0001",
      evaluationReportSha256: "e".repeat(64),
      coachValidationReference: "audit-coach-ref",
    };

    // Inserted directly: the stability guard (process-local, exercised above) would
    // otherwise block a 0→100 rollout via the admin route and couple these tests to order.
    async function seedActiveBundle(version: string, manifestSha256: string): Promise<void> {
      await pool.query(
        `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent)
         VALUES ($1, $2, 'active', 100)`,
        [version, manifestSha256],
      );
    }

    async function seedDraftVersions(shotType: string, versions: string[]): Promise<void> {
      for (const version of versions) {
        await pool.query(
          `INSERT INTO scoring_model (shot_type_id, version, status)
           SELECT id, $2, 'validating' FROM shot_type WHERE slug = $1`,
          [shotType, version],
        );
      }
    }

    async function activeVersions(shotType: string): Promise<string[]> {
      const { rows } = await pool.query<{ version: string }>(
        `SELECT sm.version FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
         WHERE st.slug = $1 AND sm.status = 'active' AND sm.active_to IS NULL ORDER BY sm.version`,
        [shotType],
      );
      return rows.map((r) => r.version);
    }

    it("OBSERVATION: two concurrent releases of DIFFERENT versions for one shot type both become active with active_to = NULL (no supersession)", async () => {
      const bundleVersion = `audit-rel-${Date.now()}`;
      await seedActiveBundle(bundleVersion, "f".repeat(64));
      const shotType = "dink";
      const versions = ["audit-va", "audit-vb"];
      await seedDraftVersions(shotType, versions);

      const responses = await Promise.all(
        versions.map((v) =>
          testApp.inject({
            method: "PUT",
            url: `/v1/admin/scoring-models/${shotType}/${v}/release`,
            headers: auth(adminToken),
            payload: { ...releaseBody, modelBundleVersion: bundleVersion },
          }),
        ),
      );
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      const active = await activeVersions(shotType);
      console.info(
        `[audit] active scoring models for ${shotType} after two releases: ${JSON.stringify(active)}`,
      );
      // Expected by the hotspot description: releasing a version supersedes the previous one.
      expect(active.filter((v) => v.startsWith("audit-"))).toHaveLength(1);
    });

    it("SUSPECTED DEFECT: a RETIRED scoring model can be re-released to active (no status guard on the UPDATE)", async () => {
      const bundleVersion = `audit-retired-${Date.now()}`;
      await seedActiveBundle(bundleVersion, "a".repeat(64));
      await pool.query(
        `INSERT INTO scoring_model (shot_type_id, version, status, active_to)
         SELECT id, 'audit-retired', 'retired', now() - interval '1 day' FROM shot_type WHERE slug = 'dink'`,
      );
      const res = await testApp.inject({
        method: "PUT",
        url: "/v1/admin/scoring-models/dink/audit-retired/release",
        headers: auth(adminToken),
        payload: { ...releaseBody, modelBundleVersion: bundleVersion },
      });
      const { rows } = await pool.query<{ status: string; active_to: string | null }>(
        "SELECT status, active_to FROM scoring_model WHERE version = 'audit-retired'",
      );
      expect(
        res.statusCode,
        `retired model now status=${rows[0]?.status} active_to=${rows[0]?.active_to}`,
      ).toBeGreaterThanOrEqual(400);
    });
  });

  describe("OpenAPI document vs implemented routes", () => {
    function implementedRoutes(app: FastifyInstance): Set<string> {
      const routes = new Set<string>();
      // find-my-way pretty print: nested segments concatenate (e.g. "/v1/me" + "dia/uploads").
      const tree = app.printRoutes({ commonPrefix: false });
      const stack: string[] = [];
      for (const line of tree.split("\n")) {
        const glyph = line.search(/[├└]/);
        if (glyph < 0) continue;
        const depth = glyph / 4;
        const rest = line.slice(glyph + 4); // strip "├── "
        const match = /^(\S+)(?: \(([^)]+)\))?/.exec(rest);
        if (!match) continue;
        stack.length = depth;
        stack.push(match[1]!);
        if (!match[2]) continue;
        const fullPath = stack.join("");
        for (const method of match[2].split(",").map((m) => m.trim())) {
          if (method === "HEAD") continue;
          routes.add(`${method} ${fullPath}`);
        }
      }
      return routes;
    }

    it("route-tree parser reconstructs full paths (self-check)", () => {
      const implemented = implementedRoutes(testApp);
      expect(implemented.has("GET /v1/health")).toBe(true);
      expect(implemented.has("POST /v1/media/uploads")).toBe(true);
      expect(implemented.has("PUT /v1/admin/flags/:key")).toBe(true);
      for (const route of implemented) expect(route, route).toMatch(/^[A-Z]+ \/v1\//);
    });

    it("every documented path+method is implemented (no phantom contracts)", () => {
      const doc = buildOpenApiDocument("0.1.0-audit") as {
        paths: Record<string, Record<string, unknown>>;
      };
      const implemented = implementedRoutes(testApp);
      const missing: string[] = [];
      for (const [path, ops] of Object.entries(doc.paths)) {
        const fastifyPath = path.replace(/\{([^}]+)\}/g, ":$1");
        for (const method of Object.keys(ops)) {
          if (!implemented.has(`${method.toUpperCase()} ${fastifyPath}`)) {
            missing.push(`${method.toUpperCase()} ${path}`);
          }
        }
      }
      expect(missing, `documented but not implemented: ${JSON.stringify(missing)}`).toEqual([]);
    });

    it("OBSERVATION: implemented routes NOT in the OpenAPI document (contract drift surface)", () => {
      const doc = buildOpenApiDocument("0.1.0-audit") as {
        paths: Record<string, Record<string, unknown>>;
      };
      const documented = new Set<string>();
      for (const [path, ops] of Object.entries(doc.paths)) {
        const fastifyPath = path.replace(/\{([^}]+)\}/g, ":$1");
        for (const method of Object.keys(ops))
          documented.add(`${method.toUpperCase()} ${fastifyPath}`);
      }
      const implemented = implementedRoutes(testApp);
      const undocumented = [...implemented].filter((r) => !documented.has(r)).sort();
      console.info(
        `[audit] openapi: documented=${documented.size} implemented=${implemented.size} undocumented=${undocumented.length}\n${undocumented.join("\n")}`,
      );
      expect(implemented.size).toBeGreaterThan(0);
      // Pinned as a fact about 4d812e1a: /v1/flags and the admin mutation surface are undocumented.
      expect(undocumented, "undocumented implemented routes").toEqual([]);
    });
  });

  describe("input hardening on admin routes", () => {
    it("malformed UUID on /v1/admin/users/:id → typed 4xx, never 500", async () => {
      const res = await testApp.inject({
        method: "GET",
        url: "/v1/admin/users/not-a-uuid",
        headers: auth(adminToken),
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it("unparseable JSON on an admin PUT → typed 400", async () => {
      const res = await testApp.inject({
        method: "PUT",
        url: "/v1/admin/flags/social",
        headers: { ...auth(adminToken), "content-type": "application/json" },
        payload: "{not json",
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { kind: string } }).error.kind).toBe("permanent");
    });
  });
});
