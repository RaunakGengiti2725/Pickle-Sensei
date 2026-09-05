import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_MAX_ATTEMPTS,
  DELETION_TASK_WINDOW,
  processDeletionTasks,
  type ObjectDeleter,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * SMW-01 acceptance #3 (triage pin): after DELETION_TASK_WINDOW fully
 * processed account deletions, the worker's own selection window contains no
 * idp_revoke row — a step the worker cannot perform is terminal, never a
 * permanently re-queued row that fills the window. The window query mirrors
 * processDeletionTasks' WHERE clause exactly.
 *
 *   DATABASE_URL_TEST=postgres://pickle:pickle_test_password@localhost:5433/pickle_test \
 *     pnpm --filter @pickle/media-worker exec vitest run test/smw01-selection-window.test.ts
 */

const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `smw01_win_${process.pid}_${randomUUID().replaceAll("-", "")}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

const SELECTION_WINDOW_BY_KIND = `
  SELECT kind, count(*)::int AS n FROM (
    SELECT id, kind FROM deletion_task
    WHERE status IN ('queued','processing')
       OR (status = 'failed' AND attempts < $1)
    ORDER BY created_at LIMIT $2
  ) w GROUP BY kind ORDER BY kind`;

function schemaUrl(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

class FakeStore implements ObjectDeleter {
  keys = new Set<string>();
  async deleteObject(key: string): Promise<void> {
    this.keys.delete(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

describe.skipIf(!testUrl)("SMW-01: deletion selection window is never filled by idp_revoke", () => {
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
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|smw01-${tag}-${randomUUID()}`,
    ]);
    return user.rows[0].id as string;
  }

  /** Mirrors services/api DELETE /v1/me: the four tasks it enqueues, in order. */
  async function requestAccountDeletion(userId: string, createdAt: Date): Promise<void> {
    await pool.query("UPDATE app_user SET status = 'deleted', deleted_at = now() WHERE id = $1", [
      userId,
    ]);
    const kinds = ["media_purge", "ml_dataset_review", "idp_revoke", "final_hard_delete"];
    for (const [i, kind] of kinds.entries()) {
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, $2, $3)",
        [userId, kind, new Date(createdAt.getTime() + i * 10)],
      );
    }
  }

  it("after WINDOW fully processed deletions the selection window holds no idp_revoke rows", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps: WorkerDeps = {
      pool,
      queue: new InMemoryJobQueue(),
      objectStore: new FakeStore(),
      transcoder: null,
      log: () => {},
    };
    const old = Date.now() - 3_600_000;
    for (let i = 0; i < DELETION_TASK_WINDOW; i++) {
      await requestAccountDeletion(await newUser(`old-${i}`), new Date(old + i * 1000));
    }
    for (let i = 0; i < DELETION_TASK_WINDOW; i++) await processDeletionTasks(deps);

    const window = await pool.query(SELECTION_WINDOW_BY_KIND, [
      DELETION_TASK_MAX_ATTEMPTS,
      DELETION_TASK_WINDOW,
    ]);
    expect(
      window.rows.filter((r: { kind: string }) => r.kind === "idp_revoke"),
      "idp_revoke rows occupying the selection window",
    ).toEqual([]);
    expect(window.rows, "selection window after every deletion completed").toEqual([]);

    const idp = await pool.query(
      "SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'done')::int AS done FROM deletion_task WHERE kind = 'idp_revoke'",
    );
    expect(idp.rows[0]).toEqual({ n: DELETION_TASK_WINDOW, done: DELETION_TASK_WINDOW });
  });
});
