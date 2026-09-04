import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { runMigrations, seed } from "@pickle/database";
import { SqsJobQueue } from "@pickle/queue";
import type { AnalyticsEvent, IAnalyticsSink } from "@pickle/analytics";
import { QueueSloMonitor, DEFAULT_QUEUE_SLO_CONFIG } from "@pickle/slo";
import { enforceMediaRetention, runOnce, type WorkerDeps } from "../src/worker.js";

/**
 * Adversarial pass 3 (tester #2) — the SqsJobQueue half of the stalled-queue
 * scenario plus retention dispatch latency, against a REAL SQS-protocol
 * broker (ElasticMQ, `docker compose up -d elasticmq`). Gated on
 * SQS_ENDPOINT_TEST (and DATABASE_URL_TEST for the retention scenario).
 *
 *  S2-sqs   1,000 share.render on SqsJobQueue: the monitor receives depth=-1
 *           and oldestJobAgeMs=null every cycle; queue_stalled(no_progress)
 *           still fires because jobsSeen>0 while messages are visible.
 *  S2-sqs-b A SMALL stuck backlog (1 poison job) under the production
 *           visibility timeout (30s) and poll interval: the job is invisible
 *           on cycles 2..N → jobsSeen=0, depth=-1 → idle counter resets →
 *           queue_stalled can NEVER fire. Documented gap.
 *  S2-sqs-c Same job with a 1s visibility timeout and >1s cycles alerts
 *           after 3 cycles: the gap is a function of visibility vs poll.
 *  S7-sqs   500 expired share_video rows dispatched through SqsJobQueue:
 *           500 SendMessage round trips inside enforceMediaRetention.
 */

const endpoint = process.env["SQS_ENDPOINT_TEST"] ?? "";
const testUrl = process.env["DATABASE_URL_TEST"];
const region = "elasticmq";
const WORKER_INTERVAL_MS = Number(process.env["WORKER_INTERVAL_MS"] ?? 5000);
const schemaName = `attack_p3sqs_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "database",
  "migrations",
);

const emptyPool = {
  query: async () => ({ rows: [], rowCount: 0 }),
} as unknown as pg.Pool;

function evidence(scenario: string, data: Record<string, unknown>): void {
  console.log(`ATTACK_EVIDENCE ${JSON.stringify({ scenario, ...data })}`);
}

/** Creates a queue through the plain SQS query API (no extra SDK dependency here). */
async function createQueue(name: string, visibilityTimeoutSeconds: number): Promise<string> {
  const body = new URLSearchParams({
    Action: "CreateQueue",
    QueueName: name,
    "Attribute.1.Name": "VisibilityTimeout",
    "Attribute.1.Value": String(visibilityTimeoutSeconds),
    Version: "2012-11-05",
  });
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const xml = await response.text();
  const match = /<QueueUrl>([^<]+)<\/QueueUrl>/.exec(xml);
  if (!response.ok || !match?.[1]) throw new Error(`CreateQueue failed: ${response.status} ${xml}`);
  // ElasticMQ reports its own host; keep the caller's endpoint (docker port mapping).
  const reported = new URL(match[1]);
  return `${endpoint.replace(/\/$/, "")}${reported.pathname}`;
}

function makeSink(): { sink: IAnalyticsSink; tracked: AnalyticsEvent[] } {
  const tracked: AnalyticsEvent[] = [];
  return {
    tracked,
    sink: { track: (event) => void tracked.push(event), flush: async () => {} },
  };
}

type Observation = {
  depth: number;
  oldestJobAgeMs: number | null;
  jobsHandled: number;
  jobsSeen: number;
};

function spyMonitor(config = DEFAULT_QUEUE_SLO_CONFIG): {
  monitor: QueueSloMonitor;
  observations: Observation[];
} {
  const monitor = new QueueSloMonitor({ ...config, stalledAfterIdleCycles: 3 });
  const observations: Observation[] = [];
  const observe = monitor.observe.bind(monitor);
  monitor.observe = (observation) => {
    observations.push(observation);
    return observe(observation);
  };
  return { monitor, observations };
}

async function enqueueMany(queue: SqsJobQueue, n: number, concurrency = 32): Promise<number> {
  const t0 = performance.now();
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (next < n) {
      const i = next++;
      await queue.enqueue("share.render", { shotId: `shot-${i}` });
    }
  });
  await Promise.all(workers);
  return performance.now() - t0;
}

describe.skipIf(!endpoint)("attack pass 3: SqsJobQueue observability against ElasticMQ", () => {
  beforeAll(() => {
    process.env["AWS_ACCESS_KEY_ID"] ??= "x";
    process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
  });

  it("S2-sqs: 1,000 share.render → monitor sees depth=-1/oldestJobAgeMs=null yet alerts no_progress while messages are visible", async () => {
    const queueUrl = await createQueue(`attack-p3-burst-${Date.now()}`, 30);
    const queue = new SqsJobQueue({ queueUrl, region, endpoint });
    const n = 1000;
    const enqueueMs = await enqueueMany(queue, n);
    expect(await queue.size()).toBe(-1);
    expect(await queue.oldestJobAgeMs()).toBeNull();

    const { monitor, observations } = spyMonitor();
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
      sloMonitor: monitor,
    };
    const alerts: Array<{ cycle: number; depth: number; hasAge: boolean; reason: string }> = [];
    const backlog: Array<{ depth: number; hasAge: boolean }> = [];
    const jobsSeen: number[] = [];
    for (let cycle = 1; cycle <= 5; cycle++) {
      const result = await runOnce(deps);
      expect(result.jobs).toBe(0);
      for (const event of tracked) {
        if (event.name === "queue_stalled")
          alerts.push({
            cycle,
            depth: event.depth,
            hasAge: event.oldestJobAgeMs !== undefined,
            reason: event.reason,
          });
        if (event.name === "queue_backlog")
          backlog.push({ depth: event.depth, hasAge: event.oldestJobAgeMs !== undefined });
      }
      tracked.length = 0;
      jobsSeen.push(observations[cycle - 1]!.jobsSeen);
    }
    for (const o of observations) {
      expect(o.depth).toBe(-1);
      expect(o.oldestJobAgeMs).toBeNull();
      expect(o.jobsHandled).toBe(0);
      expect(o.jobsSeen).toBeGreaterThan(0); // messages visible: SQS hands out the next batch
    }
    for (const b of backlog) {
      expect(b.depth).toBe(-1); // the backlog event reports a sentinel, not a depth
      expect(b.hasAge).toBe(false);
    }
    // It CAN alert — purely from jobsSeen>0 && jobsHandled=0; never from age.
    expect(alerts.map((a) => a.cycle)).toEqual([3, 4, 5]);
    for (const a of alerts) {
      expect(a.reason).toBe("no_progress");
      expect(a.depth).toBe(-1);
      expect(a.hasAge).toBe(false);
    }
    evidence("S2-sqs-1000", {
      jobs: n,
      enqueueMs: Number(enqueueMs.toFixed(1)),
      observations,
      backlogEvents: backlog,
      alerts,
      jobsSeenPerCycle: jobsSeen,
      ageRuleUsable: false,
      depthRuleUsable: false,
    });
  }, 60_000);

  it("S2-sqs-b: a single stuck job under a 30s visibility timeout never trips queue_stalled (idle counter resets while it is invisible)", async () => {
    const queueUrl = await createQueue(`attack-p3-stuck-${Date.now()}`, 30);
    const queue = new SqsJobQueue({ queueUrl, region, endpoint });
    await queue.enqueue("share.render", { shotId: "poison" });
    const { monitor, observations } = spyMonitor();
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
      sloMonitor: monitor,
    };
    const idle: number[] = [];
    for (let cycle = 1; cycle <= 6; cycle++) {
      await runOnce(deps);
      idle.push(monitor.consecutiveIdleCycles());
    }
    const stalled = tracked.filter((e) => e.name === "queue_stalled");
    const failures = tracked.filter((e) => e.name === "worker_failure");
    evidence("S2-sqs-single-stuck-30s", {
      idleCyclesPerCycle: idle,
      jobsSeenPerCycle: observations.map((o) => o.jobsSeen),
      stalledAlerts: stalled.length,
      workerFailures: failures.length,
    });
    // Documented gap: only the first cycle sees the job; afterwards jobsSeen=0
    // and depth=-1 → workVisible=false → idleCycles resets → no alert, ever,
    // while the job is redelivered forever (worker_failure fires once per sighting).
    expect(observations.map((o) => o.jobsSeen)).toEqual([1, 0, 0, 0, 0, 0]);
    expect(idle).toEqual([1, 0, 0, 0, 0, 0]);
    expect(stalled).toHaveLength(0);
    expect(failures).toHaveLength(1);
  }, 60_000);

  it("S2-sqs-c: the same stuck job with a 1s visibility timeout and >1s cycles alerts on the third sighting", async () => {
    const queueUrl = await createQueue(`attack-p3-stuck1s-${Date.now()}`, 1);
    const queue = new SqsJobQueue({ queueUrl, region, endpoint });
    await queue.enqueue("share.render", { shotId: "poison" });
    const { monitor, observations } = spyMonitor();
    const { sink, tracked } = makeSink();
    const deps: WorkerDeps = {
      pool: emptyPool,
      queue,
      objectStore: null,
      transcoder: null,
      log: () => {},
      analytics: sink,
      sloMonitor: monitor,
    };
    const attempts: number[] = [];
    const seenReceive = queue.receive.bind(queue);
    queue.receive = async (max) => {
      const batch = await seenReceive(max);
      for (const { job } of batch) attempts.push(job.attempt);
      return batch;
    };
    for (let cycle = 1; cycle <= 3; cycle++) {
      await runOnce(deps);
      await new Promise((r) => setTimeout(r, 1200)); // visibility window passes
    }
    const stalled = tracked.filter((e) => e.name === "queue_stalled");
    evidence("S2-sqs-single-stuck-1s", {
      jobsSeenPerCycle: observations.map((o) => o.jobsSeen),
      attemptsSeen: attempts,
      stalledAlerts: stalled.length,
    });
    expect(observations.map((o) => o.jobsSeen)).toEqual([1, 1, 1]);
    expect(attempts).toEqual([1, 2, 3]); // ApproximateReceiveCount grows: redelivery, not loss
    expect(stalled).toHaveLength(1);
  }, 60_000);
});

describe.skipIf(!endpoint || !testUrl)(
  "attack pass 3: retention dispatch through SqsJobQueue (ElasticMQ + isolated PostgreSQL schema)",
  () => {
    let pool: pg.Pool;
    let adminPool: pg.Pool;

    beforeAll(async () => {
      process.env["AWS_ACCESS_KEY_ID"] ??= "x";
      process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
      adminPool = new pg.Pool({ connectionString: testUrl });
      await adminPool.query(`CREATE SCHEMA ${schemaName}`);
      const url = new URL(testUrl!);
      url.searchParams.set("options", `-c search_path=${schemaName}`);
      pool = new pg.Pool({ connectionString: url.toString() });
      await runMigrations(pool, migrationsDir);
      await seed(pool);
    }, 60_000);

    afterAll(async () => {
      await pool?.end();
      if (adminPool) {
        await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
        await adminPool.end();
      }
    });

    it("S7-sqs: 500 expired share_video rows → 500 sequential SendMessage calls inside enforceMediaRetention", async () => {
      const user = await pool.query(
        "INSERT INTO app_user (auth_subject) VALUES ($1) RETURNING id",
        [`auth0|attack-s7sqs-${randomUUID()}`],
      );
      const uid = user.rows[0].id as string;
      const n = 500;
      const oldCreated = new Date(Date.now() - 31 * 24 * 3600 * 1000);
      for (let i = 0; i < n; i++) {
        await pool.query(
          `INSERT INTO media_asset (owner_user_id, kind, bucket, object_key, status, created_at)
           VALUES ($1, 'share_video', 'b', $2, 'ready', $3)`,
          [uid, `media/${uid}/share-${i}`, oldCreated],
        );
      }
      const queueUrl = await createQueue(`attack-p3-retention-${Date.now()}`, 30);
      const queue = new SqsJobQueue({ queueUrl, region, endpoint });
      let sends = 0;
      const realEnqueue = queue.enqueue.bind(queue);
      queue.enqueue = async (kind, payload) => {
        sends++;
        return realEnqueue(kind, payload);
      };
      const deps: WorkerDeps = {
        pool,
        queue,
        objectStore: null,
        transcoder: null,
        log: () => {},
      };
      const t0 = performance.now();
      const expired = await enforceMediaRetention(deps);
      const enforceMs = performance.now() - t0;
      expect(expired).toBe(n);
      expect(sends).toBe(n);
      const audits = await pool.query(
        `SELECT count(*)::int AS n FROM audit_log a JOIN media_asset m ON m.id::text = a.target_id
         WHERE a.action = 'media.retention_expired' AND m.owner_user_id = $1`,
        [uid],
      );
      expect(audits.rows[0].n).toBe(n);
      // Drain to count what actually landed on the broker.
      const ids = new Set<string>();
      let empty = 0;
      while (empty < 2) {
        const batch = await queue.receive(10);
        if (batch.length === 0) {
          empty++;
          continue;
        }
        for (const { job } of batch)
          ids.add((job.payload as { mediaAssetId: string }).mediaAssetId);
      }
      expect(ids.size).toBe(n);
      const perSendMs = enforceMs / n;
      evidence("S7-sqs", {
        rows: n,
        enforceMs: Number(enforceMs.toFixed(1)),
        perSendMsLocalBroker: Number(perSendMs.toFixed(2)),
        landed: ids.size,
        workerIntervalMs: WORKER_INTERVAL_MS,
        withinInterval: enforceMs < WORKER_INTERVAL_MS,
        // Extrapolation (INFERRED, not measured): at a typical 20-50 ms SQS
        // round trip the same 500 sequential sends take 10-25 s.
        extrapolatedMsAt20msRtt: n * 20,
        extrapolatedMsAt50msRtt: n * 50,
      });
      expect(enforceMs).toBeLessThan(WORKER_INTERVAL_MS);
    }, 120_000);
  },
);
