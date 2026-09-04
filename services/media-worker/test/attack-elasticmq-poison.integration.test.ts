import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations, seed } from "@pickle/database";
import { SqsJobQueue } from "@pickle/queue";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { runOnce, type WorkerDeps } from "../src/worker.js";

/**
 * Adversarial pass 3 — storage-media-worker, queue leg: the REAL worker loop
 * (`runOnce`) consuming the REAL SQS protocol from a local ElasticMQ broker,
 * with hostile message bodies and slow-consumer timing.
 *
 *  - Q1: a `media.purge` whose payload is not a UUID → the handler throws every
 *    cycle; the message is never acked and redelivers with a growing attempt.
 *    The worker itself has no attempt cap (production relies on the SQS
 *    redrive policy, maxReceiveCount=5, infra/terraform/modules/media/main.tf).
 *  - Q2: hostile-but-valid JSON bodies (`null`, `[]`, `"str"`, `{"kind":{}}`,
 *    `{"kind":"media.purge","payload":null}`) — `receive()` promises never to
 *    throw on a poison body; does it hold for every JSON value?
 *  - Q3: slow consumer — ack with a receipt handle from BEFORE the visibility
 *    timeout expired and the message was redelivered.
 *  - Q4: oversized payload (> 256 KiB) → enqueue must throw, not truncate.
 *
 * Gated on SQS_ENDPOINT_TEST (http://localhost:9324) and DATABASE_URL_TEST.
 * Queues are created over the plain SQS query API (ElasticMQ ignores SigV4),
 * so this package needs no direct @aws-sdk/client-sqs dependency.
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";
const testUrl = process.env["DATABASE_URL_TEST"];
const region = "elasticmq";
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

async function sqsQuery(params: Record<string, string>): Promise<string> {
  const url = new URL(endpoint);
  url.search = new URLSearchParams({ ...params, Version: "2012-11-05" }).toString();
  const res = await fetch(url, { method: "POST" });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQS ${params["Action"]} → ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

async function createQueue(name: string, visibilitySeconds: number): Promise<string> {
  const xml = await sqsQuery({
    Action: "CreateQueue",
    QueueName: name,
    "Attribute.1.Name": "VisibilityTimeout",
    "Attribute.1.Value": String(visibilitySeconds),
  });
  const match = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(xml);
  if (!match?.[1]) throw new Error(`no QueueUrl in ${xml.slice(0, 200)}`);
  // ElasticMQ advertises its container-internal host; rewrite onto the test endpoint.
  const advertised = new URL(match[1]);
  const local = new URL(endpoint);
  advertised.protocol = local.protocol;
  advertised.host = local.host;
  return advertised.toString();
}

async function sendRaw(queueUrl: string, body: string): Promise<void> {
  await sqsQuery({ Action: "SendMessage", QueueUrl: queueUrl, MessageBody: body });
}

async function approxVisible(queueUrl: string): Promise<{ visible: number; inFlight: number }> {
  const xml = await sqsQuery({
    Action: "GetQueueAttributes",
    QueueUrl: queueUrl,
    "AttributeName.1": "ApproximateNumberOfMessages",
    "AttributeName.2": "ApproximateNumberOfMessagesNotVisible",
  });
  const pick = (name: string) =>
    Number(new RegExp(`<Name>${name}</Name>\\s*<Value>(\\d+)</Value>`).exec(xml)?.[1] ?? "-1");
  return {
    visible: pick("ApproximateNumberOfMessages"),
    inFlight: pick("ApproximateNumberOfMessagesNotVisible"),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!endpoint || !testUrl)(
  "media-worker consuming ElasticMQ (adversarial pass 3)",
  () => {
    let pool: pg.Pool;
    let events: AnalyticsEvent[];
    let logs: string[];

    beforeAll(async () => {
      process.env["AWS_ACCESS_KEY_ID"] ??= "x";
      process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
      pool = new pg.Pool({ connectionString: testUrl });
      await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
      await runMigrations(pool, migrationsDir);
      await seed(pool);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
    });

    function deps(queue: SqsJobQueue): WorkerDeps {
      events = [];
      logs = [];
      const analytics: IAnalyticsSink = {
        track: (event) => {
          events.push(event);
        },
        flush: async () => {},
      };
      return {
        pool,
        queue,
        objectStore: { deleteObject: async () => {}, listObjects: async () => [] },
        transcoder: null,
        log: (line) => logs.push(line),
        analytics,
      };
    }

    it("Q1: a media.purge with a non-UUID payload is never acked, redelivers forever with a growing attempt, and the worker never caps it", async () => {
      const queueUrl = await createQueue(`attack-poison-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      await queue.enqueue("media.purge", {
        mediaAssetId: "not-a-uuid'; DROP TABLE media_asset;--",
      });
      const d = deps(queue);

      let cycles = 0;
      let lastAttempt = 0;
      for (let i = 0; i < 7; i++) {
        const before = await queue.receive(10);
        // Peek at the attempt the worker is about to see, then give the message
        // back by letting its visibility timeout lapse.
        if (before[0]) lastAttempt = before[0].job.attempt;
        await sleep(1200);
        const out = await runOnce(d);
        expect(out.jobs).toBe(0);
        cycles++;
        await sleep(1200);
      }
      const failures = events.filter((e) => e.name === "worker_failure");
      console.log(
        `Q1: cycles=${cycles} worker_failure=${failures.length} lastSeenAttempt=${lastAttempt} log=${logs.at(-1)}`,
      );
      expect(failures.length).toBe(cycles);
      expect(
        failures.every((e) => (e as { failureKind?: string }).failureKind === "handler_exception"),
      ).toBe(true);
      // Still on the queue after 14 receives: no cap, no drop — the worker
      // documents this ("visible backlog, never silently dropped") and leaves
      // the redrive to SQS. Note: ElasticMQ from docker-compose has NO redrive
      // policy, so locally this message loops forever.
      expect(lastAttempt).toBeGreaterThanOrEqual(cycles);
      const depth = await approxVisible(queueUrl);
      expect(depth.visible + depth.inFlight).toBe(1);
      // The table the payload tried to name is untouched (parameterized query).
      expect((await pool.query("SELECT count(*)::int AS n FROM media_asset")).rows[0].n).toBe(0);
    }, 60_000);

    it("Q2: hostile-but-valid JSON bodies (array, string, number, bool, non-string kind) — receive() never throws and the healthy job behind them is still handled", async () => {
      const queueUrl = await createQueue(`attack-json-${Date.now()}`, 1);
      const bodies = [
        "[]",
        '"str"',
        '{"kind":{"nested":true}}',
        '{"kind":"media.purge","payload":null}',
        "0",
        "true",
        '{"kind":"media.process"}',
      ];
      for (const body of bodies) await sendRaw(queueUrl, body);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() }); // transcoder null → handled

      const received = await queue.receive(10);
      console.log(
        `Q2: kinds=${JSON.stringify(received.map(({ job }) => [String(job.kind), job.payload]))}`,
      );
      expect(received.length).toBe(bodies.length + 1);

      // Let the batch become visible again and run the worker: the healthy job
      // must be acked, the poison ones (unknown kind / handler throw) remain.
      await sleep(1200);
      const d = deps(queue);
      const out = await runOnce(d);
      console.log(`Q2: runOnce jobs=${out.jobs} log=${JSON.stringify(logs)}`);
      expect(out.jobs).toBe(1);
      await sleep(1200);
      const depth = await approxVisible(queueUrl);
      expect(depth.visible + depth.inFlight).toBe(bodies.length);
    }, 60_000);

    it("Q2b: the JSON body `null` — receive() must not throw (its documented contract), so one poison message cannot stall the batch behind it", async () => {
      const queueUrl = await createQueue(`attack-null-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      await sendRaw(queueUrl, "null");
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() });
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() });

      const d = deps(queue);
      const outcomes: string[] = [];
      for (let i = 0; i < 3; i++) {
        try {
          const out = await runOnce(d);
          outcomes.push(`jobs=${out.jobs}`);
        } catch (error) {
          outcomes.push(`threw:${String(error)}`);
        }
        await sleep(1200);
      }
      const depth = await approxVisible(queueUrl);
      console.log(`Q2b: cycles=${JSON.stringify(outcomes)} depth=${JSON.stringify(depth)}`);
      // Attack expectation: the two healthy jobs are handled (acked) within
      // three cycles and only the poison body remains.
      expect(
        outcomes.some((o) => o.startsWith("threw")),
        `runOnce threw: ${outcomes[0]}`,
      ).toBe(false);
      expect(depth.visible + depth.inFlight).toBe(1);
    }, 60_000);

    it("Q3: slow consumer — acking with a receipt handle from before redelivery: does the stale ack delete the message?", async () => {
      const queueUrl = await createQueue(`attack-stale-ack-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() });
      const first = await queue.receive(1);
      expect(first).toHaveLength(1);
      await sleep(1500); // handler "took longer than the visibility timeout"
      const second = await queue.receive(1);
      expect(second).toHaveLength(1);
      expect(second[0]!.job.attempt).toBe(2);
      let staleAckError: string | null = null;
      try {
        await first[0]!.ack();
      } catch (error) {
        staleAckError = String(error);
      }
      await sleep(1500);
      const third = await queue.receive(1);
      console.log(
        `Q3: staleAckError=${staleAckError} messageStillPresentAfterStaleAck=${third.length === 1} attempt=${third[0]?.job.attempt}`,
      );
      // Broker semantics recorded: ElasticMQ rejects a stale receipt handle
      // (ReceiptHandleIsInvalid) and keeps the message. AWS SQS documents that a
      // stale handle "might not" delete — the consequence for the worker loop is
      // tested in Q3b with the real runOnce.
      expect(staleAckError === null || /ReceiptHandleIsInvalid/.test(staleAckError)).toBe(true);
      if (third.length === 1) await third[0]!.ack();
      else await second[0]!.ack();
    }, 30_000);

    it("Q3b: a handler slower than the visibility timeout must not abort the rest of the batch or crash the poll cycle", async () => {
      const queueUrl = await createQueue(`attack-slow-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const user = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ('attack|slow') RETURNING id",
      );
      const slowAsset = await pool.query(
        `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, content_type, size_bytes, sha256, status)
       VALUES ($1, 'raw_video', 'b', 'media/slow/master', 'video/mp4', 1, $2, 'processing') RETURNING id`,
        [user.rows[0].id, "a".repeat(64)],
      );
      const slowId = slowAsset.rows[0].id as string;
      await queue.enqueue("media.process", { mediaAssetId: slowId });
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() });
      await queue.enqueue("media.process", { mediaAssetId: randomUUID() });

      const d = deps(queue);
      let peerSaw = 0;
      d.transcoder = async ({ objectKey }) => {
        await sleep(1600); // longer than the 1s visibility timeout
        // A peer worker polls while this transcode is still running and is
        // handed the same (now visible again) message.
        peerSaw = (await queue.receive(10)).length;
        return {
          normalizedKey: `${objectKey}/normalized.mp4`,
          thumbnailKey: `${objectKey}/thumb.jpg`,
        };
      };
      let cycleError: string | null = null;
      let jobs = -1;
      try {
        jobs = (await runOnce(d)).jobs;
      } catch (error) {
        cycleError = String(error);
      }
      await sleep(1200);
      const depth = await approxVisible(queueUrl);
      console.log(
        `Q3b: peerSaw=${peerSaw} cycleError=${cycleError} jobsAcked=${jobs} depthAfter=${JSON.stringify(depth)} log=${JSON.stringify(logs)}`,
      );
      // The asset itself was processed (status ready) even if the cycle blew up.
      expect(
        (await pool.query("SELECT status FROM media_asset WHERE id = $1", [slowId])).rows[0].status,
      ).toBe("ready");
      expect(cycleError, "runOnce must survive a slow job").toBeNull();
      expect(jobs).toBe(3);
    }, 30_000);

    it("Q4: huge (> 256 KiB) and unicode payloads are never truncated or mangled — either refused by the broker or delivered byte-exact", async () => {
      const queueUrl = await createQueue(`attack-huge-${Date.now()}`, 1);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const huge = "x".repeat(300 * 1024);
      let hugeAccepted = true;
      try {
        await queue.enqueue("media.process", { blob: huge });
      } catch (error) {
        hugeAccepted = false;
        console.log(`Q4: broker refused 300 KiB body: ${String(error).slice(0, 120)}`);
      }
      const hugeReceived = await queue.receive(10);
      console.log(`Q4: hugeAccepted=${hugeAccepted} received=${hugeReceived.length}`);
      if (hugeAccepted) {
        // ElasticMQ (this broker) accepts it; AWS SQS caps at 256 KiB and would
        // throw from enqueue — the API's /complete reverts on that path.
        expect(hugeReceived).toHaveLength(1);
        expect((hugeReceived[0]!.job.payload as { blob: string }).blob).toBe(huge);
        await hugeReceived[0]!.ack();
      } else {
        expect(hugeReceived).toHaveLength(0);
      }
      // A unicode-heavy payload just under the limit round-trips intact.
      const unicode = "🥒".repeat(1000) + "\u0000\r\n\u2028";
      await queue.enqueue("media.process", { unicode });
      const got = await queue.receive(10);
      expect(got).toHaveLength(1);
      expect((got[0]!.job.payload as { unicode: string }).unicode).toBe(unicode);
      await got[0]!.ack();
    }, 30_000);
  },
);
