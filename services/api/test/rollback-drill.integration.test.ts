import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../src/app.js";
import { DevTokenVerifier } from "../src/auth/tokens.js";
import type { ApiConfig } from "../src/config.js";
import type { FastifyInstance } from "fastify";

/**
 * i06-rollback-drill: automated rollback drill for the DB-backed runtime
 * selections (feature flags, model bundle rollout) and the backend config,
 * exercised through the real admin API against a real PostgreSQL database.
 *
 * HONESTY: every time-to-disable / time-to-rollback below is measured
 * in-process on a Linux test box against a local database. These are NOT
 * production numbers — no fleet propagation, deploy pipeline, CDN/client
 * cache, or operator reaction time is included.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "rollback-drill-secret-0123456789";

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

function makeConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-known-good",
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
    adminAuthSubjects: ["auth0|drill-admin"],
    ...overrides,
  };
}

describe.skipIf(!testUrl)("rollback drill (real PostgreSQL, linux-test measurements)", () => {
  let app: FastifyInstance;
  let adminToken: string;
  let userToken: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    await pool.end();

    app = buildApp(makeConfig(), { queue: new InMemoryJobQueue() });
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint("auth0|drill-admin", "admin");
    userToken = await minter.mint("auth0|drill-user");
    for (const token of [adminToken, userToken]) {
      const bootstrap = await app.inject({
        method: "POST",
        url: "/v1/account/bootstrap",
        headers: auth(token),
        payload: {
          locale: "en-US",
          timezone: "America/Los_Angeles",
          device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "iPhone16,1" },
        },
      });
      if (bootstrap.statusCode >= 400) {
        throw new Error(`bootstrap failed: ${bootstrap.statusCode} ${bootstrap.body}`);
      }
    }
  }, 60000);

  afterAll(async () => {
    await app?.close();
  });

  it("feature flags: known-good recorded, kill switch and rollback restore it (timed)", async () => {
    // 1. Record the seeded state as known-good.
    const record = await app.inject({
      method: "POST",
      url: "/v1/admin/rollback/feature-flags/known-good",
      headers: auth(adminToken),
    });
    expect(record.statusCode).toBe(200);
    expect(record.json<{ rowCount: number }>().rowCount).toBeGreaterThan(0);

    // 2. Bad deployment: a high-risk seeded flag is fully enabled and a rogue
    //    flag appears that the snapshot has never seen.
    for (const key of ["experimental_camera_setup", "rogue_unreviewed_flag"]) {
      const put = await app.inject({
        method: "PUT",
        url: `/v1/admin/flags/${key}`,
        headers: auth(adminToken),
        payload: { enabled: true, rolloutPercent: 100 },
      });
      expect(put.statusCode).toBe(200);
    }
    const broken = await app.inject({ method: "GET", url: "/v1/flags", headers: auth(userToken) });
    const brokenFlags = broken.json<{ flags: Record<string, boolean> }>().flags;
    expect(brokenFlags["experimental_camera_setup"]).toBe(true);
    expect(brokenFlags["rogue_unreviewed_flag"]).toBe(true);

    // 3. Kill switch on the single high-risk flag — time-to-disable.
    const disableStart = performance.now();
    const disable = await app.inject({
      method: "POST",
      url: "/v1/admin/flags/experimental_camera_setup/disable",
      headers: auth(adminToken),
    });
    const timeToDisableMs = performance.now() - disableStart;
    expect(disable.statusCode).toBe(200);
    const afterDisable = await app.inject({
      method: "GET",
      url: "/v1/flags",
      headers: auth(userToken),
    });
    expect(
      afterDisable.json<{ flags: Record<string, boolean> }>().flags["experimental_camera_setup"],
    ).toBe(false);

    // 4. Full rollback — time-to-rollback. The rogue flag is neutralized
    //    because it is not in the known-good snapshot.
    const rollbackStart = performance.now();
    const rollback = await app.inject({
      method: "POST",
      url: "/v1/admin/rollback/feature-flags",
      headers: auth(adminToken),
    });
    const timeToRollbackMs = performance.now() - rollbackStart;
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json<{ neutralized: number }>().neutralized).toBeGreaterThanOrEqual(1);

    const recovered = await app.inject({
      method: "GET",
      url: "/v1/flags",
      headers: auth(userToken),
    });
    const recoveredFlags = recovered.json<{ flags: Record<string, boolean> }>().flags;
    expect(recoveredFlags["experimental_camera_setup"]).toBe(false);
    expect(recoveredFlags["rogue_unreviewed_flag"]).toBe(false);
    // Seeded always-on flags survived the rollback untouched.
    expect(recoveredFlags["social"]).toBe(true);

    // Linux-test measurements, reported for the drill record — not production.
    expect(timeToDisableMs).toBeGreaterThan(0);
    expect(timeToRollbackMs).toBeGreaterThan(0);
    console.log(
      `[rollback-drill linux-test] feature-flags timeToDisableMs=${timeToDisableMs.toFixed(1)} timeToRollbackMs=${timeToRollbackMs.toFixed(1)}`,
    );
  });

  it("model bundles: rollback restores known-good rollout state and retires unknown bundles", async () => {
    const goodSha = "a".repeat(64);
    const badSha = "b".repeat(64);
    const putGood = await app.inject({
      method: "PUT",
      url: "/v1/admin/model-bundles/drill-bundle-good",
      headers: auth(adminToken),
      payload: { manifestSha256: goodSha, status: "active", rolloutPercent: 100 },
    });
    expect(putGood.statusCode).toBe(200);

    const record = await app.inject({
      method: "POST",
      url: "/v1/admin/rollback/model-bundles/known-good",
      headers: auth(adminToken),
    });
    expect(record.statusCode).toBe(200);

    // Bad deployment: known-good bundle demoted, unknown bundle put live.
    await app.inject({
      method: "PUT",
      url: "/v1/admin/model-bundles/drill-bundle-good",
      headers: auth(adminToken),
      payload: { manifestSha256: goodSha, status: "retired", rolloutPercent: 0 },
    });
    await app.inject({
      method: "PUT",
      url: "/v1/admin/model-bundles/drill-bundle-bad",
      headers: auth(adminToken),
      payload: { manifestSha256: badSha, status: "active", rolloutPercent: 100 },
    });

    const rollbackStart = performance.now();
    const rollback = await app.inject({
      method: "POST",
      url: "/v1/admin/rollback/model-bundles",
      headers: auth(adminToken),
    });
    const timeToRollbackMs = performance.now() - rollbackStart;
    expect(rollback.statusCode).toBe(200);

    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      const { rows } = await pool.query<{
        version: string;
        status: string;
        rollout_percent: number;
      }>("SELECT version, status, rollout_percent FROM model_bundle WHERE version LIKE 'drill-%'");
      const byVersion = new Map(rows.map((row) => [row.version, row]));
      expect(byVersion.get("drill-bundle-good")).toMatchObject({
        status: "active",
        rollout_percent: 100,
      });
      expect(byVersion.get("drill-bundle-bad")).toMatchObject({
        status: "retired",
        rollout_percent: 0,
      });
    } finally {
      await pool.end();
    }
    console.log(
      `[rollback-drill linux-test] model-bundles timeToRollbackMs=${timeToRollbackMs.toFixed(1)}`,
    );
  });

  it("rollback without a recorded known-good snapshot is refused, not guessed", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DELETE FROM rollback_known_good WHERE subsystem = 'model-bundles'");
    } finally {
      await pool.end();
    }
    const rollback = await app.inject({
      method: "POST",
      url: "/v1/admin/rollback/model-bundles",
      headers: auth(adminToken),
    });
    expect(rollback.statusCode).toBe(409);
  });

  it("rollback endpoints reject non-admins", async () => {
    for (const url of [
      "/v1/admin/rollback/feature-flags/known-good",
      "/v1/admin/rollback/feature-flags",
      "/v1/admin/flags/social/disable",
    ]) {
      const response = await app.inject({ method: "POST", url, headers: auth(userToken) });
      expect(response.statusCode).toBe(403);
    }
  });

  it("backend config: known-good config snapshot restores service behavior (timed)", async () => {
    // The known-good config IS the recorded version; a bad deployment ships a
    // different config. Rollback rebuilds the service from the recorded
    // snapshot and verifies it serves again.
    const knownGoodConfig = makeConfig();
    const badConfig = makeConfig({ appVersion: "9.9.9-bad-deploy", adminAuthSubjects: [] });

    const badApp = buildApp(badConfig, { queue: new InMemoryJobQueue() });
    try {
      const badHealth = await badApp.inject({ method: "GET", url: "/v1/health" });
      expect(badHealth.json<{ version: string }>().version).toBe("9.9.9-bad-deploy");
      // The bad config also locked out every admin — a real operational break.
      const lockedOut = await badApp.inject({
        method: "POST",
        url: "/v1/admin/rollback/feature-flags/known-good",
        headers: auth(adminToken),
      });
      expect(lockedOut.statusCode).toBe(403);
    } finally {
      // Time-to-disable: taking the bad deployment out of service.
      const disableStart = performance.now();
      await badApp.close();
      const timeToDisableMs = performance.now() - disableStart;
      expect(timeToDisableMs).toBeGreaterThan(0);
      console.log(
        `[rollback-drill linux-test] backend-config timeToDisableMs=${timeToDisableMs.toFixed(1)}`,
      );
    }

    // Time-to-rollback: standing the recorded known-good config back up and
    // verifying recovery (health + admin access restored).
    const rollbackStart = performance.now();
    const restoredApp = buildApp(knownGoodConfig, { queue: new InMemoryJobQueue() });
    try {
      const health = await restoredApp.inject({ method: "GET", url: "/v1/health" });
      const timeToRollbackMs = performance.now() - rollbackStart;
      expect(health.statusCode).toBe(200);
      expect(health.json<{ version: string }>().version).toBe("0.1.0-known-good");
      const adminBack = await restoredApp.inject({
        method: "POST",
        url: "/v1/admin/rollback/feature-flags/known-good",
        headers: auth(adminToken),
      });
      expect(adminBack.statusCode).toBe(200);
      console.log(
        `[rollback-drill linux-test] backend-config timeToRollbackMs=${timeToRollbackMs.toFixed(1)}`,
      );
    } finally {
      await restoredApp.close();
    }
  });
});
