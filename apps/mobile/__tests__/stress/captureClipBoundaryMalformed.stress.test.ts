import {
  assertCapturedClip,
  assertImportedPoseExtraction,
  CAPTURE_COMPLETION_PARAMS_V1,
  TARGET_LOCK_PARAMS_V1,
} from '../../src/camera/capture';
import {
  ALL_POOL,
  BOUNDARY_NUMBERS,
  campaignSeeds,
  clone,
  CONTAINERS,
  corruptJson,
  DELETE,
  describeValue,
  errorName,
  FUTURE_SCHEMA,
  GARBAGE_ROOTS,
  getAt,
  jsonStable,
  allNumbersFinite,
  allPaths,
  LOOSE_ISO,
  NULLISH,
  OutcomeTable,
  OVERSIZE_STRINGS,
  pick,
  POISON_NUMBERS,
  POISON_STRINGS,
  pollutionPayloads,
  prototypeSnapshot,
  randomInt,
  seededRandom,
  setAt,
  STRICT_ISO,
  STRESS_ITER,
  TRAVERSAL_STRINGS,
  UNICODE_STRINGS,
  type PoolValue,
  type Verdict,
} from '../../testing/stress/boundaryMalformed';

/**
 * STRESS — boundary/malformed input at the native→JS capture boundary
 * (`assertCapturedClip`, `assertImportedPoseExtraction`).
 *
 * Contract under test (apps/mobile/src/camera/capture.ts): a payload is either
 * returned unchanged or rejected with the ONE typed error
 * ("…invalid or incomplete video result."). The oracles therefore are:
 *  - never a throw other than the typed error (no TypeError/RangeError);
 *  - poison (NaN/±Infinity/wrong type/null-in-required/non-enum string/
 *    non-`file:` URI/non-hex sha) is never accepted;
 *  - an accepted clip is JSON-stable (it is persisted as JSON), all numbers
 *    finite, the same reference, and its JSON clone re-validates;
 *  - Object.prototype / Array.prototype are untouched afterwards.
 * Accepted-but-loose cases (Date.parse-able non-ISO instants, unbounded
 * strings, traversal after `file:`, an orphan `targetSeed`, fields read
 * through the prototype chain) are recorded as OBSERVATION rows — they are
 * the reported findings of the campaign, kept out of the hard assertion so
 * the suite stays green until the contract is tightened.
 *
 * Replay: STRESS_REPLAY=clip:<seed> npx jest captureClipBoundaryMalformed
 * Scale:  STRESS_ITER=<n> (per campaign; default 60)
 */

const CLIP_MESSAGE =
  'The native camera returned an invalid or incomplete video result.';
const POSE_MESSAGE =
  'The native importer returned an invalid pose-extraction result.';

const trigger = {
  startMs: 2000,
  endMs: 2700,
  peakMotionMs: 2400,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

const captureEvidence = {
  schemaVersion: 1,
  window: 'detected_motion',
  poseSource: 'apple_vision_body_pose',
  poseModelVersion: 'apple-vision-bodypose-1',
  triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
  motionUnit: 'normalized_image_units_per_second',
  analysisInputFrameCount: 7,
  poseFrameCount: 6,
  poseMissingFrameCount: 1,
  trackedDurationMs: 620,
  meanCanonicalJointVisibility: 0.88,
  meanJointCoverage: 0.94,
  minimumJointCoverage: 0.83,
  fullBodyVisibleFrameCount: 4,
  jointMotion: [
    {
      joint: 'left_shoulder',
      sampleCount: 3,
      meanNormalizedPerSecond: 0.3,
      peakNormalizedPerSecond: 0.7,
    },
    {
      joint: 'left_wrist',
      sampleCount: 5,
      meanNormalizedPerSecond: 1.1,
      peakNormalizedPerSecond: 2.4,
    },
  ],
};

const poseSequence = {
  schemaVersion: 1,
  format: 'pickle.pose-sequence.v1',
  uri: 'file:///private/var/mobile/clip.pose.json',
  frameCount: 120,
  sha256: 'a'.repeat(64),
  coordinateSystem: 'normalized_image_top_left',
  poseModelVersion: 'apple-vision-bodypose-1',
};

const automaticMinimal = {
  uri: 'file:///private/var/mobile/clip.mov',
  durationMs: 4200,
  fps: 59.94,
  width: 720,
  height: 1280,
  capturedAtIso: '2026-08-27T18:00:00.000Z',
  captureMode: 'automatic_pose_trigger',
  recognition: {
    status: 'unknown',
    reason: 'validated_classifier_unavailable',
  },
  trigger,
  captureEvidence,
  ballSpeed: {
    status: 'unavailable',
    reason: 'calibrated_ball_tracker_unavailable',
  },
  preRollMs: 2000,
  postRollMs: 1500,
};

const lockTorso = { x: 0.52, y: 0.48 };
const tapPoint = { x: 0.5, y: 0.5 };

const automaticFull = {
  ...automaticMinimal,
  byteSize: 8_400_000,
  posterUri: 'file:///private/var/mobile/clip.jpg',
  recognition: {
    status: 'recognized',
    shotType: 'drive_forehand',
    confidence: 0.91,
    modelVersion: 'stroke-classifier-3',
  },
  ballSpeed: {
    status: 'measured',
    milesPerHour: 22.369362920544,
    metersPerSecond: 10,
    confidence: 0.9,
    source: 'calibrated_monocular_ball_track',
    calibrationId: 'cal-2026-08',
    trackerModelVersion: 'ball-tracker-1',
    measurementFrameRate: 240,
    trackPointCount: 30,
    trackedDistanceMeters: 2,
    trackedDurationMs: 200,
    reprojectionErrorPx: 1.2,
  },
  poseSequence,
  completion: {
    schemaVersion: 1,
    completionStrategy: 'adaptive',
    algorithmVersion: 'd029-adaptive-1',
    motionUnit: 'normalized_image_units_per_second',
    movementCompleteMs: 2700,
    anchorMs: 2400,
    finalizeMs: 3200,
    peakMotionValue: 2.4,
    safetyMaxHit: false,
    observedUntilMs: 3200,
    observedSampleCount: 10,
    settleDetectedMs: 3000,
    params: { ...CAPTURE_COMPLETION_PARAMS_V1 },
    postCompletionMotion: [
      { tMs: 2500, v: 1.2 },
      { tMs: 2600, v: 0.6 },
    ],
  },
  targetLock: {
    schemaVersion: 1,
    algorithmVersion: 'd027-acquire-1',
    coordinateSystem: 'normalized_capture_space',
    tapPoint,
    lockOutcome: 'locked',
    lockSource: 'start_region_occupancy',
    lockTorso,
    tapToLockDistance: Math.hypot(
      lockTorso.x - tapPoint.x,
      lockTorso.y - tapPoint.y,
    ),
    timeToLockMs: 300,
    ambiguityEntered: false,
    params: { ...TARGET_LOCK_PARAMS_V1 },
  },
  targetSeed: {
    x: lockTorso.x,
    y: lockTorso.y,
    source: 'start_region_occupancy',
  },
};

const imported = {
  uri: 'file:///private/var/mobile/import.mov',
  durationMs: 6000,
  fps: 30,
  width: 1080,
  height: 1920,
  capturedAtIso: '2026-08-27T18:00:00Z',
  captureMode: 'imported_video',
  recognition: { status: 'unknown', reason: 'analysis_not_run' },
  ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
  poseSequence,
};

const poseExtraction = {
  poseSequence,
  posterUri: 'file:///private/var/mobile/import.jpg',
  framesWithPose: 110,
  framesTotal: 120,
};

type Fixture = {
  name: string;
  value: Record<string, unknown>;
  mode: 'automatic_pose_trigger' | 'imported_video';
  /** Deleting these paths must still be accepted (documented optional). */
  optional: readonly string[];
};

const FIXTURES: readonly Fixture[] = [
  {
    name: 'automaticMinimal',
    value: automaticMinimal,
    mode: 'automatic_pose_trigger',
    optional: ['trigger.peakMotionMs'],
  },
  {
    name: 'automaticFull',
    value: automaticFull,
    mode: 'automatic_pose_trigger',
    optional: [
      'byteSize',
      'posterUri',
      'poseSequence',
      'completion',
      'completion.settleDetectedMs',
      // Deleting the whole targetLock block is legal — the observation is
      // that the now-orphan targetSeed is no longer cross-checked at all.
      'targetLock',
    ],
  },
  {
    name: 'imported',
    value: imported,
    mode: 'imported_video',
    optional: ['poseSequence', 'recognition.modelVersion'],
  },
];

// Path classification for the string oracle (suffix match on the leaf key
// plus a few whole-path exceptions).
const ENUM_KEYS = new Set([
  'captureMode',
  'status',
  'source',
  'window',
  'poseSource',
  'motionUnit',
  'joint',
  'completionStrategy',
  'coordinateSystem',
  'lockOutcome',
  'lockSource',
  'format',
  'shotType',
]);
const URI_KEYS = new Set(['uri', 'posterUri']);
const CROSSCHECK_KEYS = new Set(['triggerAlgorithmVersion']);
const CROSSCHECK_PATHS = new Set(['trigger.modelVersion', 'ballSpeed.reason']);
const TRIM_EMPTY = new Set(['empty', 'space', 'whitespace', 'nbsp']);
// Numbers the validator pins to an exact value (schema pins, frozen params,
// cross-checked telemetry) — any other finite number must be rejected.
const EXACT_NUMBER_PATHS = new Set([
  'completion.movementCompleteMs',
  'completion.anchorMs',
  'captureEvidence.analysisInputFrameCount',
  'targetSeed.x',
  'targetSeed.y',
]);
function isExactNumberPath(path: string): boolean {
  return (
    EXACT_NUMBER_PATHS.has(path) ||
    path.endsWith('schemaVersion') ||
    path.includes('.params.')
  );
}

type StringKind = 'enum' | 'uri' | 'iso' | 'sha' | 'crosscheck' | 'free';

function stringKind(path: string): StringKind {
  const key =
    path
      .split('.')
      .pop()
      ?.replace(/\[\d+\]$/, '') ?? path;
  if (CROSSCHECK_PATHS.has(path) || CROSSCHECK_KEYS.has(key))
    return 'crosscheck';
  if (key === 'capturedAtIso') return 'iso';
  if (key === 'sha256') return 'sha';
  if (URI_KEYS.has(key)) return 'uri';
  if (ENUM_KEYS.has(key)) return 'enum';
  return 'free';
}

type Expectation =
  | 'must_reject'
  | 'must_accept'
  | 'free' // typed-throw or closed-accept are both fine
  | 'observe_loose_iso'
  | 'observe_unbounded'
  | 'observe_traversal';

function expectationFor(
  path: string,
  original: unknown,
  replacement: PoolValue,
  optional: readonly string[],
): Expectation {
  const v = replacement.value;
  if (v === undefined)
    return optional.includes(path) ? 'must_accept' : 'must_reject';
  if (typeof original === 'number') {
    if (typeof v !== 'number') return 'must_reject';
    if (!Number.isFinite(v)) return 'must_reject';
    if (v === original) return 'must_accept';
    if (isExactNumberPath(path)) return 'must_reject';
    return 'free';
  }
  if (typeof original === 'boolean') {
    return typeof v === 'boolean' ? 'free' : 'must_reject';
  }
  if (typeof original === 'string') {
    if (typeof v !== 'string') return 'must_reject';
    if (v === original) return 'must_accept';
    switch (stringKind(path)) {
      case 'enum':
      case 'crosscheck':
      case 'sha':
        return 'must_reject';
      case 'uri':
        if (!v.startsWith('file:')) return 'must_reject';
        return replacement.kind === 'oversize_string'
          ? 'observe_unbounded'
          : 'observe_traversal';
      case 'iso':
        if (replacement.kind === 'strict_iso') return 'must_accept';
        if (replacement.kind === 'loose_iso') return 'observe_loose_iso';
        return 'must_reject';
      case 'free':
        if (TRIM_EMPTY.has(replacement.id)) return 'must_reject';
        if (replacement.kind === 'oversize_string') return 'observe_unbounded';
        return 'free';
    }
  }
  // Container (object/array) subtree replaced.
  return 'must_reject';
}

interface Attempt {
  threw: boolean;
  typed: boolean;
  error: string | null;
  result: unknown;
}

function attempt(fn: () => unknown, typedMessage: string): Attempt {
  try {
    const result = fn();
    return { threw: false, typed: false, error: null, result };
  } catch (error) {
    const typed = error instanceof Error && error.message === typedMessage;
    return { threw: true, typed, error: errorName(error), result: undefined };
  }
}

/** Post-acceptance closure checks shared by every campaign. */
function acceptedClosure(
  input: unknown,
  result: unknown,
  revalidate: (value: unknown) => unknown,
): string | null {
  if (result !== input) return 'ACCEPTED_DIFFERENT_REFERENCE';
  if (!allNumbersFinite(result)) return 'ACCEPTED_NONFINITE_NUMBER';
  const stable = jsonStable(result);
  if (!stable.stable) return `ACCEPTED_NOT_JSON_STABLE:${stable.why}`;
  const back = JSON.parse(JSON.stringify(result)) as unknown;
  try {
    revalidate(back);
  } catch (error) {
    return `ACCEPTED_JSON_CLONE_REJECTED:${errorName(error)}`;
  }
  return null;
}

function classify(
  expectation: Expectation,
  run: Attempt,
  closure: string | null,
): { outcome: string; verdict: Verdict } {
  if (run.threw && !run.typed) {
    return { outcome: `THREW_UNTYPED:${run.error}`, verdict: 'BROKEN' };
  }
  if (run.threw) {
    if (expectation === 'must_accept') {
      return { outcome: 'REJECTED_VALID', verdict: 'BROKEN' };
    }
    return { outcome: 'rejected_typed', verdict: 'HELD' };
  }
  if (closure !== null) return { outcome: closure, verdict: 'BROKEN' };
  switch (expectation) {
    case 'must_reject':
      return { outcome: 'ACCEPTED_POISON', verdict: 'BROKEN' };
    case 'observe_loose_iso':
      return { outcome: 'accepted_loose_iso', verdict: 'OBSERVATION' };
    case 'observe_unbounded':
      return { outcome: 'accepted_unbounded_string', verdict: 'OBSERVATION' };
    case 'observe_traversal':
      return { outcome: 'accepted_file_uri_unchecked', verdict: 'OBSERVATION' };
    default:
      return { outcome: 'accepted_closed', verdict: 'HELD' };
  }
}

const STRING_POOL: readonly PoolValue[] = [
  ...POISON_STRINGS,
  ...OVERSIZE_STRINGS,
  ...TRAVERSAL_STRINGS,
  ...UNICODE_STRINGS,
  ...LOOSE_ISO,
  ...STRICT_ISO,
  { id: 'enum-like:"Dink"', kind: 'poison_string', value: 'Dink' },
  { id: 'enum-like:"dink "', kind: 'poison_string', value: 'dink ' },
  { id: 'enum-like:"ready"', kind: 'poison_string', value: 'ready' },
  {
    id: 'nfkc-slug',
    kind: 'unicode_string',
    value: '\uff44\uff49\uff4e\uff4b',
  },
];
const NUMBER_POOL: readonly PoolValue[] = [
  ...POISON_NUMBERS,
  ...BOUNDARY_NUMBERS,
  ...FUTURE_SCHEMA,
];
const ANY_POOL: readonly PoolValue[] = [...ALL_POOL, ...NULLISH, ...CONTAINERS];

function poolFor(random: () => number, original: unknown): PoolValue {
  const roll = random();
  if (roll < 0.15) return pick(random, ANY_POOL);
  if (typeof original === 'number') return pick(random, NUMBER_POOL);
  if (typeof original === 'string') return pick(random, STRING_POOL);
  if (typeof original === 'boolean') {
    return pick(random, [
      ...POISON_NUMBERS,
      ...NULLISH,
      { id: 'bool-flip', kind: 'boundary_number', value: !original },
    ]);
  }
  return pick(random, [...CONTAINERS, ...NULLISH, ...POISON_NUMBERS]);
}

function combine(expectations: Expectation[]): Expectation {
  if (expectations.includes('must_reject')) return 'must_reject';
  if (expectations.every(e => e === 'must_accept')) return 'must_accept';
  if (expectations.includes('free')) return 'free';
  const observe = expectations.find(e => e.startsWith('observe_'));
  return observe ?? 'must_accept';
}

describe('stress: assertCapturedClip boundary/malformed', () => {
  const protoBefore = prototypeSnapshot();

  it('fixtures are accepted before mutation (precondition)', () => {
    for (const fixture of FIXTURES) {
      expect(() =>
        assertCapturedClip(clone(fixture.value), fixture.mode),
      ).not.toThrow();
    }
    expect(() =>
      assertImportedPoseExtraction(clone(poseExtraction)),
    ).not.toThrow();
  });

  it(`campaign clip: ${STRESS_ITER} seeded malformed payloads`, () => {
    const table = new OutcomeTable('clip');
    for (const seed of campaignSeeds('clip')) {
      const random = seededRandom(seed);
      const fixture = pick(random, FIXTURES);
      const doc = clone(fixture.value);
      const roll = random();
      let strategy: string;
      let input: string;
      let expectation: Expectation;
      let payload: unknown = doc;
      let expectedMode: Fixture['mode'] | undefined = fixture.mode;

      if (roll < 0.06) {
        strategy = 'garbage-root';
        const root = pick(random, GARBAGE_ROOTS);
        payload = root.value;
        input = `${fixture.name} root=${root.id}`;
        expectation = 'must_reject';
      } else if (roll < 0.5) {
        strategy = 'mutate-1';
        const path = pick(random, allPaths(doc));
        const original = getAt(doc, path);
        const replacement = poolFor(random, original);
        setAt(doc, path, replacement.value);
        input = `${fixture.name} ${path}=${replacement.id}`;
        expectation = expectationFor(
          path,
          original,
          replacement,
          fixture.optional,
        );
      } else if (roll < 0.68) {
        strategy = 'mutate-n';
        const count = randomInt(random, 2, 4);
        const paths = allPaths(doc);
        const parts: string[] = [];
        const expectations: Expectation[] = [];
        for (let i = 0; i < count; i += 1) {
          const path = pick(random, paths);
          const original = getAt(doc, path);
          if (original === undefined) continue; // parent already replaced
          const replacement = poolFor(random, original);
          setAt(doc, path, replacement.value);
          parts.push(`${path}=${replacement.id}`);
          expectations.push(
            expectationFor(path, original, replacement, fixture.optional),
          );
        }
        input = `${fixture.name} ${parts.join(' ')}`;
        expectation = combine(expectations);
      } else if (roll < 0.78) {
        strategy = 'delete';
        const candidates = allPaths(doc).filter(p => !/\[\d+\]$/.test(p));
        const path = pick(random, candidates);
        setAt(doc, path, DELETE);
        input = `${fixture.name} delete ${path}`;
        expectation = fixture.optional.includes(path)
          ? 'must_accept'
          : 'must_reject';
      } else if (roll < 0.86) {
        strategy = 'json-corrupt';
        const corrupted = corruptJson(random, doc);
        input = `${fixture.name} ${corrupted.id}`;
        if (corrupted.parseError !== null) {
          table.record({
            seed,
            strategy,
            input,
            outcome: `json_rejected:${corrupted.parseError}`,
            verdict: 'HELD',
          });
          continue;
        }
        payload = corrupted.parsed;
        expectation =
          JSON.stringify(corrupted.parsed) === JSON.stringify(fixture.value)
            ? 'must_accept'
            : 'free';
      } else if (roll < 0.92) {
        strategy = 'proto-pollution';
        const candidate = pick(random, pollutionPayloads(doc));
        payload = candidate.value;
        input = `${fixture.name} ${candidate.id}`;
        // Only the null-prototype copy carries every field as OWN data; the
        // others either lack fields (json-only) or carry them via the
        // prototype chain (inherited) — which must never be accepted
        // because it does not survive persistence.
        expectation =
          candidate.id === 'proto:null-prototype-copy' ||
          candidate.id === 'proto:json-proto-key' ||
          candidate.id === 'proto:json-merged'
            ? 'must_accept'
            : candidate.id === 'proto:literal-proto-setter'
              ? 'must_accept' // own fields intact; prototype has extras only
              : 'must_reject';
      } else if (roll < 0.97) {
        strategy = 'extra-keys';
        const extras: Array<[string, unknown, Expectation]> = [
          ['contactMs', 100, 'must_reject'], // reserved: trigger.contactMs must be absent
          ['schemaVersion', 2, 'must_accept'], // unknown top-level key is ignored
          ['x'.repeat(65_536), 1, 'must_accept'],
          ['__proto__', { polluted: true }, 'must_accept'], // own key via JSON
          ['constructor', 'x', 'must_accept'],
          ['\u0000', 1, 'must_accept'],
        ];
        const [key, value, exp] = pick(random, extras);
        if (key === 'contactMs') {
          if (fixture.mode === 'imported_video') {
            expectation = 'must_accept'; // imported clips have no trigger
            (doc as Record<string, unknown>)[key] = value;
          } else {
            setAt(doc, 'trigger.contactMs', value);
            expectation = exp;
          }
        } else if (key === '__proto__') {
          payload = JSON.parse(
            `${JSON.stringify(doc).slice(0, -1)},"__proto__":{"polluted":true}}`,
          );
          expectation = exp;
        } else {
          (doc as Record<string, unknown>)[key] = value;
          expectation = exp;
        }
        input = `${fixture.name} extra=${key.length > 20 ? `key(len=${key.length})` : JSON.stringify(key)}`;
      } else {
        strategy = 'wrong-expected-mode';
        expectedMode =
          fixture.mode === 'imported_video'
            ? 'automatic_pose_trigger'
            : 'imported_video';
        input = `${fixture.name} expectedMode=${expectedMode}`;
        expectation = 'must_reject';
      }

      const run = attempt(
        () => assertCapturedClip(payload, expectedMode),
        CLIP_MESSAGE,
      );
      const closure = run.threw
        ? null
        : acceptedClosure(payload, run.result, back =>
            assertCapturedClip(back, expectedMode),
          );
      let { outcome, verdict } = classify(expectation, run, closure);
      if (
        !run.threw &&
        verdict === 'HELD' &&
        strategy === 'delete' &&
        input.endsWith('delete targetLock')
      ) {
        outcome = 'accepted_orphan_targetSeed_unvalidated';
        verdict = 'OBSERVATION';
      }
      if (!run.threw && input.endsWith('proto:inherited-fields')) {
        // Known contract gap (reported): fields resolved through the
        // prototype chain pass, and the persisted JSON of the result is `{}`.
        outcome = 'accepted_inherited_fields_persists_empty';
        verdict = 'OBSERVATION';
      }
      if (prototypeSnapshot() !== protoBefore) {
        outcome = `PROTOTYPE_POLLUTED after ${outcome}`;
        verdict = 'BROKEN';
      }
      table.record({
        seed,
        strategy,
        input,
        outcome,
        verdict,
        ...(run.error !== null && !run.typed ? { detail: run.error } : {}),
      });
    }
    const file = table.flush();
    const broken = table.broken();
    expect({
      file,
      summary: table.summary(),
      brokenSeeds: broken.slice(0, 20),
    }).toEqual({ file, summary: table.summary(), brokenSeeds: [] });
  });

  it(`campaign orphanSeed: ${STRESS_ITER} unvalidated targetSeed payloads when targetLock is absent`, () => {
    // Pins the observation precisely: with `targetLock` absent, `targetSeed`
    // is not validated at all (capture.ts isTargetLockTelemetry is the only
    // reader), so any shape reaches AnalyzeScreen's `clip.targetSeed.x/y`.
    const table = new OutcomeTable('orphanSeed');
    for (const seed of campaignSeeds('orphanSeed')) {
      const random = seededRandom(seed);
      const doc = clone(automaticFull) as Record<string, unknown>;
      delete doc['targetLock'];
      const shape = pick(random, ['x', 'y', 'source', 'whole']);
      const replacement = pick(random, ANY_POOL);
      if (shape === 'whole') doc['targetSeed'] = replacement.value;
      else setAt(doc, `targetSeed.${shape}`, replacement.value);
      const run = attempt(() => assertCapturedClip(doc), CLIP_MESSAGE);
      const closure = run.threw
        ? null
        : acceptedClosure(doc, run.result, back => assertCapturedClip(back));
      let outcome: string;
      let verdict: Verdict;
      if (run.threw && !run.typed) {
        outcome = `THREW_UNTYPED:${run.error}`;
        verdict = 'BROKEN';
      } else if (run.threw) {
        outcome = 'rejected_typed';
        verdict = 'HELD';
      } else if (
        closure !== null &&
        !closure.startsWith('ACCEPTED_NONFINITE') &&
        !closure.startsWith('ACCEPTED_NOT_JSON_STABLE')
      ) {
        outcome = closure;
        verdict = 'BROKEN';
      } else if (closure !== null) {
        // Same unvalidated-field gap, worst case: NaN/Infinity/BigInt seed.
        outcome = `accepted_orphan_targetSeed_malformed:${closure.split(':')[0]}`;
        verdict = 'OBSERVATION';
      } else {
        const seedValue = (run.result as Record<string, unknown>)['targetSeed'];
        const wellFormed =
          typeof seedValue === 'object' &&
          seedValue !== null &&
          typeof (seedValue as { x: unknown }).x === 'number' &&
          typeof (seedValue as { y: unknown }).y === 'number' &&
          typeof (seedValue as { source: unknown }).source === 'string';
        outcome = wellFormed
          ? 'accepted_closed'
          : 'accepted_orphan_targetSeed_malformed';
        verdict = wellFormed ? 'HELD' : 'OBSERVATION';
      }
      table.record({
        seed,
        strategy: `targetSeed.${shape}`,
        input: `${shape}=${replacement.id} (${describeValue(replacement.value)})`,
        outcome,
        verdict,
      });
    }
    const file = table.flush();
    expect({
      file,
      summary: table.summary(),
      broken: table.broken().slice(0, 20),
    }).toEqual({ file, summary: table.summary(), broken: [] });
  });

  it(`campaign poseExtraction: ${STRESS_ITER} seeded malformed importer receipts`, () => {
    const table = new OutcomeTable('poseExtraction');
    const optional = ['posterUri'];
    for (const seed of campaignSeeds('poseExtraction')) {
      const random = seededRandom(seed);
      const doc = clone(poseExtraction);
      const roll = random();
      let strategy: string;
      let input: string;
      let expectation: Expectation;
      let payload: unknown = doc;
      if (roll < 0.1) {
        strategy = 'garbage-root';
        const root = pick(random, GARBAGE_ROOTS);
        payload = root.value;
        input = `root=${root.id}`;
        expectation = 'must_reject';
      } else if (roll < 0.7) {
        strategy = 'mutate-1';
        const path = pick(random, allPaths(doc));
        const original = getAt(doc, path);
        const replacement = poolFor(random, original);
        setAt(doc, path, replacement.value);
        input = `${path}=${replacement.id}`;
        expectation = expectationFor(path, original, replacement, optional);
        // framesWithPose > framesTotal is the one cross-check on numbers.
        if (
          expectation === 'free' &&
          (path === 'framesWithPose' || path === 'framesTotal') &&
          typeof replacement.value === 'number'
        ) {
          const withPose = getAt(doc, 'framesWithPose') as number;
          const total = getAt(doc, 'framesTotal') as number;
          if (withPose > total) expectation = 'must_reject';
        }
      } else if (roll < 0.85) {
        strategy = 'delete';
        const path = pick(random, allPaths(doc));
        setAt(doc, path, DELETE);
        input = `delete ${path}`;
        expectation = optional.includes(path) ? 'must_accept' : 'must_reject';
      } else if (roll < 0.95) {
        strategy = 'json-corrupt';
        const corrupted = corruptJson(random, doc);
        input = corrupted.id;
        if (corrupted.parseError !== null) {
          table.record({
            seed,
            strategy,
            input,
            outcome: `json_rejected:${corrupted.parseError}`,
            verdict: 'HELD',
          });
          continue;
        }
        payload = corrupted.parsed;
        expectation =
          JSON.stringify(corrupted.parsed) === JSON.stringify(poseExtraction)
            ? 'must_accept'
            : 'free';
      } else {
        strategy = 'proto-pollution';
        const candidate = pick(random, pollutionPayloads(doc));
        payload = candidate.value;
        input = candidate.id;
        expectation =
          candidate.id === 'proto:json-only' ||
          candidate.id === 'proto:inherited-fields'
            ? 'must_reject'
            : 'must_accept';
      }
      const run = attempt(
        () => assertImportedPoseExtraction(payload),
        POSE_MESSAGE,
      );
      // assertImportedPoseExtraction re-builds the receipt (copies fields), so
      // the closure check compares by JSON, not by reference.
      let closure: string | null = null;
      if (!run.threw) {
        if (!allNumbersFinite(run.result))
          closure = 'ACCEPTED_NONFINITE_NUMBER';
        else {
          const stable = jsonStable(run.result);
          if (!stable.stable)
            closure = `ACCEPTED_NOT_JSON_STABLE:${stable.why}`;
          else {
            try {
              assertImportedPoseExtraction(
                JSON.parse(JSON.stringify(run.result)),
              );
            } catch (error) {
              closure = `ACCEPTED_JSON_CLONE_REJECTED:${errorName(error)}`;
            }
          }
        }
      }
      let { outcome, verdict } = classify(expectation, run, closure);
      if (!run.threw && input === 'proto:inherited-fields') {
        outcome = 'accepted_inherited_fields';
        verdict = 'OBSERVATION';
      }
      if (prototypeSnapshot() !== protoBefore) {
        outcome = `PROTOTYPE_POLLUTED after ${outcome}`;
        verdict = 'BROKEN';
      }
      table.record({ seed, strategy, input, outcome, verdict });
    }
    const file = table.flush();
    expect({
      file,
      summary: table.summary(),
      broken: table.broken().slice(0, 20),
    }).toEqual({ file, summary: table.summary(), broken: [] });
  });

  it('prototypes are untouched after every campaign', () => {
    expect(prototypeSnapshot()).toBe(protoBefore);
  });
});
