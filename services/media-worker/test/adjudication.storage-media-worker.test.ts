import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue, type IJobQueue, type JobEnvelope } from "@pickle/queue";
import { QueueSloMonitor } from "@pickle/slo";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import {
  DELETION_TASK_MAX_ATTEMPTS,
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
 * Adjudication (storage-media-worker, baseline 4d812e1a): independent
 * reproductions of the confirmed findings against a REAL PostgreSQL database
 * in an isolated schema. Each test states the behaviour the worker's own
 * comments promise; at the baseline every test in this file FAILS, which is
 * the evidence. A fix is accepted when the file passes unchanged.
 *
 *   DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *     pnpm --filter @pickle/media-worker exec vitest run test/adjudication.storage-media-worker.test.ts
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `adj_smw_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  /** Keys whose deletion fails on every attempt (403 / network fault). */
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

/**
 * Minimal SQS-shaped queue: depth is unknown (-1), oldest age is unknown
 * (null) — exactly what SqsJobQueue reports — and an unacked job stays
 * invisible for `visibilityCycles` receive() calls before it reappears.
 */
class SqsLikeQueue implements IJobQueue {
  private jobs: JobEnvelope[] = [];
  private hidden: Array<{ job: JobEnvelope; until: number }> = [];
  private cycle = 0;
  private counter = 0;
  constructor(private visibilityCycles: number) {}
  async enqueue(kind: string, payload: unknown): Promise<string> {
    const id = `job-${++this.counter}`;
    this.jobs.push({ id, kind, payload, attempt: 0 });
    return id;
  }
  async receive(max: number): Promise<Array<{ job: JobEnvelope; ack: () => Promise<void> }>> {
    this.cycle++;
    const back = this.hidden.filter((h) => h.until <= this.cycle);
    this.hidden = this.hidden.filter((h) => h.until > this.cycle);
    this.jobs.push(...back.map((h) => h.job));
    const taken = this.jobs.splice(0, max);
    return taken.map((job) => {
      const withAttempt = { ...job, attempt: job.attempt + 1 };
      const entry = { job: withAttempt, until: this.cycle + this.visibilityCycles };
      this.hidden.push(entry);
      return {
        job: withAttempt,
        ack: async () => {
          this.hidden = this.hidden.filter((h) => h !== entry);
        },
      };
    });
  }
  async size(): Promise<number> {
    return -1;
  }
  async oldestJobAgeMs(): Promise<number | null> {
    return null;
  }
  get outstanding(): number {
    return this.jobs.length + this.hidden.length;
  }
}

function makeSink(): { sink: IAnalyticsSink; tracked: AnalyticsEvent[] } {
  const tracked: AnalyticsEvent[] = [];
  return {
    tracked,
    sink: { track: (event) => void tracked.push(event), flush: async () => {} },
  };
}

describe.skipIf(!testUrl)("adjudication: storage-media-worker confirmed findings", () => {
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

  function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps & { store: FakeStore } {
    const store = new FakeStore();
    const deps: WorkerDeps = {
      pool,
      queue: new InMemoryJobQueue(),
      objectStore: store,
      transcoder: null,
      log: () => {},
      ...overrides,
    };
    return Object.assign(deps, { store });
  }

  async function newUser(tag: string): Promise<string> {
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|adj-${tag}-${randomUUID()}`,
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

  /** Mirrors services/api DELETE /v1/me: the four tasks it enqueues, in order. */
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
      const at = createdAt ? new Date(createdAt.getTime() + i * 10) : null;
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, $2, COALESCE($3, clock_timestamp()))",
        [userId, kind, at],
      );
    }
  }

  // ── A: idp_revoke rows are requeued forever and fill the LIMIT 20 window ──

  it("A1: a completed account deletion leaves no non-terminal deletion_task rows (idp_revoke orphan)", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = makeDeps();
    const userId = await newUser("a1");
    await requestAccountDeletion(userId);
    for (let i = 0; i < 4; i++) await processDeletionTasks(deps);

    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(0);
    const leftovers = await pool.query(
      "SELECT kind, status FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
      [userId],
    );
    expect(leftovers.rows).toEqual([]);
    expect((await deletionBacklog(pool))?.pending ?? 0).toBe(0);
  });

  it("A2: 20 earlier completed account deletions do not starve the 21st account's deletion", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = makeDeps();
    const old = Date.now() - 3_600_000;
    for (let i = 0; i < 20; i++) {
      await requestAccountDeletion(await newUser(`a2-old-${i}`), new Date(old + i * 1000));
    }
    for (let i = 0; i < 20; i++) await processDeletionTasks(deps);
    const oldLeft = await pool.query(
      "SELECT count(*)::int AS n FROM app_user WHERE auth_subject LIKE 'auth0|adj-a2-old-%'",
    );
    expect(oldLeft.rows[0].n).toBe(0);

    const victim = await newUser("a2-victim");
    const key = `media/adj/a2-${randomUUID()}`;
    deps.store.keys.add(key);
    await insertAsset({ ownerId: victim, objectKey: key, status: "ready" });
    await requestAccountDeletion(victim);
    for (let i = 0; i < 10; i++) await processDeletionTasks(deps);

    expect(deps.store.keys.has(key), "victim media never purged").toBe(false);
    expect(
      (await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victim])).rowCount,
      "victim app_user never hard-deleted",
    ).toBe(0);
  }, 60_000);

  // ── B: rejected transcoder keys are deleted anyway ──

  it("B1: the outside-prefix rejection path never deletes the asset's own master object", async () => {
    const deps = makeDeps();
    const owner = await newUser("b1");
    const master = `media/adj/b1-${randomUUID()}`;
    deps.store.keys.add(master);
    const assetId = await insertAsset({ ownerId: owner, objectKey: master, status: "processing" });
    deps.transcoder = async ({ objectKey }) => ({
      normalizedKey: objectKey, // equal to the master: fails the `${objectKey}/` prefix check
      thumbnailKey: `${objectKey}/thumb.jpg`,
    });
    const outcome = await handleJob(deps, {
      id: "b1",
      kind: "media.process",
      payload: { mediaAssetId: assetId },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(deps.store.deletedKeys).not.toContain(master);
    expect(deps.store.keys.has(master)).toBe(true);
  });

  it("B2: the outside-prefix rejection path never deletes another live asset's master object", async () => {
    const deps = makeDeps();
    const owner = await newUser("b2");
    const victimKey = `media/adj/b2-victim-${randomUUID()}`;
    deps.store.keys.add(victimKey);
    const victimId = await insertAsset({ ownerId: owner, objectKey: victimKey, status: "ready" });
    const targetKey = `media/adj/b2-target-${randomUUID()}`;
    deps.store.keys.add(targetKey);
    const targetId = await insertAsset({
      ownerId: owner,
      objectKey: targetKey,
      status: "processing",
    });
    deps.transcoder = async () => ({
      normalizedKey: victimKey,
      thumbnailKey: `${victimKey}/thumb.jpg`,
    });
    await handleJob(deps, {
      id: "b2",
      kind: "media.process",
      payload: { mediaAssetId: targetId },
      attempt: 1,
    });
    const victim = await pool.query("SELECT status, object_key FROM media_asset WHERE id = $1", [
      victimId,
    ]);
    expect(victim.rows[0]).toEqual({ status: "ready", object_key: victimKey });
    expect(deps.store.keys.has(victimKey), "another asset's master was deleted").toBe(true);
  });

  // ── C: ack() rejection escapes runOnce and skips the rest of the cycle ──

  it("C1: an ack() that rejects does not abort runOnce; later jobs and deletion tasks still run", async () => {
    await pool.query("DELETE FROM deletion_task");
    const owner = await newUser("c1");
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'social_cleanup')", [
      owner,
    ]);
    const inner = new InMemoryJobQueue();
    await inner.enqueue("media.purge", { mediaAssetId: randomUUID() }); // acked (not found)
    await inner.enqueue("media.purge", { mediaAssetId: randomUUID() });
    let acks = 0;
    const queue: IJobQueue = {
      enqueue: (k, p) => inner.enqueue(k, p),
      size: () => inner.size(),
      oldestJobAgeMs: () => inner.oldestJobAgeMs(),
      receive: async (max) => {
        const batch = await inner.receive(max);
        return batch.map((entry, i) => ({
          job: entry.job,
          ack: async () => {
            acks++;
            if (i === 0) throw new Error("ReceiptHandleIsInvalid");
            await entry.ack();
          },
        }));
      },
    };
    const deps = makeDeps({ queue });
    let error: unknown = null;
    try {
      await runOnce(deps);
    } catch (e) {
      error = e;
    }
    expect(error, "runOnce rejected on a failing ack").toBeNull();
    expect(acks, "second job's ack never attempted").toBe(2);
    const task = await pool.query("SELECT status FROM deletion_task WHERE user_id = $1", [owner]);
    expect(task.rows[0].status, "deletion task skipped this cycle").toBe("done");
  });

  // ── D: purge paths have no per-object isolation ──

  it("D1: sweepDeletedMedia eventually purges a sweepable row behind 50 permanently failing rows", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const owner = await newUser("d1");
    for (let i = 0; i < 50; i++) {
      const bad = `media/adj/d1-poison-${i}-${randomUUID()}`;
      deps.store.keys.add(bad);
      deps.store.poison.add(bad);
      await insertAsset({ ownerId: owner, objectKey: bad, status: "deleted", deleted: true });
    }
    const good = `media/adj/d1-good-${randomUUID()}`;
    deps.store.keys.add(good);
    await insertAsset({ ownerId: owner, objectKey: good, status: "deleted", deleted: true });
    let swept = 0;
    for (let i = 0; i < 6; i++) swept += await sweepDeletedMedia(deps);
    expect(swept).toBeGreaterThanOrEqual(1);
    expect(deps.store.keys.has(good)).toBe(false);
  }, 60_000);

  it("D2: one undeletable object does not stop media_purge from purging the user's other assets", async () => {
    await pool.query("DELETE FROM deletion_task");
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const owner = await newUser("d2");
    const keys: string[] = [];
    for (let i = 0; i < 9; i++) {
      const key = `media/adj/d2-${i}-${randomUUID()}`;
      deps.store.keys.add(key);
      keys.push(key);
      await insertAsset({ ownerId: owner, objectKey: key, status: "ready" });
    }
    deps.store.poison.add(keys[4]!);
    await requestAccountDeletion(owner);
    for (let i = 0; i <= DELETION_TASK_MAX_ATTEMPTS + 2; i++) await processDeletionTasks(deps);

    const remaining = keys.filter((k) => deps.store.keys.has(k));
    expect(remaining, "healthy objects left behind by the poison one").toEqual([keys[4]]);
    const nulled = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND object_key IS NULL",
      [owner],
    );
    expect(nulled.rows[0].n).toBe(8);
  }, 60_000);

  // ── E: retention marks rows deleted before the audit row exists ──

  it("E1: every retention expiry is audited even when the audit insert fails once", async () => {
    const owner = await newUser("e1");
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await insertAsset({
        ownerId: owner,
        objectKey: `media/adj/e1-${i}-${randomUUID()}`,
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
    await enforceMediaRetention(deps);
    await enforceMediaRetention(deps);

    const deleted = await pool.query(
      "SELECT count(*)::int AS n FROM media_asset WHERE id = ANY($1::uuid[]) AND deleted_at IS NOT NULL",
      [ids],
    );
    expect(deleted.rows[0].n).toBe(3);
    const audited = await pool.query(
      "SELECT target_id FROM audit_log WHERE action = 'media.retention_expired' AND target_id = ANY($1::text[])",
      [ids],
    );
    expect(new Set(audited.rows.map((r) => r.target_id))).toEqual(new Set(ids));
  });

  // ── F: queue_stalled is blind under SQS semantics ──

  it("F1: a perpetually unhandled job trips queue_stalled when depth is unknown and visibility exceeds the poll interval", async () => {
    const { sink, tracked } = makeSink();
    const queue = new SqsLikeQueue(4);
    const deps = makeDeps({
      queue,
      analytics: sink,
      sloMonitor: new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      }),
    });
    await queue.enqueue("bogus.kind", {});
    for (let i = 0; i < 12; i++) await runOnce(deps);
    expect(queue.outstanding).toBe(1); // still poisoning the queue…
    expect(tracked.filter((e) => e.name === "queue_stalled").length).toBeGreaterThan(0);
    for (const e of tracked.filter((e) => e.name === "queue_backlog")) {
      expect((e as { depth: number }).depth).toBeGreaterThanOrEqual(0);
    }
  });

  // ── G: media.process for a vanished asset is redelivered forever ──

  it("G1: media.process for a non-existent asset is handled (acked) when a transcoder is configured", async () => {
    const deps = makeDeps({
      transcoder: async ({ objectKey }) => ({
        normalizedKey: `${objectKey}/normalized.mp4`,
        thumbnailKey: `${objectKey}/thumb.jpg`,
      }),
    });
    const outcome = await handleJob(deps, {
      id: "g1",
      kind: "media.process",
      payload: { mediaAssetId: randomUUID() },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
  });
});
