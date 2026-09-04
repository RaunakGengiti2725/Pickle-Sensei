import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { SqsJobQueue } from "@pickle/queue";
import {
  BufferedAnalytics,
  findPrivacyViolations,
  type AnalyticsEvent,
  type PrivacyViolation,
} from "@pickle/analytics";
import { runOnce, type ObjectDeleter, type WorkerDeps } from "../src/worker.js";

/**
 * Adversarial pass 3 (storage-media-worker #4) — real SQS protocol attacks
 * through ElasticMQ against SqsJobQueue + runOnce at 4d812e1a.
 *
 * Gated on SQS_ENDPOINT_TEST (broker) and DATABASE_URL_TEST (worker needs a
 * real media_asset table). Raw SQS Query-API calls are used for queue
 * creation / hostile message bodies so this package needs no extra
 * dependency (@aws-sdk/client-sqs is a dependency of @pickle/queue only).
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";
const testUrl = process.env["DATABASE_URL_TEST"];
const region = "elasticmq";
const schemaName = `attack_smw4_sqs_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

async function sqsQuery(
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const form = new URLSearchParams(params);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  return { status: res.status, body: await res.text() };
}

async function createQueue(name: string, visibilityTimeout = 1): Promise<string> {
  const { status, body } = await sqsQuery(endpoint, {
    Action: "CreateQueue",
    QueueName: name,
    "Attribute.1.Name": "VisibilityTimeout",
    "Attribute.1.Value": String(visibilityTimeout),
  });
  const match = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(body);
  if (status !== 200 || !match) throw new Error(`CreateQueue failed: ${status} ${body}`);
  return match[1]!;
}

async function sendRaw(
  queueUrl: string,
  messageBody: string,
): Promise<{ status: number; body: string }> {
  return sqsQuery(queueUrl, { Action: "SendMessage", MessageBody: messageBody });
}

async function approximateCounts(
  queueUrl: string,
): Promise<{ visible: number; notVisible: number }> {
  const { body } = await sqsQuery(queueUrl, {
    Action: "GetQueueAttributes",
    "AttributeName.1": "ApproximateNumberOfMessages",
    "AttributeName.2": "ApproximateNumberOfMessagesNotVisible",
  });
  const read = (name: string) =>
    Number(new RegExp(`<Name>${name}</Name>\\s*<Value>(\\d+)</Value>`).exec(body)?.[1] ?? "-1");
  return {
    visible: read("ApproximateNumberOfMessages"),
    notVisible: read("ApproximateNumberOfMessagesNotVisible"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class FakeStore implements ObjectDeleter {
  keys = new Set<string>();
  async deleteObject(key: string): Promise<void> {
    this.keys.delete(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    return [...this.keys].filter((k) => k.startsWith(prefix));
  }
}

describe.skipIf(!endpoint || !testUrl)(
  "attack pass 3: SqsJobQueue + runOnce over ElasticMQ",
  () => {
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
        "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
        [`auth0|attack-smw4-sqs-${randomUUID()}`],
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

    function makeDeps(
      queue: SqsJobQueue,
      overrides: Partial<WorkerDeps> = {},
    ): WorkerDeps & { store: FakeStore; lines: string[] } {
      const store = new FakeStore();
      const lines: string[] = [];
      const deps: WorkerDeps = {
        pool,
        queue,
        objectStore: store,
        transcoder: null,
        log: (line) => void lines.push(line),
        ...overrides,
      };
      return Object.assign(deps, { store, lines });
    }

    // ---------------------------------------------------------------------------
    // Scenario 5 — two runOnce on one queue, VisibilityTimeout=1, slow transcoder.
    // ---------------------------------------------------------------------------
    it("S5: parallel runOnce with VisibilityTimeout=1 and a 1.5 s transcoder — second receiver gets attempt 2; asset ends 'ready'; stale ack surfaces", async () => {
      const queueUrl = await createQueue(`attack-s5-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const key = `media/a3/s5-${randomUUID()}`;
      const asset = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status)
       VALUES ($1, 'raw_video', 'b', $2, 'processing') RETURNING id`,
        [userId, key],
      );
      const assetId = asset.rows[0].id as string;
      await queue.enqueue("media.process", { mediaAssetId: assetId });

      const transcodeCalls: number[] = [];
      const attemptsSeen: number[] = [];
      const statusesDuring: string[] = [];
      const makeWorker = (label: string) => {
        const deps = makeDeps(queue, {
          transcoder: async ({ objectKey }) => {
            transcodeCalls.push(Date.now());
            await sleep(1500);
            const mid = await pool.query("SELECT status FROM media_asset WHERE id = $1", [assetId]);
            statusesDuring.push(mid.rows[0].status as string);
            return {
              normalizedKey: `${objectKey}/normalized.mp4`,
              thumbnailKey: `${objectKey}/thumb.jpg`,
            };
          },
        });
        // Wrap receive to observe the attempt numbers each worker sees.
        const inner = deps.queue;
        deps.queue = {
          enqueue: (k, p) => inner.enqueue(k, p),
          size: () => inner.size(),
          oldestJobAgeMs: () => inner.oldestJobAgeMs(),
          receive: async (max) => {
            const batch = await inner.receive(max);
            for (const b of batch) attemptsSeen.push(b.job.attempt);
            return batch;
          },
        };
        return { label, deps };
      };
      const a = makeWorker("A");
      const b = makeWorker("B");
      const started = Date.now();
      const resultA = runOnce(a.deps).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e: String(e) }),
      );
      await sleep(1100); // visibility window (1 s) has elapsed; A is still transcoding
      const resultB = runOnce(b.deps).then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e: String(e) }),
      );
      const [ra, rb] = await Promise.all([resultA, resultB]);
      const elapsed = Date.now() - started;

      expect(attemptsSeen.sort()).toEqual([1, 2]); // redelivered mid-flight with attempt 2
      expect(transcodeCalls).toHaveLength(2); // duplicate transcode of the same asset
      const finalRow = await pool.query("SELECT status FROM media_asset WHERE id = $1", [assetId]);
      expect(finalRow.rows[0].status).toBe("ready"); // never an inconsistent status
      expect(statusesDuring.every((s) => s === "processing" || s === "ready")).toBe(true);
      // Observed outcome of the two acks is pinned below (stale receipt handle
      // behaviour is broker-specific — recorded, not assumed):
      const summary = { ra, rb, elapsed, attemptsSeen, statusesDuring };
      a.deps.log(JSON.stringify(summary));
      // Whatever the broker did with the stale handle, the message must not be
      // left visible forever: after both cycles + visibility window it is gone.
      await sleep(1200);
      const leftover = await queue.receive(10);
      expect(leftover).toHaveLength(0);
      // At least one of the two cycles completed normally.
      expect(ra.ok || rb.ok).toBe(true);
      // Both cycles surviving means the stale ack was tolerated by the broker.
      // A rejecting cycle would be a `worker_crash` in main.ts (see X1 in the DB
      // suite for the code path); record which happened for the report.
      console.error(`[S5] ${JSON.stringify(summary)}`);
    }, 30_000);

    // ---------------------------------------------------------------------------
    // Scenario 6 — 10,000-char kind + ~250 KB payload.
    // ---------------------------------------------------------------------------
    it("S6: 10,000-char kind + 250 KB payload — worker logs the note without crashing; the worker_failure event is DROPPED by the redaction guard (oversized jobKind)", async () => {
      const queueUrl = await createQueue(`attack-s6-${Date.now()}`, 1);
      const hugeKind = "k".repeat(10_000);
      const hugePayload = { blob: "p".repeat(250_000) };
      const body = JSON.stringify({ kind: hugeKind, payload: hugePayload });
      expect(body.length).toBeLessThanOrEqual(262_144); // SQS hard cap
      const sent = await sendRaw(queueUrl, body);
      expect(sent.status).toBe(200);

      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const delivered: AnalyticsEvent[] = [];
      const violations: Array<{ name: string; violations: PrivacyViolation[] }> = [];
      const analytics = new BufferedAnalytics(
        async (batch) => void delivered.push(...batch),
        50,
        (name, v) => void violations.push({ name, violations: v }),
      );
      const deps = makeDeps(queue, { analytics });
      const result = await runOnce(deps);
      expect(result.jobs).toBe(0); // not acked
      const noteLine = deps.lines.find((l) => l.includes("unknown job kind"));
      expect(noteLine).toBeDefined();
      expect(noteLine!.length).toBeGreaterThan(20_000); // kind logged twice, raw
      // The worker_failure event carries jobKind = the raw 10,000-char kind:
      // findPrivacyViolations flags oversized_string and BufferedAnalytics drops
      // the whole event. The only trace is droppedViolationCount() — main.ts
      // wires no onViolation, so in production this drop is invisible.
      expect(delivered.filter((e) => e.name === "worker_failure")).toHaveLength(0);
      expect(violations).toHaveLength(1);
      expect(violations[0]!.name).toBe("worker_failure");
      expect(violations[0]!.violations).toContainEqual({
        path: "jobKind",
        rule: "oversized_string",
      });
      for (const v of violations[0]!.violations) expect(v.path).toBe("jobKind");
      expect(analytics.droppedViolationCount()).toBe(1);
      // queue_backlog still emitted (worker survived the cycle).
      expect(delivered.some((e) => e.name === "queue_backlog")).toBe(true);
      // Message stays on the queue.
      await sleep(1200);
      const again = await queue.receive(10);
      expect(again).toHaveLength(1);
      expect(again[0]!.job.attempt).toBe(2);
      expect((again[0]!.job.kind as string).length).toBe(10_000);
    }, 30_000);

    it("S6b: a hostile kind is copied verbatim into telemetry and logs — URI-like kind silently drops worker_failure; newline kind forges a log line", async () => {
      const queueUrl = await createQueue(`attack-s6b-${Date.now()}`, 1);
      const uriKind = "s3://victim-bucket/media/u/secret.mp4";
      const forgedKind =
        "media.purge\n[media-worker] processed jobs=999 deletions=999 swept=0 expired=0";
      await sendRaw(queueUrl, JSON.stringify({ kind: uriKind, payload: {} }));
      await sendRaw(queueUrl, JSON.stringify({ kind: forgedKind, payload: {} }));
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const delivered: AnalyticsEvent[] = [];
      const violations: Array<{ name: string; violations: PrivacyViolation[] }> = [];
      const analytics = new BufferedAnalytics(
        async (batch) => void delivered.push(...batch),
        50,
        (name, v) => void violations.push({ name, violations: v }),
      );
      const deps = makeDeps(queue, { analytics });
      await runOnce(deps);
      // uri kind → worker_failure dropped (uri_scheme), forged kind → emitted
      // with the newline inside jobKind (guard has no control-character rule).
      expect(violations.map((v) => v.violations.map((x) => x.rule))).toEqual([["uri_scheme"]]);
      const failures = delivered.filter((e) => e.name === "worker_failure");
      expect(failures).toHaveLength(1);
      if (failures[0]!.name === "worker_failure") expect(failures[0]!.jobKind).toBe(forgedKind);
      // The log line is written raw: a consumer splitting on "\n" sees a
      // fabricated "processed jobs=999" line.
      const forgedLine = deps.lines.find((l) => l.startsWith("media.purge\n"));
      expect(forgedLine).toBeDefined();
      expect(forgedLine!.split("\n")[1]).toBe(
        "[media-worker] processed jobs=999 deletions=999 swept=0 expired=0: unknown job kind media.purge",
      );
      expect(findPrivacyViolations(failures[0]!)).toEqual([]);
    }, 30_000);

    // ---------------------------------------------------------------------------
    // Scenario 7 — {"kind":"media.purge"} with no payload.
    // ---------------------------------------------------------------------------
    it('S7: {"kind":"media.purge"} (no payload) becomes an unhandled job redelivered indefinitely with growing ApproximateReceiveCount and no cap at the queue layer', async () => {
      const queueUrl = await createQueue(`attack-s7-${Date.now()}`, 1);
      await sendRaw(queueUrl, JSON.stringify({ kind: "media.purge" }));
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const deps = makeDeps(queue);
      const attempts: number[] = [];
      const inner = deps.queue;
      deps.queue = {
        enqueue: (k, p) => inner.enqueue(k, p),
        size: () => inner.size(),
        oldestJobAgeMs: () => inner.oldestJobAgeMs(),
        receive: async (max) => {
          const batch = await inner.receive(max);
          for (const b of batch) attempts.push(b.job.attempt);
          return batch;
        },
      };
      for (let cycle = 0; cycle < 6; cycle++) {
        const result = await runOnce(deps);
        expect(result.jobs).toBe(0);
        await sleep(1100);
      }
      expect(attempts).toEqual([1, 2, 3, 4, 5, 6]); // past the terraform DLQ cap of 5 — nothing in code stops it
      const thrown = deps.lines.filter((l) => l.startsWith("media.purge: handler threw:"));
      expect(thrown).toHaveLength(6);
      expect(thrown[0]).toMatch(/TypeError/);
      const counts = await approximateCounts(queueUrl);
      expect(counts.visible + counts.notVisible).toBe(1); // still there
    }, 30_000);

    // ---------------------------------------------------------------------------
    // Scenario 8 — numeric kind.
    // ---------------------------------------------------------------------------
    it('S8: {"kind":42,"payload":{}} — SqsJobQueue does not throw; worker reports \'unknown job kind 42\' without acking; jobKind leaks a number into a string-typed field', async () => {
      const queueUrl = await createQueue(`attack-s8-${Date.now()}`, 1);
      await sendRaw(queueUrl, JSON.stringify({ kind: 42, payload: {} }));
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const received = await queue.receive(10);
      expect(received).toHaveLength(1);
      expect(received[0]!.job.kind).toBe(42 as unknown as string); // runtime type lie
      await sleep(1100);
      const delivered: AnalyticsEvent[] = [];
      const analytics = new BufferedAnalytics(async (batch) => void delivered.push(...batch));
      const deps = makeDeps(queue, { analytics });
      const result = await runOnce(deps);
      expect(result.jobs).toBe(0);
      expect(deps.lines).toContain("42: unknown job kind 42");
      const failure = delivered.find((e) => e.name === "worker_failure");
      expect(failure).toBeDefined();
      if (failure?.name === "worker_failure") {
        expect(failure.jobKind).toBe(42 as unknown as string);
        expect(typeof failure.jobKind).toBe("number");
        expect(failure.failureKind).toBe("unhandled");
      }
      await sleep(1100);
      const again = await queue.receive(10);
      expect(again).toHaveLength(1); // not acked
      expect(again[0]!.job.attempt).toBe(3);
    }, 30_000);

    // ---------------------------------------------------------------------------
    // Extra — JSON `null` body.
    // ---------------------------------------------------------------------------
    it("X2: a message whose body is the JSON literal `null` makes SqsJobQueue.receive() THROW — the whole batch aborts and runOnce rejects every cycle the message is visible", async () => {
      const queueUrl = await createQueue(`attack-x2-${Date.now()}`, 1);
      const key = `media/a3/x2-${randomUUID()}`;
      const asset = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, deleted_at)
       VALUES ($1, 'raw_video', 'b', $2, 'deleted', now()) RETURNING id`,
        [userId, key],
      );
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      // A legitimate purge job shares the batch with the poison body.
      await queue.enqueue("media.purge", { mediaAssetId: asset.rows[0].id });
      const sent = await sendRaw(queueUrl, "null");
      expect(sent.status).toBe(200);

      const deps = makeDeps(queue);
      deps.store.keys.add(key);
      const victim = await pool.query(
        "INSERT INTO app_user (auth_subject, status, deleted_at) VALUES ($1, 'deleted', now()) RETURNING id",
        [`auth0|x2-${randomUUID()}`],
      );
      await pool.query("INSERT INTO deletion_task (user_id, kind) VALUES ($1, 'social_cleanup')", [
        victim.rows[0].id,
      ]);
      // Cycle 1: receive() itself throws (TypeError reading .kind of null).
      await expect(runOnce(deps)).rejects.toThrow(TypeError);
      // Collateral: the good purge in the same batch did not run, the deletion
      // task was not processed, no queue_backlog/SLO observation this cycle.
      expect(deps.store.keys.has(key)).toBe(true);
      const task = await pool.query("SELECT status FROM deletion_task WHERE user_id = $1", [
        victim.rows[0].id,
      ]);
      expect(task.rows[0].status).toBe("queued");
      // Cycles 2..4: as long as the poison body is visible, every cycle dies.
      for (let cycle = 2; cycle <= 4; cycle++) {
        await sleep(1100);
        await expect(runOnce(deps)).rejects.toThrow(TypeError);
      }
      expect(deps.store.keys.has(key)).toBe(true); // purge still never ran
      // Contrast: other non-object JSON bodies do NOT throw (they surface as
      // kind undefined) — only `null` reaches `parsed.kind` on a null value.
      const q2url = await createQueue(`attack-x2b-${Date.now()}`, 1);
      const bodies = ["42", '"str"', "[]", "true"];
      for (const body of bodies) expect((await sendRaw(q2url, body)).status).toBe(200);
      const q2 = new SqsJobQueue({ queueUrl: q2url, region, endpoint });
      const distinct = new Map<string, { kind: unknown; payload: unknown }>();
      for (let i = 0; i < 6 && distinct.size < bodies.length; i++) {
        for (const r of await q2.receive(10)) {
          distinct.set(r.job.id, { kind: r.job.kind, payload: r.job.payload });
          await r.ack();
        }
      }
      expect(distinct.size).toBe(bodies.length);
      for (const r of distinct.values()) expect(r.kind).toBeUndefined();
    }, 40_000);
  },
);
