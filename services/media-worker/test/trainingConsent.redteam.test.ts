import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import {
  isDatasetItemTrainingEligible,
  latestEligibilityEntries,
  recordTrainingEligibility,
  selectTrainingEligibleItems,
  selectTrainingEligibleItemsWithWatermark,
  verifyTrainingEligibility,
  type TrainingEligibleItem,
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
 *
 * Wave F f23 additions:
 * F23-6 BREAK (fixed): a grant narrowed to one capture mode
 *       (capture_mode = 'imported_video') authorized every item of the user,
 *       including automatic-trigger captures, because no selector read
 *       capture_mode. ml_dataset_item carries no capture-mode provenance, so
 *       narrowed grants now authorize nothing (fail-closed).
 *
 * Wave I i12 additions (training-eligibility ledger):
 * I12-RT-A the sanctioned flow records eligibility entries keyed by grant
 *          seq/version + analysis/session provenance, and a withdrawal
 *          flips the item's future eligibility (DB-propagated entry).
 * I12-RT-B a compromised caller hand-crafting a TrainingEligibleItem from a
 *          video_analysis grant cannot record it as eligible: the database
 *          scope guard rejects it.
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
    captureMode = "all_captures",
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
       VALUES ($1, 'model_training', $2, $3, 'mobile_settings', $4)`,
      [subject.rows[0].pseudonym, action, version, captureMode],
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

  it("F23-6: a capture-mode-narrowed grant authorizes no items, and re-verification agrees", async () => {
    const narrowedUser = await createUser("auth0|f23-narrowed");
    await addDatasetItem(narrowedUser);
    await appendConsent(narrowedUser, "granted", "model-training-v1", "all_captures");
    const broad = (await selectTrainingEligibleItems(pool)).filter(
      (i) => i.source_user_id === narrowedUser,
    );
    expect(broad).toHaveLength(1);

    // The user narrows consent to imported video only. The dataset item has no
    // capture-mode provenance, so it can no longer be shown to be covered.
    await appendConsent(narrowedUser, "granted", "model-training-v1", "imported_video");
    const narrowed = (await selectTrainingEligibleItems(pool)).filter(
      (i) => i.source_user_id === narrowedUser,
    );
    expect(narrowed).toHaveLength(0);
    expect(await verifyTrainingEligibility(pool, broad)).toHaveLength(0);

    // Widening back to all_captures restores eligibility.
    await appendConsent(narrowedUser, "granted", "model-training-v1", "all_captures");
    expect(
      (await selectTrainingEligibleItems(pool)).filter((i) => i.source_user_id === narrowedUser),
    ).toHaveLength(1);
  });

  it("I12-RT-A: eligibility snapshots are ledgered with provenance; withdrawal updates future eligibility", async () => {
    const flywheelUser = await createUser("auth0|i12-flywheel");
    await appendConsent(flywheelUser, "granted", "model-training-v2");
    const itemId = await addDatasetItem(flywheelUser, "model-training-v1");
    const items = (await selectTrainingEligibleItems(pool)).filter(
      (i) => i.source_user_id === flywheelUser,
    );
    expect(items).toHaveLength(1);
    const analysisId = "7f0a1f9a-1111-4a67-9a3d-0c0f3a1b2c3d";
    const sessionId = "7f0a1f9a-2222-4a67-9a3d-0c0f3a1b2c3d";
    expect(await recordTrainingEligibility(pool, items, { analysisId, sessionId })).toBe(1);

    const ledgered = (await latestEligibilityEntries(pool, [itemId])).get(itemId)!;
    expect(ledgered.state).toBe("eligible");
    expect(ledgered.consent_version).toBe("model-training-v2");
    expect(ledgered.consent_seq).toBe(items[0]!.grant_seq);
    expect(ledgered.analysis_id).toBe(analysisId);
    expect(ledgered.session_id).toBe(sessionId);
    expect(await isDatasetItemTrainingEligible(pool, itemId)).toBe(true);

    // Withdrawal: the consent_record trigger appends the 'withdrawn' entry;
    // no service path has to remember to do it.
    await appendConsent(flywheelUser, "withdrawn", "model-training-v2");
    const afterWithdrawal = (await latestEligibilityEntries(pool, [itemId])).get(itemId)!;
    expect(afterWithdrawal.state).toBe("withdrawn");
    expect(afterWithdrawal.analysis_id).toBe(analysisId);
    expect(await isDatasetItemTrainingEligible(pool, itemId)).toBe(false);
  });

  it("I12-RT-B: a hand-crafted item grounded in a video_analysis grant cannot be ledgered eligible", async () => {
    const analysisOnly = await createUser("auth0|i12-analysis-only");
    const subject = await pool.query(
      "INSERT INTO consent_subject (user_id) VALUES ($1) RETURNING pseudonym",
      [analysisOnly],
    );
    const pseudonym = subject.rows[0].pseudonym as string;
    const analysisGrant = await pool.query(
      `INSERT INTO consent_record
         (subject_pseudonym, scope, action, consent_version, source, capture_mode)
       VALUES ($1, 'video_analysis', 'granted', 'video-analysis-v1', 'onboarding', 'all_captures')
       RETURNING seq`,
      [pseudonym],
    );
    const itemId = await addDatasetItem(analysisOnly, "video-analysis-v1");

    // The sanctioned selector never returns the item (no training grant).
    const selected = (await selectTrainingEligibleItems(pool)).filter(
      (i) => i.source_user_id === analysisOnly,
    );
    expect(selected).toHaveLength(0);

    // A compromised caller forges the selection anyway; the DB stops it.
    const forged: TrainingEligibleItem = {
      id: itemId,
      source_user_id: analysisOnly,
      subject_pseudonym: pseudonym,
      consent_version: "video-analysis-v1",
      grant_consent_version: "video-analysis-v1",
      grant_seq: analysisGrant.rows[0].seq as string,
    };
    await expect(recordTrainingEligibility(pool, [forged])).rejects.toThrow(
      /analysis consent never implies training consent/,
    );
    expect(await isDatasetItemTrainingEligible(pool, itemId)).toBe(false);
    expect((await latestEligibilityEntries(pool, [itemId])).has(itemId)).toBe(false);
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
