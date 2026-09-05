import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  deletionBacklog,
  processDeletionTasks,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * Adjudication (storage-media-worker, baseline 4d812e1a): independent
 * reproduction of SMW-01 against a REAL PostgreSQL database in an isolated
 * schema — the deletion workflow's own promise (every task terminal, no
 * account starved) stated as tests. At the baseline both cases FAIL; the
 * fix is accepted when the file passes unchanged. The remaining P2 cases of
 * the adjudication (SMW-02..11) live on branch
 * devin/adjudicate-storage-media-worker until each is fixed.
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
});
