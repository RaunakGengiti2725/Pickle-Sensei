import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { handleJob, processDeletionTasks, runOnce, type WorkerDeps } from "../src/worker.js";

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

describe.skipIf(!testUrl)("media worker (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let deps: WorkerDeps;
  let queue: InMemoryJobQueue;
  const deletedKeys: string[] = [];
  let userId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    queue = new InMemoryJobQueue();
    deps = {
      pool,
      queue,
      objectStore: { deleteObject: async (key) => void deletedKeys.push(key) },
      transcoder: null,
      log: () => {},
    };
    const user = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ('auth0|worker-test') RETURNING id",
    );
    userId = user.rows[0].id as string;
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  it("media.purge deletes the object and clears the key", async () => {
    const asset = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', 'media/x/abc', 'deleted', now()) RETURNING id`,
      [userId],
    );
    const outcome = await handleJob(deps, {
      id: "j1",
      kind: "media.purge",
      payload: { mediaAssetId: asset.rows[0].id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(deletedKeys).toContain("media/x/abc");
    const after = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [
      asset.rows[0].id,
    ]);
    expect(after.rows[0].object_key).toBeNull();
  });

  it("unhandled jobs stay visible on the queue — never silently dropped", async () => {
    await queue.enqueue("share.render", { shareCardId: randomUUID() });
    const result = await runOnce(deps);
    expect(result.jobs).toBe(0);
    queue.expireInFlight();
    expect(await queue.size()).toBe(1); // still there, visible backlog
  });

  it("deletion workflow completes tasks in order and hard-deletes last", async () => {
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ('auth0|todelete', 'deleted', now()) RETURNING id",
    );
    const victimId = victim.rows[0].id as string;
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1, 'raw_video', 'b', 'media/victim/clip1', 'ready')`,
      [victimId],
    );
    for (const kind of ["media_purge", "ml_dataset_review", "final_hard_delete"]) {
      await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [
        victimId,
        kind,
      ]);
    }
    // First pass: purge + review done; final may requeue until others complete.
    await processDeletionTasks(deps);
    await processDeletionTasks(deps);
    expect(deletedKeys).toContain("media/victim/clip1");
    const user = await pool.query("SELECT id FROM app_user WHERE id = $1", [victimId]);
    expect(user.rowCount).toBe(0); // hard-deleted
    const tasks = await pool.query(
      "SELECT kind, status FROM deletion_task WHERE user_id = $1 ORDER BY kind",
      [victimId],
    );
    for (const t of tasks.rows as Array<{ status: string }>) expect(t.status).toBe("done");
  });

  it("media.process without a transcoder keeps master playable and says so", async () => {
    const asset = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1, 'raw_video', 'b', 'media/x/keep', 'ready') RETURNING id`,
      [userId],
    );
    const outcome = await handleJob(deps, {
      id: "j2",
      kind: "media.process",
      payload: { mediaAssetId: asset.rows[0].id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/no transcoder/);
  });
});
