/**
 * Seeded synthetic wrist-speed streams for driving SessionEventEngine /
 * LiveSessionFlow, plus the adversarial mutations the journey calls for
 * (rapid, duplicate, out-of-order, malformed). Streams are SYNTHETIC motion
 * profiles — they exercise the engine's segmentation state machine and are
 * not a claim about any recorded rally.
 */
import type { SessionMotionSample } from '../../src/flow/session';
import { SeededRng } from './prng';

export interface StrokeStreamParams {
  seed: number;
  strokes: number;
  /** Samples per second of the synthetic feed. */
  fps: number;
  /** Quiet gap between strokes (ms) — inclusive range. */
  gapMsRange: [number, number];
  /** Stroke burst peak speed (normalized u/s) — inclusive range. */
  peakRange: [number, number];
  /** Burst half-width (ms) — how long a stroke stays above baseline. */
  burstHalfWidthMs: number;
  /** Baseline jitter amplitude. */
  baselineNoise: number;
  /** Leading quiet (ms) before the first stroke. */
  leadInMs: number;
}

export const DEFAULT_STROKE_PARAMS: Omit<
  StrokeStreamParams,
  'seed' | 'strokes'
> = {
  fps: 30,
  gapMsRange: [1500, 2600],
  peakRange: [2.0, 6.0],
  burstHalfWidthMs: 180,
  baselineNoise: 0.06,
  leadInMs: 800,
};

export interface GeneratedStream {
  params: StrokeStreamParams;
  samples: SessionMotionSample[];
  /** Planned stroke peak times (ms) — the ground truth the stream encodes. */
  plannedPeaksMs: number[];
}

/** Bell-shaped burst around `peakMs`. */
function burst(
  tMs: number,
  peakMs: number,
  peak: number,
  halfWidthMs: number,
): number {
  const sigma = halfWidthMs / 2;
  const d = (tMs - peakMs) / sigma;
  return peak * Math.exp(-0.5 * d * d);
}

export function generateStrokeStream(
  params: StrokeStreamParams,
): GeneratedStream {
  const rng = new SeededRng(params.seed);
  const frameMs = 1000 / params.fps;
  const plannedPeaksMs: number[] = [];
  const peaks: number[] = [];
  let cursor = params.leadInMs;
  for (let index = 0; index < params.strokes; index += 1) {
    cursor += rng.float(params.gapMsRange[0], params.gapMsRange[1]);
    plannedPeaksMs.push(Math.round(cursor));
    peaks.push(rng.float(params.peakRange[0], params.peakRange[1]));
  }
  const endMs = cursor + params.gapMsRange[1] + 1500;
  const samples: SessionMotionSample[] = [];
  let nextPeak = 0;
  for (let t = 0; t <= endMs; t += frameMs) {
    while (
      nextPeak < plannedPeaksMs.length &&
      (plannedPeaksMs[nextPeak] ?? Infinity) + params.burstHalfWidthMs * 3 < t
    ) {
      nextPeak += 1;
    }
    let v = Math.abs(rng.float(0, params.baselineNoise));
    for (
      let k = Math.max(0, nextPeak - 1);
      k <= Math.min(plannedPeaksMs.length - 1, nextPeak + 1);
      k += 1
    ) {
      const peakMs = plannedPeaksMs[k];
      const peak = peaks[k];
      if (peakMs === undefined || peak === undefined) continue;
      v += burst(t, peakMs, peak, params.burstHalfWidthMs);
    }
    samples.push({
      tMs: Math.round(t * 1000) / 1000,
      v: Math.round(v * 10_000) / 10_000,
    });
  }
  return { params, samples, plannedPeaksMs };
}

// ─── Mutations (each is seed-deterministic and records what it did) ─────────

export interface MutationLog {
  duplicatesInjected: number;
  outOfOrderMoves: number;
  malformedInjected: number;
  malformedKinds: Record<string, number>;
}

/** Native-shaped motion events, including malformed ones. */
export type RawMotionEvent = Record<string, unknown>;

export function toNativeEvent(
  sample: SessionMotionSample,
  captureId: string,
): RawMotionEvent {
  return {
    type: 'session_motion_sample',
    tMs: sample.tMs,
    v: sample.v,
    captureId,
    emittedAtIso: '2026-09-04T00:00:00.000Z',
  };
}

export const MALFORMED_MOTION_KINDS = [
  'tMs_nan',
  'tMs_negative',
  'tMs_string',
  'tMs_missing',
  'tMs_infinite',
  'v_nan',
  'v_negative',
  'v_string',
  'v_missing',
  'v_infinite',
  'captureId_number',
  'emittedAtIso_number',
  'type_wrong',
  'type_missing',
  'null_payload',
  'array_payload',
  'stale_captureId',
  'huge_v',
  'tMs_far_future',
] as const;

export type MalformedMotionKind = (typeof MALFORMED_MOTION_KINDS)[number];

export function malformedMotionEvent(
  base: SessionMotionSample,
  kind: MalformedMotionKind,
  captureId: string,
): unknown {
  const event = toNativeEvent(base, captureId);
  switch (kind) {
    case 'tMs_nan':
      return { ...event, tMs: Number.NaN };
    case 'tMs_negative':
      return { ...event, tMs: -base.tMs - 1 };
    case 'tMs_string':
      return { ...event, tMs: String(base.tMs) };
    case 'tMs_missing': {
      const { tMs: _drop, ...rest } = event;
      return rest;
    }
    case 'tMs_infinite':
      return { ...event, tMs: Number.POSITIVE_INFINITY };
    case 'v_nan':
      return { ...event, v: Number.NaN };
    case 'v_negative':
      return { ...event, v: -1 };
    case 'v_string':
      return { ...event, v: '2.5' };
    case 'v_missing': {
      const { v: _drop, ...rest } = event;
      return rest;
    }
    case 'v_infinite':
      return { ...event, v: Number.POSITIVE_INFINITY };
    case 'captureId_number':
      return { ...event, captureId: 42 };
    case 'emittedAtIso_number':
      return { ...event, emittedAtIso: 1234 };
    case 'type_wrong':
      return { ...event, type: 'session_motion_samplee' };
    case 'type_missing': {
      const { type: _drop, ...rest } = event;
      return rest;
    }
    case 'null_payload':
      return null;
    case 'array_payload':
      return [event];
    case 'stale_captureId':
      return { ...event, captureId: `${captureId}-stale` };
    case 'huge_v':
      // Structurally VALID (finite, non-negative): passes the boundary check.
      return { ...event, v: 1e12 };
    case 'tMs_far_future':
      // Structurally VALID: a timestamp jump the engine must absorb.
      return { ...event, tMs: base.tMs + 3_600_000 };
  }
}

export interface MutatedStream {
  /** Events in delivery order; each entry is either a valid native payload
   * or a malformed one. `origin` records how it was produced. */
  events: Array<{
    payload: unknown;
    origin: 'clean' | 'duplicate' | 'moved' | MalformedMotionKind;
  }>;
  log: MutationLog;
}

export function mutateStream(
  stream: GeneratedStream,
  captureId: string,
  options: {
    seed: number;
    duplicateRate: number;
    outOfOrderRate: number;
    /** Max positions an out-of-order sample is delayed by. */
    maxDelay: number;
    malformedRate: number;
  },
): MutatedStream {
  const rng = new SeededRng(options.seed);
  const log: MutationLog = {
    duplicatesInjected: 0,
    outOfOrderMoves: 0,
    malformedInjected: 0,
    malformedKinds: {},
  };
  const events: MutatedStream['events'] = stream.samples.map(sample => ({
    payload: toNativeEvent(sample, captureId),
    origin: 'clean' as const,
  }));
  // Out-of-order: delay a sample by 1..maxDelay positions.
  for (let index = 0; index < events.length; index += 1) {
    if (!rng.chance(options.outOfOrderRate)) continue;
    const delay = rng.int(1, options.maxDelay);
    const target = Math.min(events.length - 1, index + delay);
    if (target === index) continue;
    const [moved] = events.splice(index, 1);
    if (!moved) continue;
    events.splice(target, 0, { ...moved, origin: 'moved' });
    log.outOfOrderMoves += 1;
  }
  // Duplicates: re-deliver a sample immediately after itself.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!rng.chance(options.duplicateRate)) continue;
    const original = events[index];
    if (!original) continue;
    events.splice(index + 1, 0, {
      payload: original.payload,
      origin: 'duplicate',
    });
    log.duplicatesInjected += 1;
  }
  // Malformed: interleave a malformed payload derived from the local sample.
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (!rng.chance(options.malformedRate)) continue;
    const kind = rng.pick(MALFORMED_MOTION_KINDS);
    const sample = stream.samples[Math.min(index, stream.samples.length - 1)];
    if (!sample) continue;
    events.splice(index + 1, 0, {
      payload: malformedMotionEvent(sample, kind, captureId),
      origin: kind,
    });
    log.malformedInjected += 1;
    log.malformedKinds[kind] = (log.malformedKinds[kind] ?? 0) + 1;
  }
  return { events, log };
}
