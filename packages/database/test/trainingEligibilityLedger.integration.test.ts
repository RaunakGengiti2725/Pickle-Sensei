import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";

/**
 * Wave I (i12) training-eligibility ledger, red-teamed at the schema level.
 * The invariant under attack: analysis consent (video_analysis) must NEVER
 * become training eligibility, no matter which layer is compromised. Every
 * scenario here is an attempt to smuggle analysis-consented footage into the
 * training-eligibility ledger with raw SQL — beneath the service layer.
 *
 * I12-RT-1  eligible entry citing a video_analysis grant → rejected.
 * I12-RT-2  eligible entry citing a model_training WITHDRAWAL → rejected.
 * I12-RT-3  eligible entry citing another subject's grant → rejected.
 * I12-RT-4  eligible entry citing a capture-mode-narrowed grant → rejected.
 * I12-RT-5  eligible entry claiming a different consent version than the
 *           cited grant (version-smuggling) → rejected.
 * I12-RT-6  even 'ineligible'/'withdrawn' entries cannot be grounded in a
 *           video_analysis record — analysis consent is not ledger evidence.
 * I12-RT-7  the ledger is append-only: UPDATE, DELETE, TRUNCATE all fail.
 * I12-RT-8  a model_training withdrawal auto-appends 'withdrawn' entries for
 *           every currently-eligible item; a video_analysis withdrawal
 *           appends nothing.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `elig_ledger_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

interface ConsentSeqRow {
  seq: string;
}

describe.skipIf(!testUrl)("training-eligibility ledger red team (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let pseudonym: string;
  let otherPseudonym: string;
  let datasetItemId: string;
  let analysisGrantSeq: string;
  let trainingGrantSeq: string;

  async function createSubject(subject: string): Promise<string> {
    const user = await pool.query<{ id: string }>(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [subject],
    );
    const mapped = await pool.query<{ pseudonym: string }>(
      "INSERT INTO consent_subject (user_id) VALUES ($1) RETURNING pseudonym",
      [user.rows[0]!.id],
    );
    return mapped.rows[0]!.pseudonym;
  }

  async function appendConsent(
    subjectPseudonym: string,
    scope: "video_analysis" | "model_training",
    action: "granted" | "withdrawn",
    captureMode: string | null = "all_captures",
    version = `${scope.replaceAll("_", "-")}-v1`,
  ): Promise<string> {
    const { rows } = await pool.query<ConsentSeqRow>(
      `INSERT INTO consent_record
         (subject_pseudonym, scope, action, consent_version, source, capture_mode)
       VALUES ($1, $2, $3, $4, 'mobile_settings', $5) RETURNING seq`,
      [subjectPseudonym, scope, action, version, captureMode],
    );
    return rows[0]!.seq;
  }

  async function insertEligible(
    subjectPseudonym: string,
    itemId: string,
    consentSeq: string,
    version = "model-training-v1",
  ) {
    return pool.query(
      `INSERT INTO training_eligibility_ledger
         (subject_pseudonym, dataset_item_id, consent_version, consent_seq, state, reason)
       VALUES ($1, $2, $3, $4, 'eligible', 'redteam.attempt')`,
      [subjectPseudonym, itemId, version, consentSeq],
    );
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    pseudonym = await createSubject("auth0|i12-victim");
    otherPseudonym = await createSubject("auth0|i12-other");
    datasetItemId = randomUUID();
    analysisGrantSeq = await appendConsent(pseudonym, "video_analysis", "granted");
    trainingGrantSeq = await appendConsent(pseudonym, "model_training", "granted");
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  it("I12-RT-1: an eligible entry citing a video_analysis grant is rejected by the database", async () => {
    await expect(
      insertEligible(pseudonym, datasetItemId, analysisGrantSeq, "video-analysis-v1"),
    ).rejects.toThrow(/analysis consent never implies training consent/);
  });

  it("I12-RT-2: an eligible entry citing a model_training withdrawal is rejected", async () => {
    const smuggler = await createSubject("auth0|i12-withdrawn");
    await appendConsent(smuggler, "model_training", "granted");
    const withdrawalSeq = await appendConsent(smuggler, "model_training", "withdrawn");
    await expect(insertEligible(smuggler, randomUUID(), withdrawalSeq)).rejects.toThrow(
      /cites a withdrawn record/,
    );
  });

  it("I12-RT-3: an eligible entry citing another subject's grant is rejected", async () => {
    await expect(insertEligible(otherPseudonym, randomUUID(), trainingGrantSeq)).rejects.toThrow(
      /belongs to a different subject/,
    );
  });

  it("I12-RT-4: an eligible entry citing a capture-mode-narrowed grant is rejected", async () => {
    const narrowed = await createSubject("auth0|i12-narrowed");
    const narrowedSeq = await appendConsent(
      narrowed,
      "model_training",
      "granted",
      "imported_video",
    );
    await expect(insertEligible(narrowed, randomUUID(), narrowedSeq)).rejects.toThrow(
      /capture-mode-narrowed grant/,
    );
  });

  it("I12-RT-5: an eligible entry claiming a different consent version than the grant is rejected", async () => {
    await expect(
      insertEligible(pseudonym, datasetItemId, trainingGrantSeq, "model-training-v99"),
    ).rejects.toThrow(/does not match the cited grant version/);
  });

  it("I12-RT-6: even non-eligible states cannot be grounded in a video_analysis record", async () => {
    await expect(
      pool.query(
        `INSERT INTO training_eligibility_ledger
           (subject_pseudonym, dataset_item_id, consent_version, consent_seq, state, reason)
         VALUES ($1, $2, 'video-analysis-v1', $3, 'ineligible', 'redteam.attempt')`,
        [pseudonym, datasetItemId, analysisGrantSeq],
      ),
    ).rejects.toThrow(/analysis consent never implies training consent/);
  });

  it("a valid entry citing an all_captures model_training grant appends", async () => {
    const inserted = await insertEligible(pseudonym, datasetItemId, trainingGrantSeq);
    expect(inserted.rowCount).toBe(1);
  });

  it("I12-RT-7: the eligibility ledger is append-only (UPDATE, DELETE, TRUNCATE rejected)", async () => {
    await expect(
      pool.query("UPDATE training_eligibility_ledger SET state = 'eligible'"),
    ).rejects.toThrow(/append-only/);
    await expect(pool.query("DELETE FROM training_eligibility_ledger")).rejects.toThrow(
      /append-only/,
    );
    await expect(pool.query("TRUNCATE training_eligibility_ledger")).rejects.toThrow(/append-only/);
  });

  it("I12-RT-8: a model_training withdrawal auto-appends 'withdrawn' entries; a video_analysis withdrawal appends nothing", async () => {
    // video_analysis withdrawal first: eligibility must be untouched.
    await appendConsent(pseudonym, "video_analysis", "withdrawn");
    const afterAnalysis = await pool.query(
      `SELECT state FROM training_eligibility_ledger
       WHERE dataset_item_id = $1 ORDER BY seq DESC LIMIT 1`,
      [datasetItemId],
    );
    expect(afterAnalysis.rows[0]).toEqual({ state: "eligible" });

    const withdrawalSeq = await appendConsent(pseudonym, "model_training", "withdrawn");
    const afterTraining = await pool.query(
      `SELECT state, consent_seq::text AS consent_seq, reason
       FROM training_eligibility_ledger
       WHERE dataset_item_id = $1 ORDER BY seq DESC LIMIT 1`,
      [datasetItemId],
    );
    expect(afterTraining.rows[0]).toEqual({
      state: "withdrawn",
      consent_seq: withdrawalSeq,
      reason: "consent.model_training.withdrawn",
    });

    // A second withdrawal appends nothing further: no item is 'eligible'.
    const before = await pool.query("SELECT count(*)::int AS n FROM training_eligibility_ledger");
    await appendConsent(pseudonym, "model_training", "withdrawn");
    const after = await pool.query("SELECT count(*)::int AS n FROM training_eligibility_ledger");
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
