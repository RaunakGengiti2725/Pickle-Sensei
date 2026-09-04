import { beforeAll, describe, expect, it } from "vitest";
import { CreateQueueCommand, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SqsJobQueue } from "../src/index.js";

/**
 * Structural audit #2: the documented invariant is "a malformed body must
 * never throw here: that would abort the whole receive batch and crash-loop
 * the consumer on one poison message" (src/index.ts receive()). The existing
 * cert test only covers bodies that are NOT valid JSON. Valid JSON that is not
 * an object (`null`) is the other half of "malformed".
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";

describe.skipIf(!endpoint)("structural audit #2: SqsJobQueue poison bodies (ElasticMQ)", () => {
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

  it("a body of JSON `null` never throws and does not abort the batch's healthy job", async () => {
    const queueUrl = await makeQueue(`audit-null-body-${Date.now()}`);
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "null" }));
    await q.enqueue("media.purge", { mediaAssetId: "healthy" });

    let received: Awaited<ReturnType<SqsJobQueue["receive"]>> = [];
    for (let i = 0; i < 3 && received.length < 2; i++) {
      received = received.concat(await q.receive(10));
    }
    const kinds = received.map((r) => r.job.kind).sort();
    expect(kinds).toEqual(["__malformed__", "media.purge"]);
  }, 15_000);

  it("a body of JSON `[]`/`123` surfaces as a string kind, never `undefined`", async () => {
    const queueUrl = await makeQueue(`audit-nonobject-body-${Date.now()}`);
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "[]" }));
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "123" }));
    let received: Awaited<ReturnType<SqsJobQueue["receive"]>> = [];
    for (let i = 0; i < 3 && received.length < 2; i++) {
      received = received.concat(await q.receive(10));
    }
    expect(received).toHaveLength(2);
    for (const { job } of received) {
      // analytics `worker_failure.jobKind` is typed `string`; the worker
      // forwards job.kind verbatim.
      expect(typeof job.kind).toBe("string");
    }
  }, 15_000);
});
