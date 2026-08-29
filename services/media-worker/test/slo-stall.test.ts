import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { findPrivacyViolations } from "@pickle/analytics";
import { InMemoryJobQueue } from "@pickle/queue";
import { QueueSloMonitor } from "@pickle/slo";
import { runOnce, type WorkerDeps } from "../src/worker.js";

/**
 * Wave I i19: worker-crash / stalled-queue SLO suite. Proves two invariants:
 * (1) an analysis job is NEVER silently lost when the worker crashes — it
 * stays visible on the queue with its payload intact; (2) a queue that stops
 * making progress surfaces a typed queue_stalled alert, loudly.
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

function makeDeps(queue: InMemoryJobQueue, sink: IAnalyticsSink, pool = emptyPool): WorkerDeps {
  return {
    pool,
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
}

describe("analyses are never silently lost on worker crash", () => {
  it("keeps an analysis.deep job on the queue when the handler cannot process it", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("analysis.deep", { shotId: "shot-1" });
    const { sink } = makeSink();
    const deps = makeDeps(queue, sink);

    await runOnce(deps);
    queue.expireInFlight(); // visibility timeout after the failed cycle
    expect(await queue.size()).toBe(1);

    // The job comes back with the same payload and a higher attempt count.
    const [redelivered] = await queue.receive(1);
    expect(redelivered!.job.kind).toBe("analysis.deep");
    expect(redelivered!.job.payload).toEqual({ shotId: "shot-1" });
    expect(redelivered!.job.attempt).toBe(2);
  });

  it("keeps an analysis.deep job visible when the handler crashes mid-job", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("media.process", { mediaAssetId: "m1" });
    await queue.enqueue("analysis.deep", { shotId: "shot-2" });
    const crashingPool = {
      query: async () => {
        throw new Error("connection terminated: worker crashed mid-transaction");
      },
    } as unknown as pg.Pool;
    const { sink, tracked } = makeSink();
    const deps = makeDeps(queue, sink, crashingPool);

    // The cycle itself blows up (DB gone) — main.ts survives this and counts
    // it as worker_crash; the invariant under test is that no job is lost.
    await runOnce(deps).catch(() => {});
    queue.expireInFlight();
    // Both jobs survive: the crashed media.process AND the analysis job.
    expect(await queue.size()).toBe(2);
    const kinds = (await queue.receive(10)).map((r) => r.job.kind).sort();
    expect(kinds).toEqual(["analysis.deep", "media.process"]);
    // The crash is loud: a typed worker_failure event, not a silent retry.
    const failures = tracked.filter((e) => e.name === "worker_failure");
    expect(failures.some((f) => f.name === "worker_failure" && f.jobKind === "media.process")).toBe(
      true,
    );
  });

  it("raises a typed queue_stalled alert when analyses stop completing", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("analysis.deep", { shotId: "shot-3" });
    const { sink, tracked } = makeSink();
    const deps = makeDeps(queue, sink);
    const loudLines: string[] = [];
    deps.log = (line) => void loudLines.push(line);

    for (let cycle = 0; cycle < 3; cycle++) {
      await runOnce(deps);
      queue.expireInFlight();
    }

    const stalled = tracked.filter((e) => e.name === "queue_stalled");
    expect(stalled.length).toBeGreaterThanOrEqual(1);
    const alert = stalled[0]!;
    expect(alert).toMatchObject({
      name: "queue_stalled",
      queue: "media",
      reason: "no_progress",
      consecutiveIdleCycles: 3,
    });
    // In-memory queues can measure oldest-job age, so the alert carries it.
    if (alert.name === "queue_stalled") {
      expect(alert.oldestJobAgeMs).toBeGreaterThanOrEqual(0);
    }
    // And the log surface screams too.
    expect(loudLines.some((line) => line.includes("QUEUE STALLED"))).toBe(true);
    // The stalled job itself is still there — alerting never consumes work.
    expect(await queue.size()).toBe(1);
    // Alert events pass the redaction guard (no payloads, keys, or paths).
    for (const event of stalled) expect(findPrivacyViolations(event)).toEqual([]);
  });

  it("does not alert while the queue is draining normally", async () => {
    const queue = new InMemoryJobQueue();
    // media.process with no transcoder is handled (acked) — real progress.
    await queue.enqueue("media.process", { mediaAssetId: "m2" });
    const { sink, tracked } = makeSink();
    const deps = makeDeps(queue, sink);

    for (let cycle = 0; cycle < 5; cycle++) await runOnce(deps);
    expect(tracked.filter((e) => e.name === "queue_stalled")).toEqual([]);
    expect(await queue.size()).toBe(0);
  });

  it("emits queue_backlog with oldest-job age each cycle", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("analysis.deep", { shotId: "shot-4" });
    const { sink, tracked } = makeSink();
    await runOnce(makeDeps(queue, sink));
    queue.expireInFlight();
    const backlog = tracked.filter((e) => e.name === "queue_backlog");
    expect(backlog).toHaveLength(1);
    const event = backlog[0]!;
    if (event.name === "queue_backlog") {
      expect(event.depth).toBeGreaterThanOrEqual(0);
      expect(event.oldestJobAgeMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("emits a typed media_storage_failure and keeps the purge job when storage fails", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("media.purge", { mediaAssetId: "00000000-0000-0000-0000-000000000001" });
    const pool = {
      query: async (sql: string) =>
        sql.includes("FROM media_asset WHERE id")
          ? { rows: [{ object_key: "media/u/abc", deleted_at: new Date() }], rowCount: 1 }
          : { rows: [], rowCount: 0 },
    } as unknown as pg.Pool;
    const { sink, tracked } = makeSink();
    const deps = makeDeps(queue, sink, pool);
    deps.objectStore = {
      deleteObject: async () => {
        throw new Error("S3 503 SlowDown");
      },
    };

    await runOnce(deps);
    queue.expireInFlight();
    // The purge is not acked — deletion work is never silently dropped.
    expect(await queue.size()).toBe(1);
    const storageFailures = tracked.filter((e) => e.name === "media_storage_failure");
    expect(storageFailures).toHaveLength(1);
    expect(storageFailures[0]).toMatchObject({ operation: "purge" });
    for (const event of storageFailures) expect(findPrivacyViolations(event)).toEqual([]);
  });
});
