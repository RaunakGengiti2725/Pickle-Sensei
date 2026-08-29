import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";

/**
 * Wave I (i10-hard-case-queue): the 0019 schema must make silent loss
 * impossible AT THE DATABASE — deletes rejected, truncates rejected, illegal
 * state transitions rejected, identity columns immutable, duplicate
 * fingerprints merged by constraint, and the event history append-only.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe.skipIf(!testUrl)("hard_case schema guards (real PostgreSQL)", () => {
  const pool = new pg.Pool({ connectionString: testUrl });

  beforeAll(async () => {
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
  });

  afterAll(async () => {
    await pool.end();
  });

  async function insertCase(fingerprint: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO hard_case (fingerprint, source, category, subject_key, severity)
       VALUES ($1, 'user_feedback', 'OTHER', 'rec-x', 'medium') RETURNING id`,
      [fingerprint],
    );
    return rows[0]!.id;
  }

  it("rejects duplicate fingerprints (dedup is a constraint, not a convention)", async () => {
    await insertCase("fp-dup");
    await expect(insertCase("fp-dup")).rejects.toThrow(/duplicate key/);
  });

  it("rejects DELETE and identity mutation on hard_case", async () => {
    const id = await insertCase("fp-guard");
    await expect(pool.query("DELETE FROM hard_case WHERE id = $1", [id])).rejects.toThrow(
      /never be deleted/,
    );
    await expect(
      pool.query("UPDATE hard_case SET subject_key = 'rec-y' WHERE id = $1", [id]),
    ).rejects.toThrow(/immutable/);
    await expect(pool.query("TRUNCATE hard_case CASCADE")).rejects.toThrow(/never be truncated/);
  });

  it("permits only the legal state machine transitions", async () => {
    const id = await insertCase("fp-state");
    const move = (to: string): Promise<pg.QueryResult> =>
      pool.query("UPDATE hard_case SET state = $1 WHERE id = $2", [to, id]);
    await expect(move("resolved")).rejects.toThrow(/illegal hard_case transition/);
    await move("triaged");
    await expect(move("new")).rejects.toThrow(/illegal hard_case transition/);
    await move("in-review");
    await move("resolved");
    await expect(move("in-review")).rejects.toThrow(/illegal hard_case transition/);
    await move("regression");
    await move("triaged");
  });

  it("keeps hard_case_event append-only", async () => {
    const id = await insertCase("fp-event");
    await pool.query(
      `INSERT INTO hard_case_event (hard_case_id, event_type, actor, detail)
       VALUES ($1, 'ingested', 'test', 'first report')`,
      [id],
    );
    await expect(
      pool.query("UPDATE hard_case_event SET detail = 'rewritten' WHERE hard_case_id = $1", [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query("DELETE FROM hard_case_event WHERE hard_case_id = $1", [id]),
    ).rejects.toThrow(/append-only/);
  });
});
