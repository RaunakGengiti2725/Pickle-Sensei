import { CreateQueueCommand, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SqsJobQueue } from "../../src/index.js";
import { assertFiniteNumber } from "./leakHarness.js";
import { fnv1a, iterationSeed, mulberry32, randomPayload } from "./rng.js";

/**
 * One seeded exercise of SqsJobQueue against a real SQS-protocol broker
 * (ElasticMQ). The broker assigns message ids and may reorder, so the digest
 * is over the SORTED set of (kind, payload id) pairs, which IS deterministic
 * for a seed.
 *
 * Invariants:
 *  - every enqueued message comes back exactly once with kind + payload intact
 *  - attempt is a finite integer >= 1 (never NaN from a missing attribute)
 *  - a malformed body (sent through a raw client) surfaces as `__malformed__`
 *    with the raw body as payload and never throws out of receive()
 *  - after acking everything a long-poll receive on the empty queue returns []
 */

const KINDS = ["media.process", "media.purge", "share.render", "analysis.deep"] as const;

export interface SqsScenarioContext {
  endpoint: string;
  region: string;
  queueUrl: string;
  /** Raw client owned by the campaign (created once) for out-of-band sends. */
  raw: SQSClient;
}

export interface SqsScenarioResult {
  seed: number;
  enqueued: number;
  malformed: number;
  receives: number;
  emptyPolls: number;
  digest: string;
}

export async function createScenarioQueue(ctx: Omit<SqsScenarioContext, "queueUrl">, name: string) {
  const created = await ctx.raw.send(
    new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: "30" } }),
  );
  if (!created.QueueUrl) throw new Error("CreateQueue returned no QueueUrl");
  return created.QueueUrl;
}

export async function runSqsScenario(
  queue: SqsJobQueue,
  ctx: SqsScenarioContext,
  campaignSeed: number,
  iteration: number,
): Promise<SqsScenarioResult> {
  const seed = iterationSeed(campaignSeed, iteration);
  const rng = mulberry32(seed);
  const expected = new Map<string, { kind: string; payload: unknown }>();
  const n = rng.int(1, 5);
  for (let i = 0; i < n; i++) {
    const kind = rng.pick(KINDS);
    const payload = randomPayload(rng);
    const id = await queue.enqueue(kind, payload);
    if (id === "unknown") throw new Error(`seed ${seed}: enqueue returned no MessageId`);
    expected.set(payload.id, { kind, payload });
  }
  let malformed = 0;
  let malformedBody = "";
  if (rng.chance(0.15)) {
    malformedBody = `{not json ${rng.int(0, 1_000_000)}`;
    await ctx.raw.send(
      new SendMessageCommand({ QueueUrl: ctx.queueUrl, MessageBody: malformedBody }),
    );
    malformed = 1;
  }

  const seen: string[] = [];
  let receives = 0;
  let remaining = n + malformed;
  let polls = 0;
  while (remaining > 0) {
    if (++polls > 20)
      throw new Error(`seed ${seed}: ${remaining} messages never delivered after 20 polls`);
    const max = rng.int(1, 10);
    const batch = await queue.receive(max);
    receives++;
    if (batch.length > max)
      throw new Error(`seed ${seed}: receive(${max}) returned ${batch.length}`);
    for (const { job, ack } of batch) {
      assertFiniteNumber(job.attempt, `seed ${seed}: attempt`);
      if (!Number.isInteger(job.attempt) || job.attempt < 1) {
        throw new Error(`seed ${seed}: attempt ${job.attempt} not a positive integer`);
      }
      if (job.id === "unknown") throw new Error(`seed ${seed}: message without MessageId`);
      if (job.kind === "__malformed__") {
        if (malformed !== 1 || job.payload !== malformedBody) {
          throw new Error(`seed ${seed}: unexpected malformed payload ${String(job.payload)}`);
        }
        malformed = 0;
        seen.push("__malformed__");
      } else {
        const payload = job.payload as { id?: unknown };
        const key = typeof payload?.id === "string" ? payload.id : "";
        const exp = expected.get(key);
        if (!exp)
          throw new Error(`seed ${seed}: unexpected or duplicate message ${job.id} (${key})`);
        if (exp.kind !== job.kind) throw new Error(`seed ${seed}: kind ${job.kind} != ${exp.kind}`);
        if (JSON.stringify(exp.payload) !== JSON.stringify(job.payload)) {
          throw new Error(`seed ${seed}: payload mismatch for ${key}`);
        }
        expected.delete(key);
        seen.push(`${job.kind}:${key}`);
      }
      await ack();
      remaining--;
    }
  }
  if (expected.size !== 0)
    throw new Error(`seed ${seed}: ${expected.size} messages unaccounted for`);

  let emptyPolls = 0;
  if (rng.chance(0.04)) {
    // Production pattern: the worker long-polls an empty queue most of the time.
    const empty = await queue.receive(10);
    emptyPolls = 1;
    if (empty.length !== 0)
      throw new Error(`seed ${seed}: empty queue returned ${empty.length} messages`);
  }
  assertFiniteNumber(await queue.size(), `seed ${seed}: size`);
  const age = await queue.oldestJobAgeMs();
  if (age !== null) assertFiniteNumber(age, `seed ${seed}: oldestJobAgeMs`);

  seen.sort();
  return {
    seed,
    enqueued: n,
    malformed: malformedBody ? 1 : 0,
    receives,
    emptyPolls,
    digest: fnv1a(seen.join("|")),
  };
}
