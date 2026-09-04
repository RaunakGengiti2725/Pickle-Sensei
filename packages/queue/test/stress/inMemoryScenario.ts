import { InMemoryJobQueue, type JobEnvelope } from "../../src/index.js";
import { assertFiniteNumber } from "./leakHarness.js";
import { fnv1a, iterationSeed, mulberry32, randomPayload } from "./rng.js";

/**
 * One seeded exercise of an InMemoryJobQueue checked against a reference
 * model. Every step is derived from the iteration seed so a failing iteration
 * replays with `runInMemoryScenario(queue, campaignSeed, iteration)`.
 *
 * Invariants checked on every step:
 *  - receive(max) returns <= max jobs, each unknown to the in-flight model
 *  - payload round-trips deep-equal; attempt == model redeliveries + 1
 *  - size() == model queued count; oldestJobAgeMs() is null iff nothing is
 *    unacked, otherwise a finite number >= 0 (never NaN / Infinity)
 *  - an acked job never comes back, even after expireInFlight()
 *  - a LATE ack (the worker finishes after the visibility timeout requeued the
 *    job — the classic at-least-once race) must not desynchronise the gauges:
 *    while size() > 0 the oldest-age metric must stay non-null
 *  - at the end the queue is empty and reports null age (nothing retained)
 *
 * `staleAcks: false` disables the late-ack action so the remaining
 * invariants can be measured independently of that behaviour.
 */

const KINDS = ["media.process", "media.purge", "share.render", "analysis.deep", "k"] as const;

interface ModelJob {
  kind: string;
  payload: unknown;
  attempts: number;
  state: "queued" | "inflight" | "acked";
}

export interface ScenarioOptions {
  staleAcks: boolean;
}

export interface ScenarioResult {
  seed: number;
  enqueued: number;
  receives: number;
  redeliveries: number;
  staleAcksCalled: number;
  /** Digest of the observed (id, kind, attempt) sequence — equal for equal seeds. */
  digest: string;
}

export async function runInMemoryScenario(
  queue: InMemoryJobQueue,
  campaignSeed: number,
  iteration: number,
  options: ScenarioOptions = { staleAcks: true },
): Promise<ScenarioResult> {
  const seed = iterationSeed(campaignSeed, iteration);
  const rng = mulberry32(seed);
  const model = new Map<string, ModelJob>();
  const acks = new Map<string, () => Promise<void>>();
  const staleAcks: Array<{ id: string; ack: () => Promise<void> }> = [];
  const observed: string[] = [];
  let receives = 0;
  let redeliveries = 0;
  let staleAcksCalled = 0;

  const enqueueN = rng.int(1, 50);
  for (let i = 0; i < enqueueN; i++) {
    const kind = rng.pick(KINDS);
    const payload = randomPayload(rng);
    const id = await queue.enqueue(kind, payload);
    if (model.has(id)) throw new Error(`seed ${seed}: duplicate job id ${id}`);
    model.set(id, { kind, payload, attempts: 0, state: "queued" });
  }
  await checkGauges(queue, model, seed);

  let steps = 0;
  const maxSteps = 400;
  while (unacked(model) > 0) {
    if (++steps > maxSteps)
      throw new Error(`seed ${seed}: scenario did not converge in ${maxSteps} steps`);
    const action = rng.next();
    if (action < 0.55) {
      const max = rng.int(1, 12);
      const batch = await queue.receive(max);
      receives++;
      if (batch.length > max)
        throw new Error(`seed ${seed}: receive(${max}) returned ${batch.length}`);
      const queuedBefore = [...model.values()].filter((j) => j.state === "queued").length;
      if (batch.length !== Math.min(max, queuedBefore)) {
        throw new Error(
          `seed ${seed}: receive(${max}) returned ${batch.length}, model had ${queuedBefore} queued`,
        );
      }
      for (const { job, ack } of batch) {
        const m = model.get(job.id);
        if (!m) throw new Error(`seed ${seed}: received unknown job ${job.id}`);
        if (m.state !== "queued")
          throw new Error(`seed ${seed}: job ${job.id} received while ${m.state}`);
        m.attempts++;
        if (m.attempts > 1) redeliveries++;
        checkEnvelope(job, m, seed);
        m.state = "inflight";
        acks.set(job.id, ack);
        observed.push(`${job.id}:${job.kind}:${job.attempt}`);
      }
    } else if (action < 0.85) {
      const inflight = [...model.entries()].filter(([, j]) => j.state === "inflight");
      if (options.staleAcks && staleAcks.length > 0 && rng.chance(0.5)) {
        // Late ack from a previous delivery whose visibility already expired.
        const stale = staleAcks.splice(rng.int(0, staleAcks.length - 1), 1)[0];
        if (!stale) throw new Error(`seed ${seed}: stale ack vanished`);
        await stale.ack();
        staleAcksCalled++;
        observed.push(`stale-ack:${stale.id}`);
        // Reference semantics (SQS at-least-once): the stale receipt refers to a
        // delivery that no longer exists, so the redelivered copy keeps its
        // state; the gauge/receive checks below detect any divergence.
      } else if (inflight.length > 0) {
        const [id, m] = rng.pick(inflight);
        const ack = acks.get(id);
        if (!ack) throw new Error(`seed ${seed}: missing ack for ${id}`);
        await ack();
        if (rng.chance(0.1)) await ack(); // double-ack must be idempotent
        m.state = "acked";
        acks.delete(id);
        observed.push(`ack:${id}`);
      }
    } else {
      queue.expireInFlight();
      for (const m of model.values()) if (m.state === "inflight") m.state = "queued";
      if (options.staleAcks) {
        for (const [id, ack] of acks) if (rng.chance(0.5)) staleAcks.push({ id, ack });
      }
      acks.clear();
      observed.push("expire");
    }
    await checkGauges(queue, model, seed);
  }

  if ((await queue.size()) !== 0) throw new Error(`seed ${seed}: queue not empty at end`);
  if ((await queue.oldestJobAgeMs()) !== null)
    throw new Error(`seed ${seed}: age retained after all acks`);
  queue.expireInFlight();
  if ((await queue.size()) !== 0)
    throw new Error(`seed ${seed}: acked job resurrected by expireInFlight`);

  return {
    seed,
    enqueued: enqueueN,
    receives,
    redeliveries,
    staleAcksCalled,
    digest: fnv1a(observed.join("|")),
  };
}

function unacked(model: Map<string, ModelJob>): number {
  let n = 0;
  for (const j of model.values()) if (j.state !== "acked") n++;
  return n;
}

function checkEnvelope(job: JobEnvelope, m: ModelJob, seed: number): void {
  if (job.kind !== m.kind) throw new Error(`seed ${seed}: kind ${job.kind} != ${m.kind}`);
  if (JSON.stringify(job.payload) !== JSON.stringify(m.payload)) {
    throw new Error(`seed ${seed}: payload mismatch for ${job.id}`);
  }
  assertFiniteNumber(job.attempt, `seed ${seed}: attempt`);
  if (job.attempt !== m.attempts)
    throw new Error(`seed ${seed}: attempt ${job.attempt} != ${m.attempts}`);
}

async function checkGauges(
  queue: InMemoryJobQueue,
  model: Map<string, ModelJob>,
  seed: number,
): Promise<void> {
  const size = await queue.size();
  assertFiniteNumber(size, `seed ${seed}: size`);
  const queued = [...model.values()].filter((j) => j.state === "queued").length;
  if (size !== queued) throw new Error(`seed ${seed}: size ${size} != model queued ${queued}`);
  const age = await queue.oldestJobAgeMs();
  if (unacked(model) === 0) {
    if (age !== null) throw new Error(`seed ${seed}: age ${String(age)} with nothing unacked`);
  } else {
    assertFiniteNumber(age, `seed ${seed}: oldestJobAgeMs`);
    if (age < 0) throw new Error(`seed ${seed}: negative age ${age}`);
  }
}
