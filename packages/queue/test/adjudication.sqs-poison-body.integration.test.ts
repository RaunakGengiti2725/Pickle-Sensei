import { beforeAll, describe, expect, it } from "vitest";
import { CreateQueueCommand, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SqsJobQueue } from "../src/index.js";

/**
 * Adjudication (storage-media-worker, 4d812e1a): independent reproduction of
 * the SQS poison-body finding against ElasticMQ (SQS_ENDPOINT_TEST).
 *
 * `SqsJobQueue.receive()` documents that a malformed body never throws. The
 * JSON literal `null` parses successfully, so the `catch` in receive() is
 * bypassed and `parsed.kind` dereferences null: receive() rejects, the whole
 * batch (including healthy messages behind it) is lost for that cycle, and
 * the worker's runOnce() never reaches deletion/retention/sweep work.
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";

describe.skipIf(!endpoint)("adjudication: SqsJobQueue poison bodies (ElasticMQ)", () => {
  const region = "elasticmq";
  let client: SQSClient;

  beforeAll(() => {
    process.env["AWS_ACCESS_KEY_ID"] ??= "x";
    process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
    client = new SQSClient({ region, endpoint });
  });

  async function makeQueue(name: string): Promise<string> {
    const created = await client.send(
      new CreateQueueCommand({ QueueName: name, Attributes: { VisibilityTimeout: "1" } }),
    );
    return created.QueueUrl!;
  }

  it("a body of JSON `null` does not make receive() reject; the healthy job behind it is still delivered", async () => {
    const queueUrl = await makeQueue(`adj-null-${Date.now()}`);
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "null" }));
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await q.enqueue("media.purge", { mediaAssetId: "healthy" });

    const received = await q.receive(10);
    const kinds = received.map((r) => r.job.kind);
    expect(kinds).toContain("media.purge");
    for (const r of received) expect(typeof r.job.kind).toBe("string");
  });

  it('bodies that parse to a non-object (`[]`, `123`, `"s"`) surface as a string kind, never undefined', async () => {
    const queueUrl = await makeQueue(`adj-scalar-${Date.now()}`);
    for (const body of ["[]", "123", '"s"']) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    }
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    const received = await q.receive(10);
    expect(received).toHaveLength(3);
    for (const r of received) expect(typeof r.job.kind).toBe("string");
  });
});
