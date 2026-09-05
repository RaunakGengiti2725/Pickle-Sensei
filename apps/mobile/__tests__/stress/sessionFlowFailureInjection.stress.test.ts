/**
 * STRESS — mod-session-flow / failure-injection lens, part 1:
 * LiveSessionFlow (src/flow/session.ts) + sessionScoreProgression
 * (src/flow/sessionProgress.ts) under injected dependency faults.
 *
 * Dependencies of the flow that are faulted here, per seed:
 *   - SessionEventClipSource.extract  → reject / throw / never / slow /
 *                                        malformed / unavailable
 *   - SessionEventAnalysisProvider    → availability() throw / malformed;
 *                                        analyzeEvent() reject / throw /
 *                                        never / slow / malformed outcomes /
 *                                        malformed AnalysisRecord
 *   - onUpdate UI subscriber          → throws (always / randomly)
 *   - motion samples (replay path)    → NaN / ±Infinity / negative /
 *                                        out-of-order timestamps
 *   - lifecycle                       → end() mid-rally / twice / push after end
 *   - clock (Date.prototype.toISOString) and the stability recorder are
 *     faulted in dedicated deterministic cases below.
 *
 * Replayable: every iteration derives everything from its seed.
 *   STRESS_ITER=<n>  campaign size (default small so the suite stays fast)
 *   STRESS_SEED=<n>  replay exactly one seed
 * The seed → outcome table is written to
 *   artifacts/stress/mod-session-flow/<campaign>.json (gitignored).
 *
 * Verdicts: HELD (all invariants held), HELD_KNOWN (only documented
 * findings observed — each has a `test.failing` repro below that turns red
 * the day it is fixed), BROKEN (an undocumented invariant violation; the
 * campaign test fails and prints the seeds).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { SessionStrokeEvent } from '@pickle/analysis-pipeline';
import type { CapturedClip } from '../../src/camera/capture';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  LiveSessionFlow,
  formatSessionClock,
  getCompletedSession,
  timelineSegments,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventAnalysisRequest,
  type SessionEventClipExtraction,
  type SessionEventClipSource,
  type SessionEventView,
  type SessionMotionSample,
} from '../../src/flow/session';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

// ─── Seeded harness ─────────────────────────────────────────────────────────

/** mulberry32 — small, fast, deterministic. */
function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends string>(
  rng: () => number,
  weights: Record<T, number>,
): T {
  const entries = Object.entries(weights) as Array<[T, number]>;
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [key, weight] of entries) {
    roll -= weight;
    if (roll < 0) return key;
  }
  return entries[entries.length - 1]![0];
}

const DEFAULT_ITERATIONS = 32;

function campaignSeeds(base: number): number[] {
  const one = process.env.STRESS_SEED;
  if (one !== undefined && one !== '') return [Number(one)];
  const raw = process.env.STRESS_ITER;
  const iterations =
    raw !== undefined && raw !== '' ? Number(raw) : DEFAULT_ITERATIONS;
  return Array.from({ length: iterations }, (_, i) => base + i);
}

const ARTIFACT_DIR = path.resolve(
  __dirname,
  '../../../../artifacts/stress/mod-session-flow',
);

function writeCampaignTable(name: string, table: object): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const file = path.join(ARTIFACT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(table, null, 2));
  return file;
}

async function flushMicrotasks(rounds = 64): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Advance fake time in steps so every timer AND the promise chains it
 * unblocks get to run (60 s is the lens's "no infinite spinner" horizon). */
async function advanceFakeTime(totalMs: number, stepMs = 1_000): Promise<void> {
  for (let elapsed = 0; elapsed < totalMs; elapsed += stepMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    await flushMicrotasks(8);
  }
  await flushMicrotasks();
}

// ─── Known findings (documented; each has a test.failing repro) ────────────

/**
 * Observation codes the campaign may record without failing. Anything NOT
 * in this list is a BROKEN verdict. Each is reproduced deterministically
 * in the `known findings` block at the bottom of this file.
 */
const KNOWN_FINDINGS = {
  /** session.ts:522-577 — no deadline on a dispatch: a clip source or
   * provider that never settles leaves the event 'processing' forever
   * (still 'processing' after 60 s of fake time). Also reached when the
   * provider resolves `null` (session.ts:545 returns without marking). */
  F1_STUCK_PROCESSING_NO_DEADLINE: 'F1_STUCK_PROCESSING_NO_DEADLINE',
  /** session.ts:464 — `Math.max(lastSampleMs, NaN)` is NaN and Math.max
   * with Infinity is Infinity: one non-finite tMs (which the ENGINE drops,
   * sessionEngine.ts:838) permanently poisons durationMs → clock renders
   * 'NaN:NaN' / 'Infinity:NaN' and the timeline strip collapses to []. */
  F2_DURATION_AXIS_POISONED: 'F2_DURATION_AXIS_POISONED',
  /** session.ts:515 — provider.availability() is called unguarded: a throw
   * escapes pushSample()/end() AFTER the engine closed the event, so the
   * event stays 'pending' with NO reason, notify() is skipped, and end()
   * never registers the completed session (session.ts:478-483). */
  F3_AVAILABILITY_THROW_ESCAPES: 'F3_AVAILABILITY_THROW_ESCAPES',
  /** session.ts:554-559 — an outcome with an unknown `status` is treated as
   * pending with `pendingReason: undefined` → view shows 'pending' with a
   * null reason (silent). */
  F4_PENDING_WITHOUT_REASON: 'F4_PENDING_WITHOUT_REASON',
  /** session.ts:240 — a 'ready' record lacking `strokeResolution` makes
   * eventTechniqueFamily throw inside buildEventViews, so EVERY later
   * snapshot()/end() throws: one malformed record bricks the flow. */
  F5_SNAPSHOT_POISONED_BY_RECORD: 'F5_SNAPSHOT_POISONED_BY_RECORD',
  /** session.ts:609-624 — notify() writes the completed-session registry
   * BEFORE invoking onUpdate, so when the subscriber throws on the last
   * notification the registry (what LiveSummary reads) reports one fewer
   * onUpdateFailures than the live snapshot: the last failure is silent to
   * the summary. */
  F6_REGISTRY_LAGS_LAST_SUBSCRIBER_FAILURE:
    'F6_REGISTRY_LAGS_LAST_SUBSCRIBER_FAILURE',
  /** session.ts:562-577 — the dispatch `.catch` handler calls notify()
   * unguarded. Once F5 has poisoned snapshot(), ANY later dispatch failure
   * (clip source / provider rejection for a different event) rethrows out
   * of the catch handler: the fire-and-forget dispatch promise rejects with
   * nobody attached (unhandled rejection) and settled() rejects. */
  F7_DISPATCH_CATCH_RETHROWS_UNHANDLED: 'F7_DISPATCH_CATCH_RETHROWS_UNHANDLED',
} as const;
const KNOWN_FINDING_SET = new Set<string>(Object.values(KNOWN_FINDINGS));

// ─── Fault menus ────────────────────────────────────────────────────────────

type ExtractFault =
  | 'ok'
  | 'ok_null_clip'
  | 'unavailable'
  | 'reject_error'
  | 'reject_string'
  | 'reject_undefined'
  | 'throw_sync'
  | 'never'
  | 'slow'
  | 'malformed_null'
  | 'malformed_no_clip'
  | 'malformed_status';

type AnalyzeFault =
  | 'ready_scored'
  | 'ready_low_confidence'
  | 'ready_resultless'
  | 'abstained'
  | 'pending'
  | 'reject_error'
  | 'reject_string'
  | 'reject_undefined'
  | 'throw_sync'
  | 'never'
  | 'slow_ready'
  | 'malformed_ready_null_analysis'
  | 'malformed_status'
  | 'malformed_null'
  | 'malformed_undefined'
  | 'malformed_record_no_resolution';

type AvailabilityFault =
  'available' | 'unavailable' | 'throw' | 'malformed_null' | 'malformed_empty';

type OnUpdateFault = 'ok' | 'throw_every' | 'throw_some';

type SampleFault =
  | 'none'
  | 'nan_t'
  | 'inf_t'
  | 'neg_inf_t'
  | 'neg_t'
  | 'nan_v'
  | 'neg_v'
  | 'huge_t'
  | 'out_of_order';

type LifecycleFault =
  'end_at_finish' | 'end_mid' | 'end_twice' | 'push_after_end' | 'never_end';

const EXTRACT_WEIGHTS: Record<ExtractFault, number> = {
  ok: 30,
  ok_null_clip: 6,
  unavailable: 8,
  reject_error: 8,
  reject_string: 4,
  reject_undefined: 3,
  throw_sync: 6,
  never: 6,
  slow: 8,
  malformed_null: 5,
  malformed_no_clip: 5,
  malformed_status: 5,
};

const ANALYZE_WEIGHTS: Record<AnalyzeFault, number> = {
  ready_scored: 26,
  ready_low_confidence: 6,
  ready_resultless: 4,
  abstained: 8,
  pending: 6,
  reject_error: 8,
  reject_string: 3,
  reject_undefined: 3,
  throw_sync: 6,
  never: 6,
  slow_ready: 8,
  malformed_ready_null_analysis: 4,
  malformed_status: 4,
  malformed_null: 3,
  malformed_undefined: 3,
  malformed_record_no_resolution: 3,
};

const AVAILABILITY_WEIGHTS: Record<AvailabilityFault, number> = {
  available: 74,
  unavailable: 10,
  throw: 6,
  malformed_null: 4,
  malformed_empty: 6,
};

const ON_UPDATE_WEIGHTS: Record<OnUpdateFault, number> = {
  ok: 55,
  throw_every: 15,
  throw_some: 30,
};

const SAMPLE_WEIGHTS: Record<SampleFault, number> = {
  none: 55,
  nan_t: 6,
  inf_t: 5,
  neg_inf_t: 3,
  neg_t: 6,
  nan_v: 6,
  neg_v: 6,
  huge_t: 6,
  out_of_order: 7,
};

const LIFECYCLE_WEIGHTS: Record<LifecycleFault, number> = {
  end_at_finish: 45,
  end_mid: 20,
  end_twice: 12,
  push_after_end: 13,
  never_end: 10,
};

const BENIGN_EXTRACT = new Set<ExtractFault>(['ok', 'ok_null_clip']);
const BENIGN_ANALYZE = new Set<AnalyzeFault>([
  'ready_scored',
  'ready_low_confidence',
  'ready_resultless',
  'abstained',
  'pending',
]);
const STUCK_EXTRACT = new Set<ExtractFault>(['never']);
const STUCK_ANALYZE = new Set<AnalyzeFault>(['never', 'malformed_null']);
/** Extract faults after which the provider IS still reached. */
const EXTRACT_REACHES_PROVIDER = new Set<ExtractFault>([
  'ok',
  'ok_null_clip',
  'slow',
  'malformed_no_clip',
  'malformed_status',
]);

// ─── Fault-injecting doubles ────────────────────────────────────────────────

function fakeRecord(
  kind: 'scored' | 'low_confidence' | 'resultless',
  score: number,
  id: string,
): AnalysisRecord {
  return {
    id,
    strokeResolution: { kind: 'unresolved', reason: 'stress double' },
    result:
      kind === 'scored'
        ? { resultKind: 'scored', overallScore: score }
        : kind === 'low_confidence'
          ? { resultKind: 'low_confidence', overallScore: null }
          : null,
  } as unknown as AnalysisRecord;
}

function fakeClip(eventId: string): CapturedClip {
  return { uri: `file:///stress/${eventId}.mov` } as unknown as CapturedClip;
}

const never = <T>(): Promise<T> => new Promise<T>(() => {});
const after = <T>(ms: number, value: T): Promise<T> =>
  new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

interface EventPlan {
  extract: ExtractFault;
  analyze: AnalyzeFault;
  slowMs: number;
  score: number;
  record: AnalysisRecord | null;
}

interface IterationPlan {
  seed: number;
  availability: AvailabilityFault;
  onUpdate: OnUpdateFault;
  sample: SampleFault;
  sampleIndex: number;
  lifecycle: LifecycleFault;
  endIndex: number;
  events: EventPlan[];
}

function planIteration(seed: number): IterationPlan {
  const rng = makeRng(seed);
  const events: EventPlan[] = [];
  for (let i = 0; i < 8; i += 1) {
    const extract = pickWeighted(rng, EXTRACT_WEIGHTS);
    const analyze = pickWeighted(rng, ANALYZE_WEIGHTS);
    const score = Math.round(rng() * 100) / 10;
    const slowMs = 500 + Math.floor(rng() * 29_000);
    const id = `stress-record-${seed}-E${i + 1}`;
    const record =
      analyze === 'ready_scored' || analyze === 'slow_ready'
        ? fakeRecord('scored', score, id)
        : analyze === 'ready_low_confidence'
          ? fakeRecord('low_confidence', score, id)
          : analyze === 'ready_resultless'
            ? fakeRecord('resultless', score, id)
            : analyze === 'malformed_record_no_resolution'
              ? ({
                  id,
                  result: { resultKind: 'scored', overallScore: score },
                } as unknown as AnalysisRecord)
              : null;
    events.push({ extract, analyze, slowMs, score, record });
  }
  return {
    seed,
    availability: pickWeighted(rng, AVAILABILITY_WEIGHTS),
    onUpdate: pickWeighted(rng, ON_UPDATE_WEIGHTS),
    sample: pickWeighted(rng, SAMPLE_WEIGHTS),
    sampleIndex: Math.floor(rng() * samples.length),
    lifecycle: pickWeighted(rng, LIFECYCLE_WEIGHTS),
    endIndex: 10 + Math.floor(rng() * (samples.length - 20)),
    events,
  };
}

const samples: SessionMotionSample[] = fixture.wristSamples;

function eventOrdinal(eventId: string): number {
  return Number(eventId.replace(/^E/, '')) - 1;
}

function planFor(plan: IterationPlan, eventId: string): EventPlan {
  const ordinal = eventOrdinal(eventId);
  return plan.events[Math.min(ordinal, plan.events.length - 1)]!;
}

function faultyClipSource(plan: IterationPlan): SessionEventClipSource {
  return {
    sourceId: `stress-clip-source:${plan.seed}`,
    extract(event: SessionStrokeEvent): Promise<SessionEventClipExtraction> {
      const ep = planFor(plan, event.eventId);
      const extracted: SessionEventClipExtraction = {
        status: 'extracted',
        clip: fakeClip(event.eventId),
        poseSequenceSlice: null,
      };
      switch (ep.extract) {
        case 'ok':
          return Promise.resolve(extracted);
        case 'ok_null_clip':
          return Promise.resolve({
            status: 'extracted',
            clip: null,
            poseSequenceSlice: null,
          } as unknown as SessionEventClipExtraction);
        case 'unavailable':
          return Promise.resolve({
            status: 'unavailable',
            pendingReason: `STRESS_EXTRACT_UNAVAILABLE:${event.eventId}`,
          });
        case 'reject_error':
          return Promise.reject(
            new Error(`stress extract reject ${event.eventId}`),
          );
        case 'reject_string':
          return Promise.reject(`stress extract string ${event.eventId}`);
        case 'reject_undefined':
          return Promise.reject(undefined);
        case 'throw_sync':
          throw new Error(`stress extract sync throw ${event.eventId}`);
        case 'never':
          return never();
        case 'slow':
          return after(ep.slowMs, extracted);
        case 'malformed_null':
          return Promise.resolve(null as unknown as SessionEventClipExtraction);
        case 'malformed_no_clip':
          return Promise.resolve({
            status: 'extracted',
          } as unknown as SessionEventClipExtraction);
        case 'malformed_status':
          return Promise.resolve({
            status: 'weird',
          } as unknown as SessionEventClipExtraction);
      }
    },
  };
}

function faultyProvider(
  plan: IterationPlan,
  calls: { analyze: string[]; availability: number },
): SessionEventAnalysisProvider {
  return {
    providerId: `stress-provider:${plan.seed}`,
    availability() {
      calls.availability += 1;
      switch (plan.availability) {
        case 'available':
          return { status: 'available' };
        case 'unavailable':
          return { status: 'unavailable', pendingReason: 'STRESS_UNAVAILABLE' };
        case 'throw':
          throw new Error('stress availability throw');
        case 'malformed_null':
          return null as unknown as { status: 'available' };
        case 'malformed_empty':
          return {} as unknown as { status: 'available' };
      }
    },
    analyzeEvent(
      request: SessionEventAnalysisRequest,
    ): Promise<SessionEventAnalysisOutcome> {
      calls.analyze.push(request.eventId);
      const ep = planFor(plan, request.eventId);
      switch (ep.analyze) {
        case 'ready_scored':
        case 'ready_low_confidence':
        case 'ready_resultless':
        case 'malformed_record_no_resolution':
          return Promise.resolve({ status: 'ready', analysis: ep.record! });
        case 'abstained':
          return Promise.resolve({
            status: 'abstained',
            abstainReason: `STRESS_ABSTAIN:${request.eventId}`,
          });
        case 'pending':
          return Promise.resolve({
            status: 'pending',
            pendingReason: `STRESS_PENDING:${request.eventId}`,
          });
        case 'reject_error':
          return Promise.reject(
            new Error(`stress analyze reject ${request.eventId}`),
          );
        case 'reject_string':
          return Promise.reject(`stress analyze string ${request.eventId}`);
        case 'reject_undefined':
          return Promise.reject(undefined);
        case 'throw_sync':
          throw new Error(`stress analyze sync throw ${request.eventId}`);
        case 'never':
          return never();
        case 'slow_ready':
          return after(ep.slowMs, {
            status: 'ready',
            analysis: ep.record!,
          } as SessionEventAnalysisOutcome);
        case 'malformed_ready_null_analysis':
          return Promise.resolve({
            status: 'ready',
            analysis: null,
          } as unknown as SessionEventAnalysisOutcome);
        case 'malformed_status':
          return Promise.resolve({
            status: 'weird',
          } as unknown as SessionEventAnalysisOutcome);
        case 'malformed_null':
          return Promise.resolve(
            null as unknown as SessionEventAnalysisOutcome,
          );
        case 'malformed_undefined':
          return Promise.resolve(
            undefined as unknown as SessionEventAnalysisOutcome,
          );
      }
    },
  };
}

function corruptSample(
  sample: SessionMotionSample,
  fault: SampleFault,
): SessionMotionSample {
  switch (fault) {
    case 'none':
    case 'out_of_order':
      return sample;
    case 'nan_t':
      return { tMs: Number.NaN, v: sample.v };
    case 'inf_t':
      return { tMs: Number.POSITIVE_INFINITY, v: sample.v };
    case 'neg_inf_t':
      return { tMs: Number.NEGATIVE_INFINITY, v: sample.v };
    case 'neg_t':
      return { tMs: -sample.tMs, v: sample.v };
    case 'nan_v':
      return { tMs: sample.tMs, v: Number.NaN };
    case 'neg_v':
      return { tMs: sample.tMs, v: -1 };
    case 'huge_t':
      return { tMs: 1e12, v: sample.v };
  }
}

// ─── Invariant checking ─────────────────────────────────────────────────────

const LEGAL_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  pending: new Set(['pending', 'processing', 'abstained']),
  processing: new Set(['processing', 'pending', 'ready', 'abstained']),
  ready: new Set(['ready']),
  abstained: new Set(['abstained']),
};

interface EventOutcomeRow {
  extract: ExtractFault;
  analyze: AnalyzeFault;
  providerReached: boolean;
  finalState: string | null;
  reason: string | null;
}

interface SeedRow {
  seed: number;
  verdict: 'HELD' | 'HELD_KNOWN' | 'BROKEN';
  plan: {
    availability: AvailabilityFault;
    onUpdate: OnUpdateFault;
    sample: SampleFault;
    lifecycle: LifecycleFault;
  };
  injectedFaults: number;
  events: Record<string, EventOutcomeRow>;
  observations: string[];
  violations: string[];
  pushThrew: number;
  onUpdateThrows: number;
  snapshotsSeen: number;
  durationMs: number | string;
}

/** Path + values of the first structural difference between two JSON-ish
 * values (null when deep-equal). Keeps violation messages actionable. */
function firstDivergence(a: unknown, b: unknown, at: string): string | null {
  if (Object.is(a, b)) return null;
  if (
    typeof a !== 'object' ||
    typeof b !== 'object' ||
    a === null ||
    b === null
  ) {
    return `${at}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`;
  }
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const found = firstDivergence(
      (a as Record<string, unknown>)[key],
      (b as Record<string, unknown>)[key],
      `${at}.${key}`,
    );
    if (found !== null) return found;
  }
  return null;
}

function num(value: number): number | string {
  return Number.isFinite(value) ? value : String(value);
}

async function runIteration(seed: number): Promise<SeedRow> {
  const plan = planIteration(seed);
  const onUpdateRng = makeRng(seed ^ 0x9e3779b9);
  const sessionId = `stress-session-${seed}`;
  const calls = { analyze: [] as string[], availability: 0 };
  const trail: LiveSessionSnapshot[] = [];
  const observations = new Set<string>();
  const violations: string[] = [];
  let injectedFaults = 0;
  let onUpdateThrows = 0;
  let lastOnUpdateThrew = false;
  let pushThrew = 0;
  const dispatchRejections: string[] = [];
  // Dispatches are fire-and-forget inside the flow; attach a handler right
  // after every synchronous entry point so a rejection is observed by the
  // harness (and classified) instead of surfacing as an unhandled rejection.
  const watchDispatches = (): void => {
    void flow.settled().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!dispatchRejections.includes(message))
        dispatchRejections.push(message);
    });
  };

  const flow = new LiveSessionFlow({
    sessionId,
    source: 'live',
    provider: faultyProvider(plan, calls),
    clipSource: faultyClipSource(plan),
    startedAtIso: '2026-09-04T00:00:00.000Z',
    onUpdate: snapshot => {
      trail.push(snapshot);
      lastOnUpdateThrew = false;
      if (
        plan.onUpdate === 'throw_every' ||
        (plan.onUpdate === 'throw_some' && onUpdateRng() < 0.3)
      ) {
        onUpdateThrows += 1;
        injectedFaults += 1;
        lastOnUpdateThrew = true;
        throw new Error('stress onUpdate subscriber throw');
      }
    },
  });

  if (plan.availability !== 'available') injectedFaults += 1;
  if (plan.sample !== 'none') injectedFaults += 1;
  if (plan.lifecycle === 'push_after_end') injectedFaults += 1;

  // ── Drive the recorded rally with the injected faults ──────────────────
  const feed = [...samples];
  if (plan.sample === 'out_of_order') {
    const i = Math.min(plan.sampleIndex, feed.length - 2);
    [feed[i], feed[i + 1]] = [feed[i + 1]!, feed[i]!];
  } else if (plan.sample !== 'none') {
    feed[plan.sampleIndex] = corruptSample(
      feed[plan.sampleIndex]!,
      plan.sample,
    );
  }

  const push = (sample: SessionMotionSample): void => {
    try {
      flow.pushSample(sample);
      watchDispatches();
    } catch (error) {
      watchDispatches();
      pushThrew += 1;
      const message = error instanceof Error ? error.message : String(error);
      if (
        plan.availability === 'throw' ||
        plan.availability === 'malformed_null'
      ) {
        observations.add(KNOWN_FINDINGS.F3_AVAILABILITY_THROW_ESCAPES);
      } else {
        violations.push(`pushSample threw unexpectedly: ${message}`);
      }
    }
  };

  let ended = false;
  const endFlow = (): void => {
    try {
      flow.end();
      ended = true;
      watchDispatches();
    } catch (error) {
      ended = true;
      watchDispatches();
      const message = error instanceof Error ? error.message : String(error);
      if (
        plan.availability === 'throw' ||
        plan.availability === 'malformed_null'
      ) {
        observations.add(KNOWN_FINDINGS.F3_AVAILABILITY_THROW_ESCAPES);
      } else if (
        plan.events.some(e => e.analyze === 'malformed_record_no_resolution')
      ) {
        observations.add(KNOWN_FINDINGS.F5_SNAPSHOT_POISONED_BY_RECORD);
      } else {
        violations.push(`end() threw unexpectedly: ${message}`);
      }
    }
  };

  for (let i = 0; i < feed.length; i += 1) {
    if (plan.lifecycle === 'end_mid' && i === plan.endIndex) {
      endFlow();
      break;
    }
    push(feed[i]!);
  }
  if (plan.lifecycle !== 'never_end' && plan.lifecycle !== 'end_mid') endFlow();
  if (plan.lifecycle === 'end_twice') {
    const analyzeCallsBefore = calls.analyze.length;
    const availabilityBefore = calls.availability;
    endFlow();
    if (
      calls.analyze.length !== analyzeCallsBefore ||
      calls.availability !== availabilityBefore
    ) {
      violations.push('second end() redispatched analysis');
    }
  }
  if (plan.lifecycle === 'push_after_end') {
    let threw: string | null = null;
    try {
      flow.pushSample({ tMs: 99_999, v: 0.5 });
    } catch (error) {
      threw = error instanceof Error ? error.message : String(error);
    }
    if (threw === null || !/already ended/.test(threw)) {
      violations.push(`push after end did not refuse honestly: ${threw}`);
    }
  }

  // ── Let every settle-able dispatch settle; 60 s for the spinner check ──
  await flushMicrotasks();
  await advanceFakeTime(60_000);

  // ── Inspect ─────────────────────────────────────────────────────────────
  for (const message of dispatchRejections) {
    if (
      /reading 'kind'/.test(message) &&
      plan.events.some(e => e.analyze === 'malformed_record_no_resolution')
    ) {
      observations.add(KNOWN_FINDINGS.F5_SNAPSHOT_POISONED_BY_RECORD);
      observations.add(KNOWN_FINDINGS.F7_DISPATCH_CATCH_RETHROWS_UNHANDLED);
    } else {
      violations.push(`dispatch promise rejected: ${message}`);
    }
  }
  let final: LiveSessionSnapshot | null = null;
  try {
    final = flow.snapshot();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (plan.events.some(e => e.analyze === 'malformed_record_no_resolution')) {
      observations.add(KNOWN_FINDINGS.F5_SNAPSHOT_POISONED_BY_RECORD);
    } else {
      violations.push(`snapshot() threw: ${message}`);
    }
  }

  // Trail invariants: append-only events, frozen bounds, legal transitions,
  // terminal stability, monotone counters, progression monotonicity.
  let prevScoredPlusNoRead = 0;
  let prevBest = Number.NEGATIVE_INFINITY;
  const seenPoints = new Map<string, number>();
  for (let i = 1; i < trail.length; i += 1) {
    const prev = trail[i - 1]!;
    const next = trail[i]!;
    if (next.strokeCount < prev.strokeCount)
      violations.push('strokeCount decreased');
    if (next.onUpdateFailures < prev.onUpdateFailures)
      violations.push('onUpdateFailures decreased');
    if (next.droppedLateSamples < prev.droppedLateSamples)
      violations.push('droppedLateSamples decreased');
    if (
      Number.isFinite(prev.durationMs) &&
      Number.isFinite(next.durationMs) &&
      next.durationMs < prev.durationMs
    ) {
      violations.push('durationMs decreased');
    }
    for (let k = 0; k < prev.events.length; k += 1) {
      const a = prev.events[k]!;
      const b = next.events[k];
      if (!b || b.eventId !== a.eventId) {
        violations.push(`event list not append-only at ${a.eventId}`);
        continue;
      }
      if (
        b.startMs !== a.startMs ||
        b.endMs !== a.endMs ||
        b.peakMs !== a.peakMs
      ) {
        violations.push(`bounds rewritten for ${a.eventId}`);
      }
      if (!LEGAL_TRANSITIONS[a.state]?.has(b.state)) {
        violations.push(
          `illegal transition ${a.eventId}: ${a.state} → ${b.state}`,
        );
      }
      if (a.state === 'ready' && b.analysis !== a.analysis) {
        violations.push(`ready record replaced for ${a.eventId}`);
      }
      if (a.state === 'abstained' && b.abstainReason !== a.abstainReason) {
        violations.push(`abstain reason rewritten for ${a.eventId}`);
      }
    }
    const progression = sessionScoreProgression(next.events);
    const resolved = progression.scoredCount + progression.noReadCount;
    if (resolved < prevScoredPlusNoRead) {
      violations.push('progression: resolved count decreased');
    }
    prevScoredPlusNoRead = resolved;
    if (progression.best && progression.best.score < prevBest) {
      violations.push('progression: best score decreased');
    }
    if (progression.best) prevBest = progression.best.score;
    for (const point of progression.points) {
      const seen = seenPoints.get(point.eventId);
      if (seen !== undefined && seen !== point.score) {
        violations.push(
          `progression: plotted score changed for ${point.eventId}`,
        );
      }
      seenPoints.set(point.eventId, point.score);
    }
  }

  const events: Record<string, EventOutcomeRow> = {};
  if (final) {
    if (!Number.isFinite(final.durationMs)) {
      if (
        plan.sample === 'nan_t' ||
        plan.sample === 'inf_t' ||
        plan.sample === 'neg_inf_t'
      ) {
        observations.add(KNOWN_FINDINGS.F2_DURATION_AXIS_POISONED);
      } else {
        violations.push(`durationMs not finite: ${final.durationMs}`);
      }
    }
    if (final.onUpdateFailures !== onUpdateThrows) {
      violations.push(
        `onUpdateFailures ${final.onUpdateFailures} !== injected ${onUpdateThrows}`,
      );
    }
    for (const view of final.events) {
      const ep = planFor(plan, view.eventId);
      const providerReached = calls.analyze.includes(view.eventId);
      events[view.eventId] = {
        extract: ep.extract,
        analyze: ep.analyze,
        providerReached,
        finalState: view.state,
        reason: view.pendingReason ?? view.abstainReason,
      };
      checkEventOutcome(plan, view, providerReached, observations, violations);
      if (!BENIGN_EXTRACT.has(ep.extract) && ep.extract !== 'unavailable')
        injectedFaults += 1;
      if (providerReached && !BENIGN_ANALYZE.has(ep.analyze))
        injectedFaults += 1;
    }
    // Registry (what LiveSummary reads) must mirror the live snapshot.
    if (ended) {
      const registered = getCompletedSession(sessionId);
      if (registered === null) {
        if (
          plan.availability === 'throw' ||
          plan.availability === 'malformed_null'
        ) {
          observations.add(KNOWN_FINDINGS.F3_AVAILABILITY_THROW_ESCAPES);
        } else {
          violations.push('completed-session registry empty after end()');
        }
      } else {
        const divergence = firstDivergence(registered, final, 'registry');
        if (divergence !== null) {
          const onlyLaggingFailureCount =
            lastOnUpdateThrew &&
            registered.onUpdateFailures === final.onUpdateFailures - 1 &&
            firstDivergence(
              { ...registered, onUpdateFailures: 0 },
              { ...final, onUpdateFailures: 0 },
              'registry',
            ) === null;
          if (onlyLaggingFailureCount) {
            observations.add(
              KNOWN_FINDINGS.F6_REGISTRY_LAGS_LAST_SUBSCRIBER_FAILURE,
            );
          } else {
            violations.push(
              `completed-session registry diverged from snapshot at ${divergence}`,
            );
          }
        }
      }
    } else if (getCompletedSession(sessionId) !== null) {
      violations.push('registry populated before end()');
    }
    // Final progression buckets must account for every event.
    const progression = sessionScoreProgression(final.events);
    const bucketed =
      progression.scoredCount +
      progression.noReadCount +
      progression.pendingCount;
    if (bucketed !== final.events.length) {
      violations.push(
        `progression buckets ${bucketed} !== events ${final.events.length}`,
      );
    }
    for (let i = 1; i < progression.points.length; i += 1) {
      if (
        progression.points[i]!.eventIndex <=
        progression.points[i - 1]!.eventIndex
      )
        violations.push('progression points not index-ordered');
    }
  }

  for (const code of observations) {
    if (!KNOWN_FINDING_SET.has(code))
      violations.push(`unknown observation ${code}`);
  }

  return {
    seed,
    verdict:
      violations.length > 0
        ? 'BROKEN'
        : observations.size > 0
          ? 'HELD_KNOWN'
          : 'HELD',
    plan: {
      availability: plan.availability,
      onUpdate: plan.onUpdate,
      sample: plan.sample,
      lifecycle: plan.lifecycle,
    },
    injectedFaults,
    events,
    observations: [...observations].sort(),
    violations,
    pushThrew,
    onUpdateThrows,
    snapshotsSeen: trail.length,
    durationMs: final ? num(final.durationMs) : 'snapshot-threw',
  };
}

/** Ground-truth check of one event's final view against the faults it got. */
function checkEventOutcome(
  plan: IterationPlan,
  view: SessionEventView,
  providerReached: boolean,
  observations: Set<string>,
  violations: string[],
): void {
  const ep = planFor(plan, view.eventId);
  const id = view.eventId;
  const dispatchFailed =
    view.state === 'abstained' &&
    view.abstainReason !== null &&
    view.abstainReason.startsWith('ANALYSIS_DISPATCH_FAILED:');

  // Fake success is the cardinal sin: 'ready' only with the injected record.
  if (view.state === 'ready') {
    const readyInjected =
      providerReached &&
      (ep.analyze === 'ready_scored' ||
        ep.analyze === 'ready_low_confidence' ||
        ep.analyze === 'ready_resultless' ||
        ep.analyze === 'slow_ready' ||
        ep.analyze === 'malformed_record_no_resolution');
    if (!readyInjected)
      violations.push(`${id}: FAKE SUCCESS (ready without a ready outcome)`);
    else if (view.analysis !== ep.record)
      violations.push(`${id}: ready record substituted`);
    return;
  }

  if (plan.availability === 'unavailable') {
    if (view.state !== 'pending' || view.pendingReason !== 'STRESS_UNAVAILABLE')
      violations.push(`${id}: unavailable provider must leave honest pending`);
    return;
  }
  if (plan.availability === 'throw' || plan.availability === 'malformed_null') {
    if (view.state === 'pending' && view.pendingReason === null) {
      observations.add(KNOWN_FINDINGS.F3_AVAILABILITY_THROW_ESCAPES);
      return;
    }
    violations.push(
      `${id}: unexpected state ${view.state} under throwing availability`,
    );
    return;
  }

  if (view.state === 'processing') {
    const stuckInjected =
      STUCK_EXTRACT.has(ep.extract) ||
      (providerReached && STUCK_ANALYZE.has(ep.analyze));
    if (stuckInjected)
      observations.add(KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE);
    else
      violations.push(
        `${id}: still processing after 60s without a never-fault`,
      );
    return;
  }

  if (!EXTRACT_REACHES_PROVIDER.has(ep.extract)) {
    if (providerReached)
      violations.push(`${id}: provider reached despite extract fault`);
    switch (ep.extract) {
      case 'unavailable':
        if (
          view.state !== 'pending' ||
          view.pendingReason !== `STRESS_EXTRACT_UNAVAILABLE:${id}`
        )
          violations.push(
            `${id}: extract unavailable → expected honest pending`,
          );
        return;
      case 'reject_error':
      case 'reject_string':
      case 'reject_undefined':
      case 'throw_sync':
        if (
          view.state !== 'pending' ||
          !view.pendingReason?.startsWith('SESSION_CLIP_EXTRACTION_FAILED:')
        )
          violations.push(
            `${id}: extract failure → expected pending SESSION_CLIP_EXTRACTION_FAILED`,
          );
        return;
      case 'malformed_null':
        if (!dispatchFailed)
          violations.push(
            `${id}: null extraction → expected honest dispatch failure`,
          );
        return;
      case 'never':
        violations.push(
          `${id}: never-resolving extract left state ${view.state}`,
        );
        return;
      default:
        return;
    }
  }

  if (!providerReached) {
    violations.push(
      `${id}: provider not reached although extraction succeeded`,
    );
    return;
  }
  switch (ep.analyze) {
    case 'ready_scored':
    case 'ready_low_confidence':
    case 'ready_resultless':
    case 'slow_ready':
    case 'malformed_record_no_resolution':
      violations.push(`${id}: ready outcome lost (state ${view.state})`);
      return;
    case 'abstained':
      if (
        view.state !== 'abstained' ||
        view.abstainReason !== `STRESS_ABSTAIN:${id}`
      )
        violations.push(`${id}: abstained outcome not recorded`);
      return;
    case 'pending':
      if (
        view.state !== 'pending' ||
        view.pendingReason !== `STRESS_PENDING:${id}`
      )
        violations.push(`${id}: pending outcome not recorded`);
      return;
    case 'reject_error':
    case 'reject_string':
    case 'reject_undefined':
    case 'throw_sync':
    case 'malformed_ready_null_analysis':
    case 'malformed_undefined':
      if (!dispatchFailed)
        violations.push(
          `${id}: provider failure → expected honest ANALYSIS_DISPATCH_FAILED`,
        );
      return;
    case 'malformed_status':
      if (view.state === 'pending' && view.pendingReason === null) {
        observations.add(KNOWN_FINDINGS.F4_PENDING_WITHOUT_REASON);
      } else {
        violations.push(`${id}: unknown outcome status → state ${view.state}`);
      }
      return;
    case 'never':
    case 'malformed_null':
      violations.push(`${id}: never/null outcome left state ${view.state}`);
      return;
  }
}

// ─── Campaign ───────────────────────────────────────────────────────────────

describe('stress/failure-injection: LiveSessionFlow', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('survives the seeded fault campaign (no fake success, no corruption, honest states)', async () => {
    const seeds = campaignSeeds(1_000);
    const rows: SeedRow[] = [];
    for (const seed of seeds) rows.push(await runIteration(seed));

    const totalFaults = rows.reduce((sum, row) => sum + row.injectedFaults, 0);
    const broken = rows.filter(row => row.verdict === 'BROKEN');
    const observationCounts: Record<string, number> = {};
    for (const row of rows)
      for (const code of row.observations)
        observationCounts[code] = (observationCounts[code] ?? 0) + 1;

    const file = writeCampaignTable('sessionFlow.failureInjection', {
      campaign: 'sessionFlow.failureInjection',
      unit: 'apps/mobile/src/flow/session.ts + sessionProgress.ts',
      iterations: rows.length,
      injectedFaults: totalFaults,
      verdicts: {
        HELD: rows.filter(r => r.verdict === 'HELD').length,
        HELD_KNOWN: rows.filter(r => r.verdict === 'HELD_KNOWN').length,
        BROKEN: broken.length,
      },
      observationCounts,
      knownFindings: KNOWN_FINDINGS,
      rows,
    });

    expect(rows.length).toBe(seeds.length);
    if (seeds.length >= DEFAULT_ITERATIONS)
      expect(totalFaults).toBeGreaterThanOrEqual(60);
    expect({
      brokenSeeds: broken.map(row => ({
        seed: row.seed,
        violations: row.violations,
      })),
      table: file,
    }).toEqual({ brokenSeeds: [], table: file });
  });

  it('is replayable: the same seed produces the same outcome row', async () => {
    const seed = Number(process.env.STRESS_SEED ?? 1_007);
    const a = await runIteration(seed);
    const b = await runIteration(seed);
    expect(b).toEqual(a);
  });
});

// ─── Deterministic dependency faults outside the seeded menu ───────────────

describe('stress/failure-injection: clock + telemetry dependencies', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('a broken clock (Date#toISOString throws) never reaches the flow', async () => {
    jest.spyOn(Date.prototype, 'toISOString').mockImplementation(() => {
      throw new RangeError('stress: invalid time value');
    });
    const flow = new LiveSessionFlow({
      sessionId: 'stress-clock',
      source: 'replay',
      provider: {
        providerId: 'reject',
        availability: () => ({ status: 'available' }),
        analyzeEvent: () => Promise.reject(new Error('boom')),
      },
      onUpdate: () => {
        throw new Error('subscriber boom');
      },
    });
    for (const sample of samples) flow.pushSample(sample);
    const snapshot = flow.end();
    await flow.settled();
    const final = flow.snapshot();
    expect(final.events.length).toBe(snapshot.events.length);
    expect(final.events.length).toBeGreaterThan(0);
    for (const event of final.events) {
      expect(event.state).toBe('abstained');
      expect(event.abstainReason).toMatch(/^ANALYSIS_DISPATCH_FAILED: boom$/);
    }
    expect(final.onUpdateFailures).toBeGreaterThan(0);
  });

  it('documents that the flow relies on stabilitySlo.record never throwing', async () => {
    // stabilityTelemetry.ts:66-75 wraps the append in try/catch, so the REAL
    // recorder cannot throw. This pins what happens if that guarantee broke:
    // notify()'s catch path and the dispatch catch path would both rethrow.
    const spy = jest.spyOn(stabilitySlo, 'record').mockImplementation(() => {
      throw new Error('stress telemetry throw');
    });
    const flow = new LiveSessionFlow({
      sessionId: 'stress-telemetry',
      source: 'replay',
      provider: {
        providerId: 'reject',
        availability: () => ({ status: 'available' }),
        analyzeEvent: () => Promise.reject(new Error('boom')),
      },
    });
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
    await expect(flow.settled()).rejects.toThrow('stress telemetry throw');
    // The rejected dispatch never reached markEvent: the event is stranded.
    expect(flow.snapshot().events.every(e => e.state === 'processing')).toBe(
      true,
    );
    expect(spy).toHaveBeenCalled();
  });
});

// ─── Known findings — deterministic repros (test.failing: red once fixed) ──

describe('stress/failure-injection: known findings (expected invariants)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function driveRally(flow: LiveSessionFlow): void {
    for (const sample of samples) flow.pushSample(sample);
    flow.end();
  }

  test.failing(
    `${KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE}: a never-resolving provider must not leave an event 'processing' after 60s`,
    async () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f1',
        source: 'live',
        provider: {
          providerId: 'never',
          availability: () => ({ status: 'available' }),
          analyzeEvent: () => never(),
        },
      });
      driveRally(flow);
      await advanceFakeTime(60_000);
      const states = flow.snapshot().events.map(e => e.state);
      expect(states.length).toBeGreaterThan(0);
      expect(states).not.toContain('processing');
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F1_STUCK_PROCESSING_NO_DEADLINE}: a provider resolving null must not leave an event 'processing'`,
    async () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f1b',
        source: 'live',
        provider: {
          providerId: 'null',
          availability: () => ({ status: 'available' }),
          analyzeEvent: () =>
            Promise.resolve(null as unknown as SessionEventAnalysisOutcome),
        },
      });
      driveRally(flow);
      await flow.settled();
      await advanceFakeTime(60_000);
      expect(flow.snapshot().events.map(e => e.state)).not.toContain(
        'processing',
      );
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F2_DURATION_AXIS_POISONED}: a NaN sample timestamp must not poison durationMs/clock/timeline`,
    () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f2',
        source: 'live',
        provider: {
          providerId: 'p',
          availability: () => ({ status: 'unavailable', pendingReason: 'x' }),
          analyzeEvent: () => never(),
        },
      });
      for (const sample of samples.slice(0, 20)) flow.pushSample(sample);
      flow.pushSample({ tMs: Number.NaN, v: 0.3 });
      for (const sample of samples.slice(20)) flow.pushSample(sample);
      const snapshot = flow.end();
      expect(Number.isFinite(snapshot.durationMs)).toBe(true);
      expect(formatSessionClock(snapshot.durationMs)).toMatch(/^\d+:\d\d$/);
      expect(
        timelineSegments(snapshot.events, snapshot.durationMs).length,
      ).toBe(snapshot.events.length);
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F3_AVAILABILITY_THROW_ESCAPES}: a throwing availability() must not escape end() and leave the registry empty`,
    () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f3',
        source: 'live',
        provider: {
          providerId: 'throws',
          availability: () => {
            throw new Error('bridge probe failed');
          },
          analyzeEvent: () => never(),
        },
      });
      for (const sample of samples) {
        try {
          flow.pushSample(sample);
        } catch {
          // the native feed swallows push failures the same way
        }
      }
      expect(() => flow.end()).not.toThrow();
      expect(getCompletedSession('stress-f3')).not.toBeNull();
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F4_PENDING_WITHOUT_REASON}: an outcome with an unknown status must not become a reasonless pending`,
    async () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f4',
        source: 'live',
        provider: {
          providerId: 'weird',
          availability: () => ({ status: 'available' }),
          analyzeEvent: () =>
            Promise.resolve({
              status: 'weird',
            } as unknown as SessionEventAnalysisOutcome),
        },
      });
      driveRally(flow);
      await flow.settled();
      for (const event of flow.snapshot().events) {
        expect(event.state === 'pending' && event.pendingReason === null).toBe(
          false,
        );
      }
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F6_REGISTRY_LAGS_LAST_SUBSCRIBER_FAILURE}: the completed-session registry must report the same onUpdateFailures as the live snapshot`,
    () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f6',
        source: 'live',
        provider: {
          providerId: 'p',
          availability: () => ({ status: 'unavailable', pendingReason: 'x' }),
          analyzeEvent: () => never(),
        },
        onUpdate: () => {
          throw new Error('subscriber boom');
        },
      });
      for (const sample of samples) flow.pushSample(sample);
      flow.end();
      const live = flow.snapshot();
      expect(live.onUpdateFailures).toBe(samples.length + 1);
      expect(getCompletedSession('stress-f6')?.onUpdateFailures).toBe(
        live.onUpdateFailures,
      );
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F5_SNAPSHOT_POISONED_BY_RECORD}: one ready record without strokeResolution must not brick snapshot()`,
    async () => {
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f5',
        source: 'live',
        provider: {
          providerId: 'malformed-record',
          availability: () => ({ status: 'available' }),
          analyzeEvent: () =>
            Promise.resolve({
              status: 'ready',
              analysis: {
                id: 'no-resolution',
                result: null,
              } as unknown as AnalysisRecord,
            }),
        },
      });
      for (const sample of samples) flow.pushSample(sample);
      await flow.settled();
      expect(() => flow.snapshot()).not.toThrow();
      expect(() => flow.end()).not.toThrow();
    },
  );

  test.failing(
    `${KNOWN_FINDINGS.F7_DISPATCH_CATCH_RETHROWS_UNHANDLED}: a dispatch failure after a poisoned record must not reject the fire-and-forget dispatch chain`,
    async () => {
      let call = 0;
      const flow = new LiveSessionFlow({
        sessionId: 'stress-f7',
        source: 'live',
        provider: {
          providerId: 'poison-then-fail',
          availability: () => ({ status: 'available' }),
          analyzeEvent: () => {
            call += 1;
            // First event: malformed record (F5). Every later event: a plain
            // provider rejection, which the .catch handler should absorb.
            if (call === 1) {
              return Promise.resolve({
                status: 'ready',
                analysis: {
                  id: 'no-resolution',
                  result: null,
                } as unknown as AnalysisRecord,
              });
            }
            return Promise.reject(new Error('provider down'));
          },
        },
      });
      for (const sample of samples) flow.pushSample(sample);
      flow.end();
      const outcome = await flow.settled().then(
        () => 'resolved',
        (error: unknown) =>
          `rejected: ${error instanceof Error ? error.message : String(error)}`,
      );
      expect(call).toBeGreaterThanOrEqual(2);
      expect(outcome).toBe('resolved');
    },
  );
});
