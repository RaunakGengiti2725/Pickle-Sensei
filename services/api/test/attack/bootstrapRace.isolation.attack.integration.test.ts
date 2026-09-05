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
 * ATTACK variant: the ADJ-02 fix relies on READ COMMITTED semantics (the
 * re-SELECT after `ON CONFLICT DO NOTHING` takes a fresh snapshot). This suite
 * probes what happens when the API's connections run under a stricter
 * default_transaction_isolation (a per-role / per-database setting a DBA can
 * apply without touching the code). Under REPEATABLE READ PostgreSQL raises
 * SQLSTATE 40001 ("could not serialize access due to concurrent update") from
 * `INSERT … ON CONFLICT DO NOTHING` when the conflicting row was committed after
 * the transaction's snapshot; resolveAccount() has no retry, so the racer
 * surfaces as 500 api.internal_error. Skipped (visibly) without DATABASE_URL_TEST.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "attack-bootstrap-isolation-secret-0123456789";
const schemaName = `attack_iso_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

const CONCURRENCY = 16;

function scoped(base: string, schema: string, isolation?: string): string {
  const url = new URL(base);
  const opts = [`-c search_path=${schema}`];
  if (isolation) opts.push(`-c default_transaction_isolation=${isolation.replace(" ", "\\ ")}`);
  url.searchParams.set("options", opts.join(" "));
  return url.toString();
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack-iso" },
};

function configFor(databaseUrl: string): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-test",
    databaseUrl,
    devAuthSecret: secret,
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

describe.skipIf(!testUrl)("ATTACK ADJ-02 under non-default transaction isolation", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let minter: DevTokenVerifier;
  const apps: FastifyInstance[] = [];

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: scoped(testUrl!, schemaName) });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    minter = new DevTokenVerifier("test", secret);
  }, 120_000);

  afterAll(async () => {
    for (const a of apps) await a.close();
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  async function race(isolation: string | undefined) {
    const app = buildApp(configFor(scoped(testUrl!, schemaName, isolation)), {
      queue: new InMemoryJobQueue(),
    });
    apps.push(app);
    await app.ready();
    const probe = new pg.Pool({ connectionString: scoped(testUrl!, schemaName, isolation) });
    const check = await probe.query<{ default_transaction_isolation: string }>(
      "SHOW default_transaction_isolation",
    );
    await probe.end();
    const level = check.rows[0]!.default_transaction_isolation;
    const subject = `auth0|atk-iso-${isolation ?? "default"}-${randomUUID()}`;
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
    const tally: Record<string, number> = {};
    for (const r of responses) {
      const b = r.json() as { error?: { code?: string } };
      const k = `${r.statusCode}${b.error?.code ? ":" + b.error.code : ""}`;
      tally[k] = (tally[k] ?? 0) + 1;
    }
    console.log(
      `ATK-ISOLATION[${level}] ${CONCURRENCY} concurrent first bootstraps → ${JSON.stringify(tally)}`,
    );
    return { tally, isolation: level };
  }

  it("ATK-ISOLATION-RC: under the server default (read committed) every racer is 200", async () => {
    const { tally, isolation } = await race(undefined);
    expect(isolation).toBe("read committed");
    expect(tally).toEqual({ "200": CONCURRENCY });
  }, 120_000);

  it("ATK-ISOLATION-RR: under default_transaction_isolation=repeatable read every racer is still 200", async () => {
    const { tally, isolation } = await race("repeatable read");
    expect(isolation).toBe("repeatable read");
    expect(tally).toEqual({ "200": CONCURRENCY });
  }, 120_000);
});
