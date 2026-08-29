import { describe, expect, it } from "vitest";
import type pg from "pg";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { findPrivacyViolations } from "@pickle/analytics";
import { InMemoryJobQueue } from "@pickle/queue";
import { runOnce, type WorkerDeps } from "../src/worker.js";

/** Pool stub: every query returns no rows (no DB needed for telemetry paths). */
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

describe("worker telemetry", () => {
  it("emits worker_failure for unhandled jobs and queue_backlog each cycle", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("share.render", {});
    await queue.enqueue("unknown.kind", {});
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
    };
    await runOnce(deps);
    const failures = tracked.filter((e) => e.name === "worker_failure");
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => (f.name === "worker_failure" ? f.jobKind : ""))).toEqual([
      "share.render",
      "unknown.kind",
    ]);
    for (const f of failures) {
      if (f.name === "worker_failure") expect(f.failureKind).toBe("unhandled");
    }
    const backlog = tracked.filter((e) => e.name === "queue_backlog");
    expect(backlog).toHaveLength(1);
    expect(backlog[0]).toMatchObject({ queue: "media", depth: 0 });
  });

  it("categorizes a throwing handler and keeps events privacy-clean", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("media.purge", { mediaAssetId: "x" });
    const throwingPool = {
      query: async () => {
        throw new Error("ECONN /var/data/pg failed for file:///tmp/clip.mov");
      },
    } as unknown as pg.Pool;
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
    };
    await runOnce({ ...deps, pool: throwingPool }).catch(() => {});
    const failures = tracked.filter((e) => e.name === "worker_failure");
    expect(failures).toHaveLength(1);
    const failure = failures[0]!;
    expect(failure).toMatchObject({
      jobKind: "media.purge",
      failureKind: "handler_exception",
    });
    // The raw error string (with its path and URI) must never reach analytics.
    expect(JSON.stringify(failure)).not.toContain("/var/data");
    expect(findPrivacyViolations(failure)).toEqual([]);
  });

  it("worker_failure events pass the redaction guard even for poison jobs", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("analysis.deep", {});
    const { sink, tracked } = makeSink();
    await runOnce({
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
    });
    for (const event of tracked) {
      expect(findPrivacyViolations(event)).toEqual([]);
    }
  });

  it("emits nothing when no analytics sink is configured (unchanged behavior)", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("share.render", {});
    const result = await runOnce({
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
    });
    expect(result.jobs).toBe(0);
  });
});
