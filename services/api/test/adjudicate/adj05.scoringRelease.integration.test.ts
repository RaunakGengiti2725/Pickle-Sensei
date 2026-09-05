import { readdir, readFile } from "node:fs/promises";
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
 * ADJ-05 (services-api-legacy-admin-web): scoring-model release state machine.
 *
 * Pins the four acceptance criteria of the finding against a REAL PostgreSQL
 * database on a fresh migrate + seed:
 *   1. releasing a `retired` version is refused with 409 and the row is unchanged;
 *   2. releasing v2 after v1 leaves exactly one open-ended active row per shot
 *      type and closes v1 (`active_to IS NOT NULL`, no longer `active`);
 *   3. 8 concurrent releases of different versions end with exactly one
 *      open-ended active row — the losers get a typed 409, never a 5xx;
 *   4. the single-active invariant is a DB-level UNIQUE partial index that a
 *      NEW migration (later than every migration already applied at the
 *      finding's base) adds; migrate + seed succeed on a fresh DB.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "adj05-secret-0123456789abcdef";
const ADMIN_SUBJECT = "auth0|adj05-admin";
const SHOT_TYPE = "forehand_drive";
/** Last migration present at the finding's base (4d812e1a) and on the integrated head. */
const LAST_PREEXISTING_MIGRATION = "0020_deletion_task_fair_scheduling.sql";

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
    appVersion: "0.1.0-adj05",
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
  modelBundleVersion: "adj05-bundle-1",
  datasetSnapshotId: "adj05-dataset-snapshot",
  evaluationReportSha256: "b".repeat(64),
  coachValidationReference: "adj05-coach-review",
};

interface ModelRow {
  version: string;
  status: string;
  active_from: string | null;
  active_to: string | null;
  released_at: string | null;
  model_bundle_id: string | null;
}

interface ErrorEnvelope {
  error?: { code?: string; kind?: string };
}

describe.skipIf(!testUrl)("ADJ-05 scoring-model release state machine (real PostgreSQL)", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminToken: string;
  let shotTypeId: string;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function insertModel(version: string, status: string): Promise<void> {
    await pool.query(
      `INSERT INTO scoring_model (shot_type_id, version, status)
       VALUES ($1, $2, $3) ON CONFLICT (shot_type_id, version) DO NOTHING`,
      [shotTypeId, version, status],
    );
  }

  async function release(version: string) {
    return app.inject({
      method: "PUT",
      url: `/v1/admin/scoring-models/${SHOT_TYPE}/${version}/release`,
      headers: auth(adminToken),
      payload: releaseBody,
    });
  }

  async function rows(prefix: string): Promise<ModelRow[]> {
    const result = await pool.query<ModelRow>(
      `SELECT version, status, active_from, active_to, released_at, model_bundle_id
       FROM scoring_model WHERE shot_type_id = $1 AND version LIKE $2 ORDER BY version`,
      [shotTypeId, `${prefix}%`],
    );
    return result.rows;
  }

  async function openEndedActive(): Promise<string[]> {
    const result = await pool.query<{ version: string }>(
      `SELECT version FROM scoring_model
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL ORDER BY version`,
      [shotTypeId],
    );
    return result.rows.map((r) => r.version);
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    app = buildApp(config(), { queue: new InMemoryJobQueue() });
    await app.ready();
    const minter = new DevTokenVerifier("test", DEV_SECRET);
    adminToken = await minter.mint(ADMIN_SUBJECT, "admin");
    const boot = await app.inject({
      method: "POST",
      url: "/v1/account/bootstrap",
      headers: auth(adminToken),
      payload: {
        locale: "en-US",
        timezone: "UTC",
        device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adj05" },
      },
    });
    expect(boot.statusCode).toBe(200);

    shotTypeId = (
      await pool.query<{ id: string }>("SELECT id FROM shot_type WHERE slug = $1", [SHOT_TYPE])
    ).rows[0]!.id;
    await pool.query(
      `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent, metadata)
       VALUES ($1, $2, 'active', 100, '{}')
       ON CONFLICT (version) DO UPDATE SET status='active', rollout_percent=100,
         manifest_sha256=EXCLUDED.manifest_sha256`,
      [releaseBody.modelBundleVersion, "a".repeat(64)],
    );
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  it("AC1: releasing a `retired` version returns 409 and leaves the row unchanged", async () => {
    await insertModel("adj05-retired", "retired");
    await pool.query(
      `UPDATE scoring_model SET active_from = now() - interval '2 days', active_to = now() - interval '1 day'
       WHERE shot_type_id = $1 AND version = 'adj05-retired'`,
      [shotTypeId],
    );
    const [before] = await rows("adj05-retired");
    const res = await release("adj05-retired");
    const [after] = await rows("adj05-retired");
    const body = res.json() as ErrorEnvelope;
    console.log(`ADJ-05 AC1: release adj05-retired → ${res.statusCode} ${res.body.slice(0, 200)}`);
    expect(res.statusCode, "retired → release must be refused").toBe(409);
    expect(body.error?.code, "refusal must carry a typed error code").toMatch(/^scoring\./);
    expect(after, "retired row must be byte-for-byte unchanged").toEqual(before);
    expect(after!.status).toBe("retired");
  });

  it("AC2: releasing v2 after v1 supersedes v1 — exactly one open-ended active row per shot type", async () => {
    await insertModel("adj05-seq-v1", "validating");
    await insertModel("adj05-seq-v2", "draft");
    const v1 = await release("adj05-seq-v1");
    expect(v1.statusCode, `v1 release: ${v1.body}`).toBe(200);
    const afterV1 = await openEndedActive();
    expect(afterV1, "after v1 release exactly one open-ended active row").toEqual(["adj05-seq-v1"]);

    const v2 = await release("adj05-seq-v2");
    expect(v2.statusCode, `v2 release: ${v2.body}`).toBe(200);
    const all = await rows("adj05-seq-");
    console.log(`ADJ-05 AC2: rows=${JSON.stringify(all)}`);
    expect(await openEndedActive(), "exactly one open-ended active row").toEqual(["adj05-seq-v2"]);
    const v1Row = all.find((r) => r.version === "adj05-seq-v1")!;
    expect(v1Row.active_to, "superseded v1 must be closed (active_to NOT NULL)").not.toBeNull();
    expect(v1Row.status, "superseded v1 must no longer be `active`").not.toBe("active");
  });

  it("AC3: 8 concurrent releases of different versions end with exactly one open-ended active row; losers get a typed 409", async () => {
    const versions = Array.from({ length: 8 }, (_, i) => `adj05-race-v${i}`);
    for (const v of versions) await insertModel(v, "validating");

    const responses = await Promise.all(versions.map((v) => release(v)));
    const outcomes = responses.map((r, i) => ({
      version: versions[i]!,
      status: r.statusCode,
      code: (r.json() as ErrorEnvelope).error?.code,
    }));
    const active = await openEndedActive();
    console.log(
      `ADJ-05 AC3: outcomes=${JSON.stringify(outcomes)}; open-ended active=${JSON.stringify(active)}`,
    );

    expect(
      outcomes.filter((o) => o.status >= 500),
      "a release race must never surface as a 5xx",
    ).toEqual([]);
    const winners = outcomes.filter((o) => o.status === 200);
    const losers = outcomes.filter((o) => o.status !== 200);
    expect(winners, "exactly one concurrent release wins").toHaveLength(1);
    expect(losers, "seven concurrent releases lose").toHaveLength(7);
    for (const loser of losers) {
      expect(loser.status, `${loser.version} loser status`).toBe(409);
      expect(loser.code, `${loser.version} loser code`).toMatch(/^scoring\./);
    }
    expect(active, "exactly one open-ended active row after the race").toEqual([
      winners[0]!.version,
    ]);
    // The winner must also have superseded whatever was active before the race
    // (adj05-seq-v2 from AC2) — no second open-ended active row survives.
    const seqV2 = (await rows("adj05-seq-v2"))[0]!;
    expect(seqV2.active_to).not.toBeNull();
  });

  it("AC4: a DB-level UNIQUE partial index enforces one open-ended active model per shot type, added by a NEW migration (applied migrations untouched)", async () => {
    // migrate + seed on a fresh DB already succeeded in beforeAll.
    const { rows: indexes } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'scoring_model'`,
    );
    console.log(`ADJ-05 AC4: scoring_model indexes=${JSON.stringify(indexes)}`);
    const singleActive = indexes.filter(
      (ix) =>
        /CREATE UNIQUE INDEX/i.test(ix.indexdef) &&
        /\(shot_type_id\)/.test(ix.indexdef) &&
        /WHERE/.test(ix.indexdef) &&
        /status\s*=\s*'active'/.test(ix.indexdef) &&
        /active_to IS NULL/i.test(ix.indexdef),
    );
    expect(
      singleActive,
      "expected UNIQUE INDEX ... ON scoring_model (shot_type_id) WHERE status = 'active' AND active_to IS NULL",
    ).toHaveLength(1);

    // Direct SQL bypassing the API must be rejected by the DB itself.
    await insertModel("adj05-direct-a", "validating");
    await insertModel("adj05-direct-b", "validating");
    await pool.query(
      `UPDATE scoring_model SET active_to = now(), status = 'retired'
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL`,
      [shotTypeId],
    );
    const activate = (version: string) =>
      pool.query(
        `UPDATE scoring_model SET status = 'active', model_bundle_id = mb.id,
           dataset_snapshot_id = 'adj05-ds', evaluation_report_sha256 = repeat('c', 64),
           coach_validation_reference = 'adj05-coach', released_by = au.id,
           released_at = now(), active_from = now(), active_to = NULL
         FROM model_bundle mb, app_user au
         WHERE mb.version = $2 AND au.auth_subject = $3
           AND scoring_model.shot_type_id = $1 AND scoring_model.version = $4`,
        [shotTypeId, releaseBody.modelBundleVersion, ADMIN_SUBJECT, version],
      );
    await activate("adj05-direct-a");
    await expect(activate("adj05-direct-b"), "second open-ended active row").rejects.toMatchObject({
      code: "23505",
    });

    // Additivity: the index must come from a migration later than every file
    // that already existed at the finding's base; those files are unchanged.
    const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
    const defining: string[] = [];
    for (const name of names) {
      const sql = await readFile(join(migrationsDir, name), "utf8");
      if (sql.includes(singleActive[0]!.indexname)) defining.push(name);
    }
    expect(defining, "exactly one migration defines the index").toHaveLength(1);
    expect(
      defining[0]! > LAST_PREEXISTING_MIGRATION,
      `${defining[0]} must sort after ${LAST_PREEXISTING_MIGRATION}`,
    ).toBe(true);
  });
});
