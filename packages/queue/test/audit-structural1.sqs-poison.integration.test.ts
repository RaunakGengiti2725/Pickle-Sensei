import { beforeAll, describe, expect, it } from "vitest";
import { CreateQueueCommand, SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { SqsJobQueue } from "../src/index.js";

/**
 * Structural audit #1 (storage-media-worker): SQS poison-message contract.
 * The queue promises "a malformed body never throws; it surfaces as an
 * unknown kind and stays visible". The existing suite only pins the
 * JSON-syntax-error case (`{not json`). These cases are VALID JSON whose
 * shape is not `{kind, payload}`.
 *
 * Gated on SQS_ENDPOINT_TEST (ElasticMQ, e.g. http://localhost:9324).
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";

describe.skipIf(!endpoint)("audit-structural1: SqsJobQueue poison bodies (ElasticMQ)", () => {
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

  it("a body that is the JSON literal `null` must not make receive() reject (it would abort the whole batch)", async () => {
    const queueUrl = await makeQueue(`audit-null-${Date.now()}`);
    await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: "null" }));
    // A healthy message sharing the batch must still be delivered.
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await q.enqueue("media.purge", { mediaAssetId: "healthy" });
    let received: Awaited<ReturnType<SqsJobQueue["receive"]>> = [];
    for (let i = 0; i < 3 && received.length < 2; i++) {
      received = received.concat(await q.receive(10));
    }
    expect(received).toHaveLength(2);
    const kinds = received.map((r) => r.job.kind).sort();
    expect(kinds).toEqual(["__malformed__", "media.purge"]);
  }, 15_000);

  it("a body that is a JSON string / array / number surfaces as a string kind (never undefined)", async () => {
    const queueUrl = await makeQueue(`audit-shape-${Date.now()}`);
    for (const body of ['"just a string"', "[1,2]", "42", "{}"]) {
      await client.send(new SendMessageCommand({ QueueUrl: queueUrl, MessageBody: body }));
    }
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    let received: Awaited<ReturnType<SqsJobQueue["receive"]>> = [];
    for (let i = 0; i < 4 && received.length < 4; i++) {
      received = received.concat(await q.receive(10));
    }
    expect(received).toHaveLength(4);
    for (const { job } of received) {
      // JobEnvelope.kind is typed `string`; consumers switch on it and put it
      // into analytics (`jobKind`). An undefined kind is an untyped hole.
      expect(typeof job.kind).toBe("string");
    }
  }, 15_000);

  it("VERIFY attempt == receive count keeps growing past 2 with no cap (documented: no DLQ)", async () => {
    const queueUrl = await makeQueue(`audit-attempts-${Date.now()}`);
    const q = new SqsJobQueue({ queueUrl, region, endpoint });
    await q.enqueue("share.render", { id: "s1" });
    const attempts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const got = await q.receive(1);
      expect(got).toHaveLength(1);
      attempts.push(got[0]!.job.attempt);
      await new Promise((r) => setTimeout(r, 1300)); // visibility timeout passes, no ack
    }
    expect(attempts).toEqual([1, 2, 3]);
  }, 20_000);
});
