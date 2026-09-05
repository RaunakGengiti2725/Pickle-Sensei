import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";

/**
 * ADJ-02 regression pin: concurrent FIRST bootstraps for one auth_subject.
 * The unique index on app_user.auth_subject already guarantees a single row;
 * the handler must also turn every loser of the insert race into the same
 * 200 response instead of a 500. Skipped (visibly) without DATABASE_URL_TEST.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "bootstrap-race-secret-0123456789";
const ATTEMPTS = 5;
const CONCURRENCY = 8;

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
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
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

function config(): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-test",
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
    adminAuthSubjects: [],
  };
}

describe.skipIf(!testUrl)(
  "POST /v1/account/bootstrap concurrent first bootstrap (real PostgreSQL)",
  () => {
    let app: FastifyInstance;
    let pool: pg.Pool;
    let minter: DevTokenVerifier;
    const subjects: string[] = [];

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: testUrl });
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      app = buildApp(config(), { queue: new InMemoryJobQueue() });
      await app.ready();
      minter = new DevTokenVerifier("test", DEV_SECRET);
      for (let i = 0; i < ATTEMPTS; i++) subjects.push(`auth0|boot-race-${randomUUID()}`);
    }, 60_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
    });

    it(`${CONCURRENCY} concurrent first bootstraps return 200 with one user id (${ATTEMPTS} subjects)`, async () => {
      const outcomes: Array<{
        subject: string;
        status: number;
        code: string | undefined;
        userId: string | undefined;
      }> = [];
      for (const subject of subjects) {
        const token = await minter.mint(subject);
        const responses = await Promise.all(
          Array.from({ length: CONCURRENCY }, () =>
            app.inject({
              method: "POST",
              url: "/v1/account/bootstrap",
              headers: { authorization: `Bearer ${token}` },
              payload: bootstrapBody,
            }),
          ),
        );
        for (const r of responses) {
          const body = r.json() as { error?: { code?: string }; user?: { id?: string } };
          outcomes.push({
            subject,
            status: r.statusCode,
            code: body.error?.code,
            userId: body.user?.id,
          });
        }
      }
      const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
        const k = `${o.status}${o.code ? `:${o.code}` : ""}`;
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {});
      console.log(`bootstrap-race outcomes: ${JSON.stringify(tally)}`);

      const non200 = outcomes.filter((o) => o.status !== 200);
      expect(non200, `bootstrap race produced ${non200.length} non-200 responses`).toEqual([]);
      for (const subject of subjects) {
        const ids = new Set(outcomes.filter((o) => o.subject === subject).map((o) => o.userId));
        expect(ids.size, `subject ${subject} saw user ids ${[...ids].join(",")}`).toBe(1);
        expect([...ids][0]).toBeTruthy();
      }
    }, 60_000);

    it("exactly one app_user row and one account.created audit row exist per subject", async () => {
      const rows = await pool.query<{ auth_subject: string; users: string; audits: string }>(
        `SELECT u.auth_subject,
              count(DISTINCT u.id)::text AS users,
              count(a.id)::text AS audits
         FROM app_user u
         LEFT JOIN audit_log a ON a.actor_user_id = u.id AND a.action = 'account.created'
        WHERE u.auth_subject = ANY($1::text[])
        GROUP BY u.auth_subject
        ORDER BY u.auth_subject`,
        [subjects],
      );
      expect(rows.rows.map((r) => r.auth_subject).sort()).toEqual([...subjects].sort());
      for (const r of rows.rows) {
        expect(r.users, `${r.auth_subject} app_user rows`).toBe("1");
        expect(r.audits, `${r.auth_subject} account.created audits`).toBe("1");
      }
    });
  },
);
