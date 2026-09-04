import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ApiSession } from '../../src/account/apiSession';
import type { CapturedClip, CaptureEvidenceV1 } from '../../src/camera/capture';
import type {
  PendingCapture,
  RealAnalysisFact,
} from '../../src/data/repository';
import {
  fetchCanonicalProgress,
  ProgressApiError,
  type CanonicalProgress,
  type ProgressFetch,
} from '../../src/progress/api';
import {
  aggregatePracticeHistory,
  buildPracticeHistory,
  isVerifiedPracticeCapture,
  PRACTICE_HISTORY_RANGES,
  type PracticeHistory,
  type PracticeMetrics,
} from '../../src/progress/practiceHistory';
import {
  DEFAULT_LATEST_SET_MAX_AGE_MS,
  FIXED_CHECKPOINT_FROM_BELOW,
  FIXED_CHECKPOINT_TO_AT_LEAST,
  latestPracticeSet,
  PRACTICE_SET_TREND_THRESHOLD_TENTHS,
  practiceSetHeadline,
  practiceSetInsight,
  scoreTenths,
  summarizePracticeSet,
  type PracticeSetSummary,
} from '../../src/progress/practiceSetProgress';

/**
 * STRESS SUITE (lens: randomized-seeded long-run) for the progress module:
 *   progress/api.ts · progress/practiceHistory.ts · progress/practiceSetProgress.ts
 *
 * Every campaign is a set of seeded action sequences (length 5–60) over the
 * unit's PUBLIC API. After EVERY step the production result is model-checked
 * against an independent reference implementation of the documented
 * invariants (the module doc comments, AGENTS.md "progress" notes and the
 * pinned unit suites), then the same seed is replayed and the two traces must
 * be byte-identical (determinism).
 *
 * Replay / scale knobs (all optional):
 *   STRESS_ITER=<n>          sequences PER MODULE (default 20 → 60 total, ~5s;
 *                            the recorded campaign used STRESS_ITER=700)
 *   STRESS_SEED=<n>          base seed (default 20260904)
 *   STRESS_REPLAY=<mod>:<seed>  run exactly one sequence
 *                            (mod ∈ history|practiceSet|api)
 *   STRESS_OUT=<file.json>   write the seed → outcome table there
 *
 * Failures are never hidden: each module's `it` collects EVERY failing seed
 * (with the step index, the invariant that broke and a greedily minimized
 * input) and asserts the list is empty.
 */

// ─── Seeded PRNG (mulberry32, same as libraryFocusStress) ─────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rng: Rng, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function chance(rng: Rng, probability: number): boolean {
  return rng() < probability;
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = int(rng, 0, index);
    const held = copy[index]!;
    copy[index] = copy[swap]!;
    copy[swap] = held;
  }
  return copy;
}

/** Sequence seed: stable per (base, module, index) and reported as-is. */
function sequenceSeed(base: number, module: number, index: number): number {
  const mix = mulberry32(
    (base ^ (module * 0x9e3779b9) ^ (index * 0x85ebca6b)) >>> 0,
  );
  mix();
  return Math.floor(mix() * 0xffffffff) >>> 0;
}

// ─── Campaign plumbing ────────────────────────────────────────────────────

const ITER = Math.max(1, Number(process.env['STRESS_ITER'] ?? 20));
const SEED_BASE = Number(process.env['STRESS_SEED'] ?? 20260904);
const REPLAY = process.env['STRESS_REPLAY'];
const OUT = process.env['STRESS_OUT'];
const MIN_LEN = 5;
const MAX_LEN = 60;

type ModuleName = 'history' | 'practiceSet' | 'api';

interface SequenceOutcome {
  module: ModuleName;
  seed: number;
  length: number;
  /** Steps that actually executed (equals length unless a step failed). */
  stepsRun: number;
  outcome: 'ok' | 'fail';
  /** Per-module extra counters (e.g. coercion cases in the api campaign). */
  notes?: Record<string, number>;
  failStep?: number;
  action?: string;
  error?: string;
  minimized?: unknown;
  /** api only: lenient-parse cases (`Number()` coercion) with the payload
   * field that was coerced and the step it happened at. */
  coercions?: { step: number; coercions: string[]; body: unknown }[];
  determinism: 'identical' | 'diverged' | 'n/a';
}

const table: SequenceOutcome[] = [];

function seedsFor(module: ModuleName, moduleIndex: number): number[] {
  if (REPLAY) {
    const [name, seed] = REPLAY.split(':');
    if (name !== module) return [];
    return [Number(seed)];
  }
  const seeds: number[] = [];
  for (let index = 0; index < ITER; index += 1) {
    seeds.push(sequenceSeed(SEED_BASE, moduleIndex, index));
  }
  return seeds;
}

class InvariantError extends Error {
  constructor(
    message: string,
    readonly detail: unknown,
  ) {
    super(message);
    this.name = 'InvariantError';
  }
}

function assertInvariant(
  condition: boolean,
  message: string,
  detail?: unknown,
): void {
  if (!condition) throw new InvariantError(message, detail);
}

function nearlyEqual(left: number | null, right: number | null): boolean {
  if (left === null || right === null) return left === right;
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left));
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'number' && !Number.isFinite(item)
      ? `#${String(item)}`
      : item,
  );
}

function describeError(error: unknown): string {
  if (error instanceof InvariantError) {
    return `${error.message} ${stable(error.detail) ?? ''}`.trim();
  }
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/** Greedy one-pass delta minimization of a list-shaped input: drop every
 * element whose removal keeps the invariant failing. */
function minimizeList<T>(
  items: readonly T[],
  stillFails: (candidate: readonly T[]) => boolean,
): T[] {
  let current = [...items];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let index = 0; index < current.length; index += 1) {
      const candidate = current.filter((_item, at) => at !== index);
      if (stillFails(candidate)) {
        current = candidate;
        progressed = true;
        break;
      }
    }
  }
  return current;
}

// ─── Shared time helpers (independent of the production formatter) ────────

const DAY_MS = 86_400_000;

const TIME_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/New_York',
  'America/St_Johns',
  'America/Santiago',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'Pacific/Apia',
  'Etc/GMT+12',
  'Etc/GMT-14',
] as const;

const refFormatters = new Map<string, Intl.DateTimeFormat>();

/** Reference calendar day: en-CA renders YYYY-MM-DD directly, a different
 * path than production's formatToParts assembly. */
function refDay(ms: number, timeZone: string): string {
  let formatter = refFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    refFormatters.set(timeZone, formatter);
  }
  return formatter.format(new Date(ms));
}

function refOrdinal(day: string): number {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const dayOfMonth = Number(day.slice(8, 10));
  return Date.UTC(year, month - 1, dayOfMonth) / DAY_MS;
}

function refDayFromOrdinal(ordinal: number): string {
  const date = new Date(ordinal * DAY_MS);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${dayOfMonth}`;
}

/** Approximate zone offset (minutes) at `ms`, used only to SAMPLE instants
 * near local midnight; the oracle never depends on it. */
function zoneOffsetMinutes(ms: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const field = (type: string): number =>
    Number(parts.find(part => part.type === type)?.value ?? '0');
  const local = Date.UTC(
    field('year'),
    field('month') - 1,
    field('day'),
    field('hour'),
    field('minute'),
    field('second'),
  );
  return Math.round((local - Math.floor(ms / 1000) * 1000) / 60_000);
}

function nearLocalMidnight(rng: Rng, ms: number, timeZone: string): number {
  const offset = zoneOffsetMinutes(ms, timeZone) * 60_000;
  const midnight = Math.floor((ms + offset) / DAY_MS) * DAY_MS - offset;
  const jitter = pick(rng, [0, -1, 1, -1000, 1000, -59_000, 59_000, 3_599_999]);
  return midnight + jitter;
}

const EPOCH_2020 = Date.UTC(2020, 0, 1);
const EPOCH_2031 = Date.UTC(2031, 0, 1);

// ═══════════════════════════════════════════════════════════════════════════
// Module 1 — practiceHistory
// ═══════════════════════════════════════════════════════════════════════════

type AutomaticClip = Extract<
  CapturedClip,
  { captureMode: 'automatic_pose_trigger' }
>;
type ImportedClip = Extract<CapturedClip, { captureMode: 'imported_video' }>;

interface HistoryState {
  captures: PendingCapture[];
  asOfMs: number;
  asOfIso: string;
  timeZone: string;
  rangeDays: number;
  nextId: number;
}

function isoWithOffset(ms: number, offsetMinutes: number): string {
  const shifted = new Date(ms + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, -1);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hours = String(Math.floor(abs / 60)).padStart(2, '0');
  const minutes = String(abs % 60).padStart(2, '0');
  return `${shifted}${sign}${hours}:${minutes}`;
}

function randomIso(rng: Rng, ms: number): string {
  if (chance(rng, 0.75)) return new Date(ms).toISOString();
  const offset = pick(rng, [-720, -330, -60, 60, 330, 345, 525, 780, 840]);
  return isoWithOffset(ms, offset);
}

function randomEvidence(rng: Rng): CaptureEvidenceV1 {
  const poseFrameCount = int(rng, 1, 400);
  const poseMissingFrameCount = int(rng, 0, 120);
  const minimumJointCoverage = int(rng, 0, 1000) / 1000;
  const meanJointCoverage =
    minimumJointCoverage +
    (1 - minimumJointCoverage) * (int(rng, 0, 1000) / 1000);
  return {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: chance(rng, 0.5)
      ? 'apple_vision_body_pose'
      : 'mediapipe_pose_landmarker',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: poseFrameCount + poseMissingFrameCount,
    poseFrameCount,
    poseMissingFrameCount,
    trackedDurationMs: int(rng, 0, 800),
    meanCanonicalJointVisibility: int(rng, 0, 1000) / 1000,
    meanJointCoverage,
    minimumJointCoverage,
    fullBodyVisibleFrameCount: int(rng, 0, poseFrameCount),
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 1,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
}

function cameraCapture(
  id: string,
  capturedAtIso: string,
  evidence: CaptureEvidenceV1,
): PendingCapture {
  const uri = `file:///captures/${id}.mov`;
  const clip: AutomaticClip = {
    uri,
    capturedAtIso,
    durationMs: 3_000,
    fps: 60,
    width: 1_080,
    height: 1_920,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 1_000,
      endMs: 1_800,
      peakMotionMs: 1_500,
      confidence: 0.82,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: evidence,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 1_000,
    postRollMs: 1_200,
  };
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    clip,
    evidenceStatus: 'valid',
  };
}

function importedCapture(
  id: string,
  capturedAtIso: string,
  measured: boolean,
): PendingCapture {
  const uri = `file:///captures/${id}.mov`;
  const clip: ImportedClip = {
    uri,
    capturedAtIso,
    durationMs: 2_000,
    fps: 30,
    width: 1_080,
    height: 1_920,
    captureMode: 'imported_video',
    recognition: { status: 'unknown', reason: 'analysis_not_run' },
    ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
    ...(measured
      ? {
          poseSequence: {
            schemaVersion: 1 as const,
            format: 'pickle.pose-sequence.v1' as const,
            uri: `file:///captures/${id}.pose.json`,
            frameCount: 96,
            sha256: 'b'.repeat(64),
            coordinateSystem: 'normalized_image_top_left' as const,
            poseModelVersion: 'apple-vision-bodypose-1',
          },
        }
      : {}),
  };
  return {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    uri,
    capturedAtIso,
    durationMs: clip.durationMs,
    fps: clip.fps,
    width: clip.width,
    height: clip.height,
    clip,
    evidenceStatus: 'valid',
  };
}

function randomCaptureInstant(rng: Rng, state: HistoryState): number {
  const spanDays = Math.max(3, state.rangeDays * 2 + 3);
  const roll = rng();
  if (roll < 0.06) return state.asOfMs; // exactly at the reference instant
  if (roll < 0.1) return state.asOfMs - 1;
  if (roll < 0.3) {
    const daysBack = int(rng, 0, spanDays);
    return nearLocalMidnight(
      rng,
      state.asOfMs - daysBack * DAY_MS,
      state.timeZone,
    );
  }
  return state.asOfMs - Math.floor(rng() * spanDays * DAY_MS);
}

const HISTORY_ACTIONS = [
  'add_camera',
  'add_camera',
  'add_camera',
  'add_imported_measured',
  'add_imported_raw',
  'add_legacy',
  'add_corrupt',
  'add_mismatch',
  'add_future',
  'add_no_zone_iso',
  'add_garbage_iso',
  'add_duplicate_id',
  'add_same_instant',
  'remove_random',
  'shuffle',
  'shift_asOf',
  'asOf_to_midnight',
  'set_timeZone',
  'set_range',
  'query_invalid_options',
] as const;

type HistoryAction = (typeof HISTORY_ACTIONS)[number];

function applyHistoryAction(
  rng: Rng,
  state: HistoryState,
  action: HistoryAction,
): void {
  const nextId = (): string => {
    state.nextId += 1;
    return `cap-${String(state.nextId).padStart(4, '0')}`;
  };
  switch (action) {
    case 'add_camera': {
      const ms = randomCaptureInstant(rng, state);
      state.captures.push(
        cameraCapture(nextId(), randomIso(rng, ms), randomEvidence(rng)),
      );
      return;
    }
    case 'add_imported_measured':
    case 'add_imported_raw': {
      const ms = randomCaptureInstant(rng, state);
      state.captures.push(
        importedCapture(
          nextId(),
          randomIso(rng, ms),
          action === 'add_imported_measured',
        ),
      );
      return;
    }
    case 'add_legacy':
    case 'add_corrupt': {
      const ms = randomCaptureInstant(rng, state);
      const base = cameraCapture(
        nextId(),
        randomIso(rng, ms),
        randomEvidence(rng),
      );
      state.captures.push({
        ...base,
        clip: chance(rng, 0.5) ? null : base.clip,
        evidenceStatus: action === 'add_legacy' ? 'legacy' : 'corrupt',
      });
      return;
    }
    case 'add_mismatch': {
      const ms = randomCaptureInstant(rng, state);
      const base = cameraCapture(
        nextId(),
        randomIso(rng, ms),
        randomEvidence(rng),
      );
      const field = pick(rng, [
        'uri',
        'capturedAtIso',
        'durationMs',
        'fps',
        'width',
        'height',
      ]);
      const mutated: PendingCapture = { ...base };
      switch (field) {
        case 'uri':
          mutated.uri = `${base.uri}.moved`;
          break;
        case 'capturedAtIso':
          mutated.capturedAtIso = new Date(ms - 1).toISOString();
          break;
        case 'durationMs':
          mutated.durationMs = base.durationMs + 1;
          break;
        case 'fps':
          mutated.fps = base.fps + 1;
          break;
        case 'width':
          mutated.width = base.width + 1;
          break;
        default:
          mutated.height = base.height + 1;
      }
      // Repository would flag this; the pure rule must exclude it EITHER way.
      mutated.evidenceStatus = chance(rng, 0.5) ? 'valid' : 'metadata_mismatch';
      state.captures.push(mutated);
      return;
    }
    case 'add_future': {
      const ms =
        state.asOfMs + pick(rng, [1, 1000, 60_000, DAY_MS, 40 * DAY_MS]);
      state.captures.push(
        cameraCapture(nextId(), randomIso(rng, ms), randomEvidence(rng)),
      );
      return;
    }
    case 'add_no_zone_iso': {
      const ms = randomCaptureInstant(rng, state);
      const iso = new Date(ms).toISOString().slice(0, -1); // no Z
      state.captures.push(cameraCapture(nextId(), iso, randomEvidence(rng)));
      return;
    }
    case 'add_garbage_iso': {
      const iso = pick(rng, [
        'not-a-dateZ',
        'Z',
        '2026-13-45T00:00:00Z',
        '+05:30',
        '',
      ]);
      state.captures.push(cameraCapture(nextId(), iso, randomEvidence(rng)));
      return;
    }
    case 'add_duplicate_id': {
      const source = state.captures.length ? pick(rng, state.captures) : null;
      if (!source) return;
      state.captures.push({ ...source });
      return;
    }
    case 'add_same_instant': {
      const source = state.captures.length ? pick(rng, state.captures) : null;
      if (!source) return;
      state.captures.push(
        cameraCapture(nextId(), source.capturedAtIso, randomEvidence(rng)),
      );
      return;
    }
    case 'remove_random': {
      if (!state.captures.length) return;
      state.captures.splice(int(rng, 0, state.captures.length - 1), 1);
      return;
    }
    case 'shuffle': {
      state.captures = shuffled(rng, state.captures);
      return;
    }
    case 'shift_asOf': {
      const delta = pick(rng, [
        1,
        -1,
        60_000,
        -60_000,
        3_600_000,
        -3_600_000,
        DAY_MS,
        -DAY_MS,
        7 * DAY_MS,
        -7 * DAY_MS,
        -90 * DAY_MS,
        400 * DAY_MS,
      ]);
      state.asOfMs += delta;
      state.asOfIso = randomIso(rng, state.asOfMs);
      return;
    }
    case 'asOf_to_midnight': {
      state.asOfMs = nearLocalMidnight(rng, state.asOfMs, state.timeZone);
      state.asOfIso = randomIso(rng, state.asOfMs);
      return;
    }
    case 'set_timeZone': {
      state.timeZone = pick(rng, TIME_ZONES);
      return;
    }
    case 'set_range': {
      state.rangeDays = chance(rng, 0.6)
        ? pick(rng, [1, 7, 28, 90, 366])
        : int(rng, 1, 366);
      return;
    }
    case 'query_invalid_options': {
      // Illegal option shapes must be REJECTED loudly (documented contract).
      const invalid = pick(rng, [
        { rangeDays: 0 },
        { rangeDays: 367 },
        { rangeDays: 1.5 },
        { rangeDays: Number.NaN },
        { timeZone: '' },
        { timeZone: '   ' },
        { timeZone: 'Mars/Olympus_Mons' },
        { asOfIso: '2026-08-27T20:00:00' },
        { asOfIso: 'garbageZ' },
      ]);
      let threw = false;
      try {
        aggregatePracticeHistory(state.captures, {
          asOfIso: state.asOfIso,
          timeZone: state.timeZone,
          rangeDays: state.rangeDays,
          ...invalid,
        });
      } catch (error) {
        threw = error instanceof Error && !(error instanceof InvariantError);
      }
      assertInvariant(threw, 'invalid options must throw an Error', invalid);
      return;
    }
  }
}

// Reference model ------------------------------------------------------------

interface RefEligible {
  id: string;
  ms: number;
  day: string;
  evidence: CaptureEvidenceV1 | null;
}

function refVerified(capture: PendingCapture): boolean {
  const clip = capture.clip;
  if (capture.evidenceStatus !== 'valid' || clip === null) return false;
  const metadataMatches =
    clip.uri === capture.uri &&
    clip.capturedAtIso === capture.capturedAtIso &&
    clip.durationMs === capture.durationMs &&
    clip.fps === capture.fps &&
    clip.width === capture.width &&
    clip.height === capture.height;
  if (!metadataMatches) return false;
  if (clip.captureMode === 'automatic_pose_trigger') return true;
  return clip.poseSequence !== undefined;
}

function refInstant(iso: string): number | null {
  const explicitZone = /(Z|[+-]\d\d:\d\d)$/i.test(iso);
  if (!explicitZone) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function refEligible(
  captures: readonly PendingCapture[],
  asOfMs: number,
  tz: string,
): RefEligible[] {
  const out: RefEligible[] = [];
  for (const capture of captures) {
    if (!refVerified(capture) || !capture.clip) continue;
    const ms = refInstant(capture.capturedAtIso);
    if (ms === null || ms > asOfMs) continue;
    out.push({
      id: capture.id,
      ms,
      day: refDay(ms, tz),
      evidence:
        capture.clip.captureMode === 'automatic_pose_trigger'
          ? capture.clip.captureEvidence
          : null,
    });
  }
  return out;
}

interface RefMetrics {
  eligible: number;
  camera: number;
  imported: number;
  activeDays: number;
  trackedMs: number;
  input: number;
  pose: number;
  missing: number;
  rate: number | null;
  meanCoverage: number | null;
  minCoverage: number | null;
  meanVisibility: number | null;
  fullBodyRate: number | null;
}

function refMetrics(items: readonly RefEligible[]): RefMetrics {
  const days = new Set<string>();
  let camera = 0;
  let imported = 0;
  let trackedMs = 0;
  let input = 0;
  let pose = 0;
  let missing = 0;
  let coverageSum = 0;
  let visibilitySum = 0;
  let fullBody = 0;
  let minCoverage: number | null = null;
  for (const item of items) {
    days.add(item.day);
    if (item.evidence === null) {
      imported += 1;
      continue;
    }
    camera += 1;
    trackedMs += item.evidence.trackedDurationMs;
    input += item.evidence.analysisInputFrameCount;
    pose += item.evidence.poseFrameCount;
    missing += item.evidence.poseMissingFrameCount;
    coverageSum +=
      item.evidence.meanJointCoverage * item.evidence.poseFrameCount;
    visibilitySum +=
      item.evidence.meanCanonicalJointVisibility * item.evidence.poseFrameCount;
    fullBody += item.evidence.fullBodyVisibleFrameCount;
    minCoverage =
      minCoverage === null
        ? item.evidence.minimumJointCoverage
        : Math.min(minCoverage, item.evidence.minimumJointCoverage);
  }
  return {
    eligible: items.length,
    camera,
    imported,
    activeDays: days.size,
    trackedMs,
    input,
    pose,
    missing,
    rate: input > 0 ? pose / input : null,
    meanCoverage: pose > 0 ? coverageSum / pose : null,
    minCoverage,
    meanVisibility: pose > 0 ? visibilitySum / pose : null,
    fullBodyRate: pose > 0 ? fullBody / pose : null,
  };
}

function compareMetrics(
  label: string,
  actual: PracticeMetrics,
  expected: RefMetrics,
): void {
  const checks: Array<[string, number | null, number | null]> = [
    ['eligibleCaptureCount', actual.eligibleCaptureCount, expected.eligible],
    ['cameraCaptureCount', actual.cameraCaptureCount, expected.camera],
    ['importedCaptureCount', actual.importedCaptureCount, expected.imported],
    ['activeDayCount', actual.activeDayCount, expected.activeDays],
    ['trackedPoseDurationMs', actual.trackedPoseDurationMs, expected.trackedMs],
    [
      'analysisInputFrameCount',
      actual.poseAvailability.analysisInputFrameCount,
      expected.input,
    ],
    ['poseFrameCount', actual.poseAvailability.poseFrameCount, expected.pose],
    [
      'poseMissingFrameCount',
      actual.poseAvailability.poseMissingFrameCount,
      expected.missing,
    ],
    ['rate', actual.poseAvailability.rate, expected.rate],
    ['meanCoverage', actual.jointTracking.meanCoverage, expected.meanCoverage],
    [
      'minimumCoverage',
      actual.jointTracking.minimumCoverage,
      expected.minCoverage,
    ],
    [
      'meanCanonicalJointVisibility',
      actual.jointTracking.meanCanonicalJointVisibility,
      expected.meanVisibility,
    ],
    [
      'fullBodyVisibleFrameRate',
      actual.jointTracking.fullBodyVisibleFrameRate,
      expected.fullBodyRate,
    ],
  ];
  for (const [field, got, want] of checks) {
    assertInvariant(nearlyEqual(got, want), `${label}.${field} mismatch`, {
      got,
      want,
    });
  }
  assertInvariant(
    actual.cameraCaptureCount + actual.importedCaptureCount ===
      actual.eligibleCaptureCount,
    `${label}: camera + imported must equal eligible`,
  );
  assertInvariant(
    actual.poseAvailability.poseFrameCount +
      actual.poseAvailability.poseMissingFrameCount ===
      actual.poseAvailability.analysisInputFrameCount,
    `${label}: pose + missing must equal analysis input frames`,
  );
  const rate = actual.poseAvailability.rate;
  assertInvariant(
    rate === null
      ? actual.poseAvailability.analysisInputFrameCount === 0
      : rate >= 0 && rate <= 1,
    `${label}: pose availability rate must be null iff no frames, else within [0,1]`,
    rate,
  );
  const mean = actual.jointTracking.meanCoverage;
  const minimum = actual.jointTracking.minimumCoverage;
  if (mean !== null && minimum !== null) {
    assertInvariant(
      minimum <= mean + 1e-9,
      `${label}: minimum coverage cannot exceed the mean`,
      {
        mean,
        minimum,
      },
    );
  }
}

function refStreak(
  activeDays: ReadonlySet<string>,
  asOfOrdinal: number,
): PracticeHistory['streak'] {
  const ordinals = new Set([...activeDays].map(refOrdinal));
  if (ordinals.size === 0) {
    return {
      currentDays: 0,
      longestDays: 0,
      practicedToday: false,
      lastPracticeDay: null,
    };
  }
  let longestDays = 0;
  for (const ordinal of ordinals) {
    if (ordinals.has(ordinal - 1)) continue; // only count runs from their start
    let run = 0;
    while (ordinals.has(ordinal + run)) run += 1;
    longestDays = Math.max(longestDays, run);
  }
  const latest = Math.max(...ordinals);
  let currentDays = 0;
  if (latest === asOfOrdinal || latest === asOfOrdinal - 1) {
    while (ordinals.has(latest - currentDays)) currentDays += 1;
  }
  return {
    currentDays,
    longestDays,
    practicedToday: latest === asOfOrdinal,
    lastPracticeDay: refDayFromOrdinal(latest),
  };
}

function checkHistory(state: HistoryState): PracticeHistory {
  const options = {
    asOfIso: state.asOfIso,
    timeZone: state.timeZone,
    rangeDays: state.rangeDays,
  };
  const history = aggregatePracticeHistory(state.captures, options);

  // Verified-practice rule agrees with the reference on every row.
  for (const capture of state.captures) {
    assertInvariant(
      isVerifiedPracticeCapture(capture) === refVerified(capture),
      'isVerifiedPracticeCapture disagrees with the reference rule',
      { id: capture.id, evidenceStatus: capture.evidenceStatus },
    );
  }

  const eligible = refEligible(state.captures, state.asOfMs, state.timeZone);
  const asOfDay = refDay(state.asOfMs, state.timeZone);
  const asOfOrdinal = refOrdinal(asOfDay);
  const currentStart = asOfOrdinal - state.rangeDays + 1;
  const previousEnd = currentStart - 1;
  const previousStart = previousEnd - state.rangeDays + 1;

  assertInvariant(history.asOfDay === asOfDay, 'asOfDay mismatch', {
    got: history.asOfDay,
    want: asOfDay,
  });
  assertInvariant(history.rangeDays === state.rangeDays, 'rangeDays echoed');
  assertInvariant(
    typeof history.timeZone === 'string' && history.timeZone.length > 0,
    'timeZone must be echoed as a non-empty string',
  );
  assertInvariant(
    history.sourceCaptureCount === state.captures.length,
    'sourceCaptureCount must equal the input length',
  );
  assertInvariant(
    history.excludedCaptureCount === state.captures.length - eligible.length,
    'excludedCaptureCount must be source − eligible',
    {
      got: history.excludedCaptureCount,
      want: state.captures.length - eligible.length,
    },
  );

  compareMetrics('lifetime', history.lifetime, refMetrics(eligible));
  const inCurrent = eligible.filter(item => {
    const ordinal = refOrdinal(item.day);
    return ordinal >= currentStart && ordinal <= asOfOrdinal;
  });
  const inPrevious = eligible.filter(item => {
    const ordinal = refOrdinal(item.day);
    return ordinal >= previousStart && ordinal <= previousEnd;
  });
  compareMetrics(
    'current',
    history.rangeBuckets.current,
    refMetrics(inCurrent),
  );
  compareMetrics(
    'previous',
    history.rangeBuckets.previous,
    refMetrics(inPrevious),
  );
  assertInvariant(
    history.rangeBuckets.current.period === 'current',
    'current period tag',
  );
  assertInvariant(
    history.rangeBuckets.previous.period === 'previous',
    'previous period tag',
  );
  assertInvariant(
    history.rangeBuckets.current.startDay === refDayFromOrdinal(currentStart) &&
      history.rangeBuckets.current.endDay === asOfDay &&
      history.rangeBuckets.previous.startDay ===
        refDayFromOrdinal(previousStart) &&
      history.rangeBuckets.previous.endDay === refDayFromOrdinal(previousEnd),
    'range bucket boundaries must be contiguous and end at asOfDay',
    history.rangeBuckets,
  );
  assertInvariant(
    history.rangeBuckets.current.eligibleCaptureCount +
      history.rangeBuckets.previous.eligibleCaptureCount <=
      history.lifetime.eligibleCaptureCount,
    'current + previous can never exceed lifetime',
  );

  // Day buckets: exactly rangeDays consecutive days ending at asOfDay.
  assertInvariant(
    history.dayBuckets.length === state.rangeDays,
    'dayBuckets length must equal rangeDays',
    history.dayBuckets.length,
  );
  let bucketSum = 0;
  let bucketActive = 0;
  history.dayBuckets.forEach((bucket, index) => {
    const want = refDayFromOrdinal(currentStart + index);
    assertInvariant(
      bucket.day === want,
      'dayBuckets must be ascending consecutive days',
      {
        index,
        got: bucket.day,
        want,
      },
    );
    compareMetrics(
      `dayBuckets[${bucket.day}]`,
      bucket,
      refMetrics(eligible.filter(item => item.day === bucket.day)),
    );
    assertInvariant(
      bucket.activeDayCount === (bucket.eligibleCaptureCount > 0 ? 1 : 0),
      'a day bucket is active iff it has an eligible capture',
      bucket,
    );
    bucketSum += bucket.eligibleCaptureCount;
    bucketActive += bucket.activeDayCount;
  });
  assertInvariant(
    bucketSum === history.rangeBuckets.current.eligibleCaptureCount,
    'day buckets must sum to the current range count',
    { bucketSum, current: history.rangeBuckets.current.eligibleCaptureCount },
  );
  assertInvariant(
    bucketActive === history.rangeBuckets.current.activeDayCount,
    'active day buckets must equal the current active day count',
  );

  // Streak from the independent run-finder.
  const streak = refStreak(
    new Set(eligible.map(item => item.day)),
    asOfOrdinal,
  );
  assertInvariant(
    stable(history.streak) === stable(streak),
    'streak mismatch',
    {
      got: history.streak,
      want: streak,
    },
  );
  assertInvariant(
    history.streak.currentDays <= history.streak.longestDays,
    'current streak can never exceed the longest',
  );
  assertInvariant(
    history.streak.longestDays <= history.lifetime.activeDayCount,
    'longest streak can never exceed the lifetime active days',
  );

  // Period comparison is a plain difference (null unless both have evidence).
  const current = history.rangeBuckets.current;
  const previous = history.rangeBuckets.previous;
  const comparison = history.priorPeriodComparison;
  assertInvariant(
    comparison.eligibleCaptureDelta ===
      current.eligibleCaptureCount - previous.eligibleCaptureCount &&
      comparison.activeDayDelta ===
        current.activeDayCount - previous.activeDayCount &&
      comparison.trackedPoseDurationDeltaMs ===
        current.trackedPoseDurationMs - previous.trackedPoseDurationMs,
    'integer period deltas must be current − previous',
    comparison,
  );
  const wantRateDelta =
    current.poseAvailability.rate === null ||
    previous.poseAvailability.rate === null
      ? null
      : current.poseAvailability.rate - previous.poseAvailability.rate;
  const wantCoverageDelta =
    current.jointTracking.meanCoverage === null ||
    previous.jointTracking.meanCoverage === null
      ? null
      : current.jointTracking.meanCoverage -
        previous.jointTracking.meanCoverage;
  assertInvariant(
    nearlyEqual(comparison.poseAvailabilityRateDelta, wantRateDelta) &&
      nearlyEqual(comparison.meanJointCoverageDelta, wantCoverageDelta),
    'rate deltas must be null unless both periods carry evidence',
    comparison,
  );

  // Order independence: the same rows in a different order → identical output.
  const reordered = aggregatePracticeHistory(
    [...state.captures].reverse(),
    options,
  );
  assertInvariant(
    stable(reordered) === stable(history),
    'aggregatePracticeHistory must not depend on row order',
  );

  // UI projection agrees with the aggregation for the three product ranges.
  const definition = PRACTICE_HISTORY_RANGES.find(
    range => range.days === state.rangeDays,
  );
  if (definition) {
    const view = buildPracticeHistory(state.captures, {
      asOfIso: state.asOfIso,
      timeZone: state.timeZone,
      range: definition.key,
    });
    assertInvariant(
      view.range === definition.key &&
        view.captureCount === current.eligibleCaptureCount &&
        view.cameraCaptureCount === current.cameraCaptureCount &&
        view.importedCaptureCount === current.importedCaptureCount &&
        view.excludedCaptureCount === history.excludedCaptureCount &&
        view.activeDays === current.activeDayCount &&
        view.currentStreak === history.streak.currentDays &&
        view.longestStreak === history.streak.longestDays &&
        view.trackedDurationMs === current.trackedPoseDurationMs &&
        nearlyEqual(view.meanPoseAvailability, current.poseAvailability.rate) &&
        nearlyEqual(
          view.meanJointCoverage,
          current.jointTracking.meanCoverage,
        ) &&
        view.priorPeriodDelta.captureCount ===
          comparison.eligibleCaptureDelta &&
        view.priorPeriodDelta.activeDays === comparison.activeDayDelta &&
        view.priorPeriodDelta.trackedDurationMs ===
          comparison.trackedPoseDurationDeltaMs &&
        nearlyEqual(
          view.priorPeriodDelta.meanPoseAvailability,
          comparison.poseAvailabilityRateDelta,
        ) &&
        nearlyEqual(
          view.priorPeriodDelta.meanJointCoverage,
          comparison.meanJointCoverageDelta,
        ),
      'buildPracticeHistory must project aggregatePracticeHistory exactly',
    );
    assertInvariant(
      view.buckets.length === history.dayBuckets.length &&
        view.buckets.every(
          (bucket, index) =>
            bucket.key === history.dayBuckets[index]!.day &&
            bucket.count === history.dayBuckets[index]!.eligibleCaptureCount &&
            /^[A-Z][a-z]{2} \d{1,2}$/.test(bucket.label),
        ),
      'chart buckets must mirror day buckets with "Mon D" labels',
      view.buckets.slice(0, 3),
    );
  }
  return history;
}

function historyTrace(history: PracticeHistory): string {
  return stable(history);
}

function runHistorySequence(seed: number): {
  trace: string[];
  outcome: SequenceOutcome;
} {
  const rng = mulberry32(seed);
  const length = int(rng, MIN_LEN, MAX_LEN);
  const asOfMs = EPOCH_2020 + Math.floor(rng() * (EPOCH_2031 - EPOCH_2020));
  const state: HistoryState = {
    captures: [],
    asOfMs,
    asOfIso: new Date(asOfMs).toISOString(),
    timeZone: pick(rng, TIME_ZONES),
    rangeDays: pick(rng, [1, 7, 28, 90, 366, int(rng, 1, 366)]),
    nextId: 0,
  };
  const trace: string[] = [];
  const outcome: SequenceOutcome = {
    module: 'history',
    seed,
    length,
    stepsRun: 0,
    outcome: 'ok',
    determinism: 'n/a',
  };
  for (let step = 0; step < length; step += 1) {
    const action = pick(rng, HISTORY_ACTIONS);
    try {
      applyHistoryAction(rng, state, action);
      trace.push(`${action}:${historyTrace(checkHistory(state))}`);
      outcome.stepsRun = step + 1;
    } catch (error) {
      outcome.outcome = 'fail';
      outcome.failStep = step;
      outcome.action = action;
      outcome.error = describeError(error);
      const failing = (captures: readonly PendingCapture[]): boolean => {
        try {
          checkHistory({ ...state, captures: [...captures] });
          return false;
        } catch {
          return true;
        }
      };
      outcome.minimized = {
        asOfIso: state.asOfIso,
        timeZone: state.timeZone,
        rangeDays: state.rangeDays,
        captures: failing(state.captures)
          ? minimizeList(state.captures, failing)
          : state.captures,
      };
      break;
    }
  }
  return { trace, outcome };
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 2 — practiceSetProgress
// ═══════════════════════════════════════════════════════════════════════════

const STROKES = [
  'forehand_drive',
  'backhand_drive',
  'dink',
  'serve',
  'third_shot_drop',
];
const MODEL_VERSIONS = ['sm-v1', 'sm-v2', 'sm-v3'];
const CHECKPOINTS = [
  'ready_position',
  'preparation',
  'contact_position',
  'follow_through',
];
const MINUS = '\u2212';

interface SetState {
  facts: RealAnalysisFact[];
  asOfMs: number;
  asOfIso: string;
  maxAgeMs: number | undefined;
  sessions: string[];
  currentModel: string;
  nextId: number;
}

function sessionIdFor(index: number): string {
  return `aaaaaaaa-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function oneDecimal(rng: Rng): number {
  return int(rng, 0, 100) / 10;
}

/** A one-decimal score reached through float arithmetic (e.g. 7.4000000000000004). */
function noisyOneDecimal(rng: Rng): number {
  const tenths = int(rng, 0, 100);
  return tenths * 0.1;
}

const SET_ACTIONS = [
  'add_scored',
  'add_scored',
  'add_scored',
  'add_scored_noisy_score',
  'add_scored_other_stroke',
  'add_scored_other_model',
  'add_scored_other_config',
  'add_scored_tie_instant',
  'add_scored_after_asOf',
  'add_abstained',
  'add_scored_null_score',
  'add_scored_bad_timestamp',
  'add_no_session',
  'add_empty_session',
  'add_missing_checkpoints',
  'remove_random',
  'shuffle',
  'shift_asOf',
  'set_maxAge',
  'upgrade_model',
  'new_session',
  'query_invalid_options',
] as const;

type SetAction = (typeof SET_ACTIONS)[number];

function baseFact(rng: Rng, state: SetState): RealAnalysisFact {
  state.nextId += 1;
  const scores: Record<string, number> = {};
  for (const key of CHECKPOINTS) {
    if (chance(rng, 0.7)) {
      // Cluster around the fixed-checkpoint bars so both edges are exercised.
      scores[key] = pick(rng, [
        int(rng, 0, 100),
        FIXED_CHECKPOINT_FROM_BELOW - 1,
        FIXED_CHECKPOINT_FROM_BELOW,
        FIXED_CHECKPOINT_TO_AT_LEAST - 1,
        FIXED_CHECKPOINT_TO_AT_LEAST,
        int(rng, 0, 1000) / 10,
      ]);
    }
  }
  const minutesBack = chance(rng, 0.8)
    ? int(rng, 0, 600)
    : int(rng, 0, 60 * 24 * 40);
  const stroke = chance(rng, 0.75) ? STROKES[0]! : pick(rng, STROKES);
  return {
    id: `fact-${String(state.nextId).padStart(4, '0')}`,
    shotType: stroke,
    capturedAt: new Date(
      state.asOfMs - minutesBack * 60_000 - int(rng, 0, 59_999),
    ).toISOString(),
    overallScore: oneDecimal(rng),
    confidence: int(rng, 50, 100) / 100,
    resultKind: 'scored',
    scoringModelVersion: state.currentModel,
    shotConfigVersion: `${stroke}@1`,
    sessionId: pick(rng, state.sessions),
    priorityCheckpoint: chance(rng, 0.6) ? pick(rng, CHECKPOINTS) : null,
    checkpointScores: scores,
  };
}

function applySetAction(rng: Rng, state: SetState, action: SetAction): void {
  switch (action) {
    case 'add_scored':
      state.facts.push(baseFact(rng, state));
      return;
    case 'add_scored_noisy_score':
      state.facts.push({
        ...baseFact(rng, state),
        overallScore: noisyOneDecimal(rng),
      });
      return;
    case 'add_scored_other_stroke': {
      const stroke = pick(rng, STROKES.slice(1));
      state.facts.push({
        ...baseFact(rng, state),
        shotType: stroke,
        shotConfigVersion: `${stroke}@1`,
      });
      return;
    }
    case 'add_scored_other_model':
      state.facts.push({
        ...baseFact(rng, state),
        scoringModelVersion: pick(
          rng,
          MODEL_VERSIONS.filter(v => v !== state.currentModel),
        ),
      });
      return;
    case 'add_scored_other_config': {
      const fact = baseFact(rng, state);
      state.facts.push({ ...fact, shotConfigVersion: `${fact.shotType}@2` });
      return;
    }
    case 'add_scored_tie_instant': {
      const source = state.facts.length ? pick(rng, state.facts) : null;
      const fact = baseFact(rng, state);
      state.facts.push(
        source ? { ...fact, capturedAt: source.capturedAt } : fact,
      );
      return;
    }
    case 'add_scored_after_asOf': {
      const fact = baseFact(rng, state);
      const ahead = pick(rng, [1, 1000, 60_000, 3_600_000, DAY_MS]);
      state.facts.push({
        ...fact,
        capturedAt: new Date(state.asOfMs + ahead).toISOString(),
      });
      return;
    }
    case 'add_abstained':
      state.facts.push({
        ...baseFact(rng, state),
        resultKind: 'low_confidence',
        overallScore: null,
        priorityCheckpoint: null,
        checkpointScores: {},
      });
      return;
    case 'add_scored_null_score':
      state.facts.push({ ...baseFact(rng, state), overallScore: null });
      return;
    case 'add_scored_bad_timestamp':
      state.facts.push({
        ...baseFact(rng, state),
        capturedAt: pick(rng, ['', 'not-a-date', '2026-13-45T00:00:00Z']),
      });
      return;
    case 'add_no_session':
      state.facts.push({ ...baseFact(rng, state), sessionId: null });
      return;
    case 'add_empty_session':
      state.facts.push({ ...baseFact(rng, state), sessionId: '' });
      return;
    case 'add_missing_checkpoints': {
      // Older readers: no map at all, or a map with junk values.
      const fact = baseFact(rng, state);
      const raw: unknown = pick(rng, [
        undefined,
        null,
        [],
        { ready_position: Number.NaN, preparation: '80', contact_position: 81 },
      ]);
      state.facts.push({
        ...fact,
        checkpointScores: raw as Record<string, number>,
      });
      return;
    }
    case 'remove_random':
      if (!state.facts.length) return;
      state.facts.splice(int(rng, 0, state.facts.length - 1), 1);
      return;
    case 'shuffle':
      state.facts = shuffled(rng, state.facts);
      return;
    case 'shift_asOf': {
      state.asOfMs += pick(rng, [
        1,
        -1,
        60_000,
        -60_000,
        3_600_000,
        -3_600_000,
        DAY_MS,
        -DAY_MS,
        2 * DAY_MS,
        30 * DAY_MS,
      ]);
      state.asOfIso = new Date(state.asOfMs).toISOString();
      return;
    }
    case 'set_maxAge':
      state.maxAgeMs = pick(rng, [
        undefined,
        0,
        1,
        60_000,
        3_600_000,
        DEFAULT_LATEST_SET_MAX_AGE_MS,
        7 * DAY_MS,
        Number.MAX_SAFE_INTEGER,
      ]);
      return;
    case 'upgrade_model':
      state.currentModel = pick(rng, MODEL_VERSIONS);
      return;
    case 'new_session':
      if (state.sessions.length < 5)
        state.sessions.push(sessionIdFor(state.sessions.length + 1));
      return;
    case 'query_invalid_options': {
      const invalid = pick(rng, [
        { asOfIso: 'garbage' },
        { asOfIso: '' },
        { maxAgeMs: -1 },
        { maxAgeMs: Number.NaN },
        { maxAgeMs: Number.NEGATIVE_INFINITY },
      ]);
      let threw = false;
      try {
        latestPracticeSet(state.facts, { asOfIso: state.asOfIso, ...invalid });
      } catch (error) {
        threw = error instanceof Error && !(error instanceof InvariantError);
      }
      assertInvariant(
        threw,
        'invalid latestPracticeSet options must throw an Error',
        invalid,
      );
      return;
    }
  }
}

// Reference model ------------------------------------------------------------

interface RefScored {
  fact: RealAnalysisFact;
  ms: number;
}

function compareIds(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function refScoredInSet(
  facts: readonly RealAnalysisFact[],
  sessionId: string,
): RefScored[] {
  const rows: RefScored[] = [];
  for (const fact of facts) {
    if (fact.sessionId !== sessionId || fact.resultKind !== 'scored') continue;
    if (
      typeof fact.overallScore !== 'number' ||
      !Number.isFinite(fact.overallScore)
    )
      continue;
    const ms = Date.parse(fact.capturedAt);
    if (Number.isNaN(ms)) continue;
    rows.push({ fact, ms });
  }
  return rows.sort(
    (left, right) =>
      left.ms - right.ms || compareIds(left.fact.id, right.fact.id),
  );
}

function refAttempt(row: RefScored): PracticeSetSummary['first'] {
  const scores: Record<string, number> = {};
  const raw: unknown = row.fact.checkpointScores;
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value))
        scores[key] = value;
    }
  }
  return {
    id: row.fact.id,
    capturedAt: row.fact.capturedAt,
    overallScore: row.fact.overallScore as number,
    priorityCheckpoint:
      typeof row.fact.priorityCheckpoint === 'string'
        ? row.fact.priorityCheckpoint
        : null,
    checkpointScores: scores,
  };
}

function refTenths(score: number): number {
  return Math.round(score * 10);
}

function refSummary(
  facts: readonly RealAnalysisFact[],
  sessionId: string,
): PracticeSetSummary | null {
  if (sessionId === '') return null;
  const scored = refScoredInSet(facts, sessionId);
  const newest = scored[scored.length - 1];
  if (newest === undefined) return null;
  const sameStroke = scored.filter(
    row => row.fact.shotType === newest.fact.shotType,
  );
  const comparable = sameStroke.filter(
    row =>
      row.fact.scoringModelVersion === newest.fact.scoringModelVersion &&
      row.fact.shotConfigVersion === newest.fact.shotConfigVersion,
  );
  if (comparable.length < 2) return null;
  const attempts = comparable.map(refAttempt);
  const first = attempts[0]!;
  const latest = attempts[attempts.length - 1]!;
  const bestTenths = Math.max(...attempts.map(a => refTenths(a.overallScore)));
  const best = [...attempts]
    .reverse()
    .find(a => refTenths(a.overallScore) === bestTenths)!;
  const deltaTenths =
    refTenths(latest.overallScore) - refTenths(first.overallScore);
  const fixedCheckpoints = Object.keys(first.checkpointScores).filter(key => {
    const after = latest.checkpointScores[key];
    return (
      after !== undefined &&
      first.checkpointScores[key]! < FIXED_CHECKPOINT_FROM_BELOW &&
      after >= FIXED_CHECKPOINT_TO_AT_LEAST
    );
  });
  return {
    sessionId,
    shotType: newest.fact.shotType,
    attempts,
    first,
    latest,
    best,
    deltaTenths,
    trend:
      deltaTenths >= PRACTICE_SET_TREND_THRESHOLD_TENTHS
        ? 'improved'
        : deltaTenths <= -PRACTICE_SET_TREND_THRESHOLD_TENTHS
          ? 'slipped'
          : 'held',
    fixedCheckpoints,
    stillOpen: latest.priorityCheckpoint,
    excludedCount: sameStroke.length - comparable.length,
    startedAt: first.capturedAt,
    endedAt: latest.capturedAt,
  };
}

function refLatest(
  facts: readonly RealAnalysisFact[],
  asOfMs: number,
  maxAgeMs: number,
): PracticeSetSummary | null {
  const visible = facts.filter(fact => {
    const ms = Date.parse(fact.capturedAt);
    return !Number.isNaN(ms) && ms <= asOfMs;
  });
  const latestBySession = new Map<string, number>();
  for (const fact of visible) {
    if (
      fact.sessionId === null ||
      fact.resultKind !== 'scored' ||
      typeof fact.overallScore !== 'number' ||
      !Number.isFinite(fact.overallScore)
    ) {
      continue;
    }
    const ms = Date.parse(fact.capturedAt);
    latestBySession.set(
      fact.sessionId,
      Math.max(latestBySession.get(fact.sessionId) ?? -Infinity, ms),
    );
  }
  const ordered = [...latestBySession.entries()]
    .filter(([, ms]) => asOfMs - ms <= maxAgeMs)
    .sort((left, right) => right[1] - left[1] || compareIds(left[0], right[0]));
  for (const [sessionId] of ordered) {
    const summary = refSummary(visible, sessionId);
    if (summary) return summary;
  }
  return null;
}

function checkSummaryCopy(summary: PracticeSetSummary): void {
  const headline = practiceSetHeadline(summary);
  const insight = practiceSetInsight(summary);
  if (summary.trend === 'held') {
    assertInvariant(
      headline === 'Held steady in this set',
      'held headline copy',
      headline,
    );
  } else {
    assertInvariant(
      /^[+\u2212]\d+\.\d in this set$/.test(headline),
      'signed headline must use +/U+2212 with one decimal',
      headline,
    );
    const sign = summary.trend === 'improved' ? '+' : MINUS;
    assertInvariant(
      headline.startsWith(sign),
      'headline sign must follow the trend',
      {
        headline,
        trend: summary.trend,
      },
    );
    const magnitude = (Math.abs(summary.deltaTenths) / 10).toFixed(1);
    assertInvariant(
      headline === `${sign}${magnitude} in this set`,
      'headline magnitude must be the exact tenths delta',
      { headline, deltaTenths: summary.deltaTenths },
    );
  }
  assertInvariant(
    !headline.includes('-'),
    'headline must never use an ASCII hyphen',
    headline,
  );
  const count = summary.attempts.length;
  const bestDisplay = (refTenths(summary.best.overallScore) / 10).toFixed(1);
  assertInvariant(
    insight.startsWith(
      `${count} attempt${count === 1 ? '' : 's'} · best ${bestDisplay}`,
    ),
    'insight must open with attempt count and the best score in tenths',
    { insight, count, bestDisplay },
  );
  assertInvariant(
    !/NaN|undefined|null|Infinity/.test(insight),
    'insight must never leak NaN/undefined/null',
    insight,
  );
  assertInvariant(
    insight.includes('not compared') === summary.excludedCount > 0,
    'insight mentions non-compared attempts iff excludedCount > 0',
    { insight, excludedCount: summary.excludedCount },
  );
  if (summary.excludedCount > 0) {
    assertInvariant(
      insight.includes(
        `${summary.excludedCount} attempt${summary.excludedCount === 1 ? '' : 's'} on a different scoring model not compared`,
      ),
      'excluded clause must carry the exact count with correct plural',
      insight,
    );
  }
  const fixed = summary.fixedCheckpoints[0];
  if (fixed !== undefined) {
    const before = summary.first.checkpointScores[fixed]!;
    const after = summary.latest.checkpointScores[fixed]!;
    assertInvariant(
      insight.includes(
        `improved from ${Math.round(before)} to ${Math.round(after)}`,
      ) && Math.round(before) < Math.round(after),
      'fixed-checkpoint clause must state before→after with before < after',
      { insight, before, after },
    );
  } else if (summary.stillOpen !== null) {
    assertInvariant(
      insight.includes('still open'),
      'still-open clause expected',
      insight,
    );
  } else {
    assertInvariant(
      !insight.includes('still open') && !insight.includes('improved from'),
      'no checkpoint clause when nothing is fixed or open',
      insight,
    );
  }
}

function checkSummaryShape(
  summary: PracticeSetSummary,
  facts: readonly RealAnalysisFact[],
): void {
  const ids = new Set<string>();
  let previousMs = -Infinity;
  let previousId = '';
  for (const attempt of summary.attempts) {
    const ms = Date.parse(attempt.capturedAt);
    assertInvariant(
      ms > previousMs ||
        (ms === previousMs && compareIds(previousId, attempt.id) < 0),
      'attempts must be chronological with id tie-break',
      summary.attempts.map(a => [a.capturedAt, a.id]),
    );
    previousMs = ms;
    previousId = attempt.id;
    ids.add(attempt.id);
    const source = facts.find(fact => fact.id === attempt.id);
    assertInvariant(
      source !== undefined &&
        source.sessionId === summary.sessionId &&
        source.shotType === summary.shotType &&
        source.resultKind === 'scored' &&
        source.overallScore === attempt.overallScore,
      'every attempt must be a scored fact of this set and stroke',
      attempt.id,
    );
    assertInvariant(
      Object.values(attempt.checkpointScores).every(value =>
        Number.isFinite(value),
      ),
      'checkpoint scores must be finite numbers only',
      attempt.checkpointScores,
    );
  }
  assertInvariant(
    ids.size === summary.attempts.length,
    'attempt ids must be unique',
  );
  assertInvariant(
    summary.attempts.length >= 2,
    'a summary needs at least two attempts',
  );
  assertInvariant(
    summary.first === summary.attempts[0] &&
      summary.latest === summary.attempts[summary.attempts.length - 1],
    'first/latest must be the chronological ends',
  );
  assertInvariant(
    summary.attempts.includes(summary.best) &&
      summary.attempts.every(
        a =>
          scoreTenths(a.overallScore) <= scoreTenths(summary.best.overallScore),
      ) &&
      summary.attempts
        .slice(summary.attempts.indexOf(summary.best) + 1)
        .every(
          a =>
            scoreTenths(a.overallScore) <
            scoreTenths(summary.best.overallScore),
        ),
    'best must be the maximum in tenths, ties resolved to the most recent',
  );
  assertInvariant(
    summary.deltaTenths ===
      scoreTenths(summary.latest.overallScore) -
        scoreTenths(summary.first.overallScore) &&
      Number.isInteger(summary.deltaTenths) &&
      Math.abs(summary.deltaTenths) <= 100,
    'deltaTenths must be the exact integer latest − first',
    summary.deltaTenths,
  );
  assertInvariant(
    summary.excludedCount >= 0 &&
      Date.parse(summary.startedAt) <= Date.parse(summary.endedAt) &&
      summary.stillOpen === summary.latest.priorityCheckpoint,
    'excludedCount ≥ 0, startedAt ≤ endedAt, stillOpen = latest priority',
  );
  for (const key of summary.fixedCheckpoints) {
    assertInvariant(
      summary.first.checkpointScores[key]! < FIXED_CHECKPOINT_FROM_BELOW &&
        summary.latest.checkpointScores[key]! >= FIXED_CHECKPOINT_TO_AT_LEAST,
      'fixed checkpoints must cross both bars',
      key,
    );
  }
}

function checkPracticeSets(state: SetState): string {
  const sessionIds = new Set<string>([...state.sessions, '']);
  for (const fact of state.facts)
    if (fact.sessionId !== null) sessionIds.add(fact.sessionId);
  const traces: string[] = [];
  for (const sessionId of [...sessionIds].sort()) {
    const summary = summarizePracticeSet(state.facts, sessionId);
    const want = refSummary(state.facts, sessionId);
    assertInvariant(
      stable(summary) === stable(want),
      'summarizePracticeSet disagrees with the reference model',
      { sessionId, got: summary, want },
    );
    const reordered = summarizePracticeSet(
      [...state.facts].reverse(),
      sessionId,
    );
    assertInvariant(
      stable(reordered) === stable(summary),
      'summarizePracticeSet must not depend on row order',
      sessionId,
    );
    if (summary) {
      checkSummaryShape(summary, state.facts);
      checkSummaryCopy(summary);
      traces.push(`${sessionId}=${stable(summary)}`);
    } else {
      traces.push(`${sessionId}=null`);
    }
  }
  const options = { asOfIso: state.asOfIso, maxAgeMs: state.maxAgeMs };
  const latest = latestPracticeSet(state.facts, options);
  const wantLatest = refLatest(
    state.facts,
    state.asOfMs,
    state.maxAgeMs ?? DEFAULT_LATEST_SET_MAX_AGE_MS,
  );
  assertInvariant(
    stable(latest) === stable(wantLatest),
    'latestPracticeSet disagrees with the reference model',
    { got: latest?.sessionId ?? null, want: wantLatest?.sessionId ?? null },
  );
  if (latest) {
    const endedMs = Date.parse(latest.endedAt);
    assertInvariant(
      endedMs <= state.asOfMs &&
        state.asOfMs - endedMs <=
          (state.maxAgeMs ?? DEFAULT_LATEST_SET_MAX_AGE_MS) &&
        latest.attempts.every(a => Date.parse(a.capturedAt) <= state.asOfMs),
      'latest set must end within the window and never look past asOf',
      {
        endedAt: latest.endedAt,
        asOfIso: state.asOfIso,
        maxAgeMs: state.maxAgeMs,
      },
    );
  }
  const reorderedLatest = latestPracticeSet(
    [...state.facts].reverse(),
    options,
  );
  assertInvariant(
    stable(reorderedLatest) === stable(latest),
    'latestPracticeSet must not depend on row order',
  );
  traces.push(`latest=${stable(latest)}`);
  return traces.join('|');
}

function runSetSequence(seed: number): {
  trace: string[];
  outcome: SequenceOutcome;
} {
  const rng = mulberry32(seed);
  const length = int(rng, MIN_LEN, MAX_LEN);
  const asOfMs = EPOCH_2020 + Math.floor(rng() * (EPOCH_2031 - EPOCH_2020));
  const state: SetState = {
    facts: [],
    asOfMs,
    asOfIso: new Date(asOfMs).toISOString(),
    maxAgeMs: undefined,
    sessions: [sessionIdFor(1)],
    currentModel: 'sm-v2',
    nextId: 0,
  };
  const trace: string[] = [];
  const outcome: SequenceOutcome = {
    module: 'practiceSet',
    seed,
    length,
    stepsRun: 0,
    outcome: 'ok',
    determinism: 'n/a',
  };
  for (let step = 0; step < length; step += 1) {
    const action = pick(rng, SET_ACTIONS);
    try {
      applySetAction(rng, state, action);
      trace.push(`${action}:${checkPracticeSets(state)}`);
      outcome.stepsRun = step + 1;
    } catch (error) {
      outcome.outcome = 'fail';
      outcome.failStep = step;
      outcome.action = action;
      outcome.error = describeError(error);
      const failing = (facts: readonly RealAnalysisFact[]): boolean => {
        try {
          checkPracticeSets({ ...state, facts: [...facts] });
          return false;
        } catch {
          return true;
        }
      };
      outcome.minimized = {
        asOfIso: state.asOfIso,
        maxAgeMs: state.maxAgeMs,
        facts: failing(state.facts)
          ? minimizeList(state.facts, failing)
          : state.facts,
      };
      break;
    }
  }
  return { trace, outcome };
}

// ═══════════════════════════════════════════════════════════════════════════
// Module 3 — progress/api fetchCanonicalProgress
// ═══════════════════════════════════════════════════════════════════════════

const session: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'stress-token',
  canonicalAppUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'apple',
};

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Values a JSON body can legally carry in place of a number/string. */
const JUNK: readonly Json[] = [
  null,
  '',
  ' ',
  'abc',
  '12',
  '7.5',
  '1e3',
  ' 7 ',
  '0x1A',
  '-0',
  'NaN',
  'Infinity',
  true,
  false,
  [],
  [5],
  ['8'],
  {},
  { value: 1 },
  -1,
  0,
  12.5,
  1e308,
  -0,
];

function validPayload(rng: Rng): { [key: string]: Json } {
  const series: Json[] = [];
  for (let index = 0, n = int(rng, 0, 5); index < n; index += 1) {
    series.push({
      day: `2026-0${int(rng, 1, 9)}-${String(int(rng, 1, 28)).padStart(2, '0')}`,
      shot_type: pick(rng, STROKES),
      scoring_model_version: pick(rng, MODEL_VERSIONS),
      shot_count: int(rng, 0, 40),
      avg_score: chance(rng, 0.5)
        ? int(rng, 0, 1000) / 10
        : String(int(rng, 0, 1000) / 10),
      best_score: chance(rng, 0.5)
        ? int(rng, 0, 1000) / 10
        : `${int(rng, 0, 100)}.0`,
    });
  }
  const improving: Json[] = [];
  for (let index = 0, n = int(rng, 0, 3); index < n; index += 1) {
    improving.push({
      checkpoint: pick(rng, CHECKPOINTS),
      delta: int(rng, -100, 100) / 10,
    });
  }
  const needsAttention: Json[] = [];
  for (let index = 0, n = int(rng, 0, 3); index < n; index += 1) {
    needsAttention.push({
      checkpoint: pick(rng, CHECKPOINTS),
      avg: int(rng, 0, 1000) / 10,
    });
  }
  return {
    series,
    improving,
    needsAttention,
    streak: {
      currentDays: int(rng, 0, 30),
      longestDays: int(rng, 0, 400),
      practicedToday: chance(rng, 0.5),
      lastPracticeDate: chance(rng, 0.8) ? '2026-08-27' : null,
    },
  };
}

type Mutation =
  | { kind: 'none' }
  | { kind: 'top_delete'; key: string }
  | { kind: 'top_replace'; key: string; value: Json }
  | {
      kind: 'row_field';
      list: 'series' | 'improving' | 'needsAttention';
      field: string;
      value: Json | undefined;
    }
  | {
      kind: 'row_replace';
      list: 'series' | 'improving' | 'needsAttention';
      value: Json;
    }
  | { kind: 'streak_field'; field: string; value: Json | undefined }
  | { kind: 'extra_keys' }
  | { kind: 'wrap_array' }
  | { kind: 'scalar_body'; value: Json };

function mutate(
  rng: Rng,
  payload: { [key: string]: Json },
): { body: Json; mutation: Mutation } {
  const roll = rng();
  if (roll < 0.35) return { body: payload, mutation: { kind: 'none' } };
  const top = ['series', 'improving', 'needsAttention', 'streak'] as const;
  if (roll < 0.42) {
    const key = pick(rng, top);
    const rest = { ...payload };
    delete rest[key];
    return { body: rest, mutation: { kind: 'top_delete', key } };
  }
  if (roll < 0.5) {
    const key = pick(rng, top);
    const value = pick(rng, JUNK);
    return {
      body: { ...payload, [key]: value },
      mutation: { kind: 'top_replace', key, value },
    };
  }
  if (roll < 0.72) {
    const list = pick(rng, ['series', 'improving', 'needsAttention'] as const);
    const rows = [...(payload[list] as Json[])];
    const fields =
      list === 'series'
        ? [
            'day',
            'shot_type',
            'scoring_model_version',
            'shot_count',
            'avg_score',
            'best_score',
          ]
        : list === 'improving'
          ? ['checkpoint', 'delta']
          : ['checkpoint', 'avg'];
    const field = pick(rng, fields);
    const value = chance(rng, 0.15) ? undefined : pick(rng, JUNK);
    const row = {
      ...((rows.length ? pick(rng, rows) : null) as {
        [key: string]: Json;
      } | null),
    };
    if (value === undefined) delete row[field];
    else row[field] = value;
    rows.splice(int(rng, 0, rows.length), 0, row);
    return {
      body: { ...payload, [list]: rows },
      mutation: { kind: 'row_field', list, field, value },
    };
  }
  if (roll < 0.78) {
    const list = pick(rng, ['series', 'improving', 'needsAttention'] as const);
    const value = pick(rng, JUNK);
    const rows = [...(payload[list] as Json[]), value];
    return {
      body: { ...payload, [list]: rows },
      mutation: { kind: 'row_replace', list, value },
    };
  }
  if (roll < 0.9) {
    const field = pick(rng, [
      'currentDays',
      'longestDays',
      'practicedToday',
      'lastPracticeDate',
    ]);
    const value = chance(rng, 0.15) ? undefined : pick(rng, JUNK);
    const streak = { ...(payload['streak'] as { [key: string]: Json }) };
    if (value === undefined) delete streak[field];
    else streak[field] = value;
    return {
      body: { ...payload, streak },
      mutation: { kind: 'streak_field', field, value },
    };
  }
  if (roll < 0.94) {
    return {
      body: { ...payload, extra: { nested: [1, 2, 3] }, version: 'x' },
      mutation: { kind: 'extra_keys' },
    };
  }
  if (roll < 0.97) return { body: [payload], mutation: { kind: 'wrap_array' } };
  const value = pick(rng, JUNK);
  return { body: value, mutation: { kind: 'scalar_body', value } };
}

/** Strict reading of the documented contract ("rejects malformed metrics
 * rather than filling them with guesses"): a metric is a finite number or a
 * non-blank numeric string; anything else is malformed. */
type StrictNumber =
  { ok: true; value: number } | { ok: false; coerced: number | null };

function strictNumber(value: unknown): StrictNumber {
  const coerced = typeof value === 'number' ? value : Number(value);
  const coercedOrNull = Number.isFinite(coerced) ? coerced : null;
  if (typeof value === 'number' && Number.isFinite(value))
    return { ok: true, value };
  if (
    typeof value === 'string' &&
    value.trim() !== '' &&
    Number.isFinite(Number(value))
  ) {
    return { ok: true, value: Number(value) };
  }
  return { ok: false, coerced: coercedOrNull };
}

interface OracleResult {
  /** 'valid' → must resolve; 'invalid' → must reject with ProgressApiError;
   * 'coerced' → strict contract rejects, but production's Number() coercion
   * accepts (documented divergence, tracked separately). */
  verdict: 'valid' | 'invalid' | 'coerced';
  value?: CanonicalProgress;
  coercions: string[];
}

function oracleParse(body: Json): OracleResult {
  const coercions: string[] = [];
  const isRecord = (
    value: Json | undefined,
  ): value is { [key: string]: Json } =>
    value !== undefined &&
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value);
  const invalid = (): OracleResult => ({ verdict: 'invalid', coercions });
  if (!isRecord(body)) return invalid();
  const series = body['series'];
  const improving = body['improving'];
  const needsAttention = body['needsAttention'];
  const streak = body['streak'];
  if (
    !Array.isArray(series) ||
    !Array.isArray(improving) ||
    !Array.isArray(needsAttention) ||
    !isRecord(streak)
  ) {
    return invalid();
  }
  const number = (value: Json | undefined, path: string): number | null => {
    const strict = strictNumber(value);
    if (strict.ok) return strict.value;
    if (strict.coerced === null) return null;
    coercions.push(`${path}=${JSON.stringify(value)}→${strict.coerced}`);
    return strict.coerced;
  };
  const outSeries: CanonicalProgress['series'] = [];
  for (const row of series) {
    if (!isRecord(row)) return invalid();
    const shotCount = number(row['shot_count'], 'shot_count');
    const avg = number(row['avg_score'], 'avg_score');
    const best = number(row['best_score'], 'best_score');
    if (
      typeof row['day'] !== 'string' ||
      typeof row['shot_type'] !== 'string' ||
      typeof row['scoring_model_version'] !== 'string' ||
      shotCount === null ||
      avg === null ||
      best === null
    ) {
      return invalid();
    }
    outSeries.push({
      day: row['day'],
      shotType: row['shot_type'],
      scoringModelVersion: row['scoring_model_version'],
      shotCount,
      avgScore: avg / 10,
      bestScore: best / 10,
    });
  }
  const outImproving: CanonicalProgress['improving'] = [];
  for (const row of improving) {
    if (!isRecord(row)) return invalid();
    const delta = number(row['delta'], 'delta');
    if (typeof row['checkpoint'] !== 'string' || delta === null)
      return invalid();
    outImproving.push({ checkpoint: row['checkpoint'], delta });
  }
  const outNeeds: CanonicalProgress['needsAttention'] = [];
  for (const row of needsAttention) {
    if (!isRecord(row)) return invalid();
    const avg = number(row['avg'], 'avg');
    if (typeof row['checkpoint'] !== 'string' || avg === null) return invalid();
    outNeeds.push({ checkpoint: row['checkpoint'], avg });
  }
  const currentDays = number(streak['currentDays'], 'currentDays');
  const longestDays = number(streak['longestDays'], 'longestDays');
  const practicedToday = streak['practicedToday'];
  const lastPracticeDate = streak['lastPracticeDate'];
  if (
    currentDays === null ||
    longestDays === null ||
    typeof practicedToday !== 'boolean' ||
    !(lastPracticeDate === null || typeof lastPracticeDate === 'string')
  ) {
    return invalid();
  }
  return {
    verdict: coercions.length ? 'coerced' : 'valid',
    coercions,
    value: {
      series: outSeries,
      improving: outImproving,
      needsAttention: outNeeds,
      streak: { currentDays, longestDays, practicedToday, lastPracticeDate },
    },
  };
}

type Transport =
  | { kind: 'json'; status: number }
  | { kind: 'invalid_json'; status: number }
  | { kind: 'empty_body'; status: number }
  | { kind: 'reject'; error: string }
  | { kind: 'throw_sync' }
  | { kind: 'abort_error' };

/** Statuses a Response may carry a body with (the fetch spec forbids a body
 * on 204/205/304, so those only appear as empty bodies). */
const BODY_STATUSES = [
  200, 200, 200, 200, 201, 400, 401, 403, 404, 429, 500, 502, 503,
];
const EMPTY_STATUSES = [...BODY_STATUSES, 204, 205, 304];

function transportFor(rng: Rng): Transport {
  const roll = rng();
  if (roll < 0.7) return { kind: 'json', status: pick(rng, BODY_STATUSES) };
  if (roll < 0.8) {
    return { kind: 'invalid_json', status: pick(rng, BODY_STATUSES) };
  }
  if (roll < 0.88) {
    return { kind: 'empty_body', status: pick(rng, EMPTY_STATUSES) };
  }
  if (roll < 0.94)
    return {
      kind: 'reject',
      error: pick(rng, ['TypeError', 'Error', 'string']),
    };
  if (roll < 0.97) return { kind: 'throw_sync' };
  return { kind: 'abort_error' };
}

interface ApiStep {
  transport: Transport;
  mutation: Mutation;
  body: Json;
}

interface ApiStepResult {
  outcome: 'resolved' | 'rejected';
  value?: CanonicalProgress;
  message?: string;
  errorName?: string;
  coercions: string[];
}

async function runApiStep(step: ApiStep): Promise<ApiStepResult> {
  let seenInit: RequestInit | undefined;
  let seenUrl = '';
  const fetchFn: ProgressFetch = (url, init) => {
    seenUrl = url;
    seenInit = init;
    const transport = step.transport;
    switch (transport.kind) {
      case 'json':
        return Promise.resolve(
          new Response(JSON.stringify(step.body), {
            status: transport.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      case 'invalid_json':
        return Promise.resolve(
          new Response('{"series": [', { status: transport.status }),
        );
      case 'empty_body':
        return Promise.resolve(
          new Response(null, { status: transport.status }),
        );
      case 'reject':
        return Promise.reject(
          transport.error === 'TypeError'
            ? new TypeError('Network request failed')
            : transport.error === 'Error'
              ? new Error('socket hang up')
              : 'offline',
        );
      case 'throw_sync':
        throw new Error('synchronous transport failure');
      case 'abort_error': {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        return Promise.reject(error);
      }
    }
  };

  const setSpy = jest.spyOn(globalThis, 'setTimeout');
  const clearSpy = jest.spyOn(globalThis, 'clearTimeout');
  let result: ApiStepResult;
  try {
    const value = await fetchCanonicalProgress(session, fetchFn);
    result = { outcome: 'resolved', value, coercions: [] };
  } catch (error) {
    if (!(error instanceof ProgressApiError)) {
      throw new InvariantError(
        'fetchCanonicalProgress must only ever reject with ProgressApiError',
        {
          name: error instanceof Error ? error.name : typeof error,
          transport: step.transport,
        },
      );
    }
    result = {
      outcome: 'rejected',
      message: error.message,
      errorName: error.name,
      coercions: [],
    };
  } finally {
    // The deadline timer must be armed exactly once and always cleared.
    const timers = setSpy.mock.results.map(entry => entry.value as unknown);
    const cleared = clearSpy.mock.calls.map(call => call[0] as unknown);
    setSpy.mockRestore();
    clearSpy.mockRestore();
    assertInvariant(
      timers.length === 1 && cleared.length === 1 && cleared[0] === timers[0],
      'deadline timer must be set once and cleared with its own handle',
      { set: timers.length, cleared: cleared.length },
    );
  }

  // Request shape: URL, headers, live abort signal.
  assertInvariant(
    seenUrl === `${session.apiBaseUrl}/v1/progress`,
    'request URL',
    seenUrl,
  );
  const headers = (seenInit?.headers ?? {}) as Record<string, string>;
  assertInvariant(
    seenInit?.method === 'GET' &&
      headers['Authorization'] === `Bearer ${session.bearerToken}` &&
      headers['Accept'] === 'application/json' &&
      typeof headers['X-Client-Version'] === 'string' &&
      headers['X-Client-Version'].length > 0 &&
      seenInit?.signal instanceof AbortSignal &&
      seenInit.signal.aborted === false,
    'request must carry GET, bearer, Accept, client version and a live signal',
    { method: seenInit?.method, headers },
  );

  // Oracle: outcome must follow transport + strict payload contract.
  const transport = step.transport;
  const httpOk =
    transport.kind === 'json' ||
    transport.kind === 'invalid_json' ||
    transport.kind === 'empty_body'
      ? transport.status >= 200 && transport.status <= 299
      : false;
  if (!httpOk || transport.kind !== 'json') {
    assertInvariant(
      result.outcome === 'rejected' &&
        result.message ===
          (httpOk
            ? 'The progress server returned an invalid response.'
            : 'Account progress is temporarily unavailable.'),
      'transport failures / non-2xx / unparseable bodies must reject with the documented copy',
      { transport, got: result },
    );
    return result;
  }
  const oracle = oracleParse(step.body);
  if (oracle.verdict === 'invalid') {
    assertInvariant(
      result.outcome === 'rejected' &&
        ((result.message ?? '').startsWith('Invalid') ||
          result.message ===
            'The progress server returned an invalid response.'),
      'malformed payloads must be rejected',
      { mutation: step.mutation, got: result },
    );
    return result;
  }
  assertInvariant(
    result.outcome === 'resolved' &&
      stable(result.value) === stable(oracle.value),
    oracle.verdict === 'valid'
      ? 'valid payloads must resolve to the oracle value (scores ÷ 10)'
      : 'coerced payloads resolve to Number()-coerced metrics (documented divergence)',
    { mutation: step.mutation, got: result, want: oracle.value },
  );
  result.coercions = oracle.coercions;
  return result;
}

async function runApiSequence(
  seed: number,
): Promise<{ trace: string[]; outcome: SequenceOutcome }> {
  const rng = mulberry32(seed);
  const length = int(rng, MIN_LEN, MAX_LEN);
  const trace: string[] = [];
  const outcome: SequenceOutcome = {
    module: 'api',
    seed,
    length,
    stepsRun: 0,
    outcome: 'ok',
    determinism: 'n/a',
    notes: { coerced_steps: 0, resolved: 0, rejected: 0 },
  };
  for (let index = 0; index < length; index += 1) {
    const transport = transportFor(rng);
    const { body, mutation } = mutate(rng, validPayload(rng));
    const step: ApiStep = { transport, mutation, body };
    try {
      const result = await runApiStep(step);
      const notes = outcome.notes ?? {};
      notes[result.outcome] = (notes[result.outcome] ?? 0) + 1;
      if (result.coercions.length) {
        notes['coerced_steps'] = (notes['coerced_steps'] ?? 0) + 1;
        (outcome.coercions ??= []).push({
          step: index,
          coercions: result.coercions,
          body: step.body,
        });
      }
      outcome.notes = notes;
      trace.push(`${transport.kind}:${mutation.kind}:${stable(result)}`);
      outcome.stepsRun = index + 1;
    } catch (error) {
      outcome.outcome = 'fail';
      outcome.failStep = index;
      outcome.action = `${transport.kind}/${mutation.kind}`;
      outcome.error = describeError(error);
      outcome.minimized = step;
      break;
    }
  }
  return { trace, outcome };
}

// ═══════════════════════════════════════════════════════════════════════════
// Campaigns
// ═══════════════════════════════════════════════════════════════════════════

const CAMPAIGN_TIMEOUT_MS = 20 * 60_000;

function recordDeterminism(
  outcome: SequenceOutcome,
  first: readonly string[],
  second: readonly string[],
): void {
  const identical =
    first.length === second.length &&
    first.every((entry, i) => entry === second[i]);
  outcome.determinism = identical ? 'identical' : 'diverged';
  if (!identical && outcome.outcome === 'ok') {
    outcome.outcome = 'fail';
    outcome.error =
      'determinism: replaying the same seed produced a different trace';
    outcome.failStep = first.findIndex((entry, i) => entry !== second[i]);
  }
}

function failuresOf(outcomes: readonly SequenceOutcome[]): string[] {
  return outcomes
    .filter(entry => entry.outcome === 'fail')
    .map(
      entry =>
        `${entry.module} seed=${entry.seed} step=${entry.failStep} action=${entry.action} :: ${entry.error}`,
    );
}

afterAll(() => {
  if (!OUT) return;
  mkdirSync(dirname(OUT), { recursive: true });
  const summary = {
    generatedAt: new Date().toISOString(),
    seedBase: SEED_BASE,
    iterationsPerModule: ITER,
    sequenceLength: { min: MIN_LEN, max: MAX_LEN },
    sequences: table.length,
    stepsExecuted: table.reduce((sum, entry) => sum + entry.stepsRun, 0),
    failures: table.filter(entry => entry.outcome === 'fail').length,
    determinismDiverged: table.filter(entry => entry.determinism === 'diverged')
      .length,
    apiCoercedSteps: table
      .filter(entry => entry.module === 'api')
      .reduce((sum, entry) => sum + (entry.notes?.['coerced_steps'] ?? 0), 0),
    byModule: (['history', 'practiceSet', 'api'] as const).map(module => {
      const rows = table.filter(entry => entry.module === module);
      return {
        module,
        sequences: rows.length,
        stepsExecuted: rows.reduce((sum, entry) => sum + entry.stepsRun, 0),
        failures: rows.filter(entry => entry.outcome === 'fail').length,
      };
    }),
  };
  writeFileSync(
    OUT,
    `${JSON.stringify({ summary, sequences: table }, null, 2)}\n`,
  );
});

describe('stress · progress module · randomized-seeded long-run', () => {
  it(
    `practiceHistory: ${ITER} seeded sequences (5–60 actions) hold the aggregation invariants and replay identically`,
    () => {
      const outcomes: SequenceOutcome[] = [];
      for (const seed of seedsFor('history', 1)) {
        const first = runHistorySequence(seed);
        const second = runHistorySequence(seed);
        recordDeterminism(first.outcome, first.trace, second.trace);
        outcomes.push(first.outcome);
      }
      table.push(...outcomes);
      expect(failuresOf(outcomes)).toEqual([]);
      expect(outcomes.every(entry => entry.determinism === 'identical')).toBe(
        true,
      );
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it(
    `practiceSetProgress: ${ITER} seeded sequences (5–60 actions) match the reference set arithmetic and replay identically`,
    () => {
      const outcomes: SequenceOutcome[] = [];
      for (const seed of seedsFor('practiceSet', 2)) {
        const first = runSetSequence(seed);
        const second = runSetSequence(seed);
        recordDeterminism(first.outcome, first.trace, second.trace);
        outcomes.push(first.outcome);
      }
      table.push(...outcomes);
      expect(failuresOf(outcomes)).toEqual([]);
      expect(outcomes.every(entry => entry.determinism === 'identical')).toBe(
        true,
      );
    },
    CAMPAIGN_TIMEOUT_MS,
  );

  it(
    `progress/api: ${ITER} seeded request sequences (5–60 responses) reject every malformed body with ProgressApiError, clear the deadline, and replay identically`,
    async () => {
      const outcomes: SequenceOutcome[] = [];
      for (const seed of seedsFor('api', 3)) {
        const first = await runApiSequence(seed);
        const second = await runApiSequence(seed);
        recordDeterminism(first.outcome, first.trace, second.trace);
        outcomes.push(first.outcome);
      }
      table.push(...outcomes);
      expect(failuresOf(outcomes)).toEqual([]);
      expect(outcomes.every(entry => entry.determinism === 'identical')).toBe(
        true,
      );
    },
    CAMPAIGN_TIMEOUT_MS,
  );
});
