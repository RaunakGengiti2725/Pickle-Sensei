import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  deletionBacklog,
  enforceMediaRetention,
  handleJob,
  processDeletionTasks,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Structural audit #1 (storage-media-worker): deletion-workflow and
 * reconciliation-sweep reproducers against a REAL PostgreSQL database in an
 * isolated schema. Each `it` pins one contract the worker claims; a failing
 * test here is a reproduced finding, a passing one is a verified invariant.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `audit_s1_del_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  /** Keys whose deletion permanently fails (storage-side denial). */
  failing = new Set<string>();
  async deleteObject(key: string): Promise<void> {
    if (this.failing.has(key)) {
      throw new Error(
        `AccessDenied deleting s3://pickle-media-prod/${key} via storage.internal.example`,
      );
    }
    this.keys.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

describe.skipIf(!testUrl)(
  "audit-structural1: deletion workflow (isolated PostgreSQL schema)",
  () => {
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

    async function newUser(tag: string): Promise<string> {
      const row = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
        `auth0|audit-s1-${tag}-${randomUUID()}`,
      ]);
      return row.rows[0].id as string;
    }

    async function insertTask(
      userId: string,
      kind: string,
      createdAt: Date,
      status = "queued",
    ): Promise<string> {
      const row = await pool.query(
        "INSERT INTO deletion_task (user_id, kind, status, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
        [userId, kind, status, createdAt],
      );
      return row.rows[0].id as string;
    }

    async function insertAsset(
      ownerId: string,
      objectKey: string,
      opts: { deleted?: boolean; kind?: string; status?: string } = {},
    ): Promise<string> {
      const row = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, $2, 'b', $3, $4, $5) RETURNING id`,
        [
          ownerId,
          opts.kind ?? "raw_video",
          objectKey,
          opts.status ?? (opts.deleted ? "deleted" : "ready"),
          opts.deleted ? new Date() : null,
        ],
      );
      return row.rows[0].id as string;
    }

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

    async function taskStatus(
      id: string,
    ): Promise<{ status: string; attempts: number; detail: unknown }> {
      const row = await pool.query(
        "SELECT status, attempts, detail FROM deletion_task WHERE id = $1",
        [id],
      );
      return row.rows[0] as { status: string; attempts: number; detail: unknown };
    }

    it("HOTSPOT idp_revoke: 20 permanently-blocked older tasks must not starve a newer user's deletion", async () => {
      // Every account deletion (services/api privacy route) enqueues an
      // idp_revoke task that the worker re-queues forever ("idp credentials
      // not configured"). processDeletionTasks selects `ORDER BY created_at
      // LIMIT 20`, so once 20 such rows exist every newer task is invisible.
      await pool.query("DELETE FROM deletion_task");
      const old = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      for (let i = 0; i < 20; i++) {
        const uid = await newUser(`blocked-${i}`);
        await insertTask(uid, "idp_revoke", new Date(old.getTime() + i * 1000));
      }
      const victim = await newUser("victim");
      const social = await insertTask(victim, "social_cleanup", new Date());
      const final = await insertTask(victim, "final_hard_delete", new Date(Date.now() + 1));

      const deps = makeDeps();
      for (let cycle = 0; cycle < 5; cycle++) await processDeletionTasks(deps);

      expect((await taskStatus(social)).status).toBe("done");
      expect((await taskStatus(final)).status).toBe("done");
      const user = await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victim]);
      expect(user.rowCount).toBe(0);
    }, 60_000);

    it("HOTSPOT idp_revoke: deletion_backlog returns to zero once an account's hard delete completed", async () => {
      // With the account hard-deleted (app_user gone, deletion_task.user_id has
      // no FK), the orphan idp_revoke row is re-queued on every cycle forever:
      // `pending` never returns to 0 and `oldestAgeSeconds` grows unboundedly,
      // so the deletion_backlog SLO signal is permanently non-zero.
      await pool.query("DELETE FROM deletion_task");
      const uid = await newUser("orphan");
      const idp = await insertTask(uid, "idp_revoke", new Date(Date.now() - 2000));
      const final = await insertTask(uid, "final_hard_delete", new Date(Date.now() - 1000));
      const deps = makeDeps();
      await processDeletionTasks(deps);
      await processDeletionTasks(deps);
      expect((await taskStatus(final)).status).toBe("done");
      expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [uid])).rowCount).toBe(0);

      const backlog = await deletionBacklog(pool);
      expect(backlog).not.toBeNull();
      // The account is fully erased: nothing is pending for a human.
      expect(backlog!.pending).toBe(0);
      expect((await taskStatus(idp)).status).not.toBe("queued");
    });

    it("HOTSPOT sweep starvation: a sweepable row behind 50 permanently-failing rows is eventually swept", async () => {
      // sweepDeletedMedia selects `LIMIT 50` with no ORDER BY and never mutates
      // a failing row, so the same 50 failing rows are returned on every cycle
      // and any row beyond them is never reconciled.
      await pool.query("DELETE FROM media_asset");
      const owner = await newUser("sweep");
      const deps = makeDeps();
      for (let i = 0; i < 50; i++) {
        const key = `${owner}/failing-${i}.mov`;
        deps.store.keys.add(key);
        deps.store.failing.add(key);
        await insertAsset(owner, key, { deleted: true });
      }
      const goodKey = `${owner}/good.mov`;
      deps.store.keys.add(goodKey);
      const goodId = await insertAsset(owner, goodKey, { deleted: true });

      for (let cycle = 0; cycle < 5; cycle++) await sweepDeletedMedia(deps);

      const row = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [goodId]);
      expect(row.rows[0].object_key).toBeNull();
      expect(deps.store.keys.has(goodKey)).toBe(false);
    }, 60_000);

    it("HOTSPOT detail redaction: deletion_task.detail must not persist raw storage errors (keys/hostnames)", async () => {
      await pool.query("DELETE FROM deletion_task");
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("detail");
      const key = `${uid}/private-clip-7f3a.mov`;
      const deps = makeDeps();
      deps.store.keys.add(key);
      deps.store.failing.add(key);
      await insertAsset(uid, key, { deleted: true });
      const task = await insertTask(uid, "media_purge", new Date());
      await processDeletionTasks(deps);
      const after = await taskStatus(task);
      expect(after.status).toBe("failed");
      expect(after.attempts).toBe(1);
      const detail = JSON.stringify(after.detail);
      expect(detail).not.toContain(key);
      expect(detail).not.toContain("storage.internal.example");
      expect(detail).not.toContain("pickle-media-prod");
    });

    it("HOTSPOT claim without lock: two concurrent workers must not double-count a task's attempts", async () => {
      // A plain `UPDATE ... SET status='processing'` claims nothing: two
      // workers that both selected the row each run the handler, and each
      // failure increments `attempts`. The 5-attempt cap is then reached after
      // ~3 real cycles, and a transient outage exhausts the retry budget twice
      // as fast as documented.
      await pool.query("DELETE FROM deletion_task");
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("concurrent");
      const key = `${uid}/clip.mov`;
      const store = new FakeStore();
      store.keys.add(key);
      store.failing.add(key);
      await insertAsset(uid, key, { deleted: true });
      const task = await insertTask(uid, "media_purge", new Date());
      const a = makeDeps({ objectStore: store });
      const b = makeDeps({ objectStore: store });
      await Promise.all([processDeletionTasks(a), processDeletionTasks(b)]);
      const after = await taskStatus(task);
      expect(after.status).toBe("failed");
      expect(after.attempts).toBe(1);
      expect(after.attempts).toBeLessThan(DELETION_TASK_MAX_ATTEMPTS);
    });

    it("HOTSPOT outside-prefix cleanup: the worker never deletes a key belonging to another asset", async () => {
      // A transcoder that returns keys outside `${objectKey}/` is treated as
      // having produced junk to clean up — but the worker deletes whatever
      // keys it was handed, so a buggy/compromised transcoder can erase any
      // object in the bucket (here: another user's live master).
      await pool.query("DELETE FROM media_asset");
      const attacker = await newUser("tx-attacker");
      const victim = await newUser("tx-victim");
      const victimKey = `${victim}/master.mov`;
      const attackerKey = `${attacker}/master.mov`;
      const store = new FakeStore();
      store.keys.add(victimKey);
      store.keys.add(attackerKey);
      await insertAsset(victim, victimKey);
      const attackerAsset = await insertAsset(attacker, attackerKey, { status: "processing" });
      const deps = makeDeps({
        objectStore: store,
        transcoder: async () => ({ normalizedKey: victimKey, thumbnailKey: `${attacker}/x.jpg` }),
      });
      const outcome = await handleJob(deps, {
        id: "j1",
        kind: "media.process",
        payload: { mediaAssetId: attackerAsset },
        attempt: 1,
      });
      expect(outcome.handled).toBe(true);
      const status = await pool.query("SELECT status FROM media_asset WHERE id = $1", [
        attackerAsset,
      ]);
      expect(status.rows[0].status).toBe("failed");
      // The victim's live master must survive.
      expect(store.keys.has(victimKey)).toBe(true);
      expect(store.deletedKeys).not.toContain(victimKey);
    });

    it("media.process for a deleted-and-purged asset (object_key NULL) must be handled, not redelivered forever", async () => {
      // With a transcoder configured, `!row?.object_key` returns handled:false
      // for a row that EXISTS but was already purged. Unlike media.purge (which
      // treats the same state as idempotent success) this job is never acked
      // and redelivers on every visibility timeout with no cap.
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("purged");
      const row = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', NULL, 'deleted', now()) RETURNING id`,
        [uid],
      );
      const assetId = row.rows[0].id as string;
      let transcoderCalls = 0;
      const deps = makeDeps({
        transcoder: async ({ objectKey }) => {
          transcoderCalls++;
          return { normalizedKey: `${objectKey}/n.mp4`, thumbnailKey: `${objectKey}/t.jpg` };
        },
      });
      const outcome = await handleJob(deps, {
        id: "j2",
        kind: "media.process",
        payload: { mediaAssetId: assetId },
        attempt: 1,
      });
      expect(transcoderCalls).toBe(0);
      expect(outcome.handled).toBe(true);
    });

    it("media.process for a non-existent asset must be handled, not redelivered forever", async () => {
      let transcoderCalls = 0;
      const deps = makeDeps({
        transcoder: async ({ objectKey }) => {
          transcoderCalls++;
          return { normalizedKey: `${objectKey}/n.mp4`, thumbnailKey: `${objectKey}/t.jpg` };
        },
      });
      const outcome = await handleJob(deps, {
        id: "j3",
        kind: "media.process",
        payload: { mediaAssetId: randomUUID() },
        attempt: 1,
      });
      expect(transcoderCalls).toBe(0);
      // media.purge treats "not found" as handled (idempotent); media.process
      // must be consistent or the job is a permanent poison message.
      expect(outcome.handled).toBe(true);
    });

    it("retention audit: an expiry that crashes before the audit insert is still audited on a later cycle", async () => {
      // enforceMediaRetention marks rows deleted in one statement and audits
      // them in a later loop; a crash in between leaves deleted_at set (so the
      // row is never selected again) and no audit_log row with policyVersion.
      await pool.query("DELETE FROM media_asset");
      await pool.query("DELETE FROM audit_log WHERE action = 'media.retention_expired'");
      const uid = await newUser("retention-crash");
      const assetId = await insertAsset(uid, `${uid}/share.mp4`, { kind: "share_video" });
      await pool.query(
        "UPDATE media_asset SET created_at = now() - interval '31 days' WHERE id = $1",
        [assetId],
      );
      let armed = true;
      const crashingPool = {
        query: async (text: string, params?: unknown[]) => {
          if (armed && text.includes("INSERT INTO audit_log")) {
            armed = false;
            throw new Error("connection reset");
          }
          return pool.query(text, params);
        },
      } as unknown as pg.Pool;
      const deps = makeDeps({ pool: crashingPool });
      await expect(enforceMediaRetention(deps)).rejects.toThrow("connection reset");
      // Next cycle (healthy DB).
      await enforceMediaRetention(makeDeps());
      const asset = await pool.query("SELECT deleted_at FROM media_asset WHERE id = $1", [assetId]);
      expect(asset.rows[0].deleted_at).not.toBeNull();
      const audit = await pool.query(
        "SELECT metadata FROM audit_log WHERE action = 'media.retention_expired' AND target_id = $1",
        [assetId],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0].metadata).toMatchObject({ policyVersion: expect.any(String) });
    });

    it("VERIFY retention: explicit expires_at wins even for an until_deleted kind", async () => {
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("retention-explicit");
      const assetId = await insertAsset(uid, `${uid}/drill.mp4`, { kind: "drill_video" });
      await pool.query(
        "UPDATE media_asset SET expires_at = now() - interval '1 second' WHERE id = $1",
        [assetId],
      );
      const deps = makeDeps();
      expect(await enforceMediaRetention(deps)).toBe(1);
      const asset = await pool.query("SELECT status, deleted_at FROM media_asset WHERE id = $1", [
        assetId,
      ]);
      expect(asset.rows[0].status).toBe("deleted");
      expect(asset.rows[0].deleted_at).not.toBeNull();
      const queued = await deps.queue.receive(10);
      expect(queued.map((r) => r.job.kind)).toEqual(["media.purge"]);
    });

    it("VERIFY retention: an owner turning retention off (0/NULL) after a window elapsed keeps remaining assets", async () => {
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("retention-flip");
      await pool.query(
        "INSERT INTO user_setting (user_id, local_video_retention_days) VALUES ($1, 7)",
        [uid],
      );
      const a = await insertAsset(uid, `${uid}/a.mov`);
      const b = await insertAsset(uid, `${uid}/b.mov`);
      await pool.query(
        "UPDATE media_asset SET created_at = now() - interval '8 days' WHERE id IN ($1, $2)",
        [a, b],
      );
      // Owner disables retention before the sweep runs.
      await pool.query(
        "UPDATE user_setting SET local_video_retention_days = 0 WHERE user_id = $1",
        [uid],
      );
      expect(await enforceMediaRetention(makeDeps())).toBe(0);
      await pool.query(
        "UPDATE user_setting SET local_video_retention_days = NULL WHERE user_id = $1",
        [uid],
      );
      expect(await enforceMediaRetention(makeDeps())).toBe(0);
      const live = await pool.query(
        "SELECT count(*)::int AS n FROM media_asset WHERE owner_user_id = $1 AND deleted_at IS NULL",
        [uid],
      );
      expect(live.rows[0].n).toBe(2);
    });

    it("VERIFY retention: an asset created exactly at the window boundary is expired (inclusive)", async () => {
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("retention-boundary");
      const assetId = await insertAsset(uid, `${uid}/share.mp4`, { kind: "share_video" });
      // created_at + 30d == now() at the instant of the UPDATE cannot be pinned
      // exactly; use 30 days + 1 ms to assert the `<=` edge behaves as "expired"
      // and 30 days - 1 minute as "not expired".
      await pool.query(
        "UPDATE media_asset SET created_at = now() - interval '30 days' + interval '1 minute' WHERE id = $1",
        [assetId],
      );
      expect(await enforceMediaRetention(makeDeps())).toBe(0);
      await pool.query(
        "UPDATE media_asset SET created_at = now() - interval '30 days' - interval '1 millisecond' WHERE id = $1",
        [assetId],
      );
      expect(await enforceMediaRetention(makeDeps())).toBe(1);
    });

    it("VERIFY media_purge task: live (non-deleted) assets of the user are purged too (account deletion erases everything)", async () => {
      await pool.query("DELETE FROM deletion_task");
      await pool.query("DELETE FROM media_asset");
      const uid = await newUser("purge-live");
      const deps = makeDeps();
      const liveKey = `${uid}/live.mov`;
      deps.store.keys.add(liveKey);
      deps.store.keys.add(`${liveKey}/n.mp4`);
      const liveId = await insertAsset(uid, liveKey);
      const task = await insertTask(uid, "media_purge", new Date());
      await processDeletionTasks(deps);
      expect((await taskStatus(task)).status).toBe("done");
      const row = await pool.query(
        "SELECT object_key, status, deleted_at FROM media_asset WHERE id = $1",
        [liveId],
      );
      expect(row.rows[0].object_key).toBeNull();
      expect(row.rows[0].status).toBe("deleted");
      expect(row.rows[0].deleted_at).not.toBeNull();
      expect(deps.store.keys.size).toBe(0);
    });
  },
);
