import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { MIGRATION_LOCK_KEY, runMigrations } from "../src/migrate.js";

/**
 * Destructive role-separation suite (g11-f23): every boundary from migration
 * 0018 is exercised from the runtime login users' OWN connections — real
 * password-authenticated sessions as pickle_app / pickle_worker / pickle_ro /
 * pickle_migrator — never via SET ROLE from an admin session (the companion
 * roles.integration.test.ts covers the SET ROLE path). The schema is migrated
 * BY the migration role so the runtime roles own nothing, matching the
 * production deployment shape described in 0018.
 *
 * The login users come from infra/postgres/init-roles.sql, executed
 * idempotently here so the suite also runs against CI service containers
 * that do not mount docker-entrypoint-initdb.d.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `roles_dit_${process.pid}_${randomUUID().replaceAll("-", "")}`;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const migrationsDir = join(repoRoot, "packages", "database", "migrations");
const initRolesSql = join(repoRoot, "infra", "postgres", "init-roles.sql");

function loginUrl(user: string, password: string, extraOptions = ""): string {
  const url = new URL(testUrl!);
  url.username = user;
  url.password = password;
  url.searchParams.set("options", `-c search_path=${schemaName}${extraOptions}`);
  return url.toString();
}

const DENIED = /permission denied|must be owner|must be superuser/;

describe.skipIf(!testUrl)("consent role separation — destructive, real login users", () => {
  let adminPool: pg.Pool;
  let migratorPool: pg.Pool;
  let appPool: pg.Pool;
  let workerPool: pg.Pool;
  let roPool: pg.Pool;
  let migrationResult: { applied: string[]; skipped: string[] };
  let pseudonym: string;
  let userId: string;

  async function expectDenied(pool: pg.Pool, sql: string): Promise<void> {
    await expect(pool.query(sql)).rejects.toThrow(DENIED);
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    // Idempotent bootstrap of group roles + login users (same file docker
    // runs at initdb time), plus the one superuser-only prerequisite the
    // migrations otherwise no-op past (CREATE EXTENSION IF NOT EXISTS).
    await adminPool.query(await readFile(initRolesSql, "utf8"));
    // migrate.test.ts runs `DROP SCHEMA public CASCADE` concurrently, which
    // would take a public-schema pgcrypto with it and leave the non-superuser
    // migrator unable to recreate it mid-run. Parking the extension in its own
    // schema makes it survive; one multi-statement batch keeps it atomic.
    // (gen_random_uuid itself is a pg_catalog builtin since PostgreSQL 13, so
    // nothing resolves through the extension's schema.)
    // CREATE EXTENSION IF NOT EXISTS still races under concurrency (two
    // sessions can both pass the existence check and one hits 23505 on
    // pg_extension_name_index), so serialize against concurrent migration
    // runners using the same advisory lock key runMigrations takes.
    const extClient = await adminPool.connect();
    try {
      await extClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
      await extClient.query(
        `CREATE EXTENSION IF NOT EXISTS pgcrypto;
         CREATE SCHEMA IF NOT EXISTS pickle_ext;
         ALTER EXTENSION pgcrypto SET SCHEMA pickle_ext;`,
      );
      await extClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    } finally {
      extClient.release();
    }
    await adminPool.query(`CREATE SCHEMA ${schemaName} AUTHORIZATION pickle_migration_owner`);

    // The migrator logs in as pickle_migrator and assumes the group role for
    // the whole session, so every migrated object is owned by
    // pickle_migration_owner — runtime roles own nothing.
    migratorPool = new pg.Pool({
      connectionString: loginUrl(
        "pickle_migrator",
        "pickle_migrator_password",
        " -c role=pickle_migration_owner",
      ),
    });
    migrationResult = await runMigrations(migratorPool, migrationsDir);

    appPool = new pg.Pool({ connectionString: loginUrl("pickle_app", "pickle_app_password") });
    workerPool = new pg.Pool({
      connectionString: loginUrl("pickle_worker", "pickle_worker_password"),
    });
    roPool = new pg.Pool({ connectionString: loginUrl("pickle_ro", "pickle_ro_password") });

    // Seed through the intended path: the application runtime itself.
    const { rows } = await appPool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`roles-dit-${randomUUID()}`],
    );
    userId = rows[0].id;
    const { rows: subj } = await appPool.query(
      `INSERT INTO consent_subject (user_id) VALUES ($1)
       ON CONFLICT (user_id) DO UPDATE SET user_id = consent_subject.user_id
       RETURNING pseudonym`,
      [userId],
    );
    pseudonym = subj[0].pseudonym;
  });

  afterAll(async () => {
    await appPool?.end();
    await workerPool?.end();
    await roPool?.end();
    await migratorPool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  it("migration role runs a full legitimate migration and owns every table", async () => {
    expect(migrationResult.applied.length).toBeGreaterThanOrEqual(18);
    expect(migrationResult.applied).toContain("0018_consent_role_separation.sql");
    const { rows } = await adminPool.query(
      `SELECT DISTINCT tableowner FROM pg_tables WHERE schemaname = $1`,
      [schemaName],
    );
    expect(rows).toEqual([{ tableowner: "pickle_migration_owner" }]);
  });

  it("app runtime appends consent grant + withdrawal via the intended path and reads them back", async () => {
    await appPool.query(
      `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
       VALUES ($1, 'video_analysis', 'granted', 'v1', 'mobile_settings')`,
      [pseudonym],
    );
    await appPool.query(
      `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
       VALUES ($1, 'video_analysis', 'withdrawn', 'v1', 'privacy_center')`,
      [pseudonym],
    );
    const { rows } = await appPool.query(
      "SELECT action FROM consent_record WHERE subject_pseudonym = $1 ORDER BY seq",
      [pseudonym],
    );
    expect(rows.map((r) => r.action)).toEqual(["granted", "withdrawn"]);
  });

  it("runtime logins cannot UPDATE or DELETE consent history from their own connections", async () => {
    for (const pool of [appPool, workerPool]) {
      await expectDenied(pool, "UPDATE consent_record SET action = 'granted'");
      await expectDenied(pool, "DELETE FROM consent_record");
      await expectDenied(pool, "TRUNCATE consent_record");
      await expectDenied(pool, "DELETE FROM consent_subject");
      await expectDenied(
        pool,
        "INSERT INTO consent_subject_erasure (pseudonym) VALUES (gen_random_uuid())",
      );
      await expectDenied(pool, "UPDATE consent_subject_erasure SET erased_at = now()");
      await expectDenied(pool, "DELETE FROM consent_subject_erasure");
      await expectDenied(pool, "INSERT INTO schema_migrations (name, checksum) VALUES ('x','y')");
      await expectDenied(pool, "UPDATE schema_migrations SET checksum = 'z'");
      await expectDenied(pool, "DELETE FROM schema_migrations");
    }
  });

  it("runtime logins cannot tamper with triggers or the protected schema", async () => {
    for (const pool of [appPool, workerPool]) {
      await expectDenied(
        pool,
        "ALTER TABLE consent_record DISABLE TRIGGER trg_consent_record_append_only",
      );
      await expectDenied(pool, "ALTER TABLE consent_record DISABLE TRIGGER ALL");
      await expectDenied(pool, "DROP TRIGGER trg_consent_subject_tombstone ON consent_subject");
      await expectDenied(pool, "DROP FUNCTION consent_record_append_only()");
      await expectDenied(pool, "ALTER TABLE consent_record ADD COLUMN sneaky text");
      await expectDenied(pool, "ALTER TABLE consent_record ALTER COLUMN action DROP NOT NULL");
      await expectDenied(pool, "DROP TABLE consent_record");
      await expectDenied(pool, `CREATE TABLE ${schemaName}.not_allowed (id int)`);
      await expectDenied(pool, `ALTER SCHEMA ${schemaName} RENAME TO stolen_schema`);
    }
  });

  it("runtime logins cannot escalate privileges", async () => {
    for (const [pool, self] of [
      [appPool, "pickle_app"],
      [workerPool, "pickle_worker"],
      [roPool, "pickle_ro"],
    ] as const) {
      await expectDenied(pool, "SET ROLE pickle_migration_owner");
      await expectDenied(pool, "SET ROLE pickle_migrator");
      await expectDenied(pool, `GRANT pickle_migration_owner TO ${self}`);
      await expectDenied(pool, `ALTER ROLE ${self} SUPERUSER`);
      await expectDenied(pool, `ALTER ROLE ${self} CREATEROLE`);
      await expectDenied(pool, "CREATE ROLE sneaky_role LOGIN PASSWORD 'x'");
    }
    // App/worker must not be able to cross-assume each other's runtime role.
    await expectDenied(appPool, "SET ROLE pickle_worker_runtime");
    await expectDenied(workerPool, "SET ROLE pickle_application_runtime");
    // Self-granting table privileges must have no effect: whatever the server
    // reports (error or no-op warning), UPDATE stays denied afterwards.
    await appPool
      .query("GRANT UPDATE, DELETE ON consent_record TO pickle_app")
      .catch(() => undefined);
    const { rows } = await appPool.query(
      `SELECT has_table_privilege('pickle_app', '${schemaName}.consent_record', 'UPDATE') AS can_update,
              has_table_privilege('pickle_app', '${schemaName}.consent_record', 'DELETE') AS can_delete`,
    );
    expect(rows[0]).toEqual({ can_update: false, can_delete: false });
    await expectDenied(appPool, "UPDATE consent_record SET action = 'granted'");
  });

  it("readonly login can read but not write and cannot escalate", async () => {
    const { rows } = await roPool.query("SELECT count(*)::int AS n FROM consent_record");
    expect(rows[0].n).toBeGreaterThanOrEqual(2);
    await expectDenied(
      roPool,
      `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
       VALUES (gen_random_uuid(), 'video_analysis', 'granted', 'v1', 'support')`,
    );
    await expectDenied(roPool, "UPDATE app_user SET email = 'x@y.z'");
    await expectDenied(roPool, "DELETE FROM app_user");
    await expectDenied(roPool, "SET ROLE pickle_application_runtime");
  });

  it("export query works from the app login and returns the full appended ledger", async () => {
    // Same shape as the privacy-module export's consentLedger query.
    const { rows } = await appPool.query(
      `SELECT cr.scope, cr.action, cr.consent_version, cr.source
       FROM consent_record cr
       JOIN consent_subject cs ON cs.pseudonym = cr.subject_pseudonym
       WHERE cs.user_id = $1 ORDER BY cr.seq`,
      [userId],
    );
    expect(rows).toEqual([
      {
        scope: "video_analysis",
        action: "granted",
        consent_version: "v1",
        source: "mobile_settings",
      },
      {
        scope: "video_analysis",
        action: "withdrawn",
        consent_version: "v1",
        source: "privacy_center",
      },
    ]);
  });

  it("delete-account path works end-to-end under runtime privileges; ledger survives, mapping is tombstoned", async () => {
    // API half (app login): soft-delete, social removal, queue deletion tasks.
    await appPool.query(
      "UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1",
      [userId],
    );
    await appPool.query(
      "DELETE FROM friendship WHERE requester_user_id = $1 OR addressee_user_id = $1",
      [userId],
    );
    await appPool.query(
      "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE owner_user_id = $1 AND deleted_at IS NULL",
      [userId],
    );
    await appPool.query(
      "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'final_hard_delete')",
      [userId],
    );
    // Worker half (worker login): the final hard delete. The consent_subject
    // cascade + tombstone execute with the owner's privileges, so the worker
    // needs (and has) no direct write access to any consent table.
    await workerPool.query("DELETE FROM app_user WHERE id = $1", [userId]);

    const { rows: mapping } = await workerPool.query(
      "SELECT count(*)::int AS n FROM consent_subject WHERE pseudonym = $1",
      [pseudonym],
    );
    expect(mapping[0].n).toBe(0);
    const { rows: tomb } = await workerPool.query(
      "SELECT count(*)::int AS n FROM consent_subject_erasure WHERE pseudonym = $1",
      [pseudonym],
    );
    expect(tomb[0].n).toBe(1);
    const { rows: ledger } = await workerPool.query(
      "SELECT count(*)::int AS n FROM consent_record WHERE subject_pseudonym = $1",
      [pseudonym],
    );
    expect(ledger[0].n).toBe(2);
  });
});
