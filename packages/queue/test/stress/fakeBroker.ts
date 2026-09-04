/**
 * In-process stand-in for `SQSClient` used by the boundary/malformed stress
 * tests (installed via `vi.mock("@aws-sdk/client-sqs")`).
 *
 * It mirrors the documented SQS request validation the package can hit —
 * MaxNumberOfMessages 1..10, MessageBody 1..262,144 bytes, the XML-safe
 * character set — and, unlike a real broker, lets a test INJECT arbitrary
 * `Message.Body` / `Attributes` values so `SqsJobQueue.receive` can be driven
 * with thousands of hostile bodies per second. Validation limits are taken
 * from the AWS SQS API reference (INFERRED, not measured against AWS); the
 * ElasticMQ campaign covers the real wire protocol.
 */

export interface FakeMessage {
  MessageId: string;
  ReceiptHandle: string;
  Body: string | undefined;
  /** `undefined` = synthesize a real ApproximateReceiveCount; `null` = omit Attributes entirely. */
  Attributes: Record<string, string> | undefined | null;
  receiveCount: number;
}

export interface RecordedSend {
  QueueUrl: string;
  MessageBody: unknown;
  bytes: number;
}

export class SqsLikeError extends Error {
  public readonly $fault = "client" as const;
  public readonly $metadata = { httpStatusCode: 400 };
  public constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}

export const SQS_MAX_BODY_BYTES = 262144;

/** SQS MessageBody charset: #x9 | #xA | #xD | #x20-#xD7FF | #xE000-#xFFFD | #x10000-#x10FFFF. */
export function bodyCharsetViolation(body: string): string | null {
  for (let index = 0; index < body.length; index += 1) {
    const codePoint = body.codePointAt(index);
    if (codePoint === undefined) return `undefined code point at ${index}`;
    if (codePoint > 0xffff) {
      index += 1;
      continue;
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff)
      return `lone surrogate U+${codePoint.toString(16)}`;
    const ok =
      codePoint === 0x9 ||
      codePoint === 0xa ||
      codePoint === 0xd ||
      (codePoint >= 0x20 && codePoint <= 0xd7ff) ||
      (codePoint >= 0xe000 && codePoint <= 0xfffd);
    if (!ok) return `disallowed U+${codePoint.toString(16).padStart(4, "0")} at ${index}`;
  }
  return null;
}

interface CommandLike {
  constructor: { name: string };
  input: Record<string, unknown>;
}

class FakeQueue {
  public readonly visible: FakeMessage[] = [];
  public readonly inFlight = new Map<string, FakeMessage>();
  private counter = 0;

  public inject(
    body: string | undefined,
    attributes: Record<string, string> | undefined | null,
  ): FakeMessage {
    this.counter += 1;
    const message: FakeMessage = {
      MessageId: `fake-${this.counter}`,
      ReceiptHandle: `rh-${this.counter}`,
      Body: body,
      Attributes: attributes,
      receiveCount: 0,
    };
    this.visible.push(message);
    return message;
  }
}

export class FakeBroker {
  public readonly queues = new Map<string, FakeQueue>();
  public readonly sends: RecordedSend[] = [];
  public readonly deletes: string[] = [];

  public reset(): void {
    this.queues.clear();
    this.sends.length = 0;
    this.deletes.length = 0;
  }

  public queue(url: string): FakeQueue {
    let queue = this.queues.get(url);
    if (!queue) {
      queue = new FakeQueue();
      this.queues.set(url, queue);
    }
    return queue;
  }

  /** Put a raw message on the queue exactly as a broker would hand it back. */
  public inject(
    url: string,
    body: string | undefined,
    attributes: Record<string, string> | undefined | null = undefined,
  ): FakeMessage {
    return this.queue(url).inject(body, attributes);
  }

  public handle(command: CommandLike): unknown {
    switch (command.constructor.name) {
      case "SendMessageCommand":
        return this.send(command.input);
      case "ReceiveMessageCommand":
        return this.receive(command.input);
      case "DeleteMessageCommand":
        return this.delete(command.input);
      default:
        throw new SqsLikeError("InvalidAction", `unsupported command ${command.constructor.name}`);
    }
  }

  private send(input: Record<string, unknown>): { MessageId: string } {
    const url = String(input["QueueUrl"]);
    const body = input["MessageBody"];
    if (typeof body !== "string")
      throw new SqsLikeError("MissingParameter", "MessageBody must be a string");
    const bytes = Buffer.byteLength(body, "utf8");
    // Recorded BEFORE validation so a rejected send is still visible as a
    // write attempt the harness can flag.
    this.sends.push({ QueueUrl: url, MessageBody: body, bytes });
    if (bytes === 0 || bytes > SQS_MAX_BODY_BYTES)
      throw new SqsLikeError(
        "InvalidParameterValue",
        `MessageBody must be 1..${SQS_MAX_BODY_BYTES} bytes, got ${bytes}`,
      );
    const charset = bodyCharsetViolation(body);
    if (charset) throw new SqsLikeError("InvalidMessageContents", charset);
    const message = this.queue(url).inject(body, undefined);
    return { MessageId: message.MessageId };
  }

  private receive(input: Record<string, unknown>): {
    Messages?: Array<{
      MessageId: string;
      ReceiptHandle: string;
      Body?: string;
      Attributes?: Record<string, string>;
    }>;
  } {
    const url = String(input["QueueUrl"]);
    const max = input["MaxNumberOfMessages"];
    if (typeof max !== "number" || !Number.isInteger(max) || max < 1 || max > 10)
      throw new SqsLikeError(
        "InvalidAttributeValue",
        "The attribute value for MaxNumberOfMessages is invalid.",
      );
    const queue = this.queue(url);
    const taken = queue.visible.splice(0, max);
    const messages = taken.map((message) => {
      message.receiveCount += 1;
      queue.inFlight.set(message.ReceiptHandle, message);
      const attributes =
        message.Attributes === undefined
          ? { ApproximateReceiveCount: String(message.receiveCount) }
          : message.Attributes;
      return {
        MessageId: message.MessageId,
        ReceiptHandle: message.ReceiptHandle,
        ...(message.Body === undefined ? {} : { Body: message.Body }),
        ...(attributes === null ? {} : { Attributes: attributes }),
      };
    });
    return messages.length === 0 ? {} : { Messages: messages };
  }

  private delete(input: Record<string, unknown>): Record<string, never> {
    const url = String(input["QueueUrl"]);
    const handle = input["ReceiptHandle"];
    const queue = this.queue(url);
    if (typeof handle !== "string" || !queue.inFlight.has(handle))
      throw new SqsLikeError("ReceiptHandleIsInvalid", `unknown receipt handle ${String(handle)}`);
    queue.inFlight.delete(handle);
    this.deletes.push(handle);
    return {};
  }
}

export const fakeBroker = new FakeBroker();

/** Drop-in for `SQSClient`: same constructor shape, `send` routed to the broker. */
export class FakeSQSClient {
  public readonly config: unknown;

  public constructor(config: unknown) {
    this.config = config;
  }

  public async send(command: unknown): Promise<unknown> {
    return fakeBroker.handle(command as CommandLike);
  }
}
