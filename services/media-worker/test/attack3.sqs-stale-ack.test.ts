import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { SqsJobQueue } from "@pickle/queue";
import { runOnce, type ObjectDeleter, type WorkerDeps } from "../src/worker.js";

/**
 * ADVERSARIAL TESTER #3 — real SQS protocol (ElasticMQ) + real PostgreSQL.
 * Two workers share one queue with VisibilityTimeout=1s. Worker A receives a
 * media.purge, purges it, but its ack is delayed past the visibility timeout
 * so worker B receives the SAME message (attempt 2) first. Asserts:
 *  - B's redelivered job reports "no object to delete" and issues no second
 *    deleteObject;
 *  - A's late ack with the stale receipt handle does not crash A's cycle
 *    (or, if the broker rejects it, that the rejection is what escapes);
 *  - the message is gone from the queue afterwards (no infinite redelivery).
 * Gated on SQS_ENDPOINT_TEST and DATABASE_URL_TEST like the existing suites.
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";
const testUrl = process.env["DATABASE_URL_TEST"];
const schemaName = `attack3sqs_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

/** Create a queue through the plain SQS Query API (no extra SDK dependency). */
async function createQueue(name: string, visibilityTimeout: number): Promise<string> {
  const body = new URLSearchParams({
    Action: "CreateQueue",
    Version: "2012-11-05",
    QueueName: name,
    "Attribute.1.Name": "VisibilityTimeout",
    "Attribute.1.Value": String(visibilityTimeout),
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const xml = await res.text();
  const match = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(xml);
  if (!res.ok || !match) throw new Error(`CreateQueue failed (${res.status}): ${xml}`);
  return match[1]!;
}

class FakeStore implements ObjectDeleter {
  keys = new Set<string>();
  deleteCalls: string[] = [];
  async deleteObject(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.keys.delete(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

describe.skipIf(!endpoint || !testUrl)(
  "attack3: stale SQS receipt handle across two workers",
  () => {
    const region = "elasticmq";
    let pool: pg.Pool;
    let adminPool: pg.Pool;
    let userId: string;

    beforeAll(async () => {
      process.env["AWS_ACCESS_KEY_ID"] ??= "x";
      process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      pool = new pg.Pool({ connectionString: schemaUrl(testUrl!, schemaName) });
      await runMigrations(pool, migrationsDir);
      await seed(pool);
      const user = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ('auth0|attack3-sqs') RETURNING id",
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

    it("worker B's redelivery is a no-op purge; A's stale ack does not resurrect or duplicate work; queue drains", async () => {
      const queueUrl = await createQueue(`attack3-stale-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const store = new FakeStore();
      const key = `media/attack3/sqs/${randomUUID()}`;
      store.keys.add(key);
      const row = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', $2, 'deleted', now()) RETURNING id`,
        [userId, key],
      );
      const id = row.rows[0].id as string;
      await queue.enqueue("media.purge", { mediaAssetId: id });

      const logsA: string[] = [];
      const logsB: string[] = [];
      // Worker A: receive, but hold the ack until after the visibility timeout.
      let releaseAck: () => void = () => {};
      const ackGate = new Promise<void>((resolve) => {
        releaseAck = resolve;
      });
      const slowQueue = {
        enqueue: (k: string, p: unknown) => queue.enqueue(k, p),
        size: () => queue.size(),
        oldestJobAgeMs: () => queue.oldestJobAgeMs(),
        receive: async (max: number) =>
          (await queue.receive(max)).map(({ job, ack }) => ({
            job,
            ack: async () => {
              await ackGate;
              await ack();
            },
          })),
      };
      const depsA: WorkerDeps = {
        pool,
        queue: slowQueue,
        objectStore: store,
        transcoder: null,
        log: (l) => logsA.push(l),
      };
      const depsB: WorkerDeps = {
        pool,
        queue,
        objectStore: store,
        transcoder: null,
        log: (l) => logsB.push(l),
      };

      const aCycle = runOnce(depsA).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      // Give A time to receive + purge, then let the visibility timeout lapse.
      await new Promise((r) => setTimeout(r, 2500));
      expect(store.deleteCalls).toEqual([key]);

      // Worker B receives the redelivered message (attempt 2).
      let bResult = await runOnce(depsB);
      for (let i = 0; i < 5 && bResult.jobs === 0; i++) bResult = await runOnce(depsB);
      expect(bResult.jobs).toBe(1);
      expect(logsB.some((l) => l.includes("no object to delete"))).toBe(true);
      expect(store.deleteCalls).toEqual([key]);

      // Now A's stale ack fires.
      releaseAck();
      const aOutcome = await aCycle;
      // Record whichever the broker does; neither may duplicate work.
      console.log(
        `attack3 sqs stale-ack: worker A cycle ${aOutcome.ok ? `resolved ${JSON.stringify(aOutcome.r)}` : `rejected ${String(aOutcome.e)}`}`,
      );
      if (!aOutcome.ok) {
        expect(String(aOutcome.e)).toMatch(/Receipt|receipt|InvalidParameter/);
      }
      expect(store.deleteCalls).toEqual([key]);
      const after = await pool.query("SELECT object_key FROM media_asset WHERE id = $1", [id]);
      expect(after.rows[0].object_key).toBeNull();

      // Queue is drained: a fresh receive after another visibility window sees nothing.
      await new Promise((r) => setTimeout(r, 1500));
      const leftover = await queue.receive(10);
      expect(leftover).toHaveLength(0);
    }, 30_000);
  },
);
