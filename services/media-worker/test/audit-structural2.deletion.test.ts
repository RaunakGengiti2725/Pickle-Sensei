import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { QueueSloMonitor } from "@pickle/slo";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import {
  deletionBacklog,
  enforceMediaRetention,
  handleJob,
  processDeletionTasks,
  runOnce,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Structural audit #2 (storage-media-worker) — adversarial scenarios against
 * a REAL PostgreSQL database in an isolated schema. Each test encodes the
 * behaviour the worker's own comments/invariants promise; a failing test is
 * a reported finding, a passing one is `verified_ok`.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `audit_s2_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  /** Keys whose deletion fails permanently (simulates a 403/network fault). */
  poison = new Set<string>();
  async deleteObject(key: string): Promise<void> {
    if (this.poison.has(key)) throw new Error(`AccessDenied deleting ${key}`);
    this.keys.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

function makeSink(): { sink: IAnalyticsSink; tracked: AnalyticsEvent[] } {
  const tracked: AnalyticsEvent[] = [];
  return {
    tracked,
    sink: { track: (event) => void tracked.push(event), flush: async () => {} },
  };
}

describe.skipIf(!testUrl)("structural audit #2: deletion workflow / sweep / retention", () => {
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

  async function newUser(tag: string): Promise<string> {
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|audit-${tag}-${randomUUID()}`,
    ]);
    return user.rows[0].id as string;
  }

  async function insertAsset(fields: {
    ownerId: string;
    objectKey: string;
    status: string;
    deleted?: boolean;
    kind?: string;
  }): Promise<string> {
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, $2, 'b', $3, $4, $5) RETURNING id`,
      [
        fields.ownerId,
        fields.kind ?? "raw_video",
        fields.objectKey,
        fields.status,
        fields.deleted ? new Date() : null,
      ],
    );
    return row.rows[0].id as string;
  }

  /** Mirrors services/api DELETE /v1/me: the exact four tasks it enqueues. */
  async function requestAccountDeletion(userId: string, createdAt?: Date): Promise<void> {
    await pool.query("UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1", [
      userId,
    ]);
    await pool.query(
      "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE owner_user_id = $1 AND deleted_at IS NULL",
      [userId],
    );
    const kinds = ["media_purge", "ml_dataset_review", "idp_revoke", "final_hard_delete"];
    for (const [i, kind] of kinds.entries()) {
      // Preserve the API's insertion order under ORDER BY created_at.
      const at = createdAt ? new Date(createdAt.getTime() + i * 10) : null;
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, $2, COALESCE($3, clock_timestamp()))",
        [userId, kind, at],
      );
    }
  }

  it("a completed account deletion leaves the deletion backlog at zero (no orphan idp_revoke row)", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = makeDeps();
    const userId = await newUser("single");
    await requestAccountDeletion(userId);

    for (let i = 0; i < 4; i++) await processDeletionTasks(deps);

    const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId]);
    expect(user.rowCount).toBe(0); // hard delete did run

    // Every task for a hard-deleted user must be terminal: the app_user row is
    // gone, so nothing can ever complete idp_revoke later, and the row is not
    // FK-bound to app_user (it survives the cascade).
    const leftovers = await pool.query(
      "SELECT kind, status, detail FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
      [userId],
    );
    expect(leftovers.rows).toEqual([]);
    const backlog = await deletionBacklog(pool);
    expect(backlog?.pending).toBe(0);
  });

  it("19 completed account deletions do not starve the 20th account's deletion (LIMIT 20 window)", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = makeDeps();
    // 19 earlier deletions, fully processed by the worker (as production would).
    const old = Date.now() - 60 * 60 * 1000;
    for (let i = 0; i < 19; i++) {
      const u = await newUser(`old-${i}`);
      await requestAccountDeletion(u, new Date(old + i * 1000));
    }
    for (let i = 0; i < 15; i++) await processDeletionTasks(deps);
    const gone = await pool.query(
      "SELECT count(*)::int AS n FROM app_user WHERE auth_subject LIKE 'auth0|audit-old-%'",
    );
    expect(gone.rows[0].n).toBe(0); // all 19 old accounts hard-deleted

    // A fresh deletion request arrives.
    const victim = await newUser("victim");
    const key = `media/audit/victim-${randomUUID()}`;
    deps.store.keys.add(key);
    await insertAsset({ ownerId: victim, objectKey: key, status: "ready" });
    await requestAccountDeletion(victim);

    // Plenty of cycles for a healthy worker: 4 tasks, dependency-ordered.
    for (let i = 0; i < 10; i++) await processDeletionTasks(deps);

    expect(deps.store.keys.has(key)).toBe(false); // media purged
    const window = await pool.query(
      `SELECT kind, count(*)::int AS n FROM (
         SELECT kind FROM deletion_task
         WHERE status IN ('queued','processing') OR (status = 'failed' AND attempts < 5)
         ORDER BY created_at LIMIT 20) w GROUP BY kind`,
    );
    const stillThere = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victim]);
    // Diagnostic in the failure message: what the worker's selection window holds.
    expect(
      stillThere.rowCount,
      `victim app_user still present; worker selection window = ${JSON.stringify(window.rows)}`,
    ).toBe(0);
  }, 60_000);

  it("sweepDeletedMedia eventually purges a deletable row even behind 50 permanently failing rows", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const owner = await newUser("sweep");
    for (let i = 0; i < 50; i++) {
      const bad = `media/audit/poison-${i}-${randomUUID()}`;
      deps.store.keys.add(bad);
      deps.store.poison.add(bad);
      await insertAsset({ ownerId: owner, objectKey: bad, status: "deleted", deleted: true });
    }
    const good = `media/audit/good-${randomUUID()}`;
    deps.store.keys.add(good);
    const goodId = await insertAsset({
      ownerId: owner,
      objectKey: good,
      status: "deleted",
      deleted: true,
    });

    let swept = 0;
    for (let i = 0; i < 5; i++) swept += await sweepDeletedMedia(deps);

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(deps.store.keys.has(good)).toBe(false);
    const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [goodId]);
    expect(row.rows[0].object_key).toBeNull();
  }, 60_000);

  it("every retention expiry is audited even when the audit insert fails transiently once", async () => {
    const owner = await newUser("retention");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertAsset({
        ownerId: owner,
        objectKey: `media/audit/exp-${i}-${randomUUID()}`,
        status: "ready",
        kind: "share_video",
      });
      await pool.query(
        "UPDATE media_asset SET expires_at = now() - interval '1 minute' WHERE id = $1",
        [id],
      );
      ids.push(id);
    }
    let failOnce = true;
    const flakyPool = {
      query: async (text: string, params?: unknown[]) => {
        if (failOnce && text.includes("INSERT INTO audit_log")) {
          failOnce = false;
          throw new Error("connection reset by peer");
        }
        return pool.query(text, params);
      },
    } as unknown as pg.Pool;
    const deps = makeDeps({ pool: flakyPool });

    await expect(enforceMediaRetention(deps)).rejects.toThrow("connection reset");
    // Next cycle: the worker retries.
    await enforceMediaRetention(deps);
    await enforceMediaRetention(deps);

    const audited = await pool.query(
      "SELECT target_id FROM audit_log WHERE action = 'media.retention_expired' AND target_id = ANY($1::text[])",
      [ids],
    );
    const deleted = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
      [ids],
    );
    expect(deleted.rows[0].n).toBe(3); // all three ARE expired…
    expect(new Set(audited.rows.map((r) => r.target_id))).toEqual(new Set(ids)); // …so all three must be audited
  });

  it("media.process for a hard-deleted asset is acked like media.purge is (no permanent poison job)", async () => {
    const { sink, tracked } = makeSink();
    const deps = makeDeps({
      transcoder: async ({ objectKey }) => ({
        normalizedKey: `${objectKey}/normalized.mp4`,
        thumbnailKey: `${objectKey}/thumb.jpg`,
      }),
      analytics: sink,
      sloMonitor: new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      }),
    });
    // Account hard-deleted (app_user cascade removed the media_asset row) while
    // its media.process job was still on the queue.
    const missing = randomUUID();
    const purgeOutcome = await handleJob(deps, {
      id: "j-purge",
      kind: "media.purge",
      payload: { mediaAssetId: missing },
      attempt: 1,
    });
    expect(purgeOutcome.handled).toBe(true); // purge path: not found → acked

    await deps.queue.enqueue("media.process", { mediaAssetId: missing });
    for (let i = 0; i < 4; i++) {
      await runOnce(deps);
      deps.queue.expireInFlight();
    }
    // Same not-found condition must not become an infinite redelivery that
    // trips the stalled-queue alert forever.
    expect(await deps.queue.size()).toBe(0);
    expect(tracked.filter((e) => e.name === "queue_stalled")).toEqual([]);
  });

  it("outside-prefix cleanup never deletes another live asset's master object", async () => {
    const deps = makeDeps();
    const owner = await newUser("prefix");
    const victimKey = `media/audit/victim-master-${randomUUID()}`;
    deps.store.keys.add(victimKey);
    const victimId = await insertAsset({ ownerId: owner, objectKey: victimKey, status: "ready" });

    const targetKey = `media/audit/target-${randomUUID()}`;
    deps.store.keys.add(targetKey);
    const targetId = await insertAsset({
      ownerId: owner,
      objectKey: targetKey,
      status: "processing",
    });

    // Misbehaving transcoder returns a key belonging to a DIFFERENT asset.
    deps.transcoder = async () => ({
      normalizedKey: victimKey,
      thumbnailKey: `${victimKey}/thumb.jpg`,
    });
    const outcome = await handleJob(deps, {
      id: "j-prefix",
      kind: "media.process",
      payload: { mediaAssetId: targetId },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    const target = await pool.query("SELECT status FROM media_asset WHERE id = $1", [targetId]);
    expect(target.rows[0].status).toBe("failed"); // target correctly failed…

    // …but the victim must be untouched: its DB row says ready, so its object
    // must still exist (otherwise it is a dangling 'ready' asset — data loss).
    const victim = await pool.query("SELECT status, object_key FROM media_asset WHERE id = $1", [
      victimId,
    ]);
    expect(victim.rows[0]).toEqual({ status: "ready", object_key: victimKey });
    expect(deps.store.keys.has(victimKey)).toBe(true);
  });

  it("deletion_task.detail does not persist raw error strings carrying paths/keys", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = makeDeps();
    const owner = await newUser("detail");
    const key = `media/audit/${owner}/user@example.com/clip.mov`;
    deps.store.keys.add(key);
    deps.store.poison.add(key);
    await insertAsset({ ownerId: owner, objectKey: key, status: "ready" });
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [
      owner,
    ]);
    await processDeletionTasks(deps);
    const task = await pool.query(
      "SELECT status, detail FROM deletion_task WHERE user_id = $1 AND kind = 'media_purge'",
      [owner],
    );
    expect(task.rows[0].status).toBe("failed");
    const detail = JSON.stringify(task.rows[0].detail);
    expect(detail).not.toContain("user@example.com");
    expect(detail).not.toContain(key);
  });

  it("concurrent workers claiming the same deletion task never double-run final_hard_delete", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = makeDeps();
    const owner = await newUser("race");
    await requestAccountDeletion(owner);
    // Two worker processes in lock-step (no FOR UPDATE SKIP LOCKED in the claim).
    for (let i = 0; i < 4; i++) {
      await Promise.all([processDeletionTasks(deps), processDeletionTasks(deps)]);
    }
    const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [owner]);
    expect(user.rowCount).toBe(0);
    const tasks = await pool.query(
      "SELECT kind, status FROM deletion_task WHERE user_id = $1 AND kind <> 'idp_revoke' ORDER BY kind",
      [owner],
    );
    expect(tasks.rows.every((r) => r.status === "done")).toBe(true);
  });
});
