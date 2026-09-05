import { beforeAll, describe, expect, it } from "vitest";
import { CreateQueueCommand, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { InMemoryJobQueue, SqsJobQueue } from "../../src/index.js";

/**
 * Independent adjudication replays for stress area packages-ops-2 (queue).
 * Each `it` asserts the DESIRED behaviour, so it is red while the defect is
 * present and turns green once fixed. Run with
 * `SQS_ENDPOINT_TEST=http://localhost:9324 pnpm --filter @pickle/queue test -- test/adjudication`.
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";

describe.skipIf(!endpoint)("ADJ-Q1: JSON `null` body must not abort the receive batch", () => {
  const region = "elasticmq";
  let client: SQSClient;

  beforeAll(() => {
    process.env["AWS_ACCESS_KEY_ID"] ??= "x";
    process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
    client = new SQSClient({ region, endpoint });
  });

  it("returns the null-bodied message as __malformed__ beside its valid neighbours", async () => {
    const created = await client.send(
      new CreateQueueCommand({
        QueueName: `adj-q1-null-${Date.now()}`,
        Attributes: { VisibilityTimeout: "1" },
      }),
    );
    const queueUrl = created.QueueUrl!;
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ kind: "media.process", payload: { assetId: "a" } }),
      }),
    );
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "null" }));
    await client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify({ kind: "media.purge", payload: { assetId: "b" } }),
      }),
    );
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    const received = await q.receive(10);
    expect(received).toHaveLength(3);
    const kinds = received.map((r) => r.job.kind).sort();
    expect(kinds).toEqual(["__malformed__", "media.process", "media.purge"]);
  });
});

describe("ADJ-Q3: InMemoryJobQueue stale ack after visibility expiry", () => {
  it("a late ack from the first delivery must not drop the redelivered job", async () => {
    const q = new InMemoryJobQueue();
    const id = await q.enqueue("media.process", { assetId: "x" });
    const [first] = await q.receive(1);
    expect(first?.job.id).toBe(id);
    q.expireInFlight(); // visibility timeout: job goes back to the queue
    const [second] = await q.receive(1);
    expect(second?.job.id).toBe(id);
    expect(second?.job.attempt).toBe(2);
    await first!.ack(); // stale ack from the superseded delivery
    // The second delivery is still in flight and must survive a later expiry.
    q.expireInFlight();
    expect(await q.size()).toBe(1);
    expect(await q.oldestJobAgeMs()).not.toBeNull();
  });
});
