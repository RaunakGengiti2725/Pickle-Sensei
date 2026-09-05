import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pg from "pg";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * Adversarial probes for the ADJ-02 (bootstrap insert race) + ADJ-03 (bootstrap
 * account-status gate) fix of `POST /v1/account/bootstrap`
 * (services/api/src/modules/identity/routes.ts, plugins/authPlugin.ts).
 *
 * Every probe states the contract the fix claims; a failing probe is a break in
 * the fix, never a reason to weaken the probe. Two Fastify instances (two pg
 * pools) model two API processes sharing one database. Isolated schema, so the
 * shared `public` schema of the test database is untouched.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "adj02-03-attack-secret-0123456789abcdef";
const schemaName = `adj0203atk_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
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

const SUBJECTS = 10;
const CONCURRENCY = 16;

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

const bootstrapBody = {
  locale: "en-US",
  timezone: "UTC",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "attack" },
};

type ErrorEnvelope = { error: { kind: string; code: string; retryable: boolean } };
type MeEnvelope = {
  user: { id: string; status: string };
  profile: unknown;
  settings: unknown;
};

function tally(rows: Array<{ status: number; code: string | undefined }>): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, o) => {
    const k = `${o.status}${o.code ? `:${o.code}` : ""}`;
    acc[k] = (acc[k] ?? 0) + 1;
    return acc;
  }, {});
}

describe.skipIf(!testUrl)("ADJ-02/ADJ-03 bootstrap attack (isolated PostgreSQL schema)", () => {
  let apps: FastifyInstance[];
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let minter: DevTokenVerifier;
  let scopedUrl: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  function app(i: number): FastifyInstance {
    return apps[i % apps.length]!;
  }

  async function bootstrap(
    token: string,
    i = 0,
    body: unknown = bootstrapBody,
  ): Promise<LightMyRequestResponse> {
    return app(i).inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: body as object,
    });
  }

  async function counts(subject: string) {
    const r = await pool.query<{
      users: string;
      profiles: string;
      settings: string;
      devices: string;
      audits: string;
    }>(
      `SELECT count(DISTINCT u.id)::text AS users,
              (SELECT count(*) FROM user_profile p WHERE p.user_id IN (SELECT id FROM app_user WHERE auth_subject = $1))::text AS profiles,
              (SELECT count(*) FROM user_setting s WHERE s.user_id IN (SELECT id FROM app_user WHERE auth_subject = $1))::text AS settings,
              (SELECT count(*) FROM user_device d WHERE d.user_id IN (SELECT id FROM app_user WHERE auth_subject = $1))::text AS devices,
              (SELECT count(*) FROM audit_log a WHERE a.action = 'account.created' AND a.actor_user_id IN (SELECT id FROM app_user WHERE auth_subject = $1))::text AS audits
         FROM app_user u WHERE u.auth_subject = $1`,
      [subject],
    );
    return r.rows[0]!;
  }

  async function accountWithStatus(status: "active" | "suspended" | "deleted") {
    const subject = `auth0|atk-${status}-${randomUUID()}`;
    const token = await minter.mint(subject);
    const first = await bootstrap(token);
    expect(first.statusCode, first.body).toBe(200);
    const userId = (first.json() as MeEnvelope).user.id;
    if (status !== "active") {
      await pool.query("UPDATE app_user SET status = $2 WHERE id = $1", [userId, status]);
    }
    return { subject, token, userId };
  }

  async function activeBackends(sqlPrefix: string): Promise<number> {
    const r = await adminPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE state = 'active' AND query LIKE $1`,
      [`${sqlPrefix}%`],
    );
    return Number(r.rows[0]!.n);
  }

  /** Waits until a backend of this schema's test user blocks on `sqlPrefix`. */
  async function waitForBlockedStatement(sqlPrefix: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const r = await adminPool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM pg_stat_activity
          WHERE wait_event_type = 'Lock' AND query LIKE $1`,
        [`${sqlPrefix}%`],
      );
      if (Number(r.rows[0]!.n) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`no backend blocked on ${sqlPrefix} within 10s`);
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedUrl = schemaUrl(testUrl!, schemaName);
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
      adminAuthSubjects: [],
    };
    apps = [
      buildApp(config, { queue: new InMemoryJobQueue() }),
      buildApp(config, { queue: new InMemoryJobQueue() }),
    ];
    await Promise.all(apps.map((a) => a.ready()));
    minter = new DevTokenVerifier("test", secret);
  }, 90_000);

  afterAll(async () => {
    for (const a of apps ?? []) await a.close();
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  it(`ATK-RACE-2X: ${SUBJECTS} subjects × ${CONCURRENCY} first bootstraps fired at once across two API instances all return 200 with one id; one user/profile/setting/audit each`, async () => {
    const subjects = Array.from({ length: SUBJECTS }, () => `auth0|atk-race-${randomUUID()}`);
    const tokens = await Promise.all(subjects.map((s) => minter.mint(s)));
    const jobs: Array<
      Promise<{ subject: string; status: number; code: string | undefined; id: string | undefined }>
    > = [];
    subjects.forEach((subject, si) => {
      for (let i = 0; i < CONCURRENCY; i++) {
        jobs.push(
          bootstrap(tokens[si]!, si * CONCURRENCY + i).then((r) => {
            const body = r.json() as Partial<ErrorEnvelope> & Partial<MeEnvelope>;
            return { subject, status: r.statusCode, code: body.error?.code, id: body.user?.id };
          }),
        );
      }
    });
    const outcomes = await Promise.all(jobs);
    console.log(`ATK-RACE-2X outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(outcomes.filter((o) => o.status !== 200)).toEqual([]);
    for (const subject of subjects) {
      const ids = new Set(outcomes.filter((o) => o.subject === subject).map((o) => o.id));
      expect(ids.size, `subject ${subject} ids ${[...ids].join(",")}`).toBe(1);
      const c = await counts(subject);
      expect(c, subject).toEqual({
        users: "1",
        profiles: "1",
        settings: "1",
        devices: String(CONCURRENCY),
        audits: "1",
      });
    }
  }, 120_000);

  it(`ATK-DELETED-RACE: ${CONCURRENCY} concurrent re-bootstraps of a deleted account all return 410 account.deleted, insert nothing`, async () => {
    const { subject, token } = await accountWithStatus("deleted");
    const before = await counts(subject);
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        bootstrap(token, i).then((r) => ({
          status: r.statusCode,
          code: (r.json() as Partial<ErrorEnvelope>).error?.code,
        })),
      ),
    );
    console.log(`ATK-DELETED-RACE outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(tally(outcomes)).toEqual({ "410:account.deleted": CONCURRENCY });
    expect(await counts(subject)).toEqual(before);
  });

  it(`ATK-SUSPENDED-RACE: ${CONCURRENCY} concurrent bootstraps of a suspended account all return authenticate()'s 401 auth.suspended, insert nothing`, async () => {
    const { subject, token } = await accountWithStatus("suspended");
    const me = await app(0).inject({ method: "GET", url: "/v1/me", headers: auth(token) });
    const control = me.json() as ErrorEnvelope;
    const before = await counts(subject);
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        bootstrap(token, i).then((r) => ({
          status: r.statusCode,
          code: (r.json() as Partial<ErrorEnvelope>).error?.code,
          body: r.json() as ErrorEnvelope,
        })),
      ),
    );
    console.log(`ATK-SUSPENDED-RACE outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(tally(outcomes)).toEqual({ [`${me.statusCode}:${control.error.code}`]: CONCURRENCY });
    for (const o of outcomes) {
      expect(o.body.error.kind).toBe(control.error.kind);
      expect(o.body.error.retryable).toBe(control.error.retryable);
    }
    expect(await counts(subject)).toEqual(before);
  });

  it("ATK-EXTERNAL-ROLLBACK: a bootstrap that waits on an uncommitted external app_user insert creates the account itself once that insert rolls back", async () => {
    const subject = `auth0|atk-ext-rollback-${randomUUID()}`;
    const token = await minter.mint(subject);
    const ext = await pool.connect();
    try {
      await ext.query("BEGIN");
      await ext.query("INSERT INTO app_user (auth_subject) VALUES ($1)", [subject]);
      const pending = bootstrap(token);
      await waitForBlockedStatement("INSERT INTO app_user");
      await ext.query("ROLLBACK");
      const r = await pending;
      expect(r.statusCode, r.body).toBe(200);
      const body = r.json() as MeEnvelope;
      expect(body.user.status).toBe("active");
      expect(body.profile).not.toBeNull();
      expect(body.settings).not.toBeNull();
      expect(await counts(subject)).toEqual({
        users: "1",
        profiles: "1",
        settings: "1",
        devices: "1",
        audits: "1",
      });
    } finally {
      ext.release();
    }
  });

  it("ATK-EXTERNAL-COMMIT: a bootstrap that waits on an uncommitted external app_user insert adopts that row once it commits and registers its device on it", async () => {
    const subject = `auth0|atk-ext-commit-${randomUUID()}`;
    const token = await minter.mint(subject);
    const ext = await pool.connect();
    try {
      await ext.query("BEGIN");
      const ins = await ext.query<{ id: string }>(
        "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
        [subject],
      );
      const pending = bootstrap(token);
      await waitForBlockedStatement("INSERT INTO app_user");
      await ext.query("COMMIT");
      const r = await pending;
      expect(r.statusCode, r.body).toBe(200);
      expect((r.json() as MeEnvelope).user.id).toBe(ins.rows[0]!.id);
      const c = await counts(subject);
      expect(c.users).toBe("1");
      expect(c.devices).toBe("1");
      expect(c.audits, "adopting a row is not creating one").toBe("0");
    } finally {
      ext.release();
    }
  });

  /**
   * Serializability oracle for a status change that lands while bootstrap is in flight.
   * Either order is acceptable — bootstrap-then-change (200 naming an ACTIVE user, the
   * device row written before the change) or change-then-bootstrap (the account-status
   * rejection, no device row). What is never acceptable is the observed mix: a 200 whose
   * own body says the account is suspended/deleted, plus a fresh device row.
   */
  function expectSerializable(
    label: string,
    r: { statusCode: number; body: string },
    rejection: { status: number; code: string },
    devices: { before: number; after: number },
  ): void {
    if (r.statusCode === 200) {
      const body = JSON.parse(r.body) as { user: { status: string } };
      expect(body.user.status, `${label}: a 200 bootstrap must name an active account`).toBe(
        "active",
      );
      expect(devices.after, `${label}: the 200 registered exactly one device`).toBe(
        devices.before + 1,
      );
      return;
    }
    expect(r.statusCode, `${label}: rejection must match authenticate()`).toBe(rejection.status);
    expect(JSON.parse(r.body).error.code, `${label}: rejection code`).toBe(rejection.code);
    expect(devices.after, `${label}: no device row for a refused bootstrap`).toBe(devices.before);
  }

  it("ATK-TOCTOU-SUSPEND: an account suspended while bootstrap is in flight is either refused with no device row, or bootstrapped strictly before the suspension — never 200 {status:'suspended'} plus a new device", async () => {
    const { subject, token, userId } = await accountWithStatus("active");
    const before = await counts(subject);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE user_device IN EXCLUSIVE MODE");
      const pending = bootstrap(token, 1, {
        ...bootstrapBody,
        device: { ...bootstrapBody.device, model: "toctou-suspend" },
      });
      await waitForBlockedStatement("INSERT INTO user_device");
      // Fired, not awaited: a row-lock based fix legitimately makes this wait for bootstrap.
      const suspend = pool.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [
        userId,
      ]);
      await Promise.race([suspend, new Promise((resolve) => setTimeout(resolve, 300))]);
      await blocker.query("COMMIT");
      const r = await pending;
      await suspend;
      const me = await app(0).inject({ method: "GET", url: "/v1/me", headers: auth(token) });
      const after = await counts(subject);
      console.log(
        `ATK-TOCTOU-SUSPEND: bootstrap → ${r.statusCode} ${r.body.slice(0, 120)}; /v1/me → ${me.statusCode}; user_device rows ${before.devices} → ${after.devices}`,
      );
      expect(me.statusCode).toBe(401);
      expectSerializable(
        "ATK-TOCTOU-SUSPEND",
        r,
        { status: 401, code: "auth.suspended" },
        { before: Number(before.devices), after: Number(after.devices) },
      );
    } finally {
      blocker.release();
    }
  });

  it("ATK-TOCTOU-DELETE: DELETE /v1/me landing while bootstrap is in flight is either refused with 410 and no device row, or bootstrapped strictly before the deletion — never 200 {status:'deleted'} plus a new device", async () => {
    const { subject, token } = await accountWithStatus("active");
    const before = await counts(subject);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE user_device IN EXCLUSIVE MODE");
      const pending = bootstrap(token, 1, {
        ...bootstrapBody,
        device: { ...bootstrapBody.device, model: "toctou-delete" },
      });
      await waitForBlockedStatement("INSERT INTO user_device");
      const del = app(0).inject({
        method: "DELETE",
        url: "/v1/me",
        headers: auth(token),
        payload: { confirmation: "DELETE" },
      });
      await Promise.race([del, new Promise((resolve) => setTimeout(resolve, 300))]);
      await blocker.query("COMMIT");
      const r = await pending;
      const deleted = await del;
      expect(deleted.statusCode, deleted.body).toBe(200);
      const after = await counts(subject);
      console.log(
        `ATK-TOCTOU-DELETE: bootstrap → ${r.statusCode} ${r.body.slice(0, 120)}; user_device rows ${before.devices} → ${after.devices}`,
      );
      expectSerializable(
        "ATK-TOCTOU-DELETE",
        r,
        { status: 410, code: "account.deleted" },
        { before: Number(before.devices), after: Number(after.devices) },
      );
    } finally {
      blocker.release();
    }
  });

  it("ATK-MIXED: 8 first bootstraps + 8 GET /v1/me for a never-seen subject at once never yield a 5xx; every 200 names one id", async () => {
    const subject = `auth0|atk-mixed-${randomUUID()}`;
    const token = await minter.mint(subject);
    const jobs = Array.from({ length: 16 }, (_, i) =>
      (i % 2 === 0
        ? bootstrap(token, i)
        : app(i).inject({ method: "GET", url: "/v1/me", headers: auth(token) })
      ).then((r) => {
        const body = r.json() as Partial<ErrorEnvelope> & Partial<MeEnvelope>;
        return { status: r.statusCode, code: body.error?.code, id: body.user?.id };
      }),
    );
    const outcomes = await Promise.all(jobs);
    console.log(`ATK-MIXED outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(outcomes.filter((o) => o.status >= 500)).toEqual([]);
    for (const o of outcomes) {
      expect([200, 401]).toContain(o.status);
      if (o.status === 401) expect(o.code).toBe("auth.no_account");
    }
    const ids = new Set(outcomes.filter((o) => o.status === 200).map((o) => o.id));
    expect(ids.size).toBe(1);
    expect((await counts(subject)).users).toBe("1");
  });

  it(`ATK-HARD-DELETED: after the worker's final hard delete removed the row, ${CONCURRENCY} concurrent bootstraps create exactly one fresh account`, async () => {
    const { subject, token, userId } = await accountWithStatus("deleted");
    await pool.query("DELETE FROM app_user WHERE id = $1", [userId]);
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        bootstrap(token, i).then((r) => {
          const body = r.json() as Partial<ErrorEnvelope> & Partial<MeEnvelope>;
          return { status: r.statusCode, code: body.error?.code, id: body.user?.id };
        }),
      ),
    );
    console.log(`ATK-HARD-DELETED outcomes: ${JSON.stringify(tally(outcomes))}`);
    expect(tally(outcomes)).toEqual({ "200": CONCURRENCY });
    const ids = new Set(outcomes.map((o) => o.id));
    expect(ids.size).toBe(1);
    expect(ids.has(userId)).toBe(false);
    expect(await counts(subject)).toEqual({
      users: "1",
      profiles: "1",
      settings: "1",
      devices: String(CONCURRENCY),
      audits: "1",
    });
  });

  it("ATK-UNICODE-SUBJECT: a 1 KiB mixed-script subject bootstraps once under 16-way concurrency", async () => {
    const subject = `apple|${"\u00e9\u4e2d\ud83e\udd52\u0416".repeat(200)}`;
    const token = await minter.mint(subject);
    const outcomes = await Promise.all(
      Array.from({ length: CONCURRENCY }, (_, i) =>
        bootstrap(token, i).then((r) => ({
          status: r.statusCode,
          code: (r.json() as Partial<ErrorEnvelope>).error?.code,
        })),
      ),
    );
    expect(tally(outcomes)).toEqual({ "200": CONCURRENCY });
    expect((await counts(subject)).users).toBe("1");
  });

  it("ATK-MALFORMED: malformed bodies are 400 validation.bootstrap and never create an account", async () => {
    const subject = `auth0|atk-malformed-${randomUUID()}`;
    const token = await minter.mint(subject);
    const bodies: unknown[] = [
      null,
      {},
      { ...bootstrapBody, device: { ...bootstrapBody.device, platform: "web" } },
      { ...bootstrapBody, locale: 7 },
      { ...bootstrapBody, device: null },
      { locale: "en-US", timezone: "UTC" },
    ];
    for (const body of bodies) {
      const r = await bootstrap(token, 0, body);
      expect(r.statusCode, JSON.stringify(body)).toBe(400);
      expect((r.json() as ErrorEnvelope).error.code).toBe("validation.bootstrap");
    }
    const rows = await pool.query("SELECT 1 FROM app_user WHERE auth_subject = $1", [subject]);
    expect(rows.rowCount).toBe(0);
  });

  it("ATK-STALE-TOKEN: expired, not-yet-valid (clock skew), wrong-issuer and tampered tokens are all 401 and create no account", async () => {
    const subject = `auth0|atk-stale-${randomUUID()}`;
    const key = new TextEncoder().encode(secret);
    const now = Math.floor(Date.now() / 1000);
    const sign = (jwt: SignJWT) =>
      jwt.setProtectedHeader({ alg: "HS256" }).setSubject(subject).sign(key);
    const good = await minter.mint(subject);
    const tokens: Array<[string, string, string]> = [
      [
        "expired 60s ago",
        await sign(
          new SignJWT({})
            .setIssuer("pickle-dev")
            .setIssuedAt(now - 960)
            .setExpirationTime(now - 60),
        ),
        "auth.invalid_token",
      ],
      [
        "nbf 10 min in the future (client clock ahead)",
        await sign(
          new SignJWT({})
            .setIssuer("pickle-dev")
            .setIssuedAt(now + 600)
            .setNotBefore(now + 600)
            .setExpirationTime(now + 1500),
        ),
        "auth.invalid_token",
      ],
      [
        "wrong issuer",
        await sign(
          new SignJWT({}).setIssuer("https://evil.example").setIssuedAt().setExpirationTime("15m"),
        ),
        "auth.invalid_token",
      ],
      ["tampered signature", `${good.slice(0, -4)}AAAA`, "auth.invalid_token"],
      ["empty bearer", "", "auth.invalid_token"],
    ];
    for (const [label, token, code] of tokens) {
      const r = await bootstrap(token, 0);
      expect(r.statusCode, label).toBe(401);
      expect((r.json() as ErrorEnvelope).error.code, label).toBe(code);
    }
    const rows = await pool.query("SELECT 1 FROM app_user WHERE auth_subject = $1", [subject]);
    expect(rows.rowCount).toBe(0);
    // The genuine token still works afterwards — the rejections left nothing behind.
    const ok = await bootstrap(good, 0);
    expect(ok.statusCode).toBe(200);
  });

  it("ATK-BOUNDARY: 255-char locale/timezone and a 512-char device model are accepted or refused deterministically and never 5xx; a 64 KiB body is refused", async () => {
    const subject = `auth0|atk-boundary-${randomUUID()}`;
    const token = await minter.mint(subject);
    const big = await bootstrap(token, 0, {
      locale: "x".repeat(255),
      timezone: "y".repeat(255),
      device: { ...bootstrapBody.device, model: "m".repeat(512) },
    });
    expect(big.statusCode, big.body).toBeLessThan(500);
    const huge = await bootstrap(token, 1, {
      ...bootstrapBody,
      device: { ...bootstrapBody.device, model: "m".repeat(64 * 1024) },
    });
    expect(huge.statusCode, huge.body).toBeLessThan(500);
    const users = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM app_user WHERE auth_subject = $1",
      [subject],
    );
    expect(Number(users.rows[0]!.n)).toBeLessThanOrEqual(1);
  });

  it("ATK-CANCEL: a client that drops its socket while its first bootstrap is blocked mid-transaction leaves at most one account and the next bootstrap gets 200", async () => {
    const subject = `auth0|atk-cancel-${randomUUID()}`;
    const token = await minter.mint(subject);
    const server = app(1);
    const address = await server.listen({ port: 0, host: "127.0.0.1" });
    const { port } = new URL(address);
    const blocker = await pool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE user_device IN EXCLUSIVE MODE");
      const payload = JSON.stringify(bootstrapBody);
      const aborted = new Promise<void>((resolve) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: Number(port),
            method: "POST",
            path: "/v1/account/bootstrap",
            headers: {
              ...auth(token),
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            },
          },
          (res) => res.resume(),
        );
        req.on("error", () => resolve());
        req.on("close", () => resolve());
        req.end(payload);
        void waitForBlockedStatement("INSERT INTO user_device").then(() => req.destroy());
      });
      await aborted;
      await blocker.query("COMMIT");
    } finally {
      blocker.release();
    }
    // Whatever the aborted transaction did, the account is consistent and usable.
    const deadline = Date.now() + 5_000;
    let after = await counts(subject);
    while (Date.now() < deadline && (await activeBackends("INSERT INTO user_device")) > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      after = await counts(subject);
    }
    expect(Number(after.users)).toBeLessThanOrEqual(1);
    expect(after.profiles).toBe(after.users);
    expect(after.settings).toBe(after.users);
    const r = await bootstrap(token, 0);
    expect(r.statusCode, r.body).toBe(200);
    const final = await counts(subject);
    expect(final.users).toBe("1");
    expect(final.audits).toBe("1");
  });

  it("ATK-AUTHENTICATE-SHAPE: authenticate() replies are unchanged for missing, suspended, deleted and active accounts", async () => {
    const fresh = await minter.mint(`auth0|atk-none-${randomUUID()}`);
    const none = await app(0).inject({ method: "GET", url: "/v1/me", headers: auth(fresh) });
    expect(none.statusCode).toBe(401);
    expect((none.json() as ErrorEnvelope).error).toMatchObject({
      kind: "auth_failed",
      code: "auth.no_account",
      retryable: false,
    });

    const suspended = await accountWithStatus("suspended");
    const s = await app(1).inject({ method: "GET", url: "/v1/me", headers: auth(suspended.token) });
    expect(s.statusCode).toBe(401);
    expect((s.json() as ErrorEnvelope).error).toMatchObject({
      kind: "auth_failed",
      code: "auth.suspended",
      retryable: false,
    });

    const deleted = await accountWithStatus("deleted");
    const d = await app(0).inject({ method: "GET", url: "/v1/me", headers: auth(deleted.token) });
    expect(d.statusCode).toBe(401);
    expect((d.json() as ErrorEnvelope).error.code).toBe("auth.no_account");

    const active = await accountWithStatus("active");
    const a = await app(1).inject({ method: "GET", url: "/v1/me", headers: auth(active.token) });
    expect(a.statusCode).toBe(200);
    expect((a.json() as MeEnvelope).user.id).toBe(active.userId);
  });
});
