import { beforeAll, describe, expect, it } from "vitest";
import { CreateQueueCommand, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SqsJobQueue } from "../src/index.js";

/**
 * Wave H h21-backend-cert (Gate 10): real SQS-protocol behavior against a
 * local ElasticMQ broker. Gated on SQS_ENDPOINT_TEST (e.g.
 * http://localhost:9324) so it runs only where the broker is up.
 * - delivery/ack removes the message
 * - unacked messages redeliver after the visibility timeout with an
 *   incremented ApproximateReceiveCount (attempt)
 * - a malformed message body never throws; it surfaces as an unknown kind
 *   and stays visible until explicitly handled
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";

describe.skipIf(!endpoint)("SqsJobQueue against ElasticMQ", () => {
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
        QueueName: name,
        Attributes: { VisibilityTimeout: "1" },
      }),
    );
    return created.QueueUrl!;
  }

  it("delivers once and ack removes the message", async () => {
    const queueUrl = await makeQueue(`cert-ack-${Date.now()}`);
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await q.enqueue("media.process", { assetId: "a1" });
    const received = await q.receive(10);
    expect(received).toHaveLength(1);
    expect(received[0]?.job.kind).toBe("media.process");
    expect(received[0]?.job.attempt).toBe(1);
    await received[0]?.ack();
    await new Promise((r) => setTimeout(r, 1200)); // visibility window passes
    expect(await q.receive(10)).toHaveLength(0);
  });

  it("redelivers unacked messages with incremented attempt", async () => {
    const queueUrl = await makeQueue(`cert-redeliver-${Date.now()}`);
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await q.enqueue("media.purge", { assetId: "a2" });
    const first = await q.receive(1);
    expect(first[0]?.job.attempt).toBe(1);
    // no ack — wait out the 1s visibility timeout
    await new Promise((r) => setTimeout(r, 1500));
    const second = await q.receive(1);
    expect(second[0]?.job.attempt).toBe(2);
    expect(second[0]?.job.payload).toEqual({ assetId: "a2" });
    await second[0]?.ack();
  }, 15000);

  it("a malformed body never throws and stays visible as an unknown kind", async () => {
    const queueUrl = await makeQueue(`cert-malformed-${Date.now()}`);
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "{not json" }));
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    const received = await q.receive(10);
    expect(received).toHaveLength(1);
    expect(received[0]?.job.kind).toBe("__malformed__");
    expect(received[0]?.job.payload).toBe("{not json");
  });
});
