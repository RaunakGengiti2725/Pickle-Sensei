import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  assertCapturedClip,
  type CapturedClip,
} from '../../src/camera/capture';
import type { PendingCapture } from '../../src/data/repository';
import {
  aggregatePracticeHistory,
  buildPracticeHistory,
  PRACTICE_HISTORY_RANGES,
  type PracticeHistory,
  type PracticeHistoryOptions,
  type PracticeHistoryRangeKey,
  type PracticeHistoryResult,
  type PracticeMetrics,
} from '../../src/progress/practiceHistory';

/**
 * Seeded boundary/malformed-input campaign for the practice-history
 * aggregation (`aggregatePracticeHistory` / `buildPracticeHistory`).
 *
 * Every iteration is replayable from its seed:
 *   STRESS_ITER=<n>        iterations (default 200; the campaign run uses 1500)
 *   STRESS_SEED=<base>     base seed (default 0x48495354)
 *   STRESS_REPLAY=<s1,s2>  run exactly these iteration seeds
 *   STRESS_OUT=<dir>       write the seed → outcome JSON table there
 *
 * Captures reach the aggregation exactly the way the repository produces
 * them: a stored row (metadata columns + payload JSON) is re-validated with
 * the real `assertCapturedClip` and the row's metadata-match rule, so every
 * `evidenceStatus` here is one the repository could actually emit.
 *
 * Oracle: an independent reading of the documented option grammar (asOfIso
 * must be an ISO instant with an explicit zone, timeZone a non-blank zone
 * Intl accepts, rangeDays an integer 1..366). Invalid options must be
 * refused with one of the documented `Error` messages; valid options must
 * produce a result that satisfies the structural invariants below and is
 * deterministic and order-independent.
 */

const ITERATIONS = Number.parseInt(process.env.STRESS_ITER ?? '', 10) || 200;
const BASE_SEED =
  Number.parseInt(process.env.STRESS_SEED ?? '', 10) || 0x48495354;
const REPLAY = (process.env.STRESS_REPLAY ?? '')
  .split(',')
  .map(part => Number.parseInt(part, 10))
  .filter(seed => Number.isFinite(seed));
const OUT_DIR = process.env.STRESS_OUT;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function iterationSeeds(): number[] {
  if (REPLAY.length > 0) return REPLAY;
  return Array.from(
    { length: ITERATIONS },
    (_, index) => (BASE_SEED + index * 0x9e3779b9) >>> 0,
  );
}

class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  float(): number {
    return this.next();
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  range(min: number, maxInclusive: number): number {
    return min + this.int(maxInclusive - min + 1);
  }
  chance(probability: number): boolean {
    return this.next() < probability;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)] as T;
  }
  shuffle<T>(items: readonly T[]): T[] {
    const copy = [...items];
    for (let index = copy.length - 1; index > 0; index -= 1) {
      const swap = this.int(index + 1);
      const held = copy[index] as T;
      copy[index] = copy[swap] as T;
      copy[swap] = held;
    }
    return copy;
  }
}

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Option pools
// ---------------------------------------------------------------------------

const VALID_ZONES = [
  'UTC',
  'Etc/UTC',
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'Asia/Tokyo',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'Pacific/Apia',
  'Pacific/Pago_Pago',
  'Etc/GMT+12',
  'Etc/GMT-14',
  'Asia/Calcutta',
  'US/Pacific',
  'EST5EDT',
  'utc',
  'america/new_york',
];

const HOSTILE_ZONES = [
  '',
  ' ',
  '\t',
  '\u0000',
  'UTC\u0000',
  'Mars/Olympus_Mons',
  '../../etc/localtime',
  '/etc/localtime',
  'GMT+5',
  '+05:30',
  'Z',
  '__proto__',
  'constructor',
  'prototype',
  'Europe/London\n',
  'America/New York',
  'Etc/GMT+15',
  'Etc/GMT-15',
  'America/Los_Angeles/../New_York',
  'Ame\u0301rica/New_York',
  '\u202eUTC',
  'ＵＴＣ',
  'UTC '.repeat(20000),
  'x'.repeat(70_000),
  'Asia/Tokyo;DROP TABLE zones',
  '%2e%2e%2f',
];

const HOSTILE_INSTANTS = [
  '',
  ' ',
  'Z',
  'z',
  '+00:00',
  '-00:00',
  'now',
  'nowZ',
  '2026-08-27',
  '2026-08-27T10:00:00',
  '2026-08-27T10:00:00+0000',
  '2026-08-27T10:00:00 UTC',
  '2026-08-27T10:00:00 GMT+00:00',
  '2026-08-27 10:00:00Z',
  '2026-08-27T10:00:00.1234567Z',
  '2026-08-27T24:00:00Z',
  '2026-08-27T23:59:60Z',
  '2026-02-30T00:00:00Z',
  '2026-13-01T00:00:00Z',
  '2026-00-10T00:00:00Z',
  '2026-08-27T10:00:00+24:00',
  '2026-08-27T10:00:00+99:99',
  '2026-08-27T10:00:00-23:59',
  '1970-01-01T00:00:00Z',
  '1969-12-31T23:59:59.999Z',
  '1900-01-01T00:00:00Z',
  '0001-01-01T00:00:00Z',
  '0001-01-01T00:00:00.000Z',
  '0000-01-01T00:00:00Z',
  '0099-12-31T23:59:59Z',
  '0999-12-31T23:59:59Z',
  '1000-01-01T00:00:00Z',
  '9999-12-31T23:59:59Z',
  '+010000-01-01T00:00:00Z',
  '+275760-09-13T00:00:00Z',
  '+275760-09-13T00:00:00.001Z',
  '-000001-01-01T00:00:00Z',
  '-271821-04-20T00:00:00Z',
  '-271821-04-19T23:59:59Z',
  '2038-01-19T03:14:08Z',
  '2106-02-07T06:28:16Z',
  '\u0000Z',
  '2026-08-27T10:00:00\u0000Z',
  '２０２６-08-27T10:00:00Z',
  '٢٠٢٦-08-27T10:00:00Z',
  'Thu, 27 Aug 2026 10:00:00 GMT',
  '1756288800000',
  '1756288800000Z',
  'NaNZ',
  'InfinityZ',
  `${'9'.repeat(70_000)}Z`,
  '2026-08-27T10:00:00Z'.repeat(4000),
  '\ufeff2026-08-27T10:00:00Z',
  '2026-08-27T10:00:00Z\ufeff',
];

const HOSTILE_IDS = [
  '',
  '\u0000',
  '../../etc/passwd',
  '..\\..\\',
  '__proto__',
  'constructor',
  'hasOwnProperty',
  '\u00e9',
  'e\u0301',
  '\ud83d\udc4b',
  '\ufb01',
  'fi',
  'x'.repeat(66_000),
  '\u202e',
  '9'.repeat(400),
];

function instantIso(rng: Rng, ms: number): string {
  const base = new Date(ms).toISOString();
  const roll = rng.float();
  if (roll < 0.5) return base;
  if (roll < 0.6) return base.replace('Z', 'z');
  if (roll < 0.7) return base.replace('.000Z', 'Z');
  // Same instant expressed with an explicit offset.
  const offsetMinutes = rng.pick([
    -720, -570, -300, -210, 0, 60, 330, 345, 525, 780, 840,
  ]);
  const shifted = new Date(ms + offsetMinutes * 60_000)
    .toISOString()
    .slice(0, 23);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${shifted}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

function pickAsOfMs(rng: Rng): number {
  // 2019-01-01 .. 2031-01-01, at a random ms of the day so DST edges appear.
  return Date.UTC(2019, 0, 1) + Math.floor(rng.float() * 12 * 365.25 * DAY_MS);
}

interface OptionDraw {
  asOfIso: string;
  timeZone: string;
  rangeDays: number;
  /** The instant behind `asOfIso` when it was generated as valid. */
  asOfMs: number;
  rangeKey: string;
}

function drawOptions(rng: Rng): OptionDraw {
  const asOfMs = pickAsOfMs(rng);
  const asOfIso = rng.chance(0.7)
    ? instantIso(rng, asOfMs)
    : rng.pick(HOSTILE_INSTANTS);
  const timeZone = rng.chance(0.75)
    ? rng.pick(VALID_ZONES)
    : rng.pick(HOSTILE_ZONES);
  let rangeDays: number;
  const rangeRoll = rng.float();
  if (rangeRoll < 0.65) {
    rangeDays = rng.pick([1, 2, 7, 28, 90, 365, 366, rng.range(1, 366)]);
  } else {
    rangeDays = rng.pick<number>([
      0,
      -1,
      -0,
      367,
      1.5,
      7.000000001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      2 ** 53,
      2 ** 53 - 1,
      -(2 ** 53),
      1e-300,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
      // Wrong runtime types smuggled through the number slot.
      '7' as unknown as number,
      null as unknown as number,
      undefined as unknown as number,
      true as unknown as number,
      [7] as unknown as number,
      {} as unknown as number,
    ]);
  }
  const rangeKey = rng.chance(0.7)
    ? rng.pick(PRACTICE_HISTORY_RANGES).key
    : rng.pick([
        '30d',
        '',
        '7D',
        ' 7d',
        '7d\u0000',
        '__proto__',
        'constructor',
        'toString',
        'x'.repeat(65_536),
      ]);
  return { asOfIso, timeZone, rangeDays, asOfMs, rangeKey };
}

// ---------------------------------------------------------------------------
// Capture rows → PendingCapture exactly like the repository does it
// ---------------------------------------------------------------------------

const BASE_TRIGGER = {
  startMs: 1_000,
  endMs: 1_800,
  peakMotionMs: 1_500,
  confidence: 0.82,
  source: 'temporal_pose_motion',
  modelVersion: 'temporal-stroke-heuristic-2',
};

function baseEvidence(rng: Rng): Record<string, unknown> {
  const roll = rng.float();
  // Boundary evidence numbers that the strict parser still accepts.
  const poseFrameCount =
    roll < 0.1
      ? 1
      : roll < 0.15
        ? 2 ** 31
        : roll < 0.18
          ? 2 ** 53 - 1
          : rng.range(1, 400);
  const poseMissingFrameCount = roll < 0.1 ? 0 : rng.range(0, 50);
  const coverage = rng.pick([0, 1, 0.5, 0.75, 1e-9, 1 - 1e-12, rng.float()]);
  return {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    analysisInputFrameCount: poseFrameCount + poseMissingFrameCount,
    poseFrameCount,
    poseMissingFrameCount,
    trackedDurationMs: rng.pick([
      0,
      1,
      300,
      2 ** 31,
      Number.MAX_SAFE_INTEGER,
      rng.range(1, 60_000),
    ]),
    meanCanonicalJointVisibility: coverage,
    meanJointCoverage: coverage,
    minimumJointCoverage: Math.min(coverage, rng.pick([0, coverage, 0.25])),
    fullBodyVisibleFrameCount: rng.pick([
      0,
      1,
      poseFrameCount,
      Math.min(poseFrameCount, 2),
    ]),
    jointMotion: [
      {
        joint: 'right_wrist',
        sampleCount: 2,
        meanNormalizedPerSecond: 0.8,
        peakNormalizedPerSecond: 1.2,
      },
    ],
  };
}

function poseSequenceRef(rng: Rng): Record<string, unknown> {
  return {
    schemaVersion: 1,
    format: 'pickle.pose-sequence.v1',
    uri: 'file:///pose/seq.json',
    frameCount: rng.range(1, 500),
    sha256: 'ab'.repeat(32),
    coordinateSystem: 'normalized_image_top_left',
    poseModelVersion: 'apple-vision-bodypose-1',
  };
}

interface StoredRow {
  id: string;
  uri: string;
  captured_at: string;
  duration_ms: number;
  fps: number;
  width: number;
  height: number;
  payload: string | null;
  shape: string;
}

function captureInstant(rng: Rng, asOfMs: number, rangeDays: number): number {
  const span =
    (Number.isFinite(rangeDays) && rangeDays > 0
      ? Math.min(rangeDays, 366)
      : 28) * 2.5;
  const offsetDays = rng.float() * span - span * 0.1;
  return Math.floor(asOfMs - offsetDays * DAY_MS);
}

function storedRow(
  rng: Rng,
  index: number,
  asOfMs: number,
  rangeDays: number,
): StoredRow {
  const idRoll = rng.float();
  const id =
    idRoll < 0.8 ? `cap-${index}-${rng.int(1e9)}` : rng.pick(HOSTILE_IDS);
  const ms = captureInstant(rng, asOfMs, rangeDays);
  const instantRoll = rng.float();
  const capturedAtIso =
    instantRoll < 0.6
      ? instantIso(rng, ms)
      : instantRoll < 0.7
        ? new Date(ms).toISOString().slice(0, 19)
        : rng.pick(HOSTILE_INSTANTS);
  const uri = `file:///captures/${index}.mov`;
  const durationMs = rng.pick([3_000, 1, 0.5, 2 ** 31, 4_200.5]);
  const fps = rng.pick([60, 59.94, 0, 240, 30]);
  const width = rng.pick([1080, 720, 1]);
  const height = rng.pick([1920, 1280, 1]);
  const mode = rng.chance(0.6) ? 'automatic_pose_trigger' : 'imported_video';

  const clip: Record<string, unknown> = {
    uri,
    capturedAtIso,
    durationMs,
    fps,
    width,
    height,
    captureMode: mode,
    recognition: {
      status: 'unknown',
      reason:
        mode === 'imported_video'
          ? 'analysis_not_run'
          : 'validated_classifier_unavailable',
    },
  };
  if (mode === 'automatic_pose_trigger') {
    clip.trigger = {
      ...BASE_TRIGGER,
      endMs: Math.min(1_800, durationMs),
      peakMotionMs: Math.min(1_500, durationMs),
      startMs: Math.min(1_000, durationMs),
    };
    clip.captureEvidence = baseEvidence(rng);
    clip.ballSpeed = {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    };
    clip.preRollMs = Math.min(1_000, durationMs);
    clip.postRollMs = Math.min(1_200, durationMs);
  } else {
    clip.ballSpeed = { status: 'unavailable', reason: 'analysis_not_run' };
    if (rng.chance(0.6)) clip.poseSequence = poseSequenceRef(rng);
  }

  let shape = `${mode}.wellFormed`;
  let payload: string | null = JSON.stringify(clip);
  const row: StoredRow = {
    id,
    uri,
    captured_at: capturedAtIso,
    duration_ms: durationMs,
    fps,
    width,
    height,
    payload,
    shape,
  };

  const shapeRoll = rng.int(14);
  switch (shapeRoll) {
    case 0:
      row.payload = null;
      shape = `${mode}.legacyNullPayload`;
      break;
    case 1:
      row.payload = '';
      shape = `${mode}.emptyPayload`;
      break;
    case 2:
      row.payload = payload.slice(0, rng.int(payload.length));
      shape = `${mode}.truncatedPayload`;
      break;
    case 3:
      row.payload = rng.pick([
        'null',
        '[]',
        '{}',
        '"clip"',
        '0',
        '{"captureMode":"automatic_pose_trigger"}',
        '{"__proto__":{"captureMode":"imported_video"}}',
        '\u0000',
        'undefined',
      ]);
      shape = `${mode}.replacedPayload`;
      break;
    case 4:
      row.captured_at = rng.pick(HOSTILE_INSTANTS);
      shape = `${mode}.rowInstantMismatch`;
      break;
    case 5:
      row.duration_ms = Number.NaN;
      shape = `${mode}.rowDurationNaN`;
      break;
    case 6:
      row.uri = `${uri}\u0000`;
      shape = `${mode}.rowUriMismatch`;
      break;
    case 7: {
      const evidence = clip.captureEvidence as
        Record<string, unknown> | undefined;
      if (evidence) {
        evidence[
          rng.pick([
            'poseFrameCount',
            'trackedDurationMs',
            'meanJointCoverage',
            'fullBodyVisibleFrameCount',
          ])
        ] = rng.pick<unknown>([
          -1,
          -0,
          Number.NaN,
          Number.POSITIVE_INFINITY,
          1.5,
          '12',
          null,
          [],
          {},
          Number.MAX_VALUE * 2,
          2,
        ]);
        row.payload = JSON.stringify(clip);
        shape = `${mode}.evidenceBoundaryValue`;
      } else {
        clip.poseSequence = {
          ...poseSequenceRef(rng),
          sha256: rng.pick(['', 'AB'.repeat(32), 'ab'.repeat(31), '../../x']),
        };
        row.payload = JSON.stringify(clip);
        shape = `${mode}.poseSequenceBadSha`;
      }
      break;
    }
    case 8:
      clip.captureMode = rng.pick([
        'automatic',
        'IMPORTED_VIDEO',
        '',
        '__proto__',
        'imported_video\u0000',
        2,
      ]);
      row.payload = JSON.stringify(clip);
      shape = `${mode}.unknownCaptureMode`;
      break;
    case 9:
      // Future schema version on the evidence block.
      if (clip.captureEvidence) {
        (clip.captureEvidence as Record<string, unknown>).schemaVersion =
          rng.pick([2, 99, '1', null]);
      } else {
        clip.poseSequence = {
          ...poseSequenceRef(rng),
          schemaVersion: rng.pick([2, '1', 1.0000001]),
        };
      }
      row.payload = JSON.stringify(clip);
      shape = `${mode}.futureSchemaVersion`;
      break;
    case 10:
      // Payload with a prototype-polluting key alongside valid fields.
      row.payload = payload.replace(
        /^\{/,
        '{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},',
      );
      shape = `${mode}.prototypeKeys`;
      break;
    case 11: {
      // Same instant, different textual form: row column vs payload text.
      const alt = new Date(ms).toISOString().replace('Z', '+00:00');
      row.captured_at = alt;
      shape = `${mode}.rowInstantSameMsDifferentText`;
      break;
    }
    case 12: {
      // 64 KiB+ id / uri / free strings inside an otherwise valid payload.
      clip.posterUri = `file:///${'p'.repeat(70_000)}`;
      row.payload = JSON.stringify(clip);
      shape = `${mode}.hugeStringField`;
      break;
    }
    default:
      break;
  }
  payload = row.payload;
  row.shape = shape;
  return row;
}

/** Mirrors `parseCaptureRow` in src/data/repository.ts (not exported). */
function pendingFromRow(row: StoredRow): PendingCapture {
  let clip: CapturedClip | null = null;
  let evidenceStatus: PendingCapture['evidenceStatus'] =
    row.payload === null ? 'legacy' : 'corrupt';
  if (typeof row.payload === 'string' && row.payload.length > 0) {
    try {
      const parsed = assertCapturedClip(JSON.parse(row.payload));
      const metadataMatches =
        parsed.uri === row.uri &&
        parsed.capturedAtIso === row.captured_at &&
        parsed.durationMs === row.duration_ms &&
        parsed.fps === row.fps &&
        parsed.width === row.width &&
        parsed.height === row.height;
      if (metadataMatches) {
        clip = parsed;
        evidenceStatus = 'valid';
      } else {
        evidenceStatus = 'metadata_mismatch';
      }
    } catch {
      evidenceStatus = 'corrupt';
    }
  }
  return {
    id: row.id,
    shotType: 'forehand_drive',
    declaredStroke: null,
    uri: row.uri,
    capturedAtIso: row.captured_at,
    durationMs: row.duration_ms,
    fps: row.fps,
    width: row.width,
    height: row.height,
    clip,
    evidenceStatus,
  };
}

// ---------------------------------------------------------------------------
// Independent oracle
// ---------------------------------------------------------------------------

const DOCUMENTED_ERRORS = [
  'asOfIso must be an ISO timestamp with an explicit timezone.',
  'timeZone must be a non-empty IANA timezone.',
  'timeZone must be a supported IANA timezone.',
  'rangeDays must be an integer between 1 and 366.',
  'The selected timezone could not produce a calendar day.',
  'Unsupported practice history range.',
];

function explicitInstantMs(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function zoneAccepted(timeZone: unknown): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim().length === 0)
    return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

function optionsValid(options: PracticeHistoryOptions): boolean {
  return (
    explicitInstantMs(options.asOfIso) !== null &&
    zoneAccepted(options.timeZone) &&
    Number.isSafeInteger(options.rangeDays) &&
    options.rangeDays >= 1 &&
    options.rangeDays <= 366
  );
}

/** Independent eligibility: repository-valid + evidence + parseable + not future. */
function referenceEligible(capture: PendingCapture, asOfMs: number): boolean {
  const clip = capture.clip;
  if (capture.evidenceStatus !== 'valid' || !clip) return false;
  if (
    clip.uri !== capture.uri ||
    clip.capturedAtIso !== capture.capturedAtIso ||
    clip.durationMs !== capture.durationMs ||
    clip.fps !== capture.fps ||
    clip.width !== capture.width ||
    clip.height !== capture.height
  ) {
    return false;
  }
  const hasEvidence =
    clip.captureMode === 'automatic_pose_trigger' ||
    clip.poseSequence !== undefined;
  if (!hasEvidence) return false;
  const ms = explicitInstantMs(capture.capturedAtIso);
  return ms !== null && ms <= asOfMs;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => sameValue(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      sameValue(leftKeys, rightKeys) &&
      leftKeys.every(key => sameValue(left[key], right[key]))
    );
  }
  return false;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCount(value: unknown): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    !Object.is(value, -0)
  );
}

function isRateOrNull(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'number' &&
      Number.isFinite(value) &&
      value >= 0 &&
      value <= 1)
  );
}

function isFiniteOrNull(value: unknown): boolean {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

function metricsViolations(label: string, metrics: PracticeMetrics): string[] {
  const out: string[] = [];
  if (!isCount(metrics.eligibleCaptureCount))
    out.push(`${label}.eligibleCaptureCount not a count`);
  if (!isCount(metrics.cameraCaptureCount))
    out.push(`${label}.cameraCaptureCount not a count`);
  if (!isCount(metrics.importedCaptureCount))
    out.push(`${label}.importedCaptureCount not a count`);
  if (!isCount(metrics.activeDayCount))
    out.push(`${label}.activeDayCount not a count`);
  if (
    metrics.cameraCaptureCount + metrics.importedCaptureCount !==
    metrics.eligibleCaptureCount
  ) {
    out.push(`${label}: camera + imported != eligible`);
  }
  if (metrics.activeDayCount > metrics.eligibleCaptureCount)
    out.push(`${label}: activeDays > captures`);
  if (!(
    typeof metrics.trackedPoseDurationMs === 'number' &&
    Number.isFinite(metrics.trackedPoseDurationMs) &&
    metrics.trackedPoseDurationMs >= 0
  )) {
    out.push(`${label}.trackedPoseDurationMs not finite non-negative`);
  }
  const pose = metrics.poseAvailability;
  if (
    !isCount(pose.analysisInputFrameCount) ||
    !isCount(pose.poseFrameCount) ||
    !isCount(pose.poseMissingFrameCount)
  ) {
    out.push(`${label}.poseAvailability counts`);
  }
  if (!isRateOrNull(pose.rate))
    out.push(`${label}.poseAvailability.rate out of [0,1]`);
  if (pose.rate === null && pose.analysisInputFrameCount > 0)
    out.push(`${label}.poseAvailability.rate null with frames`);
  const joint = metrics.jointTracking;
  if (!isRateOrNull(joint.meanCoverage))
    out.push(`${label}.jointTracking.meanCoverage`);
  if (!isRateOrNull(joint.minimumCoverage))
    out.push(`${label}.jointTracking.minimumCoverage`);
  if (!isRateOrNull(joint.meanCanonicalJointVisibility))
    out.push(`${label}.jointTracking.meanCanonicalJointVisibility`);
  if (!isRateOrNull(joint.fullBodyVisibleFrameRate))
    out.push(`${label}.jointTracking.fullBodyVisibleFrameRate`);
  if (
    joint.minimumCoverage !== null &&
    joint.meanCoverage !== null &&
    joint.minimumCoverage > joint.meanCoverage + 1e-9
  ) {
    out.push(`${label}.jointTracking.minimumCoverage > meanCoverage`);
  }
  return out;
}

function dayOrdinal(day: string): number {
  return Math.floor(Date.parse(`${day}T00:00:00.000Z`) / DAY_MS);
}

function historyViolations(
  history: PracticeHistory,
  captures: readonly PendingCapture[],
  options: PracticeHistoryOptions,
  asOfMs: number,
): string[] {
  const out: string[] = [];
  if (!DAY_RE.test(history.asOfDay))
    out.push(`asOfDay malformed: ${JSON.stringify(history.asOfDay)}`);
  if (history.rangeDays !== options.rangeDays)
    out.push('rangeDays echo mismatch');
  if (history.sourceCaptureCount !== captures.length)
    out.push('sourceCaptureCount != captures.length');
  if (!isCount(history.excludedCaptureCount))
    out.push('excludedCaptureCount not a count');
  if (
    history.excludedCaptureCount + history.lifetime.eligibleCaptureCount !==
    captures.length
  ) {
    out.push('excluded + lifetime eligible != source');
  }
  const referenceEligibleCount = captures.filter(capture =>
    referenceEligible(capture, asOfMs),
  ).length;
  if (history.lifetime.eligibleCaptureCount !== referenceEligibleCount) {
    out.push(
      `lifetime eligible ${history.lifetime.eligibleCaptureCount} != reference ${referenceEligibleCount}`,
    );
  }
  out.push(...metricsViolations('lifetime', history.lifetime));
  out.push(...metricsViolations('current', history.rangeBuckets.current));
  out.push(...metricsViolations('previous', history.rangeBuckets.previous));

  const buckets = history.dayBuckets;
  if (buckets.length !== options.rangeDays)
    out.push(
      `dayBuckets.length ${buckets.length} != rangeDays ${options.rangeDays}`,
    );
  let bucketEligible = 0;
  for (let index = 0; index < buckets.length; index += 1) {
    const bucket = buckets[index];
    if (!bucket) continue;
    if (!DAY_RE.test(bucket.day))
      out.push(
        `dayBuckets[${index}].day malformed: ${JSON.stringify(bucket.day)}`,
      );
    const previous = buckets[index - 1];
    if (previous && dayOrdinal(bucket.day) !== dayOrdinal(previous.day) + 1) {
      out.push(
        `dayBuckets not consecutive at ${index}: ${previous.day} -> ${bucket.day}`,
      );
    }
    out.push(...metricsViolations(`dayBuckets[${index}]`, bucket));
    bucketEligible += bucket.eligibleCaptureCount;
  }
  const last = buckets[buckets.length - 1];
  if (last && last.day !== history.asOfDay)
    out.push('last day bucket != asOfDay');
  if (bucketEligible !== history.rangeBuckets.current.eligibleCaptureCount) {
    out.push(
      `sum(dayBuckets) ${bucketEligible} != current ${history.rangeBuckets.current.eligibleCaptureCount}`,
    );
  }
  const current = history.rangeBuckets.current;
  const previousRange = history.rangeBuckets.previous;
  if (current.endDay !== history.asOfDay) out.push('current.endDay != asOfDay');
  if (buckets[0] && current.startDay !== buckets[0].day)
    out.push('current.startDay != first bucket');
  if (
    !DAY_RE.test(previousRange.startDay) ||
    !DAY_RE.test(previousRange.endDay)
  )
    out.push('previous range days malformed');
  if (dayOrdinal(previousRange.endDay) !== dayOrdinal(current.startDay) - 1)
    out.push('previous.endDay != current.startDay - 1');
  if (
    dayOrdinal(previousRange.endDay) -
      dayOrdinal(previousRange.startDay) +
      1 !==
    options.rangeDays
  ) {
    out.push('previous range length != rangeDays');
  }
  if (current.eligibleCaptureCount > history.lifetime.eligibleCaptureCount)
    out.push('current > lifetime');
  if (
    previousRange.eligibleCaptureCount + current.eligibleCaptureCount >
    history.lifetime.eligibleCaptureCount
  ) {
    out.push('current + previous > lifetime');
  }

  const streak = history.streak;
  if (!isCount(streak.currentDays) || !isCount(streak.longestDays))
    out.push('streak counts');
  if (streak.currentDays > streak.longestDays)
    out.push('currentDays > longestDays');
  if (streak.longestDays > history.lifetime.activeDayCount)
    out.push('longestDays > lifetime activeDays');
  if (typeof streak.practicedToday !== 'boolean')
    out.push('practicedToday not boolean');
  if (streak.lastPracticeDay === null) {
    if (history.lifetime.eligibleCaptureCount !== 0)
      out.push('lastPracticeDay null with eligible captures');
    if (
      streak.practicedToday ||
      streak.currentDays !== 0 ||
      streak.longestDays !== 0
    )
      out.push('empty streak not zeroed');
  } else {
    if (!DAY_RE.test(streak.lastPracticeDay))
      out.push(
        `lastPracticeDay malformed: ${JSON.stringify(streak.lastPracticeDay)}`,
      );
    if (history.lifetime.eligibleCaptureCount === 0)
      out.push('lastPracticeDay set with no eligible captures');
    if (streak.lastPracticeDay > history.asOfDay)
      out.push('lastPracticeDay after asOfDay');
    if (streak.practicedToday !== (streak.lastPracticeDay === history.asOfDay))
      out.push('practicedToday inconsistent');
    if (streak.longestDays < 1) out.push('longestDays 0 with practice');
  }

  const comparison = history.priorPeriodComparison;
  for (const [key, value] of Object.entries(comparison)) {
    if (!isFiniteOrNull(value))
      out.push(`priorPeriodComparison.${key} not finite/null`);
  }
  if (
    comparison.eligibleCaptureDelta !==
    current.eligibleCaptureCount - previousRange.eligibleCaptureCount
  ) {
    out.push('eligibleCaptureDelta arithmetic');
  }
  return out;
}

function resultViolations(
  result: PracticeHistoryResult,
  rangeKey: PracticeHistoryRangeKey,
  history: PracticeHistory,
): string[] {
  const out: string[] = [];
  if (result.range !== rangeKey) out.push('result.range echo');
  if (result.buckets.length !== history.dayBuckets.length)
    out.push('result buckets length');
  for (const bucket of result.buckets) {
    if (!DAY_RE.test(bucket.key))
      out.push(`bucket key malformed ${JSON.stringify(bucket.key)}`);
    if (!/^[A-Z][a-z]{2} \d{1,2}$/.test(bucket.label))
      out.push(`bucket label malformed ${JSON.stringify(bucket.label)}`);
    if (!isCount(bucket.count)) out.push('bucket count');
  }
  if (result.captureCount !== history.rangeBuckets.current.eligibleCaptureCount)
    out.push('captureCount mismatch');
  if (result.excludedCaptureCount !== history.excludedCaptureCount)
    out.push('excluded mismatch');
  if (
    result.currentStreak !== history.streak.currentDays ||
    result.longestStreak !== history.streak.longestDays
  )
    out.push('streak mismatch');
  if (
    !isRateOrNull(result.meanPoseAvailability) ||
    !isRateOrNull(result.meanJointCoverage)
  )
    out.push('result rates');
  for (const [key, value] of Object.entries(result.priorPeriodDelta)) {
    if (!isFiniteOrNull(value)) out.push(`priorPeriodDelta.${key}`);
  }
  const text = JSON.stringify(result);
  if (/NaN|Infinity|undefined/.test(text))
    out.push('result serializes NaN/Infinity/undefined');
  return out;
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface Outcome {
  seed: number;
  options: {
    asOfIso: string;
    timeZone: string;
    rangeDays: unknown;
    rangeKey: string;
  };
  captureCount: number;
  captureShapes: string[];
  evidenceStatuses: Record<string, number>;
  oracle: 'valid' | 'invalid';
  aggregate: 'resolved' | 'rejected_typed' | 'escaped';
  aggregateMessage?: string;
  /** For escaped errors: the smallest reproduction found. */
  minimized?: string;
  build: 'resolved' | 'rejected_typed' | 'escaped' | 'skipped';
  buildMessage?: string;
  violations: string[];
  deterministic: boolean;
  orderIndependent: boolean;
  inputsMutated: boolean;
  prototypePolluted: boolean;
  class:
    | 'ok'
    | 'rejected'
    | 'escaped_error'
    | 'invariant_violation'
    | 'over_reject'
    | 'under_reject';
}

function describeOptionValue(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Object.is(value, -0)) return '-0';
    if (!Number.isFinite(value)) return String(value);
    return value;
  }
  if (value === undefined) return 'undefined';
  if (typeof value === 'string')
    return value.length > 80
      ? `${value.slice(0, 80)}…(${value.length})`
      : value;
  return JSON.stringify(value);
}

function protoSnapshot(): string {
  return JSON.stringify([
    Object.getOwnPropertyNames(Object.prototype).sort(),
    Object.getOwnPropertyNames(Array.prototype).sort(),
  ]);
}

function escapes(
  captures: readonly PendingCapture[],
  options: PracticeHistoryOptions,
): string | null {
  try {
    aggregatePracticeHistory(captures, options);
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return DOCUMENTED_ERRORS.includes(message) ? null : message;
  }
}

function minimizeEscape(
  captures: readonly PendingCapture[],
  options: PracticeHistoryOptions,
): string {
  const optionsOnly = escapes([], options);
  if (optionsOnly !== null) {
    return `options-only asOfIso=${JSON.stringify(options.asOfIso.slice(0, 40))} timeZone=${JSON.stringify(options.timeZone.slice(0, 40))} → ${optionsOnly}`;
  }
  for (const capture of captures) {
    const single = escapes([capture], options);
    if (single !== null) {
      return `single-capture capturedAtIso=${JSON.stringify(capture.capturedAtIso.slice(0, 40))} mode=${capture.clip?.captureMode ?? 'none'} → ${single}`;
    }
  }
  return 'needs-multiple-captures';
}

function runIteration(seed: number): Outcome {
  const rng = new Rng(seed);
  const draw = drawOptions(rng);
  const captureCount = rng.chance(0.05) ? rng.range(40, 120) : rng.int(12);
  const rows: StoredRow[] = [];
  for (let index = 0; index < captureCount; index += 1) {
    rows.push(storedRow(rng, index, draw.asOfMs, draw.rangeDays));
  }
  const captures = rows.map(pendingFromRow);
  const options: PracticeHistoryOptions = {
    asOfIso: draw.asOfIso,
    timeZone: draw.timeZone,
    rangeDays: draw.rangeDays,
  };
  const evidenceStatuses: Record<string, number> = {};
  for (const capture of captures) {
    evidenceStatuses[capture.evidenceStatus] =
      (evidenceStatuses[capture.evidenceStatus] ?? 0) + 1;
  }
  const inputSnapshot = JSON.stringify(captures);
  const protoBefore = protoSnapshot();
  const valid = optionsValid(options);
  const asOfMs = explicitInstantMs(options.asOfIso) ?? Number.NaN;

  let aggregate: Outcome['aggregate'];
  let aggregateMessage: string | undefined;
  let history: PracticeHistory | undefined;
  try {
    history = aggregatePracticeHistory(captures, options);
    aggregate = 'resolved';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    aggregate =
      error instanceof Error && DOCUMENTED_ERRORS.includes(message)
        ? 'rejected_typed'
        : 'escaped';
    aggregateMessage =
      error instanceof Error ? `${error.name}: ${message}` : message;
  }

  // Minimize an escaped error: does it reproduce with no captures (options
  // alone), or with exactly one capture (then which capturedAtIso)?
  let minimized: string | undefined;
  if (aggregate === 'escaped') {
    minimized = minimizeEscape(captures, options);
  }

  const violations: string[] = [];
  let deterministic = true;
  let orderIndependent = true;
  if (history) {
    violations.push(...historyViolations(history, captures, options, asOfMs));
    try {
      deterministic = sameValue(
        history,
        aggregatePracticeHistory(captures, options),
      );
      orderIndependent = sameValue(
        history,
        aggregatePracticeHistory(rng.shuffle(captures), options),
      );
    } catch (error) {
      violations.push(
        `re-run threw: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // buildPracticeHistory: the UI entry, with its own range-key boundary.
  let build: Outcome['build'] = 'skipped';
  let buildMessage: string | undefined;
  const rangeKeyValid = PRACTICE_HISTORY_RANGES.some(
    candidate => candidate.key === draw.rangeKey,
  );
  try {
    const result = buildPracticeHistory(captures, {
      asOfIso: options.asOfIso,
      timeZone: options.timeZone,
      range: draw.rangeKey as PracticeHistoryRangeKey,
    });
    build = 'resolved';
    if (!rangeKeyValid)
      violations.push(
        `build accepted unsupported range ${JSON.stringify(draw.rangeKey.slice(0, 40))}`,
      );
    else if (
      explicitInstantMs(options.asOfIso) !== null &&
      zoneAccepted(options.timeZone)
    ) {
      const definition = PRACTICE_HISTORY_RANGES.find(
        candidate => candidate.key === draw.rangeKey,
      );
      if (definition) {
        const buildHistory = aggregatePracticeHistory(captures, {
          ...options,
          rangeDays: definition.days,
        });
        violations.push(
          ...resultViolations(result, definition.key, buildHistory),
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    build =
      error instanceof Error && DOCUMENTED_ERRORS.includes(message)
        ? 'rejected_typed'
        : 'escaped';
    buildMessage =
      error instanceof Error ? `${error.name}: ${message}` : message;
    const buildShouldPass =
      rangeKeyValid &&
      explicitInstantMs(options.asOfIso) !== null &&
      zoneAccepted(options.timeZone);
    if (build === 'rejected_typed' && buildShouldPass)
      violations.push(`build over-rejected: ${message}`);
    if (build === 'escaped' && minimized === undefined) {
      const definition = PRACTICE_HISTORY_RANGES.find(
        candidate => candidate.key === draw.rangeKey,
      );
      minimized = minimizeEscape(captures, {
        ...options,
        rangeDays: definition?.days ?? 7,
      });
    }
  }

  const inputsMutated = JSON.stringify(captures) !== inputSnapshot;
  const prototypePolluted =
    protoSnapshot() !== protoBefore ||
    ({} as Record<string, unknown>)['polluted'] !== undefined;

  let cls: Outcome['class'];
  if (aggregate === 'escaped' || build === 'escaped') cls = 'escaped_error';
  else if (aggregate === 'rejected_typed')
    cls = valid ? 'over_reject' : 'rejected';
  else if (!valid) cls = 'under_reject';
  else if (
    violations.length > 0 ||
    !deterministic ||
    !orderIndependent ||
    inputsMutated ||
    prototypePolluted
  ) {
    cls = 'invariant_violation';
  } else cls = 'ok';
  if (
    cls === 'rejected' &&
    (violations.length > 0 || inputsMutated || prototypePolluted)
  )
    cls = 'invariant_violation';

  return {
    seed,
    options: {
      asOfIso: String(describeOptionValue(options.asOfIso)),
      timeZone: String(describeOptionValue(options.timeZone)),
      rangeDays: describeOptionValue(options.rangeDays),
      rangeKey: String(describeOptionValue(draw.rangeKey)),
    },
    captureCount,
    captureShapes: rows.map(row => row.shape),
    evidenceStatuses,
    oracle: valid ? 'valid' : 'invalid',
    aggregate,
    aggregateMessage,
    minimized,
    build,
    buildMessage,
    violations,
    deterministic,
    orderIndependent,
    inputsMutated,
    prototypePolluted,
    class: cls,
  };
}

const outcomes: Outcome[] = [];

beforeAll(() => {
  for (const seed of iterationSeeds()) {
    outcomes.push(runIteration(seed));
  }
  if (OUT_DIR) {
    mkdirSync(OUT_DIR, { recursive: true });
    const counts: Record<string, number> = {};
    for (const outcome of outcomes)
      counts[outcome.class] = (counts[outcome.class] ?? 0) + 1;
    writeFileSync(
      join(OUT_DIR, 'practiceHistory.boundaryMalformed.json'),
      JSON.stringify(
        {
          unit: 'progress/practiceHistory.aggregatePracticeHistory+buildPracticeHistory',
          lens: 'boundary-malformed',
          baseSeed: BASE_SEED,
          iterations: outcomes.length,
          counts,
          outcomes,
        },
        null,
        2,
      ),
    );
  }
}, 600_000);

function seedsOf(predicate: (outcome: Outcome) => boolean): string[] {
  return outcomes
    .filter(predicate)
    .map(
      outcome =>
        `${outcome.seed}:asOf=${outcome.options.asOfIso}:tz=${outcome.options.timeZone}:range=${String(outcome.options.rangeDays)}:${
          outcome.minimized ??
          (outcome.build === 'escaped' ? outcome.buildMessage : undefined) ??
          outcome.aggregateMessage ??
          outcome.buildMessage ??
          outcome.violations.slice(0, 3).join('|')
        }`,
    );
}

describe('practice history boundary/malformed campaign', () => {
  it('ran every scheduled iteration', () => {
    expect(outcomes.length).toBe(iterationSeeds().length);
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('never throws anything but the documented boundary errors', () => {
    expect(seedsOf(outcome => outcome.class === 'escaped_error')).toEqual([]);
  });

  it('refuses every invalid option set with a documented error and accepts every valid one', () => {
    expect(seedsOf(outcome => outcome.class === 'under_reject')).toEqual([]);
    expect(seedsOf(outcome => outcome.class === 'over_reject')).toEqual([]);
  });

  it('keeps every structural invariant for valid options (buckets, sums, streaks, rates)', () => {
    expect(seedsOf(outcome => outcome.class === 'invariant_violation')).toEqual(
      [],
    );
  });

  it('is deterministic and independent of capture order', () => {
    expect(
      seedsOf(outcome => !outcome.deterministic || !outcome.orderIndependent),
    ).toEqual([]);
  });

  it('never mutates its inputs or any prototype', () => {
    expect(
      seedsOf(outcome => outcome.inputsMutated || outcome.prototypePolluted),
    ).toEqual([]);
  });

  it('covers every required malformed category at least once', () => {
    const shapes = outcomes
      .flatMap(outcome => outcome.captureShapes)
      .join('\n');
    for (const needle of [
      'truncatedPayload',
      'replacedPayload',
      'legacyNullPayload',
      'evidenceBoundaryValue',
      'unknownCaptureMode',
      'futureSchemaVersion',
      'prototypeKeys',
      'hugeStringField',
      'rowInstantMismatch',
    ]) {
      expect(shapes).toContain(needle);
    }
    const statuses = new Set(
      outcomes.flatMap(outcome => Object.keys(outcome.evidenceStatuses)),
    );
    expect([...statuses].sort()).toEqual([
      'corrupt',
      'legacy',
      'metadata_mismatch',
      'valid',
    ]);
    expect(outcomes.some(outcome => outcome.oracle === 'invalid')).toBe(true);
    expect(
      outcomes.some(
        outcome => outcome.oracle === 'valid' && outcome.captureCount > 0,
      ),
    ).toBe(true);
  });
});
