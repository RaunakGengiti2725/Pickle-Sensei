/**
 * mod-capture / concurrency — native bridge wrappers in
 * `src/camera/capture.ts` under seeded Promise.all bursts against a
 * SIMULATED native module (never the real bridge; Swift behaviour is not
 * claimed here).
 *
 * Per seed the plan is: a burst of 2–14 interleaved wrapper calls
 * (duplicate captures, capture-during-capture, two actors stopping /
 * extracting the SAME sessionCaptureId, cancel-during-call, strategy flips,
 * pose extraction with valid and out-of-range seeds), native outcomes drawn
 * from {valid, odd fps/aspect, malformed, permission denied, user cancelled,
 * frame-drop error}, settled in a seed-chosen order, with camera-event
 * subscribers attaching / detaching / double-detaching (rotation + logout)
 * mid-burst.
 *
 * Invariants asserted per iteration:
 *  - every wrapper promise settles inside the wall bound (no deadlock);
 *  - a fulfilled call returns exactly the payload native produced FOR THAT
 *    CALL (uri tag) — no cross-talk between interleaved promises;
 *  - a malformed payload is rejected with the boundary error, a native
 *    rejection propagates as the SAME error object (codes survive), a
 *    legal odd fps/aspect is never rejected;
 *  - one native invocation per wrapper call, per method (no dedupe, no
 *    duplicate issuance), cancel forwarded once per cancel;
 *  - extractSessionEventClip / extractImportedPoseSequence forward the
 *    request verbatim; an out-of-range seed never reaches native;
 *  - startSessionCapture records exactly ONE stability event per call with
 *    the reason matching the outcome (no double-counted startup failures);
 *  - the completion strategy native ends on is the last-applied call's;
 *  - each event subscriber receives exactly the events emitted while it was
 *    subscribed, in order; detaching twice is harmless.
 *
 * Replay: STRESS_SEED=<seed> npx jest --ci __tests__/stress/captureBridgeConcurrency.stress.test.ts
 */
jest.mock('react-native', () => {
  const listeners: Array<(event: object) => void> = [];
  const bridge = {
    capture: () => Promise.reject(new Error('unplanned capture')),
    importVideo: () => Promise.reject(new Error('unplanned importVideo')),
    cancel: () => {},
    addListener: () => {},
    removeListeners: () => {},
    readTextFile: () => Promise.reject(new Error('unplanned readTextFile')),
    setCompletionStrategy: () =>
      Promise.reject(new Error('unplanned setCompletionStrategy')),
    startSessionCapture: () =>
      Promise.reject(new Error('unplanned startSessionCapture')),
    stopSessionCapture: () =>
      Promise.reject(new Error('unplanned stopSessionCapture')),
    extractSessionEventClip: () =>
      Promise.reject(new Error('unplanned extractSessionEventClip')),
    extractImportedPoseSequence: () =>
      Promise.reject(new Error('unplanned extractImportedPoseSequence')),
  };
  return {
    Platform: { OS: 'ios' },
    NativeModules: { PickleVideoCapture: bridge },
    NativeEventEmitter: class {
      addListener(_type: string, listener: (event: object) => void) {
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

import {
  cancelCameraOperation,
  captureStrokeVideo,
  extractImportedPoseSequence,
  extractSessionEventClip,
  importStrokeVideo,
  readCaptureArtifact,
  setCaptureCompletionStrategy,
  startSessionCapture,
  stopSessionCapture,
  subscribeToCameraEvents,
  type CameraEvent,
  type CaptureCompletionStrategy,
  type CapturedClip,
  type SessionEventClipBounds,
} from '../../src/camera/capture';
import { stabilitySlo } from '../../src/analysis/stabilityTelemetry';
import {
  importedClipPayload,
  planClipPayload,
  poseExtractionPayload,
} from '../../testing/stress/captureFixtures';
import {
  describeFailures,
  pick,
  randomInt,
  runCampaign,
  SeededScheduler,
  seededRandom,
  stableJson,
  type IterationResult,
  type Rng,
} from '../../testing/stress/harness';

interface SimulatedBridge {
  capture: () => Promise<unknown>;
  importVideo: () => Promise<unknown>;
  cancel: () => void;
  readTextFile: (uri: string) => Promise<string>;
  setCompletionStrategy: (strategy: string) => Promise<string>;
  startSessionCapture: () => Promise<unknown>;
  stopSessionCapture: (id: string) => Promise<unknown>;
  extractSessionEventClip: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
  extractImportedPoseSequence: (
    request: Record<string, unknown>,
  ) => Promise<unknown>;
}

const { __simulatedBridge: bridge, __simulatedListeners: emitterListeners } =
  jest.requireMock('react-native') as {
    __simulatedBridge: SimulatedBridge;
    __simulatedListeners: Array<(event: object) => void>;
  };

const SUITE = 'captureBridgeConcurrency';

type NativeErrorKind = 'permission_denied' | 'user_cancelled' | 'frame_drop';

function nativeError(kind: NativeErrorKind): Error & { code: string } {
  const codes: Record<NativeErrorKind, string> = {
    permission_denied: 'camera.permission_denied',
    user_cancelled: 'camera.cancelled',
    frame_drop: 'camera.frame_drop',
  };
  const error = new Error(`native ${kind}`) as Error & { code: string };
  error.code = codes[kind];
  return error;
}

type OpKind =
  | 'capture'
  | 'import'
  | 'startSession'
  | 'stopSession'
  | 'extractClip'
  | 'extractPose'
  | 'setStrategy'
  | 'cancel'
  | 'readArtifact';

const OP_KINDS: readonly OpKind[] = [
  'capture',
  'capture',
  'import',
  'startSession',
  'stopSession',
  'stopSession',
  'extractClip',
  'extractClip',
  'extractPose',
  'setStrategy',
  'setStrategy',
  'cancel',
  'readArtifact',
];

interface Op {
  index: number;
  kind: OpKind;
  /** Planned native outcome. */
  outcome: 'valid' | 'malformed' | NativeErrorKind;
  mutation: string | null;
  uri: string;
  sessionId: string;
  bounds: SessionEventClipBounds;
  strategy: CaptureCompletionStrategy;
  poseSeed: { x: number; y: number } | null | undefined;
  poseSeedValid: boolean;
  nativeErr: (Error & { code: string }) | null;
  settled: 'fulfilled' | 'rejected' | 'pending';
  result: unknown;
  error: unknown;
}

const SESSION_IDS = ['session-A', 'session-B'];

function planOp(random: Rng, seed: number, index: number): Op {
  const kind = pick(random, OP_KINDS);
  const roll = random();
  let outcome: Op['outcome'] = 'valid';
  if (roll < 0.12) outcome = 'permission_denied';
  else if (roll < 0.22) outcome = 'user_cancelled';
  else if (roll < 0.3) outcome = 'frame_drop';
  else if (roll < 0.55) outcome = 'malformed';
  const poseSeedRoll = random();
  const poseSeed =
    poseSeedRoll < 0.25
      ? undefined
      : poseSeedRoll < 0.4
        ? null
        : poseSeedRoll < 0.7
          ? { x: random(), y: random() }
          : pick(random, [
              { x: Number.NaN, y: 0.5 },
              { x: 1.5, y: 0.5 },
              { x: 0.5, y: -0.1 },
              { x: 0.5, y: Number.POSITIVE_INFINITY },
            ]);
  const poseSeedValid =
    poseSeed === undefined ||
    poseSeed === null ||
    (poseSeed.x >= 0 && poseSeed.x <= 1 && poseSeed.y >= 0 && poseSeed.y <= 1);
  const startMs = randomInt(random, 0, 60_000);
  return {
    index,
    kind,
    outcome,
    mutation: null,
    uri: `file:///stress/${seed}/${index}.mov`,
    sessionId: pick(random, SESSION_IDS),
    bounds: {
      startMs,
      endMs: startMs + randomInt(random, 200, 3000),
      peakMs: random() < 0.2 ? null : startMs + randomInt(random, 0, 200),
      confidence: random(),
      detectionModelVersion: 'session-engine-stress',
    },
    strategy: random() < 0.5 ? 'fixed' : 'adaptive',
    poseSeed,
    poseSeedValid,
    nativeErr: null,
    settled: 'pending',
    result: undefined,
    error: undefined,
  };
}

interface Counters {
  capture: number;
  importVideo: number;
  cancel: number;
  readTextFile: number;
  setCompletionStrategy: number;
  startSessionCapture: number;
  stopSessionCapture: number;
  extractSessionEventClip: number;
  extractImportedPoseSequence: number;
}

function zeroCounters(): Counters {
  return {
    capture: 0,
    importVideo: 0,
    cancel: 0,
    readTextFile: 0,
    setCompletionStrategy: 0,
    startSessionCapture: 0,
    stopSessionCapture: 0,
    extractSessionEventClip: 0,
    extractImportedPoseSequence: 0,
  };
}

interface Subscriber {
  id: number;
  subscribeAt: number;
  unsubscribeAt: number;
  doubleUnsubscribe: boolean;
  received: string[];
  expected: string[];
  unsubscribe: (() => void) | null;
}

function cameraEvent(step: number, random: Rng): CameraEvent {
  const kinds: CameraEvent[] = [
    {
      type: 'permission',
      state: pick(random, ['requesting', 'granted', 'denied'] as const),
      emittedAtIso: `2026-09-05T00:00:${String(step % 60).padStart(2, '0')}.000Z`,
    },
    {
      type: 'readiness',
      state: 'ready',
      jointCoverage: random(),
      emittedAtIso: '2026-09-05T00:00:00.000Z',
    } as CameraEvent,
    {
      type: 'processing',
      emittedAtIso: '2026-09-05T00:00:00.000Z',
    } as CameraEvent,
  ];
  return pick(random, kinds);
}

async function iteration(seed: number, random: Rng): Promise<IterationResult> {
  const violations: string[] = [];
  const scheduler = new SeededScheduler(random);
  const counters = zeroCounters();
  const ops: Op[] = [];
  const burst = randomInt(random, 2, 14);
  for (let i = 0; i < burst; i += 1) ops.push(planOp(random, seed, i));

  // Native state the simulated bridge owns: the strategy is applied at
  // SETTLE time (the order the scheduler picks), and the last one applied is
  // what native must report afterwards.
  let nativeStrategy: CaptureCompletionStrategy = 'fixed';
  let lastAppliedStrategyOp: Op | null = null;
  const forwardedClipRequests: Array<Record<string, unknown>> = [];
  const forwardedPoseRequests: Array<Record<string, unknown>> = [];
  const forwardedStops: string[] = [];
  const readUris: string[] = [];

  const errorFor = (op: Op): Error & { code: string } => {
    if (!op.nativeErr)
      op.nativeErr = nativeError(op.outcome as NativeErrorKind);
    return op.nativeErr;
  };

  let current: Op | null = null;
  const clipOutcome = (
    op: Op,
    mode: 'automatic_pose_trigger' | 'imported_video',
  ): Promise<unknown> => {
    if (op.outcome === 'valid' || op.outcome === 'malformed') {
      const planned = planClipPayload(
        random,
        mode,
        op.uri,
        op.outcome === 'malformed' ? 1 : 0,
      );
      op.mutation = planned.mutation;
      return scheduler.hold(`${op.kind}#${op.index}`, () => planned.payload);
    }
    return scheduler.holdRejection(`${op.kind}#${op.index}`, errorFor(op));
  };

  bridge.capture = () => {
    counters.capture += 1;
    const op = current;
    if (!op) throw new Error('capture without current op');
    return clipOutcome(op, 'automatic_pose_trigger');
  };
  bridge.importVideo = () => {
    counters.importVideo += 1;
    const op = current;
    if (!op) throw new Error('importVideo without current op');
    return clipOutcome(op, 'imported_video');
  };
  bridge.cancel = () => {
    counters.cancel += 1;
  };
  bridge.readTextFile = uri => {
    counters.readTextFile += 1;
    readUris.push(uri);
    const op = current;
    if (!op) throw new Error('readTextFile without current op');
    if (op.outcome === 'valid' || op.outcome === 'malformed') {
      return scheduler.hold(`read#${op.index}`, () => `sidecar:${uri}`);
    }
    return scheduler.holdRejection(`read#${op.index}`, errorFor(op));
  };
  bridge.setCompletionStrategy = strategy => {
    counters.setCompletionStrategy += 1;
    const op = current;
    if (!op) throw new Error('setCompletionStrategy without current op');
    if (op.outcome === 'malformed') {
      return scheduler.hold(`strategy#${op.index}`, () => 'turbo');
    }
    if (op.outcome !== 'valid') {
      return scheduler.holdRejection(`strategy#${op.index}`, errorFor(op));
    }
    return scheduler.hold(`strategy#${op.index}`, () => {
      nativeStrategy = strategy as CaptureCompletionStrategy;
      lastAppliedStrategyOp = op;
      return strategy;
    });
  };
  bridge.startSessionCapture = () => {
    counters.startSessionCapture += 1;
    const op = current;
    if (!op) throw new Error('startSessionCapture without current op');
    if (op.outcome === 'malformed') {
      const bad = pick(random, [
        { sessionCaptureId: '' },
        { sessionCaptureId: 42 },
        null,
        'session-A',
        {},
      ]);
      op.mutation = `receipt:${stableJson(bad)}`;
      return scheduler.hold(`start#${op.index}`, () => bad);
    }
    if (op.outcome !== 'valid') {
      return scheduler.holdRejection(`start#${op.index}`, errorFor(op));
    }
    return scheduler.hold(`start#${op.index}`, () => ({
      sessionCaptureId: op.sessionId,
    }));
  };
  bridge.stopSessionCapture = id => {
    counters.stopSessionCapture += 1;
    forwardedStops.push(id);
    const op = current;
    if (!op) throw new Error('stopSessionCapture without current op');
    if (op.outcome === 'valid' || op.outcome === 'malformed') {
      return scheduler.hold(`stop#${op.index}`, () => null);
    }
    return scheduler.holdRejection(`stop#${op.index}`, errorFor(op));
  };
  bridge.extractSessionEventClip = request => {
    counters.extractSessionEventClip += 1;
    forwardedClipRequests.push(request);
    const op = current;
    if (!op) throw new Error('extractSessionEventClip without current op');
    return clipOutcome(op, 'automatic_pose_trigger');
  };
  bridge.extractImportedPoseSequence = request => {
    counters.extractImportedPoseSequence += 1;
    forwardedPoseRequests.push(request);
    const op = current;
    if (!op) throw new Error('extractImportedPoseSequence without current op');
    if (op.outcome === 'malformed') {
      return scheduler.hold(`pose#${op.index}`, () => ({
        ...poseExtractionPayload(`${seed}-${op.index}`),
        framesWithPose: 500, // > framesTotal
      }));
    }
    if (op.outcome !== 'valid') {
      return scheduler.holdRejection(`pose#${op.index}`, errorFor(op));
    }
    return scheduler.hold(`pose#${op.index}`, () =>
      poseExtractionPayload(`${seed}-${op.index}`),
    );
  };

  const importedClip = importedClipPayload(
    `file:///stress/${seed}/imported-source.mov`,
  ) as unknown as Extract<CapturedClip, { captureMode: 'imported_video' }>;

  const issue = (op: Op): Promise<void> => {
    current = op;
    let promise: Promise<unknown>;
    switch (op.kind) {
      case 'capture':
        promise = captureStrokeVideo();
        break;
      case 'import':
        promise = importStrokeVideo();
        break;
      case 'startSession':
        promise = startSessionCapture();
        break;
      case 'stopSession':
        promise = stopSessionCapture(op.sessionId);
        break;
      case 'extractClip':
        promise = extractSessionEventClip(op.sessionId, op.bounds);
        break;
      case 'extractPose':
        promise = extractImportedPoseSequence(importedClip, op.poseSeed);
        break;
      case 'setStrategy':
        promise = setCaptureCompletionStrategy(op.strategy);
        break;
      case 'cancel':
        cancelCameraOperation();
        promise = Promise.resolve(undefined);
        break;
      case 'readArtifact':
        promise = readCaptureArtifact(op.uri);
        break;
    }
    current = null;
    return promise.then(
      value => {
        op.settled = 'fulfilled';
        op.result = value;
      },
      error => {
        op.settled = 'rejected';
        op.error = error;
      },
    );
  };

  // Event subscribers (rotation/logout = detach mid-burst).
  const totalSteps = burst * 3;
  const subscribers: Subscriber[] = [];
  const subscriberCount = randomInt(random, 0, 4);
  for (let i = 0; i < subscriberCount; i += 1) {
    const subscribeAt = randomInt(random, 0, totalSteps - 1);
    subscribers.push({
      id: i,
      subscribeAt,
      unsubscribeAt: randomInt(random, subscribeAt, totalSteps + 1),
      doubleUnsubscribe: random() < 0.4,
      received: [],
      expected: [],
      unsubscribe: null,
    });
  }
  const emitted: string[] = [];
  const emit = (event: CameraEvent): void => {
    const tag = stableJson(event);
    emitted.push(tag);
    for (const subscriber of subscribers) {
      if (subscriber.unsubscribe !== null) subscriber.expected.push(tag);
    }
    for (const listener of [...emitterListeners]) listener(event);
  };

  const outstanding: Promise<void>[] = [];
  let nextOp = 0;
  stabilitySlo.reset();

  for (let step = 0; step < totalSteps || nextOp < ops.length; step += 1) {
    for (const subscriber of subscribers) {
      if (subscriber.subscribeAt === step && subscriber.unsubscribe === null) {
        subscriber.unsubscribe = subscribeToCameraEvents(event => {
          subscriber.received.push(stableJson(event));
        });
      }
    }
    const action = random();
    if (
      nextOp < ops.length &&
      (scheduler.pendingCount() === 0 || action < 0.55)
    ) {
      const op = ops[nextOp] as Op;
      nextOp += 1;
      outstanding.push(issue(op));
    } else if (action < 0.85) {
      await scheduler.step();
    } else {
      emit(cameraEvent(step, random));
    }
    for (const subscriber of subscribers) {
      if (
        subscriber.unsubscribeAt === step &&
        subscriber.unsubscribe !== null
      ) {
        subscriber.unsubscribe();
        if (subscriber.doubleUnsubscribe) subscriber.unsubscribe();
        subscriber.unsubscribe = null;
        subscriber.unsubscribeAt = -1;
      }
    }
  }
  await scheduler.drain();
  await Promise.all(outstanding);
  for (const subscriber of subscribers) {
    if (subscriber.unsubscribe !== null) {
      subscriber.unsubscribe();
      subscriber.unsubscribe = null;
    }
  }

  // ── Invariants ────────────────────────────────────────────────────────────
  const expectedCounters = zeroCounters();
  for (const op of ops) {
    switch (op.kind) {
      case 'capture':
        expectedCounters.capture += 1;
        break;
      case 'import':
        expectedCounters.importVideo += 1;
        break;
      case 'startSession':
        expectedCounters.startSessionCapture += 1;
        break;
      case 'stopSession':
        expectedCounters.stopSessionCapture += 1;
        break;
      case 'extractClip':
        expectedCounters.extractSessionEventClip += 1;
        break;
      case 'extractPose':
        if (op.poseSeedValid) expectedCounters.extractImportedPoseSequence += 1;
        break;
      case 'setStrategy':
        expectedCounters.setCompletionStrategy += 1;
        break;
      case 'cancel':
        expectedCounters.cancel += 1;
        break;
      case 'readArtifact':
        expectedCounters.readTextFile += 1;
        break;
    }
  }
  if (stableJson(counters) !== stableJson(expectedCounters)) {
    violations.push(
      `native call counts ${stableJson(counters)} != issued ${stableJson(expectedCounters)}`,
    );
  }

  for (const op of ops) {
    const at = `op#${op.index}(${op.kind}/${op.outcome}${op.mutation ? ':' + op.mutation : ''})`;
    if (op.settled === 'pending') {
      violations.push(`${at} never settled`);
      continue;
    }
    const isClipOp =
      op.kind === 'capture' ||
      op.kind === 'import' ||
      op.kind === 'extractClip';
    if (op.kind === 'cancel') {
      if (op.settled !== 'fulfilled') violations.push(`${at} cancel threw`);
      continue;
    }
    if (op.kind === 'extractPose' && !op.poseSeedValid) {
      if (
        op.settled !== 'rejected' ||
        !(op.error instanceof Error) ||
        !/normalized point/.test(op.error.message)
      ) {
        violations.push(`${at} out-of-range seed not rejected at boundary`);
      }
      continue;
    }
    if (op.outcome === 'valid') {
      if (op.settled !== 'fulfilled') {
        violations.push(
          `${at} valid outcome rejected: ${op.error instanceof Error ? op.error.message : String(op.error)}`,
        );
        continue;
      }
      if (isClipOp) {
        const clip = op.result as CapturedClip;
        if (clip.uri !== op.uri) {
          violations.push(`${at} cross-talk: got ${clip.uri}, want ${op.uri}`);
        }
      } else if (op.kind === 'startSession') {
        const receipt = op.result as { sessionCaptureId: string };
        if (receipt.sessionCaptureId !== op.sessionId) {
          violations.push(`${at} receipt mismatch ${receipt.sessionCaptureId}`);
        }
      } else if (op.kind === 'setStrategy') {
        if (op.result !== op.strategy) {
          violations.push(
            `${at} applied ${String(op.result)} != ${op.strategy}`,
          );
        }
      } else if (op.kind === 'readArtifact') {
        if (op.result !== `sidecar:${op.uri}`) {
          violations.push(`${at} artifact cross-talk ${String(op.result)}`);
        }
      } else if (op.kind === 'extractPose') {
        const extraction = op.result as { poseSequence: { uri: string } };
        if (
          extraction.poseSequence.uri !==
          `file:///private/var/mobile/pose-${seed}-${op.index}.json`
        ) {
          violations.push(
            `${at} pose cross-talk ${extraction.poseSequence.uri}`,
          );
        }
      }
    } else if (op.outcome === 'malformed') {
      // stop has no payload to validate — a malformed plan is a plain resolve.
      if (op.kind === 'stopSession') {
        if (op.settled !== 'fulfilled') violations.push(`${at} stop rejected`);
        continue;
      }
      if (op.kind === 'readArtifact') {
        if (op.settled !== 'fulfilled') violations.push(`${at} read rejected`);
        continue;
      }
      if (op.settled !== 'rejected') {
        violations.push(
          `${at} malformed payload ACCEPTED: ${stableJson(op.result)}`,
        );
      } else if (!(op.error instanceof Error)) {
        violations.push(`${at} rejected with non-Error`);
      } else if (
        !/invalid or incomplete|invalid session receipt|unknown completion strategy|invalid pose-extraction/i.test(
          op.error.message,
        )
      ) {
        violations.push(`${at} unexpected boundary error: ${op.error.message}`);
      }
    } else {
      // Native rejection must propagate as the SAME error (codes survive).
      if (op.settled !== 'rejected') {
        violations.push(`${at} native error swallowed → fulfilled`);
      } else if (op.error !== op.nativeErr) {
        violations.push(`${at} native error replaced/wrapped`);
      }
    }
  }

  // Verbatim forwarding of extraction requests (in issue order).
  const clipOps = ops.filter(o => o.kind === 'extractClip');
  clipOps.forEach((op, i) => {
    const forwarded = forwardedClipRequests[i];
    const want = { sessionCaptureId: op.sessionId, ...op.bounds };
    if (!forwarded || stableJson(forwarded) !== stableJson(want)) {
      violations.push(
        `extractClip#${op.index} request not verbatim: ${stableJson(forwarded)}`,
      );
    }
  });
  const poseOps = ops.filter(o => o.kind === 'extractPose' && o.poseSeedValid);
  poseOps.forEach((op, i) => {
    const forwarded = forwardedPoseRequests[i];
    const want = {
      uri: importedClip.uri,
      ...(op.poseSeed ? { seedX: op.poseSeed.x, seedY: op.poseSeed.y } : {}),
    };
    if (!forwarded || stableJson(forwarded) !== stableJson(want)) {
      violations.push(
        `extractPose#${op.index} request not verbatim: ${stableJson(forwarded)}`,
      );
    }
  });
  const stopOps = ops.filter(o => o.kind === 'stopSession');
  if (
    stableJson(forwardedStops) !== stableJson(stopOps.map(o => o.sessionId))
  ) {
    violations.push(
      `stop ids not forwarded verbatim: ${stableJson(forwardedStops)}`,
    );
  }
  const readOps = ops.filter(o => o.kind === 'readArtifact');
  if (stableJson(readUris) !== stableJson(readOps.map(o => o.uri))) {
    violations.push(`read uris not forwarded verbatim`);
  }

  // Last-writer-wins on the native strategy.
  const applied = lastAppliedStrategyOp as Op | null;
  if (applied !== null && nativeStrategy !== applied.strategy) {
    violations.push(`strategy lost update: native=${nativeStrategy}`);
  }

  // Stability telemetry: exactly one startup event per startSessionCapture.
  const startOps = ops.filter(o => o.kind === 'startSession');
  const stabilityEvents = stabilitySlo.events();
  const startupEvents = stabilityEvents.filter(
    e =>
      e.kind === 'camera_startup_failed' ||
      e.kind === 'camera_startup_succeeded',
  );
  if (startupEvents.length !== startOps.length) {
    violations.push(
      `stability events ${startupEvents.length} != startSessionCapture calls ${startOps.length}`,
    );
  }
  const wantReasons = startOps
    .map(o =>
      o.outcome === 'valid'
        ? 'camera_startup_succeeded'
        : o.outcome === 'malformed'
          ? 'invalid_session_receipt'
          : 'native_session_start_error',
    )
    .sort();
  const gotReasons = startupEvents
    .map(e =>
      e.kind === 'camera_startup_failed'
        ? e.reason
        : 'camera_startup_succeeded',
    )
    .sort();
  if (stableJson(wantReasons) !== stableJson(gotReasons)) {
    violations.push(
      `stability reasons ${stableJson(gotReasons)} != ${stableJson(wantReasons)}`,
    );
  }

  // Event fan-out: exactly the events emitted while subscribed, in order.
  for (const subscriber of subscribers) {
    if (stableJson(subscriber.received) !== stableJson(subscriber.expected)) {
      violations.push(
        `subscriber#${subscriber.id} received ${subscriber.received.length} events, expected ${subscriber.expected.length}`,
      );
    }
  }
  if (emitterListeners.length !== 0) {
    violations.push(
      `${emitterListeners.length} listener(s) leaked after detach`,
    );
    emitterListeners.splice(0, emitterListeners.length);
  }

  return {
    detail: {
      burst,
      ops: ops.map(o => ({
        i: o.index,
        kind: o.kind,
        outcome: o.outcome,
        mutation: o.mutation,
        settled: o.settled,
      })),
      settleOrder: scheduler.settledOrder,
      subscribers: subscribers.map(s => ({
        id: s.id,
        subscribeAt: s.subscribeAt,
        doubleUnsubscribe: s.doubleUnsubscribe,
        received: s.received.length,
      })),
      eventsEmitted: emitted.length,
      nativeStrategy,
      counters,
    },
    violations,
  };
}

describe('mod-capture concurrency stress — native bridge wrappers', () => {
  it('bridge_burst: interleaved duplicate/cancel/two-actor wrapper calls hold every invariant', async () => {
    const table = await runCampaign(SUITE, 'bridge_burst', iteration);
    expect(table.iterations).toBeGreaterThan(0);
    expect(describeFailures(table)).toBe('');
    expect(table.failingSeeds).toEqual([]);
  });

  it('replays byte-identically from its seed (the table is reproducible)', async () => {
    const seed = 0x5eed_0001;
    const first = await iteration(seed, seededRandom(seed));
    const second = await iteration(seed, seededRandom(seed));
    expect(stableJson(first)).toBe(stableJson(second));
    expect(first.violations).toEqual([]);
  });
});
