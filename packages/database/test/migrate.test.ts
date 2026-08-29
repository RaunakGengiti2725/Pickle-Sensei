import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { checksumOf, loadMigrations, orderMigrations, runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe("migration runner (unit)", () => {
  it("orders migrations numerically and rejects malformed names", () => {
    const ordered = orderMigrations([
      "0002_catalog_scoring.sql",
      "0001_extensions_identity.sql",
      "notes.txt",
      "9999_zz.sql.bak",
    ]);
    expect(ordered).toEqual(["0001_extensions_identity.sql", "0002_catalog_scoring.sql"]);
  });

  it("checksums are stable and content-sensitive", () => {
    expect(checksumOf("CREATE TABLE a ();")).toBe(checksumOf("CREATE TABLE a ();"));
    expect(checksumOf("CREATE TABLE a ();")).not.toBe(checksumOf("CREATE TABLE b ();"));
  });

  it("loads the committed migration set in order", async () => {
    const files = await loadMigrations(migrationsDir);
    expect(files.length).toBeGreaterThanOrEqual(6);
    expect(files[0]?.name).toBe("0001_extensions_identity.sql");
    for (const f of files) expect(f.checksum).toHaveLength(64);
  });
});

// Integration tests run only when a database is provided (DECISIONS D-009):
// they are SKIPPED — visibly, never green-washed — without DATABASE_URL_TEST.
const testUrl = process.env["DATABASE_URL_TEST"];
describe.skipIf(!testUrl)("migration runner (integration)", () => {
  it("applies all migrations and seeds on a fresh database, idempotently", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      const first = await runMigrations(pool, migrationsDir);
      expect(first.applied.length).toBeGreaterThanOrEqual(6);
      const second = await runMigrations(pool, migrationsDir);
      expect(second.applied).toHaveLength(0);
      await seed(pool);
      await seed(pool); // idempotent
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM shot_type");
      expect(rows[0]?.n).toBe(8);
      const { rows: sm } = await pool.query("SELECT count(*)::int AS n FROM scoring_model");
      expect(sm[0]?.n).toBe(8);
      const { rows: released } = await pool.query(
        "SELECT count(*)::int AS n FROM scoring_model WHERE status = 'active'",
      );
      expect(released[0]?.n).toBe(0);
    } finally {
      await pool.end();
    }
  });
});

describe.skipIf(!testUrl)("D4-09 audit remediations (integration)", () => {
  it("0016 adds the query-path and FK indexes", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      const { rows } = await pool.query<{ indexname: string }>(
        "SELECT indexname FROM pg_indexes WHERE schemaname = 'public'",
      );
      const names = new Set(rows.map((r) => r.indexname));
      for (const expected of [
        "idx_drill_checkpoint_map_shot_checkpoint",
        "idx_training_plan_source_shot",
        "idx_ml_dataset_item_source_shot",
        "idx_session_summary_best_shot",
        "idx_weekly_report_best_shot",
        "idx_share_card_shot",
        "idx_shot_analysis_job",
        "idx_shot_media_asset",
        "idx_media_asset_owner_object_key",
        "idx_deletion_task_user",
      ]) {
        expect(names.has(expected), expected).toBe(true);
      }
    } finally {
      await pool.end();
    }
  });

  it("consent_record rejects UPDATE, DELETE, and TRUNCATE", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await pool.query(
        `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
         VALUES (gen_random_uuid(), 'video_analysis', 'granted', 'v1', 'onboarding')`,
      );
      await expect(pool.query("UPDATE consent_record SET consent_version = 'v2'")).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query("DELETE FROM consent_record")).rejects.toThrow(/append-only/);
      await expect(pool.query("TRUNCATE consent_record")).rejects.toThrow(/append-only/);
      const { rows } = await pool.query("SELECT count(*)::int AS n FROM consent_record");
      expect(rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("coach_review is append-only and amendments never rewrite the base row", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await pool.query(
        `INSERT INTO coach_review (review_id, queue_item_id, coach_id, coach_credential_ref,
           schema_version, stroke_taxonomy_version, fault_taxonomy_version, drill_library_version,
           record, qualification_snapshot)
         VALUES ('item-1.coach-01', 'item-1', 'coach-01', 'cred-1', 3,
           'pickleball-stroke-taxonomy-v3', 'fault-taxonomy-v0-draft', 'drill-library-v0',
           '{"confidence": 0.8}'::jsonb, '{"coachId": "coach-01"}'::jsonb)`,
      );
      await expect(pool.query("UPDATE coach_review SET coach_id = 'coach-02'")).rejects.toThrow(
        /append-only/,
      );
      await expect(pool.query("DELETE FROM coach_review")).rejects.toThrow(/append-only/);
      await expect(pool.query("TRUNCATE coach_review CASCADE")).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          `INSERT INTO coach_review (review_id, queue_item_id, coach_id, coach_credential_ref,
             schema_version, stroke_taxonomy_version, fault_taxonomy_version, drill_library_version,
             record, qualification_snapshot)
           VALUES ('item-1.coach-01', 'item-1', 'coach-01', 'cred-1', 3,
             'pickleball-stroke-taxonomy-v3', 'fault-taxonomy-v0-draft', 'drill-library-v0',
             '{"confidence": 0.1}'::jsonb, '{"coachId": "coach-01"}'::jsonb)`,
        ),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        pool.query(
          `INSERT INTO coach_review (review_id, queue_item_id, coach_id, coach_credential_ref,
             schema_version, stroke_taxonomy_version, fault_taxonomy_version, drill_library_version,
             record, qualification_snapshot)
           VALUES ('item-2.SYNTHETIC-COACH-A', 'item-2', 'SYNTHETIC-COACH-A', 'cred-x', 3,
             'pickleball-stroke-taxonomy-v3', 'fault-taxonomy-v0-draft', 'drill-library-v0',
             '{}'::jsonb, '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/coach_review/);

      await pool.query(
        `INSERT INTO coach_review_amendment (amendment_id, review_id, revision, reason, record)
         VALUES ('item-1.coach-01.r2', 'item-1.coach-01', 2, 'rewatched at quarter speed',
           '{"confidence": 0.95}'::jsonb)`,
      );
      const { rows: base } = await pool.query<{ record: { confidence?: number } }>(
        "SELECT record FROM coach_review WHERE review_id = 'item-1.coach-01'",
      );
      expect(base[0]?.record).toEqual({ confidence: 0.8 });
      await expect(
        pool.query("UPDATE coach_review_amendment SET reason = 'edited'"),
      ).rejects.toThrow(/append-only/);
      await expect(pool.query("DELETE FROM coach_review_amendment")).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          `INSERT INTO coach_review_amendment (amendment_id, review_id, revision, reason, record)
           VALUES ('item-1.coach-01.r2', 'item-1.coach-01', 2, 'second write attempt', '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/duplicate key/);
      await expect(
        pool.query(
          `INSERT INTO coach_review_amendment (amendment_id, review_id, revision, reason, record)
           VALUES ('item-1.coach-01.r1', 'item-1.coach-01', 1, 'revision below two', '{}'::jsonb)`,
        ),
      ).rejects.toThrow(/revision/);
    } finally {
      await pool.end();
    }
  });

  it("re-seeding never rewrites a released scoring model's config", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await seed(pool);

      // Promote one seeded model to active with complete release evidence.
      const { rows: userRows } = await pool.query<{ id: string }>(
        `INSERT INTO app_user (auth_subject) VALUES ('test|releaser') RETURNING id`,
      );
      const { rows: bundleRows } = await pool.query<{ id: string }>(
        `INSERT INTO model_bundle (version, status) VALUES ('bundle-test-1', 'active') RETURNING id`,
      );
      const { rows: modelRows } = await pool.query<{ id: string }>(
        `UPDATE scoring_model SET status = 'active', model_bundle_id = $1,
           dataset_snapshot_id = 'ds-1', evaluation_report_sha256 = repeat('a', 64),
           coach_validation_reference = 'coach-ref-1', released_by = $2,
           released_at = now(), active_from = now(),
           config = '{"released": true}'::jsonb
         WHERE id = (SELECT id FROM scoring_model LIMIT 1)
         RETURNING id`,
        [bundleRows[0]?.id, userRows[0]?.id],
      );
      const releasedId = modelRows[0]?.id;
      expect(releasedId).toBeTruthy();

      await seed(pool); // must not clobber the released config
      const { rows } = await pool.query<{ config: { released?: boolean } }>(
        "SELECT config FROM scoring_model WHERE id = $1",
        [releasedId],
      );
      expect(rows[0]?.config).toEqual({ released: true });
    } finally {
      await pool.end();
    }
  });
});
