import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import {
  TEST_DATABASE_URL,
  attackConfig,
  bearer,
  bootstrap,
  minter,
  resetTestDatabase,
  writeArtifact,
} from "./support.js";

/**
 * ATTACK S1 — concurrent scoring-model release for two versions of ONE shot
 * type against the SAME 100% active bundle.
 *
 * Attack: `PUT /v1/admin/scoring-models/forehand_drive/sm-v1/release` and
 * `…/sm-v2/release` fired in the same tick. The release transaction locks the
 * model_bundle row (`FOR UPDATE`) but never retires the sibling versions and
 * the schema has no "one active model per shot type" constraint, so the
 * invariant the scenario asserts — at most one `status='active'` row for the
 * shot type — must hold by construction or it does not hold at all.
 */

const SHOT_TYPE = "forehand_drive";
const BUNDLE_VERSION = "test-native-1";
const RELEASE_BODY = {
  modelBundleVersion: BUNDLE_VERSION,
  datasetSnapshotId: "attack4-dataset-snapshot-0001",
  evaluationReportSha256: "c".repeat(64),
  coachValidationReference: "attack4-coach-review-ref",
};

interface ActiveRow {
  version: string;
  status: string;
  active_from: Date | null;
  active_to: Date | null;
}

async function activeRows(pool: pg.Pool): Promise<ActiveRow[]> {
  const { rows } = await pool.query<ActiveRow>(
    `SELECT sm.version, sm.status, sm.active_from, sm.active_to
       FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
      WHERE st.slug = $1 AND sm.status = 'active' AND sm.active_to IS NULL
      ORDER BY sm.version`,
    [SHOT_TYPE],
  );
  return rows;
}

/** Put every version of the shot type back to the pre-release state. */
async function resetVersions(pool: pg.Pool): Promise<void> {
  await pool.query(
    `UPDATE scoring_model sm SET status = 'validating', active_from = NULL, active_to = NULL,
            released_by = NULL, released_at = NULL, model_bundle_id = NULL
       FROM shot_type st WHERE sm.shot_type_id = st.id AND st.slug = $1`,
    [SHOT_TYPE],
  );
}

describe.skipIf(!TEST_DATABASE_URL)("ATTACK S1: concurrent scoring-model release race", () => {
  let app: FastifyInstance;
  let pool: pg.Pool;
  let adminToken: string;

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    pool = new pg.Pool({ connectionString: TEST_DATABASE_URL });
    app = buildApp(attackConfig());
    adminToken = await minter().mint("attack4|admin", "admin");
    await bootstrap(app, adminToken);

    // Second version of the same shot type, same hypothesis config.
    await pool.query(
      `INSERT INTO scoring_model (shot_type_id, version, status, min_analysis_confidence,
                                  lower_confidence_threshold, config)
       SELECT sm.shot_type_id, 'sm-v2', 'validating', sm.min_analysis_confidence,
              sm.lower_confidence_threshold, sm.config
         FROM scoring_model sm JOIN shot_type st ON st.id = sm.shot_type_id
        WHERE st.slug = $1 AND sm.version = 'sm-v1'
       ON CONFLICT (shot_type_id, version) DO NOTHING`,
      [SHOT_TYPE],
    );
    await resetVersions(pool);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  function release(version: string) {
    return app.inject({
      method: "PUT",
      url: `/v1/admin/scoring-models/${SHOT_TYPE}/${version}/release`,
      headers: bearer(adminToken),
      payload: RELEASE_BODY,
    });
  }

  it("at most one scoring_model row per shot type ends status='active' after concurrent releases", async () => {
    const before = await activeRows(pool);
    expect(before, "precondition: nothing active").toEqual([]);

    const ROUNDS = 5;
    const rounds: Array<{
      round: number;
      statuses: number[];
      bodies: unknown[];
      active: ActiveRow[];
    }> = [];
    let maxActive = 0;
    for (let round = 0; round < ROUNDS; round++) {
      await resetVersions(pool);
      // Alternate firing order so neither version is always first on the wire.
      const versions = round % 2 === 0 ? ["sm-v1", "sm-v2"] : ["sm-v2", "sm-v1"];
      const responses = await Promise.all(versions.map((v) => release(v)));
      const active = await activeRows(pool);
      maxActive = Math.max(maxActive, active.length);
      rounds.push({
        round,
        statuses: responses.map((r) => r.statusCode),
        bodies: responses.map((r) => r.json()),
        active,
      });
    }

    const artifact = writeArtifact("s1-scoring-release-race.json", {
      scenario: "S1 concurrent PUT /v1/admin/scoring-models/<shot>/<v>/release",
      shotType: SHOT_TYPE,
      bundleVersion: BUNDLE_VERSION,
      rounds,
      maxActiveRowsObserved: maxActive,
      expectedMaxActiveRows: 1,
    });

    for (const r of rounds) {
      expect(r.statuses, `round ${r.round} both releases were accepted`).toEqual([200, 200]);
    }
    expect(
      maxActive,
      `expected ≤1 active scoring_model for ${SHOT_TYPE}; evidence: ${artifact}`,
    ).toBeLessThanOrEqual(1);
  }, 60_000);

  it("sequential releases (no race) also leave only one active version", async () => {
    await resetVersions(pool);
    const first = await release("sm-v1");
    const second = await release("sm-v2");
    const active = await activeRows(pool);
    const artifact = writeArtifact("s1-scoring-release-sequential.json", {
      statuses: [first.statusCode, second.statusCode],
      active,
    });
    expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
    expect(active.length, `sequential release; evidence: ${artifact}`).toBeLessThanOrEqual(1);
  });
});
