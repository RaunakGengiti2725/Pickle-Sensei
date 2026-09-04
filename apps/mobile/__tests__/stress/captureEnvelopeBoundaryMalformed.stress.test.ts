import { ENVELOPE_DIMENSIONS } from '@pickle/shared-types';
import type { CaptureQualitySignalsV1 } from '../../src/camera/capture';
import {
  attemptCaptureEnvelope,
  captureGuidanceLines,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  qualityBlockedMessage,
  readyGate,
  sessionEventClipEnvelope,
  type ReadinessSnapshot,
} from '../../src/camera/captureEnvelope';
import {
  ALL_POOL,
  BOUNDARY_NUMBERS,
  campaignSeeds,
  clone,
  CONTAINERS,
  DELETE,
  describeValue,
  errorName,
  FUTURE_SCHEMA,
  GARBAGE_ROOTS,
  getAt,
  jsonStable,
  allPaths,
  NULLISH,
  OutcomeTable,
  pick,
  POISON_NUMBERS,
  pollutionPayloads,
  prototypeSnapshot,
  randomInt,
  seededRandom,
  setAt,
  STRESS_ITER,
  type PoolValue,
  type Verdict,
} from '../../testing/stress/boundaryMalformed';

/**
 * STRESS — boundary/malformed input into the capture-envelope evaluators
 * (`liveCaptureEnvelope`, `attemptCaptureEnvelope`, `sessionEventClipEnvelope`)
 * plus the derived gate/guidance helpers and the per-attempt evidence buffer.
 *
 * These are PURE evaluators with no throwing contract: any input reachable
 * through the typed surface (readiness snapshot, native quality signals, a
 * validated clip) must yield either `null` (nothing measured) or a canonical
 * `EnvelopeVerdict`. Hard oracles (BROKEN on violation):
 *  - never a throw (TypeError/RangeError) for object-shaped or primitive input;
 *  - live: `null` iff BOTH readiness and quality are nullish;
 *  - attempt/session: never `null`;
 *  - verdict shape: exactly ENVELOPE_DIMENSIONS in canonical order, statuses
 *    and `overall` from the enum, `notMeasured` == dimensions with status
 *    NOT_MEASURED, `overall` == worst measured status;
 *  - readyGate blocks iff some dimension is UNSUPPORTED, guidance lines exist
 *    exactly for DEGRADED/UNSUPPORTED dimensions, blocked message starts
 *    with the reason;
 *  - a finite numeric measurement given for a field is reported verbatim;
 *  - Object.prototype / Array.prototype untouched afterwards.
 * Loose cases recorded as OBSERVATION rows (the campaign's reported gaps):
 *  - a non-number measurement (string/boolean/undefined/object) reaching a
 *    dimension is classified (usually SUPPORTED) instead of NOT_MEASURED and
 *    the non-number leaks into `measured`;
 *  - ±Infinity leaks into `measured` (persisted JSON turns it into null while
 *    the status says UNSUPPORTED);
 *  - a Symbol/BigInt/null-prototype measurement makes the shared
 *    `classifyDimension` throw TypeError from `<`/`Math.min` coercion. Those
 *    three types cannot cross the React Native bridge (JSON-shaped), so the
 *    throw is recorded, not asserted; any OTHER throw is BROKEN.
 * Nullish `clip` roots are excluded from attempt/session: the parameter type
 * is non-nullable and the only callers pass an `assertCapturedClip` result.
 *
 * Replay: STRESS_REPLAY=envelopeLive:<seed> npx jest captureEnvelopeBoundaryMalformed
 * Scale:  STRESS_ITER=<n> (per campaign; default 60)
 */

const STATUSES = new Set([
  'SUPPORTED',
  'DEGRADED',
  'UNSUPPORTED',
  'NOT_MEASURED',
]);
const OVERALL = new Set(['SUPPORTED', 'DEGRADED', 'UNSUPPORTED']);
const OVERALL_COVERAGE = new Set([
  'SUPPORTED',
  'SUPPORTED_UNMEASURED',
  'DEGRADED',
  'UNSUPPORTED',
]);
const SEVERITY: Record<string, number> = {
  SUPPORTED: 0,
  DEGRADED: 1,
  UNSUPPORTED: 2,
};

const validReadiness: ReadinessSnapshot = {
  state: 'ready',
  jointCoverage: 0.95,
};
const validQuality: CaptureQualitySignalsV1 = {
  schemaVersion: 1,
  frameWidthPx: 1080,
  frameHeightPx: 1920,
  avgFrameRateFps: 60,
  brightnessMeanLuma: 120,
  laplacianVarianceMedian: 250,
  meanAbsFrameDiff: 2,
  sampledFrameCount: 12,
};
const validClip = { width: 1080, height: 1920, fps: 60, durationMs: 4200 };

const READINESS_STATES = [
  'ready',
  'no_person',
  'too_far',
  'partial',
  'READY',
  'ready ',
  '',
  '\u0000',
  'x'.repeat(65_536),
];

const NUMBER_POOL: readonly PoolValue[] = [
  ...POISON_NUMBERS,
  ...BOUNDARY_NUMBERS,
  ...FUTURE_SCHEMA,
  ...NULLISH,
];
const ANY_POOL: readonly PoolValue[] = [...ALL_POOL, ...NULLISH, ...CONTAINERS];
const DELETE_VALUE: PoolValue = {
  id: 'DELETE',
  kind: 'nullish',
  value: DELETE,
};

interface Variant {
  id: string;
  value: unknown;
  /** path → replacement value for finite-number expectations. */
  numeric: Array<{ path: string; value: number }>;
  nonNumber: string[];
}

/** Mutates 1–3 paths of a plain fixture; records what went in where. */
function mutate(
  random: () => number,
  name: string,
  fixture: Record<string, unknown>,
): Variant {
  const doc = clone(fixture);
  const count = randomInt(random, 1, 3);
  const paths = allPaths(doc);
  const parts: string[] = [];
  const numeric: Variant['numeric'] = [];
  const nonNumber: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const path = pick(random, paths);
    const original = getAt(doc, path);
    if (original === undefined || parts.some(p => p.startsWith(`${path}=`)))
      continue;
    let replacement: PoolValue;
    if (path === 'state') {
      const state = pick(random, READINESS_STATES);
      replacement =
        random() < 0.7
          ? {
              id: `state:${describeValue(state)}`,
              kind: 'poison_string',
              value: state,
            }
          : pick(random, ANY_POOL);
    } else if (random() < 0.1) {
      replacement = DELETE_VALUE;
    } else if (typeof original === 'number') {
      replacement =
        random() < 0.8 ? pick(random, NUMBER_POOL) : pick(random, ANY_POOL);
    } else {
      replacement = pick(random, ANY_POOL);
    }
    setAt(doc, path, replacement.value);
    parts.push(`${path}=${replacement.id}`);
    if (
      typeof replacement.value === 'number' &&
      Number.isFinite(replacement.value)
    ) {
      numeric.push({ path, value: replacement.value });
    } else if (replacement.value !== null && replacement.value !== DELETE) {
      nonNumber.push(path);
    }
  }
  return { id: `${name}{${parts.join(' ')}}`, value: doc, numeric, nonNumber };
}

function rootVariant(
  random: () => number,
  name: string,
  allowNullish: boolean,
): Variant {
  const roots = allowNullish
    ? GARBAGE_ROOTS
    : GARBAGE_ROOTS.filter(r => r.value !== null && r.value !== undefined);
  const root = pick(random, roots);
  return {
    id: `${name}=root:${root.id}`,
    value: root.value,
    numeric: [],
    nonNumber: [],
  };
}

function protoVariant(
  random: () => number,
  name: string,
  fixture: Record<string, unknown>,
): Variant {
  const candidate = pick(random, pollutionPayloads(fixture));
  return {
    id: `${name}=${candidate.id}`,
    value: candidate.value,
    numeric: [],
    nonNumber: [],
  };
}

/** True when some value reachable one level deep cannot cross the RN bridge. */
function carriesNonBridgeable(variants: Variant[]): boolean {
  const isNonBridgeable = (value: unknown): boolean =>
    typeof value === 'symbol' ||
    typeof value === 'bigint' ||
    (typeof value === 'object' &&
      value !== null &&
      Object.getPrototypeOf(value) === null);
  return variants.some(variant => {
    const value = variant.value;
    if (isNonBridgeable(value)) return true;
    if (typeof value !== 'object' || value === null) return false;
    return Object.values(value as Record<string, unknown>).some(
      isNonBridgeable,
    );
  });
}

function classifyThrow(
  threw: string,
  variants: Variant[],
): { outcome: string; verdict: Verdict } {
  if (
    threw.startsWith('TypeError:Cannot convert') &&
    carriesNonBridgeable(variants)
  ) {
    return {
      outcome: `threw_nonbridgeable_type:${threw}`,
      verdict: 'OBSERVATION',
    };
  }
  return { outcome: `THREW:${threw}`, verdict: 'BROKEN' };
}

function nullVariant(name: string): Variant {
  return { id: `${name}=null`, value: null, numeric: [], nonNumber: [] };
}

function validVariant(name: string, fixture: unknown): Variant {
  return {
    id: `${name}=valid`,
    value: clone(fixture),
    numeric: [],
    nonNumber: [],
  };
}

function pickVariant(
  random: () => number,
  name: string,
  fixture: Record<string, unknown>,
  opts: { allowNull: boolean },
): Variant {
  const roll = random();
  if (opts.allowNull && roll < 0.15) return nullVariant(name);
  if (roll < 0.3) return validVariant(name, fixture);
  if (roll < 0.4) return rootVariant(random, name, opts.allowNull);
  if (roll < 0.48) return protoVariant(random, name, fixture);
  return mutate(random, name, fixture);
}

interface VerdictCheck {
  broken: string | null;
  observations: string[];
  dims: Array<{ dimension: string; status: string; measured: unknown }>;
}

/** Structural + consistency oracle over whatever the evaluator returned. */
function checkVerdict(verdict: unknown): VerdictCheck {
  const observations: string[] = [];
  if (typeof verdict !== 'object' || verdict === null) {
    return {
      broken: `VERDICT_NOT_OBJECT:${describeValue(verdict)}`,
      observations,
      dims: [],
    };
  }
  const v = verdict as Record<string, unknown>;
  if (!Array.isArray(v['dimensions'])) {
    return { broken: 'VERDICT_DIMENSIONS_NOT_ARRAY', observations, dims: [] };
  }
  const dims = v['dimensions'] as Array<Record<string, unknown>>;
  const names = dims.map(d => d['dimension']);
  if (JSON.stringify(names) !== JSON.stringify(ENVELOPE_DIMENSIONS)) {
    return {
      broken: `VERDICT_DIMENSION_ORDER:${names.join(',')}`,
      observations,
      dims: [],
    };
  }
  const notMeasured: string[] = [];
  let worst = 'SUPPORTED';
  const out: VerdictCheck['dims'] = [];
  for (const d of dims) {
    const status = d['status'];
    const measured = d['measured'];
    const dimension = String(d['dimension']);
    if (typeof status !== 'string' || !STATUSES.has(status)) {
      return {
        broken: `VERDICT_STATUS_ENUM:${dimension}=${String(status)}`,
        observations,
        dims: [],
      };
    }
    out.push({ dimension, status, measured });
    if (status === 'NOT_MEASURED') {
      notMeasured.push(dimension);
      if (measured !== null) {
        return {
          broken: `NOT_MEASURED_WITH_VALUE:${dimension}=${describeValue(measured)}`,
          observations,
          dims: out,
        };
      }
    } else {
      if (SEVERITY[status]! > SEVERITY[worst]!) worst = status;
      if (typeof measured !== 'number') {
        observations.push(
          `measured_not_number:${dimension}:${typeof measured}:${status}`,
        );
      } else if (!Number.isFinite(measured)) {
        observations.push(
          `measured_nonfinite:${dimension}:${measured}:${status}`,
        );
      }
    }
    if (typeof d['unit'] !== 'string' || typeof d['thresholdId'] !== 'string') {
      return {
        broken: `VERDICT_DIMENSION_META:${dimension}`,
        observations,
        dims: out,
      };
    }
  }
  if (typeof v['overall'] !== 'string' || !OVERALL.has(v['overall'])) {
    return {
      broken: `VERDICT_OVERALL_ENUM:${String(v['overall'])}`,
      observations,
      dims: out,
    };
  }
  if (v['overall'] !== worst) {
    return {
      broken: `VERDICT_OVERALL_MISMATCH:${v['overall']}!=${worst}`,
      observations,
      dims: out,
    };
  }
  if (
    typeof v['overallWithCoverage'] !== 'string' ||
    !OVERALL_COVERAGE.has(v['overallWithCoverage'])
  ) {
    return { broken: 'VERDICT_COVERAGE_ENUM', observations, dims: out };
  }
  const expectedCoverage =
    worst === 'SUPPORTED' && notMeasured.length > 0
      ? 'SUPPORTED_UNMEASURED'
      : worst;
  if (v['overallWithCoverage'] !== expectedCoverage) {
    return { broken: 'VERDICT_COVERAGE_MISMATCH', observations, dims: out };
  }
  if (JSON.stringify(v['notMeasured']) !== JSON.stringify(notMeasured)) {
    return { broken: 'VERDICT_NOT_MEASURED_LIST', observations, dims: out };
  }
  if (
    typeof v['thresholdsVersion'] !== 'string' ||
    typeof v['provisional'] !== 'boolean'
  ) {
    return { broken: 'VERDICT_VERSION_META', observations, dims: out };
  }

  // Derived helpers must agree with the verdict they were handed.
  const gate = readyGate(verdict as never);
  const unsupported = out
    .filter(d => d.status === 'UNSUPPORTED')
    .map(d => d.dimension);
  if (gate.blocked !== unsupported.length > 0) {
    return { broken: 'GATE_BLOCKED_MISMATCH', observations, dims: out };
  }
  if (JSON.stringify(gate.blockingDimensions) !== JSON.stringify(unsupported)) {
    return { broken: 'GATE_DIMENSIONS_MISMATCH', observations, dims: out };
  }
  const lines = captureGuidanceLines(verdict as never);
  const guided = out
    .filter(d => d.status === 'DEGRADED' || d.status === 'UNSUPPORTED')
    .map(d => d.dimension);
  if (JSON.stringify(lines.map(l => l.dimension)) !== JSON.stringify(guided)) {
    return { broken: 'GUIDANCE_DIMENSIONS_MISMATCH', observations, dims: out };
  }
  if (lines.some(l => typeof l.text !== 'string' || l.text.length === 0)) {
    return { broken: 'GUIDANCE_EMPTY_TEXT', observations, dims: out };
  }
  const message = qualityBlockedMessage('reason', verdict as never);
  if (!message.startsWith('reason')) {
    return { broken: 'BLOCKED_MESSAGE_DROPS_REASON', observations, dims: out };
  }
  if ((lines.length === 0) !== (message === 'reason')) {
    return {
      broken: 'BLOCKED_MESSAGE_LINES_MISMATCH',
      observations,
      dims: out,
    };
  }
  const stable = jsonStable(verdict);
  if (!stable.stable)
    observations.push(`verdict_not_json_stable:${stable.why}`);
  return { broken: null, observations, dims: out };
}

const MEASURED_BY_PATH: Record<string, string> = {
  frameWidthPx: 'resolution',
  frameHeightPx: 'resolution',
  avgFrameRateFps: 'frame_rate',
  brightnessMeanLuma: 'brightness',
  laplacianVarianceMedian: 'motion_blur',
  meanAbsFrameDiff: 'camera_motion',
  jointCoverage: 'player_visibility',
  width: 'resolution',
  height: 'resolution',
  fps: 'frame_rate',
  durationMs: 'clip_duration',
};

/** A finite number fed to a source field must be echoed by its dimension. */
function checkEcho(
  dims: VerdictCheck['dims'],
  variants: Variant[],
  overriddenBy: Set<string>,
): string | null {
  const byDim = new Map(dims.map(d => [d.dimension, d]));
  for (const variant of variants) {
    for (const { path, value } of variant.numeric) {
      const dimension = MEASURED_BY_PATH[path];
      if (!dimension || overriddenBy.has(path)) continue;
      if (dimension === 'resolution') continue; // min(width,height) — checked below
      if (path === 'jointCoverage') {
        const state = getAt(variant.value, 'state');
        if (state === 'no_person') continue; // observed zero-visibility read
      }
      const dim = byDim.get(dimension);
      if (!dim || dim.measured !== value) {
        return `ECHO_MISMATCH:${path}=${value}→${dimension}=${describeValue(dim?.measured)}`;
      }
    }
  }
  return null;
}

interface Run {
  threw: string | null;
  result: unknown;
}

function run(fn: () => unknown): Run {
  try {
    return { threw: null, result: fn() };
  } catch (error) {
    return { threw: errorName(error), result: undefined };
  }
}

function record(
  table: OutcomeTable,
  seed: number,
  strategy: string,
  input: string,
  outcome: string,
  verdict: Verdict,
  detail?: string,
): void {
  table.record({ seed, strategy, input, outcome, verdict, detail });
}

function classifyVerdict(
  check: VerdictCheck,
  echo: string | null,
): { outcome: string; verdict: Verdict; detail?: string } {
  if (check.broken) return { outcome: check.broken, verdict: 'BROKEN' };
  if (echo) return { outcome: echo, verdict: 'BROKEN' };
  if (check.observations.length > 0) {
    const first = check.observations[0]!;
    return {
      outcome: first.split(':').slice(0, 2).join(':'),
      verdict: 'OBSERVATION',
      detail: check.observations.join(' | '),
    };
  }
  return { outcome: 'verdict_canonical', verdict: 'HELD' };
}

describe('stress: capture envelope boundary/malformed', () => {
  const protoBefore = prototypeSnapshot();

  it('valid fixtures evaluate canonically (precondition)', () => {
    const live = liveCaptureEnvelope(validReadiness, validQuality);
    expect(live).not.toBeNull();
    expect(checkVerdict(live).broken).toBeNull();
    expect(checkVerdict(live).observations).toEqual([]);
    expect(
      checkVerdict(
        attemptCaptureEnvelope(validClip, validQuality, validReadiness),
      ).broken,
    ).toBeNull();
    expect(checkVerdict(sessionEventClipEnvelope(validClip)).broken).toBeNull();
    expect(liveCaptureEnvelope(null, null)).toBeNull();
  });

  it(`campaign envelopeLive: ${STRESS_ITER} seeded readiness/quality pairs through the evidence buffer`, () => {
    const table = new OutcomeTable('envelopeLive');
    for (const seed of campaignSeeds('envelopeLive')) {
      const random = seededRandom(seed);
      const readiness = pickVariant(
        random,
        'readiness',
        validReadiness as never,
        {
          allowNull: true,
        },
      );
      const quality = pickVariant(random, 'quality', validQuality as never, {
        allowNull: true,
      });
      const viaBuffer = random() < 0.5;
      const strategy = viaBuffer ? 'buffer' : 'direct';
      const input = `${readiness.id} ${quality.id}`;

      let r: unknown = readiness.value;
      let q: unknown = quality.value;
      if (viaBuffer) {
        const buffer = createAttemptEvidenceBuffer();
        const bufRun = run(() => {
          buffer.noteReadiness({ state: 'stale', jointCoverage: 0.1 });
          buffer.noteQuality(validQuality);
          buffer.beginAttempt();
          if (buffer.readiness !== null || buffer.quality !== null) {
            throw new Error('BUFFER_NOT_CLEARED');
          }
          if (readiness.value !== null)
            buffer.noteReadiness(readiness.value as never);
          if (quality.value !== null)
            buffer.noteQuality(quality.value as never);
          if (
            (readiness.value !== null &&
              !Object.is(buffer.readiness, readiness.value)) ||
            (quality.value !== null &&
              !Object.is(buffer.quality, quality.value))
          ) {
            throw new Error('BUFFER_LOST_EVIDENCE');
          }
          return [buffer.readiness, buffer.quality];
        });
        if (bufRun.threw) {
          record(
            table,
            seed,
            strategy,
            input,
            `THREW_BUFFER:${bufRun.threw}`,
            'BROKEN',
          );
          continue;
        }
        [r, q] = bufRun.result as [unknown, unknown];
      }

      const outcome = run(() => liveCaptureEnvelope(r as never, q as never));
      if (outcome.threw) {
        const c = classifyThrow(outcome.threw, [readiness, quality]);
        record(table, seed, strategy, input, c.outcome, c.verdict);
        continue;
      }
      const bothNullish =
        (r === null || r === undefined) && (q === null || q === undefined);
      if (outcome.result === null) {
        if (bothNullish) {
          record(table, seed, strategy, input, 'null_from_silence', 'HELD');
        } else if (!r && !q) {
          // Falsy primitives (0, '', false) are not snapshots; silence is right.
          record(table, seed, strategy, input, 'null_from_falsy_roots', 'HELD');
        } else {
          record(table, seed, strategy, input, 'NULL_WITH_EVIDENCE', 'BROKEN');
        }
        continue;
      }
      if (bothNullish) {
        record(table, seed, strategy, input, 'VERDICT_FROM_SILENCE', 'BROKEN');
        continue;
      }
      const check = checkVerdict(outcome.result);
      const echo = checkEcho(check.dims, [readiness, quality], new Set());
      const c = classifyVerdict(check, echo);
      record(table, seed, strategy, input, c.outcome, c.verdict, c.detail);
    }
    const file = table.flush();
    expect({ broken: table.broken(), file }).toEqual({ broken: [], file });
  });

  it(`campaign envelopeAttempt: ${STRESS_ITER} seeded clip/quality/readiness triples`, () => {
    const table = new OutcomeTable('envelopeAttempt');
    for (const seed of campaignSeeds('envelopeAttempt')) {
      const random = seededRandom(seed);
      const clip = pickVariant(random, 'clip', validClip, { allowNull: false });
      const quality = pickVariant(random, 'quality', validQuality as never, {
        allowNull: true,
      });
      const readiness = pickVariant(
        random,
        'readiness',
        validReadiness as never,
        {
          allowNull: true,
        },
      );
      const input = `${clip.id} ${quality.id} ${readiness.id}`;
      const outcome = run(() =>
        attemptCaptureEnvelope(
          clip.value as never,
          quality.value as never,
          readiness.value as never,
        ),
      );
      if (outcome.threw) {
        const c = classifyThrow(outcome.threw, [clip, quality, readiness]);
        record(table, seed, 'attempt', input, c.outcome, c.verdict);
        continue;
      }
      if (outcome.result === null || outcome.result === undefined) {
        record(table, seed, 'attempt', input, 'NULL_ATTEMPT_VERDICT', 'BROKEN');
        continue;
      }
      const check = checkVerdict(outcome.result);
      // Clip fields override the quality proxies for resolution/frame rate.
      const overridden = new Set([
        'frameWidthPx',
        'frameHeightPx',
        'avgFrameRateFps',
      ]);
      const echo = checkEcho(
        check.dims,
        [clip, quality, readiness],
        overridden,
      );
      const c = classifyVerdict(check, echo);
      record(table, seed, 'attempt', input, c.outcome, c.verdict, c.detail);
    }
    const file = table.flush();
    expect({ broken: table.broken(), file }).toEqual({ broken: [], file });
  });

  it(`campaign envelopeSession: ${STRESS_ITER} seeded session-event clips`, () => {
    const table = new OutcomeTable('envelopeSession');
    for (const seed of campaignSeeds('envelopeSession')) {
      const random = seededRandom(seed);
      const clip = pickVariant(random, 'clip', validClip, { allowNull: false });
      const outcome = run(() => sessionEventClipEnvelope(clip.value as never));
      if (outcome.threw) {
        const c = classifyThrow(outcome.threw, [clip]);
        record(table, seed, 'session', clip.id, c.outcome, c.verdict);
        continue;
      }
      if (outcome.result === null || outcome.result === undefined) {
        record(
          table,
          seed,
          'session',
          clip.id,
          'NULL_SESSION_VERDICT',
          'BROKEN',
        );
        continue;
      }
      const check = checkVerdict(outcome.result);
      let broken = check.broken;
      if (!broken) {
        // Session events never measure duration/quality proxies — must stay NOT_MEASURED.
        const dim = check.dims.find(d => d.dimension === 'clip_duration');
        if (dim?.status !== 'NOT_MEASURED')
          broken = 'SESSION_MEASURED_DURATION';
      }
      const echo = broken
        ? null
        : checkEcho(check.dims, [clip], new Set(['durationMs']));
      const c = classifyVerdict({ ...check, broken }, echo);
      record(table, seed, 'session', clip.id, c.outcome, c.verdict, c.detail);
    }
    const file = table.flush();
    expect({ broken: table.broken(), file }).toEqual({ broken: [], file });
  });

  it('prototypes are untouched after every campaign', () => {
    expect(prototypeSnapshot()).toBe(protoBefore);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });
});
