import {
  SQSClient,
  SendMessageCommand,
  ReceiveMessageCommand,
  DeleteMessageCommand,
} from "@aws-sdk/client-sqs";

/**
 * Job queue abstraction: SQS in cloud, in-memory for tests/local.
 * Every job is typed; consumers acknowledge explicitly (no silent drops).
 */

export interface JobEnvelope<T = unknown> {
  id: string;
  kind: string;
  payload: T;
  attempt: number;
}

export interface IJobQueue {
  enqueue(kind: string, payload: unknown): Promise<string>;
  /** Receive up to `max` jobs; each must be acked or it becomes visible again. */
  receive(max: number): Promise<Array<{ job: JobEnvelope; ack: () => Promise<void> }>>;
  size(): Promise<number>;
  /**
   * Age (ms) of the oldest job that has been enqueued but not yet acked,
   * or null when the backend cannot measure it (SQS exposes this only via
   * CloudWatch, not per-call — reported honestly, never guessed).
   */
  oldestJobAgeMs(): Promise<number | null>;
}

export class InMemoryJobQueue implements IJobQueue {
  private jobs: JobEnvelope[] = [];
  private inFlight = new Map<string, JobEnvelope>();
  private enqueuedAt = new Map<string, number>();
  private counter = 0;

  async enqueue(kind: string, payload: unknown): Promise<string> {
    const id = `job-${++this.counter}`;
    this.jobs.push({ id, kind, payload, attempt: 0 });
    this.enqueuedAt.set(id, Date.now());
    return id;
  }

  async receive(max: number): Promise<Array<{ job: JobEnvelope; ack: () => Promise<void> }>> {
    const taken = this.jobs.splice(0, max);
    return taken.map((job) => {
      const withAttempt = { ...job, attempt: job.attempt + 1 };
      this.inFlight.set(job.id, withAttempt);
      return {
        job: withAttempt,
        ack: async () => {
          this.inFlight.delete(job.id);
          this.enqueuedAt.delete(job.id);
        },
      };
    });
  }

  /** Test helper: requeue everything unacked (visibility timeout expiry). */
  expireInFlight(): void {
    for (const job of this.inFlight.values()) this.jobs.push(job);
    this.inFlight.clear();
  }

  async size(): Promise<number> {
    return this.jobs.length;
  }

  /** Oldest unfinished (queued or in-flight, unacked) job age. */
  async oldestJobAgeMs(): Promise<number | null> {
    if (this.enqueuedAt.size === 0) return null;
    let oldest = Number.POSITIVE_INFINITY;
    for (const at of this.enqueuedAt.values()) if (at < oldest) oldest = at;
    return Date.now() - oldest;
  }
}

export interface SqsQueueConfig {
  queueUrl: string;
  region: string;
  endpoint?: string;
}

export class SqsJobQueue implements IJobQueue {
  private client: SQSClient;
  private queueUrl: string;

  constructor(config: SqsQueueConfig) {
    this.queueUrl = config.queueUrl;
    this.client = new SQSClient(
      config.endpoint
        ? { region: config.region, endpoint: config.endpoint }
        : { region: config.region },
    );
  }

  async enqueue(kind: string, payload: unknown): Promise<string> {
    const result = await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify({ kind, payload }),
      }),
    );
    return result.MessageId ?? "unknown";
  }

  async receive(max: number): Promise<Array<{ job: JobEnvelope; ack: () => Promise<void> }>> {
    const result = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: max,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ["ApproximateReceiveCount"],
      }),
    );
    return (result.Messages ?? []).map((message) => {
      // A malformed body must never throw here: that would abort the whole
      // receive batch and crash-loop the consumer on one poison message. It
      // surfaces as an unknown kind instead, staying visible on the queue.
      let parsed: { kind: string; payload: unknown };
      try {
        parsed = JSON.parse(message.Body ?? "{}") as { kind: string; payload: unknown };
      } catch {
        parsed = { kind: "__malformed__", payload: message.Body };
      }
      return {
        job: {
          id: message.MessageId ?? "unknown",
          kind: parsed.kind,
          payload: parsed.payload,
          attempt: Number(message.Attributes?.["ApproximateReceiveCount"] ?? 1),
        },
        ack: async () => {
          await this.client.send(
            new DeleteMessageCommand({
              QueueUrl: this.queueUrl,
              ReceiptHandle: message.ReceiptHandle,
            }),
          );
        },
      };
    });
  }

  async size(): Promise<number> {
    return -1; // SQS exposes approximate depth via CloudWatch, not per-call.
  }

  async oldestJobAgeMs(): Promise<number | null> {
    return null; // ApproximateAgeOfOldestMessage lives in CloudWatch only.
  }
}
