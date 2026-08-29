import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  processDeletionTasks,
  runOnce,
  sweepDeletedMedia,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Wave H h21-backend-cert (Gate 10): worker behavior under failure.
 * - transient storage failure on a deletion task retries to completion
 * - permanently failing tasks stop retrying at the attempt cap, stay 'failed',
 *   and block final_hard_delete (no hard delete with data left behind)
 * - one failing object does not abort the reconciliation sweep
 * - a throwing job handler never prevents other jobs from being processed
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

describe.skipIf(!testUrl)("worker failure certification (real PostgreSQL)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  async function createUser(subject: string): Promise<string> {
    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [subject],
    );
    return rows[0].id as string;
  }

  function depsWith(overrides: Partial<WorkerDeps>): WorkerDeps {
    return {
      pool,
      queue: new InMemoryJobQueue(),
      objectStore: { deleteObject: async () => {} },
      transcoder: null,
      log: () => {},
      ...overrides,
    };
  }

  it("a transiently failing media_purge deletion task is retried and completes", async () => {
    const userId = await createUser("auth0|cert-transient");
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', 'media/cert/transient', 'deleted', now())`,
      [userId],
    );
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [
      userId,
    ]);
    let calls = 0;
    const deps = depsWith({
      objectStore: {
        deleteObject: async () => {
          calls++;
          if (calls === 1) throw new Error("storage outage (injected)");
        },
      },
    });
    await processDeletionTasks(deps);
    const failed = await pool.query(
      "SELECT status, attempts FROM deletion_task WHERE user_id = $1",
      [userId],
    );
    expect(failed.rows[0].status).toBe("failed");
    expect(failed.rows[0].attempts).toBe(1);

    // Next poll retries the failed task and it completes.
    await processDeletionTasks(deps);
    const done = await pool.query("SELECT status FROM deletion_task WHERE user_id = $1", [userId]);
    expect(done.rows[0].status).toBe("done");
  });

  it("a permanently failing task stops at the attempt cap and blocks final_hard_delete", async () => {
    const userId = await createUser("auth0|cert-permanent");
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', 'media/cert/permanent', 'deleted', now())`,
      [userId],
    );
    for (const kind of ["media_purge", "final_hard_delete"]) {
      await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [userId, kind]);
    }
    const deps = depsWith({
      objectStore: {
        deleteObject: async () => {
          throw new Error("bucket gone (injected)");
        },
      },
    });
    for (let i = 0; i < DELETION_TASK_MAX_ATTEMPTS + 3; i++) await processDeletionTasks(deps);
    const purge = await pool.query(
      "SELECT status, attempts FROM deletion_task WHERE user_id = $1 AND kind = 'media_purge'",
      [userId],
    );
    expect(purge.rows[0].status).toBe("failed");
    expect(purge.rows[0].attempts).toBe(DELETION_TASK_MAX_ATTEMPTS);
    // The user must NOT be hard-deleted while purge is incomplete.
    const user = await pool.query("SELECT id FROM app_user WHERE id = $1", [userId]);
    expect(user.rowCount).toBe(1);
    const final = await pool.query(
      "SELECT status FROM deletion_task WHERE user_id = $1 AND kind = 'final_hard_delete'",
      [userId],
    );
    expect(final.rows[0].status).not.toBe("done");
  });

  it("sweep continues past a failing object and purges the remaining rows", async () => {
    const userId = await createUser("auth0|cert-sweep");
    for (const key of ["media/cert/sweep-bad", "media/cert/sweep-ok1", "media/cert/sweep-ok2"]) {
      await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
         VALUES ($1, 'raw_video', 'b', $2, 'deleted', now())`,
        [userId, key],
      );
    }
    const deps = depsWith({
      objectStore: {
        deleteObject: async (key) => {
          if (key === "media/cert/sweep-bad") throw new Error("object locked (injected)");
        },
      },
    });
    // The sweep is global; rows left behind by earlier tests may also be
    // swept, so assert on this user's rows rather than the total count.
    const swept = await sweepDeletedMedia(deps);
    expect(swept).toBeGreaterThanOrEqual(2);
    const remaining = await pool.query(
      "SELECT object_key FROM media_asset WHERE owner_user_id = $1 AND object_key IS NOT NULL",
      [userId],
    );
    expect(remaining.rows.map((r: { object_key: string }) => r.object_key)).toEqual([
      "media/cert/sweep-bad",
    ]);
  });

  it("a throwing handler leaves the poison job visible and processes the rest", async () => {
    const queue = new InMemoryJobQueue();
    const userId = await createUser("auth0|cert-poison");
    const asset = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', 'media/cert/poison-ok', 'deleted', now()) RETURNING id`,
      [userId],
    );
    // media.process with a payload whose asset id is not a uuid → pg throws.
    await queue.enqueue("media.process", { mediaAssetId: "not-a-uuid" });
    await queue.enqueue("media.purge", { mediaAssetId: asset.rows[0].id });
    const deps = depsWith({ queue });
    const result = await runOnce(deps);
    expect(result.jobs).toBe(1); // the good job was handled and acked
    queue.expireInFlight();
    expect(await queue.size()).toBe(1); // poison job still visible
  });
});
