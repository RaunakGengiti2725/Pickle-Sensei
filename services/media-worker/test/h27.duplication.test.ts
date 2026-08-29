import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  handleJob,
  processDeletionTasks,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Wave H h27 red team — queue duplication. The queue is at-least-once, so
 * every handler must tolerate redelivery, concurrent workers, and duplicated
 * task rows. In particular a duplicated final_hard_delete must not leave the
 * account deletion workflow waiting on itself forever.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `h27_dup_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

class FakeStore implements ObjectDeleter {
  keys = new Set<string>();
  deletedKeys: string[] = [];
  async deleteObject(key: string): Promise<void> {
    this.keys.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

describe.skipIf(!testUrl)("h27 queue duplication regressions", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  function makeDeps(store: FakeStore): WorkerDeps {
    return {
      pool,
      queue: new InMemoryJobQueue(),
      objectStore: store,
      transcoder: null,
      log: () => {},
    };
  }

  async function makeUser(): Promise<string> {
    const row = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|h27-dup-${randomUUID()}`,
    ]);
    return row.rows[0].id as string;
  }

  it("redelivered and concurrent media.purge jobs delete each object exactly once", async () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    const userId = await makeUser();
    const key = `media/dup/${randomUUID()}`;
    store.keys.add(key);
    store.keys.add(`${key}/thumb.jpg`);
    const asset = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1,'raw_video','b',$2,'deleted', now()) RETURNING id`,
      [userId, key],
    );
    const job = {
      id: "dup-purge",
      kind: "media.purge",
      payload: { mediaAssetId: asset.rows[0].id as string },
      receivedCount: 1,
    } as never;

    const outcomes = [await handleJob(deps, job), await handleJob(deps, job)];
    outcomes.push(...(await Promise.all([handleJob(deps, job), handleJob(deps, job)])));

    expect(outcomes.every((o) => o.handled)).toBe(true);
    expect(store.keys.size).toBe(0);
    expect(store.deletedKeys).toHaveLength(2);
    expect(new Set(store.deletedKeys).size).toBe(2);
  });

  it("duplicated final_hard_delete rows still complete the deletion", async () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    const userId = await makeUser();
    for (let i = 0; i < 3; i++) {
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1,'final_hard_delete','queued')",
        [userId],
      );
    }

    await processDeletionTasks(deps);

    const remaining = await pool.query("SELECT count(*)::int AS n FROM app_user WHERE id = $1", [
      userId,
    ]);
    expect(remaining.rows[0].n).toBe(0);
    const stuck = await pool.query(
      "SELECT count(*)::int AS n FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
      [userId],
    );
    expect(stuck.rows[0].n).toBe(0);
  });

  it("a duplicated final_hard_delete never runs ahead of outstanding work", async () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    const userId = await makeUser();
    // No object store for this sweep: media_purge must stay blocked, and the
    // duplicated hard-delete rows must wait for it rather than wiping the user
    // while objects are still in the bucket.
    const blocked: WorkerDeps = { ...deps, objectStore: null };
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1,'raw_video','b',$2,'ready')`,
      [userId, `media/dup-block/${randomUUID()}`],
    );
    for (const kind of ["media_purge", "final_hard_delete", "final_hard_delete"]) {
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1,$2,'queued')",
        [userId, kind],
      );
    }

    await processDeletionTasks(blocked);

    const remaining = await pool.query("SELECT count(*)::int AS n FROM app_user WHERE id = $1", [
      userId,
    ]);
    expect(remaining.rows[0].n).toBe(1);
    const purge = await pool.query(
      "SELECT status, detail FROM deletion_task WHERE user_id = $1 AND kind = 'media_purge'",
      [userId],
    );
    expect(purge.rows[0].status).toBe("queued");
    expect((purge.rows[0].detail as { blocked?: string }).blocked).toBe(
      "object store unconfigured",
    );
  });

  it("concurrent workers sweeping one user's tasks converge on a complete deletion", async () => {
    const store = new FakeStore();
    const deps = makeDeps(store);
    const userId = await makeUser();
    const key = `media/dup-conc/${randomUUID()}`;
    store.keys.add(key);
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1,'raw_video','b',$2,'ready')`,
      [userId, key],
    );
    for (const kind of [
      "media_purge",
      "ml_dataset_review",
      "social_cleanup",
      "final_hard_delete",
    ]) {
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1,$2,'queued')",
        [userId, kind],
      );
    }

    await Promise.all([processDeletionTasks(deps), processDeletionTasks(deps)]);

    const remaining = await pool.query("SELECT count(*)::int AS n FROM app_user WHERE id = $1", [
      userId,
    ]);
    expect(remaining.rows[0].n).toBe(0);
    expect(store.keys.size).toBe(0);
    const notDone = await pool.query(
      "SELECT count(*)::int AS n FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
      [userId],
    );
    expect(notDone.rows[0].n).toBe(0);
  });
});
