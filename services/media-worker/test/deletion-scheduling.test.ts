import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { InMemoryJobQueue } from "@pickle/queue";
import {
  DELETION_TASK_WINDOW,
  deletionBacklog,
  processDeletionTasks,
  type WorkerDeps,
} from "../src/worker.js";

/**
 * SMW-01: the deletion_task selection window must not be monopolised by rows
 * that can never leave it. Two guarantees:
 * - idp_revoke without IdP credentials reaches a terminal state (no orphan
 *   row survives the account, backlog returns to zero);
 * - rows legitimately held back (media_purge blocked on a missing object
 *   store, final_hard_delete waiting on it) rotate to the back of the window
 *   after each attempt, so a newer account's deletion is processed within a
 *   bounded number of cycles no matter how many stuck rows precede it.
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

describe.skipIf(!testUrl)("deletion task scheduling (real PostgreSQL)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  async function createUser(tag: string): Promise<string> {
    const { rows } = await pool.query(
      "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
      [`auth0|sched-${tag}-${randomUUID()}`],
    );
    return rows[0].id as string;
  }

  async function enqueue(userId: string, kinds: string[]): Promise<void> {
    for (const kind of kinds) {
      await pool.query(
        "INSERT INTO deletion_task (user_id, kind, created_at) VALUES ($1, $2, clock_timestamp())",
        [userId, kind],
      );
    }
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

  it("idp_revoke without IdP credentials is terminal, carries its reason, and leaves no backlog", async () => {
    await pool.query("DELETE FROM deletion_task");
    const userId = await createUser("idp");
    await enqueue(userId, ["idp_revoke", "final_hard_delete"]);
    const deps = depsWith({});

    await processDeletionTasks(deps);

    const idp = await pool.query(
      "SELECT status, processed_at, detail FROM deletion_task WHERE user_id = $1 AND kind = 'idp_revoke'",
      [userId],
    );
    expect(idp.rows[0].status).toBe("done");
    expect(idp.rows[0].processed_at).not.toBeNull();
    expect(idp.rows[0].detail).toEqual({ skipped: "idp credentials not configured" });

    // final_hard_delete may have been picked before idp_revoke in the same
    // cycle; a second cycle must finish the account either way.
    await processDeletionTasks(deps);
    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(0);
    const open = await pool.query(
      "SELECT kind FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
      [userId],
    );
    expect(open.rows).toEqual([]);
    expect((await deletionBacklog(pool))?.pending).toBe(0);

    // A done row is never re-selected: a further cycle processes nothing.
    expect(await processDeletionTasks(deps)).toBe(0);
  });

  it("final_hard_delete waits for idp_revoke like any other outstanding task", async () => {
    await pool.query("DELETE FROM deletion_task");
    const userId = await createUser("idp-order");
    await enqueue(userId, ["final_hard_delete"]);
    // An idp_revoke row that has failed past the retry cap is outstanding
    // work: the account must not be hard-deleted over it.
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, status, attempts) VALUES ($1, 'idp_revoke', 'failed', 99)",
      [userId],
    );

    await processDeletionTasks(depsWith({}));

    expect((await pool.query("SELECT 1 FROM app_user WHERE id = $1", [userId])).rowCount).toBe(1);
    const final = await pool.query(
      "SELECT status FROM deletion_task WHERE user_id = $1 AND kind = 'final_hard_delete'",
      [userId],
    );
    expect(final.rows[0].status).toBe("queued");
  });

  it("a newer account's deletion completes within bounded cycles behind 2x the window of stuck rows", async () => {
    await pool.query("DELETE FROM deletion_task");
    // No object store: every media_purge stays honestly blocked and every
    // final_hard_delete keeps waiting on it — 2 * WINDOW rows that never
    // leave the selection window, all older than the victim's rows.
    const deps = depsWith({ objectStore: null });
    const stuckUsers: string[] = [];
    for (let i = 0; i < DELETION_TASK_WINDOW; i++) {
      const userId = await createUser(`stuck-${i}`);
      await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
         VALUES ($1, 'raw_video', 'b', $2, 'ready')`,
        [userId, `media/sched/stuck-${i}-${randomUUID()}`],
      );
      await enqueue(userId, ["media_purge", "final_hard_delete"]);
      stuckUsers.push(userId);
    }
    for (let i = 0; i < 2; i++) await processDeletionTasks(deps);

    const victim = await createUser("victim");
    await enqueue(victim, ["ml_dataset_review", "social_cleanup", "final_hard_delete"]);
    const stuckRows = 2 * DELETION_TASK_WINDOW;
    const bound = Math.ceil((stuckRows + 3) / DELETION_TASK_WINDOW) + 1;
    let cycles = 0;
    while (
      cycles < bound &&
      (await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victim])).rowCount === 1
    ) {
      await processDeletionTasks(deps);
      cycles++;
    }

    expect(
      (await pool.query("SELECT 1 FROM app_user WHERE id = $1", [victim])).rowCount,
      `victim not hard-deleted within ${bound} cycles`,
    ).toBe(0);
    const victimOpen = await pool.query(
      "SELECT kind FROM deletion_task WHERE user_id = $1 AND status <> 'done'",
      [victim],
    );
    expect(victimOpen.rows).toEqual([]);

    // The stuck rows were rotated, not dropped: still queued, still blocked
    // visibly, every one of them attempted, and no account hard-deleted with
    // objects still in the bucket (fairness, not exclusion).
    const stuck = await pool.query(
      `SELECT count(*)::int AS n,
              count(*) FILTER (WHERE status = 'queued')::int AS queued,
              count(*) FILTER (WHERE kind = 'media_purge' AND detail->>'blocked' = 'object store unconfigured')::int AS blocked,
              count(*) FILTER (WHERE last_attempt_at IS NULL)::int AS never_attempted
       FROM deletion_task WHERE user_id = ANY($1::uuid[])`,
      [stuckUsers],
    );
    expect(stuck.rows[0]).toEqual({
      n: stuckRows,
      queued: stuckRows,
      blocked: DELETION_TASK_WINDOW,
      never_attempted: 0,
    });
    expect(
      (
        await pool.query("SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1::uuid[])", [
          stuckUsers,
        ])
      ).rows[0].n,
    ).toBe(DELETION_TASK_WINDOW);
  });

  it("every eligible row is attempted at least once per ceil(eligible / window) cycles", async () => {
    await pool.query("DELETE FROM deletion_task");
    const deps = depsWith({ objectStore: null });
    const rows = 3 * DELETION_TASK_WINDOW + 7;
    const users: string[] = [];
    for (let i = 0; i < rows; i++) {
      const userId = await createUser(`rr-${i}`);
      await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
         VALUES ($1, 'raw_video', 'b', $2, 'ready')`,
        [userId, `media/sched/rr-${i}-${randomUUID()}`],
      );
      await enqueue(userId, ["media_purge"]);
      users.push(userId);
    }
    const perRound = Math.ceil(rows / DELETION_TASK_WINDOW);
    for (let round = 1; round <= 3; round++) {
      const mark = await pool.query("SELECT clock_timestamp() AS t");
      for (let i = 0; i < perRound; i++) await processDeletionTasks(deps);
      const attempted = await pool.query(
        `SELECT count(*)::int AS n FROM deletion_task
         WHERE user_id = ANY($1::uuid[]) AND last_attempt_at >= $2`,
        [users, mark.rows[0].t],
      );
      expect(attempted.rows[0].n, `round ${round}`).toBe(rows);
    }
  });
});
