import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations } from "../src/migrate.js";

/**
 * Least-privilege role separation for the consent system (migration 0018):
 * the runtime roles must be able to use the intended paths (append + read)
 * and nothing else — no ledger rewrites, no trigger tampering, no schema
 * changes — independent of the trigger-level protections from 0015–0017.
 *
 * SET ROLE (rather than separate login users) keeps the suite runnable
 * against any test database whose admin user can assume the group roles
 * (local docker superuser, CI service container).
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `roles_it_${process.pid}_${randomUUID().replaceAll("-", "")}`;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

describe.skipIf(!testUrl)("consent role separation (real PostgreSQL)", () => {
  let adminPool: pg.Pool;
  let pool: pg.Pool;
  let pseudonym: string;

  async function asRole<T>(role: string, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query(`SET search_path = ${schemaName}`);
      await client.query(`SET ROLE ${role}`);
      return await fn(client);
    } finally {
      await client.query("RESET ROLE").catch(() => {});
      client.release();
    }
  }

  async function expectDenied(role: string, sql: string): Promise<void> {
    await expect(asRole(role, (c) => c.query(sql))).rejects.toThrow(
      /permission denied|must be owner/,
    );
  }

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-c search_path=${schemaName}`);
    pool = new pg.Pool({ connectionString: url.toString() });
    await runMigrations(pool, migrationsDir);

    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`roles-it-${randomUUID()}`],
    );
    const { rows: subj } = await pool.query(
      "INSERT INTO consent_subject (user_id) VALUES ($1) RETURNING pseudonym",
      [rows[0].id],
    );
    pseudonym = subj[0].pseudonym;
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool?.end();
  });

  it("creates all four group roles", async () => {
    const { rows } = await adminPool.query(
      `SELECT rolname, rolcanlogin FROM pg_roles WHERE rolname = ANY($1) ORDER BY rolname`,
      [
        [
          "pickle_application_runtime",
          "pickle_migration_owner",
          "pickle_readonly",
          "pickle_worker_runtime",
        ],
      ],
    );
    expect(rows.map((r) => r.rolname)).toEqual([
      "pickle_application_runtime",
      "pickle_migration_owner",
      "pickle_readonly",
      "pickle_worker_runtime",
    ]);
    for (const r of rows) expect(r.rolcanlogin).toBe(false);
  });

  it("application runtime can append and read the consent ledger", async () => {
    await asRole("pickle_application_runtime", async (c) => {
      await c.query(
        `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
         VALUES ($1, 'video_analysis', 'granted', 'v1', 'mobile_settings')`,
        [pseudonym],
      );
      const { rows } = await c.query(
        "SELECT scope, action FROM consent_record WHERE subject_pseudonym = $1",
        [pseudonym],
      );
      expect(rows).toEqual([{ scope: "video_analysis", action: "granted" }]);
    });
  });

  it("runtime roles cannot rewrite consent history at the privilege level", async () => {
    for (const role of ["pickle_application_runtime", "pickle_worker_runtime"]) {
      await expectDenied(role, "UPDATE consent_record SET action = 'granted'");
      await expectDenied(role, "DELETE FROM consent_record");
      await expectDenied(role, "TRUNCATE consent_record");
      await expectDenied(role, "DELETE FROM consent_subject");
      await expectDenied(
        role,
        "INSERT INTO consent_subject_erasure (pseudonym) VALUES (gen_random_uuid())",
      );
      await expectDenied(role, "UPDATE consent_subject_erasure SET erased_at = now()");
      await expectDenied(role, "DELETE FROM consent_subject_erasure");
      await expectDenied(role, "INSERT INTO schema_migrations (name, checksum) VALUES ('x', 'y')");
      await expectDenied(role, "DELETE FROM schema_migrations");
    }
  });

  it("runtime roles cannot disable triggers or alter the consent schema", async () => {
    for (const role of ["pickle_application_runtime", "pickle_worker_runtime"]) {
      await expectDenied(
        role,
        "ALTER TABLE consent_record DISABLE TRIGGER trg_consent_record_append_only",
      );
      await expectDenied(role, "ALTER TABLE consent_record ADD COLUMN sneaky text");
      await expectDenied(role, "ALTER TABLE consent_record ALTER COLUMN action DROP NOT NULL");
      await expectDenied(role, "DROP TABLE consent_record");
      await expectDenied(role, "DROP TRIGGER trg_consent_record_append_only ON consent_record");
      await expectDenied(role, "CREATE TABLE not_allowed (id int)");
    }
  });

  it("worker deletes app_user; the owner-privileged cascade tombstones the mapping", async () => {
    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`roles-it-cascade-${randomUUID()}`],
    );
    const userId = rows[0].id;
    const { rows: subj } = await pool.query(
      "INSERT INTO consent_subject (user_id) VALUES ($1) RETURNING pseudonym",
      [userId],
    );
    await asRole("pickle_worker_runtime", async (c) => {
      await c.query("DELETE FROM app_user WHERE id = $1", [userId]);
    });
    const { rows: tomb } = await pool.query(
      "SELECT count(*)::int AS n FROM consent_subject_erasure WHERE pseudonym = $1",
      [subj[0].pseudonym],
    );
    expect(tomb[0].n).toBe(1);
  });

  it("readonly can read but not write", async () => {
    await asRole("pickle_readonly", async (c) => {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM consent_record");
      expect(rows[0].n).toBeGreaterThanOrEqual(1);
    });
    await expectDenied(
      "pickle_readonly",
      `INSERT INTO consent_record (subject_pseudonym, scope, action, consent_version, source)
       VALUES (gen_random_uuid(), 'video_analysis', 'granted', 'v1', 'support')`,
    );
    await expectDenied("pickle_readonly", "UPDATE app_user SET email = 'x@y.z'");
  });

  it("default privileges cover tables created by later migrations", async () => {
    await pool.query("CREATE TABLE future_table (id int)");
    await asRole("pickle_application_runtime", async (c) => {
      await c.query("INSERT INTO future_table (id) VALUES (1)");
      const { rows } = await c.query("SELECT count(*)::int AS n FROM future_table");
      expect(rows[0].n).toBe(1);
    });
    await asRole("pickle_readonly", async (c) => {
      const { rows } = await c.query("SELECT count(*)::int AS n FROM future_table");
      expect(rows[0].n).toBe(1);
    });
    await expectDenied("pickle_readonly", "INSERT INTO future_table (id) VALUES (2)");
  });
});
