import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import type { StabilitySloEvent } from "@pickle/shared-types";
import { buildApp } from "../../src/app.js";
import {
  TEST_DATABASE_URL,
  attackConfig,
  bearer,
  bootstrap,
  minter,
  resetTestDatabase,
  writeArtifact,
  type ErrorEnvelope,
} from "./support.js";

/**
 * ATTACK S7 — stability SLO guard vs. flag rollout advances, and what a
 * fresh app build does to the guard's decision.
 *
 *   1. submit a breached window (healthy sample + one fatal crash → `pause`)
 *   2. PUT /v1/admin/flags/social {rolloutPercent: 75} from 50 → 409
 *      stability.rollout_advance_blocked
 *   3. reduce 75 → 25 → 200 (rollbacks are never trapped)
 *   4. rebuild the app against the SAME database and repeat the advance:
 *      the guard has no window any more, so the advance is allowed. The
 *      scenario names this "guard state lost" — the test pins the exact
 *      observed behaviour so the finding carries an executable repro.
 */

const AT = "2026-08-29T00:00:00.000Z";

function cleanSessions(count: number): StabilitySloEvent[] {
  const events: StabilitySloEvent[] = [];
  for (let i = 0; i < count; i++) {
    events.push({ kind: "session_started", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
    events.push({ kind: "session_ended_clean", userKey: `u${i}`, sessionKey: `s${i}`, at: AT });
  }
  return events;
}

function breachedWindow(): StabilitySloEvent[] {
  const events = cleanSessions(50);
  for (let i = 0; i < 20; i++) {
    events.push({ kind: "analysis_started", userKey: "u0", sessionKey: "s0", at: AT });
    events.push({ kind: "analysis_completed", userKey: "u0", sessionKey: "s0", at: AT });
    events.push({ kind: "camera_startup_succeeded", userKey: "u0", sessionKey: "s0", at: AT });
  }
  for (let i = 0; i < 10; i++) {
    events.push({ kind: "try_again_rearmed", userKey: "u0", sessionKey: "s0", at: AT });
  }
  events.push({
    kind: "crash",
    fatal: true,
    fingerprint: "attack4-f1",
    userKey: "u0",
    sessionKey: "s0",
    at: AT,
  });
  return events;
}

describe.skipIf(!TEST_DATABASE_URL)(
  "ATTACK S7: stability guard blocks advances, state lost on rebuild",
  () => {
    let app: FastifyInstance;
    let pool: pg.Pool;
    let adminToken: string;
    const steps: Array<{ step: string; status: number; body: unknown; rolloutInDb: number }> = [];

    async function rolloutInDb(): Promise<number> {
      const { rows } = await pool.query<{ rollout_percent: number }>(
        "SELECT rollout_percent FROM feature_flag WHERE key = 'social'",
      );
      return rows[0]!.rollout_percent;
    }

    async function putRollout(target: FastifyInstance, rolloutPercent: number, step: string) {
      const res = await target.inject({
        method: "PUT",
        url: "/v1/admin/flags/social",
        headers: bearer(adminToken),
        payload: { rolloutPercent },
      });
      steps.push({
        step,
        status: res.statusCode,
        body: res.json(),
        rolloutInDb: await rolloutInDb(),
      });
      return res;
    }

    async function submitWindow(target: FastifyInstance, windowId: string) {
      const res = await target.inject({
        method: "POST",
        url: "/v1/admin/stability/window",
        headers: bearer(adminToken),
        payload: { windowId, events: breachedWindow() },
      });
      steps.push({
        step: `submit window ${windowId}`,
        status: res.statusCode,
        body: res.json(),
        rolloutInDb: await rolloutInDb(),
      });
      return res;
    }

    beforeAll(async () => {
      await resetTestDatabase(TEST_DATABASE_URL!);
      pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
      app = buildApp(attackConfig());
      adminToken = await minter().mint("attack4|admin", "admin");
      await bootstrap(app, adminToken);
    }, 120_000);

    afterAll(async () => {
      writeArtifact("s7-stability-rollout.json", { scenario: "S7", steps });
      await app?.close();
      await pool?.end();
    });

    it("breached window → 50→75 blocked (409), 75→25 allowed (200)", async () => {
      // Guard inactive: bring the flag to 50 first.
      const seedTo50 = await putRollout(app, 50, "guard inactive: set 50");
      expect(seedTo50.statusCode, seedTo50.body).toBe(200);

      const win = await submitWindow(app, "attack4-w1");
      expect(win.statusCode, win.body).toBe(200);
      expect(
        (win.json() as { window: { decision: { action: string } } }).window.decision.action,
      ).toBe("pause");

      const advance = await putRollout(app, 75, "paused: 50→75");
      expect(advance.statusCode, advance.body).toBe(409);
      const err = (advance.json() as ErrorEnvelope).error;
      expect(err.code).toBe("stability.rollout_advance_blocked");
      expect(await rolloutInDb(), "blocked advance must not touch the DB").toBe(50);

      // Simulate an operator who had already advanced to 75 before the breach
      // (direct DB write), then roll back to 25 through the API.
      await pool.query("UPDATE feature_flag SET rollout_percent = 75 WHERE key = 'social'");
      const rollback = await putRollout(app, 25, "paused: 75→25");
      expect(rollback.statusCode, rollback.body).toBe(200);
      expect(await rolloutInDb()).toBe(25);

      // Holding at the current value is also allowed while paused.
      const hold = await putRollout(app, 25, "paused: 25→25 (hold)");
      expect(hold.statusCode, hold.body).toBe(200);

      // And the advance is still blocked from the new baseline.
      const again = await putRollout(app, 26, "paused: 25→26");
      expect(again.statusCode, again.body).toBe(409);
    });

    it("a rapid burst of concurrent advances while paused is refused in full", async () => {
      const results = await Promise.all(
        [60, 70, 80, 90, 100].map((p) => putRollout(app, p, `paused burst: 25→${p}`)),
      );
      for (const r of results) expect(r.statusCode, r.body).toBe(409);
      expect(await rolloutInDb()).toBe(25);
    });

    it("rebuilding the app against the same DB forgets the pause: the same advance is allowed", async () => {
      const rebuilt = buildApp(attackConfig());
      try {
        const decision = await rebuilt.inject({
          method: "GET",
          url: "/v1/admin/stability/decision",
          headers: bearer(adminToken),
        });
        expect(decision.statusCode).toBe(200);
        const window = (decision.json() as { window: unknown }).window;
        steps.push({
          step: "rebuilt: GET stability/decision",
          status: decision.statusCode,
          body: decision.json(),
          rolloutInDb: await rolloutInDb(),
        });

        const advance = await putRollout(rebuilt, 75, "rebuilt app: 25→75");
        const oldAppStillPaused = await putRollout(app, 76, "old app (still paused): 75→76");

        // Observed behaviour, pinned exactly: guard state is process-local.
        expect(window, "fresh build has no stability window").toBeNull();
        expect(advance.statusCode, advance.body).toBe(200);
        expect(await rolloutInDb()).toBe(75);
        // …while the original instance (same DB!) still refuses — two instances
        // of the same service now disagree about whether rollout may advance.
        expect(oldAppStillPaused.statusCode, oldAppStillPaused.body).toBe(409);
      } finally {
        await rebuilt.close();
      }
    });
  },
);
