import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  processDeletionTasks,
  sweepDeletedMedia,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * INT-deletion-managed-media adversary (attack branch only). Probes the
 * media-worker deletion workflow against a REAL PostgreSQL schema built from
 * packages/database migrations:
 *   - owner isolation of media_purge (another owner's live and soft-deleted
 *     assets must survive),
 *   - per-clip deletion vs referenced originals (a media_asset referenced by
 *     drill / ml_dataset_item / pro_reference with FK NO ACTION),
 *   - sweep page cap (LIMIT 50) with a poison object,
 *   - restart mid-deletion at the final_hard_delete step.
 * Nothing here fixes behaviour; failures are evidence for the coordinator.
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `adv_deletion_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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
  poison = new Set<string>();
  async deleteObject(key: string): Promise<void> {
    if (this.poison.has(key)) throw new Error(`poison object ${key}`);
    this.keys.delete(key);
    this.deletedKeys.push(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

describe.skipIf(!testUrl)("ADV deletion: owner isolation + referenced originals", () => {
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
    return Object.assign(deps, { store }) as WorkerDeps & { store: FakeStore };
  }

  async function newUser(status: "active" | "deleted" = "deleted"): Promise<string> {
    const row = await pool.query(
      "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, $2, $3) RETURNING id",
      [`auth0|adv-${randomUUID()}`, status, status === "deleted" ? new Date() : null],
    );
    return row.rows[0].id as string;
  }

  async function newAsset(
    owner: string,
    store: FakeStore,
    opts: { deleted?: boolean; status?: string } = {},
  ): Promise<{ id: string; key: string }> {
    const key = `media/adv/${owner}/${randomUUID()}`;
    store.keys.add(key);
    const row = await pool.query(
      `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', $2, $3, $4) RETURNING id`,
      [
        owner,
        key,
        opts.status ?? (opts.deleted ? "deleted" : "ready"),
        opts.deleted ? new Date() : null,
      ],
    );
    return { id: row.rows[0].id as string, key };
  }

  async function taskStatuses(
    userId: string,
  ): Promise<Record<string, { status: string; attempts: number; detail: unknown }>> {
    const rows = await pool.query(
      "SELECT kind, status, attempts, detail FROM deletion_task WHERE user_id = $1",
      [userId],
    );
    return Object.fromEntries(
      (rows.rows as Array<{ kind: string; status: string; attempts: number; detail: unknown }>).map(
        (r) => [r.kind, r],
      ),
    );
  }

  async function drainDeletion(deps: WorkerDeps, cycles: number): Promise<void> {
    for (let i = 0; i < cycles; i++) await processDeletionTasks(deps);
  }

  it("ATTACK owner isolation: purging owner A never touches owner B's live or soft-deleted objects", async () => {
    const deps = makeDeps();
    const a = await newUser();
    const b = await newUser("active");
    const aLive = await newAsset(a, deps.store);
    const aSoft = await newAsset(a, deps.store, { deleted: true });
    const bLive = await newAsset(b, deps.store);
    // B soft-deleted its own clip but its purge is B's business, not A's task.
    const bSoft = await newAsset(b, deps.store, { deleted: true });
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [a]);

    await processDeletionTasks(deps);

    expect((await taskStatuses(a))["media_purge"]!.status).toBe("done");
    expect(deps.store.keys.has(aLive.key)).toBe(false);
    expect(deps.store.keys.has(aSoft.key)).toBe(false);
    expect(deps.store.keys.has(bLive.key)).toBe(true);
    expect(deps.store.keys.has(bSoft.key)).toBe(true);
    const bRows = await pool.query(
      "SELECT id, object_key, status FROM media_asset WHERE owner_user_id = $1 ORDER BY id",
      [b],
    );
    expect(bRows.rowCount).toBe(2);
    for (const row of bRows.rows as Array<{ object_key: string | null }>) {
      expect(row.object_key).not.toBeNull();
    }
    expect(
      (await pool.query("SELECT status FROM media_asset WHERE id = $1", [bLive.id])).rows[0].status,
    ).toBe("ready");
  });

  it("ATTACK referenced original (drill): account hard-delete must not stall on a clip a drill references", async () => {
    const deps = makeDeps();
    const owner = await newUser();
    const asset = await newAsset(owner, deps.store);
    await pool.query(
      "INSERT INTO drill (slug, title, media_asset_id) VALUES ($1, 'adv drill', $2)",
      [`adv-drill-${randomUUID()}`, asset.id],
    );
    for (const kind of [
      "media_purge",
      "ml_dataset_review",
      "social_cleanup",
      "idp_revoke",
      "final_hard_delete",
    ]) {
      await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [owner, kind]);
    }

    await drainDeletion(deps, DELETION_TASK_MAX_ATTEMPTS + 2);

    const statuses = await taskStatuses(owner);
    const remaining = await pool.query("SELECT id FROM app_user WHERE id = $1", [owner]);
    // Expected on a supported deletion path: the account row is gone (the
    // referenced original either detaches or survives ownerless), never a
    // permanently 'failed' final_hard_delete with the personal row retained.
    expect(remaining.rowCount).toBe(0);
    expect(statuses["final_hard_delete"]!.status).toBe("done");
  });

  it("OBSERVED referenced original (drill): FK NO ACTION makes final_hard_delete fail until the attempt cap", async () => {
    const deps = makeDeps();
    const owner = await newUser();
    const asset = await newAsset(owner, deps.store);
    await pool.query(
      "INSERT INTO drill (slug, title, media_asset_id) VALUES ($1, 'adv drill', $2)",
      [`adv-drill-${randomUUID()}`, asset.id],
    );
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [
      owner,
    ]);
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'final_hard_delete')", [
      owner,
    ]);

    await drainDeletion(deps, DELETION_TASK_MAX_ATTEMPTS + 2);

    const statuses = await taskStatuses(owner);
    expect(statuses["media_purge"]!.status).toBe("done");
    // The purge already nulled the object key the drill pointed at, so the
    // shared reference is broken while the personal row still exists.
    const drill = await pool.query(
      "SELECT ma.object_key, ma.status FROM drill d JOIN media_asset ma ON ma.id = d.media_asset_id WHERE d.media_asset_id = $1",
      [asset.id],
    );
    expect(drill.rows[0].object_key).toBeNull();
    expect(statuses["final_hard_delete"]!.status).toBe("failed");
    expect(statuses["final_hard_delete"]!.attempts).toBe(DELETION_TASK_MAX_ATTEMPTS);
    expect(JSON.stringify(statuses["final_hard_delete"]!.detail)).toMatch(/foreign key|violates/i);
    expect((await pool.query("SELECT id FROM app_user WHERE id = $1", [owner])).rowCount).toBe(1);
  });

  it("ATTACK consented dataset item: ml_dataset_review only stamps removed_at, so hard-delete must still complete", async () => {
    const deps = makeDeps();
    const owner = await newUser();
    const asset = await newAsset(owner, deps.store);
    await pool.query(
      `INSERT INTO ml_dataset_item (source_user_id, media_asset_id, consent_version)
       VALUES ($1, $2, 'v1')`,
      [owner, asset.id],
    );
    for (const kind of ["media_purge", "ml_dataset_review", "final_hard_delete"]) {
      await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, $2)", [owner, kind]);
    }

    await drainDeletion(deps, DELETION_TASK_MAX_ATTEMPTS + 2);

    const statuses = await taskStatuses(owner);
    expect(statuses["ml_dataset_review"]!.status).toBe("done");
    // Migration 0019 cascades dataset items with their media row; either the
    // item is gone or it is stamped removed — never a live training row.
    const item = await pool.query(
      "SELECT removed_at FROM ml_dataset_item WHERE media_asset_id = $1 AND removed_at IS NULL",
      [asset.id],
    );
    expect(item.rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM app_user WHERE id = $1", [owner])).rowCount).toBe(0);
    expect(statuses["final_hard_delete"]!.status).toBe("done");
  });

  it("ATTACK sweep page cap: 60 soft-deleted clips with one poison object all purge within bounded sweeps", async () => {
    const deps = makeDeps();
    const owner = await newUser("active");
    const assets: Array<{ id: string; key: string }> = [];
    for (let i = 0; i < 60; i++) assets.push(await newAsset(owner, deps.store, { deleted: true }));
    deps.store.poison.add(assets[0]!.key);

    // LIMIT 50 per sweep and the poison row stays eligible forever: it must
    // never starve the other 59 rows, which need at most ceil(60/50)+1 sweeps.
    let swept = 0;
    for (let i = 0; i < 3; i++) swept += await sweepDeletedMedia(deps);

    const remaining = await pool.query(
      "SELECT id, object_key FROM media_asset WHERE owner_user_id = $1 AND object_key IS NOT NULL",
      [owner],
    );
    // Soft-deleted rows left behind by other cases in this schema may also be
    // swept, so the count is a floor; the owner-scoped remainder is exact.
    expect(swept).toBeGreaterThanOrEqual(59);
    expect(remaining.rowCount).toBe(1);
    expect(remaining.rows[0].id).toBe(assets[0]!.id);
    expect(deps.store.keys.size).toBe(1);
  });

  it("ATTACK restart mid-deletion: final_hard_delete left 'processing' by a crash still waits for outstanding steps", async () => {
    const deps = makeDeps({ objectStore: null });
    const owner = await newUser();
    await newAsset(owner, new FakeStore());
    await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'media_purge')", [
      owner,
    ]);
    // Crash left the terminal step claimed but not executed.
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1, 'final_hard_delete', 'processing')",
      [owner],
    );

    await drainDeletion(deps, 3);

    const statuses = await taskStatuses(owner);
    expect(statuses["media_purge"]!.status).toBe("queued");
    expect(statuses["final_hard_delete"]!.status).toBe("queued");
    expect((await pool.query("SELECT id FROM app_user WHERE id = $1", [owner])).rowCount).toBe(1);

    // Store comes back: the whole chain finishes without operator action.
    const recovered = makeDeps();
    const assets = await pool.query("SELECT object_key FROM media_asset WHERE owner_user_id = $1", [
      owner,
    ]);
    for (const row of assets.rows as Array<{ object_key: string }>)
      recovered.store.keys.add(row.object_key);
    await drainDeletion(recovered, 3);
    const after = await taskStatuses(owner);
    expect(after["media_purge"]!.status).toBe("done");
    expect(after["final_hard_delete"]!.status).toBe("done");
    expect((await pool.query("SELECT id FROM app_user WHERE id = $1", [owner])).rowCount).toBe(0);
    expect(recovered.store.keys.size).toBe(0);
  });
});
