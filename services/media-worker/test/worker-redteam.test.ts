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
  runOnce,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Wave D3-12 red-team suite: worker crash/deletion/orphan taxonomy against a
 * REAL PostgreSQL database in an isolated schema. Deletion must be COMPLETE
 * (no orphan artifacts), deleted media must never be processed, and one
 * poison job must never take down a batch.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `worker_redteam_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

/** Synthetic object store tracking a full key inventory (orphan detection). */
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

describe.skipIf(!testUrl)("media worker red team (isolated PostgreSQL schema)", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    const user = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ('auth0|worker-redteam') RETURNING id",
    );
    userId = user.rows[0].id as string;
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
    if (adminPool) {
      await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
      await adminPool.end();
    }
  });

  function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps & {
    store: FakeStore;
    queue: InMemoryJobQueue;
  } {
    const store = new FakeStore();
    const queue = new InMemoryJobQueue();
    const deps: WorkerDeps = {
      pool,
      queue,
      objectStore: store,
      transcoder: null,
      log: () => {},
      ...overrides,
    };
    return Object.assign(deps, { store, queue }) as WorkerDeps & {
      store: FakeStore;
      queue: InMemoryJobQueue;
    };
  }

  async function insertAsset(fields: {
    objectKey: string;
    status: string;
    deleted?: boolean;
  }): Promise<string> {
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', $2, $3, $4) RETURNING id`,
      [userId, fields.objectKey, fields.status, fields.deleted ? new Date() : null],
    );
    return row.rows[0].id as string;
  }

  it("media.purge refuses to touch a LIVE asset (no nulled key, no deleted object)", async () => {
    const deps = makeDeps();
    const key = `media/rt/live-${randomUUID()}`;
    deps.store.keys.add(key);
    const id = await insertAsset({ objectKey: key, status: "ready" });
    const outcome = await handleJob(deps, {
      id: "j-live",
      kind: "media.purge",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/not deleted; purge refused/);
    expect(deps.store.keys.has(key)).toBe(true); // object untouched
    const after = await pool.query("SELECT object_key, status FROM media_asset WHERE id = $1", [
      id,
    ]);
    expect(after.rows[0].object_key).toBe(key); // key NOT nulled
    expect(after.rows[0].status).toBe("ready");
  });

  it("media.purge without an object store leaves the job visible instead of faking completion", async () => {
    const deps = makeDeps({ objectStore: null });
    const key = `media/rt/nostore-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    const outcome = await handleJob(deps, {
      id: "j-nostore",
      kind: "media.purge",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(false); // stays on the queue, visible backlog
    const after = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].object_key).toBe(key); // never nulled while the object may exist
  });

  it("media.purge removes derived artifacts under the master prefix — deletion is complete", async () => {
    const deps = makeDeps();
    const key = `media/rt/derived-${randomUUID()}`;
    deps.store.keys.add(key);
    deps.store.keys.add(`${key}/normalized.mp4`);
    deps.store.keys.add(`${key}/thumb.jpg`);
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    const outcome = await handleJob(deps, {
      id: "j-derived",
      kind: "media.purge",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(deps.store.keys.size).toBe(0); // no orphan artifacts
    const after = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].object_key).toBeNull();
  });

  it("double purge is idempotent: second run reports nothing to delete", async () => {
    const deps = makeDeps();
    const key = `media/rt/double-${randomUUID()}`;
    deps.store.keys.add(key);
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    const job = { id: "j-dd", kind: "media.purge", payload: { mediaAssetId: id }, attempt: 1 };
    const first = await handleJob(deps, job);
    expect(first.handled).toBe(true);
    const second = await handleJob(deps, { ...job, attempt: 2 });
    expect(second.handled).toBe(true);
    expect(second.note).toBe("no object to delete");
    expect(deps.store.deletedKeys.filter((k) => k === key)).toHaveLength(1);
  });

  it("media.process refuses deleted media and never resurrects its status", async () => {
    const key = `media/rt/deleted-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    const deps = makeDeps({
      transcoder: async ({ objectKey }) => ({
        normalizedKey: `${objectKey}/normalized.mp4`,
        thumbnailKey: `${objectKey}/thumb.jpg`,
      }),
    });
    const outcome = await handleJob(deps, {
      id: "j-proc-del",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/deleted; processing refused/);
    const after = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].status).toBe("deleted"); // NOT flipped back to ready

    // Same guarantee on the no-transcoder path.
    const noTranscode = makeDeps();
    await handleJob(noTranscode, {
      id: "j-proc-del2",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    const still = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
    expect(still.rows[0].status).toBe("deleted");
  });

  it("unsupported codec / corrupt file: transcoder failure marks the asset failed — typed, no crash", async () => {
    const key = `media/rt/badcodec-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "ready" });
    const deps = makeDeps({
      transcoder: async () => {
        throw new Error("unsupported codec: hevc-10bit synthetic fixture");
      },
    });
    const outcome = await handleJob(deps, {
      id: "j-codec",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/transcode failed/);
    const after = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].status).toBe("failed");
  });

  it("a poison job never takes down the batch: later jobs still run", async () => {
    const deps = makeDeps({
      transcoder: async () => {
        throw new Error("boom");
      },
    });
    // Poison payload: null payload makes the handler itself throw.
    await deps.queue.enqueue("media.purge", null);
    const key = `media/rt/batch-${randomUUID()}`;
    deps.store.keys.add(key);
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    await deps.queue.enqueue("media.purge", { mediaAssetId: id });
    const result = await runOnce(deps);
    expect(result.jobs).toBe(1); // good job processed despite the poison one
    expect(deps.store.keys.has(key)).toBe(false);
    deps.queue.expireInFlight();
    expect(await deps.queue.size()).toBe(1); // poison job visibly back on the queue
  });

  it("lost purge dispatch: the sweep still completes deletion (no orphan object)", async () => {
    const deps = makeDeps();
    const key = `media/rt/sweep-${randomUUID()}`;
    deps.store.keys.add(key);
    // deleted_at set by the API, but the purge job was never enqueued.
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    const swept = await sweepDeletedMedia(deps);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(deps.store.keys.has(key)).toBe(false);
    const after = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].object_key).toBeNull();
  });

  it("worker crash during deletion: tasks stuck in 'processing' are picked up again", async () => {
    const deps = makeDeps();
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id",
      [`auth0|crash-${randomUUID()}`],
    );
    const victimId = victim.rows[0].id as string;
    const key = `media/rt/crash-${randomUUID()}`;
    deps.store.keys.add(key);
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1, 'raw_video', 'b', $2, 'ready')`,
      [victimId, key],
    );
    // Simulate a crash mid-task: the row was already moved to 'processing'.
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1, 'media_purge', 'processing')",
      [victimId],
    );
    const processed = await processDeletionTasks(deps);
    expect(processed).toBeGreaterThanOrEqual(1);
    const task = await pool.query(
      "SELECT status FROM deletion_task WHERE user_id = $1 AND kind = 'media_purge'",
      [victimId],
    );
    expect(task.rows[0].status).toBe("done");
    expect(deps.store.keys.has(key)).toBe(false);
  });

  it("account media_purge without an object store blocks visibly instead of claiming done", async () => {
    const deps = makeDeps({ objectStore: null });
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id",
      [`auth0|blocked-${randomUUID()}`],
    );
    const victimId = victim.rows[0].id as string;
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1, 'raw_video', 'b', $2, 'ready')`,
      [victimId, `media/rt/blocked-${randomUUID()}`],
    );
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [
      victimId,
    ]);
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'final_hard_delete')", [
      victimId,
    ]);
    await processDeletionTasks(deps);
    await processDeletionTasks(deps);
    const tasks = await pool.query(
      "SELECT kind, status, detail FROM deletion_task WHERE user_id = $1 ORDER BY kind",
      [victimId],
    );
    const byKind = Object.fromEntries(
      (tasks.rows as Array<{ kind: string; status: string; detail: unknown }>).map((t) => [
        t.kind,
        t,
      ]),
    );
    expect(byKind["media_purge"]!.status).toBe("queued"); // blocked visibly
    expect(JSON.stringify(byKind["media_purge"]!.detail)).toMatch(/object store unconfigured/);
    // final hard delete must NOT proceed while objects remain in the bucket.
    expect(byKind["final_hard_delete"]!.status).toBe("queued");
    const user = await pool.query("SELECT id FROM app_user WHERE id = $1", [victimId]);
    expect(user.rowCount).toBe(1);
  });

  it("deletion mid-transcode: derived artifacts are removed and status stays deleted", async () => {
    const key = `media/rt/midtrans-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "ready" });
    const store = new FakeStore();
    store.keys.add(key);
    const deps = makeDeps({
      objectStore: store,
      transcoder: async ({ objectKey }) => {
        // The asset is deleted WHILE the transcoder is running.
        await pool.query(
          "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE id = $1",
          [id],
        );
        const normalizedKey = `${objectKey}/normalized.mp4`;
        const thumbnailKey = `${objectKey}/thumb.jpg`;
        store.keys.add(normalizedKey);
        store.keys.add(thumbnailKey);
        return { normalizedKey, thumbnailKey };
      },
    });
    const outcome = await handleJob(deps, {
      id: "j-midtrans",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/deleted mid-transcode/);
    const after = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].status).toBe("deleted"); // never resurrected
    expect(store.keys.has(`${key}/normalized.mp4`)).toBe(false); // no orphan derived artifacts
    expect(store.keys.has(`${key}/thumb.jpg`)).toBe(false);
  });

  it("transcoder emitting derived keys outside the master prefix is rejected (orphan prevention contract)", async () => {
    const key = `media/rt/prefix-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "ready" });
    const deps = makeDeps({
      transcoder: async () => ({
        normalizedKey: "elsewhere/normalized.mp4",
        thumbnailKey: "elsewhere/thumb.jpg",
      }),
    });
    const outcome = await handleJob(deps, {
      id: "j-prefix",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/outside the master prefix/);
    expect(deps.store.deletedKeys).toContain("elsewhere/normalized.mp4");
    expect(deps.store.deletedKeys).toContain("elsewhere/thumb.jpg");
    const after = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].status).toBe("failed");
  });
});
