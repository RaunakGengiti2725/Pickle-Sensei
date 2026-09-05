import { copyFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { buildApp } from "../../src/app.js";
import { DevTokenVerifier } from "../../src/auth/tokens.js";
import type { ApiConfig } from "../../src/config.js";

/**
 * ADJ-05 adversarial variants (services-api-legacy-admin-web): scoring-model
 * release state machine, attacked at double the scale of the pinning test.
 *
 * Every test asserts the CORRECT behaviour, so a failure is a reproduced
 * defect. Variants covered here that the pinning test does not:
 *   X1. 16 concurrent releases across TWO independent Fastify apps, each with
 *       its own pg.Pool (two real connection sets) → exactly one 200, 15×409.
 *   X2. Re-releasing the version that is ALREADY active is refused (409) and
 *       does not rewind `active_from` / `released_at`.
 *   X3. A superseded (closed) version cannot be re-released (409, unchanged).
 *   X4. Releasing for shot type B never closes shot type A's active model.
 *   X5. Deterministic two-connection SQL interleaving: with an open transaction
 *       holding the first activation, the second activation on another
 *       connection must fail with 23505 once the first commits.
 *   X6. Upgrade path: a database that already holds several open-ended active
 *       rows per shot type (pre-existing bad rows, migrated only through 0020)
 *       must still migrate to head, leaving exactly one open-ended active row.
 *   X7. A refused release writes NO `scoring_model.released` audit row.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "adj05-attack-secret-0123456789abcdef";
const ADMIN_SUBJECT = "auth0|adj05-attack-admin";
const SHOT_A = "forehand_drive";
const SHOT_B = "backhand_drive";
const LAST_PREEXISTING_MIGRATION = "0020_deletion_task_fair_scheduling.sql";
const BUNDLE = "adj05x-bundle-1";

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

function config(): ApiConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    appVersion: "0.1.0-adj05x",
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
    adminAuthSubjects: [ADMIN_SUBJECT],
  };
}

const releaseBody = {
  modelBundleVersion: BUNDLE,
  datasetSnapshotId: "adj05x-dataset-snapshot",
  evaluationReportSha256: "b".repeat(64),
  coachValidationReference: "adj05x-coach-review",
};

interface ModelRow {
  version: string;
  status: string;
  active_from: string | null;
  active_to: string | null;
  released_at: string | null;
}

interface ErrorEnvelope {
  error?: { code?: string };
}

describe.skipIf(!testUrl)("ADJ-05 attack variants: scoring-model release (real PostgreSQL)", () => {
  let appA: FastifyInstance;
  let appB: FastifyInstance;
  let pool: pg.Pool;
  let adminToken: string;
  let shotAId: string;
  let shotBId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function insertModel(shotTypeId: string, version: string, status: string) {
    await pool.query(
      `INSERT INTO scoring_model (shot_type_id, version, status, config)
       VALUES ($1, $2, $3, jsonb_build_object('shotConfigVersion', 'forehand_drive@1'))
       ON CONFLICT (shot_type_id, version) DO NOTHING`,
      [shotTypeId, version, status],
    );
  }

  async function release(app: FastifyInstance, shotType: string, version: string) {
    return app.inject({
      method: "PUT",
      url: `/v1/admin/scoring-models/${shotType}/${version}/release`,
      headers: auth(adminToken),
      payload: releaseBody,
    });
  }

  async function row(shotTypeId: string, version: string): Promise<ModelRow | undefined> {
    const r = await pool.query<ModelRow>(
      `SELECT version, status, active_from, active_to, released_at
       FROM scoring_model WHERE shot_type_id = $1 AND version = $2`,
      [shotTypeId, version],
    );
    return r.rows[0];
  }

  async function openEndedActive(shotTypeId: string): Promise<string[]> {
    const r = await pool.query<{ version: string }>(
      `SELECT version FROM scoring_model
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL ORDER BY version`,
      [shotTypeId],
    );
    return r.rows.map((x) => x.version);
  }

  async function auditCount(targetId: string): Promise<number> {
    const r = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
       WHERE action = 'scoring_model.released' AND target_id = $1`,
      [targetId],
    );
    return Number(r.rows[0]!.n);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    appA = buildApp(config(), { queue: new InMemoryJobQueue() });
    appB = buildApp(config(), { queue: new InMemoryJobQueue() });
    await Promise.all([appA.ready(), appB.ready()]);
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint(ADMIN_SUBJECT, "admin");
    const boot = await appA.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(adminToken),
      payload: {
        locale: "en-US",
        timezone: "UTC",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adj05x" },
      },
    });
    expect(boot.statusCode).toBe(200);
    const ids = await pool.query<{ slug: string; id: string }>(
      "SELECT slug, id FROM shot_type WHERE slug = ANY($1)",
      [[SHOT_A, SHOT_B]],
    );
    shotAId = ids.rows.find((r) => r.slug === SHOT_A)!.id;
    shotBId = ids.rows.find((r) => r.slug === SHOT_B)!.id;
    await pool.query(
      `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent, metadata)
       VALUES ($1, $2, 'active', 100, '{}')
       ON CONFLICT (version) DO UPDATE SET status='active', rollout_percent=100,
         manifest_sha256=EXCLUDED.manifest_sha256`,
      [BUNDLE, "a".repeat(64)],
    );
  }, 60_000);

  afterAll(async () => {
    await appA?.close();
    await appB?.close();
    await pool?.end();
  });

  it("X1: 16 concurrent releases across two independent apps/pools → exactly one 200, fifteen typed 409, one open-ended active row", async () => {
    const versions = Array.from(
      { length: 16 },
      (_, i) => `adj05x-race-v${String(i).padStart(2, "0")}`,
    );
    for (const v of versions) await insertModel(shotAId, v, "validating");

    const responses = await Promise.all(
      versions.map((v, i) => release(i % 2 === 0 ? appA : appB, SHOT_A, v)),
    );
    const outcomes = responses.map((r, i) => ({
      version: versions[i]!,
      status: r.statusCode,
      code: (r.json() as ErrorEnvelope).error?.code,
    }));
    const active = await openEndedActive(shotAId);
    console.log(
      `ADJ-05 X1: outcomes=${JSON.stringify(outcomes)}; open-ended active=${JSON.stringify(active)}`,
    );

    expect(
      outcomes.filter((o) => o.status >= 500),
      "no 5xx in a release race",
    ).toEqual([]);
    const winners = outcomes.filter((o) => o.status === 200);
    expect(winners, "exactly one winner").toHaveLength(1);
    for (const loser of outcomes.filter((o) => o.status !== 200)) {
      expect(loser.status, `${loser.version}`).toBe(409);
      expect(loser.code, `${loser.version}`).toMatch(/^scoring\./);
    }
    expect(active).toEqual([winners[0]!.version]);
  });

  it("X2: re-releasing the already-active version is refused and does not rewind active_from/released_at", async () => {
    const [current] = await openEndedActive(shotAId);
    expect(current, "precondition: one active row from X1").toBeTruthy();
    const before = await row(shotAId, current!);
    await new Promise((r) => setTimeout(r, 20));
    const res = await release(appB, SHOT_A, current!);
    const after = await row(shotAId, current!);
    console.log(`ADJ-05 X2: re-release ${current} → ${res.statusCode} ${res.body.slice(0, 160)}`);
    expect(res.statusCode, "active → release is not a valid transition").toBe(409);
    expect((res.json() as ErrorEnvelope).error?.code).toMatch(/^scoring\./);
    expect(after, "active row must be unchanged").toEqual(before);
  });

  it("X3: a superseded/closed version cannot be re-released; its row stays closed", async () => {
    await insertModel(shotAId, "adj05x-sup-v1", "validating");
    await insertModel(shotAId, "adj05x-sup-v2", "validating");
    expect((await release(appA, SHOT_A, "adj05x-sup-v1")).statusCode).toBe(200);
    expect((await release(appB, SHOT_A, "adj05x-sup-v2")).statusCode).toBe(200);
    const closed = await row(shotAId, "adj05x-sup-v1");
    expect(closed!.active_to, "v1 closed by v2").not.toBeNull();
    expect(closed!.status).not.toBe("active");

    const res = await release(appA, SHOT_A, "adj05x-sup-v1");
    const after = await row(shotAId, "adj05x-sup-v1");
    console.log(
      `ADJ-05 X3: re-release closed v1 → ${res.statusCode}; row=${JSON.stringify(after)}`,
    );
    expect(res.statusCode).toBe(409);
    expect((res.json() as ErrorEnvelope).error?.code).toMatch(/^scoring\./);
    expect(after).toEqual(closed);
    expect(await openEndedActive(shotAId)).toEqual(["adj05x-sup-v2"]);
  });

  it("X4: releasing for another shot type never closes this shot type's active model", async () => {
    const aActiveAll = await openEndedActive(shotAId);
    const [aActive] = aActiveAll;
    const aBefore = await row(shotAId, aActive!);
    await insertModel(shotBId, "adj05x-b-v1", "validating");
    const res = await release(appA, SHOT_B, "adj05x-b-v1");
    expect(res.statusCode, res.body).toBe(200);
    expect(await openEndedActive(shotBId)).toEqual(["adj05x-b-v1"]);
    expect(await openEndedActive(shotAId), "shot A untouched").toEqual(aActiveAll);
    expect(await row(shotAId, aActive!)).toEqual(aBefore);
  });

  it("X5: two real connections, deterministic interleaving — second open-ended activation fails with 23505 after the first commits", async () => {
    await insertModel(shotBId, "adj05x-b-ia", "validating");
    await insertModel(shotBId, "adj05x-b-ib", "validating");
    await pool.query(
      `UPDATE scoring_model SET active_to = now(), status = 'retired'
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL`,
      [shotBId],
    );
    const activateSql = `UPDATE scoring_model SET status = 'active', model_bundle_id = mb.id,
         dataset_snapshot_id = 'adj05x-ds', evaluation_report_sha256 = repeat('c', 64),
         coach_validation_reference = 'adj05x-coach', released_by = au.id,
         released_at = now(), active_from = now(), active_to = NULL
       FROM model_bundle mb, app_user au
       WHERE mb.version = $2 AND au.auth_subject = $3
         AND scoring_model.shot_type_id = $1 AND scoring_model.version = $4`;
    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      await c1.query("BEGIN");
      await c1.query(activateSql, [shotBId, BUNDLE, ADMIN_SUBJECT, "adj05x-b-ia"]);
      await c2.query("BEGIN");
      // c2 either blocks on c1's index entry (then fails on commit of c1) or fails at once.
      const second = c2.query(activateSql, [shotBId, BUNDLE, ADMIN_SUBJECT, "adj05x-b-ib"]);
      await new Promise((r) => setTimeout(r, 200));
      await c1.query("COMMIT");
      await expect(second).rejects.toMatchObject({ code: "23505" });
    } finally {
      await c2.query("ROLLBACK").catch(() => undefined);
      await c1.query("ROLLBACK").catch(() => undefined);
      c1.release();
      c2.release();
    }
    expect(await openEndedActive(shotBId)).toEqual(["adj05x-b-ia"]);
  });

  it("X7: a refused release (retired source) writes no `scoring_model.released` audit row", async () => {
    await insertModel(shotAId, "adj05x-audit-ret", "retired");
    const res = await release(appA, SHOT_A, "adj05x-audit-ret");
    console.log(`ADJ-05 X7: release retired → ${res.statusCode}`);
    expect(res.statusCode).toBe(409);
    expect(await auditCount(`${SHOT_A}:adj05x-audit-ret`)).toBe(0);
    expect((await row(shotAId, "adj05x-audit-ret"))!.status).toBe("retired");
  });

  it("X6: upgrade path — pre-existing multiple open-ended active rows per shot type migrate to head leaving exactly one", async () => {
    const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
    const newer = names.filter((n) => n > LAST_PREEXISTING_MIGRATION);
    expect(newer, "a NEW migration later than 0020 must exist").not.toHaveLength(0);

    const partial = await mkdtemp(join(tmpdir(), "adj05x-mig-"));
    for (const n of names.filter((x) => x <= LAST_PREEXISTING_MIGRATION)) {
      await copyFile(join(migrationsDir, n), join(partial, n));
    }
    const p = new pg.Pool({ connectionString: testUrl });
    try {
      await p.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(p, partial);
      await seed(p);
      const actor = await p.query<{ id: string }>(
        `INSERT INTO app_user (auth_subject) VALUES ('adj05x|legacy-actor') RETURNING id`,
      );
      const bundle = await p.query<{ id: string }>(
        `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent, metadata)
         VALUES ('adj05x-legacy-bundle', repeat('a', 64), 'active', 100, '{}') RETURNING id`,
      );
      const st = await p.query<{ id: string }>("SELECT id FROM shot_type WHERE slug = $1", [
        SHOT_A,
      ]);
      for (const [v, daysAgo] of [
        ["adj05x-legacy-old", 3],
        ["adj05x-legacy-mid", 2],
        ["adj05x-legacy-new", 1],
      ] as const) {
        await p.query(
          `INSERT INTO scoring_model (shot_type_id, version, model_bundle_id, status,
             dataset_snapshot_id, evaluation_report_sha256, coach_validation_reference,
             released_by, released_at, active_from, active_to)
           VALUES ($1, $2, $3, 'active', 'legacy-ds', repeat('d', 64), 'legacy-coach',
             $4, now() - make_interval(days => $5), now() - make_interval(days => $5), NULL)`,
          [st.rows[0]!.id, v, bundle.rows[0]!.id, actor.rows[0]!.id, daysAgo],
        );
      }
      const beforeCount = await p.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM scoring_model
         WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL`,
        [st.rows[0]!.id],
      );
      expect(Number(beforeCount.rows[0]!.n), "precondition: 3 bad rows on the 0020 schema").toBe(3);

      const result = await runMigrations(p, migrationsDir);
      console.log(`ADJ-05 X6: applied=${JSON.stringify(result.applied)}`);
      expect(
        result.applied.length,
        "new migration(s) applied on top of a dirty DB",
      ).toBeGreaterThan(0);

      const after = await p.query<{ version: string; status: string; active_to: string | null }>(
        `SELECT version, status, active_to FROM scoring_model
         WHERE shot_type_id = $1 AND version LIKE 'adj05x-legacy-%' ORDER BY version`,
        [st.rows[0]!.id],
      );
      console.log(`ADJ-05 X6: after=${JSON.stringify(after.rows)}`);
      const open = after.rows.filter((r) => r.status === "active" && r.active_to === null);
      expect(open, "exactly one open-ended active row survives the upgrade").toHaveLength(1);
      expect(open[0]!.version, "the most recent activation survives").toBe("adj05x-legacy-new");
      for (const r of after.rows.filter((r) => r.version !== "adj05x-legacy-new")) {
        expect(r.active_to, `${r.version} closed`).not.toBeNull();
        expect(r.status, `${r.version} not active`).not.toBe("active");
      }
      // seed must still be idempotent on the upgraded schema
      await seed(p);
    } finally {
      await p.end();
    }
  }, 90_000);
});
