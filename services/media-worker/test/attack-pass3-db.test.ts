import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  deletionBacklog,
  handleJob,
  processDeletionTasks,
  runOnce,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Adversarial pass 3 (storage-media-worker #4) — DB-backed attacks against
 * worker.ts at 4d812e1a in an isolated PostgreSQL schema.
 *
 * Every test states the contract it attacks and whether the observed
 * behaviour HELD or is a documented finding (the assertions pin the observed
 * behaviour so a future change is deliberate).
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `attack_smw4_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

describe.skipIf(!testUrl)("attack pass 3: worker DB contracts (isolated schema)", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|attack-smw4-${randomUUID()}`,
    ]);
    userId = user.rows[0].id as string;
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

  async function insertAsset(fields: {
    objectKey: string;
    status: string;
    owner?: string;
    deleted?: boolean;
  }): Promise<string> {
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', $2, $3, $4) RETURNING id`,
      [fields.owner ?? userId, fields.objectKey, fields.status, fields.deleted ? new Date() : null],
    );
    return row.rows[0].id as string;
  }

  // ---------------------------------------------------------------------------
  // Scenario 1 — traversal-looking derived key passes the prefix contract.
  // ---------------------------------------------------------------------------
  it("S1: `${objectKey}/../elsewhere/normalized.mp4` passes startsWith — traversal-looking S3 keys are accepted (documented)", async () => {
    const key = `media/a3/trav-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "processing" });
    const traversalNormalized = `${key}/../elsewhere/normalized.mp4`;
    const traversalThumb = `${key}/../elsewhere/thumb.jpg`;
    const deps = makeDeps({
      transcoder: async () => {
        deps.store.keys.add(traversalNormalized);
        deps.store.keys.add(traversalThumb);
        return { normalizedKey: traversalNormalized, thumbnailKey: traversalThumb };
      },
    });
    deps.store.keys.add(key);
    const outcome = await handleJob(deps, {
      id: "j-s1",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    // The prefix check is a plain string-prefix contract: S3 keys are opaque
    // strings, "/../" has no traversal meaning in S3, and the key literally
    // lives under `${objectKey}/` so purge's listObjects(prefix) WILL find it.
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toBe(`normalized=${traversalNormalized} thumb=${traversalThumb}`);
    const after = await pool.query("SELECT status FROM media_asset WHERE id = $1", [id]);
    expect(after.rows[0].status).toBe("ready");
    // Purge completeness still holds for the traversal-looking derived keys.
    await pool.query(
      "UPDATE media_asset SET status = 'deleted', deleted_at = now() WHERE id = $1",
      [id],
    );
    const purge = await handleJob(deps, {
      id: "j-s1-purge",
      kind: "media.purge",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(purge.handled).toBe(true);
    expect(deps.store.keys.size).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Scenario 2 — normalizedKey === objectKey (no trailing slash).
  // ---------------------------------------------------------------------------
  it("S2: normalizedKey exactly equal to objectKey is rejected by the prefix check — BUT the rejection path deletes the MASTER object", async () => {
    const key = `media/a3/same-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "processing" });
    const deps = makeDeps({
      transcoder: async ({ objectKey }) => ({
        normalizedKey: objectKey, // no trailing slash: not under `${objectKey}/`
        thumbnailKey: `${objectKey}/thumb.jpg`,
      }),
    });
    deps.store.keys.add(key);
    deps.store.keys.add(`${key}/thumb.jpg`);
    const outcome = await handleJob(deps, {
      id: "j-s2",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/outside the master prefix/);
    const after = await pool.query("SELECT status, object_key FROM media_asset WHERE id = $1", [
      id,
    ]);
    expect(after.rows[0].status).toBe("failed");
    // FINDING: worker.ts:114-117 calls deleteObject(derived.normalizedKey)
    // unconditionally on rejection. With normalizedKey === objectKey that is
    // the master object itself: the user's original upload is destroyed while
    // the row still points at it (object_key kept, status 'failed').
    expect(deps.store.deletedKeys).toContain(key); // master deleted (observed)
    expect(deps.store.keys.has(key)).toBe(false);
    expect(after.rows[0].object_key).toBe(key); // row still claims the object exists
  });

  it("S2b: a rejected derived key equal to ANOTHER asset's master deletes that other user's master (cross-asset deletion)", async () => {
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`auth0|attack-smw4-victim-${randomUUID()}`],
    );
    const victimId = victim.rows[0].id as string;
    const victimKey = `media/a3/victim-${randomUUID()}`;
    const victimAsset = await insertAsset({
      objectKey: victimKey,
      status: "ready",
      owner: victimId,
    });
    const key = `media/a3/attacker-${randomUUID()}`;
    const id = await insertAsset({ objectKey: key, status: "processing" });
    const deps = makeDeps({
      transcoder: async () => ({
        normalizedKey: victimKey,
        thumbnailKey: `${victimKey}/thumb.jpg`,
      }),
    });
    deps.store.keys.add(key);
    deps.store.keys.add(victimKey);
    const outcome = await handleJob(deps, {
      id: "j-s2b",
      kind: "media.process",
      payload: { mediaAssetId: id },
      attempt: 1,
    });
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toMatch(/outside the master prefix/);
    // Observed: the victim's master object is gone; its row is untouched and
    // still 'ready' with the (now dangling) key.
    expect(deps.store.keys.has(victimKey)).toBe(false);
    const victimRow = await pool.query("SELECT status, object_key FROM media_asset WHERE id = $1", [
      victimAsset,
    ]);
    expect(victimRow.rows[0].status).toBe("ready");
    expect(victimRow.rows[0].object_key).toBe(victimKey);
  });

  // ---------------------------------------------------------------------------
  // Scenario 3 — two pools racing processDeletionTasks for one user.
  // ---------------------------------------------------------------------------
  it("S3: two pg.Pool instances × 20 tight iterations — DELETE FROM app_user never precedes the last purge completion", async () => {
    // DB-side ordering log: triggers stamp clock_timestamp() so the ordering
    // proof does not depend on JS timers or two connections' clocks.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attack_order_log (
        at timestamptz NOT NULL DEFAULT clock_timestamp(),
        user_id uuid NOT NULL,
        event text NOT NULL,
        note text
      );
      CREATE OR REPLACE FUNCTION attack_log_purge() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF OLD.object_key IS NOT NULL AND NEW.object_key IS NULL THEN
          INSERT INTO attack_order_log (user_id, event, note) VALUES (NEW.owner_user_id, 'purge_done', OLD.object_key);
        END IF;
        RETURN NEW;
      END $$;
      CREATE OR REPLACE FUNCTION attack_log_user_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE remaining int;
      BEGIN
        SELECT count(*) INTO remaining FROM media_asset WHERE owner_user_id = OLD.id AND object_key IS NOT NULL;
        INSERT INTO attack_order_log (user_id, event, note) VALUES (OLD.id, 'user_delete', remaining::text);
        RETURN OLD;
      END $$;
      DROP TRIGGER IF EXISTS attack_purge_log ON media_asset;
      CREATE TRIGGER attack_purge_log BEFORE UPDATE ON media_asset FOR EACH ROW EXECUTE FUNCTION attack_log_purge();
      DROP TRIGGER IF EXISTS attack_user_delete_log ON app_user;
      CREATE TRIGGER attack_user_delete_log BEFORE DELETE ON app_user FOR EACH ROW EXECUTE FUNCTION attack_log_user_delete();
    `);

    const poolA = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName), max: 4 });
    const poolB = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName), max: 4 });
    const store = new FakeStore();
    const seedValue = 0x5eed_0003;
    let state = seedValue;
    const rand = () => {
      // xorshift32 — seeded so interleavings can be replayed
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return (state >>> 0) / 0x1_0000_0000;
    };
    // Slow object store: widens the window between "purge started" and
    // "media_purge done" so a racing final_hard_delete has a chance to slip in.
    const slowStore: ObjectDeleter = {
      deleteObject: async (key) => {
        await new Promise((r) => setTimeout(r, 1 + Math.floor(rand() * 8)));
        await store.deleteObject(key);
      },
      listObjects: (prefix) => store.listObjects(prefix),
    };
    const depsA: WorkerDeps = {
      pool: poolA,
      queue: new InMemoryJobQueue(),
      objectStore: slowStore,
      transcoder: null,
      log: () => {},
    };
    const depsB: WorkerDeps = { ...depsA, pool: poolB };

    const violations: string[] = [];
    for (let iteration = 0; iteration < 20; iteration++) {
      const victim = await pool.query(
        "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id",
        [`auth0|race-${iteration}-${randomUUID()}`],
      );
      const victimId = victim.rows[0].id as string;
      const assetCount = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < assetCount; i++) {
        const key = `media/a3/race-${iteration}-${i}-${randomUUID()}`;
        store.keys.add(key);
        store.keys.add(`${key}/normalized.mp4`);
        await pool.query(
          `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
           VALUES ($1, 'raw_video', 'b', $2, 'ready')`,
          [victimId, key],
        );
      }
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge'), ($1, 'final_hard_delete')",
        [victimId],
      );
      // Tight loop: both workers hammer processDeletionTasks until the user is gone.
      const hammer = async (deps: WorkerDeps) => {
        for (let n = 0; n < 6; n++) {
          await processDeletionTasks(deps);
          if (rand() < 0.5) await new Promise((r) => setTimeout(r, Math.floor(rand() * 3)));
        }
      };
      await Promise.all([hammer(depsA), hammer(depsB)]);

      const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victimId]);
      expect(user.rowCount).toBe(0); // deletion completed
      const log = await pool.query(
        "SELECT event, note, at FROM attack_order_log WHERE user_id = $1 ORDER BY at",
        [victimId],
      );
      const rows = log.rows as Array<{ event: string; note: string; at: Date }>;
      const deletes = rows.filter((r) => r.event === "user_delete");
      const purges = rows.filter((r) => r.event === "purge_done");
      expect(deletes.length).toBeGreaterThanOrEqual(1);
      expect(purges.length).toBe(assetCount);
      const firstDelete = deletes[0]!;
      const lastPurge = purges[purges.length - 1]!;
      if (firstDelete.at.getTime() < lastPurge.at.getTime() || firstDelete.note !== "0") {
        violations.push(
          `iteration ${iteration}: user_delete at ${firstDelete.at.toISOString()} (remaining=${firstDelete.note}) before last purge at ${lastPurge.at.toISOString()}`,
        );
      }
      const tasks = await pool.query(
        "SELECT kind, status, attempts FROM deletion_task WHERE user_id = $1",
        [victimId],
      );
      for (const t of tasks.rows as Array<{ kind: string; status: string; attempts: number }>) {
        expect(t.status).toBe("done");
        expect(t.attempts).toBe(0);
      }
    }
    await poolA.end();
    await poolB.end();
    expect(violations).toEqual([]);
    // Every object the victims owned is gone from the store (no orphans).
    expect([...store.keys].filter((k) => k.includes("/race-"))).toEqual([]);
  }, 120_000);

  // ---------------------------------------------------------------------------
  // Scenario 9 — retry-exhausted task.
  // ---------------------------------------------------------------------------
  it("S9: failed task with attempts=5 is never selected again; deletion_backlog.exhausted counts it; final_hard_delete stays queued indefinitely", async () => {
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id",
      [`auth0|exhausted-${randomUUID()}`],
    );
    const victimId = victim.rows[0].id as string;
    const exhausted = await pool.query(
      `INSERT INTO deletion_task (user_id, kind, status, attempts, detail)
       VALUES ($1, 'media_purge', 'failed', $2, '{"error":"synthetic"}') RETURNING id`,
      [victimId, DELETION_TASK_MAX_ATTEMPTS],
    );
    const exhaustedId = exhausted.rows[0].id as string;
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'final_hard_delete')", [
      victimId,
    ]);
    const tracked: AnalyticsEvent[] = [];
    const sink: IAnalyticsSink = { track: (e) => void tracked.push(e), flush: async () => {} };
    const deps = makeDeps({ analytics: sink });
    // The store works now — proves the cap itself stops the retry, not a
    // still-failing store.
    deps.store.keys.add(`media/a3/never-${randomUUID()}`);

    const before = await deletionBacklog(pool);
    for (let cycle = 0; cycle < 25; cycle++) {
      await runOnce(deps);
    }
    const rows = await pool.query(
      "SELECT id, kind, status, attempts, processed_at FROM deletion_task WHERE user_id = $1 ORDER BY kind",
      [victimId],
    );
    const byKind = Object.fromEntries(
      (
        rows.rows as Array<{
          id: string;
          kind: string;
          status: string;
          attempts: number;
          processed_at: Date | null;
        }>
      ).map((r) => [r.kind, r]),
    );
    // Never re-selected: status/attempts untouched after 25 cycles.
    expect(byKind["media_purge"]!.id).toBe(exhaustedId);
    expect(byKind["media_purge"]!.status).toBe("failed");
    expect(byKind["media_purge"]!.attempts).toBe(DELETION_TASK_MAX_ATTEMPTS);
    expect(byKind["media_purge"]!.processed_at).toBeNull();
    // final_hard_delete: still queued (bounced processing→queued every cycle), user row intact.
    expect(byKind["final_hard_delete"]!.status).toBe("queued");
    expect(byKind["final_hard_delete"]!.attempts).toBe(0);
    const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victimId]);
    expect(user.rowCount).toBe(1);
    // Backlog telemetry counts it as exhausted and pending, every cycle.
    const after = await deletionBacklog(pool);
    expect(after!.exhausted).toBeGreaterThanOrEqual(1);
    expect(after!.exhausted).toBe(before!.exhausted);
    expect(after!.pending).toBeGreaterThanOrEqual(2);
    const backlogEvents = tracked.filter((e) => e.name === "deletion_backlog");
    expect(backlogEvents).toHaveLength(25);
    for (const e of backlogEvents) {
      if (e.name === "deletion_backlog") expect(e.exhausted).toBeGreaterThanOrEqual(1);
    }
  }, 60_000);

  // ---------------------------------------------------------------------------
  // Extra — ack() rejection escapes runOnce's per-job try/catch.
  // ---------------------------------------------------------------------------
  it("X1: an ack() that rejects aborts the whole runOnce cycle (later jobs + deletion tasks skipped) — the per-job catch does not cover ack", async () => {
    const key1 = `media/a3/ack1-${randomUUID()}`;
    const key2 = `media/a3/ack2-${randomUUID()}`;
    const id1 = await insertAsset({ objectKey: key1, status: "deleted", deleted: true });
    const id2 = await insertAsset({ objectKey: key2, status: "deleted", deleted: true });
    const inner = new InMemoryJobQueue();
    await inner.enqueue("media.purge", { mediaAssetId: id1 });
    await inner.enqueue("media.purge", { mediaAssetId: id2 });
    const queue: WorkerDeps["queue"] = {
      enqueue: (k, p) => inner.enqueue(k, p),
      size: () => inner.size(),
      oldestJobAgeMs: () => inner.oldestJobAgeMs(),
      receive: async (max) => {
        const batch = await inner.receive(max);
        return batch.map((entry, i) => ({
          job: entry.job,
          ack: async () => {
            if (i === 0) throw new Error("ReceiptHandleIsInvalid (synthetic stale handle)");
            await entry.ack();
          },
        }));
      },
    };
    const deps = makeDeps({ queue });
    deps.store.keys.add(key1);
    deps.store.keys.add(key2);
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id",
      [`auth0|ack-${randomUUID()}`],
    );
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'social_cleanup')", [
      victim.rows[0].id,
    ]);
    await expect(runOnce(deps)).rejects.toThrow(/ReceiptHandleIsInvalid/);
    // Observed: job 1 was purged (object gone) but the cycle died at its ack;
    // job 2 never ran, and the deletion task was not touched this cycle.
    expect(deps.store.keys.has(key1)).toBe(false);
    expect(deps.store.keys.has(key2)).toBe(true);
    const task = await pool.query("SELECT status FROM deletion_task WHERE user_id = $1", [
      victim.rows[0].id,
    ]);
    expect(task.rows[0].status).toBe("queued");
  });
});
