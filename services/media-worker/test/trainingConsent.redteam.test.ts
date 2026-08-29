import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import {
  selectTrainingEligibleItems,
  selectTrainingEligibleItemsWithWatermark,
  verifyTrainingEligibility,
} from "../src/trainingConsent.js";

/**
 * Wave D3 red-team suite (D3-08): the withdrawal race against an in-flight
 * training-eligibility selection, at the database level.
 *
 * RT-7  BREAK (inherent TOCTOU, demonstrated): a selection taken inside a
 *       REPEATABLE READ snapshot opened before a withdrawal commits still
 *       returns the withdrawn user's items. The hardening is a mandatory
 *       re-verification (verifyTrainingEligibility) on a fresh connection,
 *       which this test proves drops the withdrawn items.
 * RT-8  The consent watermark advances across a withdrawal so consumers can
 *       detect that a selection is stale.
 * RT-9  The selection reports the ledger grant's consent version alongside
 *       the version stamped on the item at ingest, so a version upgrade
 *       mid-session is visible to training consumers.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

describe.skipIf(!testUrl)("training consent withdrawal race (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let raceUser: string;
  let versionUser: string;

  async function createUser(subject: string): Promise<string> {
    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [subject],
    );
    return rows[0].id as string;
  }

  async function appendConsent(
    userId: string,
    action: "granted" | "withdrawn",
    version = "model-training-v1",
  ): Promise<void> {
    const subject = await pool.query(
      `INSERT INTO consent_subject (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = consent_subject.user_id
       RETURNING pseudonym`,
      [userId],
    );
    await pool.query(
      `INSERT INTO consent_record
         (subject_pseudonym, scope, action, consent_version, source, capture_mode)
       VALUES ($1, 'model_training', $2, $3, 'mobile_settings', 'all_captures')`,
      [subject.rows[0].pseudonym, action, version],
    );
  }

  async function addDatasetItem(userId: string, version = "model-training-v1"): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, consent_version)
       VALUES ($1, $2) RETURNING id`,
      [userId, version],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    raceUser = await createUser("auth0|rt-race");
    versionUser = await createUser("auth0|rt-grant-version");
    await appendConsent(raceUser, "granted");
    await addDatasetItem(raceUser);
    await appendConsent(versionUser, "granted", "model-training-v1");
    await addDatasetItem(versionUser, "model-training-v1");
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  it("RT-7: withdrawal committed after the selection snapshot is invisible to it — re-verification catches it", async () => {
    const staleClient = await pool.connect();
    try {
      await staleClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      // Materialize the snapshot, then select: the user is consented here.
      const before = await selectTrainingEligibleItems(staleClient);
      const raceItems = before.filter((i) => i.source_user_id === raceUser);
      expect(raceItems).toHaveLength(1);

      // Concurrently (separate connection) the user withdraws and it commits.
      await appendConsent(raceUser, "withdrawn");

      // BREAK demonstrated: the in-flight snapshot still sees the item as
      // eligible even though consent is already withdrawn.
      const staleAgain = await selectTrainingEligibleItems(staleClient);
      expect(staleAgain.filter((i) => i.source_user_id === raceUser)).toHaveLength(1);
      await staleClient.query("COMMIT");

      // Hardening: mandatory re-verification on a fresh connection drops it.
      const verified = await verifyTrainingEligibility(pool, raceItems);
      expect(verified).toHaveLength(0);

      // And a fresh selection no longer returns it either.
      const fresh = await selectTrainingEligibleItems(pool);
      expect(fresh.filter((i) => i.source_user_id === raceUser)).toHaveLength(0);
    } finally {
      staleClient.release();
    }
  });

  it("RT-8: the consent watermark advances across ledger writes, exposing stale selections", async () => {
    const first = await selectTrainingEligibleItemsWithWatermark(pool);
    await appendConsent(raceUser, "granted");
    const second = await selectTrainingEligibleItemsWithWatermark(pool);
    expect(second.consentWatermark).toBeGreaterThan(first.consentWatermark);
    // Regranted: the item is eligible again (regrant restores nothing silently
    // at the dataset level — removed_at was never set in this scenario).
    expect(second.items.filter((i) => i.source_user_id === raceUser)).toHaveLength(1);
    // Roll back to withdrawn so later tests see the withdrawn state.
    await appendConsent(raceUser, "withdrawn");
  });

  it("RT-9: selection exposes the authorizing grant's consent version next to the item's ingest version", async () => {
    // Mid-session version upgrade: the user re-grants under v2.
    await appendConsent(versionUser, "granted", "model-training-v2");
    const items = (await selectTrainingEligibleItems(pool)).filter(
      (i) => i.source_user_id === versionUser,
    );
    expect(items).toHaveLength(1);
    expect(items[0]!.consent_version).toBe("model-training-v1"); // stamped at ingest
    expect(items[0]!.grant_consent_version).toBe("model-training-v2"); // current authority
  });

  it("RT: verifyTrainingEligibility keeps consented items and is a no-op on empty batches", async () => {
    expect(await verifyTrainingEligibility(pool, [])).toEqual([]);
    const items = (await selectTrainingEligibleItems(pool)).filter(
      (i) => i.source_user_id === versionUser,
    );
    const verified = await verifyTrainingEligibility(pool, items);
    expect(verified).toHaveLength(1);
  });
});
