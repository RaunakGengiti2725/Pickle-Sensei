import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateQueueCommand, SQSClient } from "@aws-sdk/client-sqs";
import { afterAll, describe, expect, it } from "vitest";
import { InMemoryJobQueue, SqsJobQueue } from "../../src/index.js";
import { type ScenarioResult, runInMemoryScenario } from "./inMemoryScenario.js";
import { type LeakVerdict, runLeakCampaign, stressIterations } from "./leakHarness.js";
import { iterationSeed } from "./rng.js";
import { type SqsScenarioResult, createScenarioQueue, runSqsScenario } from "./sqsScenario.js";

/**
 * Long-run leak lens for @pickle/queue.
 *
 * Every campaign invokes the unit N times in ONE process with --expose-gc
 * (see vitest.config.ts), samples heap + active handles every 50 iterations
 * and asserts: heap slope <= 5% / 100 iterations, handles/listeners back to
 * baseline, p95 invocation time in the last window <= 2x the first window.
 *
 * Scale: STRESS_ITER (default 500 for the in-memory queue, 40 for ElasticMQ
 * so the suite stays fast; the full campaign is `STRESS_ITER=500`). Every
 * iteration is replayable from `iterationSeed(STRESS_SEED, i)`; the JSON
 * table (seed -> outcome) is written to STRESS_OUT_DIR
 * (default <repo>/artifacts/stress/pkg-queue/).
 */

const CAMPAIGN_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const OUT_DIR =
  process.env.STRESS_OUT_DIR ??
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../../artifacts/stress/pkg-queue");
const SAMPLE_EVERY = 50;
const ENDPOINT = process.env.SQS_ENDPOINT_TEST;
const REGION = process.env.AWS_REGION ?? "us-east-1";

interface Row {
  iteration: number;
  seed: number;
  ok: boolean;
  ms: number;
  error?: string;
  result?: ScenarioResult | SqsScenarioResult;
}

interface CampaignReport {
  campaign: string;
  campaignSeed: number;
  iterations: number;
  executed: number;
  failed: number;
  verdict: LeakVerdict | null;
  rows: Row[];
}

const reports: CampaignReport[] = [];

function writeReports(): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = resolve(OUT_DIR, `long-run-leak-${stamp}.json`);
  writeFileSync(
    path,
    JSON.stringify(
      {
        unit: "pkg-queue",
        lens: "long-run-leak",
        node: process.version,
        campaignSeed: CAMPAIGN_SEED,
        sqsEndpoint: ENDPOINT ?? null,
        campaigns: reports,
      },
      null,
      2,
    ),
  );
  console.log(`[stress] wrote ${path}`);
}

afterAll(writeReports);

async function campaign(
  name: string,
  iterations: number,
  warmup: number,
  trackedResources: readonly string[],
  resourceTolerance: number,
  body: (iteration: number, seed: number) => Promise<ScenarioResult | SqsScenarioResult>,
): Promise<CampaignReport> {
  const rows: Row[] = [];
  const report: CampaignReport = {
    campaign: name,
    campaignSeed: CAMPAIGN_SEED,
    iterations,
    executed: 0,
    failed: 0,
    verdict: null,
    rows,
  };
  reports.push(report);
  const verdict = await runLeakCampaign(
    {
      iterations,
      // every 50 at full scale; small STRESS_ITER campaigns still get >= 5 samples
      sampleEvery: Math.min(SAMPLE_EVERY, Math.max(1, Math.floor(iterations / 5))),
      warmup,
      trackedResources,
      resourceTolerance,
    },
    async (iteration) => {
      const seed = iterationSeed(CAMPAIGN_SEED, iteration);
      if (iteration < 0) {
        // warmup (JIT / lazy SDK init): not part of the recorded table
        await body(iteration, seed).catch(() => undefined);
        return;
      }
      const t0 = performance.now();
      try {
        const result = await body(iteration, seed);
        rows.push({ iteration, seed, ok: true, ms: performance.now() - t0, result });
      } catch (err) {
        rows.push({ iteration, seed, ok: false, ms: performance.now() - t0, error: String(err) });
        report.failed++;
      } finally {
        report.executed++;
      }
    },
  );
  report.verdict = verdict;
  return report;
}

function expectHeld(report: CampaignReport): void {
  const failures = report.rows.filter((r) => !r.ok);
  expect(
    failures,
    `failing seeds: ${failures.map((f) => `${f.seed}: ${f.error}`).join("\n")}`,
  ).toEqual([]);
  const v = report.verdict;
  if (!v) throw new Error("no verdict");
  const tracked = Object.fromEntries(
    Object.entries(v.resourceDelta).filter(([kind]) => trackedKinds.has(kind)),
  );
  expect(v.heapSlopePer100, "heap slope per 100 iterations").toBeLessThanOrEqual(
    v.thresholds.heapSlopePer100,
  );
  expect(v.resourcesHeld, `tracked active resources vs baseline ${JSON.stringify(tracked)}`).toBe(
    true,
  );
  expect(v.processListenerDelta, "process listeners vs baseline").toBeLessThanOrEqual(0);
  expect(v.timeDrift.ratio, "median invocation time last/first window").toBeLessThanOrEqual(
    v.thresholds.timeDriftRatio,
  );
  expect(v.held).toBe(true);
}

const trackedKinds = new Set(["TCPSocketWrap", "Timeout", "Immediate"]);

describe("InMemoryJobQueue long-run leak", () => {
  const iterations = stressIterations(500);

  it(`fresh instance per iteration x${iterations} (mount/unmount)`, async () => {
    const report = await campaign("inmemory.churn", iterations, 5, ["Timeout", "Immediate"], 0, (i) =>
      runInMemoryScenario(new InMemoryJobQueue(), CAMPAIGN_SEED, i, { staleAcks: false }),
    );
    expectHeld(report);
  });

  it(`one long-lived instance x${iterations}`, async () => {
    const queue = new InMemoryJobQueue();
    const report = await campaign(
      "inmemory.longLived",
      iterations,
      5,
      ["Timeout", "Immediate"],
      0,
      (i) => runInMemoryScenario(queue, CAMPAIGN_SEED, i, { staleAcks: false }),
    );
    expectHeld(report);
    expect(await queue.size()).toBe(0);
    expect(await queue.oldestJobAgeMs()).toBeNull();
  });

  it("same seed replays to the same operation digest", async () => {
    for (let i = 0; i < 25; i++) {
      const a = await runInMemoryScenario(new InMemoryJobQueue(), CAMPAIGN_SEED, i, {
        staleAcks: false,
      });
      const b = await runInMemoryScenario(new InMemoryJobQueue(), CAMPAIGN_SEED, i, {
        staleAcks: false,
      });
      expect(b).toEqual(a);
    }
  });

  it(`late ack after visibility expiry keeps gauges + redelivery intact x${iterations}`, async () => {
    // At-least-once contract: a worker acking a delivery that already expired
    // (and was redelivered) must not lose the redelivered copy or its age.
    const report = await campaign(
      "inmemory.staleAck",
      iterations,
      5,
      ["Timeout", "Immediate"],
      0,
      (i) => runInMemoryScenario(new InMemoryJobQueue(), CAMPAIGN_SEED, i, { staleAcks: true }),
    );
    expectHeld(report);
  });

  it("minimized: stale ack from an expired delivery drops the redelivered job", async () => {
    const queue = new InMemoryJobQueue();
    await queue.enqueue("media.process", { id: "a" });
    const [first] = await queue.receive(1);
    if (!first) throw new Error("no delivery");
    queue.expireInFlight(); // visibility timeout: job goes back to the queue
    const [second] = await queue.receive(1);
    if (!second) throw new Error("no redelivery");
    expect(second.job.attempt).toBe(2);
    await first.ack(); // the slow worker finally acks its OLD receipt
    // The redelivered copy is still owned by worker #2, so if worker #2 dies
    // the job must come back on the next expiry.
    queue.expireInFlight();
    expect(await queue.size()).toBe(1);
    expect(await queue.oldestJobAgeMs()).not.toBeNull();
  });
});

describe.skipIf(!ENDPOINT)("SqsJobQueue long-run leak against ElasticMQ", () => {
  const iterations = stressIterations(40);
  const endpoint = ENDPOINT ?? "";
  process.env["AWS_ACCESS_KEY_ID"] ??= "x";
  process.env["AWS_SECRET_ACCESS_KEY"] ??= "x";
  const raw = new SQSClient({ endpoint, region: REGION });
  afterAll(() => raw.destroy());
  // ~4% of iterations long-poll an empty queue for 1s; budget generously.
  const campaignTimeoutMs = 20_000 + iterations * 250;
  // the SDK initialises lazily on first use of each code path (long-poll, malformed
  // body, ...); warm those up so they do not read as heap growth
  const SQS_WARMUP = 25;

  it(
    `one long-lived client x${iterations}`,
    async () => {
      const queueUrl = await createScenarioQueue(
        { endpoint, region: REGION, raw },
        `stress-long-${Date.now()}`,
      );
      const ctx = { endpoint, region: REGION, raw, queueUrl };
      const queue = new SqsJobQueue({ queueUrl, region: REGION, endpoint });
      const report = await campaign(
        "sqs.longLived",
        iterations,
        SQS_WARMUP,
        ["TCPSocketWrap", "Timeout", "Immediate"],
        1, // one keep-alive socket may be (re)opened lazily by the SDK
        (i) => runSqsScenario(queue, ctx, CAMPAIGN_SEED, i),
      );
      expectHeld(report);
    },
    campaignTimeoutMs,
  );

  it("reference semantics: a stale receipt does not delete the redelivered message", async () => {
    // Same script as the in-memory "minimized" case, run against the broker.
    const created = await raw.send(
      new CreateQueueCommand({
        QueueName: `stress-stale-${Date.now()}`,
        Attributes: { VisibilityTimeout: "1" },
      }),
    );
    const queueUrl = created.QueueUrl;
    if (!queueUrl) throw new Error("no QueueUrl");
    const queue = new SqsJobQueue({ queueUrl, region: REGION, endpoint });
    await queue.enqueue("media.process", { id: "a" });
    const [first] = await queue.receive(1);
    if (!first) throw new Error("no delivery");
    await new Promise((r) => setTimeout(r, 1500)); // visibility timeout expires
    const [second] = await queue.receive(1);
    if (!second) throw new Error("no redelivery");
    expect(second.job.attempt).toBe(2);
    // Stale receipt from the expired delivery: ElasticMQ rejects it; AWS SQS
    // documents that the request succeeds but the message is NOT deleted.
    // Either way the live delivery is untouched.
    await expect(first.ack()).rejects.toMatchObject({ name: "ReceiptHandleIsInvalid" });
    await new Promise((r) => setTimeout(r, 1500)); // worker #2 "dies"; its visibility expires
    const third = await queue.receive(1);
    expect(third.map((d) => d.job.attempt)).toEqual([3]);
    for (const d of third) await d.ack();
  }, 15_000);

  it(
    `fresh client per iteration x${iterations} (mount/unmount)`,
    async () => {
      const queueUrl = await createScenarioQueue(
        { endpoint, region: REGION, raw },
        `stress-churn-${Date.now()}`,
      );
      const ctx = { endpoint, region: REGION, raw, queueUrl };
      const report = await campaign(
        "sqs.churn",
        iterations,
        SQS_WARMUP,
        ["TCPSocketWrap", "Timeout", "Immediate"],
        1,
        (i) =>
          runSqsScenario(
            new SqsJobQueue({ queueUrl, region: REGION, endpoint }),
            ctx,
            CAMPAIGN_SEED,
            i,
          ),
      );
      expectHeld(report);
    },
    campaignTimeoutMs,
  );
});
