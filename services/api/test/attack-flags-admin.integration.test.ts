import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import { FLAG_REGISTRY } from "../src/modules/flags/registry.js";
import { FakeObjectStore } from "./support/fakeObjectStore.js";

/**
 * Adversarial pass 3 (services-api-legacy-admin-web) — feature-flag attack
 * surface against a REAL PostgreSQL schema:
 *
 *  S1  PUT /v1/admin/flags/<unregistered key> as admin: is a row created and
 *      audited, or is the key rejected?
 *  S5  GET /v1/flags cohort decision at rollout 0 / 100 / 37 and at the exact
 *      boundary bucket ((sha256(key:userId)[0] << 8 | [1]) % 100).
 *  S7  seed twice, flip a seeded flag, seed a third time — the operator's
 *      override must survive (ON CONFLICT (key) DO NOTHING).
 *  +   unicode / huge / empty keys, `{}` body, user-role and non-allowlisted
 *      admin denial, rapid interleaved PUTs, audit-row content.
 *
 * Every assertion below records the behaviour of the revision under test; a
 * test that FAILS is a finding, a test that passes is a HELD invariant.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const secret = "attack-flags-admin-secret-0123456789";
const adminSubject = "attack|flags-admin";
const schemaName = `attack_flags_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
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

/** Mirror of services/api/src/modules/flags/routes.ts rolloutBucket(). */
function rolloutBucket(flagKey: string, userId: string): number {
  const digest = createHash("sha256").update(`${flagKey}:${userId}`).digest();
  return ((digest[0]! << 8) | digest[1]!) % 100;
}

const bootstrapPayload = {
  locale: "en-US",
  timezone: "America/Los_Angeles",
  device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
};

describe.skipIf(!testUrl)("attack: admin flag writes + rollout cohorts (isolated schema)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let minter: DevTokenVerifier;
  let adminToken: string;
  let adminUserId: string;
  let userToken: string;
  let userId: string;
  let unlistedAdminToken: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function bootstrap(token: string, subject: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(token),
      payload: bootstrapPayload,
    });
    expect(res.statusCode, res.body).toBe(200);
    const row = await pool.query<{ id: string }>(
      "SELECT id FROM app_user WHERE auth_subject = $1",
      [subject],
    );
    return row.rows[0]!.id;
  }

  async function putFlag(token: string, key: string, body: unknown) {
    return app.inject({
      method: "PUT",
      url: `/v1/admin/flags/${encodeURIComponent(key)}`,
      headers: auth(token),
      payload: body as Record<string, unknown>,
    });
  }

  async function getFlags(token: string): Promise<Record<string, boolean>> {
    const res = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(token) });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { flags: Record<string, boolean> }).flags;
  }

  async function flagRow(key: string) {
    const res = await pool.query<{
      key: string;
      description: string;
      enabled: boolean;
      rollout_percent: number;
    }>("SELECT key, description, enabled, rollout_percent FROM feature_flag WHERE key = $1", [key]);
    return res.rows[0] ?? null;
  }

  async function auditRows(targetId: string) {
    const res = await pool.query<{
      actor_user_id: string | null;
      action: string;
      target_kind: string | null;
      target_id: string | null;
      metadata: Record<string, unknown>;
    }>(
      `SELECT actor_user_id, action, target_kind, target_id, metadata
         FROM audit_log WHERE target_id = $1 ORDER BY id`,
      [targetId],
    );
    return res.rows;
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
      adminAuthSubjects: [adminSubject],
      oidcIssuer: undefined,
      oidcAudience: undefined,
      oidcJwksUrl: undefined,
      sqsQueueUrl: undefined,
      consentExportSigningKey: undefined,
      consentExportSigningKeyId: "consent-export-k1",
      appleIapConfigured: false,
      googlePlayConfigured: false,
    };
    app = buildApp(config, { queue: new InMemoryJobQueue(), objectStore: new FakeObjectStore() });

    minter = new DevTokenVerifier("test", secret);
    adminToken = await minter.mint(adminSubject, "admin");
    adminUserId = await bootstrap(adminToken, adminSubject);
    const userSubject = `attack|user-${randomUUID()}`;
    userToken = await minter.mint(userSubject, "user");
    userId = await bootstrap(userToken, userSubject);
    const unlistedSubject = `attack|unlisted-admin-${randomUUID()}`;
    unlistedAdminToken = await minter.mint(unlistedSubject, "admin");
    await bootstrap(unlistedAdminToken, unlistedSubject);
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  // ───────────────────────────── S1 ─────────────────────────────

  describe("S1 — PUT /v1/admin/flags/<unregistered>", () => {
    const key = "definitely_not_registered";

    it("precondition: key is neither registered nor seeded", async () => {
      expect(FLAG_REGISTRY.some((f) => f.key === key)).toBe(false);
      expect(await flagRow(key)).toBeNull();
    });

    it("records what the server does with an unregistered key (row + audit)", async () => {
      const res = await putFlag(adminToken, key, { enabled: true });
      const row = await flagRow(key);
      const audits = await auditRows(key);
      // Observation record — printed to the test log for the artifact.
      console.log(
        JSON.stringify({ scenario: "S1", status: res.statusCode, body: res.json(), row, audits }),
      );
      // The revision under test inserts the row (INSERT … ON CONFLICT) and
      // audits it. If the server ever starts rejecting unregistered keys with
      // 404 this assertion flips — which is the decision the finding asks for.
      expect(res.statusCode).toBe(200);
      expect(row).toEqual({ key, description: "", enabled: true, rollout_percent: 100 });
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor_user_id: adminUserId,
        action: "admin.flag_update",
        target_kind: "feature_flag",
        target_id: key,
      });
    });

    it("the ad-hoc row is then served to EVERY client on GET /v1/flags without a version", async () => {
      const res = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(userToken) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        flags: Record<string, boolean>;
        flagState: { versions: Record<string, number> };
      };
      expect(body.flags[key]).toBe(true);
      expect(body.flagState.versions[key]).toBeUndefined();
    });

    it("audit row carries NO before/after values for the change (metadata is {})", async () => {
      const audits = await auditRows(key);
      expect(audits[0]!.metadata).toEqual({});
    });

    it("an empty `{}` body still materialises a disabled row for an unknown key", async () => {
      const ghost = `ghost_${randomUUID().slice(0, 8)}`;
      const res = await putFlag(adminToken, ghost, {});
      expect(res.statusCode, res.body).toBe(200);
      expect(await flagRow(ghost)).toEqual({
        key: ghost,
        description: "",
        enabled: false,
        rollout_percent: 100,
      });
    });

    it("unicode + whitespace keys are accepted verbatim (no key grammar)", async () => {
      const weird = "  ☃ flag\twith spaces / slash 🥒 ";
      const res = await putFlag(adminToken, weird, { enabled: true });
      console.log(
        JSON.stringify({ scenario: "S1-unicode", status: res.statusCode, body: res.json() }),
      );
      expect([200, 400, 404]).toContain(res.statusCode);
      const row = await flagRow(weird);
      if (res.statusCode === 200) {
        expect(row?.key).toBe(weird);
        const flags = await getFlags(userToken);
        expect(flags[weird]).toBe(true);
      } else {
        expect(row).toBeNull();
      }
    });

    it("a 5,000-char key is rejected before it reaches the database", async () => {
      const huge = "k".repeat(5_000);
      const res = await putFlag(adminToken, huge, { enabled: true });
      console.log(JSON.stringify({ scenario: "S1-huge", status: res.statusCode }));
      expect(res.statusCode).not.toBe(200);
      expect(res.statusCode).toBeLessThan(500);
      expect(await flagRow(huge)).toBeNull();
    });

    it("a 100-char key (Fastify maxParamLength) is stored", async () => {
      const key100 = "l".repeat(100);
      const res = await putFlag(adminToken, key100, { enabled: false });
      expect(res.statusCode, res.body).toBe(200);
      expect((await flagRow(key100))?.key).toBe(key100);
    });

    it("a 101-char key is refused (route param limit) and leaves no row", async () => {
      const key101 = "m".repeat(101);
      const res = await putFlag(adminToken, key101, { enabled: false });
      expect(res.statusCode).not.toBe(200);
      expect(await flagRow(key101)).toBeNull();
    });

    it("permission denial: user role → 403, admin claim outside allowlist → 403, no rows", async () => {
      const k1 = `denied_user_${randomUUID().slice(0, 8)}`;
      const k2 = `denied_unlisted_${randomUUID().slice(0, 8)}`;
      const r1 = await putFlag(userToken, k1, { enabled: true });
      const r2 = await putFlag(unlistedAdminToken, k2, { enabled: true });
      expect(r1.statusCode).toBe(403);
      expect(r1.json()).toMatchObject({ error: { code: "auth.admin_required" } });
      expect(r2.statusCode).toBe(403);
      expect(r2.json()).toMatchObject({ error: { code: "auth.admin_not_authorized" } });
      expect(await flagRow(k1)).toBeNull();
      expect(await flagRow(k2)).toBeNull();
      expect(await auditRows(k1)).toHaveLength(0);
      expect(await auditRows(k2)).toHaveLength(0);
    });

    it("anonymous / garbage bearer → 401 and no row", async () => {
      const k = `anon_${randomUUID().slice(0, 8)}`;
      const r1 = await app.inject({
        method: "PUT",
        url: `/v1/admin/flags/${k}`,
        payload: { enabled: true },
      });
      const r2 = await putFlag("not.a.jwt", k, { enabled: true });
      expect(r1.statusCode).toBe(401);
      expect(r2.statusCode).toBe(401);
      expect(await flagRow(k)).toBeNull();
    });

    it("validation: rolloutPercent 101 / -1 / 37.5 / string → 400, no row", async () => {
      const k = `invalid_${randomUUID().slice(0, 8)}`;
      for (const body of [
        { rolloutPercent: 101 },
        { rolloutPercent: -1 },
        { rolloutPercent: 37.5 },
        { rolloutPercent: "50" },
        { enabled: "true" },
        { description: "d".repeat(401) },
      ]) {
        const res = await putFlag(adminToken, k, body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(await flagRow(k)).toBeNull();
    });

    it("rapid interleaved PUTs on one key converge to a single consistent row + N audits", async () => {
      const k = `race_${randomUUID().slice(0, 8)}`;
      const seedValue = 0x5eed_0003;
      let state = seedValue;
      const next = () => {
        // xorshift32 — deterministic so the interleaving is reproducible.
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) % 101;
      };
      const writes = Array.from({ length: 40 }, () => ({
        enabled: next() % 2 === 0,
        rolloutPercent: next(),
      }));
      const results = await Promise.all(writes.map((w) => putFlag(adminToken, k, w)));
      for (const r of results) expect(r.statusCode, r.body).toBe(200);
      const row = await flagRow(k);
      expect(row).not.toBeNull();
      expect(writes.some((w) => w.rolloutPercent === row!.rollout_percent)).toBe(true);
      expect(writes.some((w) => w.enabled === row!.enabled)).toBe(true);
      expect(await auditRows(k)).toHaveLength(40);
      console.log(JSON.stringify({ scenario: "S1-race", seed: seedValue, finalRow: row }));
    });
  });

  // ───────────────────────────── S5 ─────────────────────────────

  describe("S5 — GET /v1/flags cohort boundary", () => {
    // Registered flag whose safe default is disabled, so the DB row is the
    // only thing that decides the outcome.
    const key = "ball_tracking";

    async function setFlag(enabled: boolean, rolloutPercent: number) {
      const res = await putFlag(adminToken, key, { enabled, rolloutPercent });
      expect(res.statusCode, res.body).toBe(200);
    }

    it("precondition: key is registered", () => {
      expect(FLAG_REGISTRY.some((f) => f.key === key)).toBe(true);
    });

    it("rollout 0 → false, 100 → true, 37 → bucket<37", async () => {
      const bucket = rolloutBucket(key, userId);
      await setFlag(true, 0);
      expect((await getFlags(userToken))[key]).toBe(false);
      await setFlag(true, 100);
      expect((await getFlags(userToken))[key]).toBe(true);
      await setFlag(true, 37);
      expect((await getFlags(userToken))[key]).toBe(bucket < 37);
      console.log(JSON.stringify({ scenario: "S5", userId, bucket }));
    });

    it("exact boundary: rollout == bucket → false, rollout == bucket+1 → true", async () => {
      const bucket = rolloutBucket(key, userId);
      await setFlag(true, bucket);
      expect((await getFlags(userToken))[key]).toBe(false);
      if (bucket + 1 <= 100) {
        await setFlag(true, bucket + 1);
        expect((await getFlags(userToken))[key]).toBe(true);
      }
    });

    it("enabled=false wins over rollout 100; rollout 0 with enabled=true is false for 50 seeded users", async () => {
      await setFlag(false, 100);
      expect((await getFlags(userToken))[key]).toBe(false);
      await setFlag(true, 0);
      // Deterministic subjects — seed recorded.
      const seedValue = "attack-s5-seed-0001";
      for (let i = 0; i < 50; i++) {
        const subject = `attack|s5-${seedValue}-${i}`;
        const token = await minter.mint(subject, "user");
        await bootstrap(token, subject);
        expect((await getFlags(token))[key]).toBe(false);
      }
    });

    it("cohort is stable across 25 rapid repeats and matches the formula at 37/50/63", async () => {
      const bucket = rolloutBucket(key, userId);
      for (const pct of [37, 50, 63]) {
        await setFlag(true, pct);
        const results = await Promise.all(
          Array.from({ length: 25 }, () => getFlags(userToken).then((f) => f[key])),
        );
        expect(new Set(results).size).toBe(1);
        expect(results[0]).toBe(bucket < pct);
      }
    });

    it("bucket formula matches the server at every percentage 0..100 for one user", async () => {
      // One user whose bucket we know; sweep all 101 percentages and
      // assert the server matches `bucket < pct` at each one.
      const bucket = rolloutBucket(key, userId);
      const mismatches: number[] = [];
      for (let pct = 0; pct <= 100; pct++) {
        await setFlag(true, pct);
        const actual = (await getFlags(userToken))[key];
        if (actual !== bucket < pct) mismatches.push(pct);
      }
      expect(mismatches).toEqual([]);
    });
  });

  // ───────────────────────────── S7 ─────────────────────────────

  describe("S7 — seed idempotency preserves operator overrides", () => {
    const key = "live_court";

    it("precondition: seeded flag exists", async () => {
      expect(await flagRow(key)).not.toBeNull();
    });

    it("seed twice → row unchanged; flip enabled+rollout+description; seed again → override preserved", async () => {
      const before = await flagRow(key);
      await seed(pool);
      await seed(pool);
      expect(await flagRow(key)).toEqual(before);

      await pool.query(
        `UPDATE feature_flag
            SET enabled = NOT enabled, rollout_percent = 13, description = 'operator override'
          WHERE key = $1`,
        [key],
      );
      const overridden = await flagRow(key);
      expect(overridden!.enabled).toBe(!before!.enabled);

      await seed(pool);
      const after = await flagRow(key);
      expect(after).toEqual(overridden);
      console.log(JSON.stringify({ scenario: "S7", before, overridden, after }));
    });

    it("seed re-creates a deleted seeded flag with defaults (safe re-provision)", async () => {
      const deleted = await flagRow(key);
      await pool.query("DELETE FROM feature_flag WHERE key = $1", [key]);
      expect(await flagRow(key)).toBeNull();
      await seed(pool);
      const restored = await flagRow(key);
      expect(restored).not.toBeNull();
      expect(restored!.key).toBe(key);
      // Restored with SEED values, not the operator's pre-deletion values.
      console.log(JSON.stringify({ scenario: "S7-delete", deleted, restored }));
    });

    it("concurrent seed runs do not error and leave exactly one row per seeded key", async () => {
      const seededKeys = (await pool.query<{ key: string }>("SELECT key FROM feature_flag")).rows
        .length;
      await Promise.all([seed(pool), seed(pool), seed(pool)]);
      const afterKeys = (await pool.query<{ key: string }>("SELECT key FROM feature_flag")).rows
        .length;
      expect(afterKeys).toBe(seededKeys);
      const dupes = await pool.query(
        "SELECT key, count(*) FROM feature_flag GROUP BY key HAVING count(*) > 1",
      );
      expect(dupes.rowCount).toBe(0);
    });
  });

  // ───────────────────────── extras ─────────────────────────

  describe("extras — clock skew, forged tokens, corrupt account state, DB invariants", () => {
    const key = "attack_extras";
    const secretBytes = new TextEncoder().encode(secret);
    const signAdmin = (mutate: (jwt: SignJWT) => SignJWT, alg = "HS256") =>
      mutate(
        new SignJWT({ pickle_role: "admin" })
          .setProtectedHeader({ alg })
          .setIssuer("pickle-dev")
          .setSubject(adminSubject),
      ).sign(secretBytes);

    it("clock skew: expired / not-yet-valid admin tokens → 401 and no row", async () => {
      const now = Math.floor(Date.now() / 1000);
      const expired = await signAdmin((j) => j.setIssuedAt(now - 3600).setExpirationTime(now - 5));
      const notYet = await signAdmin((j) =>
        j
          .setIssuedAt(now)
          .setNotBefore(now + 3600)
          .setExpirationTime(now + 7200),
      );
      for (const token of [expired, notYet]) {
        const res = await putFlag(token, key, { enabled: true });
        expect(res.statusCode, res.body).toBe(401);
      }
      expect(await flagRow(key)).toBeNull();
    });

    it("clock skew: an admin token whose iat is 1h in the FUTURE is still accepted (recorded)", async () => {
      const now = Math.floor(Date.now() / 1000);
      const futureIat = await signAdmin((j) =>
        j.setIssuedAt(now + 3600).setExpirationTime(now + 7200),
      );
      const res = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(futureIat) });
      console.log(JSON.stringify({ scenario: "extras-future-iat", status: res.statusCode }));
      // jose validates exp/nbf only; a future iat is not rejected without maxTokenAge.
      expect(res.statusCode).toBe(200);
    });

    it("forged tokens: wrong issuer, wrong secret, tampered role, alg=none → 401", async () => {
      const now = Math.floor(Date.now() / 1000);
      const wrongIssuer = await new SignJWT({ pickle_role: "admin" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("pickle-prod")
        .setSubject(adminSubject)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(secretBytes);
      const wrongSecret = await new SignJWT({ pickle_role: "admin" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("pickle-dev")
        .setSubject(adminSubject)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(new TextEncoder().encode("not-the-configured-secret-0000000"));
      // Take a valid USER token and rewrite the payload's role without re-signing.
      const [h, , s] = userToken.split(".");
      const tampered = `${h}.${Buffer.from(
        JSON.stringify({
          pickle_role: "admin",
          iss: "pickle-dev",
          sub: adminSubject,
          iat: now,
          exp: now + 600,
        }),
      ).toString("base64url")}.${s}`;
      const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
      const payload = Buffer.from(
        JSON.stringify({
          pickle_role: "admin",
          iss: "pickle-dev",
          sub: adminSubject,
          exp: now + 600,
        }),
      ).toString("base64url");
      const algNone = `${header}.${payload}.`;

      for (const [name, token] of Object.entries({ wrongIssuer, wrongSecret, tampered, algNone })) {
        const res = await putFlag(token, key, { enabled: true });
        expect(res.statusCode, `${name}: ${res.body}`).toBe(401);
      }
      expect(await flagRow(key)).toBeNull();
    });

    it("role claim is case-sensitive: pickle_role 'ADMIN' / 'Admin' is a plain user → 403", async () => {
      const now = Math.floor(Date.now() / 1000);
      for (const role of ["ADMIN", "Admin", "admin ", ["admin"]]) {
        const token = await new SignJWT({ pickle_role: role })
          .setProtectedHeader({ alg: "HS256" })
          .setIssuer("pickle-dev")
          .setSubject(adminSubject)
          .setIssuedAt(now)
          .setExpirationTime(now + 600)
          .sign(secretBytes);
        const res = await putFlag(token, key, { enabled: true });
        expect(res.statusCode, `${JSON.stringify(role)}: ${res.body}`).toBe(403);
      }
      expect(await flagRow(key)).toBeNull();
    });

    it("corrupt account state: suspended / deleted admin row → 401, no write; restored → 200", async () => {
      await pool.query("UPDATE app_user SET status = 'suspended' WHERE id = $1", [adminUserId]);
      let res = await putFlag(adminToken, key, { enabled: true });
      expect(res.statusCode, res.body).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth.suspended");

      await pool.query("UPDATE app_user SET status = 'deleted' WHERE id = $1", [adminUserId]);
      res = await putFlag(adminToken, key, { enabled: true });
      expect(res.statusCode, res.body).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe("auth.no_account");
      expect(await flagRow(key)).toBeNull();

      await pool.query("UPDATE app_user SET status = 'active' WHERE id = $1", [adminUserId]);
      res = await putFlag(adminToken, key, { enabled: true, rolloutPercent: 50 });
      expect(res.statusCode, res.body).toBe(200);
      expect(await flagRow(key)).toMatchObject({ enabled: true, rollout_percent: 50 });
    });

    it("DB invariant: rollout_percent outside 0..100 is refused by the CHECK constraint even via raw SQL", async () => {
      for (const pct of [-1, 101, 32767]) {
        await expect(
          pool.query("UPDATE feature_flag SET rollout_percent = $2 WHERE key = $1", [key, pct]),
        ).rejects.toThrow(/check constraint|out of range/i);
      }
      expect((await flagRow(key))!.rollout_percent).toBe(50);
    });

    it("corrupt state: garbage `conditions` jsonb (nested, huge, odd unicode) never breaks GET /v1/flags", async () => {
      // jsonb itself refuses \u0000 — everything else goes in.
      await pool.query(`UPDATE feature_flag SET conditions = $2::jsonb WHERE key = $1`, [
        key,
        JSON.stringify({
          "\uFFFFweird": [1, { deep: "\u202E\uD83E\uDD52" }],
          huge: "x".repeat(50_000),
        }),
      ]);
      const flags = await getFlags(userToken);
      expect(typeof flags[key]).toBe("boolean");
      expect(flags[key]).toBe(rolloutBucket(key, userId) < 50);
    });

    it("path tricks: NUL in the key → 400; encoded slash / dot segments are recorded verbatim", async () => {
      const statuses: Record<string, number> = {};
      for (const raw of ["a%2Fb", "..%2F..%2Fetc", "nul%00byte", "%2e%2e", ".", ".."]) {
        const res = await app.inject({
          method: "PUT",
          url: `/v1/admin/flags/${raw}`,
          headers: auth(adminToken),
          payload: { enabled: true },
        });
        statuses[raw] = res.statusCode;
      }
      console.log(JSON.stringify({ scenario: "extras-path-tricks", statuses }));
      const rows = await pool.query<{ key: string }>(
        "SELECT key FROM feature_flag WHERE key LIKE '%/%' OR key LIKE '%..%' OR key LIKE '%etc%' OR key LIKE 'nul%' OR key IN ('.', '..')",
      );
      // Any row here was created from a path-trick key: record it verbatim.
      console.log(JSON.stringify({ scenario: "extras-path-tricks-rows", rows: rows.rows }));
      expect(statuses["nul%00byte"]).toBe(400);
      for (const [raw, status] of Object.entries(statuses)) {
        expect([200, 400, 404], `${raw} → ${status}`).toContain(status);
      }
    });

    it("rate limit: the default 600/min per-IP budget is enforced on PUT /v1/admin/flags/:key", async () => {
      let first429 = -1;
      let lastStatus = 0;
      for (let i = 0; i < 700; i++) {
        const res = await putFlag(adminToken, key, { rolloutPercent: i % 101 });
        lastStatus = res.statusCode;
        if (res.statusCode === 429) {
          first429 = i;
          expect(res.headers["retry-after"]).toBeDefined();
          break;
        }
        expect(res.statusCode, res.body).toBe(200);
      }
      console.log(JSON.stringify({ scenario: "extras-rate-limit", first429, lastStatus }));
      expect(first429).toBeGreaterThan(0);
      expect(first429).toBeLessThanOrEqual(600);
    });
  });
});
