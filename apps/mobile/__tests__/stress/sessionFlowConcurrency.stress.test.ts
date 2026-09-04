/**
 * STRESS HARNESS — unit `mod-session-flow`, lens `concurrency`.
 *
 * Drives `LiveSessionFlow` + `connectNativeSessionMotionFeed` +
 * `createNativeSessionAnalysisProvider` + `sessionScoreProgression` through a
 * SEEDED scheduler that interleaves:
 *   - native bridge emissions (valid / duplicate / out-of-order / stale /
 *     malformed / wrong-captureId / non-motion / post-end)
 *   - duplicate feed connections on the same flow (double subscribe)
 *   - two actors (flows) on the same native emitter with distinct captureIds
 *   - `end()` at random points, double `end()`, `end()` re-entered from
 *     `onUpdate` (call-during-call), `pushSample` re-entered from `onUpdate`
 *   - explicit `disconnect()` mid-stream
 *   - async native fault fabric: clip extraction / pending-capture save /
 *     analysis resolving out of order, rejecting, returning contract-violating
 *     payloads, or hanging forever (cancel-during-call analogue)
 *   - provider availability flipping to "signed out" mid-session
 *     (logout-during-request analogue)
 *   - throwing `onUpdate` subscribers
 *
 * Every iteration is replayable from its seed. A seed→outcome JSON table is
 * written to `$STRESS_OUT` when set.
 *
 *   STRESS_ITER   number of seeds (default 60 so the suite stays fast)
 *   STRESS_SEED   base seed (default 20260904)
 *   STRESS_ONLY   replay exactly one seed (e.g. STRESS_ONLY=20260917)
 *   STRESS_OUT    path for the seed→outcome JSON table
 *   STRESS_STRICT=1  also fail on the KNOWN registry-counter divergence
 *                 (`getCompletedSession().onUpdateFailures` lags the live
 *                 snapshot by one when the final `onUpdate` throws; see
 *                 `LiveSessionFlow.notify`). Recorded per seed regardless.
 *
 * Oracle: a REFERENCE `LiveSessionFlow` per actor is fed exactly the pushes the
 * feed contract says the real flow must receive (computed by a model of
 * `connectNativeSessionMotionFeed`), so event structure must be identical; the
 * fault fabric records, per event, the terminal/pending state the provider
 * contract promises. Synthetic wrist-speed noise is used ONLY to stress the
 * state machine — it makes no claim about CV/analysis quality.
 */
import { writeFileSync } from 'fs';
import type { ShotTypeSlug } from '@pickle/shared-types';
import type { AnalysisRecord } from '@pickle/swing-domain';
import type { LocalDb } from '../../src/data/db';
import {
  LiveSessionFlow,
  NATIVE_CLIP_EXTRACTION_NOT_BUILT,
  SESSION_MOTION_SAMPLE_EVENT_TYPE,
  createPendingStubAnalysisProvider,
  getCompletedSession,
  type LiveSessionSnapshot,
  type SessionEventAnalysisOutcome,
  type SessionEventAnalysisProvider,
  type SessionEventClipSource,
  type SessionMotionSample,
} from '../../src/flow/session';
import {
  connectNativeSessionMotionFeed,
  createNativeSessionAnalysisProvider,
  createNativeSessionEventClipSource,
} from '../../src/flow/sessionNative';
import { sessionScoreProgression } from '../../src/flow/sessionProgress';
import { runCaptureAnalysis } from '../../src/analysis/runCaptureAnalysis';
import { savePendingCapture } from '../../src/data/repository';
import fixture from '../fixtures/sessionReplay.afn-sasebo-rally1.json';

jest.mock('react-native', () => {
  const listeners: Array<(event: unknown) => void> = [];
  const bridge = {
    capture: jest.fn(),
    importVideo: jest.fn(),
    cancel: jest.fn(),
    addListener: jest.fn(),
    removeListeners: jest.fn(),
    startSessionCapture: jest.fn(),
    stopSessionCapture: jest.fn(),
    extractSessionEventClip: jest.fn(),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: unknown) => void) {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      }
    },
    __simulatedBridge: bridge,
    __simulatedListeners: listeners,
  };
});
jest.mock('../../src/analysis/runCaptureAnalysis', () => ({
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../../src/data/repository', () => ({
  savePendingCapture: jest.fn(),
}));

const { __simulatedBridge: mockBridge, __simulatedListeners: listeners } =
  jest.requireMock('react-native') as {
    __simulatedBridge: { extractSessionEventClip: jest.Mock };
    __simulatedListeners: Array<(event: unknown) => void>;
  };

const runCaptureAnalysisMock = runCaptureAnalysis as jest.Mock;
const savePendingCaptureMock = savePendingCapture as jest.Mock;

// ─── seeded RNG (mulberry32) ────────────────────────────────────────────────
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
const chance = (rng: () => number, p: number) => rng() < p;
const pick = <T>(rng: () => number, xs: readonly T[]): T => {
  const x = xs[Math.floor(rng() * xs.length)];
  if (x === undefined) throw new Error('pick on empty list');
  return x;
};
const int = (rng: () => number, lo: number, hi: number) =>
  lo + Math.floor(rng() * (hi - lo + 1));

// ─── fault fabric ───────────────────────────────────────────────────────────
interface Deferred {
  id: string;
  kind: 'extract' | 'save' | 'analyze';
  settle: () => void;
  hang: boolean;
}

type ExtractFault =
  'ok' | 'reject' | 'invalid_payload' | 'wrong_mode' | 'no_pose' | 'hang';
type SaveFault = 'ok' | 'reject';
type AnalyzeFault =
  | 'scored'
  | 'low_confidence'
  | 'unavailable'
  | 'quality_blocked'
  | 'reject'
  | 'hang';

interface ExpectedOutcome {
  state: 'pending' | 'processing' | 'ready' | 'abstained';
  pendingReasonPrefix: string | null;
  abstainReasonPrefix: string | null;
  analysis: object | null | 'any';
}

const fixtureStream: SessionMotionSample[] = fixture.wristSamples;

/** Structurally valid automatic-capture payload as the native extractor
 * would return it (placeholder values for contract-shape stress only — no
 * measurement claims). The uri encodes the event bounds so the async save /
 * analyze mocks can correlate a call back to its event. */
function validClipPayload(
  actor: number,
  startMs: number,
  endMs: number,
): Record<string, unknown> {
  // Clip-relative trigger window: 2000ms pre-roll, the event's own span,
  // 1500ms post-roll (mirrors the shipped fixed rolls).
  const span = Math.max(1, Math.round(endMs - startMs));
  return {
    uri: `file:///private/var/mobile/session-clip-${actor}-${startMs}-${endMs}.mov`,
    durationMs: 2000 + span + 1500,
    fps: 59.94,
    width: 720,
    height: 1280,
    capturedAtIso: '2026-09-04T10:00:05.000Z',
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 2000,
      endMs: 2000 + span,
      peakMotionMs: 2000 + Math.round(span / 2),
      confidence: 0.8,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: {
      schemaVersion: 1,
      window: 'detected_motion',
      poseSource: 'apple_vision_body_pose',
      poseModelVersion: 'apple-vision-bodypose-1',
      triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
      motionUnit: 'normalized_image_units_per_second',
      analysisInputFrameCount: 7,
      poseFrameCount: 6,
      poseMissingFrameCount: 1,
      trackedDurationMs: Math.min(620, span),
      meanCanonicalJointVisibility: 0.88,
      meanJointCoverage: 0.94,
      minimumJointCoverage: 0.83,
      fullBodyVisibleFrameCount: 4,
      jointMotion: [
        {
          joint: 'left_wrist',
          sampleCount: 5,
          meanNormalizedPerSecond: 1.1,
          peakNormalizedPerSecond: 2.4,
        },
      ],
    },
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 2000,
    postRollMs: 1500,
    poseSequence: {
      schemaVersion: 1,
      format: 'pickle.pose-sequence.v1',
      uri: `file:///private/var/mobile/session-clip-${actor}-${startMs}-${endMs}.pose.json`,
      frameCount: 6,
      sha256: 'a'.repeat(64),
      coordinateSystem: 'normalized_image_top_left',
      poseModelVersion: 'apple-vision-bodypose-1',
    },
  };
}

const nativeDeps = {
  db: { execute: async () => ({ rows: [] }), close() {} } as unknown as LocalDb,
  apiConfig: { baseUrl: 'https://api.test', token: 'token-1' },
  appVersion: '0.1.0',
  handedness: 'right' as const,
};

/** Structurally complete AnalysisRecord double (shape from sessionFlow.test.ts;
 * values are placeholders — no measurement claims). */
function analysisRecordDouble(
  id: string,
  shotType: ShotTypeSlug,
  result: unknown,
): AnalysisRecord {
  return {
    schemaVersion: 1,
    id,
    captureId: `capture-${id}`,
    createdAtIso: '2026-01-01T00:00:00.000Z',
    engineVersion: 'stress-double',
    strokeTaxonomyVersion: 'stress-double',
    strokeResolution: { kind: 'declared', shotType },
    modalities: {
      pose: true,
      paddle: false,
      ball: false,
      court: false,
      camera: false,
    },
    modelRuns: [],
    provenance: {
      appVersion: 'stress-double',
      pipelineVersion: 'stress-double',
      providerVersions: [
        {
          providerId: 'stress-double',
          modelVersion: 'stress-double',
          runtime: 'deterministic',
          executionTarget: 'on_device',
          artifactHash: null,
        },
      ],
      scoreVersion: 'stress-double',
      taxonomyVersion: 'stress-double',
      drillMappingVersion: 'none',
      captureEnvelopeVersion: 'capture-envelope-not-measured',
      recordedAtIso: '2026-01-01T00:00:00.000Z',
    },
    result: result as AnalysisRecord['result'],
    faults: [],
    uncertainty: {
      analysisConfidence: 0,
      presentation: 'abstain',
      perCheckpoint: {},
      limitingFactors: ['STRESS_DOUBLE'],
    },
    evidence: [],
    shadow: [],
  };
}

// ─── scenario plan ──────────────────────────────────────────────────────────
type Emission =
  | { kind: 'sample'; tMs: number; v: number; captureId: string | undefined }
  | { kind: 'malformed'; payload: unknown }
  | { kind: 'foreign' } // a non-motion camera event
  | { kind: 'end'; actor: number }
  | { kind: 'disconnect'; actor: number; conn: number }
  | { kind: 'connect'; actor: number };

type ProviderMode =
  | 'native'
  | 'native_no_clip_source'
  | 'replay'
  | 'custom_ready_without_record'
  | 'custom_sync_throw'
  | 'custom_logout_midway';

interface Plan {
  seed: number;
  actors: number;
  providerMode: ProviderMode;
  logoutAfterDispatches: number;
  reentrantEndAtStrokeCount: number | null;
  reentrantPushAtDurationMs: number | null;
  throwingSubscriber: boolean;
  allowHang: boolean;
  emissions: Emission[];
  settleBias: number;
}

function buildPlan(seed: number): Plan {
  const rng = makeRng(seed);
  const actors = chance(rng, 0.3) ? 2 : 1;
  const providerMode: ProviderMode = pick(rng, [
    'native',
    'native',
    'native',
    'native',
    'native',
    'native_no_clip_source',
    'replay',
    'custom_ready_without_record',
    'custom_sync_throw',
    'custom_logout_midway',
  ]);
  const allowHang = chance(rng, 0.35);

  // Base motion stream: recorded fixture (+ an offset second copy) with an
  // optional synthetic-noise segment (state-machine stress only).
  const base: SessionMotionSample[] = fixtureStream.map(s => ({ ...s }));
  if (chance(rng, 0.5)) {
    const offset = base[base.length - 1]!.tMs + int(rng, 300, 1500);
    for (const s of fixtureStream) base.push({ tMs: s.tMs + offset, v: s.v });
  }
  if (chance(rng, 0.3)) {
    let t = base[base.length - 1]!.tMs + int(rng, 100, 900);
    const n = int(rng, 20, 80);
    for (let i = 0; i < n; i += 1) {
      t += int(rng, 10, 90);
      base.push({ tMs: t, v: Math.round(rng() * 3 * 1000) / 1000 });
    }
  }

  const captureIds = Array.from(
    { length: actors },
    (_, i) => `cap-${seed}-${i}`,
  );
  const emissions: Emission[] = [];
  const total = base.length;
  const endIndex = new Map<number, number>();
  for (let a = 0; a < actors; a += 1) {
    if (chance(rng, 0.8))
      endIndex.set(a, int(rng, Math.floor(total * 0.5), total - 1));
  }
  const disconnectAt = chance(rng, 0.2) ? int(rng, 5, total - 1) : -1;
  const dupConnectAt = chance(rng, 0.2)
    ? int(rng, 1, Math.floor(total * 0.6))
    : -1;

  for (let i = 0; i < total; i += 1) {
    let sample = base[i]!;
    // clock skew: swap with neighbour (out-of-order arrival by one)
    if (chance(rng, 0.04) && i + 1 < total) {
      const next = base[i + 1]!;
      base[i + 1] = sample;
      sample = next;
    }
    // stale replay of an earlier sample (behind the engine frontier)
    if (chance(rng, 0.02) && i > 3) {
      const stale = base[int(rng, 0, i - 2)]!;
      emissions.push({
        kind: 'sample',
        tMs: stale.tMs,
        v: stale.v,
        captureId: chance(rng, 0.3) ? undefined : pick(rng, captureIds),
      });
    }
    const target: string | undefined =
      actors === 2 && chance(rng, 0.85)
        ? captureIds[int(rng, 0, actors - 1)]
        : chance(rng, 0.8)
          ? captureIds[0]
          : undefined;
    emissions.push({
      kind: 'sample',
      tMs: sample.tMs,
      v: sample.v,
      captureId: target,
    });
    if (chance(rng, 0.05)) {
      emissions.push({
        kind: 'sample',
        tMs: sample.tMs,
        v: sample.v,
        captureId: target,
      });
    }
    if (chance(rng, 0.04)) {
      const t = SESSION_MOTION_SAMPLE_EVENT_TYPE;
      emissions.push({
        kind: 'malformed',
        payload: pick(rng, [
          { type: t, tMs: Number.NaN, v: 1 },
          { type: t, tMs: -1, v: 1 },
          { type: t, tMs: sample.tMs, v: 'fast' },
          { type: t, tMs: Number.POSITIVE_INFINITY, v: 1 },
          { type: t, tMs: sample.tMs, v: -0.1 },
          { type: t, tMs: sample.tMs, v: 1, captureId: 42 },
          { type: t, tMs: sample.tMs, v: 1, emittedAtIso: 12 },
          { type: t, tMs: `${sample.tMs}`, v: 1 },
          { type: t },
        ]),
      });
    }
    if (chance(rng, 0.03)) {
      emissions.push({
        kind: 'sample',
        tMs: sample.tMs,
        v: sample.v,
        captureId: `stale-capture-${seed}`,
      });
    }
    if (chance(rng, 0.02)) emissions.push({ kind: 'foreign' });
    if (i === dupConnectAt) emissions.push({ kind: 'connect', actor: 0 });
    if (i === disconnectAt)
      emissions.push({ kind: 'disconnect', actor: 0, conn: 0 });
    for (const [a, idx] of endIndex) {
      if (idx === i) {
        emissions.push({ kind: 'end', actor: a });
        if (chance(rng, 0.4)) emissions.push({ kind: 'end', actor: a });
      }
    }
  }
  for (let a = 0; a < actors; a += 1) {
    if (!endIndex.has(a) && chance(rng, 0.7))
      emissions.push({ kind: 'end', actor: a });
  }

  return {
    seed,
    actors,
    providerMode,
    logoutAfterDispatches: int(rng, 1, 4),
    reentrantEndAtStrokeCount: chance(rng, 0.2) ? int(rng, 1, 4) : null,
    reentrantPushAtDurationMs: chance(rng, 0.15) ? int(rng, 500, 3000) : null,
    throwingSubscriber: chance(rng, 0.2),
    allowHang,
    emissions,
    settleBias: 0.2 + rng() * 0.6,
  };
}

// ─── invariant checks ───────────────────────────────────────────────────────
class Violations {
  readonly items: string[] = [];
  check(cond: boolean, message: string): void {
    if (!cond && this.items.length < 40) this.items.push(message);
  }
}

function checkSnapshotShape(
  v: Violations,
  s: LiveSessionSnapshot,
  tag: string,
) {
  v.check(
    s.strokeCount === s.events.length,
    `${tag}: strokeCount != events.length`,
  );
  const dist = s.distribution;
  v.check(
    dist.reduce((acc, d) => acc + d.count, 0) === s.events.length,
    `${tag}: distribution counts != events.length`,
  );
  let lastEnd = -1;
  s.events.forEach((e, i) => {
    v.check(
      e.index === i,
      `${tag}: event ${e.eventId} index ${e.index} != position ${i}`,
    );
    v.check(
      e.eventId === `E${i + 1}`,
      `${tag}: eventId ${e.eventId} != E${i + 1}`,
    );
    v.check(
      e.startMs <= e.peakMs && e.peakMs <= e.endMs,
      `${tag}: ${e.eventId} bounds start=${e.startMs} peak=${e.peakMs} end=${e.endMs}`,
    );
    v.check(
      e.peakMs > lastEnd,
      `${tag}: ${e.eventId} peak ${e.peakMs} not past previous frontier ${lastEnd}`,
    );
    lastEnd = e.endMs;
    v.check(
      e.endMs <= s.durationMs,
      `${tag}: ${e.eventId} endMs ${e.endMs} > durationMs ${s.durationMs}`,
    );
    if (e.state === 'ready')
      v.check(
        e.analysis !== null,
        `${tag}: ${e.eventId} ready without analysis`,
      );
    if (e.state !== 'ready')
      v.check(
        e.analysis === null,
        `${tag}: ${e.eventId} ${e.state} carries analysis`,
      );
    if (e.state === 'abstained')
      v.check(
        e.abstainReason !== null,
        `${tag}: ${e.eventId} abstained w/o reason`,
      );
    if (e.state === 'pending')
      v.check(
        e.pendingReason !== null,
        `${tag}: ${e.eventId} pending w/o reason (closeReason=${e.closeReason}, provider=${s.analysisProviderId})`,
      );
    if (e.state === 'processing')
      v.check(
        e.pendingReason === null,
        `${tag}: ${e.eventId} processing with pendingReason`,
      );
  });
}

function checkMonotonic(
  v: Violations,
  a: LiveSessionSnapshot,
  b: LiveSessionSnapshot,
  tag: string,
) {
  v.check(
    b.strokeCount >= a.strokeCount,
    `${tag}: strokeCount went ${a.strokeCount}→${b.strokeCount}`,
  );
  v.check(
    b.durationMs >= a.durationMs,
    `${tag}: durationMs went ${a.durationMs}→${b.durationMs}`,
  );
  v.check(
    b.droppedLateSamples >= a.droppedLateSamples,
    `${tag}: droppedLateSamples decreased`,
  );
  v.check(
    b.onUpdateFailures >= a.onUpdateFailures,
    `${tag}: onUpdateFailures decreased`,
  );
  v.check(
    !(a.phase === 'ended' && b.phase === 'running'),
    `${tag}: phase ended→running`,
  );
  v.check(a.sessionId === b.sessionId, `${tag}: sessionId changed`);
  a.events.forEach((ea, i) => {
    const eb = b.events[i];
    if (!eb) {
      v.check(false, `${tag}: event ${ea.eventId} vanished`);
      return;
    }
    v.check(
      eb.eventId === ea.eventId,
      `${tag}: event ${i} id ${ea.eventId}→${eb.eventId}`,
    );
    v.check(
      eb.startMs === ea.startMs &&
        eb.endMs === ea.endMs &&
        eb.peakMs === ea.peakMs &&
        eb.closeReason === ea.closeReason &&
        eb.closedAtMs === ea.closedAtMs,
      `${tag}: ${ea.eventId} proposal mutated after close`,
    );
    if (ea.state === 'ready' || ea.state === 'abstained') {
      v.check(
        eb.state === ea.state,
        `${tag}: ${ea.eventId} terminal ${ea.state}→${eb.state}`,
      );
      v.check(
        eb.analysis === ea.analysis,
        `${tag}: ${ea.eventId} analysis rewritten after terminal`,
      );
      v.check(
        eb.abstainReason === ea.abstainReason,
        `${tag}: ${ea.eventId} abstainReason rewritten`,
      );
    }
    if (ea.pendingReason !== null)
      v.check(
        eb.pendingReason !== null,
        `${tag}: ${ea.eventId} pendingReason cleared`,
      );
    if (ea.state === 'pending' && ea.pendingReason !== null) {
      v.check(
        eb.state === 'pending',
        `${tag}: ${ea.eventId} pending(with reason)→${eb.state}`,
      );
    }
  });
  const pa = sessionScoreProgression(a.events);
  const pb = sessionScoreProgression(b.events);
  v.check(
    pb.scoredCount >= pa.scoredCount,
    `${tag}: progression scoredCount decreased`,
  );
  v.check(
    pb.noReadCount >= pa.noReadCount,
    `${tag}: progression noReadCount decreased`,
  );
  pa.points.forEach(pt => {
    const q = pb.points.find(x => x.eventId === pt.eventId);
    v.check(
      q !== undefined && q.score === pt.score && q.eventIndex === pt.eventIndex,
      `${tag}: progression point ${pt.eventId} lost/changed`,
    );
  });
}

function checkProgression(v: Violations, s: LiveSessionSnapshot, tag: string) {
  const p = sessionScoreProgression(s.events);
  v.check(
    p.scoredCount + p.pendingCount + p.noReadCount <= s.events.length,
    `${tag}: progression buckets exceed events`,
  );
  v.check(
    p.points.length === p.scoredCount,
    `${tag}: points.length != scoredCount`,
  );
  for (let i = 1; i < p.points.length; i += 1) {
    v.check(
      p.points[i]!.eventIndex > p.points[i - 1]!.eventIndex,
      `${tag}: points not ordered by eventIndex`,
    );
  }
  if (p.best !== null) {
    const best = p.best;
    const max = Math.max(...p.points.map(x => x.score));
    v.check(best.score === max, `${tag}: best != max`);
    const first = p.points.find(x => x.score === max);
    v.check(
      first !== undefined && first.eventId === best.eventId,
      `${tag}: best tie not earliest`,
    );
  } else {
    v.check(p.points.length === 0, `${tag}: best null with points`);
  }
  // Oracle: points are exactly the ready events with a scored, non-null score, in index order.
  const oracle = s.events
    .filter(e => {
      if (e.state !== 'ready') return false;
      const result = (
        e.analysis as {
          result?: { resultKind?: string; overallScore?: number | null } | null;
        } | null
      )?.result;
      return (
        result !== undefined &&
        result !== null &&
        result.resultKind !== 'low_confidence' &&
        result.overallScore !== null
      );
    })
    .map(e => e.eventId);
  v.check(
    JSON.stringify(p.points.map(x => x.eventId)) === JSON.stringify(oracle),
    `${tag}: points ${p.points.map(x => x.eventId).join(',')} != oracle ${oracle.join(',')}`,
  );
  const expectedNoRead = s.events.filter(e => {
    if (e.state === 'abstained') return true;
    if (e.state !== 'ready') return false;
    const result = (
      e.analysis as { result?: { resultKind?: string } | null } | null
    )?.result;
    return result === null || result?.resultKind === 'low_confidence';
  }).length;
  v.check(
    p.noReadCount === expectedNoRead,
    `${tag}: noReadCount ${p.noReadCount} != ${expectedNoRead}`,
  );
  if (p.scoredCount >= 2) {
    v.check(
      p.startAverage !== null && p.endAverage !== null && p.delta !== null,
      `${tag}: delta null with >=2 scored`,
    );
    if (p.startAverage !== null && p.endAverage !== null && p.delta !== null) {
      v.check(
        Math.abs(p.delta - (p.endAverage - p.startAverage)) < 0.11,
        `${tag}: delta != end-start`,
      );
    }
  } else {
    v.check(p.delta === null, `${tag}: delta non-null with <2 scored`);
  }
  const pending = s.events.filter(
    e => e.state === 'pending' || e.state === 'processing',
  ).length;
  v.check(
    p.pendingCount === pending,
    `${tag}: pendingCount ${p.pendingCount} != ${pending}`,
  );
}

// ─── one iteration ──────────────────────────────────────────────────────────
interface Outcome {
  seed: number;
  status: 'HELD' | 'BROKEN' | 'DEADLOCK';
  actors: number;
  providerMode: ProviderMode;
  emissions: number;
  settles: number;
  events: number;
  snapshots: number;
  droppedInvalid: number;
  wallMs: number;
  violations: string[];
  registryCounterLag: string[];
  /** Per actor/event compact state history (only recorded for non-HELD seeds). */
  eventHistory?: Record<string, string[]>;
}

const DEADLOCK_MS = 5000;
const drain = () => new Promise<void>(resolve => setImmediate(resolve));

async function runIteration(seed: number): Promise<Outcome> {
  const started = Date.now();
  const plan = buildPlan(seed);
  const rng = makeRng(seed ^ 0x9e3779b9);
  const v = new Violations();
  /** Known divergence (see header): `getCompletedSession()` snapshot is
   * written BEFORE `onUpdate` runs, so a throwing subscriber on the last
   * notification leaves the registry's `onUpdateFailures` one behind. Recorded
   * per seed; only fails the campaign under STRESS_STRICT=1. */
  const registryCounterLag: string[] = [];
  listeners.length = 0;
  mockBridge.extractSessionEventClip.mockReset();
  runCaptureAnalysisMock.mockReset();
  savePendingCaptureMock.mockReset();

  const pending: Deferred[] = [];
  const expected = new Map<string, ExpectedOutcome>(); // `${actor}:${eventId}`
  const extractCalls = new Map<string, number>();
  let savesCalled = 0;
  let analyzesCalled = 0;
  let okExtractions = 0;
  let okSaves = 0;
  let dispatchesSeen = 0;
  let sawLogout = false;

  const actorByCaptureId = new Map<string, number>();
  for (let a = 0; a < plan.actors; a += 1)
    actorByCaptureId.set(`cap-${seed}-${a}`, a);
  const rangeKey = (actor: number, startMs: number, endMs: number) =>
    `${actor}:${startMs}:${endMs}`;
  const keyFromUri = (uri: string | undefined, fallback: string) => {
    const m = /session-clip-(\d+)-([\d.]+)-([\d.]+)\.mov$/.exec(uri ?? '');
    return m
      ? rangeKey(Number(m[1]), Number(m[2]), Number(m[3]))
      : `?:${fallback}`;
  };

  const defer = <T>(
    kind: Deferred['kind'],
    id: string,
    resolveWith: () => T | Promise<T>,
    hang: boolean,
  ) =>
    new Promise<T>((resolve, reject) => {
      pending.push({
        id,
        kind,
        hang,
        settle: () => {
          try {
            resolve(resolveWith());
          } catch (error) {
            reject(error);
          }
        },
      });
    });

  mockBridge.extractSessionEventClip.mockImplementation(
    (req: { sessionCaptureId: string; startMs: number; endMs: number }) => {
      const actorIdx = actorByCaptureId.get(req.sessionCaptureId);
      v.check(
        actorIdx !== undefined,
        `extract requested for unknown sessionCaptureId ${req.sessionCaptureId}`,
      );
      const key = rangeKey(actorIdx ?? -1, req.startMs, req.endMs);
      extractCalls.set(key, (extractCalls.get(key) ?? 0) + 1);
      const fault: ExtractFault = pick(rng, [
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'reject',
        'invalid_payload',
        'wrong_mode',
        'no_pose',
        ...(plan.allowHang ? (['hang'] as const) : []),
      ]);
      const hang = fault === 'hang';
      const setExpect = (o: ExpectedOutcome) => expected.set(key, o);
      switch (fault) {
        case 'ok':
          okExtractions += 1;
          break;
        case 'reject':
        case 'invalid_payload':
        case 'wrong_mode':
          setExpect({
            state: 'pending',
            pendingReasonPrefix: 'SESSION_CLIP_EXTRACTION_FAILED',
            abstainReasonPrefix: null,
            analysis: null,
          });
          break;
        case 'no_pose':
          setExpect({
            state: 'pending',
            pendingReasonPrefix: 'SESSION_CLIP_POSE_SLICE_EMPTY',
            abstainReasonPrefix: null,
            analysis: null,
          });
          break;
        case 'hang':
          setExpect({
            state: 'processing',
            pendingReasonPrefix: null,
            abstainReasonPrefix: null,
            analysis: null,
          });
          break;
      }
      return defer(
        'extract',
        key,
        () => {
          switch (fault) {
            case 'ok':
              return validClipPayload(actorIdx ?? -1, req.startMs, req.endMs);
            case 'reject':
              throw new Error(`bridge extract failed for ${key}`);
            case 'invalid_payload':
              return { uri: 'x', poseSequence: 'nope' };
            case 'wrong_mode':
              return {
                ...validClipPayload(actorIdx ?? -1, req.startMs, req.endMs),
                captureMode: 'manual_tap',
              };
            case 'no_pose':
              return {
                ...validClipPayload(actorIdx ?? -1, req.startMs, req.endMs),
                poseSequence: undefined,
              };
            default:
              return null;
          }
        },
        hang,
      );
    },
  );

  savePendingCaptureMock.mockImplementation(
    (
      _db: unknown,
      captureId: string,
      _shot: unknown,
      clip: { uri?: string },
    ) => {
      savesCalled += 1;
      // Correlate through the clip uri (deterministic per actor + event range).
      const key = keyFromUri(clip?.uri, captureId);
      const fault: SaveFault = pick(rng, [
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'reject',
      ]);
      if (fault === 'reject') {
        expected.set(key, {
          state: 'abstained',
          pendingReasonPrefix: null,
          abstainReasonPrefix: 'ANALYSIS_DISPATCH_FAILED',
          analysis: null,
        });
      } else {
        okSaves += 1;
      }
      return defer(
        'save',
        key,
        () => {
          if (fault === 'reject')
            throw new Error(`sqlite write failed for ${key}`);
          return undefined;
        },
        false,
      );
    },
  );

  runCaptureAnalysisMock.mockImplementation(
    (input: {
      captureId: string;
      sessionId?: string;
      declaredStroke?: unknown;
    }) => {
      analyzesCalled += 1;
      v.check(
        input.declaredStroke === null,
        `runCaptureAnalysis called with declaredStroke ${String(input.declaredStroke)}`,
      );
      v.check(
        typeof input.sessionId === 'string' &&
          input.sessionId.startsWith(`stress-${seed}-`),
        `runCaptureAnalysis sessionId ${String(input.sessionId)} not from this iteration`,
      );
      const key = keyFromUri(
        (input as { clip?: { uri?: string } }).clip?.uri,
        input.captureId,
      );
      const fault: AnalyzeFault = pick(rng, [
        'scored',
        'scored',
        'scored',
        'scored',
        'low_confidence',
        'low_confidence',
        'unavailable',
        'unavailable',
        'quality_blocked',
        'reject',
        ...(plan.allowHang ? (['hang'] as const) : []),
      ]);
      const record = analysisRecordDouble(
        `a-${key}`,
        pick(rng, [
          'forehand_drive',
          'backhand_drive',
          'dink',
          'serve',
        ] as const),
        fault === 'low_confidence'
          ? pick(rng, [
              { resultKind: 'low_confidence', overallScore: null },
              null,
            ])
          : {
              resultKind: 'scored',
              overallScore: Math.round(rng() * 100) / 10,
            },
      );
      switch (fault) {
        case 'scored':
        case 'low_confidence':
          expected.set(key, {
            state: 'ready',
            pendingReasonPrefix: null,
            abstainReasonPrefix: null,
            analysis: record,
          });
          break;
        case 'unavailable':
          expected.set(key, {
            state: 'pending',
            pendingReasonPrefix: 'network down',
            abstainReasonPrefix: null,
            analysis: null,
          });
          break;
        case 'quality_blocked':
          expected.set(key, {
            state: 'pending',
            pendingReasonPrefix: 'STRESS_QUALITY_BLOCKED',
            abstainReasonPrefix: null,
            analysis: null,
          });
          break;
        case 'reject':
          expected.set(key, {
            state: 'abstained',
            pendingReasonPrefix: null,
            abstainReasonPrefix: 'ANALYSIS_DISPATCH_FAILED',
            analysis: null,
          });
          break;
        case 'hang':
          expected.set(key, {
            state: 'processing',
            pendingReasonPrefix: null,
            abstainReasonPrefix: null,
            analysis: null,
          });
          break;
      }
      return defer(
        'analyze',
        key,
        () => {
          switch (fault) {
            case 'scored':
              return {
                kind: 'scored',
                analysisId: record.id,
                record,
                freeLimitReached: false,
              };
            case 'low_confidence':
              return {
                kind: 'low_confidence',
                analysisId: record.id,
                record,
                guidance: null,
              };
            case 'unavailable':
              return { kind: 'unavailable', reason: 'network down' };
            case 'quality_blocked':
              return {
                kind: 'quality_blocked',
                reason: 'STRESS_QUALITY_BLOCKED: pose gate withheld',
                envelope: null,
              };
            case 'reject':
              throw new Error(`analysis threw for ${key}`);
            default:
              return null;
          }
        },
        fault === 'hang',
      );
    },
  );

  // ── actors ──
  interface Actor {
    index: number;
    captureId: string;
    flow: LiveSessionFlow;
    ref: LiveSessionFlow;
    connections: Array<{
      conn: ReturnType<typeof connectNativeSessionMotionFeed>;
      alive: boolean;
      dropped: number;
    }>;
    trail: LiveSessionSnapshot[];
    reentered: {
      real: { end: boolean; push: boolean };
      ref: { end: boolean; push: boolean };
    };
    subscriberThrows: number;
  }
  const actors: Actor[] = [];

  const makeProvider = (
    actor: number,
    captureId: string,
  ): {
    provider: SessionEventAnalysisProvider;
    clipSource: SessionEventClipSource | undefined;
  } => {
    switch (plan.providerMode) {
      case 'native':
        return {
          provider: createNativeSessionAnalysisProvider(nativeDeps),
          clipSource: createNativeSessionEventClipSource(captureId),
        };
      case 'native_no_clip_source':
        return {
          provider: createNativeSessionAnalysisProvider(nativeDeps),
          clipSource: undefined,
        };
      case 'replay':
        return {
          provider: createPendingStubAnalysisProvider(),
          clipSource: undefined,
        };
      case 'custom_ready_without_record':
        return {
          clipSource: undefined,
          provider: {
            providerId: 'stress-ready-without-record',
            availability: () => ({ status: 'available' }),
            analyzeEvent: () =>
              Promise.resolve({
                status: 'ready',
                analysis: null,
              } as unknown as SessionEventAnalysisOutcome),
          },
        };
      case 'custom_sync_throw':
        return {
          clipSource: undefined,
          provider: {
            providerId: 'stress-sync-throw',
            availability: () => ({ status: 'available' }),
            analyzeEvent: () => {
              throw new Error(`sync provider failure (${actor})`);
            },
          },
        };
      case 'custom_logout_midway':
        return {
          clipSource: undefined,
          provider: {
            providerId: 'stress-logout-midway',
            availability: () => {
              dispatchesSeen += 1;
              if (dispatchesSeen > plan.logoutAfterDispatches) {
                sawLogout = true;
                return {
                  status: 'unavailable',
                  pendingReason: 'SESSION_SIGNED_OUT',
                };
              }
              return { status: 'available' };
            },
            analyzeEvent: () =>
              defer<SessionEventAnalysisOutcome>(
                'analyze',
                `logout-${actor}`,
                () => ({ status: 'abstained', abstainReason: 'NO_READ' }),
                false,
              ),
          },
        };
    }
  };

  for (let a = 0; a < plan.actors; a += 1) {
    const actor: Actor = {
      index: a,
      captureId: `cap-${seed}-${a}`,
      flow: null as unknown as LiveSessionFlow,
      ref: null as unknown as LiveSessionFlow,
      connections: [],
      trail: [],
      reentered: {
        real: { end: false, push: false },
        ref: { end: false, push: false },
      },
      subscriberThrows: 0,
    };
    const subscriber = (isRef: boolean) => (s: LiveSessionSnapshot) => {
      const target = isRef ? actor.ref : actor.flow;
      const flags = isRef ? actor.reentered.ref : actor.reentered.real;
      if (!isRef) actor.trail.push(s);
      if (
        plan.reentrantEndAtStrokeCount !== null &&
        !flags.end &&
        s.strokeCount >= plan.reentrantEndAtStrokeCount
      ) {
        flags.end = true;
        target.end();
      }
      if (
        plan.reentrantPushAtDurationMs !== null &&
        !flags.push &&
        s.phase === 'running' &&
        s.durationMs >= plan.reentrantPushAtDurationMs
      ) {
        flags.push = true;
        target.pushSample({ tMs: s.durationMs + 1, v: 0.5 });
      }
      if (!isRef && plan.throwingSubscriber && s.strokeCount % 2 === 1) {
        actor.subscriberThrows += 1;
        throw new Error('subscriber exploded');
      }
    };
    const wiring = makeProvider(a, actor.captureId);
    actor.flow = new LiveSessionFlow({
      sessionId: `stress-${seed}-${a}`,
      source: 'live',
      provider: wiring.provider,
      clipSource: wiring.clipSource,
      onUpdate: subscriber(false),
    });
    actor.ref = new LiveSessionFlow({
      sessionId: `stress-ref-${seed}-${a}`,
      source: 'live',
      provider: createPendingStubAnalysisProvider(),
      onUpdate: subscriber(true),
    });
    actors.push(actor);
  }
  const connect = (actor: Actor) => {
    const conn = connectNativeSessionMotionFeed(actor.flow, {
      sessionCaptureId: actor.captureId,
    });
    actor.connections.push({ conn, alive: true, dropped: 0 });
  };
  for (const actor of actors) connect(actor);

  const snapshotAll = () => {
    for (const actor of actors) actor.trail.push(actor.flow.snapshot());
  };

  // ── the feed-contract model: which pushes must each real flow receive ──
  const modelEmission = (em: Emission) => {
    switch (em.kind) {
      case 'sample': {
        for (const actor of actors) {
          for (const c of actor.connections) {
            if (!c.alive) continue;
            if (em.captureId !== undefined && em.captureId !== actor.captureId)
              continue;
            if (actor.ref.ended()) {
              c.alive = false;
              continue;
            }
            actor.ref.pushSample({ tMs: em.tMs, v: em.v });
          }
        }
        break;
      }
      case 'malformed':
        for (const actor of actors)
          for (const c of actor.connections) if (c.alive) c.dropped += 1;
        break;
      case 'foreign':
        break;
      case 'end':
        actors[em.actor]?.ref.end();
        break;
      case 'disconnect': {
        const c = actors[em.actor]?.connections[em.conn];
        if (c) c.alive = false;
        break;
      }
      case 'connect':
        break;
    }
  };

  const emit = (payload: unknown) => {
    for (const cb of [...listeners]) cb(payload);
  };

  const applyEmission = (em: Emission) => {
    switch (em.kind) {
      case 'sample':
        emit({
          type: SESSION_MOTION_SAMPLE_EVENT_TYPE,
          tMs: em.tMs,
          v: em.v,
          ...(em.captureId === undefined ? {} : { captureId: em.captureId }),
          emittedAtIso: '2026-09-04T00:00:00.000Z',
        });
        break;
      case 'malformed':
        emit(em.payload);
        break;
      case 'foreign':
        emit({ type: 'capture_started', captureId: 'x' });
        break;
      case 'end': {
        const actor = actors[em.actor];
        if (!actor) break;
        const first = actor.flow.end();
        const again = actor.flow.end();
        const core = (x: LiveSessionSnapshot) =>
          JSON.stringify({ ...x, onUpdateFailures: 0 });
        v.check(
          core(first) === core(again),
          `actor ${em.actor}: end() not idempotent`,
        );
        v.check(
          again.phase === 'ended' && actor.flow.ended(),
          `actor ${em.actor}: end() left phase ${again.phase}`,
        );
        break;
      }
      case 'disconnect': {
        const c = actors[em.actor]?.connections[em.conn];
        if (c) c.conn.disconnect();
        break;
      }
      case 'connect': {
        const actor = actors[em.actor];
        if (actor && !actor.flow.ended()) connect(actor);
        else if (actor) connect(actor);
        break;
      }
    }
  };

  // ── scheduler loop ──
  let settles = 0;
  let cursor = 0;
  const total = plan.emissions.length;
  const guard = Date.now();
  for (;;) {
    if (cursor >= total) {
      // Dispatch chains reach the provider asynchronously (extractClip is
      // awaited first): flush microtasks so late-registered deferreds are
      // still scheduled before deciding the fabric is quiescent.
      await drain();
      await drain();
      if (!pending.some(p => !p.hang)) break;
    }
    if (Date.now() - guard > DEADLOCK_MS) {
      v.check(
        false,
        `scheduler exceeded ${DEADLOCK_MS}ms wall time (cursor ${cursor}/${total}, pending ${pending.length})`,
      );
      break;
    }
    const settleable = pending.filter(p => !p.hang);
    const doSettle =
      settleable.length > 0 &&
      (cursor >= total || chance(rng, plan.settleBias));
    if (doSettle) {
      const d = pick(rng, settleable);
      pending.splice(pending.indexOf(d), 1);
      d.settle();
      settles += 1;
      await drain();
      await drain();
    } else {
      const em = plan.emissions[cursor]!;
      cursor += 1;
      if (em.kind === 'connect') {
        // model: a second live connection on actor 0
        applyEmission(em);
        const actor = actors[em.actor];
        if (actor) {
          const c = actor.connections[actor.connections.length - 1];
          if (c) c.alive = true;
        }
      } else {
        applyEmission(em);
        modelEmission(em);
      }
      if (chance(rng, 0.3)) await drain();
    }
    snapshotAll();
  }

  // Let every non-hung promise chain finish.
  for (let i = 0; i < 10; i += 1) await drain();

  // ── settled() must resolve promptly when nothing hangs ──
  const hungCount = pending.filter(p => p.hang).length;
  if (hungCount === 0) {
    for (const actor of actors) {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const raced = await Promise.race([
        actor.flow.settled().then(() => 'settled' as const),
        new Promise<'timeout'>(r => {
          timer = setTimeout(() => r('timeout'), 2000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      v.check(
        raced === 'settled',
        `actor ${actor.index}: settled() did not resolve within 2s with no hung native call`,
      );
    }
  }

  // ── final invariants ──
  let totalEvents = 0;
  let totalDropped = 0;
  let totalSnapshots = 0;
  for (const actor of actors) {
    const s = actor.flow.snapshot();
    const r = actor.ref.snapshot();
    totalEvents += s.events.length;
    totalSnapshots += actor.trail.length;
    const tag = `seed ${seed} actor ${actor.index}`;

    // Structural equality with the contract-model reference flow.
    const strip = (x: LiveSessionSnapshot) =>
      x.events.map(e => [
        e.eventId,
        e.startMs,
        e.peakMs,
        e.endMs,
        e.closeReason,
        e.closedAtMs,
      ]);
    v.check(
      JSON.stringify(strip(s)) === JSON.stringify(strip(r)),
      `${tag}: events differ from feed-contract reference (${s.events.length} vs ${r.events.length})`,
    );
    v.check(
      s.durationMs === r.durationMs,
      `${tag}: durationMs ${s.durationMs} != reference ${r.durationMs}`,
    );
    v.check(
      s.droppedLateSamples === r.droppedLateSamples,
      `${tag}: droppedLateSamples ${s.droppedLateSamples} != reference ${r.droppedLateSamples}`,
    );
    v.check(
      s.phase === r.phase,
      `${tag}: phase ${s.phase} != reference ${r.phase}`,
    );

    // Feed-level accounting.
    actor.connections.forEach((c, i) => {
      totalDropped += c.conn.droppedInvalidSamples();
      v.check(
        c.conn.droppedInvalidSamples() === c.dropped,
        `${tag} conn ${i}: droppedInvalid ${c.conn.droppedInvalidSamples()} != model ${c.dropped}`,
      );
    });
    if (plan.throwingSubscriber) {
      v.check(
        s.onUpdateFailures >= actor.subscriberThrows,
        `${tag}: onUpdateFailures ${s.onUpdateFailures} < subscriber throws ${actor.subscriberThrows}`,
      );
    } else if (plan.reentrantPushAtDurationMs === null) {
      v.check(
        s.onUpdateFailures === 0,
        `${tag}: unexpected onUpdateFailures ${s.onUpdateFailures}`,
      );
    }

    // Snapshot shape + monotonic trail.
    checkSnapshotShape(v, s, tag);
    checkProgression(v, s, tag);
    for (let i = 1; i < actor.trail.length; i += 1) {
      checkMonotonic(
        v,
        actor.trail[i - 1]!,
        actor.trail[i]!,
        `${tag} trail[${i}]`,
      );
      checkSnapshotShape(v, actor.trail[i]!, `${tag} trail[${i}]`);
    }

    // Per-event outcome vs fault fabric.
    for (const e of s.events) {
      const key = rangeKey(actor.index, e.startMs, e.endMs);
      const exp = expected.get(key);
      switch (plan.providerMode) {
        case 'replay':
        case 'native_no_clip_source':
          v.check(
            e.state === 'pending' &&
              e.pendingReason === NATIVE_CLIP_EXTRACTION_NOT_BUILT,
            `${tag} ${e.eventId}: ${plan.providerMode} state ${e.state}/${e.pendingReason}`,
          );
          break;
        case 'custom_ready_without_record':
          v.check(
            e.state === 'abstained' &&
              (e.abstainReason ?? '').startsWith('ANALYSIS_DISPATCH_FAILED'),
            `${tag} ${e.eventId}: ready-without-record not abstained (${e.state}/${e.abstainReason})`,
          );
          break;
        case 'custom_sync_throw':
          v.check(
            e.state === 'abstained' &&
              (e.abstainReason ?? '').startsWith('ANALYSIS_DISPATCH_FAILED'),
            `${tag} ${e.eventId}: sync-throw not abstained (${e.state})`,
          );
          break;
        case 'custom_logout_midway':
          v.check(
            (e.state === 'abstained' && e.abstainReason === 'NO_READ') ||
              (e.state === 'pending' &&
                e.pendingReason === 'SESSION_SIGNED_OUT'),
            `${tag} ${e.eventId}: logout provider state ${e.state}/${e.pendingReason}/${e.abstainReason}`,
          );
          break;
        case 'native': {
          const calls = extractCalls.get(key) ?? 0;
          v.check(
            calls === 1,
            `${tag} ${e.eventId}: extract called ${calls}× (expected exactly once)`,
          );
          if (!exp) {
            v.check(
              false,
              `${tag} ${e.eventId}: no fabric outcome recorded (state ${e.state}, pending=${e.pendingReason}, abstain=${e.abstainReason})`,
            );
            break;
          }
          v.check(
            e.state === exp.state,
            `${tag} ${e.eventId}: state ${e.state} != expected ${exp.state}`,
          );
          if (exp.pendingReasonPrefix !== null) {
            v.check(
              (e.pendingReason ?? '').startsWith(exp.pendingReasonPrefix),
              `${tag} ${e.eventId}: pendingReason ${e.pendingReason} !~ ${exp.pendingReasonPrefix}`,
            );
          }
          if (exp.abstainReasonPrefix !== null) {
            v.check(
              (e.abstainReason ?? '').startsWith(exp.abstainReasonPrefix),
              `${tag} ${e.eventId}: abstainReason ${e.abstainReason} !~ ${exp.abstainReasonPrefix}`,
            );
          }
          if (exp.analysis !== 'any') {
            v.check(
              e.analysis === exp.analysis,
              `${tag} ${e.eventId}: analysis identity mismatch`,
            );
          }
          break;
        }
      }
    }

    // Registry: ended sessions are retrievable and equal to the live snapshot.
    const stored = getCompletedSession(s.sessionId);
    if (s.phase === 'ended') {
      const core = (x: LiveSessionSnapshot) =>
        JSON.stringify({ ...x, onUpdateFailures: 0 });
      v.check(
        stored !== null && core(stored) === core(s),
        `${tag}: completed-session registry events/phase != final snapshot`,
      );
      if (stored !== null && stored.onUpdateFailures !== s.onUpdateFailures) {
        registryCounterLag.push(
          `${tag}: registry onUpdateFailures ${stored.onUpdateFailures} != live ${s.onUpdateFailures}`,
        );
        v.check(
          !STRICT,
          `${tag}: registry onUpdateFailures ${stored.onUpdateFailures} != live ${s.onUpdateFailures}`,
        );
      }
      let threw = false;
      try {
        actor.flow.pushSample({ tMs: s.durationMs + 10, v: 1 });
      } catch {
        threw = true;
      }
      v.check(threw, `${tag}: pushSample after end() did not throw`);
    } else {
      v.check(
        stored === null,
        `${tag}: running session present in completed registry`,
      );
    }
    for (const c of actor.connections) c.conn.disconnect();
  }
  if (plan.providerMode !== 'native') {
    v.check(
      mockBridge.extractSessionEventClip.mock.calls.length === 0,
      `seed ${seed}: bridge extract called without a clip source`,
    );
  }
  if (plan.providerMode === 'native_no_clip_source') {
    v.check(
      savesCalled === 0 && analyzesCalled === 0,
      `seed ${seed}: clip-less request reached save/analyze`,
    );
  }
  if (plan.providerMode === 'native') {
    v.check(
      savesCalled === okExtractions,
      `seed ${seed}: savePendingCapture called ${savesCalled}× for ${okExtractions} ok extractions`,
    );
    v.check(
      analyzesCalled === okSaves,
      `seed ${seed}: runCaptureAnalysis called ${analyzesCalled}× for ${okSaves} ok saves`,
    );
  }
  if (
    plan.providerMode === 'custom_logout_midway' &&
    totalEvents > plan.logoutAfterDispatches
  ) {
    v.check(sawLogout, `seed ${seed}: logout availability never consulted`);
  }
  v.check(
    listeners.length === 0,
    `seed ${seed}: ${listeners.length} native listeners leaked after disconnect`,
  );

  const wallMs = Date.now() - started;
  const deadlock = v.items.some(
    m => m.includes('wall time') || m.includes('did not resolve'),
  );
  let eventHistory: Record<string, string[]> | undefined;
  if (v.items.length > 0) {
    eventHistory = {};
    for (const actor of actors) {
      const perEvent = new Map<string, string[]>();
      for (const snap of actor.trail) {
        for (const e of snap.events) {
          const hist = perEvent.get(e.eventId) ?? [];
          const entry = `${e.state}${e.pendingReason ? `(pending:${e.pendingReason.slice(0, 40)})` : ''}${e.abstainReason ? `(abstain:${e.abstainReason.slice(0, 40)})` : ''}`;
          if (hist[hist.length - 1] !== entry) hist.push(entry);
          perEvent.set(e.eventId, hist);
        }
      }
      for (const [id, hist] of perEvent)
        eventHistory[`${actor.index}:${id}`] = hist;
    }
  }
  return {
    ...(eventHistory ? { eventHistory } : {}),
    seed,
    status: v.items.length === 0 ? 'HELD' : deadlock ? 'DEADLOCK' : 'BROKEN',
    actors: plan.actors,
    providerMode: plan.providerMode,
    emissions: plan.emissions.length,
    settles,
    events: totalEvents,
    snapshots: totalSnapshots,
    droppedInvalid: totalDropped,
    wallMs,
    violations: v.items,
    registryCounterLag,
  };
}

// ─── campaign ───────────────────────────────────────────────────────────────
const ITER = Number(process.env.STRESS_ITER ?? 60);
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904);
const ONLY = process.env.STRESS_ONLY ? Number(process.env.STRESS_ONLY) : null;
const OUT = process.env.STRESS_OUT;
const STRICT = process.env.STRESS_STRICT === '1';

describe('STRESS mod-session-flow / concurrency (seeded scheduler)', () => {
  jest.setTimeout(20 * 60 * 1000);

  test(`campaign: ${ONLY !== null ? `seed ${ONLY}` : `${ITER} seeds from ${BASE_SEED}`}`, async () => {
    const seeds =
      ONLY !== null
        ? [ONLY]
        : Array.from({ length: ITER }, (_, i) => BASE_SEED + i);
    const outcomes: Outcome[] = [];
    for (const seed of seeds) outcomes.push(await runIteration(seed));

    const failures = outcomes.filter(o => o.status !== 'HELD');
    const summary = {
      unit: 'mod-session-flow',
      lens: 'concurrency',
      baseSeed: BASE_SEED,
      iterations: outcomes.length,
      held: outcomes.length - failures.length,
      broken: failures.length,
      totalEmissions: outcomes.reduce((a, o) => a + o.emissions, 0),
      totalSettles: outcomes.reduce((a, o) => a + o.settles, 0),
      totalEvents: outcomes.reduce((a, o) => a + o.events, 0),
      totalSnapshotsChecked: outcomes.reduce((a, o) => a + o.snapshots, 0),
      totalDroppedInvalid: outcomes.reduce((a, o) => a + o.droppedInvalid, 0),
      maxWallMs: Math.max(...outcomes.map(o => o.wallMs)),
      byProvider: outcomes.reduce<Record<string, number>>((acc, o) => {
        acc[o.providerMode] = (acc[o.providerMode] ?? 0) + 1;
        return acc;
      }, {}),
      twoActorIterations: outcomes.filter(o => o.actors === 2).length,
      registryCounterLagSeeds: outcomes
        .filter(o => o.registryCounterLag.length > 0)
        .map(o => o.seed),
      strict: STRICT,
      outcomes,
    };
    if (OUT) writeFileSync(OUT, JSON.stringify(summary, null, 2));
    if (failures.length > 0) {
      throw new Error(
        `${failures.length}/${outcomes.length} seeds violated invariants:\n` +
          failures
            .slice(0, 10)
            .map(
              f =>
                `  seed ${f.seed} [${f.status}] ${f.violations.slice(0, 5).join(' | ')}`,
            )
            .join('\n'),
      );
    }
    expect(failures).toHaveLength(0);
  });

  test('burst: Promise.all of concurrent end()/pushSample/snapshot on one flow is idempotent and bounded', async () => {
    const rng = makeRng(BASE_SEED ^ 0x5eed);
    const flows = Array.from({ length: 25 }, (_, i) => {
      const flow = new LiveSessionFlow({
        sessionId: `burst-${i}`,
        source: 'live',
        provider: createPendingStubAnalysisProvider(),
        onUpdate: () => {
          if (chance(rng, 0.2)) throw new Error('subscriber boom');
        },
      });
      for (let k = 0; k < fixtureStream.length; k += 1) {
        const w = fixtureStream[k]!;
        flow.pushSample({ tMs: w.tMs, v: w.v });
      }
      return flow;
    });
    const started = Date.now();
    const results = await Promise.all(
      flows.flatMap(flow => [
        Promise.resolve().then(() => flow.end()),
        Promise.resolve().then(() => flow.end()),
        Promise.resolve().then(() => flow.snapshot()),
        Promise.resolve().then(() => {
          try {
            flow.pushSample({ tMs: 999_999, v: 1 });
            return 'pushed';
          } catch {
            return 'rejected';
          }
        }),
        flow.settled().then(() => 'settled'),
      ]),
    );
    expect(Date.now() - started).toBeLessThan(5000);
    for (const flow of flows) {
      const s = flow.snapshot();
      expect(s.phase).toBe('ended');
      expect(new Set(s.events.map(e => e.eventId)).size).toBe(s.events.length);
      expect(s.strokeCount).toBe(s.events.length);
      const stored = getCompletedSession(s.sessionId);
      expect(stored?.events.map(e => [e.eventId, e.state])).toEqual(
        s.events.map(e => [e.eventId, e.state]),
      );
    }
    // Every post-end push after end() settled must reject; ordering within the
    // microtask burst decides whether the push landed before or after end().
    const pushOutcomes = results.filter(
      r => r === 'pushed' || r === 'rejected',
    );
    expect(pushOutcomes).toHaveLength(flows.length);
    expect(pushOutcomes.every(r => r === 'rejected')).toBe(true);
  });

  (STRICT ? test : test.skip)(
    'minimized reproducer: getCompletedSession().onUpdateFailures tracks the live snapshot after a throwing final onUpdate',
    () => {
      const flow = new LiveSessionFlow({
        sessionId: 'registry-lag-repro',
        source: 'live',
        provider: createPendingStubAnalysisProvider(),
        onUpdate: () => {
          throw new Error('always throws');
        },
      });
      flow.pushSample({ tMs: 0, v: 0 });
      flow.end();
      const live = flow.snapshot();
      const stored = getCompletedSession('registry-lag-repro');
      expect(stored?.onUpdateFailures).toBe(live.onUpdateFailures);
    },
  );
});
