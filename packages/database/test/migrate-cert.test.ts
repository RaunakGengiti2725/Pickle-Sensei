import { mkdtemp, readdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { loadMigrations, runMigrations } from "../src/migrate.js";
import { seed } from "../src/seed.js";

/**
 * Wave H (h21-backend-cert) migration certification:
 * - every migration applies from the state its predecessors leave behind
 *   (order dependency verified stepwise, not just as one full chain);
 * - upgrading a previous-schema database that already holds user data must
 *   not destroy or alter that data;
 * - the 0009 real-data-boundary migration's deletions are exactly its
 *   documented scope (fixture-derived rows) and its derived-table rebuild
 *   reproduces correct aggregates from surviving real data;
 * - an edited already-applied migration is rejected (checksum);
 * - two concurrent runners against one database serialize safely.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

const tempDirs: string[] = [];

async function partialDir(upTo: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pickle-mig-"));
  tempDirs.push(dir);
  const names = (await readdir(migrationsDir)).filter((n) => n.endsWith(".sql")).sort();
  for (const name of names) {
    if (name <= upTo) await copyFile(join(migrationsDir, name), join(dir, name));
  }
  return dir;
}

async function resetDb(pool: pg.Pool): Promise<void> {
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!testUrl)("migration certification (real PostgreSQL)", () => {
  it("each migration applies on top of exactly its predecessors (stepwise order)", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await resetDb(pool);
      const files = await loadMigrations(migrationsDir);
      expect(files.length).toBeGreaterThanOrEqual(17);
      for (const file of files) {
        const dir = await partialDir(file.name);
        const result = await runMigrations(pool, dir);
        // Exactly one new migration per step — no skipped dependencies.
        expect(result.applied, `step ${file.name}`).toEqual([file.name]);
      }
      // Full chain afterwards is a no-op.
      const final = await runMigrations(pool, migrationsDir);
      expect(final.applied).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  it("upgrading a previous-schema database preserves existing user data byte-for-byte", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await resetDb(pool);
      // Previous released schema: everything before the consent-era migrations.
      const prevDir = await partialDir("0014_shot_sync_payload_integrity.sql");
      await runMigrations(pool, prevDir);
      await seed(pool);

      // Production-like data at the old schema.
      const user = await pool.query<{ id: string }>(
        "INSERT INTO app_user (auth_subject, email, locale) VALUES ('auth0|cert-user', 'cert@example.com', 'en-GB') RETURNING id",
      );
      const userId = user.rows[0]!.id;
      await pool.query(
        "INSERT INTO user_profile (user_id, display_name) VALUES ($1, 'Cert User')",
        [userId],
      );
      await pool.query("INSERT INTO user_setting (user_id, cloud_sync_enabled) VALUES ($1, true)", [
        userId,
      ]);
      const media = await pool.query<{ id: string }>(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, content_type, size_bytes, status)
         VALUES ($1, 'raw_video', 'bucket', 'media/cert/obj1', 'video/mp4', 1234, 'ready') RETURNING id`,
        [userId],
      );
      await pool.query(
        "INSERT INTO user_consent (user_id, consent_type, version, granted, source) VALUES ($1, 'cloud_video_sync', 'v1', true, 'onboarding')",
        [userId],
      );
      const session = await pool.query<{ id: string }>(
        `INSERT INTO practice_session (id, user_id, mode, started_at, shot_count)
         VALUES (gen_random_uuid(), $1, 'live', now(), 1) RETURNING id`,
        [userId],
      );
      const shotType = await pool.query<{ id: string }>(
        "SELECT id FROM shot_type WHERE slug = 'serve'",
      );
      const shot = await pool.query<{ id: string }>(
        `INSERT INTO shot (id, user_id, session_id, shot_type_id, captured_at, start_ms, end_ms,
           overall_score, confidence, result_kind, source, model_bundle_version, version_vector)
         VALUES (gen_random_uuid(), $1, $2, $3, now(), 0, 900, 7.5, 0.91, 'scored', 'real', 'mb-1', '{"v":1}') RETURNING id`,
        [userId, session.rows[0]!.id, shotType.rows[0]!.id],
      );
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1, 'idp_revoke', 'queued')",
        [userId],
      );
      await pool.query(
        "INSERT INTO audit_log (actor_user_id, actor_service, action) VALUES ($1, 'api', 'cert.marker')",
        [userId],
      );

      const before = await pool.query(
        `SELECT (SELECT count(*)::int FROM app_user) AS users,
                (SELECT count(*)::int FROM media_asset) AS media,
                (SELECT count(*)::int FROM shot) AS shots,
                (SELECT count(*)::int FROM user_consent) AS consents,
                (SELECT count(*)::int FROM deletion_task) AS tasks,
                (SELECT count(*)::int FROM audit_log) AS audits`,
      );

      // Upgrade to head.
      const result = await runMigrations(pool, migrationsDir);
      expect(result.applied).toEqual([
        "0015_consent_records.sql",
        "0016_audit_indexes_consent_hardening.sql",
        "0017_consent_abuse_hardening.sql",
        "0018_coach_review_records.sql",
        "0018_consent_role_separation.sql",
        "0018_deletion_task_retry.sql",
        "0018_evaluation_telemetry.sql",
        "0019_hard_case_queue.sql",
      ]);

      const after = await pool.query(
        `SELECT (SELECT count(*)::int FROM app_user) AS users,
                (SELECT count(*)::int FROM media_asset) AS media,
                (SELECT count(*)::int FROM shot) AS shots,
                (SELECT count(*)::int FROM user_consent) AS consents,
                (SELECT count(*)::int FROM deletion_task) AS tasks,
                (SELECT count(*)::int FROM audit_log) AS audits`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]);

      const preserved = await pool.query("SELECT email, locale FROM app_user WHERE id = $1", [
        userId,
      ]);
      expect(preserved.rows[0]).toEqual({ email: "cert@example.com", locale: "en-GB" });
      const mediaRow = await pool.query(
        "SELECT object_key, status, deleted_at FROM media_asset WHERE id = $1",
        [media.rows[0]!.id],
      );
      expect(mediaRow.rows[0]).toEqual({
        object_key: "media/cert/obj1",
        status: "ready",
        deleted_at: null,
      });
      const shotRow = await pool.query(
        "SELECT overall_score, result_kind, source FROM shot WHERE id = $1",
        [shot.rows[0]!.id],
      );
      expect(shotRow.rows[0]).toEqual({
        overall_score: "7.50",
        result_kind: "scored",
        source: "real",
      });
      // Post-upgrade the API's seed remains idempotent on the migrated DB.
      await seed(pool);
      const consents = await pool.query("SELECT count(*)::int AS n FROM user_consent");
      expect(consents.rows[0]?.n).toBe(1);
    } finally {
      await pool.end();
    }
  });

  it("0009 deletes exactly its documented fixture scope and rebuilds real aggregates", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await resetDb(pool);
      const preDir = await partialDir("0008_progress_daily_nulls.sql");
      await runMigrations(pool, preDir);
      await seed(pool);

      const user = await pool.query<{ id: string }>(
        "INSERT INTO app_user (auth_subject) VALUES ('auth0|0009-cert') RETURNING id",
      );
      const userId = user.rows[0]!.id;
      const shotType = await pool.query<{ id: string }>(
        "SELECT id FROM shot_type WHERE slug = 'dink'",
      );
      const shotTypeId = shotType.rows[0]!.id;
      const model = await pool.query<{ id: string }>(
        "SELECT id FROM scoring_model WHERE shot_type_id = $1 LIMIT 1",
        [shotTypeId],
      );
      const modelId = model.rows[0]!.id;
      const session = await pool.query<{ id: string }>(
        `INSERT INTO practice_session (id, user_id, mode, started_at, shot_count, avg_score)
         VALUES (gen_random_uuid(), $1, 'live', now(), 99, 1.23) RETURNING id`,
        [userId],
      );
      const sessionId = session.rows[0]!.id;
      const insertShot = async (source: string, score: number | null) => {
        const r = await pool.query<{ id: string }>(
          `INSERT INTO shot (id, user_id, session_id, shot_type_id, scoring_model_id, captured_at,
             start_ms, end_ms, overall_score, confidence, result_kind, source,
             model_bundle_version, version_vector)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, '2026-01-05T10:00:00Z', 0, 800, $5, 0.9,
             $6, $7, 'mb-1', '{}') RETURNING id`,
          [
            userId,
            sessionId,
            shotTypeId,
            modelId,
            score,
            score === null ? "low_confidence" : "scored",
            source,
          ],
        );
        return r.rows[0]!.id;
      };
      const realScored1 = await insertShot("real", 6.0);
      const realScored2 = await insertShot("real", 8.0);
      await insertShot("real", null); // real low-confidence: preserved, excluded from rollups
      const fixtureShot = await insertShot("fixture", 9.9);
      // Stale mixed-source aggregate that 0009 must rebuild.
      await pool.query(
        `INSERT INTO progress_daily (user_id, day, shot_type_id, checkpoint_id, scoring_model_id, shot_count, avg_score, median_score, best_score)
         VALUES ($1, '2026-01-05', $2, NULL, $3, 42, 99, 99, 99)`,
        [userId, shotTypeId, modelId],
      );

      await runMigrations(pool, migrationsDir);

      // Real shots preserved; fixture shot removed (documented scope).
      const survivors = await pool.query("SELECT id FROM shot ORDER BY captured_at");
      const survivorIds = survivors.rows.map((r) => (r as { id: string }).id);
      expect(survivorIds).toContain(realScored1);
      expect(survivorIds).toContain(realScored2);
      expect(survivorIds).not.toContain(fixtureShot);
      expect(survivorIds).toHaveLength(3);

      // Rollup rebuilt from real scored shots only (scores stored ×10).
      const rollup = await pool.query(
        "SELECT shot_count, avg_score, best_score FROM progress_daily WHERE user_id = $1",
        [userId],
      );
      expect(rollup.rows).toHaveLength(1);
      expect(rollup.rows[0]).toMatchObject({ shot_count: 2 });
      expect(Number((rollup.rows[0] as { avg_score: string }).avg_score)).toBeCloseTo(70);
      expect(Number((rollup.rows[0] as { best_score: string }).best_score)).toBeCloseTo(80);

      // Session counters recomputed from surviving real shots.
      const sess = await pool.query(
        "SELECT shot_count, avg_score FROM practice_session WHERE id = $1",
        [sessionId],
      );
      expect((sess.rows[0] as { shot_count: number }).shot_count).toBe(3);
      expect(Number((sess.rows[0] as { avg_score: string }).avg_score)).toBeCloseTo(7);
    } finally {
      await pool.end();
    }
  });

  it("rejects an already-applied migration whose file was edited (checksum)", async () => {
    const pool = new pg.Pool({ connectionString: testUrl });
    try {
      await resetDb(pool);
      const dir = await mkdtemp(join(tmpdir(), "pickle-mig-tamper-"));
      tempDirs.push(dir);
      await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE cert_tamper (id int);");
      await runMigrations(pool, dir);
      await writeFile(join(dir, "0001_a.sql"), "CREATE TABLE cert_tamper (id bigint);");
      await expect(runMigrations(pool, dir)).rejects.toThrow(/checksum mismatch/);
    } finally {
      await pool.end();
    }
  });

  it("two concurrent runners serialize on the advisory lock; every migration applies exactly once", async () => {
    const poolA = new pg.Pool({ connectionString: testUrl });
    const poolB = new pg.Pool({ connectionString: testUrl });
    try {
      await poolA.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      const [a, b] = await Promise.all([
        runMigrations(poolA, migrationsDir),
        runMigrations(poolB, migrationsDir),
      ]);
      const files = await loadMigrations(migrationsDir);
      expect(a.applied.length + b.applied.length).toBe(files.length);
      const { rows } = await poolA.query(
        "SELECT count(*)::int AS n, count(DISTINCT name)::int AS d FROM schema_migrations",
      );
      expect(rows[0]).toEqual({ n: files.length, d: files.length });
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });
});
