import { beforeAll, describe, expect, it } from "vitest";
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { SqsJobQueue } from "../../src/index.js";
import {
  checkDecodedJob,
  DEFAULT_OUT_DIR,
  errorText,
  finish,
  prototypePollution,
  summarize,
  writeReport,
  type RowDraft,
  type StressRow,
} from "./campaign.js";
import { describeValue, genBoundaryNumber, genJsValue, genKind, genRawBody } from "./generators.js";
import { hashSeed, SeededRng } from "./rng.js";

/**
 * LENS boundary-malformed on the REAL SQS wire (ElasticMQ). Gated on
 * SQS_ENDPOINT_TEST exactly like sqs.integration.test.ts. `STRESS_SQS_ITER`
 * (default 40) seeded iterations per campaign — every iteration is 2–3
 * broker round trips, so the bulk campaign lives in the fake-broker suite
 * and this one proves the wire protocol agrees with it.
 *
 *  - decode: seeded hostile bodies sent RAW (SendMessageCommand), decoded by
 *    SqsJobQueue.receive — the broker's own MessageBody validation is part of
 *    the observed behaviour (recorded as `broker_rejected:*`).
 *  - encode: seeded hostile kind/payload through SqsJobQueue.enqueue, then a
 *    real round trip; a rejection must leave the queue empty.
 *  - receive(max) boundaries: the broker's typed 400s must surface as Error
 *    instances (caller misuse, not message content).
 *  - GAP-QUEUE-1 pinned against the real broker, including the collateral
 *    damage: batch neighbours' ApproximateReceiveCount advances every poll.
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";
const ITER = Math.max(1, Number.parseInt(process.env["STRESS_SQS_ITER"] ?? "40", 10) || 40);
const SEED = Number.parseInt(process.env["STRESS_SEED"] ?? "20260904", 10) || 20260904;
const OUT_DIR = process.env["STRESS_OUT"] ?? DEFAULT_OUT_DIR;

describe.skipIf(!endpoint)(`boundary-malformed against ElasticMQ (STRESS_SQS_ITER=${ITER})`, () => {
  const region = "elasticmq";
  let client: SQSClient;

  beforeAll(() => {
    process.env["AWS_ACCESS_KEY_ID"] ??= "x";
    process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
    client = new SQSClient({ region, endpoint });
  });

  async function makeQueue(name: string): Promise<string> {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: `stress-${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        Attributes: { VisibilityTimeout: "1" },
      }),
    );
    if (!created.QueueUrl) throw new Error("CreateQueue returned no QueueUrl");
    return created.QueueUrl;
  }

  async function messageCount(queueUrl: string): Promise<number> {
    const attributes = await client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queueUrl,
        AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
      }),
    );
    return (
      Number(attributes.Attributes?.["ApproximateNumberOfMessages"] ?? 0) +
      Number(attributes.Attributes?.["ApproximateNumberOfMessagesNotVisible"] ?? 0)
    );
  }

  /** Remove whatever is left on the queue via the raw SDK so iterations stay isolated. */
  async function drain(queueUrl: string): Promise<number> {
    let drained = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // The poisoned message is invisible for the 1s visibility timeout after
      // the failed receive; wait it out before the raw poll.
      await new Promise((resolve) => setTimeout(resolve, 1100));
      const raw = await client.send(
        new ReceiveMessageCommand({ QueueUrl: queueUrl, MaxNumberOfMessages: 10 }),
      );
      const messages = raw.Messages ?? [];
      for (const message of messages) {
        await client.send(
          new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }),
        );
        drained += 1;
      }
      if ((await messageCount(queueUrl)) === 0) break;
    }
    return drained;
  }

  async function receiveWithRetry(
    queue: SqsJobQueue,
    attempts = 3,
  ): Promise<Awaited<ReturnType<SqsJobQueue["receive"]>>> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const received = await queue.receive(10);
      if (received.length > 0) return received;
    }
    return [];
  }

  it(
    "decode campaign: seeded hostile bodies over the real wire",
    async () => {
      const queueUrl = await makeQueue("decode");
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const rows: StressRow[] = [];
      for (let iter = 0; iter < ITER; iter += 1) {
        const seed = hashSeed("elasticmq-decode", SEED + iter);
        const rng = new SeededRng(seed);
        const generated = genRawBody(rng);
        const draft: RowDraft = { violations: [], notes: [] };
        const input = `body=${generated.body === undefined ? "<absent>" : describeValue(generated.body, 120)}`;
        if (generated.body === undefined) {
          draft.notes.push("unsendable_absent_body");
          rows.push(finish("elasticmq-decode", iter, seed, generated.category, input, draft));
          continue;
        }
        let messageId: string | undefined;
        try {
          const sent = await client.send(
            new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: generated.body }),
          );
          messageId = sent.MessageId;
        } catch (error) {
          draft.notes.push(`broker_rejected:${error instanceof Error ? error.name : "non-Error"}`);
          rows.push(finish("elasticmq-decode", iter, seed, generated.category, input, draft));
          continue;
        }
        try {
          const received = await receiveWithRetry(queue);
          if (received.length !== 1) draft.violations.push("batch_loss");
          const entry = received[0];
          if (!entry) draft.violations.push("target_missing");
          else {
            checkDecodedJob(entry.job, { generated, messageId: messageId ?? "unknown" }, draft);
            await entry.ack();
          }
        } catch (error) {
          draft.violations.push("receive_threw");
          draft.error = errorText(error);
          draft.notes.push(`drained:${await drain(queueUrl)}`);
        }
        const pollution = prototypePollution();
        if (pollution) draft.violations.push(pollution);
        rows.push(finish("elasticmq-decode", iter, seed, generated.category, input, draft));
      }
      const summary = summarize("elasticmq-decode", SEED, rows);
      const { rowsPath } = writeReport(
        OUT_DIR,
        `elasticmq-decode.seed${SEED}.iter${ITER}`,
        rows,
        summary,
      );
      const unclassified = rows.filter((row) => row.outcome === "BROKEN" && !row.gapId);
      expect(
        unclassified,
        `new BROKEN rows in ${rowsPath}: ${JSON.stringify(unclassified.slice(0, 5), null, 2)}`,
      ).toHaveLength(0);
      expect(rows).toHaveLength(ITER);
    },
    Math.max(60_000, ITER * 3_000),
  );

  it(
    "encode campaign: seeded hostile kind/payload through enqueue over the real wire",
    async () => {
      const queueUrl = await makeQueue("encode");
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      const rows: StressRow[] = [];
      for (let iter = 0; iter < ITER; iter += 1) {
        const seed = hashSeed("elasticmq-encode", SEED + iter);
        const rng = new SeededRng(seed);
        const kind = genKind(rng);
        const payload = genJsValue(rng);
        const category = `${kind.category}|${payload.category}`;
        const input = `kind=${describeValue(kind.value, 60)} payload=${describeValue(payload.value, 100)}`;
        const draft: RowDraft = { violations: [], notes: [] };
        let enqueued = false;
        try {
          const id = await queue.enqueue(kind.value as string, payload.value);
          enqueued = true;
          if (typeof id !== "string" || id.length === 0)
            draft.violations.push("enqueue_id_not_string");
          const received = await receiveWithRetry(queue);
          if (received.length !== 1) draft.violations.push("roundtrip_count_not_1");
          const entry = received[0];
          if (entry) {
            if (!Number.isInteger(entry.job.attempt) || entry.job.attempt < 1)
              draft.violations.push("attempt_not_finite");
            if (typeof kind.value === "string" && entry.job.kind !== kind.value)
              draft.violations.push("kind_roundtrip_mismatch");
            if (typeof entry.job.kind !== "string")
              draft.notes.push(`kind_not_string_on_wire:${typeof entry.job.kind}`);
            await entry.ack();
          }
        } catch (error) {
          draft.error = errorText(error);
          if (enqueued) draft.violations.push("receive_or_ack_threw");
          else if (!(error instanceof Error)) draft.violations.push("reject_not_error");
          else {
            draft.notes.push(`rejected:${error.name}`);
            if ((await messageCount(queueUrl)) !== 0) draft.violations.push("write_before_reject");
          }
        }
        const pollution = prototypePollution();
        if (pollution) draft.violations.push(pollution);
        rows.push(finish("elasticmq-encode", iter, seed, category, input, draft));
      }
      const summary = summarize("elasticmq-encode", SEED, rows);
      const { rowsPath } = writeReport(
        OUT_DIR,
        `elasticmq-encode.seed${SEED}.iter${ITER}`,
        rows,
        summary,
      );
      const unclassified = rows.filter((row) => row.outcome === "BROKEN" && !row.gapId);
      expect(
        unclassified,
        `new BROKEN rows in ${rowsPath}: ${JSON.stringify(unclassified.slice(0, 5), null, 2)}`,
      ).toHaveLength(0);
      expect(rows).toHaveLength(ITER);
    },
    Math.max(60_000, ITER * 3_000),
  );

  it("receive(max) boundaries surface the broker's typed 400 as an Error", async () => {
    const queueUrl = await makeQueue("max");
    const queue = new SqsJobQueue({ queueUrl, region, endpoint });
    const rows: StressRow[] = [];
    const rng = new SeededRng(hashSeed("elasticmq-max", SEED));
    const seen = new Set<string>();
    for (let iter = 0; iter < 24; iter += 1) {
      const max = genBoundaryNumber(rng);
      if (seen.has(max.category)) continue;
      seen.add(max.category);
      const draft: RowDraft = { violations: [], notes: [] };
      try {
        const received = await queue.receive(max.value);
        draft.notes.push(`accepted:${received.length}`);
        if (!(Number.isInteger(max.value) && max.value >= 1 && max.value <= 10))
          draft.notes.push("broker_accepted_out_of_range");
      } catch (error) {
        draft.error = errorText(error);
        if (!(error instanceof Error)) draft.violations.push("reject_not_error");
        else draft.notes.push(`typed_error:${error.name}`);
        if (Number.isInteger(max.value) && max.value >= 1 && max.value <= 10)
          draft.violations.push("valid_max_rejected");
      }
      rows.push(
        finish(
          "elasticmq-max",
          iter,
          hashSeed("elasticmq-max", SEED + iter),
          `max-${max.category}`,
          `max=${String(max.value)}`,
          draft,
        ),
      );
    }
    const summary = summarize("elasticmq-max", SEED, rows);
    writeReport(OUT_DIR, `elasticmq-max.seed${SEED}`, rows, summary);
    expect(rows.filter((row) => row.outcome === "BROKEN")).toHaveLength(0);
    expect(rows.length).toBeGreaterThan(5);
  }, 60_000);

  it("GAP-QUEUE-1 on the real wire: `null` body throws and re-polls advance neighbours' receive count", async () => {
    const queueUrl = await makeQueue("gap1");
    const queue = new SqsJobQueue({ queueUrl, region, endpoint });
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ kind: "media.process", payload: { assetId: "ok" } }),
      }),
    );
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "null" }));
    await expect(queue.receive(10)).rejects.toThrow(TypeError);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    await expect(queue.receive(10)).rejects.toThrow(TypeError);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const raw = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    const counts = Object.fromEntries(
      (raw.Messages ?? []).map((message) => [
        message.Body ?? "",
        Number(message.Attributes?.["ApproximateReceiveCount"]),
      ]),
    );
    expect(raw.Messages).toHaveLength(2);
    // Two failed polls + this raw one: the VALID job has been "received" 3
    // times without ever reaching a handler (redrive maxReceiveCount=5 in
    // infra/terraform/modules/media/main.tf would dead-letter it after 5).
    expect(counts["null"]).toBe(3);
    expect(counts[JSON.stringify({ kind: "media.process", payload: { assetId: "ok" } })]).toBe(3);
  }, 30_000);
});
