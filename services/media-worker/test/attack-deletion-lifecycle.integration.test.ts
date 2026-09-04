import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import type { S3Client } from "@aws-sdk/client-s3";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { buildObjectDeleter } from "../src/objectStore.js";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  processDeletionTasks,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";
import {
  deleteAllUnderPrefix,
  ensureBucket,
  minioClient,
  minioEndpoint,
  minioEnv,
  objectExists,
  putObject,
} from "./support/minio.js";

/**
 * Adversarial pass 3 — storage-media-worker deletion lifecycle against real
 * PostgreSQL (DATABASE_URL_TEST) and, where the scenario is about the wire,
 * real MinIO (S3_ENDPOINT_TEST).
 *  - S5: S3_MEDIA_BUCKET points at a bucket that does not exist →
 *    sweepDeletedMedia fails every row, emits media_storage_failure per row,
 *    leaves every object_key intact and RETURNS (never throws).
 *  - S6: media_purge task over 25 assets whose store fails on asset #13 →
 *    attempts++ and status failed, exactly the first 12 keys nulled, and the
 *    retry resumes on the remaining 13 (never re-touches the 12).
 *  - S7: final_hard_delete created BEFORE media_purge → final is re-queued
 *    every cycle without incrementing attempts until purge completes, then
 *    the user is hard-deleted.
 *  - Extras: sweep starvation past LIMIT 50, purge resume through the real
 *    protocol, clock-skewed created_at, concurrent workers.
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

function sink(): { events: AnalyticsEvent[]; sink: IAnalyticsSink } {
  const events: AnalyticsEvent[] = [];
  return { events, sink: { track: (e) => void events.push(e), flush: async () => {} } };
}

describe.skipIf(!testUrl)("deletion lifecycle (adversarial pass 3, real PostgreSQL)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 60_000);

  afterAll(async () => {
    await pool?.end();
  });

  async function createUser(tag: string): Promise<string> {
    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`auth0|attack-${tag}-${randomUUID()}`],
    );
    return rows[0].id as string;
  }

  async function insertAsset(
    userId: string,
    objectKey: string,
    opts: { deleted?: boolean } = {},
  ): Promise<string> {
    const { rows } = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', $2, $3, $4) RETURNING id`,
      [userId, objectKey, opts.deleted ? "deleted" : "ready", opts.deleted ? new Date() : null],
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

  async function taskRow(
    id: string,
  ): Promise<{ status: string; attempts: number; detail: unknown }> {
    const { rows } = await pool.query(
      "SELECT status, attempts, detail FROM deletion_task WHERE id = $1",
      [id],
    );
    return rows[0] as { status: string; attempts: number; detail: unknown };
  }

  async function keysNulled(userId: string): Promise<number> {
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND object_key IS NULL",
      [userId],
    );
    return rows[0].n as number;
  }

  // ───────────────────────── S5 ─────────────────────────

  describe.skipIf(!minioEndpoint)("S5: sweep against a NONEXISTENT bucket (real MinIO)", () => {
    it("every row fails, media_storage_failure fires per row, keys remain, sweep returns 0 without throwing", async () => {
      const userId = await createUser("s5");
      const ROWS = 7;
      const ids: string[] = [];
      for (let i = 0; i < ROWS; i++) {
        ids.push(await insertAsset(userId, `media/s5/${randomUUID()}`, { deleted: true }));
      }
      const ghostBucket = `attack-ghost-${randomUUID().slice(0, 8)}`;
      const store = buildObjectDeleter(minioEnv(ghostBucket));
      expect(store).not.toBeNull();
      const { events, sink: analytics } = sink();
      const logs: string[] = [];
      const deps = depsWith({ objectStore: store!, analytics, log: (l) => void logs.push(l) });

      await expect(sweepDeletedMedia(deps)).resolves.toBe(0);

      const failures = events.filter((e) => e.name === "media_storage_failure");
      expect(failures).toHaveLength(ROWS);
      for (const e of failures) {
        if (e.name === "media_storage_failure") expect(e.operation).toBe("sweep");
      }
      expect(logs.filter((l) => l.includes("NoSuchBucket"))).toHaveLength(ROWS);
      const remaining = await pool.query(
        "SELECT count(*)::int AS n FROM media_asset WHERE id = ANY($1::uuid[]) AND object_key IS NOT NULL AND deleted_at IS NOT NULL",
        [ids],
      );
      expect(remaining.rows[0].n).toBe(ROWS);

      // Rapid repeat: the rows stay eligible and the failure is re-reported, never swallowed.
      await expect(sweepDeletedMedia(deps)).resolves.toBe(0);
      expect(events.filter((e) => e.name === "media_storage_failure")).toHaveLength(ROWS * 2);

      // Fix the config (bucket now exists) and the SAME rows sweep on the next cycle.
      const client = minioClient();
      await ensureBucket(client, ghostBucket);
      await expect(sweepDeletedMedia(deps)).resolves.toBe(ROWS);
      expect(await keysNulled(userId)).toBe(ROWS);
    });
  });

  it("S5b: sweep starvation — 50 permanently failing rows ahead of 10 healthy ones: are the healthy rows ever swept?", async () => {
    // sweepDeletedMedia selects `LIMIT 50` with no ORDER BY and no per-row
    // backoff; a failing row keeps object_key set and stays in the window.
    const userId = await createUser("s5b");
    const badIds: string[] = [];
    for (let i = 0; i < 50; i++) {
      badIds.push(await insertAsset(userId, `media/s5b/bad/${i}`, { deleted: true }));
    }
    const goodIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      goodIds.push(await insertAsset(userId, `media/s5b/good/${i}`, { deleted: true }));
    }
    const attempted = new Set<string>();
    const store: ObjectDeleter = {
      deleteObject: async (key) => {
        attempted.add(key);
        if (key.includes("/bad/")) throw new Error("permanent storage denial (injected)");
      },
    };
    const deps = depsWith({ objectStore: store });
    let sweptTotal = 0;
    for (let cycle = 0; cycle < 20; cycle++) sweptTotal += await sweepDeletedMedia(deps);
    const goodLeft = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE id = ANY($1::uuid[]) AND object_key IS NOT NULL",
      [goodIds],
    );
    console.log(
      `S5b: after 20 sweeps swept=${sweptTotal} goodKeysStillSet=${goodLeft.rows[0].n} distinctKeysAttempted=${attempted.size}`,
    );
    expect(goodLeft.rows[0].n, "healthy rows starved behind 50 permanently failing rows").toBe(0);
  });

  // ───────────────────────── S6 ─────────────────────────

  it("S6: media_purge over 25 assets failing at asset #13 → attempts 1, exactly 12 keys nulled, retry resumes on the remaining 13", async () => {
    const userId = await createUser("s6");
    const assetIds: string[] = [];
    for (let i = 1; i <= 25; i++) {
      assetIds.push(await insertAsset(userId, `media/s6/${String(i).padStart(2, "0")}`));
    }
    const { rows } = await pool.query(
      "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge') RETURNING id",
      [userId],
    );
    const taskId = rows[0].id as string;

    let masterDeletes = 0;
    let arm = true;
    const deletedKeys: string[] = [];
    let failedOn: string | null = null;
    const store: ObjectDeleter = {
      listObjects: async () => [],
      deleteObject: async (key) => {
        masterDeletes++;
        if (arm && masterDeletes === 13) {
          failedOn = key;
          throw new Error("object store denied asset #13 (injected)");
        }
        deletedKeys.push(key);
      },
    };
    const deps = depsWith({ objectStore: store });

    await processDeletionTasks(deps);
    const afterFail = await taskRow(taskId);
    expect(afterFail.status).toBe("failed");
    expect(afterFail.attempts).toBe(1);
    expect(String((afterFail.detail as { error?: string }).error)).toContain("asset #13");
    expect(deletedKeys).toHaveLength(12);
    expect(await keysNulled(userId)).toBe(12);
    // The 12 nulled rows are exactly the 12 whose objects were deleted, and they are marked deleted.
    const nulled = await pool.query(
      "SELECT object_key, status, deleted_at FROM media_asset WHERE owner_user_id = $1 AND object_key IS NULL",
      [userId],
    );
    for (const r of nulled.rows as Array<{ status: string; deleted_at: Date | null }>) {
      expect(r.status).toBe("deleted");
      expect(r.deleted_at).not.toBeNull();
    }
    // Asset #13's key is still set (its delete threw before the row update).
    const thirteenth = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND object_key = $2",
      [userId, failedOn],
    );
    expect(thirteenth.rows[0].n).toBe(1);

    // Retry: the store recovers; only the remaining 13 keys are touched.
    arm = false;
    const before = deletedKeys.length;
    await processDeletionTasks(deps);
    const afterRetry = await taskRow(taskId);
    expect(afterRetry.status).toBe("done");
    expect(afterRetry.attempts).toBe(1);
    expect(deletedKeys.length - before).toBe(13);
    expect(new Set(deletedKeys).size, "a key was deleted twice across the retry").toBe(25);
    expect(await keysNulled(userId)).toBe(25);
  });

  describe.skipIf(!minioEndpoint)("S6b: the same resume through the REAL protocol (MinIO)", () => {
    it("12 objects gone after the failure, 13 remain, all 25 gone after the retry", async () => {
      const bucket = `attack-s6b-${randomUUID().slice(0, 8)}`;
      const client: S3Client = minioClient();
      await ensureBucket(client, bucket);
      const real = buildObjectDeleter(minioEnv(bucket))!;
      const userId = await createUser("s6b");
      const keys = Array.from(
        { length: 25 },
        (_, i) => `media/s6b/${String(i + 1).padStart(2, "0")}`,
      );
      for (const key of keys) {
        await putObject(client, bucket, key);
        await insertAsset(userId, key);
      }
      const { rows } = await pool.query(
        "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge') RETURNING id",
        [userId],
      );
      const taskId = rows[0].id as string;
      let masters = 0;
      let arm = true;
      const wrapped: ObjectDeleter = {
        listObjects: (prefix) => real.listObjects!(prefix),
        deleteObject: async (key) => {
          if (!key.endsWith("/")) masters++;
          if (arm && masters === 13) throw new Error("denied #13 (injected, before the wire call)");
          await real.deleteObject(key);
        },
      };
      const deps = depsWith({ objectStore: wrapped });
      await processDeletionTasks(deps);
      expect((await taskRow(taskId)).status).toBe("failed");
      const present = await Promise.all(keys.map((k) => objectExists(client, bucket, k)));
      expect(present.filter(Boolean)).toHaveLength(13);
      expect(await keysNulled(userId)).toBe(12);
      // DB and bucket agree row-by-row: a nulled key has no object; a set key still has one.
      const rowsNow = await pool.query(
        "SELECT object_key FROM media_asset WHERE owner_user_id = $1",
        [userId],
      );
      const stillSet = new Set(
        (rowsNow.rows as Array<{ object_key: string | null }>)
          .map((r) => r.object_key)
          .filter(Boolean),
      );
      keys.forEach((k, i) => expect(present[i], k).toBe(stillSet.has(k)));

      arm = false;
      await processDeletionTasks(deps);
      expect((await taskRow(taskId)).status).toBe("done");
      const after = await Promise.all(keys.map((k) => objectExists(client, bucket, k)));
      expect(after.filter(Boolean)).toHaveLength(0);
      await deleteAllUnderPrefix(client, bucket, "");
    }, 60_000);
  });

  it("S6c: ONE poison object (#13 fails on every attempt) must not block the purge of the other 24 assets", async () => {
    // media_purge aborts the whole task at the first throwing asset (no
    // per-asset continue, unlike sweepDeletedMedia). With no ORDER BY the
    // retry re-hits the poison row first, so #14..#25 are never attempted.
    const userId = await createUser("s6c");
    for (let i = 1; i <= 25; i++)
      await insertAsset(userId, `media/s6c/${String(i).padStart(2, "0")}`);
    const { rows } = await pool.query(
      "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge') RETURNING id",
      [userId],
    );
    const taskId = rows[0].id as string;
    const store: ObjectDeleter = {
      deleteObject: async (key) => {
        if (key.endsWith("/13")) throw new Error("poison object (injected)");
      },
    };
    const deps = depsWith({ objectStore: store });
    for (let i = 0; i < DELETION_TASK_MAX_ATTEMPTS + 3; i++) await processDeletionTasks(deps);
    const row = await taskRow(taskId);
    expect(row.status).toBe("failed");
    expect(row.attempts).toBe(DELETION_TASK_MAX_ATTEMPTS);
    const nulledAtCap = await keysNulled(userId);
    console.log(`S6c: at the attempt cap keysNulled=${nulledAtCap}/25 (poison=#13)`);
    // Expected: every non-poison asset purged over the retries; only #13 stays.
    expect(nulledAtCap).toBe(24);
    const left = await pool.query(
      "SELECT object_key FROM media_asset WHERE owner_user_id = $1 AND object_key IS NOT NULL",
      [userId],
    );
    expect(left.rows.map((r: { object_key: string }) => r.object_key)).toEqual(["media/s6c/13"]);
  });

  // ───────────────────────── S7 ─────────────────────────

  it("S7: final_hard_delete created BEFORE media_purge requeues each cycle without incrementing attempts until purge completes", async () => {
    const userId = await createUser("s7");
    await insertAsset(userId, `media/s7/${randomUUID()}`);
    const t0 = new Date("2026-01-01T00:00:00Z");
    const finalRow = await pool.query(
      "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'final_hard_delete', $2) RETURNING id",
      [userId, t0],
    );
    const purgeRow = await pool.query(
      "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'media_purge', $2) RETURNING id",
      [userId, new Date(t0.getTime() + 60_000)],
    );
    const finalId = finalRow.rows[0].id as string;
    const purgeId = purgeRow.rows[0].id as string;

    // Purge is blocked for the first 3 cycles (storage denies), then recovers.
    let cycle = 0;
    const store: ObjectDeleter = {
      deleteObject: async () => {
        if (cycle < 3) throw new Error(`storage denial cycle ${cycle} (injected)`);
      },
    };
    const deps = depsWith({ objectStore: store });
    for (cycle = 0; cycle < 3; cycle++) {
      await processDeletionTasks(deps);
      const final = await taskRow(finalId);
      const purge = await taskRow(purgeId);
      expect(final.status, `cycle ${cycle}`).toBe("queued");
      expect(final.attempts, `cycle ${cycle}: final attempts must not grow while waiting`).toBe(0);
      expect(purge.status, `cycle ${cycle}`).toBe("failed");
      expect(purge.attempts, `cycle ${cycle}`).toBe(cycle + 1);
      expect(await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).toMatchObject({
        rowCount: 1,
      });
    }
    // Cycle 3: final (older) runs first → still pending purge → requeued; then purge completes.
    await processDeletionTasks(deps);
    expect(await taskRow(purgeId)).toMatchObject({ status: "done", attempts: 3 });
    expect(await taskRow(finalId)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(1);
    // Cycle 4: nothing outstanding → final completes and the user row is gone.
    await processDeletionTasks(deps);
    expect(await taskRow(finalId)).toMatchObject({ status: "done", attempts: 0 });
    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(0);
  });

  it("S7b: purge exhausted at the attempt cap → final keeps requeueing forever with attempts 0 (visible, never done)", async () => {
    const userId = await createUser("s7b");
    await insertAsset(userId, `media/s7b/${randomUUID()}`);
    const t0 = new Date("2026-01-01T00:00:00Z");
    const finalId = (
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'final_hard_delete', $2) RETURNING id",
        [userId, t0],
      )
    ).rows[0].id as string;
    const purgeId = (
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'media_purge', $2) RETURNING id",
        [userId, new Date(t0.getTime() + 1)],
      )
    ).rows[0].id as string;
    const deps = depsWith({
      objectStore: {
        deleteObject: async () => {
          throw new Error("permanent denial (injected)");
        },
      },
    });
    for (let i = 0; i < DELETION_TASK_MAX_ATTEMPTS + 5; i++) await processDeletionTasks(deps);
    expect(await taskRow(purgeId)).toMatchObject({
      status: "failed",
      attempts: DELETION_TASK_MAX_ATTEMPTS,
    });
    expect(await taskRow(finalId)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(1);
  });

  it("S7c: clock skew — final_hard_delete created 1h in the FUTURE still cannot run ahead of an outstanding purge", async () => {
    const userId = await createUser("s7c");
    await insertAsset(userId, `media/s7c/${randomUUID()}`);
    const purgeId = (
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge') RETURNING id",
        [userId],
      )
    ).rows[0].id as string;
    const finalId = (
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'final_hard_delete', now() + interval '1 hour') RETURNING id",
        [userId],
      )
    ).rows[0].id as string;
    const deps = depsWith({ objectStore: null }); // purge blocked: unconfigured store
    await processDeletionTasks(deps);
    expect(await taskRow(purgeId)).toMatchObject({ status: "queued", attempts: 0 });
    expect(await taskRow(finalId)).toMatchObject({ status: "queued", attempts: 0 });
    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(1);
    // Park this user's tasks so they do not leak into later polls.
    await pool.query("UPDATE deletion_task SET status = 'done' WHERE user_id = $1", [userId]);
  });

  it("S7d: two workers polling concurrently — the deletion still completes exactly once and attempts stay honest", async () => {
    const userId = await createUser("s7d");
    for (let i = 0; i < 5; i++) await insertAsset(userId, `media/s7d/${i}`);
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, 'final_hard_delete', now() - interval '1 minute')",
      [userId],
    );
    const purgeId = (
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge') RETURNING id",
        [userId],
      )
    ).rows[0].id as string;
    const deletes: string[] = [];
    const store: ObjectDeleter = {
      deleteObject: async (key) => {
        await new Promise((r) => setTimeout(r, 5));
        deletes.push(key);
      },
    };
    const a = depsWith({ objectStore: store });
    const b = depsWith({ objectStore: store });
    await Promise.all([processDeletionTasks(a), processDeletionTasks(b)]);
    const mine = deletes.filter((k) => k.startsWith("media/s7d/"));
    console.log(
      `S7d: deleteObject calls for this user=${mine.length} distinct=${new Set(mine).size} (duplicates = both workers ran the same task)`,
    );
    expect(await taskRow(purgeId)).toMatchObject({ status: "done", attempts: 0 });
    expect(await keysNulled(userId)).toBe(5);
    expect(new Set(mine).size).toBe(5);
    // Every key was deleted at most once per worker — no runaway.
    expect(mine.length).toBeLessThanOrEqual(10);
    // Final completes on the next poll, user row gone (cascade removes media rows).
    await processDeletionTasks(a);
    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(0);
    expect(
      (
        await pool.query("SELECT 1 FROM deletion_task WHERE user_id = $1 AND status <> 'done'", [
          userId,
        ])
      ).rowCount,
    ).toBe(0);
  });
});
