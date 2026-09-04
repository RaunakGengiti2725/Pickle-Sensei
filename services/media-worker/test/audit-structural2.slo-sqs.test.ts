import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { IJobQueue, JobEnvelope } from "@pickle/queue";
import { SqsJobQueue } from "@pickle/queue";
import { QueueSloMonitor } from "@pickle/slo";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { runOnce, type WorkerDeps } from "../src/worker.js";

/**
 * Structural audit #2: the stalled-queue alert ("fires when work is visible
 * but nothing completes", slo-stall.test.ts) is only exercised with
 * InMemoryJobQueue, whose `size()` reports depth. SqsJobQueue reports
 * depth -1 / age null, and a real broker hides an unacked message for the
 * visibility timeout (default 30s) which is longer than the poll interval
 * (5s). These tests run the SAME stuck-job scenario through SQS semantics.
 */

const emptyPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as pg.Pool;

function makeSink(): { sink: IAnalyticsSink; tracked: AnalyticsEvent[] } {
  const tracked: AnalyticsEvent[] = [];
  return {
    tracked,
    sink: { track: (event) => void tracked.push(event), flush: async () => {} },
  };
}

/** SQS-faithful fake: no depth, no age, unacked jobs hidden for N receives. */
class SqsLikeQueue implements IJobQueue {
  private messages: Array<{ job: JobEnvelope; hiddenFor: number }> = [];
  constructor(private visibilityCycles: number) {}
  async enqueue(kind: string, payload: unknown): Promise<string> {
    const id = `m${this.messages.length + 1}`;
    this.messages.push({ job: { id, kind, payload, attempt: 0 }, hiddenFor: 0 });
    return id;
  }
  async receive(max: number): Promise<Array<{ job: JobEnvelope; ack: () => Promise<void> }>> {
    const out: Array<{ job: JobEnvelope; ack: () => Promise<void> }> = [];
    for (const m of this.messages) {
      if (m.hiddenFor > 0) {
        m.hiddenFor--;
        continue;
      }
      if (out.length >= max) continue;
      m.hiddenFor = this.visibilityCycles;
      m.job = { ...m.job, attempt: m.job.attempt + 1 };
      out.push({
        job: m.job,
        ack: async () => {
          this.messages = this.messages.filter((x) => x !== m);
        },
      });
    }
    return out;
  }
  async size(): Promise<number> {
    return -1;
  }
  async oldestJobAgeMs(): Promise<number | null> {
    return null;
  }
  remaining(): number {
    return this.messages.length;
  }
}

describe("structural audit #2: queue_stalled under SQS semantics", () => {
  it("a perpetually unhandled job trips queue_stalled within the idle-cycle budget (fake SQS, visibility > poll)", async () => {
    // Default worker: 5s poll, SQS default 30s visibility → a stuck message is
    // seen once every ~6 cycles. Model that as hidden for 5 receives.
    const queue = new SqsLikeQueue(5);
    await queue.enqueue("share.render", {});
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
      sloMonitor: new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      }),
    };
    // 30 cycles = 2.5 minutes of a job that is never completed.
    for (let i = 0; i < 30; i++) await runOnce(deps);
    expect(queue.remaining()).toBe(1); // still not acked — visibly stuck
    expect(tracked.filter((e) => e.name === "worker_failure").length).toBeGreaterThanOrEqual(5);
    expect(tracked.filter((e) => e.name === "queue_stalled").length).toBeGreaterThan(0);
  });

  it("queue_backlog never reports a negative depth to analytics", async () => {
    const queue = new SqsLikeQueue(1);
    const { sink, tracked } = makeSink();
    await runOnce({
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
    });
    const backlog = tracked.find((e) => e.name === "queue_backlog");
    expect(backlog).toBeDefined();
    if (backlog?.name === "queue_backlog") expect(backlog.depth).toBeGreaterThanOrEqual(0);
  });
});

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";

/** SQS query-protocol CreateQueue (ElasticMQ); avoids a direct SDK dependency here. */
async function createQueue(name: string, visibilityTimeoutSeconds: number): Promise<string> {
  const params = new URLSearchParams({
    Action: "CreateQueue",
    Version: "2012-11-05",
    QueueName: name,
    "Attribute.1.Name": "VisibilityTimeout",
    "Attribute.1.Value": String(visibilityTimeoutSeconds),
  });
  const response = await fetch(`${endpoint}/?${params.toString()}`, { method: "POST" });
  const body = await response.text();
  const match = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(body);
  if (!response.ok || !match) throw new Error(`CreateQueue failed: ${response.status} ${body}`);
  return match[1]!;
}

describe.skipIf(!endpoint)("structural audit #2: queue_stalled against real ElasticMQ", () => {
  it("a perpetually unhandled job trips queue_stalled when visibility timeout exceeds the poll interval", async () => {
    process.env["AWS_ACCESS_KEY_ID"] ??= "x";
    process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
    const region = "elasticmq";
    const queueUrl = await createQueue(`audit-stall-${Date.now()}`, 3);
    const queue = new SqsJobQueue({ queueUrl, region, endpoint });
    await queue.enqueue("share.render", {});
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
      sloMonitor: new QueueSloMonitor({
        queue: "media",
        stalledAfterIdleCycles: 3,
        maxOldestJobAgeMs: null,
      }),
    };
    // ~12s of polling at a sub-visibility interval.
    for (let i = 0; i < 10; i++) {
      await runOnce(deps);
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(tracked.filter((e) => e.name === "worker_failure").length).toBeGreaterThanOrEqual(2);
    expect(tracked.filter((e) => e.name === "queue_stalled").length).toBeGreaterThan(0);
  }, 40_000);
});
