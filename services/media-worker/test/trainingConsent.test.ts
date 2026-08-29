import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import {
  hasActiveModelTrainingConsent,
  selectTrainingEligibleItems,
} from "../src/trainingConsent.js";

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `training_consent_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

describe.skipIf(!testUrl)("training consent gate (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let consentedUser: string;
  let silentUser: string;
  let withdrawnUser: string;

  async function createUser(subject: string): Promise<string> {
    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [subject],
    );
    return rows[0].id as string;
  }

  async function appendConsent(userId: string, action: "granted" | "withdrawn"): Promise<void> {
    const subject = await pool.query(
      `INSERT INTO consent_subject (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = consent_subject.user_id
       RETURNING pseudonym`,
      [userId],
    );
    await pool.query(
      `INSERT INTO consent_record
         (subject_pseudonym, scope, action, consent_version, source, capture_mode)
       VALUES ($1, 'model_training', $2, 'model-training-v1', 'mobile_settings', 'all_captures')`,
      [subject.rows[0].pseudonym, action],
    );
  }

  async function addDatasetItem(userId: string): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, consent_version)
       VALUES ($1, 'model-training-v1') RETURNING id`,
      [userId],
    );
    return rows[0].id as string;
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    consentedUser = await createUser("auth0|gate-consented");
    silentUser = await createUser("auth0|gate-silent");
    withdrawnUser = await createUser("auth0|gate-withdrawn");
    await appendConsent(consentedUser, "granted");
    await appendConsent(withdrawnUser, "granted");
    await appendConsent(withdrawnUser, "withdrawn");
    await addDatasetItem(consentedUser);
    await addDatasetItem(silentUser);
    await addDatasetItem(withdrawnUser);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  it("no consent record means NO training consent (absence is never opt-in)", async () => {
    expect(await hasActiveModelTrainingConsent(pool, silentUser)).toBe(false);
  });

  it("an explicit grant enables consent; a later withdrawal disables it", async () => {
    expect(await hasActiveModelTrainingConsent(pool, consentedUser)).toBe(true);
    expect(await hasActiveModelTrainingConsent(pool, withdrawnUser)).toBe(false);
  });

  it("selector returns only items from users with an active grant", async () => {
    const items = await selectTrainingEligibleItems(pool);
    const users = items.map((i) => i.source_user_id);
    expect(users).toContain(consentedUser);
    expect(users).not.toContain(silentUser);
    expect(users).not.toContain(withdrawnUser);
  });

  it("re-grant after withdrawal restores eligibility via the append-only ledger", async () => {
    await appendConsent(withdrawnUser, "granted");
    expect(await hasActiveModelTrainingConsent(pool, withdrawnUser)).toBe(true);
    const items = await selectTrainingEligibleItems(pool);
    expect(items.map((i) => i.source_user_id)).toContain(withdrawnUser);
  });
});
