import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import { QueueSloMonitor } from "@pickle/slo";
import { enforceMediaRetention, handleJob, runOnce, type WorkerDeps } from "../../src/worker.js";
import {
  FaultInjector,
  InventoryStore,
  RecordingAnalytics,
  bounded,
  inventoryTranscoder,
  wrapPool,
  wrapStore,
  wrapTranscoder,
  type FaultPlan,
} from "./faultKit.js";

/**
 * Deterministic, minimized reproductions distilled from the seeded campaign
 * (failure-injection.campaign.stress.test.ts), plus the hang/no-watchdog
 * probes that need fake timers.
 *
 * Convention: `it.fails(...)` pins a KNOWN DEFECT — the assertions state the
 * behaviour the worker SHOULD have, and vitest requires the test to fail. When
 * the defect is fixed the test starts passing, vitest reports it, and the
 * `.fails` modifier is removed. Plain `it(...)` pins an invariant that HELD
 * under injection.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `worker_stress_t_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
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

const CYCLES = 5;

describe.skipIf(!testUrl)("media worker failure injection — minimized reproductions", () => {
  let pool: pg.Pool;
  let adminPool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    adminPool = new pg.Pool({ connectionString: testUrl });
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName), max: 4 });
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    const user = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ('auth0|worker-stress-targeted') RETURNING id",
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

  async function insertAsset(fields: {
    objectKey: string | null;
    status: string;
    deleted?: boolean;
    kind?: string;
  }): Promise<string> {
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, $2, 'b', $3, $4, $5) RETURNING id`,
      [
        userId,
        fields.kind ?? "raw_video",
        fields.objectKey,
        fields.status,
        fields.deleted ? new Date() : null,
      ],
    );
    return row.rows[0].id as string;
  }

  async function assetRow(id: string) {
    const r = await pool.query(
      "SELECT status, object_key, deleted_at FROM media_asset WHERE id = $1",
      [id],
    );
    return r.rows[0] as
      { status: string; object_key: string | null; deleted_at: Date | null } | undefined;
  }

  interface Built {
    deps: WorkerDeps;
    store: InventoryStore;
    queue: InMemoryJobQueue;
    analytics: RecordingAnalytics;
    log: string[];
  }

  function build(
    plan: FaultPlan | null,
    transcoder: WorkerDeps["transcoder"] | "inventory" = null,
  ): Built {
    const inj = new FaultInjector(plan);
    const store = new InventoryStore();
    const queue = new InMemoryJobQueue();
    const analytics = new RecordingAnalytics(inj);
    const log: string[] = [];
    const deps: WorkerDeps = {
      pool: wrapPool(pool, inj),
      queue,
      objectStore: wrapStore(store, inj),
      transcoder:
        transcoder === "inventory"
          ? wrapTranscoder(inventoryTranscoder(store), inj, () => "")
          : transcoder,
      log: (line) => log.push(line),
      analytics,
      sloMonitor: new QueueSloMonitor(),
    };
    return { deps, store, queue, analytics, log };
  }

  async function cycles(b: Built, n: number): Promise<Array<Awaited<ReturnType<typeof runOnce>>>> {
    const out = [];
    for (let i = 0; i < n; i++) {
      b.queue.expireInFlight();
      out.push(await runOnce(b.deps));
    }
    return out;
  }

  // ------------------------------------------------------------------ BROKEN

  it.fails(
    "media.process for an asset whose object was already purged must not be retried forever",
    async () => {
      // Realistic ordering: the purge job (or the sweep) ran before a stale
      // process job was delivered — the asset is deleted and its key nulled.
      const id = await insertAsset({ objectKey: null, status: "deleted", deleted: true });
      const b = build(null, "inventory");
      await b.queue.enqueue("media.process", { mediaAssetId: id });

      const results = await cycles(b, CYCLES);
      b.queue.expireInFlight();
      // EXPECTED: a deleted/purged asset is a terminal "refused" outcome (the
      // handler already treats `deleted_at` that way) → acked once, queue empty.
      expect(await b.queue.size()).toBe(0);
      expect(results.some((r) => r.jobs === 1)).toBe(true);
      expect(b.analytics.events.filter((e) => e.name === "worker_failure")).toHaveLength(0);
    },
  );

  it.fails(
    "media.process for a mediaAssetId that does not exist must not be retried forever",
    async () => {
      const b = build(null, "inventory");
      await b.queue.enqueue("media.process", { mediaAssetId: randomUUID() });
      await cycles(b, CYCLES);
      b.queue.expireInFlight();
      // EXPECTED: unknown asset is terminal — not a transient dependency fault.
      expect(await b.queue.size()).toBe(0);
    },
  );

  it.fails(
    "a transcoder that returns the master key as its output must not delete the master",
    async () => {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "processing" });
      const b = build(null, async ({ objectKey }) => ({
        normalizedKey: objectKey,
        thumbnailKey: objectKey,
      }));
      b.store.keys.add(key);
      await b.queue.enqueue("media.process", { mediaAssetId: id });

      await runOnce(b.deps);
      const row = await assetRow(id);
      // EXPECTED: asset marked failed AND the user's original upload survives.
      expect(row?.status).toBe("failed");
      expect(b.store.keys.has(key), "master object must never be deleted by process").toBe(true);
      expect(b.store.deletedKeys).not.toContain(key);
    },
  );

  it.fails(
    "a transcoder that names another asset's object must not cause that object to be deleted",
    async () => {
      const victimKey = `media/${userId}/${randomUUID()}/master.mp4`;
      const otherKey = `media/${randomUUID()}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: victimKey, status: "processing" });
      const other = await insertAsset({ objectKey: otherKey, status: "ready" });
      const b = build(null, async ({ objectKey }) => ({
        normalizedKey: otherKey, // stale temp-file bookkeeping / wrong job id
        thumbnailKey: `${objectKey}/thumb.jpg`,
      }));
      b.store.keys.add(victimKey);
      b.store.keys.add(otherKey);
      b.store.keys.add(`${otherKey}/normalized.mp4`);
      await b.queue.enqueue("media.process", { mediaAssetId: id });

      await runOnce(b.deps);
      expect((await assetRow(id))?.status).toBe("failed");
      // EXPECTED: only keys under the faulty asset's own prefix may be touched.
      expect(b.store.keys.has(otherKey), "another asset's master was deleted").toBe(true);
      expect((await assetRow(other))?.status).toBe("ready");
    },
  );

  it.fails(
    "a transcoder that resolves with a malformed result must become a typed failure, not an infinite retry",
    async () => {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "processing" });
      let invocations = 0;
      const b = build(null, async () => {
        invocations++;
        return undefined as unknown as { normalizedKey: string; thumbnailKey: string };
      });
      b.store.keys.add(key);
      await b.queue.enqueue("media.process", { mediaAssetId: id });

      await cycles(b, CYCLES);
      b.queue.expireInFlight();
      // EXPECTED: same contract as a transcoder throw — asset 'failed', job acked once.
      expect((await assetRow(id))?.status).toBe("failed");
      expect(await b.queue.size()).toBe(0);
      expect(invocations).toBe(1);
    },
  );

  it.fails(
    "retention expiry must leave an audit_log row even when the connection drops right after the UPDATE",
    async () => {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "ready", kind: "drill_video" });
      await pool.query(
        "UPDATE media_asset SET expires_at = now() - interval '1 day' WHERE id = $1",
        [id],
      );
      // Fault: the 1st query (the explicit-expiry UPDATE) commits, then the
      // connection dies before the client sees the result.
      const b = build({ target: "pool.query", mode: "partial", nth: 0, variant: 0 });
      b.store.keys.add(key);

      await expect(enforceMediaRetention(b.deps)).rejects.toThrow(/injected/);
      // Recovery with no fault: the asset is already deleted, so it is no
      // longer eligible and the audit row is never written.
      const clean = build(null);
      clean.store.keys.add(key);
      await enforceMediaRetention(clean.deps);
      expect((await assetRow(id))?.deleted_at).not.toBeNull();
      const audit = await pool.query(
        "SELECT 1 FROM audit_log WHERE action = 'media.retention_expired' AND target_id = $1",
        [id],
      );
      // EXPECTED: every automated deletion is auditable.
      expect(audit.rowCount).toBe(1);
    },
  );

  it.fails(
    "purge must not orphan derived objects when the prefix listing is incomplete once",
    async () => {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
      const b = build({ target: "store.listObjects", mode: "empty", nth: 0, variant: 0 });
      b.store.keys.add(key);
      b.store.keys.add(`${key}/normalized.mp4`);
      b.store.keys.add(`${key}/thumb.jpg`);
      await b.queue.enqueue("media.purge", { mediaAssetId: id });

      await cycles(b, CYCLES);
      // EXPECTED: the DB keeps a pointer until a verified re-list is empty, so
      // a later sweep can finish; instead object_key is NULL and 2 objects
      // remain unreachable.
      const remaining = [...b.store.keys].filter((k) => k.startsWith(`${key}/`));
      expect(remaining, "derived objects orphaned with no DB pointer").toEqual([]);
    },
  );

  it.fails(
    "purge must not strand training-eligible dataset items when the DB fails after the key was nulled",
    async () => {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
      const item = await pool.query(
        `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
         VALUES ($1, $2, 'v1') RETURNING id`,
        [userId, id],
      );
      const itemId = item.rows[0].id as string;
      // media.purge issues 3 statements: SELECT asset, UPDATE object_key=NULL,
      // UPDATE ml_dataset_item. Fault: the 3rd statement is rejected once.
      const b = build({ target: "pool.query", mode: "reject", nth: 2, variant: 0 });
      b.store.keys.add(key);
      const job = {
        id: randomUUID(),
        kind: "media.purge",
        payload: { mediaAssetId: id },
        attempt: 1,
      };

      await expect(handleJob(b.deps, job)).rejects.toThrow(/injected/);
      // Recovery: the job is redelivered and the sweep runs with no fault.
      const clean = build(null);
      const retry = await handleJob(clean.deps, { ...job, attempt: 2 });
      await runOnce(clean.deps);
      expect(retry.handled).toBe(true);
      expect((await assetRow(id))?.object_key).toBeNull();
      const left = await pool.query("SELECT removed_at FROM ml_dataset_item WHERE id = $1", [
        itemId,
      ]);
      // EXPECTED: a purged asset's dataset items are removed by the retry or
      // the sweep. OBSERVED: retry says "no object to delete" and the sweep
      // only selects rows with object_key set, so the item stays eligible.
      expect(left.rows[0]?.removed_at, "dataset item still training-eligible").not.toBeNull();
    },
  );

  // -------------------------------------------------------------------- HELD

  it("purge storage failure keeps the job visible, emits media_storage_failure, then completes", async () => {
    const key = `media/${userId}/${randomUUID()}/master.mp4`;
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    for (const [i, mode] of (["throw", "reject", "timeout", "partial"] as const).entries()) {
      const b = build({ target: "store.deleteObject", mode, nth: 0, variant: i });
      b.store.keys.add(key);
      b.store.keys.add(`${key}/normalized.mp4`);
      await b.queue.enqueue("media.purge", { mediaAssetId: id });
      const first = await runOnce(b.deps);
      expect(first.jobs).toBe(0);
      b.queue.expireInFlight();
      expect(await b.queue.size()).toBe(1);
      expect(b.analytics.events.filter((e) => e.name === "media_storage_failure")).toHaveLength(1);
      // The purge job stays visible; the same cycle's deleted-media sweep (or
      // the next clean cycle) finishes the erasure.

      const clean = build(null);
      clean.store.keys = b.store.keys;
      clean.queue = b.queue;
      clean.deps.queue = b.queue;
      await runOnce(clean.deps);
      expect([...clean.store.keys].filter((k) => k.startsWith(key))).toEqual([]);
      expect((await assetRow(id))?.object_key).toBeNull();
      await pool.query("UPDATE media_asset SET object_key = $2 WHERE id = $1", [id, key]);
    }
  });

  it("a transcoder throw/reject/timeout marks the asset failed exactly once and keeps the master", async () => {
    for (const [i, mode] of (["throw", "reject", "timeout"] as const).entries()) {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "processing" });
      const b = build({ target: "transcoder", mode, nth: 0, variant: i }, "inventory");
      b.store.keys.add(key);
      await b.queue.enqueue("media.process", { mediaAssetId: id });
      const r = await runOnce(b.deps);
      expect(r.jobs).toBe(1);
      expect((await assetRow(id))?.status).toBe("failed");
      expect(b.store.keys.has(key)).toBe(true);
      b.queue.expireInFlight();
      expect(await b.queue.size()).toBe(0);
    }
  });

  it("a transcoder that writes derived objects then dies leaves the asset retryable, not half-ready", async () => {
    const key = `media/${userId}/${randomUUID()}/master.mp4`;
    const id = await insertAsset({ objectKey: key, status: "processing" });
    const b = build({ target: "transcoder", mode: "partial", nth: 0, variant: 0 }, "inventory");
    b.store.keys.add(key);
    await b.queue.enqueue("media.process", { mediaAssetId: id });
    await runOnce(b.deps);
    const row = await assetRow(id);
    expect(row?.status).toBe("failed");
    expect(b.store.keys.has(key)).toBe(true);
    // Derived objects live under the master prefix, so a later purge finds them.
    expect([...b.store.keys].filter((k) => k.startsWith(`${key}/`))).toHaveLength(2);
  });

  it("deletion-task faults (storage reject, DB reject before/after the purge) stay retryable and converge idempotently", async () => {
    const victim = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`auth0|stress-victim-${randomUUID()}`],
    );
    const victimId = victim.rows[0].id as string;
    const key = `media/${victimId}/${randomUUID()}/master.mp4`;
    await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status) VALUES ($1, 'raw_video', 'b', $2, 'ready')`,
      [victimId, key],
    );
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [
      victimId,
    ]);

    const taskRow = async () =>
      (
        await pool.query("SELECT status, attempts FROM deletion_task WHERE user_id = $1", [
          victimId,
        ])
      ).rows[0] as { status: string; attempts: number };

    // A: S3 SlowDown on the first delete → task failed, attempts 1, object kept.
    const b = build({ target: "store.deleteObject", mode: "reject", nth: 0, variant: 0 });
    b.store.keys.add(key);
    await runOnce(b.deps);
    expect(await taskRow()).toEqual({ status: "failed", attempts: 1 });
    expect(b.store.keys.has(key)).toBe(true);

    // B: DB rejects the 'processing' UPDATE (query #1) → escapes runOnce
    // (main.ts logs worker_crash); the row is untouched and still retryable.
    const b2 = build({ target: "pool.query", mode: "reject", nth: 1, variant: 0 });
    b2.store.keys = b.store.keys;
    const settled = await bounded(() => runOnce(b2.deps), 2000);
    expect(settled.kind).toBe("rejected");
    expect(await taskRow()).toEqual({ status: "failed", attempts: 1 });

    // C: objects deleted, then the DB rejects the media_asset UPDATE (query #3)
    // → task failed, attempts 2; object_key still set so the retry re-runs.
    const b3 = build({ target: "pool.query", mode: "reject", nth: 3, variant: 1 });
    b3.store.keys = b.store.keys;
    await runOnce(b3.deps);
    expect(await taskRow()).toEqual({ status: "failed", attempts: 2 });
    expect(b.store.keys.has(key)).toBe(false);
    const asset = await pool.query("SELECT object_key FROM media_asset WHERE owner_user_id = $1", [
      victimId,
    ]);
    expect(asset.rows[0].object_key).toBe(key);

    // D: clean cycle converges (idempotent delete of an already-gone object).
    const clean = build(null);
    clean.store.keys = b.store.keys;
    await runOnce(clean.deps);
    expect(await taskRow()).toEqual({ status: "done", attempts: 2 });
    const after = await pool.query(
      "SELECT object_key, status FROM media_asset WHERE owner_user_id = $1",
      [victimId],
    );
    expect(after.rows[0]).toEqual({ object_key: null, status: "deleted" });
  });

  it("malformed job envelopes are isolated: the batch continues and the poison stays visible", async () => {
    const key = `media/${userId}/${randomUUID()}/master.mp4`;
    const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
    // Payloads the handler throws on (stay visible, category-only telemetry)…
    const poisons: unknown[] = [
      null, // destructuring null
      { mediaAssetId: 123 }, // invalid uuid literal
      { mediaAssetId: "not-a-uuid" },
      { mediaAssetId: { $ne: null } }, // object serialised as JSON → invalid uuid
    ];
    // …and payloads that resolve to "asset not found" (terminal for purge: acked).
    const unknownAsset: unknown[] = [{}, "string-payload"];
    const b = build(null);
    b.store.keys.add(key);
    for (const payload of poisons) await b.queue.enqueue("media.purge", payload);
    for (const payload of unknownAsset) await b.queue.enqueue("media.purge", payload);
    await b.queue.enqueue("__malformed__", { raw: "{not json" });
    await b.queue.enqueue("media.purge", { mediaAssetId: id });

    const r = await runOnce(b.deps);
    expect(r.jobs).toBe(unknownAsset.length + 1);
    expect(b.store.keys.has(key)).toBe(false);
    b.queue.expireInFlight();
    expect(await b.queue.size()).toBe(poisons.length + 1);
    const failures = b.analytics.events.filter((e) => e.name === "worker_failure");
    expect(failures).toHaveLength(poisons.length + 1);
    // Every recorded failure is category-only: no payloads, keys or error text.
    for (const e of failures)
      expect(Object.keys(e).sort()).toEqual(["at", "failureKind", "jobKind", "name", "platform"]);
  });

  it("clock jumps (±1h) during a cycle do not corrupt state or crash the cycle", async () => {
    for (const delta of [-3_600_000, 3_600_000]) {
      const key = `media/${userId}/${randomUUID()}/master.mp4`;
      const id = await insertAsset({ objectKey: key, status: "deleted", deleted: true });
      const b = build(null);
      b.store.keys.add(key);
      await b.queue.enqueue("media.purge", { mediaAssetId: id });
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(Date.now() + delta);
        const r = await runOnce(b.deps);
        expect(r.jobs).toBe(1);
      } finally {
        vi.useRealTimers();
      }
      expect((await assetRow(id))?.object_key).toBeNull();
      for (const e of b.analytics.events) expect(Number.isNaN(Date.parse(e.at))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// No-DB probes: hangs and the missing watchdog (fake timers, 60 s advance).
// ---------------------------------------------------------------------------
describe("media worker hang probes (no DB)", () => {
  afterEach(() => vi.useRealTimers());

  function hangingDeps(target: "pool" | "store" | "transcoder" | "queue"): {
    deps: WorkerDeps;
    analytics: RecordingAnalytics;
    log: string[];
  } {
    const never = <T>() => new Promise<T>(() => {});
    const analytics = new RecordingAnalytics(new FaultInjector(null));
    const log: string[] = [];
    const queue = new InMemoryJobQueue();
    const fakePoolQuery = (text: string): Promise<pg.QueryResult> => {
      if (target === "pool") return never();
      if (text.startsWith("SELECT object_key, owner_user_id"))
        return Promise.resolve({
          rows: [{ object_key: "media/u/a/master.mp4", owner_user_id: "u", deleted_at: null }],
          rowCount: 1,
        } as unknown as pg.QueryResult);
      if (text.startsWith("SELECT object_key, deleted_at"))
        return Promise.resolve({
          rows: [{ object_key: "media/u/a/master.mp4", deleted_at: new Date() }],
          rowCount: 1,
        } as unknown as pg.QueryResult);
      return Promise.resolve({ rows: [], rowCount: 0 } as unknown as pg.QueryResult);
    };
    const deps: WorkerDeps = {
      pool: { query: fakePoolQuery } as unknown as pg.Pool,
      queue:
        target === "queue"
          ? {
              enqueue: (kind, payload) => queue.enqueue(kind, payload),
              receive: () => never(),
              size: () => queue.size(),
              oldestJobAgeMs: () => queue.oldestJobAgeMs(),
            }
          : queue,
      objectStore: {
        deleteObject: () => (target === "store" ? never() : Promise.resolve()),
        listObjects: () => Promise.resolve([]),
      },
      transcoder: () =>
        target === "transcoder"
          ? never()
          : Promise.resolve({
              normalizedKey: "media/u/a/master.mp4/n.mp4",
              thumbnailKey: "media/u/a/master.mp4/t.jpg",
            }),
      log: (line) => log.push(line),
      analytics,
      sloMonitor: new QueueSloMonitor(),
    };
    return { deps, analytics, log };
  }

  for (const target of ["pool", "store", "transcoder", "queue"] as const) {
    it.fails(
      `a never-resolving ${target} call must not stall the cycle silently past 60 s`,
      async () => {
        vi.useFakeTimers();
        const h = hangingDeps(target);
        if (target === "store")
          await h.deps.queue.enqueue("media.purge", { mediaAssetId: randomUUID() });
        if (target === "transcoder")
          await h.deps.queue.enqueue("media.process", { mediaAssetId: randomUUID() });
        let settled: "resolved" | "rejected" | null = null;
        const cycle = runOnce(h.deps).then(
          () => (settled = "resolved"),
          () => (settled = "rejected"),
        );
        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.race([cycle, Promise.resolve()]);
        // EXPECTED: a bounded cycle (statement/request timeout or a watchdog) so
        // the crash path in main.ts can log worker_crash and the SLO monitor can
        // observe the stall. OBSERVED: the cycle is still pending after 60 s and
        // nothing was logged or tracked.
        expect(settled, "cycle still pending after 60s of fake time").not.toBeNull();
      },
    );
  }

  it("the hang probes above are honest: without the hang the same cycle settles", async () => {
    const h = hangingDeps("queue");
    h.deps.queue = new InMemoryJobQueue();
    const settled = await bounded(() => runOnce(h.deps), 1000);
    expect(settled.kind).toBe("resolved");
  });
});
