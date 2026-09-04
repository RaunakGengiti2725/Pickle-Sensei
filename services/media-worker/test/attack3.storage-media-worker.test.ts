import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue, type IJobQueue } from "@pickle/queue";
import { MEDIA_RETENTION_POLICY_V1 } from "@pickle/shared-types";
import {
  enforceMediaRetention,
  handleJob,
  runOnce,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * ADVERSARIAL TESTER #3 (pass 3 of 3) — subsystem storage-media-worker.
 * Attacks against commit 4d812e1a on a REAL PostgreSQL database in an
 * isolated schema. Every test is written as the attack ("does the worker
 * survive X?") and records observed behaviour as assertions; tests that
 * document a BROKEN behaviour are named `[BROKEN]` and assert the observed
 * (bad) behaviour so a fix flips them loudly. Nothing here touches
 * production code.
 *
 * Scenarios (from the role brief):
 *  S1 sweepDeletedMedia starvation (LIMIT 50 / no ORDER BY)
 *  S2 explicit expires_at wins for an until_deleted kind
 *  S3 status='deleted' with deleted_at NULL: invisible to purge AND sweep
 *  S4 exact-boundary retention window; retention 0 / NULL siblings
 *  S5 ack() throws after a successful purge; redelivery is idempotent
 *  S6 queue.enqueue throws inside enforceMediaRetention
 *  S7 2,500 derived keys, deleteObject fails on key #1,200
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `attack3_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

/** Seeded PRNG (mulberry32) so any randomised interleaving is reproducible. */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = 0x5eed_0003;

/**
 * Synthetic object store with a full key inventory. `failing` keys reject on
 * deleteObject (permanent storage failure, e.g. 403 from a bucket policy).
 * `staleListing` makes listObjects return the inventory as it was at the
 * first call (an eventually-consistent listing).
 */
class FakeStore implements ObjectDeleter {
  keys = new Set<string>();
  failing = new Set<string>();
  deleteCalls: string[] = [];
  listCalls: string[] = [];
  staleListing = false;
  private snapshot: string[] | null = null;

  async deleteObject(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.failing.has(key)) throw new Error(`AccessDenied: ${key}`);
    this.keys.delete(key);
  }

  async listObjects(prefix: string): Promise<string[]> {
    this.listCalls.push(prefix);
    if (this.staleListing) {
      this.snapshot ??= [...this.keys].sort();
      return this.snapshot.filter((k) => k.startsWith(prefix));
    }
    // S3 lists in UTF-8 binary order.
    return [...this.keys].filter((k) => k.startsWith(prefix)).sort();
  }

  timesDeleted(key: string): number {
    return this.deleteCalls.filter((k) => k === key).length;
  }
}

describe.skipIf(!testUrl)("attack3: storage-media-worker purge/retention (isolated schema)", () => {
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
      "INSERT INTO app_user (auth_subject) VALUES ('auth0|attack3-owner') RETURNING id",
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
    logs: string[];
  } {
    const store = (overrides.objectStore as FakeStore | undefined) ?? new FakeStore();
    const queue = (overrides.queue as InMemoryJobQueue | undefined) ?? new InMemoryJobQueue();
    const logs: string[] = [];
    const deps: WorkerDeps = {
      pool,
      transcoder: null,
      log: (line) => logs.push(line),
      ...overrides,
      queue,
      objectStore: store,
    };
    return Object.assign(deps, { store, queue, logs });
  }

  async function createOwner(subject: string, retentionDays: number | null): Promise<string> {
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      subject,
    ]);
    const id = user.rows[0].id as string;
    await pool.query(
      "INSERT INTO user_setting (user_id, local_video_retention_days) VALUES ($1, $2)",
      [id, retentionDays],
    );
    return id;
  }

  async function insertAsset(fields: {
    ownerId?: string | null;
    kind?: string;
    objectKey: string | null;
    status: string;
    deletedAt?: Date | null;
    createdAtSql?: string;
    expiresAtSql?: string;
  }): Promise<string> {
    const createdAt = fields.createdAtSql ?? "now()";
    const expiresAt = fields.expiresAtSql ?? "NULL";
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at, created_at, expires_at)
       VALUES ($1, $2, 'b', $3, $4, $5, ${createdAt}, ${expiresAt}) RETURNING id`,
      [
        fields.ownerId === undefined ? userId : fields.ownerId,
        fields.kind ?? "raw_video",
        fields.objectKey,
        fields.status,
        fields.deletedAt ?? null,
      ],
    );
    return row.rows[0].id as string;
  }

  async function assetRow(id: string): Promise<{
    status: string;
    object_key: string | null;
    deleted_at: Date | null;
  }> {
    const { rows } = await pool.query(
      "SELECT status, object_key, deleted_at FROM media_asset WHERE id = $1",
      [id],
    );
    return rows[0] as { status: string; object_key: string | null; deleted_at: Date | null };
  }

  async function purgeAudits(id: string): Promise<Array<{ metadata: { policyVersion: string } }>> {
    const { rows } = await pool.query(
      "SELECT metadata FROM audit_log WHERE action = 'media.retention_expired' AND target_id = $1",
      [id],
    );
    return rows as Array<{ metadata: { policyVersion: string } }>;
  }

  // ---------------------------------------------------------------------------
  // S1 — sweep starvation
  // ---------------------------------------------------------------------------
  it("[BROKEN] S1: 60 permanently-failing deleted rows starve a healthy deleted row forever (LIMIT 50, no ORDER BY)", async () => {
    // Own schema state: make sure no other deleted rows with keys exist.
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const poison: string[] = [];
    for (let i = 0; i < 60; i++) {
      const key = `media/attack3/s1/poison-${String(i).padStart(3, "0")}-${randomUUID()}`;
      deps.store.keys.add(key);
      deps.store.failing.add(key);
      poison.push(await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() }));
    }
    const healthyKey = `media/attack3/s1/healthy-${randomUUID()}`;
    deps.store.keys.add(healthyKey);
    const healthy = await insertAsset({
      objectKey: healthyKey,
      status: "deleted",
      deletedAt: new Date(Date.now() - 60_000), // deleted BEFORE the poison rows, still starved
    });

    const cycles = 25;
    let sweptTotal = 0;
    for (let i = 0; i < cycles; i++) sweptTotal += await sweepDeletedMedia(deps);

    const healthyRow = await assetRow(healthy);
    const healthyEverAttempted = deps.store.deleteCalls.includes(healthyKey);
    const distinctAttempted = new Set(deps.store.deleteCalls).size;

    // Observed: every cycle selects the same 50 poison rows (heap order, no
    // ORDER BY, LIMIT 50); the healthy row is never even attempted.
    expect(sweptTotal).toBe(0);
    expect(deps.store.deleteCalls.length).toBe(cycles * 50);
    expect(distinctAttempted).toBe(50);
    expect(healthyEverAttempted).toBe(false);
    expect(healthyRow.object_key).toBe(healthyKey);
    expect(deps.store.keys.has(healthyKey)).toBe(true);
    // 10 of the 60 poison rows were never attempted either.
    expect(poison.length - distinctAttempted).toBe(10);

    // Cleanup so later tests see a clean sweep set.
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
  });

  it("S1b: with fewer than 50 poison rows the healthy row IS swept (starvation is purely the LIMIT)", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    for (let i = 0; i < 49; i++) {
      const key = `media/attack3/s1b/poison-${i}-${randomUUID()}`;
      deps.store.keys.add(key);
      deps.store.failing.add(key);
      await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });
    }
    const healthyKey = `media/attack3/s1b/healthy-${randomUUID()}`;
    deps.store.keys.add(healthyKey);
    const healthy = await insertAsset({
      objectKey: healthyKey,
      status: "deleted",
      deletedAt: new Date(),
    });
    expect(await sweepDeletedMedia(deps)).toBe(1);
    expect((await assetRow(healthy)).object_key).toBeNull();
    expect(deps.store.keys.has(healthyKey)).toBe(false);
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
  });

  // ---------------------------------------------------------------------------
  // S2 — explicit expiry wins over until_deleted
  // ---------------------------------------------------------------------------
  it("S2: drill_video (until_deleted) with expires_at = now() - 1s expires: status deleted, audited with policyVersion, purge enqueued", async () => {
    const deps = makeDeps();
    const key = `media/attack3/s2/${randomUUID()}`;
    deps.store.keys.add(key);
    const id = await insertAsset({
      ownerId: null,
      kind: "drill_video",
      objectKey: key,
      status: "ready",
      expiresAtSql: "now() - interval '1 second'",
    });
    const sibling = await insertAsset({
      ownerId: null,
      kind: "drill_video",
      objectKey: `media/attack3/s2/sib-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '5000 days'",
    });
    const future = await insertAsset({
      ownerId: null,
      kind: "drill_video",
      objectKey: `media/attack3/s2/future-${randomUUID()}`,
      status: "ready",
      expiresAtSql: "now() + interval '1 hour'",
    });

    const expired = await enforceMediaRetention(deps, MEDIA_RETENTION_POLICY_V1);
    expect(expired).toBe(1);
    const row = await assetRow(id);
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).not.toBeNull();
    const audits = await purgeAudits(id);
    expect(audits).toHaveLength(1);
    expect(audits[0]!.metadata.policyVersion).toBe(MEDIA_RETENTION_POLICY_V1.version);
    expect(await deps.queue.size()).toBe(1);
    const received = await deps.queue.receive(10);
    expect(received[0]!.job.kind).toBe("media.purge");
    expect(received[0]!.job.payload).toEqual({ mediaAssetId: id });
    expect((await assetRow(sibling)).status).toBe("ready");
    expect((await assetRow(future)).status).toBe("ready");

    // The purge job itself completes and the object is gone.
    const outcome = await handleJob(deps, received[0]!.job);
    expect(outcome.handled).toBe(true);
    expect(deps.store.keys.has(key)).toBe(false);
    expect((await assetRow(id)).object_key).toBeNull();
  });

  it("S2b: expires_at exactly at now() (same-transaction equality) counts as expired (<=)", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, expires_at)
         VALUES (NULL, 'drill_video', 'b', $1, 'ready', now())
         RETURNING (expires_at <= now()) AS expired_now`,
        [`media/attack3/s2b/${randomUUID()}`],
      );
      expect(res.rows[0].expired_now).toBe(true);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  // ---------------------------------------------------------------------------
  // S3 — status='deleted' with deleted_at NULL
  // ---------------------------------------------------------------------------
  it("[BROKEN] S3: status='deleted' + deleted_at NULL is refused by media.purge (acked) AND skipped by the sweep — object lives forever", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const key = `media/attack3/s3/${randomUUID()}`;
    deps.store.keys.add(key);
    // No CHECK constraint prevents this state.
    const id = await insertAsset({ objectKey: key, status: "deleted", deletedAt: null });

    const outcome = await handleJob(deps, {
      id: "j-s3",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    // Observed: handled=true → the job is ACKED and dropped from the queue.
    expect(outcome.handled).toBe(true);
    expect(outcome.note).toContain("purge refused");
    expect(deps.store.deleteCalls).toHaveLength(0);

    // Sweep: deleted_at IS NULL → not selected.
    expect(await sweepDeletedMedia(deps)).toBe(0);
    expect(deps.store.deleteCalls).toHaveLength(0);

    // Retention: kind raw_video is user_controlled, owner has no window → untouched.
    expect(await enforceMediaRetention(deps)).toBe(0);

    // runOnce end-to-end: still nothing.
    await deps.queue.enqueue("media.purge", { mediaAssetId: id });
    const result = await runOnce(deps);
    expect(result.jobs).toBe(1); // acked
    expect(result.swept).toBe(0);
    expect(await deps.queue.size()).toBe(0);

    const row = await assetRow(id);
    expect(row.status).toBe("deleted");
    expect(row.deleted_at).toBeNull();
    expect(row.object_key).toBe(key);
    expect(deps.store.keys.has(key)).toBe(true);
  });

  it("S3b: schema has no CHECK tying status='deleted' to deleted_at (the inconsistent row is insertable)", async () => {
    const { rows } = await pool.query(
      `SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
       WHERE conrelid = ($1 || '.media_asset')::regclass AND contype = 'c'`,
      [schemaName],
    );
    const defs = (rows as Array<{ def: string }>).map((r) => r.def);
    expect(defs.some((d) => d.includes("deleted_at"))).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // S4 — exact boundary of the owner retention window
  // ---------------------------------------------------------------------------
  it("S4: created_at = now() - 7d with retention 7 expires; +1h younger sibling, retention 0 and NULL owners do not", async () => {
    const deps = makeDeps();
    const owner7 = await createOwner(`auth0|attack3-r7-${randomUUID()}`, 7);
    const owner0 = await createOwner(`auth0|attack3-r0-${randomUUID()}`, 0);
    const ownerNull = await createOwner(`auth0|attack3-rnull-${randomUUID()}`, null);

    const boundary = await insertAsset({
      ownerId: owner7,
      objectKey: `media/attack3/s4/boundary-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '7 days'",
    });
    const justInside = await insertAsset({
      ownerId: owner7,
      objectKey: `media/attack3/s4/inside-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '7 days' + interval '1 hour'",
    });
    const zeroOwner = await insertAsset({
      ownerId: owner0,
      objectKey: `media/attack3/s4/zero-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '5000 days'",
    });
    const nullOwner = await insertAsset({
      ownerId: ownerNull,
      objectKey: `media/attack3/s4/null-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '5000 days'",
    });
    const noSettingsOwner = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`auth0|attack3-nosettings-${randomUUID()}`],
    );
    const noSettings = await insertAsset({
      ownerId: noSettingsOwner.rows[0].id as string,
      objectKey: `media/attack3/s4/nosettings-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '5000 days'",
    });

    const expired = await enforceMediaRetention(deps, MEDIA_RETENTION_POLICY_V1);
    expect(expired).toBe(1);
    expect((await assetRow(boundary)).status).toBe("deleted");
    expect((await assetRow(justInside)).status).toBe("ready");
    expect((await assetRow(zeroOwner)).status).toBe("ready");
    expect((await assetRow(nullOwner)).status).toBe("ready");
    expect((await assetRow(noSettings)).status).toBe("ready");
    expect(await purgeAudits(boundary)).toHaveLength(1);

    // Then flip the boundary owner's retention to 0 and NULL: a fresh sibling
    // at the same age must NOT expire under either value.
    for (const value of [0, null]) {
      await pool.query(
        "UPDATE user_setting SET local_video_retention_days = $2 WHERE user_id = $1",
        [owner7, value],
      );
      const sib = await insertAsset({
        ownerId: owner7,
        objectKey: `media/attack3/s4/sib-${String(value)}-${randomUUID()}`,
        status: "ready",
        createdAtSql: "now() - interval '7 days'",
      });
      expect(await enforceMediaRetention(deps, MEDIA_RETENTION_POLICY_V1)).toBe(0);
      expect((await assetRow(sib)).status).toBe("ready");
    }
  });

  it("S4b: SQL predicate at exact equality (same transaction) is inclusive; negative retention never expires", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const eq = await client.query(
        `SELECT (now() - make_interval(days => 7)) + make_interval(days => 7) <= now() AS at_boundary,
                (now() - make_interval(days => 7) + interval '1 microsecond') + make_interval(days => 7) <= now() AS one_us_inside`,
      );
      expect(eq.rows[0].at_boundary).toBe(true);
      expect(eq.rows[0].one_us_inside).toBe(false);
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const deps = makeDeps();
    const ownerNeg = await createOwner(`auth0|attack3-rneg-${randomUUID()}`, -1);
    const neg = await insertAsset({
      ownerId: ownerNeg,
      objectKey: `media/attack3/s4b/neg-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '5000 days'",
    });
    expect(await enforceMediaRetention(deps, MEDIA_RETENTION_POLICY_V1)).toBe(0);
    expect((await assetRow(neg)).status).toBe("ready");
  });

  // ---------------------------------------------------------------------------
  // S5 — ack() throws after a successful purge
  // ---------------------------------------------------------------------------
  it("S5: ack() throwing after a successful purge → redelivered job reports 'no object to delete' with no second deleteObject", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const inner = new InMemoryJobQueue();
    let ackThrows = true;
    const wrapped: IJobQueue = {
      enqueue: (k, p) => inner.enqueue(k, p),
      size: () => inner.size(),
      oldestJobAgeMs: () => inner.oldestJobAgeMs(),
      receive: async (max) =>
        (await inner.receive(max)).map(({ job, ack }) => ({
          job,
          ack: async () => {
            if (ackThrows) {
              ackThrows = false;
              throw new Error("ReceiptHandleIsInvalid: The receipt handle has expired");
            }
            await ack();
          },
        })),
    };
    const deps = makeDeps({ queue: wrapped });
    const key = `media/attack3/s5/${randomUUID()}`;
    deps.store.keys.add(key);
    deps.store.keys.add(`${key}/normalized.mp4`);
    const id = await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });
    await inner.enqueue("media.purge", { mediaAssetId: id });

    // Cycle 1: purge succeeds, ack throws.
    let cycleError: unknown = null;
    try {
      await runOnce(deps);
    } catch (error) {
      cycleError = error;
    }
    const deletesAfterFirst = deps.store.deleteCalls.length;
    expect(deletesAfterFirst).toBe(2);
    expect((await assetRow(id)).object_key).toBeNull();

    // Observed (documented, see finding): the ack exception escapes runOnce —
    // the cycle aborts before processDeletionTasks/enforceMediaRetention/
    // sweepDeletedMedia and before analytics flush.
    expect(cycleError).toBeInstanceOf(Error);
    expect(String(cycleError)).toContain("ReceiptHandleIsInvalid");

    // Visibility timeout expires → redelivery.
    inner.expireInFlight();
    const result = await runOnce(deps);
    expect(result.jobs).toBe(1);
    expect(deps.logs.some((l) => l.includes("no object to delete"))).toBe(true);
    expect(deps.store.deleteCalls.length).toBe(deletesAfterFirst);
    expect(await inner.size()).toBe(0);
  });

  it("[BROKEN] S5b: one expired receipt handle aborts the whole batch — later jobs in the same receive are not processed that cycle and the maintenance sweeps are skipped", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const inner = new InMemoryJobQueue();
    let ackCalls = 0;
    const wrapped: IJobQueue = {
      enqueue: (k, p) => inner.enqueue(k, p),
      size: () => inner.size(),
      oldestJobAgeMs: () => inner.oldestJobAgeMs(),
      receive: async (max) =>
        (await inner.receive(max)).map(({ job, ack }) => ({
          job,
          ack: async () => {
            ackCalls++;
            if (ackCalls === 1) throw new Error("ReceiptHandleIsInvalid");
            await ack();
          },
        })),
    };
    const deps = makeDeps({ queue: wrapped });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const key = `media/attack3/s5b/${i}-${randomUUID()}`;
      deps.store.keys.add(key);
      ids.push(await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() }));
      await inner.enqueue("media.purge", { mediaAssetId: ids[i]! });
    }
    // A row only the sweep would reconcile (no job for it).
    const sweepOnlyKey = `media/attack3/s5b/sweep-${randomUUID()}`;
    deps.store.keys.add(sweepOnlyKey);
    const sweepOnly = await insertAsset({
      objectKey: sweepOnlyKey,
      status: "deleted",
      deletedAt: new Date(),
    });

    await expect(runOnce(deps)).rejects.toThrow("ReceiptHandleIsInvalid");
    // Only job #1 ran; #2 and #3 untouched this cycle; sweep did not run.
    expect((await assetRow(ids[0]!)).object_key).toBeNull();
    expect((await assetRow(ids[1]!)).object_key).not.toBeNull();
    expect((await assetRow(ids[2]!)).object_key).not.toBeNull();
    expect((await assetRow(sweepOnly)).object_key).toBe(sweepOnlyKey);

    // Recovery on the next cycle is complete.
    inner.expireInFlight();
    const result = await runOnce(deps);
    expect(result.jobs).toBe(3);
    expect(result.swept).toBe(1);
    expect((await assetRow(sweepOnly)).object_key).toBeNull();
    expect(await inner.size()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // S6 — enqueue throws inside enforceMediaRetention
  // ---------------------------------------------------------------------------
  it("S6: queue.enqueue throwing → every expired id is still audited + marked deleted, then purged by the same-cycle sweep", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const inner = new InMemoryJobQueue();
    let enqueueAttempts = 0;
    const broken: IJobQueue = {
      enqueue: async () => {
        enqueueAttempts++;
        throw new Error("SQS unavailable");
      },
      receive: (max) => inner.receive(max),
      size: () => inner.size(),
      oldestJobAgeMs: () => inner.oldestJobAgeMs(),
    };
    const deps = makeDeps({ queue: broken });
    const ownerId = await createOwner(`auth0|attack3-s6-${randomUUID()}`, 3);
    const rng = seededRandom(SEED);
    const expected: Array<{ id: string; key: string }> = [];
    for (let i = 0; i < 7; i++) {
      const key = `media/attack3/s6/${i}-${randomUUID()}`;
      deps.store.keys.add(key);
      deps.store.keys.add(`${key}/thumb.jpg`);
      const age = 4 + Math.floor(rng() * 300);
      const id = await insertAsset({
        ownerId,
        objectKey: key,
        status: "ready",
        createdAtSql: `now() - interval '${age} days'`,
      });
      expected.push({ id, key });
    }
    const live = await insertAsset({
      ownerId,
      objectKey: `media/attack3/s6/live-${randomUUID()}`,
      status: "ready",
    });

    const result = await runOnce(deps);
    expect(result.expired).toBe(7);
    expect(enqueueAttempts).toBe(7);
    expect(deps.logs.filter((l) => l.includes("media.purge dispatch")).length).toBe(7);
    expect(result.swept).toBe(7);
    for (const { id, key } of expected) {
      const row = await assetRow(id);
      expect(row.status).toBe("deleted");
      expect(row.deleted_at).not.toBeNull();
      expect(row.object_key).toBeNull();
      expect(await purgeAudits(id)).toHaveLength(1);
      expect(deps.store.keys.has(key)).toBe(false);
      expect(deps.store.keys.has(`${key}/thumb.jpg`)).toBe(false);
    }
    expect((await assetRow(live)).status).toBe("ready");
  });

  // ---------------------------------------------------------------------------
  // S7 — 2,500 derived keys with a mid-listing failure
  // ---------------------------------------------------------------------------
  it("S7: 2,500 derived keys, deleteObject fails on key #1,200 → unhandled, object_key kept; retry deletes only what remains (no re-deletes)", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const master = `media/attack3/s7/${randomUUID()}`;
    const derived: string[] = [];
    for (let i = 0; i < 2500; i++) {
      const k = `${master}/derived-${String(i).padStart(5, "0")}.bin`;
      derived.push(k);
      deps.store.keys.add(k);
    }
    deps.store.keys.add(master);
    // Sorted listing order == insertion order here; key #1,200 is index 1199.
    const failingKey = derived[1199]!;
    deps.store.failing.add(failingKey);
    const id = await insertAsset({ objectKey: master, status: "deleted", deletedAt: new Date() });

    const first = await handleJob(deps, {
      id: "j-s7",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    expect(first.handled).toBe(false);
    expect(first.note).toContain("object store purge failed");
    expect(deps.store.deleteCalls.length).toBe(1200);
    expect(deps.store.keys.size).toBe(2500 + 1 - 1199);
    expect((await assetRow(id)).object_key).toBe(master);
    // Master is deleted LAST, so it still exists (the row still points at it).
    expect(deps.store.keys.has(master)).toBe(true);

    // Storage recovers; retry (attempt 2).
    deps.store.failing.clear();
    const second = await handleJob(deps, {
      id: "j-s7",
      kind: "media.purge",
      attempt: 2,
      payload: { mediaAssetId: id },
    });
    expect(second.handled).toBe(true);
    expect(second.note).toContain("object deleted (1302 artifact(s)");
    expect(deps.store.keys.size).toBe(0);
    expect((await assetRow(id)).object_key).toBeNull();
    // No successfully-removed key was ever re-deleted (listing reflects
    // deletions); only the key that failed is attempted a second time.
    const counts = new Map<string, number>();
    for (const k of deps.store.deleteCalls) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect(counts.get(failingKey)).toBe(2);
    counts.delete(failingKey);
    expect([...counts.values()].every((n) => n === 1)).toBe(true);
    expect(deps.store.deleteCalls.length).toBe(2502);
  });

  it("S7b: with an eventually-consistent (stale) listing the retry re-issues deletes for already-removed keys (idempotent on S3, but 1,199 wasted calls)", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    deps.store.staleListing = true;
    const master = `media/attack3/s7b/${randomUUID()}`;
    for (let i = 0; i < 2500; i++)
      deps.store.keys.add(`${master}/derived-${String(i).padStart(5, "0")}.bin`);
    deps.store.keys.add(master);
    const failingKey = `${master}/derived-01199.bin`;
    deps.store.failing.add(failingKey);
    const id = await insertAsset({ objectKey: master, status: "deleted", deletedAt: new Date() });

    const first = await handleJob(deps, {
      id: "j-s7b",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    expect(first.handled).toBe(false);
    deps.store.failing.clear();
    const second = await handleJob(deps, {
      id: "j-s7b",
      kind: "media.purge",
      attempt: 2,
      payload: { mediaAssetId: id },
    });
    expect(second.handled).toBe(true);
    expect(deps.store.keys.size).toBe(0);
    expect(deps.store.deleteCalls.length).toBe(1200 + 2501);
    expect(deps.store.timesDeleted(`${master}/derived-00000.bin`)).toBe(2);
  });

  // ---------------------------------------------------------------------------
  // Extra scenarios
  // ---------------------------------------------------------------------------
  it("X1: sibling asset whose master key is nested under another master's prefix is deleted by the parent's purge (prefix collision)", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const parentKey = `media/attack3/x1/${randomUUID()}`;
    const childKey = `${parentKey}/child-master`;
    deps.store.keys.add(parentKey);
    deps.store.keys.add(childKey);
    const parent = await insertAsset({
      objectKey: parentKey,
      status: "deleted",
      deletedAt: new Date(),
    });
    const child = await insertAsset({ objectKey: childKey, status: "ready" });
    const outcome = await handleJob(deps, {
      id: "j-x1",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: parent },
    });
    expect(outcome.handled).toBe(true);
    // The LIVE child asset's bytes are gone while its row still says ready.
    expect(deps.store.keys.has(childKey)).toBe(false);
    const childRow = await assetRow(child);
    expect(childRow.status).toBe("ready");
    expect(childRow.object_key).toBe(childKey);
    // Reachability note: the API mints keys as media/<user>/<48 hex>, so no
    // API-minted key can be a prefix of another; this documents the
    // implicit invariant the purge relies on.
  });

  it("X2: unicode / whitespace / percent-encoded derived keys are listed and deleted; a prefix-similar key without the slash is untouched", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const master = `media/attack3/x2/ピクル ${randomUUID()}`;
    const odd = [
      `${master}/派生 ビデオ.mp4`,
      `${master}/thumb%20nail.jpg`,
      `${master}/ /space.bin`,
      `${master}/\u0000nul`,
      `${master}/${"x".repeat(900)}`,
    ];
    for (const k of odd) deps.store.keys.add(k);
    deps.store.keys.add(master);
    const lookalike = `${master}-other`;
    deps.store.keys.add(lookalike);
    const id = await insertAsset({ objectKey: master, status: "deleted", deletedAt: new Date() });
    const outcome = await handleJob(deps, {
      id: "j-x2",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    expect(outcome.handled).toBe(true);
    for (const k of odd) expect(deps.store.keys.has(k)).toBe(false);
    expect(deps.store.keys.has(master)).toBe(false);
    expect(deps.store.keys.has(lookalike)).toBe(true);
  });

  it("X3: two workers sweeping the same deleted row concurrently both succeed; the row ends nulled once and the object is deleted (double delete is harmless)", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const a = makeDeps();
    const b = makeDeps({ objectStore: a.store });
    const key = `media/attack3/x3/${randomUUID()}`;
    a.store.keys.add(key);
    const id = await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });
    const [sa, sb] = await Promise.all([sweepDeletedMedia(a), sweepDeletedMedia(b)]);
    expect(sa + sb).toBeGreaterThanOrEqual(1);
    expect((await assetRow(id)).object_key).toBeNull();
    expect(a.store.keys.has(key)).toBe(false);
    expect(a.store.timesDeleted(key)).toBeLessThanOrEqual(2);
  });

  it("X4: retention expiry racing a purge of the same asset: deleted_at set once, exactly one audit row, purge completes", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const key = `media/attack3/x4/${randomUUID()}`;
    deps.store.keys.add(key);
    const id = await insertAsset({
      ownerId: null,
      kind: "share_video",
      objectKey: key,
      status: "ready",
      createdAtSql: "now() - interval '31 days'",
    });
    const [e1, e2, e3] = await Promise.all([
      enforceMediaRetention(deps),
      enforceMediaRetention(deps),
      enforceMediaRetention(deps),
    ]);
    expect(e1 + e2 + e3).toBe(1);
    expect(await purgeAudits(id)).toHaveLength(1);
    expect(await deps.queue.size()).toBe(1);
    const result = await runOnce(deps);
    expect(result.jobs).toBe(1);
    expect((await assetRow(id)).object_key).toBeNull();
    expect(deps.store.keys.has(key)).toBe(false);
  });

  it("X5: poison purge payloads (non-uuid id, missing id, null payload) never crash runOnce; malformed ids stay on the queue (relies on SQS DLQ maxReceiveCount=5)", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    await deps.queue.enqueue("media.purge", { mediaAssetId: "not-a-uuid" });
    await deps.queue.enqueue("media.purge", {});
    await deps.queue.enqueue("media.purge", null);
    await deps.queue.enqueue("media.purge", { mediaAssetId: randomUUID() });
    const result = await runOnce(deps);
    // not-a-uuid → pg 22P02 → handler threw → unhandled (stays in flight);
    // {} → id NULL → not found → handled; null payload → destructuring throws
    // → unhandled; random uuid → not found → handled.
    expect(result.jobs).toBe(2);
    expect(deps.logs.filter((l) => l.includes("handler threw")).length).toBe(2);
    deps.queue.expireInFlight();
    expect(await deps.queue.size()).toBe(2);
    // Redelivery loops forever in the in-memory queue (no attempt cap in
    // the worker); with SqsJobQueue the terraform redrive policy parks it
    // in the DLQ after 5 receives.
    for (let i = 0; i < 6; i++) {
      const r = await runOnce(deps);
      expect(r.jobs).toBe(0);
      deps.queue.expireInFlight();
    }
    expect(await deps.queue.size()).toBe(2);
  });

  it("X6: media.purge on a deleted row whose object_key has a trailing slash lists the prefix once (no infinite/double-slash listing) and deletes the master", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const key = `media/attack3/x6/${randomUUID()}/`;
    deps.store.keys.add(key);
    deps.store.keys.add(`${key}/derived`);
    const id = await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });
    const outcome = await handleJob(deps, {
      id: "j-x6",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    expect(outcome.handled).toBe(true);
    expect(deps.store.listCalls).toEqual([`${key}/`]);
    expect(deps.store.keys.size).toBe(0);
  });

  it("X7: sweep with 120 healthy deleted rows drains in exactly 3 cycles (LIMIT 50) and never touches live rows", async () => {
    await pool.query("UPDATE media_asset SET object_key = NULL WHERE deleted_at IS NOT NULL");
    const deps = makeDeps();
    const liveKey = `media/attack3/x7/live-${randomUUID()}`;
    deps.store.keys.add(liveKey);
    await insertAsset({ objectKey: liveKey, status: "ready" });
    for (let i = 0; i < 120; i++) {
      const key = `media/attack3/x7/${i}-${randomUUID()}`;
      deps.store.keys.add(key);
      await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });
    }
    expect(await sweepDeletedMedia(deps)).toBe(50);
    expect(await sweepDeletedMedia(deps)).toBe(50);
    expect(await sweepDeletedMedia(deps)).toBe(20);
    expect(await sweepDeletedMedia(deps)).toBe(0);
    expect(deps.store.keys.has(liveKey)).toBe(true);
    expect(deps.store.keys.size).toBe(1);
  });

  it("X8: listObjects permission denial (ListBucket) makes purge unhandled without touching the master; once listing works the retry completes", async () => {
    const deps = makeDeps();
    const key = `media/attack3/x8/${randomUUID()}`;
    deps.store.keys.add(key);
    deps.store.keys.add(`${key}/derived/a.mp4`);
    const id = await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });
    const realList = deps.store.listObjects.bind(deps.store);
    let denyList = true;
    deps.store.listObjects = async (prefix: string) => {
      if (denyList) throw new Error("AccessDenied: s3:ListBucket");
      return realList(prefix);
    };

    const first = await handleJob(deps, {
      id: "j-x8",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    expect(first.handled).toBe(false);
    expect(deps.store.deleteCalls).toHaveLength(0);
    expect((await assetRow(id)).object_key).toBe(key);

    denyList = false;
    const second = await handleJob(deps, {
      id: "j-x8",
      kind: "media.purge",
      attempt: 2,
      payload: { mediaAssetId: id },
    });
    expect(second.handled).toBe(true);
    expect(deps.store.deleteCalls).toEqual([`${key}/derived/a.mp4`, key]);
    expect((await assetRow(id)).object_key).toBeNull();
  });

  it("X9: master delete fails after all derived succeeded → unhandled, object_key kept; retry lists nothing and deletes just the master", async () => {
    const deps = makeDeps();
    const key = `media/attack3/x9/${randomUUID()}`;
    deps.store.keys.add(key);
    for (let i = 0; i < 5; i++) deps.store.keys.add(`${key}/d${i}`);
    deps.store.failing.add(key);
    const id = await insertAsset({ objectKey: key, status: "deleted", deletedAt: new Date() });

    const first = await handleJob(deps, {
      id: "j-x9",
      kind: "media.purge",
      attempt: 1,
      payload: { mediaAssetId: id },
    });
    expect(first.handled).toBe(false);
    expect(deps.store.deleteCalls).toHaveLength(6);
    expect((await assetRow(id)).object_key).toBe(key);
    expect([...deps.store.keys]).toEqual([key]);

    deps.store.failing.clear();
    deps.store.deleteCalls = [];
    const second = await handleJob(deps, {
      id: "j-x9",
      kind: "media.purge",
      attempt: 2,
      payload: { mediaAssetId: id },
    });
    expect(second.handled).toBe(true);
    expect(deps.store.deleteCalls).toEqual([key]);
    expect(deps.store.keys.size).toBe(0);
    expect((await assetRow(id)).object_key).toBeNull();
  });

  it("X10: clock skew — future expires_at and future created_at never expire; a 100-year-old row with retention 1 does", async () => {
    const deps = makeDeps();
    const owner = await createOwner(`auth0|attack3-x10-${randomUUID()}`, 1);
    const futureExplicit = await insertAsset({
      ownerId: owner,
      kind: "drill_video",
      objectKey: `media/attack3/x10/fe-${randomUUID()}`,
      status: "ready",
      expiresAtSql: "now() + interval '2 seconds'",
    });
    const futureCreated = await insertAsset({
      ownerId: owner,
      objectKey: `media/attack3/x10/fc-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() + interval '1 day'",
    });
    const ancient = await insertAsset({
      ownerId: owner,
      objectKey: `media/attack3/x10/old-${randomUUID()}`,
      status: "ready",
      createdAtSql: "now() - interval '100 years'",
    });
    const expired = await enforceMediaRetention(deps);
    expect(expired).toBe(1);
    expect(await purgeAudits(ancient)).toHaveLength(1);
    expect((await assetRow(futureExplicit)).deleted_at).toBeNull();
    expect((await assetRow(futureCreated)).deleted_at).toBeNull();
    expect((await assetRow(ancient)).status).toBe("deleted");
  });
});
