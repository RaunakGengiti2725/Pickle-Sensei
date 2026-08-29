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
  DELETION_TASK_MAX_ATTEMPTS,
  deletionBacklog,
  runOnce,
  type WorkerDeps,
} from "../src/worker.js";

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

describe.skipIf(!testUrl)("deletion backlog SLO (real PostgreSQL)", () => {
  let pool: pg.Pool;
  let userId: string;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: testUrl });
    await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
    await runMigrations(pool, migrationsDir);
    await seed(pool);
    const user = await pool.query("INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id", [
      `auth0|slo-${randomUUID()}`,
    ]);
    userId = user.rows[0].id as string;
  }, 60000);

  afterAll(async () => {
    await pool?.end();
  });

  it("counts pending, oldest age, and retry-exhausted rows honestly", async () => {
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1, 'social_cleanup', 'queued')",
      [userId],
    );
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, status, attempts) VALUES ($1, 'media_purge', 'failed', $2)",
      [userId, DELETION_TASK_MAX_ATTEMPTS],
    );
    const backlog = await deletionBacklog(pool);
    expect(backlog).not.toBeNull();
    expect(backlog!.pending).toBeGreaterThanOrEqual(2);
    expect(backlog!.exhausted).toBeGreaterThanOrEqual(1);
    expect(backlog!.oldestAgeSeconds).not.toBeNull();
    expect(backlog!.oldestAgeSeconds!).toBeGreaterThanOrEqual(0);
  });

  it("reports null instead of pretending when the table is unreachable", async () => {
    const broken = new pg.Pool({
      connectionString: "postgres://nobody:wrong@127.0.0.1:1/none",
      connectionTimeoutMillis: 300,
    });
    expect(await deletionBacklog(broken)).toBeNull();
    await broken.end();
  });

  it("surfaces the backlog through the deletion_backlog event after a crash mid-deletion", async () => {
    // Crash simulation: a media_purge task already in 'processing' (the
    // worker died holding it) plus an analysis job in flight.
    await pool.query(
      "INSERT INTO deletion_task (user_id, kind, status) VALUES ($1, 'media_purge', 'processing')",
      [userId],
    );
    const queue = new InMemoryJobQueue();
    await queue.enqueue("analysis.deep", { shotId: randomUUID() });
    const tracked: AnalyticsEvent[] = [];
    const sink: IAnalyticsSink = {
      track: (event) => void tracked.push(event),
      flush: async () => {},
    };
    const deps: WorkerDeps = {
      pool,
      queue,
      objectStore: null, // media_purge blocks visibly without storage
      transcoder: null,
      log: () => {},
      analytics: sink,
      sloMonitor: new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      }),
    };
    await runOnce(deps);
    queue.expireInFlight();

    // The analysis job survived the crash cycle — never silently lost.
    expect(await queue.size()).toBe(1);
    // The stuck deletion is visible in the typed backlog event, not hidden.
    const backlogEvents = tracked.filter((e) => e.name === "deletion_backlog");
    expect(backlogEvents).toHaveLength(1);
    const event = backlogEvents[0]!;
    if (event.name === "deletion_backlog") {
      expect(event.pending).toBeGreaterThanOrEqual(1);
    }
  });
});
