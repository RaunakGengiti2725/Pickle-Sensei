import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * ADJ-03 pin: `POST /v1/account/bootstrap` must apply the same account-status
 * gate as `authenticate()`. A `suspended` app_user must receive the rejection
 * every other route gives; a `deleted` one keeps its dedicated 410
 * account.deleted (pinned by integration.test.ts — authenticate() answers
 * 401 auth.no_account there, so the codes intentionally differ); neither may
 * register a new `user_device` row; a subject with no row still bootstraps.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "adj03-bootstrap-status-secret-0123456789";
const schemaName = `adj03_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adj03" },
};

type ErrorEnvelope = { error: { code: string } };

describe.skipIf(!testUrl)(
  "ADJ-03 bootstrap account-status gate (isolated PostgreSQL schema)",
  () => {
    let app: FastifyInstance;
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let minter: DevTokenVerifier;
    const auth = (token: string) => ({ authorization: `Bearer ${token}` });

    async function deviceCount(userId: string): Promise<string> {
      const r = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM user_device WHERE user_id = $1",
        [userId],
      );
      return r.rows[0]!.n;
    }

    async function bootstrap(token: string, model: string) {
      return app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: { ...bootstrapBody, device: { ...bootstrapBody.device, model } },
      });
    }

    /** Creates an account, moves it to `status`, and returns the token + id. */
    async function accountWithStatus(status: "suspended" | "deleted") {
      const token = await minter.mint(`auth0|adj03-${status}-${randomUUID()}`);
      const first = await bootstrap(token, "first-device");
      expect(first.statusCode, first.body).toBe(200);
      const userId = (first.json() as { user: { id: string } }).user.id;
      await pool.query("UPDATE app_user SET status = $2 WHERE id = $1", [userId, status]);
      return { token, userId };
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
      };
      app = buildApp(config, { queue: new InMemoryJobQueue() });
      await app.ready();
      minter = new DevTokenVerifier("test", secret);
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
      await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool?.end();
    });

    it("ADJ-03-AC1: a suspended account gets authenticate()'s rejection from bootstrap and no new device row", async () => {
      const { token, userId } = await accountWithStatus("suspended");

      const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
      expect(me.statusCode, "control: authenticate() refuses suspended").not.toBe(200);
      const control = me.json() as ErrorEnvelope;
      expect(control.error.code).toBe("auth.suspended");

      const before = await deviceCount(userId);
      const again = await bootstrap(token, "after-suspend");
      const after = await deviceCount(userId);
      console.log(
        `ADJ-03-AC1: /v1/me → ${me.statusCode} ${control.error.code}; bootstrap after suspend → ${again.statusCode} ${again.body.slice(0, 160)}; user_device rows ${before} → ${after}`,
      );

      expect(again.statusCode, "suspended account must not bootstrap").toBe(me.statusCode);
      expect((again.json() as ErrorEnvelope).error.code).toBe(control.error.code);
      expect(after, "no user_device row may be written for a suspended account").toBe(before);
    });

    it("ADJ-03-AC2a: a deleted account is refused by bootstrap and no new device row is written", async () => {
      const { token, userId } = await accountWithStatus("deleted");
      const before = await deviceCount(userId);
      const again = await bootstrap(token, "after-delete");
      const after = await deviceCount(userId);
      console.log(
        `ADJ-03-AC2a: bootstrap after delete → ${again.statusCode} ${again.body.slice(0, 160)}; user_device rows ${before} → ${after}`,
      );
      expect(again.statusCode, "deleted account must not bootstrap").not.toBe(200);
      expect(after, "no user_device row may be written for a deleted account").toBe(before);
    });

    it("ADJ-03-AC3: a subject with no app_user row still bootstraps with 200 and one device row", async () => {
      const token = await minter.mint(`auth0|adj03-fresh-${randomUUID()}`);
      const first = await bootstrap(token, "fresh-device");
      expect(first.statusCode, first.body).toBe(200);
      const body = first.json() as { user: { id: string; status: string } };
      expect(body.user.status).toBe("active");
      expect(await deviceCount(body.user.id)).toBe("1");
    });
  },
);
