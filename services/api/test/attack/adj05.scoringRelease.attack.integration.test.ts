import { readdir } from "node:fs/promises";
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
 * ADJ-05 ATTACK SUITE (services-api-legacy-admin-web): scoring-model release
 * state machine, probed at double the scale of the pinning test and along its
 * neighbourhood. Real PostgreSQL, fresh migrate + seed, REAL TCP listener so
 * concurrent requests arrive on independent connections (not `app.inject`).
 *
 * Expected behaviour (from the finding): a release is only allowed from
 * `draft`/`validating` (409 otherwise); releasing closes the previously
 * active version (`active_to = now()`, status no longer `active`); at most one
 * open-ended active model per shot type, enforced by the DB itself; other
 * shot types are never touched; refused releases leave no audit trail and no
 * row change.
 *
 * Tests tagged [GUARD] pass on f702f0f8 and pin behaviour a fix must keep.
 * Tests tagged [BREAK] fail on f702f0f8 and expose the defect surface.
 *
 * Skipped (visibly) without DATABASE_URL_TEST — a skip is never a pass.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const DEV_SECRET = "adj05-attack-secret-0123456789abcdef";
const ADMIN_SUBJECT = "auth0|adj05-attack-admin";
const USER_SUBJECT = "auth0|adj05-attack-user";
const SHOT_A = "forehand_drive";
const SHOT_B = "dink";
const RACE_WIDTH = 16;

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
    appVersion: "0.1.0-adj05-attack",
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

const BUNDLE = "adj05-attack-bundle-1";
const CANARY_BUNDLE = "adj05-attack-bundle-canary";
const releaseBody = {
  modelBundleVersion: BUNDLE,
  datasetSnapshotId: "adj05-attack-dataset-snapshot",
  evaluationReportSha256: "b".repeat(64),
  coachValidationReference: "adj05-attack-coach-review",
};

interface ModelRow {
  version: string;
  status: string;
  active_from: string | null;
  active_to: string | null;
  released_at: string | null;
  released_by: string | null;
  model_bundle_id: string | null;
}

interface ErrorEnvelope {
  error?: { code?: string; kind?: string };
}

interface Outcome {
  version: string;
  status: number;
  code: string | undefined;
}

describe.skipIf(!testUrl)(
  "ADJ-05 attack: scoring-model release state machine (real PostgreSQL, real TCP)",
  () => {
    let app: FastifyInstance;
    let baseUrl: string;
    let pool: pg.Pool;
    let adminToken: string;
    let userToken: string;
    const shotTypeId: Record<string, string> = {};

    async function insertModel(slug: string, version: string, status: string): Promise<void> {
      await pool.query(
        `INSERT INTO scoring_model (shot_type_id, version, status)
       VALUES ($1, $2, $3) ON CONFLICT (shot_type_id, version) DO NOTHING`,
        [shotTypeId[slug], version, status],
      );
    }

    /** Real HTTP over TCP — every call is its own socket, not `app.inject`. */
    async function releaseHttp(
      slug: string,
      version: string,
      token = adminToken,
      body: unknown = releaseBody,
    ): Promise<{ status: number; json: ErrorEnvelope & Record<string, unknown> }> {
      const res = await fetch(
        `${baseUrl}/v1/admin/scoring-models/${encodeURIComponent(slug)}/${encodeURIComponent(version)}/release`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      const text = await res.text();
      let json: ErrorEnvelope & Record<string, unknown> = {};
      try {
        json = JSON.parse(text) as ErrorEnvelope & Record<string, unknown>;
      } catch {
        json = { raw: text };
      }
      return { status: res.status, json };
    }

    async function rows(slug: string, prefix: string): Promise<ModelRow[]> {
      const result = await pool.query<ModelRow>(
        `SELECT version, status, active_from, active_to, released_at, released_by, model_bundle_id
       FROM scoring_model WHERE shot_type_id = $1 AND version LIKE $2 ORDER BY version`,
        [shotTypeId[slug], `${prefix}%`],
      );
      return result.rows;
    }

    async function openEndedActive(slug: string): Promise<string[]> {
      const result = await pool.query<{ version: string }>(
        `SELECT version FROM scoring_model
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL ORDER BY version`,
        [shotTypeId[slug]],
      );
      return result.rows.map((r) => r.version);
    }

    async function auditCount(target: string): Promise<number> {
      const result = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'scoring_model.released' AND target_id = $1`,
        [target],
      );
      return result.rows[0]!.n;
    }

    function summarize(outcomes: Outcome[]) {
      return {
        winners: outcomes.filter((o) => o.status === 200),
        losers: outcomes.filter((o) => o.status !== 200),
        fiveXX: outcomes.filter((o) => o.status >= 500),
      };
    }

    beforeAll(async () => {
      pool = new pg.Pool({ connectionString: testUrl, max: 8 });
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      app = buildApp(config(), { queue: new InMemoryJobQueue() });
      await app.ready();
      baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });

      const minter = new DevTokenVerifier("test", DEV_SECRET);
      adminToken = await minter.mint(ADMIN_SUBJECT, "admin");
      userToken = await minter.mint(USER_SUBJECT, "user");
      for (const token of [adminToken, userToken]) {
        const boot = await fetch(`${baseUrl}/v1/account/bootstrap`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            locale: "en-US",
            timezone: "UTC",
            device: { platform: "ios", osVersion: "18.0", appVersion: "0.1.0", model: "adj05" },
          }),
        });
        expect(boot.status).toBe(200);
      }

      for (const slug of [SHOT_A, SHOT_B]) {
        shotTypeId[slug] = (
          await pool.query<{ id: string }>("SELECT id FROM shot_type WHERE slug = $1", [slug])
        ).rows[0]!.id;
      }
      await pool.query(
        `INSERT INTO model_bundle (version, manifest_sha256, status, rollout_percent, metadata)
       VALUES ($1, $2, 'active', 100, '{}'), ($3, $2, 'canary', 50, '{}')
       ON CONFLICT (version) DO NOTHING`,
        [BUNDLE, "a".repeat(64), CANARY_BUNDLE],
      );
    }, 90_000);

    afterAll(async () => {
      await app?.close();
      await pool?.end();
    });

    // ---------------------------------------------------------------------------
    // [GUARD] input / auth boundaries — pass on f702f0f8, must keep passing.
    // ---------------------------------------------------------------------------
    it("[GUARD] non-admin bearer is refused with 403 and changes no row", async () => {
      await insertModel(SHOT_A, "atk-guard-user", "validating");
      const before = await rows(SHOT_A, "atk-guard-user");
      const res = await releaseHttp(SHOT_A, "atk-guard-user", userToken);
      expect(res.status).toBe(403);
      expect(res.json.error?.code).toBe("auth.admin_required");
      expect(await rows(SHOT_A, "atk-guard-user")).toEqual(before);
    });

    it("[GUARD] malformed payloads are 400 and change no row", async () => {
      await insertModel(SHOT_A, "atk-guard-body", "validating");
      const before = await rows(SHOT_A, "atk-guard-body");
      const bad: unknown[] = [
        null,
        {},
        { ...releaseBody, evaluationReportSha256: "B".repeat(64) },
        { ...releaseBody, evaluationReportSha256: "b".repeat(63) },
        { ...releaseBody, modelBundleVersion: "" },
        { ...releaseBody, datasetSnapshotId: "short" },
        { ...releaseBody, coachValidationReference: null },
      ];
      for (const body of bad) {
        const res = await releaseHttp(SHOT_A, "atk-guard-body", adminToken, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
      expect(await releaseHttp("Forehand_Drive", "atk-guard-body").then((r) => r.status)).toBe(400);
      expect(await releaseHttp(SHOT_A, "   ").then((r) => r.status)).toBe(400);
      expect(await rows(SHOT_A, "atk-guard-body")).toEqual(before);
    });

    it("[GUARD] version lookalikes (trailing space, unicode confusable) never release the real row", async () => {
      await insertModel(SHOT_A, "atk-guard-look", "validating");
      for (const lookalike of [
        "atk-guard-look ",
        "atk-guard-lo\u200bok",
        "ATK-GUARD-LOOK",
        "atk-guard-look\u0301",
      ]) {
        const res = await releaseHttp(SHOT_A, lookalike);
        expect(res.status, JSON.stringify(lookalike)).toBe(409);
        expect(res.json.error?.code).toMatch(/^scoring\./);
      }
      expect((await rows(SHOT_A, "atk-guard-look"))[0]!.status).toBe("validating");
    });

    it("[GUARD] a bundle that is not 100% active cannot be released against; row unchanged", async () => {
      await insertModel(SHOT_A, "atk-guard-canary", "validating");
      const res = await releaseHttp(SHOT_A, "atk-guard-canary", adminToken, {
        ...releaseBody,
        modelBundleVersion: CANARY_BUNDLE,
      });
      expect(res.status).toBe(409);
      expect((await rows(SHOT_A, "atk-guard-canary"))[0]!.status).toBe("validating");
    });

    // ---------------------------------------------------------------------------
    // [BREAK] state machine — fail on f702f0f8.
    // ---------------------------------------------------------------------------
    it("[BREAK] releasing a `retired` version is refused (409), the row is unchanged and NO audit row is written", async () => {
      await insertModel(SHOT_A, "atk-retired", "retired");
      await pool.query(
        `UPDATE scoring_model SET active_from = now() - interval '3 days', active_to = now() - interval '1 day'
       WHERE shot_type_id = $1 AND version = 'atk-retired'`,
        [shotTypeId[SHOT_A]],
      );
      const [before] = await rows(SHOT_A, "atk-retired");
      const res = await releaseHttp(SHOT_A, "atk-retired");
      const [after] = await rows(SHOT_A, "atk-retired");
      console.log(
        `ATTACK retired: → ${res.status} ${JSON.stringify(res.json)} row=${JSON.stringify(after)}`,
      );
      expect(res.status, "retired → release must be refused").toBe(409);
      expect(res.json.error?.code).toMatch(/^scoring\./);
      expect(after).toEqual(before);
      expect(
        await auditCount(`${SHOT_A}:atk-retired`),
        "refused release must not be audited as released",
      ).toBe(0);
    });

    it("[BREAK] replaying a release of the ALREADY-ACTIVE version is refused and does not rewrite release history", async () => {
      await insertModel(SHOT_A, "atk-replay", "validating");
      const first = await releaseHttp(SHOT_A, "atk-replay");
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      const [afterFirst] = await rows(SHOT_A, "atk-replay");
      await pool.query("SELECT pg_sleep(0.05)");
      const second = await releaseHttp(SHOT_A, "atk-replay", adminToken, {
        ...releaseBody,
        datasetSnapshotId: "adj05-attack-dataset-snapshot-REWRITTEN",
        evaluationReportSha256: "c".repeat(64),
      });
      const [afterSecond] = await rows(SHOT_A, "atk-replay");
      console.log(
        `ATTACK replay: second → ${second.status}; first=${JSON.stringify(afterFirst)} second=${JSON.stringify(afterSecond)}`,
      );
      expect(second.status, "active → release (replay) must be refused").toBe(409);
      expect(afterSecond, "release evidence/timestamps of an active version are immutable").toEqual(
        afterFirst,
      );
    });

    it("[BREAK] sequential chain v1→v2→v3 supersedes each predecessor; re-releasing superseded v1 is refused", async () => {
      for (const v of ["atk-chain-v1", "atk-chain-v2", "atk-chain-v3"])
        await insertModel(SHOT_A, v, "validating");
      await pool.query(
        `UPDATE scoring_model SET status = 'retired', active_to = now()
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL`,
        [shotTypeId[SHOT_A]],
      );
      for (const v of ["atk-chain-v1", "atk-chain-v2", "atk-chain-v3"]) {
        const res = await releaseHttp(SHOT_A, v);
        expect(res.status, `${v}: ${JSON.stringify(res.json)}`).toBe(200);
        expect(await openEndedActive(SHOT_A), `after ${v}`).toEqual([v]);
      }
      const all = await rows(SHOT_A, "atk-chain-");
      console.log(`ATTACK chain: rows=${JSON.stringify(all)}`);
      for (const v of ["atk-chain-v1", "atk-chain-v2"]) {
        const row = all.find((r) => r.version === v)!;
        expect(row.active_to, `${v} closed`).not.toBeNull();
        expect(row.status, `${v} not active`).not.toBe("active");
      }
      const back = await releaseHttp(SHOT_A, "atk-chain-v1");
      expect(back.status, "superseded v1 cannot be re-released").toBe(409);
      expect(await openEndedActive(SHOT_A)).toEqual(["atk-chain-v3"]);
    });

    it(`[BREAK] ${RACE_WIDTH} concurrent releases over real TCP → exactly 1×200, ${RACE_WIDTH - 1}×409 typed, no 5xx, one open-ended active`, async () => {
      const versions = Array.from(
        { length: RACE_WIDTH },
        (_, i) => `atk-race-v${String(i).padStart(2, "0")}`,
      );
      for (const v of versions) await insertModel(SHOT_A, v, "validating");
      const outcomes: Outcome[] = await Promise.all(
        versions.map(async (version) => {
          const r = await releaseHttp(SHOT_A, version);
          return { version, status: r.status, code: r.json.error?.code };
        }),
      );
      const active = await openEndedActive(SHOT_A);
      const { winners, losers, fiveXX } = summarize(outcomes);
      console.log(
        `ATTACK race16: outcomes=${JSON.stringify(outcomes)} active=${JSON.stringify(active)}`,
      );
      expect(fiveXX, "no 5xx under contention").toEqual([]);
      expect(winners, "exactly one winner").toHaveLength(1);
      expect(losers).toHaveLength(RACE_WIDTH - 1);
      for (const l of losers) {
        expect(l.status, l.version).toBe(409);
        expect(l.code, l.version).toMatch(/^scoring\./);
      }
      expect(active).toEqual([winners[0]!.version]);
    });

    it("[BREAK] cross-shot-type race: 8+8 concurrent releases → exactly one open-ended active per shot type, neither leaks into the other", async () => {
      const a = Array.from({ length: 8 }, (_, i) => `atk-x-a${i}`);
      const b = Array.from({ length: 8 }, (_, i) => `atk-x-b${i}`);
      for (const v of a) await insertModel(SHOT_A, v, "validating");
      for (const v of b) await insertModel(SHOT_B, v, "draft");
      const beforeBOthers = await rows(SHOT_B, "");
      const outcomes: Outcome[] = await Promise.all([
        ...a.map(async (version) => {
          const r = await releaseHttp(SHOT_A, version);
          return { version, status: r.status, code: r.json.error?.code };
        }),
        ...b.map(async (version) => {
          const r = await releaseHttp(SHOT_B, version);
          return { version, status: r.status, code: r.json.error?.code };
        }),
      ]);
      const activeA = await openEndedActive(SHOT_A);
      const activeB = await openEndedActive(SHOT_B);
      console.log(
        `ATTACK xrace: outcomes=${JSON.stringify(outcomes)} A=${JSON.stringify(activeA)} B=${JSON.stringify(activeB)}`,
      );
      expect(summarize(outcomes).fiveXX).toEqual([]);
      const winA = outcomes.filter((o) => o.status === 200 && a.includes(o.version));
      const winB = outcomes.filter((o) => o.status === 200 && b.includes(o.version));
      expect(winA, "exactly one winner for shot type A").toHaveLength(1);
      expect(winB, "exactly one winner for shot type B").toHaveLength(1);
      expect(activeA).toEqual([winA[0]!.version]);
      expect(activeB).toEqual([winB[0]!.version]);
      // Rows of shot type B that were NOT part of the race must be untouched by A's releases
      // (a fix's supersede UPDATE must be scoped to the same shot_type_id).
      const afterBOthers = (await rows(SHOT_B, "")).filter((r) => !b.includes(r.version));
      expect(afterBOthers).toEqual(beforeBOthers.filter((r) => !b.includes(r.version)));
    });

    it("[BREAK] release + direct-SQL activation race across two real DB sessions: the DB itself keeps one open-ended active row (23505)", async () => {
      await insertModel(SHOT_A, "atk-dbrace-api", "validating");
      await insertModel(SHOT_A, "atk-dbrace-sql", "validating");
      await pool.query(
        `UPDATE scoring_model SET status = 'retired', active_to = now()
       WHERE shot_type_id = $1 AND status = 'active' AND active_to IS NULL`,
        [shotTypeId[SHOT_A]],
      );
      const sqlSession = new pg.Client({ connectionString: testUrl });
      await sqlSession.connect();
      try {
        await sqlSession.query("BEGIN");
        await sqlSession.query(
          `UPDATE scoring_model SET status = 'active', model_bundle_id = mb.id,
           dataset_snapshot_id = 'atk-ds', evaluation_report_sha256 = repeat('d', 64),
           coach_validation_reference = 'atk-coach', released_by = au.id,
           released_at = now(), active_from = now(), active_to = NULL
         FROM model_bundle mb, app_user au
         WHERE mb.version = $2 AND au.auth_subject = $3
           AND scoring_model.shot_type_id = $1 AND scoring_model.version = 'atk-dbrace-sql'`,
          [shotTypeId[SHOT_A], BUNDLE, ADMIN_SUBJECT],
        );
        // Session 1 holds an uncommitted activation; session 2 (the API) releases another version.
        const apiPromise = releaseHttp(SHOT_A, "atk-dbrace-api");
        await new Promise((r) => setTimeout(r, 150));
        await sqlSession.query("COMMIT");
        const api = await apiPromise;
        const active = await openEndedActive(SHOT_A);
        console.log(
          `ATTACK dbrace: api → ${api.status} ${JSON.stringify(api.json)} active=${JSON.stringify(active)}`,
        );
        expect(api.status, "API must answer 200 or a typed 409, never 5xx").toBeLessThan(500);
        expect(active, "the DB must never hold two open-ended active rows").toHaveLength(1);
      } finally {
        await sqlSession.end();
      }
    });

    it("[BREAK] schema: a UNIQUE partial index on scoring_model(shot_type_id) WHERE status='active' AND active_to IS NULL exists and comes from a migration after 0020", async () => {
      const { rows: indexes } = await pool.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'scoring_model'`,
      );
      console.log(`ATTACK schema: indexes=${JSON.stringify(indexes)}`);
      const single = indexes.filter(
        (ix) =>
          /CREATE UNIQUE INDEX/i.test(ix.indexdef) &&
          /\(shot_type_id\)/.test(ix.indexdef) &&
          /status\s*=\s*'active'/.test(ix.indexdef) &&
          /active_to IS NULL/i.test(ix.indexdef),
      );
      expect(single).toHaveLength(1);
      const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
      expect(names[names.length - 1]! > "0020_deletion_task_fair_scheduling.sql").toBe(true);
    });

    it("[BREAK] upgrade path: direct-SQL attempts to create duplicate open-ended active rows are rejected by the schema and none survive a re-migrate", async () => {
      // Legacy-style writes bypassing the API must be stopped by the DB; after
      // re-applying migrations (idempotent runner) the invariant must hold.
      await insertModel(SHOT_B, "atk-legacy-1", "validating");
      await insertModel(SHOT_B, "atk-legacy-2", "validating");
      await pool
        .query(
          `UPDATE scoring_model SET status = 'active', active_from = now() - interval '10 days', active_to = NULL
       WHERE shot_type_id = $1 AND version IN ('atk-legacy-1', 'atk-legacy-2')`,
          [shotTypeId[SHOT_B]],
        )
        .catch(() => undefined);
      await runMigrations(pool, migrationsDir);
      const { rows: dupes } = await pool.query<{ shot_type_id: string; n: number }>(
        `SELECT shot_type_id, count(*)::int AS n FROM scoring_model
       WHERE status = 'active' AND active_to IS NULL GROUP BY shot_type_id HAVING count(*) > 1`,
      );
      console.log(`ATTACK legacy: duplicate groups=${JSON.stringify(dupes)}`);
      expect(
        dupes,
        "no shot type may keep more than one open-ended active row after migrate",
      ).toEqual([]);
    });
  },
);
