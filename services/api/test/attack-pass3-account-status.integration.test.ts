import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";

/**
 * Adversarial pass 3 (services-api-legacy-admin-web) — account-status and
 * bootstrap-concurrency attacks against a REAL PostgreSQL (DATABASE_URL_TEST),
 * pinned to 4d812e1a. Skipped visibly without the database, like the other
 * *.integration.test.ts suites. Titles say HELD / BROKEN at that commit.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "attack-pass3-integration-secret-01";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

type Envelope = { error: { kind: string; code: string; retryable: boolean; requestId: string } };

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

describe.skipIf(!testUrl)(
  "attack pass 3 — account status + bootstrap races (real PostgreSQL)",
  () => {
    let app: FastifyInstance;
    let pool: pg.Pool;
    let minter: DevTokenVerifier;
    const handlerErrors: Array<{
      requestId: string;
      code: string | undefined;
      constraint: string | undefined;
      message: string;
    }> = [];

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: testUrl });
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      const config: ApiConfig = {
        env: "test",
        port: 0,
        host: "127.0.0.1",
        appVersion: "0.1.0-attack",
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
      };
      app = buildApp(config, { queue: new InMemoryJobQueue() });
      // test-side tap: record what the global error handler swallowed (no prod change)
      app.addHook("onError", async (request, _reply, error) => {
        const pgError = error as Error & { code?: string; constraint?: string };
        handlerErrors.push({
          requestId: request.id,
          code: pgError.code,
          constraint: pgError.constraint,
          message: pgError.message,
        });
      });
      minter = new DevTokenVerifier("test", DEV_SECRET);
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
    });

    const auth = (token: string) => ({ authorization: `Bearer ${token}` });
    const bootstrap = (token: string) =>
      app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: bootstrapBody,
      });
    const me = (token: string) =>
      app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });

    describe("S1 — suspended / deleted status enforcement", () => {
      const subject = `auth0|attack-s1-${randomUUID()}`;
      let token: string;

      beforeAll(async () => {
        token = await minter.mint(subject);
        expect((await bootstrap(token)).statusCode).toBe(200);
        expect((await me(token)).statusCode).toBe(200);
      });

      it("HELD: status='suspended' → GET /v1/me is 401 auth.suspended (typed, non-retryable)", async () => {
        await pool.query("UPDATE app_user SET status = 'suspended' WHERE auth_subject = $1", [
          subject,
        ]);
        const res = await me(token);
        expect(res.statusCode).toBe(401);
        expect((res.json() as Envelope).error).toMatchObject({
          kind: "auth_failed",
          code: "auth.suspended",
          retryable: false,
        });
      });

      it("HELD: suspension also blocks every other authenticate()-guarded route, including admin", async () => {
        const adminToken = await minter.mint(subject, "admin");
        const results = await Promise.all([
          app.inject({
            method: "PATCH",
            url: "/v1/me/profile",
            headers: auth(token),
            payload: { displayName: "x" },
          }),
          app.inject({ method: "POST", url: "/v1/devices", headers: auth(token), payload: {} }),
          app.inject({ method: "GET", url: "/v1/flags", headers: auth(adminToken) }),
          app.inject({ method: "GET", url: "/v1/me", headers: auth(adminToken) }),
        ]);
        for (const res of results) {
          expect(res.statusCode).toBe(401);
          expect((res.json() as Envelope).error.code).toBe("auth.suspended");
        }
      });

      it("BROKEN: a SUSPENDED account can still POST /v1/account/bootstrap → 200 with the full /me payload and a new user_device row (bootstrap uses verifyToken only, identity/routes.ts:92,121)", async () => {
        const devicesBefore = await pool.query(
          "SELECT count(*)::int AS n FROM user_device d JOIN app_user u ON u.id = d.user_id WHERE u.auth_subject = $1",
          [subject],
        );
        const res = await bootstrap(token);
        // observed at 4d812e1a
        expect(res.statusCode).toBe(200);
        const body = res.json() as {
          user: { status: string };
          settings: unknown;
          entitlements: unknown[];
        };
        expect(body.user.status).toBe("suspended");
        expect(body.settings).toBeTruthy();
        const devicesAfter = await pool.query(
          "SELECT count(*)::int AS n FROM user_device d JOIN app_user u ON u.id = d.user_id WHERE u.auth_subject = $1",
          [subject],
        );
        expect(devicesAfter.rows[0].n).toBe(devicesBefore.rows[0].n + 1);
      });

      it("HELD: status='deleted' → POST /v1/account/bootstrap is 410 account.deleted and creates nothing", async () => {
        await pool.query(
          "UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE auth_subject = $1",
          [subject],
        );
        const rowsBefore = await pool.query(
          "SELECT count(*)::int AS n FROM app_user WHERE auth_subject = $1",
          [subject],
        );
        const res = await bootstrap(token);
        expect(res.statusCode).toBe(410);
        expect((res.json() as Envelope).error).toMatchObject({
          kind: "permanent",
          code: "account.deleted",
          retryable: false,
        });
        const rowsAfter = await pool.query(
          "SELECT count(*)::int AS n FROM app_user WHERE auth_subject = $1",
          [subject],
        );
        expect(rowsAfter.rows[0].n).toBe(rowsBefore.rows[0].n);
        expect(rowsAfter.rows[0].n).toBe(1);
      });

      it("HELD: status='deleted' → GET /v1/me is 401 auth.no_account (never a 200, never a 500)", async () => {
        const res = await me(token);
        expect(res.statusCode).toBe(401);
        expect((res.json() as Envelope).error.code).toBe("auth.no_account");
      });

      it("HELD: 20 concurrent bootstraps against the DELETED subject are all 410 and still create nothing", async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => bootstrap(token)));
        expect(results.map((r) => r.statusCode)).toEqual(Array(20).fill(410));
        const rows = await pool.query(
          "SELECT count(*)::int AS n FROM app_user WHERE auth_subject = $1",
          [subject],
        );
        expect(rows.rows[0].n).toBe(1);
      });

      it("HELD: reactivating (status='active') restores /v1/me without re-bootstrap", async () => {
        await pool.query(
          "UPDATE app_user SET status = 'active', deleted_at = NULL WHERE auth_subject = $1",
          [subject],
        );
        expect((await me(token)).statusCode).toBe(200);
      });
    });

    describe("S5 — 20 concurrent FIRST-TIME bootstraps for one fresh auth_subject", () => {
      it("BROKEN: exactly one app_user row is created (UNIQUE holds) but losers of the INSERT race surface as 500 api.internal_error 'permanent' (pg 23505 unmapped in app.ts setErrorHandler)", async () => {
        const subject = `auth0|attack-s5-${randomUUID()}`;
        const token = await minter.mint(subject);
        const responses = await Promise.all(Array.from({ length: 20 }, () => bootstrap(token)));
        const statuses = responses.map((r) => r.statusCode);

        // exactly one account, one profile, one settings row, one audit entry
        const counts = await pool.query(
          `SELECT
           (SELECT count(*)::int FROM app_user WHERE auth_subject = $1) AS users,
           (SELECT count(*)::int FROM user_profile p JOIN app_user u ON u.id = p.user_id WHERE u.auth_subject = $1) AS profiles,
           (SELECT count(*)::int FROM user_setting s JOIN app_user u ON u.id = s.user_id WHERE u.auth_subject = $1) AS settings,
           (SELECT count(*)::int FROM audit_log a JOIN app_user u ON u.id = a.actor_user_id WHERE u.auth_subject = $1 AND a.action = 'account.created') AS audits,
           (SELECT count(*)::int FROM user_device d JOIN app_user u ON u.id = d.user_id WHERE u.auth_subject = $1) AS devices`,
          [subject],
        );
        expect(counts.rows[0]).toMatchObject({ users: 1, profiles: 1, settings: 1, audits: 1 });

        // every response is a typed envelope or a 200 with the account
        for (const res of responses) {
          if (res.statusCode === 200) {
            expect((res.json() as { user: { status: string } }).user.status).toBe("active");
            continue;
          }
          const body = res.json() as Envelope;
          expect(body.error.kind).toBeTruthy();
          expect(body.error.code).toBeTruthy();
          expect(body.error.requestId).toBeTruthy();
        }
        // successful bootstraps each register a device; failed ones roll back
        expect(counts.rows[0].devices).toBe(statuses.filter((s) => s === 200).length);

        // observed at 4d812e1a: the racers that hit 23505 answer 500 permanent
        const failures = responses.filter((r) => r.statusCode !== 200);
        expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
        expect(failures.length).toBeGreaterThanOrEqual(1);
        for (const res of failures) {
          expect(res.statusCode).toBe(500);
          const envelope = (res.json() as Envelope).error;
          expect(envelope).toMatchObject({
            kind: "permanent",
            code: "api.internal_error",
            retryable: false,
          });
          const swallowed = handlerErrors.find((e) => e.requestId === envelope.requestId);
          expect(swallowed).toMatchObject({
            code: "23505",
            constraint: "app_user_auth_subject_key",
          });
        }
        // the SAME token retried afterwards succeeds — so "permanent" was a lie to the client
        expect((await bootstrap(token)).statusCode).toBe(200);
        console.log(`[attack-s5] statuses=${JSON.stringify(statuses)}`);
      }, 60_000);

      it("HELD: 20 concurrent bootstraps for an EXISTING subject are all 200 and add exactly 20 device rows", async () => {
        const subject = `auth0|attack-s5b-${randomUUID()}`;
        const token = await minter.mint(subject);
        expect((await bootstrap(token)).statusCode).toBe(200);
        const responses = await Promise.all(Array.from({ length: 20 }, () => bootstrap(token)));
        expect(responses.map((r) => r.statusCode)).toEqual(Array(20).fill(200));
        const devices = await pool.query(
          "SELECT count(*)::int AS n FROM user_device d JOIN app_user u ON u.id = d.user_id WHERE u.auth_subject = $1",
          [subject],
        );
        expect(devices.rows[0].n).toBe(21);
      });
    });

    describe("extra — bootstrap input edges", () => {
      it("HELD: a unicode auth subject round-trips through bootstrap and /v1/me", async () => {
        const subject = `apple|ünïcödé-😀-${randomUUID()}`;
        const token = await minter.mint(subject);
        expect((await bootstrap(token)).statusCode).toBe(200);
        const res = await me(token);
        expect(res.statusCode).toBe(200);
        const row = await pool.query("SELECT auth_subject FROM app_user WHERE auth_subject = $1", [
          subject,
        ]);
        expect(row.rows[0].auth_subject).toBe(subject);
      });

      it("HELD: a NUL byte inside the token subject is a typed 400 validation.identifier, not a 500", async () => {
        const token = await minter.mint(`auth0|nul\u0000byte-${randomUUID()}`);
        const res = await bootstrap(token);
        expect(res.statusCode).toBe(400);
        expect((res.json() as Envelope).error.code).toBe("validation.identifier");
      });

      it("BROKEN (P3): AccountBootstrapRequest has no length caps — a 900 KB locale is stored verbatim in app_user.locale", async () => {
        const subject = `auth0|attack-huge-${randomUUID()}`;
        const token = await minter.mint(subject);
        const hugeLocale = "x".repeat(900 * 1024);
        const res = await app.inject({
          method: "POST",
          url: "/v1/account/bootstrap",
          headers: auth(token),
          payload: { ...bootstrapBody, locale: hugeLocale },
        });
        expect(res.statusCode).toBe(200);
        const row = await pool.query(
          "SELECT length(locale)::int AS n FROM app_user WHERE auth_subject = $1",
          [subject],
        );
        expect(row.rows[0].n).toBe(900 * 1024);
      });

      it("HELD: a body over Fastify's 1 MiB limit is a typed 413 validation.payload_too_large", async () => {
        const token = await minter.mint(`auth0|attack-413-${randomUUID()}`);
        const res = await app.inject({
          method: "POST",
          url: "/v1/account/bootstrap",
          headers: auth(token),
          payload: { ...bootstrapBody, locale: "x".repeat(1024 * 1024 + 10) },
        });
        expect(res.statusCode).toBe(413);
        expect((res.json() as Envelope).error.code).toBe("validation.payload_too_large");
      });
    });
  },
);
