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
}

export class InMemoryJobQueue implements IJobQueue {
  private jobs: JobEnvelope[] = [];
  private inFlight = new Map<string, JobEnvelope>();
  private counter = 0;

  async enqueue(kind: string, payload: unknown): Promise<string> {
    const id = `job-${++this.counter}`;
    this.jobs.push({ id, kind, payload, attempt: 0 });
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
      }),
    );
    return (result.Messages ?? []).map((message) => {
      const parsed = JSON.parse(message.Body ?? "{}") as { kind: string; payload: unknown };
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
}
