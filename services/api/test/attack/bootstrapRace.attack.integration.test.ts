import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from "fastify";
import { SignJWT } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * ATTACK suite for the ADJ-02 / ADJ-03 bootstrap fix (candidate 9907196e).
 * Every scenario here is a variant of the original repro at (at least) double
 * the original scale, or a neighbouring path the fix touched. Each `it`
 * prints its observed outcome tally so a failure is self-describing.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "attack-bootstrap-race-secret-0123456789";
const schemaName = `attack_boot_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

const SUBJECTS = 10; // 2× the original 5
const CONCURRENCY = 16; // 2× the original 8
const OVERSUBSCRIBED = 32; // > pg.Pool default max (10) — every connection blocked on the winner

function schemaUrl(base: string, schema: string, extra: string[] = []): string {
  const url = new URL(base);
  url.searchParams.set("options", [`-c search_path=${schema}`, ...extra].join(" "));
  return url.toString();
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack" },
};

type Outcome = { status: number; code: string | undefined; userId: string | undefined };
type ErrorEnvelope = { error?: { code?: string } };

function tally(outcomes: Outcome[]): Record<string, number> {
  return outcomes.reduce<Record<string, number>>((acc, o) => {
    const k = `${o.status}${o.code ? `:${o.code}` : ""}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

function outcomeOf(r: { statusCode: number; json: () => unknown }): Outcome {
  const body = r.json() as ErrorEnvelope & { user?: { id?: string } };
  return { status: r.statusCode, code: body.error?.code, userId: body.user?.id };
}

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

describe.skipIf(!testUrl)("ATTACK ADJ-02/ADJ-03 bootstrap (isolated PostgreSQL schema)", () => {
  let app: FastifyInstance;
  let appB: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let minter: DevTokenVerifier;
  let scopedUrl: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  function bootstrap(
    target: FastifyInstance,
    token: string,
    body: InjectOptions["payload"] = bootstrapBody,
  ): Promise<LightMyRequestResponse> {
    return target.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: body,
    });
  }

  async function fire(target: FastifyInstance, token: string, n: number): Promise<Outcome[]> {
    const responses = await Promise.all(Array.from({ length: n }, () => bootstrap(target, token)));
    return responses.map(outcomeOf);
  }

  async function rowsFor(subject: string) {
    const r = await pool.query<{ users: string; audits: string; devices: string }>(
      `SELECT count(DISTINCT u.id)::text AS users,
              (SELECT count(*) FROM audit_log a WHERE a.action = 'account.created'
                  AND a.actor_user_id IN (SELECT id FROM app_user WHERE auth_subject = $1))::text AS audits,
              (SELECT count(*) FROM user_device d
                  WHERE d.user_id IN (SELECT id FROM app_user WHERE auth_subject = $1))::text AS devices
         FROM app_user u WHERE u.auth_subject = $1`,
      [subject],
    );
    return r.rows[0]!;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedUrl = schemaUrl(testUrl!, schemaName);
    pool = new pg.Pool({ connectionString: scopedUrl });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    app = buildApp(configFor(scopedUrl), { queue: new InMemoryJobQueue() });
    appB = buildApp(configFor(scopedUrl), { queue: new InMemoryJobQueue() });
    await Promise.all([app.ready(), appB.ready()]);
    minter = new DevTokenVerifier("test", secret);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await appB?.close();
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  it(`ATK-RACE-2X: ${SUBJECTS} subjects × ${CONCURRENCY} concurrent first bootstraps all return 200 with one id`, async () => {
    const all: Outcome[] = [];
    for (let i = 0; i < SUBJECTS; i++) {
      const subject = `auth0|atk-2x-${randomUUID()}`;
      const outcomes = await fire(app, await minter.mint(subject), CONCURRENCY);
      all.push(...outcomes);
      const ids = new Set(outcomes.map((o) => o.userId));
      expect(ids.size, `subject ${subject} ids=${[...ids].join(",")}`).toBe(1);
      const rows = await rowsFor(subject);
      expect(rows.users).toBe("1");
      expect(rows.audits).toBe("1");
      expect(rows.devices, "one user_device row per successful bootstrap").toBe(
        String(CONCURRENCY),
      );
    }
    console.log(`ATK-RACE-2X outcomes: ${JSON.stringify(tally(all))}`);
    expect(all.filter((o) => o.status !== 200)).toEqual([]);
  }, 120_000);

  it(`ATK-RACE-OVERSUBSCRIBED: ${OVERSUBSCRIBED} concurrent first bootstraps (> pool max) neither deadlock nor 500`, async () => {
    const subject = `auth0|atk-oversub-${randomUUID()}`;
    const outcomes = await fire(app, await minter.mint(subject), OVERSUBSCRIBED);
    console.log(`ATK-RACE-OVERSUBSCRIBED outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    expect(new Set(outcomes.map((o) => o.userId)).size).toBe(1);
    expect((await rowsFor(subject)).users).toBe("1");
  }, 120_000);

  it("ATK-RACE-TWO-INSTANCES: two API processes (two pools) racing the same fresh subject agree on one id", async () => {
    for (let i = 0; i < 3; i++) {
      const subject = `auth0|atk-two-${randomUUID()}`;
      const token = await minter.mint(subject);
      const [a, b] = await Promise.all([fire(app, token, 8), fire(appB, token, 8)]);
      const outcomes = [...a, ...b];
      console.log(`ATK-RACE-TWO-INSTANCES outcomes: ${JSON.stringify(tally(outcomes))}`);
      expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
      expect(new Set(outcomes.map((o) => o.userId)).size).toBe(1);
      expect((await rowsFor(subject)).users).toBe("1");
    }
  }, 120_000);

  it("ATK-RACE-EXTERNAL-COMMIT: losers adopt a row committed by a foreign transaction that held the insert open", async () => {
    const subject = `auth0|atk-ext-commit-${randomUUID()}`;
    const token = await minter.mint(subject);
    const foreign = await pool.connect();
    try {
      await foreign.query("BEGIN");
      const ins = await foreign.query<{ id: string }>(
        "INSERT INTO app_user (auth_subject, locale, timezone) VALUES ($1, 'en-US', 'UTC') RETURNING id",
        [subject],
      );
      const foreignId = ins.rows[0]!.id;
      const pending = fire(app, token, CONCURRENCY);
      // Give the bootstraps time to block on the uncommitted unique-index entry.
      await new Promise((r) => setTimeout(r, 300));
      await foreign.query("COMMIT");
      const outcomes = await pending;
      console.log(`ATK-RACE-EXTERNAL-COMMIT outcomes: ${JSON.stringify(tally(outcomes))}`);
      expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
      expect(new Set(outcomes.map((o) => o.userId))).toEqual(new Set([foreignId]));
      const rows = await rowsFor(subject);
      expect(rows.users).toBe("1");
      expect(rows.audits, "nobody may claim to have created a row they adopted").toBe("0");
    } finally {
      foreign.release();
    }
  }, 120_000);

  it("ATK-RACE-EXTERNAL-ROLLBACK: when the blocking foreign insert rolls back, exactly one bootstrap creates the row", async () => {
    const subject = `auth0|atk-ext-rollback-${randomUUID()}`;
    const token = await minter.mint(subject);
    const foreign = await pool.connect();
    try {
      await foreign.query("BEGIN");
      await foreign.query(
        "INSERT INTO app_user (auth_subject, locale, timezone) VALUES ($1, 'en-US', 'UTC')",
        [subject],
      );
      const pending = fire(app, token, CONCURRENCY);
      await new Promise((r) => setTimeout(r, 300));
      await foreign.query("ROLLBACK");
      const outcomes = await pending;
      console.log(`ATK-RACE-EXTERNAL-ROLLBACK outcomes: ${JSON.stringify(tally(outcomes))}`);
      expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
      expect(new Set(outcomes.map((o) => o.userId)).size).toBe(1);
      const rows = await rowsFor(subject);
      expect(rows.users).toBe("1");
      expect(rows.audits).toBe("1");
    } finally {
      foreign.release();
    }
  }, 120_000);

  it("ATK-RACE-DELETED-BEFORE-VISIBLE: a row that is deleted before the losers see it yields 410 for every loser and no device row", async () => {
    const subject = `auth0|atk-ext-deleted-${randomUUID()}`;
    const token = await minter.mint(subject);
    const foreign = await pool.connect();
    try {
      await foreign.query("BEGIN");
      await foreign.query(
        "INSERT INTO app_user (auth_subject, locale, timezone, status, deleted_at) VALUES ($1, 'en-US', 'UTC', 'deleted', now())",
        [subject],
      );
      const pending = fire(app, token, CONCURRENCY);
      await new Promise((r) => setTimeout(r, 300));
      await foreign.query("COMMIT");
      const outcomes = await pending;
      console.log(`ATK-RACE-DELETED-BEFORE-VISIBLE outcomes: ${JSON.stringify(tally(outcomes))}`);
      expect(outcomes.filter((o) => o.status !== 410 || o.code !== "account.deleted")).toEqual([]);
      const rows = await rowsFor(subject);
      expect(rows.users).toBe("1");
      expect(rows.devices).toBe("0");
    } finally {
      foreign.release();
    }
  }, 120_000);

  it("ATK-STATUS-SUSPENDED-CONCURRENT: 16 concurrent bootstraps of a suspended account are all 401 auth.suspended and write nothing", async () => {
    const subject = `auth0|atk-susp-${randomUUID()}`;
    const token = await minter.mint(subject);
    const first = await bootstrap(app, token);
    expect(first.statusCode).toBe(200);
    const userId = outcomeOf(first).userId!;
    await pool.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [userId]);
    const before = await rowsFor(subject);
    const outcomes = await fire(app, token, CONCURRENCY);
    console.log(`ATK-STATUS-SUSPENDED-CONCURRENT outcomes: ${JSON.stringify(tally(outcomes))}`);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
    const meBody = me.json() as ErrorEnvelope;
    for (const o of outcomes) {
      expect(o.status).toBe(me.statusCode);
      expect(o.code).toBe(meBody.error?.code);
    }
    const after = await rowsFor(subject);
    expect(after).toEqual(before);
    const audits = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM audit_log WHERE actor_user_id = $1",
      [userId],
    );
    expect(audits.rows[0]!.n, "no audit row is written for a refused bootstrap").toBe("1");
  }, 120_000);

  it("ATK-STATUS-DELETED-CONCURRENT: 16 concurrent bootstraps of a deleted account are all 410 and never resurrect the row", async () => {
    const subject = `auth0|atk-del-${randomUUID()}`;
    const token = await minter.mint(subject);
    const first = await bootstrap(app, token);
    expect(first.statusCode).toBe(200);
    const userId = outcomeOf(first).userId!;
    await pool.query("UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1", [
      userId,
    ]);
    const before = await rowsFor(subject);
    const outcomes = await fire(app, token, CONCURRENCY);
    console.log(`ATK-STATUS-DELETED-CONCURRENT outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(outcomes.filter((o) => o.status !== 410 || o.code !== "account.deleted")).toEqual([]);
    const after = await rowsFor(subject);
    expect(after).toEqual(before);
    const status = await pool.query<{ status: string }>(
      "SELECT status FROM app_user WHERE id = $1",
      [userId],
    );
    expect(status.rows[0]!.status).toBe("deleted");
  }, 120_000);

  it("ATK-STATUS-REINSTATED: an account moved suspended → active bootstraps again with the SAME id (no second row)", async () => {
    const subject = `auth0|atk-reinstate-${randomUUID()}`;
    const token = await minter.mint(subject);
    const first = await bootstrap(app, token);
    const userId = outcomeOf(first).userId!;
    await pool.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [userId]);
    expect((await bootstrap(app, token)).statusCode).toBe(401);
    await pool.query("UPDATE app_user SET status = 'active' WHERE id = $1", [userId]);
    const again = await fire(app, token, CONCURRENCY);
    console.log(`ATK-STATUS-REINSTATED outcomes: ${JSON.stringify(tally(again))}`);
    expect(again.filter((o) => o.status !== 200)).toEqual([]);
    expect(new Set(again.map((o) => o.userId))).toEqual(new Set([userId]));
  }, 120_000);

  it("ATK-STATUS-PARITY: for every app_user status the bootstrap reply equals authenticate()'s (except the pinned 410 for deleted)", async () => {
    const subject = `auth0|atk-parity-${randomUUID()}`;
    const token = await minter.mint(subject);
    const userId = outcomeOf(await bootstrap(app, token)).userId!;
    const seen: Record<string, string> = {};
    for (const status of ["active", "suspended", "deleted"] as const) {
      await pool.query("UPDATE app_user SET status = $2 WHERE id = $1", [userId, status]);
      const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
      const boot = await bootstrap(app, token);
      const meCode = (me.json() as ErrorEnvelope).error?.code;
      const bootCode = (boot.json() as ErrorEnvelope).error?.code;
      seen[status] =
        `me=${me.statusCode}${meCode ? ":" + meCode : ""} boot=${boot.statusCode}${bootCode ? ":" + bootCode : ""}`;
      if (status === "deleted") {
        expect(boot.statusCode).toBe(410);
        expect(bootCode).toBe("account.deleted");
        expect(me.statusCode).toBe(401);
      } else {
        expect(boot.statusCode).toBe(me.statusCode);
        expect(bootCode).toBe(meCode);
      }
    }
    console.log(`ATK-STATUS-PARITY ${JSON.stringify(seen)}`);
  }, 120_000);

  it("ATK-SUBJECT-BOUNDARY: unicode / 2 KiB / whitespace-adjacent subjects race correctly and stay distinct", async () => {
    const base = randomUUID();
    const subjects = [
      `apple|ünïcødé-${base}-\u{1F3D3}`,
      `apple|${"x".repeat(2048)}-${base}`,
      `apple|trail-${base} `,
      `apple|trail-${base}`,
      `apple|Case-${base}`,
      `apple|case-${base}`,
    ];
    const ids = new Set<string>();
    const all: Outcome[] = [];
    for (const subject of subjects) {
      const outcomes = await fire(app, await minter.mint(subject), 8);
      all.push(...outcomes);
      const own = new Set(outcomes.map((o) => o.userId));
      expect(own.size, subject).toBe(1);
      ids.add([...own][0]!);
      expect((await rowsFor(subject)).users).toBe("1");
    }
    console.log(`ATK-SUBJECT-BOUNDARY outcomes: ${JSON.stringify(tally(all))}`);
    expect(all.filter((o) => o.status !== 200)).toEqual([]);
    expect(ids.size, "byte-distinct subjects must map to distinct accounts").toBe(subjects.length);
  }, 120_000);

  it("ATK-PAYLOAD: malformed bodies under concurrency are 400 validation.bootstrap and create no row", async () => {
    const subject = `auth0|atk-payload-${randomUUID()}`;
    const token = await minter.mint(subject);
    const bad: InjectOptions["payload"][] = [
      {},
      { locale: "en-US", timezone: "UTC" },
      { locale: null, timezone: "UTC", device: bootstrapBody.device },
      { ...bootstrapBody, device: { ...bootstrapBody.device, platform: "web" } },
      { ...bootstrapBody, device: { ...bootstrapBody.device, model: 42 } },
      [],
    ];
    const responses = await Promise.all(
      bad.flatMap((b) => [bootstrap(app, token, b), bootstrap(app, token, b)]),
    );
    const outcomes = responses.map(outcomeOf);
    console.log(`ATK-PAYLOAD outcomes: ${JSON.stringify(tally(outcomes))}`);
    for (const o of outcomes) {
      expect(o.status).toBe(400);
      expect(o.code).toBe("validation.bootstrap");
    }
    const raw = await Promise.all(
      ["{not json", "null", "", '"string"'].flatMap((body) =>
        Array.from({ length: 2 }, () =>
          app.inject({
            method: "POST",
            url: "/v1/account/bootstrap",
            headers: { ...auth(token), "content-type": "application/json" },
            payload: body,
          }),
        ),
      ),
    );
    console.log(`ATK-PAYLOAD raw outcomes: ${JSON.stringify(tally(raw.map(outcomeOf)))}`);
    for (const r of raw) {
      expect(r.statusCode, r.body).toBe(400);
    }
    const rows = await pool.query("SELECT 1 FROM app_user WHERE auth_subject = $1", [subject]);
    expect(rows.rowCount).toBe(0);
  }, 120_000);

  it("ATK-PARTIAL-ROW: a pre-existing app_user row with no profile/settings still bootstraps 200 and does not duplicate the row", async () => {
    const subject = `auth0|atk-partial-${randomUUID()}`;
    const token = await minter.mint(subject);
    const ins = await pool.query<{ id: string }>(
      "INSERT INTO app_user (auth_subject, locale, timezone) VALUES ($1, 'en-US', 'UTC') RETURNING id",
      [subject],
    );
    const outcomes = await fire(app, token, 8);
    console.log(`ATK-PARTIAL-ROW outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    expect(new Set(outcomes.map((o) => o.userId))).toEqual(new Set([ins.rows[0]!.id]));
    expect((await rowsFor(subject)).users).toBe("1");
  }, 120_000);

  it("ATK-TOKEN-STALE: an expired / foreign-secret token is refused before any account work (no row created)", async () => {
    const subject = `auth0|atk-stale-${randomUUID()}`;
    const other = new DevTokenVerifier("test", "a-completely-different-secret-0123456789");
    const forged = await other.mint(subject);
    const res = await fire(app, forged, 8);
    console.log(`ATK-TOKEN-STALE outcomes: ${JSON.stringify(tally(res))}`);
    for (const o of res) {
      expect(o.status).toBe(401);
      expect(o.code).toBe("auth.invalid_token");
    }
    const rows = await pool.query("SELECT 1 FROM app_user WHERE auth_subject = $1", [subject]);
    expect(rows.rowCount).toBe(0);
  }, 120_000);

  it("ATK-TOKEN-CLOCK: expired / not-yet-valid (clock skew) / wrong-issuer / no-sub tokens are 401 and create no row", async () => {
    const key = new TextEncoder().encode(secret);
    const base = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const variants: Array<[string, Promise<string>]> = [
      [
        "expired-1h",
        new SignJWT({ pickle_role: "user" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("pickle-dev")
          .setSubject(`auth0|atk-clock-exp-${base}`)
          .setIssuedAt(now - 7200)
          .setExpirationTime(now - 3600)
          .sign(key),
      ],
      [
        "nbf+1h-skew",
        new SignJWT({ pickle_role: "user" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("pickle-dev")
          .setSubject(`auth0|atk-clock-nbf-${base}`)
          .setNotBefore(now + 3600)
          .setExpirationTime(now + 7200)
          .sign(key),
      ],
      [
        "wrong-issuer",
        new SignJWT({ pickle_role: "user" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("pickle-prod")
          .setSubject(`auth0|atk-clock-iss-${base}`)
          .setExpirationTime(now + 900)
          .sign(key),
      ],
      [
        "no-sub",
        new SignJWT({ pickle_role: "user" })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("pickle-dev")
          .setExpirationTime(now + 900)
          .sign(key),
      ],
    ];
    const seen: Record<string, string> = {};
    for (const [name, tokenP] of variants) {
      const outcomes = await fire(app, await tokenP, 4);
      seen[name] = JSON.stringify(tally(outcomes));
      for (const o of outcomes) {
        expect(o.status, name).toBe(401);
        expect(["auth.invalid_token", "auth.no_subject"], name).toContain(o.code);
      }
    }
    console.log(`ATK-TOKEN-CLOCK ${JSON.stringify(seen)}`);
    const rows = await pool.query(
      "SELECT count(*)::text AS n FROM app_user WHERE auth_subject LIKE $1",
      [`auth0|atk-clock-%${base}`],
    );
    expect(rows.rows[0]!.n).toBe("0");
  }, 120_000);

  it("ATK-SUSPEND-MIDFLIGHT: a suspension committed while bootstraps are in flight never yields 5xx and is honoured by every later call", async () => {
    const subject = `auth0|atk-susp-mid-${randomUUID()}`;
    const token = await minter.mint(subject);
    const userId = outcomeOf(await bootstrap(app, token)).userId!;
    const foreign = await pool.connect();
    try {
      await foreign.query("BEGIN");
      await foreign.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [userId]);
      const pending = fire(app, token, CONCURRENCY);
      await new Promise((r) => setTimeout(r, 50));
      await foreign.query("COMMIT");
      const outcomes = await pending;
      console.log(`ATK-SUSPEND-MIDFLIGHT outcomes: ${JSON.stringify(tally(outcomes))}`);
      for (const o of outcomes) {
        expect(o.status, JSON.stringify(o)).toBeLessThan(500);
        expect([200, 401]).toContain(o.status);
        if (o.status === 401) expect(o.code).toBe("auth.suspended");
      }
    } finally {
      foreign.release();
    }
    const after = await fire(app, token, 8);
    expect(after.filter((o) => o.status !== 401 || o.code !== "auth.suspended")).toEqual([]);
    const me = await app.inject({ method: "GET", url: "/v1/me", headers: auth(token) });
    expect(me.statusCode).toBe(401);
    expect((await rowsFor(subject)).users).toBe("1");
  }, 120_000);

  it("ATK-DELETE-RACE: DELETE /v1/me racing 16 bootstraps leaves exactly one deleted row; nobody gets 5xx and every later bootstrap is 410", async () => {
    const subject = `auth0|atk-del-race-${randomUUID()}`;
    const token = await minter.mint(subject);
    const userId = outcomeOf(await bootstrap(app, token)).userId!;
    const [del, outcomes] = await Promise.all([
      app.inject({
        method: "DELETE",
        url: "/v1/me",
        headers: auth(token),
        payload: { confirmation: "DELETE" },
      }),
      fire(appB, token, CONCURRENCY),
    ]);
    console.log(
      `ATK-DELETE-RACE delete=${del.statusCode} outcomes: ${JSON.stringify(tally(outcomes))}`,
    );
    expect(del.statusCode).toBeLessThan(300);
    for (const o of outcomes) {
      expect([200, 410], JSON.stringify(o)).toContain(o.status);
      if (o.status === 200) expect(o.userId).toBe(userId);
    }
    const after = await fire(app, token, 8);
    expect(after.filter((o) => o.status !== 410 || o.code !== "account.deleted")).toEqual([]);
    const status = await pool.query<{ status: string; n: string }>(
      "SELECT status, (SELECT count(*)::text FROM app_user WHERE auth_subject = $1) AS n FROM app_user WHERE id = $2",
      [subject, userId],
    );
    expect(status.rows[0]).toEqual({ status: "deleted", n: "1" });
  }, 120_000);

  it("ATK-CLIENT-ABORT: clients that disconnect mid-flight over a real socket leave one consistent row and no stuck transaction", async () => {
    const subject = `auth0|atk-abort-${randomUUID()}`;
    const token = await minter.mint(subject);
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const url = `${address}/v1/account/bootstrap`;
    const aborted = Array.from({ length: CONCURRENCY }, (_, i) => {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), i % 2 === 0 ? 0 : 5);
      return fetch(url, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(bootstrapBody),
        signal: ac.signal,
      }).then(
        (r) => `${r.status}`,
        (e: Error) => `abort:${e.name}`,
      );
    });
    const live = Array.from({ length: CONCURRENCY }, () =>
      fetch(url, {
        method: "POST",
        headers: { ...auth(token), "content-type": "application/json" },
        body: JSON.stringify(bootstrapBody),
      }).then(async (r) => ({
        status: r.status,
        body: (await r.json()) as { user?: { id?: string } },
      })),
    );
    const [abortedOutcomes, liveOutcomes] = await Promise.all([
      Promise.all(aborted),
      Promise.all(live),
    ]);
    const abortTally = abortedOutcomes.reduce<Record<string, number>>((acc, k) => {
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {});
    console.log(
      `ATK-CLIENT-ABORT aborted=${JSON.stringify(abortTally)} live=${JSON.stringify(
        tally(
          liveOutcomes.map((o) => ({ status: o.status, code: undefined, userId: o.body.user?.id })),
        ),
      )}`,
    );
    for (const o of liveOutcomes) expect(o.status).toBe(200);
    expect(new Set(liveOutcomes.map((o) => o.body.user?.id)).size).toBe(1);
    const rows = await rowsFor(subject);
    expect(rows.users).toBe("1");
    expect(rows.audits).toBe("1");
    const idle = await adminPool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_stat_activity WHERE state = 'idle in transaction' AND datname = current_database()",
    );
    expect(idle.rows[0]!.n, "no connection left idle in transaction").toBe("0");
  }, 120_000);

  it("ATK-COMPAT: old-app payloads (extra/unknown fields, android platform) still bootstrap 200 exactly as on f702f0f8", async () => {
    const subject = `auth0|atk-compat-${randomUUID()}`;
    const token = await minter.mint(subject);
    const payloads = [
      { ...bootstrapBody, legacyField: true, device: { ...bootstrapBody.device, pushToken: "x" } },
      { ...bootstrapBody, device: { ...bootstrapBody.device, platform: "android" } },
    ];
    const outcomes = (
      await Promise.all(
        payloads.flatMap((p) => Array.from({ length: 8 }, () => bootstrap(app, token, p))),
      )
    ).map(outcomeOf);
    console.log(`ATK-COMPAT outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    expect(new Set(outcomes.map((o) => o.userId)).size).toBe(1);
    expect((await rowsFor(subject)).users).toBe("1");
  }, 120_000);
});
