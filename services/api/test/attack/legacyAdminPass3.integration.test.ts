import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT, UnsecuredJWT } from "jose";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";
import type { AppContext } from "../../src/context.js";
import { FLAG_REGISTRY, flagStateFingerprint } from "../../src/modules/flags/registry.js";

/**
 * Adversarial pass 3 (tester #2) — legacy Fastify services/api against a REAL
 * PostgreSQL (DATABASE_URL_TEST). Skipped visibly without the database.
 *
 * Scenarios:
 *   S1  unregistered feature_flag row → served without a registry version,
 *       fingerprint unchanged
 *   S2  pg_terminate_backend on the backend serving POST /v1/sessions →
 *       503 api.datastore_unavailable, pooled client released, pool recovers
 *   S3  pickle_role 'ADMIN' / 'superadmin' → 403 auth.admin_required
 *   S4  wrong iss / expired / alg none / no sub → 401, never 500
 *   +   extras: rapid concurrent kills, unicode/huge bearer, clock-skew nbf
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "attack-pass3-secret-0123456789abcdef";
const SECRET_BYTES = new TextEncoder().encode(DEV_SECRET);
const POOL_APP_NAME = "attack-pass3-api-pool";

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

function withAppName(url: string, name: string): string {
  const u = new URL(url);
  u.searchParams.set("application_name", name);
  return u.toString();
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

interface ErrorEnvelope {
  error: { kind: string; code: string; message: string; retryable: boolean; requestId: string };
}

describe.skipIf(!testUrl)("attack pass 3: legacy services/api (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let admin: pg.Client; // out-of-band superuser connection for attacks/inspection
  let minter: DevTokenVerifier;
  let userToken: string;
  let adminToken: string;
  const userSubject = `attack3|user-${randomUUID()}`;
  const adminSubject = `attack3|admin-${randomUUID()}`;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const pool = () => (app as FastifyInstance & { appContext: AppContext }).appContext.pool!;

  beforeAll(async () => {
    const setup = new pg.Pool({ connectionString: testUrl });
    await setup.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(setup, migrationsDir);
    await seed(setup);
    await setup.end();

    admin = new pg.Client({ connectionString: testUrl });
    await admin.connect();

    const config: ApiConfig = {
      env: "test",
      port: 0,
      host: "127.0.0.1",
      appVersion: "0.1.0-attack3",
      databaseUrl: withAppName(testUrl!, POOL_APP_NAME),
      devAuthSecret: DEV_SECRET,
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
    app = buildApp(config, { queue: new InMemoryJobQueue() });
    minter = new DevTokenVerifier("test", DEV_SECRET);
    userToken = await minter.mint(userSubject);
    adminToken = await minter.mint(adminSubject, "admin");
    for (const token of [userToken, adminToken]) {
      const res = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
      expect(res.statusCode, res.body).toBe(200);
    }
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await admin?.end();
  });

  // ---------------------------------------------------------------- S1 ----
  describe("S1 unregistered feature_flag row", () => {
    it("is served without a registry version and leaves flagState.fingerprint unchanged", async () => {
      const before = await app.inject({
        method: "GET",
        url: "/v1/flags",
        headers: auth(userToken),
      });
      expect(before.statusCode).toBe(200);
      const beforeBody = before.json() as {
        flags: Record<string, boolean>;
        flagState: {
          fingerprint: string;
          versions: Record<string, number>;
          registryVersion: number;
        };
      };
      expect(beforeBody.flags["unregistered_thing"]).toBeUndefined();
      expect(beforeBody.flagState.fingerprint).toBe(flagStateFingerprint(process.env));

      await admin.query(
        `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
         VALUES ('unregistered_thing', 'attack pass 3 — never registered', true, 100)`,
      );
      try {
        const after = await app.inject({
          method: "GET",
          url: "/v1/flags",
          headers: auth(userToken),
        });
        expect(after.statusCode).toBe(200);
        const afterBody = after.json() as typeof beforeBody;
        // served (enabled=true, rollout 100 → true for every user) …
        expect(afterBody.flags["unregistered_thing"]).toBe(true);
        // … without a registry version …
        expect(afterBody.flagState.versions["unregistered_thing"]).toBeUndefined();
        expect(Object.keys(afterBody.flagState.versions).sort()).toEqual(
          FLAG_REGISTRY.map((f) => f.key).sort(),
        );
        // … and the fingerprint (registry + kill switches only) is unchanged.
        expect(afterBody.flagState.fingerprint).toBe(beforeBody.flagState.fingerprint);
        expect(afterBody.flagState.registryVersion).toBe(beforeBody.flagState.registryVersion);
        // every registered flag is still present and versioned
        for (const def of FLAG_REGISTRY) {
          expect(afterBody.flags[def.key], def.key).toBeTypeOf("boolean");
          expect(afterBody.flagState.versions[def.key], def.key).toBe(def.version);
        }
      } finally {
        await admin.query("DELETE FROM feature_flag WHERE key = 'unregistered_thing'");
      }
    });

    it("unicode / huge keys in feature_flag are served without crashing the route", async () => {
      const weird = ["🥒_flag_\u0000".replace("\u0000", ""), "a".repeat(2000), "Ünregïstered"];
      for (const key of weird) {
        await admin.query(
          `INSERT INTO feature_flag (key, description, enabled, rollout_percent)
           VALUES ($1, 'attack pass 3 unicode/huge', false, 0)`,
          [key],
        );
      }
      try {
        const res = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(userToken) });
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          flags: Record<string, boolean>;
          flagState: { fingerprint: string };
        };
        for (const key of weird) expect(body.flags[key]).toBe(false);
        expect(body.flagState.fingerprint).toBe(flagStateFingerprint(process.env));
      } finally {
        await admin.query(
          "DELETE FROM feature_flag WHERE description = 'attack pass 3 unicode/huge'",
        );
      }
    });
  });

  // ---------------------------------------------------------------- S2 ----
  describe("S2 pg_terminate_backend during POST /v1/sessions", () => {
    const sessionPayload = () => ({
      id: randomUUID(),
      mode: "single",
      shotType: "forehand_drive",
      focusCheckpoint: null,
      cameraView: null,
      startedAt: new Date().toISOString(),
    });

    async function poolPidsWaitingOnLock(): Promise<number[]> {
      const { rows } = await admin.query<{ pid: number }>(
        `SELECT pid FROM pg_stat_activity
          WHERE application_name = $1 AND state = 'active'
            AND wait_event_type = 'Lock' AND query ILIKE 'INSERT INTO practice_session%'`,
        [POOL_APP_NAME],
      );
      return rows.map((r) => r.pid);
    }

    async function waitFor<T>(
      fn: () => Promise<T>,
      ok: (v: T) => boolean,
      ms = 10_000,
    ): Promise<T> {
      const deadline = Date.now() + ms;
      for (;;) {
        const v = await fn();
        if (ok(v)) return v;
        if (Date.now() > deadline) throw new Error(`timed out waiting: ${JSON.stringify(v)}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    }

    it("returns 503 api.datastore_unavailable, releases the client and the pool recovers", async () => {
      // Warm the pool so totalCount is meaningful before the attack.
      const warm = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
      expect(warm.statusCode).toBe(200);
      const totalBefore = pool().totalCount;
      expect(totalBefore).toBeGreaterThanOrEqual(1);

      // Blocker: hold an exclusive lock so the route's INSERT parks mid-request
      // on a known backend pid that we can then terminate.
      const blocker = new pg.Client({ connectionString: testUrl });
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE practice_session IN ACCESS EXCLUSIVE MODE");

      let response: Awaited<ReturnType<typeof app.inject>> | undefined;
      try {
        const inflight = app.inject({
          method: "POST",
          url: "/v1/sessions",
          headers: auth(userToken),
          payload: sessionPayload(),
        });
        const pids = await waitFor(poolPidsWaitingOnLock, (p) => p.length === 1);
        const { rows } = await admin.query<{ ok: boolean }>(
          "SELECT pg_terminate_backend($1) AS ok",
          [pids[0]],
        );
        expect(rows[0]?.ok).toBe(true);
        response = await inflight;
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end();
      }

      expect(response!.statusCode).toBe(503);
      const body = response!.json() as ErrorEnvelope;
      expect(body.error.code).toBe("api.datastore_unavailable");
      expect(body.error.kind).toBe("retryable");
      expect(body.error.retryable).toBe(true);
      // No 5xx detail leak beyond the typed envelope.
      expect(body.error.message).not.toMatch(/terminating connection|administrator/i);

      // Client released: the dead client must not linger as checked-out.
      await waitFor(
        async () => pool().waitingCount,
        (w) => w === 0,
      );
      expect(pool().idleCount + pool().waitingCount).toBeLessThanOrEqual(pool().totalCount);
      expect(pool().totalCount - pool().idleCount).toBe(0); // nothing checked out

      // Recovery: the very next request succeeds and totalCount is back ≥ 1.
      const retry = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: auth(userToken),
        payload: sessionPayload(),
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(pool().totalCount).toBeGreaterThanOrEqual(1);
      expect(pool().totalCount).toBeGreaterThanOrEqual(totalBefore);
      const { rows: live } = await admin.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = $1",
        [POOL_APP_NAME],
      );
      expect(live[0]!.n).toBe(pool().totalCount);
    }, 30_000);

    it("rapid repeat: 5 concurrent session creates all killed mid-INSERT → five 503s, then 200", async () => {
      const blocker = new pg.Client({ connectionString: testUrl });
      await blocker.connect();
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE practice_session IN ACCESS EXCLUSIVE MODE");
      let responses: Awaited<ReturnType<typeof app.inject>>[] = [];
      try {
        const inflight = Array.from({ length: 5 }, () =>
          app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: auth(userToken),
            payload: sessionPayload(),
          }),
        );
        const pids = await waitFor(poolPidsWaitingOnLock, (p) => p.length === 5);
        await admin.query("SELECT pg_terminate_backend(pid) FROM unnest($1::int[]) AS pid", [pids]);
        responses = await Promise.all(inflight);
      } finally {
        await blocker.query("ROLLBACK").catch(() => undefined);
        await blocker.end();
      }
      for (const res of responses) {
        expect(res.statusCode).toBe(503);
        expect((res.json() as ErrorEnvelope).error.code).toBe("api.datastore_unavailable");
      }
      await waitFor(
        async () => pool().totalCount - pool().idleCount,
        (checkedOut) => checkedOut === 0,
      );
      const retry = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: auth(userToken),
        payload: sessionPayload(),
      });
      expect(retry.statusCode, retry.body).toBe(200);
      expect(pool().totalCount).toBeLessThanOrEqual(10); // pg default max
    }, 30_000);
  });

  // ---------------------------------------------------------------- S3 ----
  describe("S3 requireAdmin is exact-match on pickle_role", () => {
    const adminRoutes = [
      { method: "GET" as const, url: "/v1/admin/stability/decision" },
      { method: "PUT" as const, url: "/v1/admin/flags/live_court", payload: { enabled: false } },
    ];

    async function mintRole(role: unknown, subject = userSubject): Promise<string> {
      return new SignJWT({ pickle_role: role })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("pickle-dev")
        .setSubject(subject)
        .setIssuedAt()
        .setExpirationTime("15m")
        .sign(SECRET_BYTES);
    }

    for (const role of [
      "ADMIN",
      "superadmin",
      "Admin",
      " admin",
      "admin\u0000",
      ["admin"],
      { role: "admin" },
      true,
    ]) {
      it(`pickle_role=${JSON.stringify(role)} → 403 auth.admin_required`, async () => {
        const token = await mintRole(role);
        for (const route of adminRoutes) {
          const res = await app.inject({ ...route, headers: auth(token) });
          expect(res.statusCode, `${route.url} ${res.body}`).toBe(403);
          const body = res.json() as ErrorEnvelope;
          expect(body.error.code).toBe("auth.admin_required");
          expect(body.error.kind).toBe("permission_denied");
        }
      });
    }

    it("control: exact 'admin' on the allowlisted subject reaches the admin route", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/v1/admin/stability/decision",
        headers: auth(adminToken),
      });
      expect(res.statusCode, res.body).toBe(200);
    });

    it("exact 'admin' claim on a NON-allowlisted subject is still refused (claim alone never mints admin)", async () => {
      const token = await mintRole("admin", userSubject);
      const res = await app.inject({
        method: "GET",
        url: "/v1/admin/stability/decision",
        headers: auth(token),
      });
      expect(res.statusCode).toBe(403);
      expect((res.json() as ErrorEnvelope).error.code).toBe("auth.admin_not_authorized");
    });

    it("the flag write attempted with a forged role did not land", async () => {
      const { rows } = await admin.query<{ enabled: boolean }>(
        "SELECT enabled FROM feature_flag WHERE key = 'live_court'",
      );
      expect(rows[0]?.enabled).toBe(true); // seed default, untouched
    });
  });

  // ---------------------------------------------------------------- S4 ----
  describe("S4 malformed / hostile bearer tokens on GET /v1/me", () => {
    const base = () =>
      new SignJWT({ pickle_role: "user" })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userSubject)
        .setIssuedAt();

    const cases: Array<{ name: string; token: () => Promise<string>; code: string }> = [
      {
        name: "wrong issuer 'pickle-prod'",
        token: () => base().setIssuer("pickle-prod").setExpirationTime("15m").sign(SECRET_BYTES),
        code: "auth.invalid_token",
      },
      {
        name: "expired (exp -1s)",
        token: () => base().setIssuer("pickle-dev").setExpirationTime("-1s").sign(SECRET_BYTES),
        code: "auth.invalid_token",
      },
      {
        name: "alg none (unsecured JWT)",
        token: async () =>
          new UnsecuredJWT({ pickle_role: "admin" })
            .setIssuer("pickle-dev")
            .setSubject(userSubject)
            .setIssuedAt()
            .setExpirationTime("15m")
            .encode(),
        code: "auth.invalid_token",
      },
      {
        name: "alg none with a bogus signature segment",
        token: async () => {
          const unsecured = new UnsecuredJWT({ pickle_role: "admin" })
            .setIssuer("pickle-dev")
            .setSubject(userSubject)
            .setExpirationTime("15m")
            .encode();
          return `${unsecured}AAAA`;
        },
        code: "auth.invalid_token",
      },
      {
        name: "no sub",
        token: () =>
          new SignJWT({ pickle_role: "user" })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuer("pickle-dev")
            .setIssuedAt()
            .setExpirationTime("15m")
            .sign(SECRET_BYTES),
        code: "auth.no_subject",
      },
      {
        name: "empty-string sub",
        token: () =>
          new SignJWT({ pickle_role: "user", sub: "" })
            .setProtectedHeader({ alg: "HS256" })
            .setIssuer("pickle-dev")
            .setIssuedAt()
            .setExpirationTime("15m")
            .sign(SECRET_BYTES),
        code: "auth.no_subject",
      },
      {
        name: "wrong secret",
        token: () =>
          base()
            .setIssuer("pickle-dev")
            .setExpirationTime("15m")
            .sign(new TextEncoder().encode("not-the-configured-secret-0000")),
        code: "auth.invalid_token",
      },
      {
        name: "clock skew: nbf 10 minutes in the future",
        token: () =>
          base()
            .setIssuer("pickle-dev")
            .setNotBefore("10m")
            .setExpirationTime("15m")
            .sign(SECRET_BYTES),
        code: "auth.invalid_token",
      },
      {
        name: "HS512 signed with the same secret (alg confusion within HMAC family)",
        token: () =>
          new SignJWT({ pickle_role: "admin" })
            .setProtectedHeader({ alg: "HS512" })
            .setIssuer("pickle-dev")
            .setSubject(adminSubject)
            .setExpirationTime("15m")
            .sign(SECRET_BYTES),
        // HS512 with the same key is a valid HMAC; jose accepts any HS* by default
        // when algorithms is not pinned — record the actual behaviour below.
        code: "__observe__",
      },
    ];

    for (const c of cases) {
      it(`${c.name} → 401 ${c.code}, never 500`, async () => {
        const token = await c.token();
        const res = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
        expect(res.statusCode).toBeLessThan(500);
        if (c.code === "__observe__") {
          // Documented observation (not an assertion of a bug): HS512 with the
          // same shared secret is cryptographically valid HMAC; the verifier does
          // not pin `algorithms`, so this is accepted as the subject's identity.
          console.log(`[observe] ${c.name} → ${res.statusCode} ${res.body}`);
          return;
        }
        expect(res.statusCode, res.body).toBe(401);
        const body = res.json() as ErrorEnvelope;
        expect(body.error.code).toBe(c.code);
        expect(body.error.kind).toBe("auth_failed");
        expect(body.error.retryable).toBe(false);
      });
    }

    for (const garbage of [
      "",
      "Bearer",
      "Bearer ",
      "bearer " + userSubject,
      "Bearer " + "A".repeat(65_536),
      "Bearer 🥒🥒🥒.🥒🥒🥒.🥒🥒🥒",
      "Bearer ..",
      "Bearer eyJhbGciOiJIUzI1NiJ9..",
      "Basic dXNlcjpwYXNz",
    ]) {
      it(`garbage authorization header ${JSON.stringify(garbage.slice(0, 40))} → 401, never 500`, async () => {
        const res = await app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: garbage },
        });
        expect(res.statusCode, res.body).toBe(401);
        const body = res.json() as ErrorEnvelope;
        expect(["auth.missing_token", "auth.invalid_token", "auth.no_subject"]).toContain(
          body.error.code,
        );
      });
    }

    it("rapid repeat: 200 interleaved bad tokens never yield a 5xx and the good token still works", async () => {
      const bad = await Promise.all(
        cases.filter((c) => c.code !== "__observe__").map((c) => c.token()),
      );
      const results = await Promise.all(
        Array.from({ length: 200 }, (_, i) =>
          app.inject({ method: "GET", url: "/v1/me", headers: auth(bad[i % bad.length]!) }),
        ),
      );
      for (const r of results) expect(r.statusCode).toBe(401);
      const good = await app.inject({ method: "GET", url: "/v1/me", headers: auth(userToken) });
      expect(good.statusCode).toBe(200);
    });
  });
});
