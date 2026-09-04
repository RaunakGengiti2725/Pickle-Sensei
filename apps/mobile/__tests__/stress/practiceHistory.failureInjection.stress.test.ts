/**
 * FAILURE INJECTION — src/progress/practiceHistory.ts.
 *
 * The module's dependencies are the SQLite repository rows (PendingCapture),
 * the clock (asOfIso) and Intl (timeZone). Each seeded iteration builds a
 * hostile capture set — every evidenceStatus the repository can emit, clip
 * metadata mismatches, imports with and without a measured pose sequence,
 * timestamps with every zone spelling Date.parse accepts (explicit Z /
 * ±HH:MM, none, date-only, garbage), captures in the future, duplicates,
 * evidence extremes — under a random real zone (DST, half-hour and
 * 45-minute offsets, ±14 h) at a random instant (often within seconds of
 * local midnight or a DST transition), and checks:
 *
 *   no_throw       — repository-reachable rows never throw
 *   oracle         — every count, day bucket, rate and streak equals an
 *                    independent brute-force computation (Intl en-CA day
 *                    keys + Date.UTC ordinals)
 *   finite         — no NaN/Infinity anywhere; rates within [0, 1]
 *   buckets        — rangeDays contiguous ascending days ending on asOfDay
 *   deterministic  — same seed → identical JSON; shuffled input → identical
 *   options_reject — invalid zone / asOfIso / rangeDays / range key throw an
 *                    Error (never a NaN-laden result)
 *
 * A separate small campaign feeds rows the repository cannot produce today
 * (capturedAtIso with a year < 1000 — Date.parse accepts them, the strict
 * clip parser accepts them, but every producer stamps the device clock) and
 * asserts the module still does not crash — a documented hardening gap when
 * it does.
 *
 * Replay:  STRESS_ONLY=practiceHistory:<seed>   Scale: STRESS_ITER=<n>
 * Table:   artifacts/stress/practiceHistory.json
 */
import type { CaptureEvidenceV1, CapturedClip } from '../../src/camera/capture';
import type { PendingCapture } from '../../src/data/repository';
import {
  aggregatePracticeHistory,
  buildPracticeHistory,
  PRACTICE_HISTORY_RANGES,
  type PracticeHistoryRangeKey,
  type PracticeHistoryResult,
} from '../../src/progress/practiceHistory';
import { SeededRng } from '../../test-support/stress/seededRng';
import {
  CampaignTable,
  Checker,
  describeValue,
  planCampaign,
} from '../../test-support/stress/campaign';

const TEST_FILE =
  '__tests__/stress/practiceHistory.failureInjection.stress.test.ts';
const DAY_MS = 86_400_000;

// ─── Zones and instants ──────────────────────────────────────────────────────

const REAL_ZONES = [
  'UTC',
  'utc',
  'Etc/GMT+12',
  'Pacific/Kiritimati', // +14
  'Pacific/Pago_Pago', // -11
  'America/New_York',
  'America/Los_Angeles',
  'America/St_Johns', // -3:30 with DST
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata', // +5:30
  'Asia/Calcutta', // alias
  'Asia/Kathmandu', // +5:45
  'Asia/Tokyo',
  'Australia/Lord_Howe', // 30-minute DST shift
  'Australia/Sydney',
  'Pacific/Apia',
  'Pacific/Chatham', // +12:45
  'EST',
  '+05:30', // ECMA-402 offset zone (accepted by Intl on Hermes/ICU ≥ 74)
] as const;

const INVALID_ZONES = [
  '',
  '   ',
  'Mars/Olympus_Mons',
  'UTC+5',
  'GMT+02:00',
  'America/New York',
  'local',
  'Etc/Unknown',
  'Europe/Berlin\u0000',
] as const;

/** Instants that sit on or within seconds of a DST transition. */
const DST_EDGES = [
  '2026-03-08T07:00:00Z', // America/New_York spring forward
  '2026-11-01T06:00:00Z', // America/New_York fall back
  '2026-03-29T01:00:00Z', // Europe/London spring forward
  '2026-10-25T01:00:00Z', // Europe/London fall back
  '2026-04-04T15:00:00Z', // Australia/Lord_Howe end of DST
  '2026-10-03T15:00:00Z', // Australia/Lord_Howe start of DST
  '2026-03-08T04:30:00Z', // America/St_Johns spring forward
] as const;

function randomInstantMs(rng: SeededRng): number {
  const from = Date.UTC(2020, 0, 1);
  const to = Date.UTC(2030, 11, 31);
  return from + Math.floor(rng.next() * (to - from));
}

/** Local midnight in `zone` for the day containing `ms`, ± a few seconds. */
function nearLocalMidnightMs(ms: number, zone: string, rng: SeededRng): number {
  const day = oracleDay(ms, zone);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  // Find the UTC instant at which local time is 00:00 by probing offsets.
  const guess = Date.UTC(y, m - 1, d);
  for (let offsetMin = -14 * 60; offsetMin <= 14 * 60; offsetMin += 15) {
    const candidate = guess + offsetMin * 60_000;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(new Date(candidate));
    const hour = parts.find(p => p.type === 'hour')?.value;
    const minute = parts.find(p => p.type === 'minute')?.value;
    if ((hour === '00' || hour === '24') && minute === '00') {
      return candidate + rng.int(-3, 3) * 1_000;
    }
  }
  return ms;
}

// ─── Capture generator ───────────────────────────────────────────────────────

type TimestampStyle =
  | 'iso_z'
  | 'iso_z_no_ms'
  | 'iso_lower_z'
  | 'iso_offset'
  | 'iso_no_zone'
  | 'date_only'
  | 'rfc2822'
  | 'garbage'
  | 'epoch_1904';

const TIMESTAMP_STYLES: readonly TimestampStyle[] = [
  'iso_z',
  'iso_z',
  'iso_z',
  'iso_z_no_ms',
  'iso_lower_z',
  'iso_offset',
  'iso_offset',
  'iso_no_zone',
  'date_only',
  'rfc2822',
  'garbage',
  'epoch_1904',
];

function formatTimestamp(ms: number, style: TimestampStyle, rng: SeededRng) {
  const iso = new Date(ms).toISOString();
  switch (style) {
    case 'iso_z':
      return iso;
    case 'iso_z_no_ms':
      return iso.replace(/\.\d{3}Z$/, 'Z');
    case 'iso_lower_z':
      return iso.replace(/Z$/, 'z');
    case 'iso_offset': {
      const offsetMin = rng.pick([
        -720, -570, -300, -210, 0, 60, 330, 345, 840,
      ]);
      const shifted = new Date(ms + offsetMin * 60_000).toISOString();
      const sign = offsetMin < 0 ? '-' : '+';
      const abs = Math.abs(offsetMin);
      const hh = String(Math.floor(abs / 60)).padStart(2, '0');
      const mm = String(abs % 60).padStart(2, '0');
      return shifted.replace(/Z$/, `${sign}${hh}:${mm}`);
    }
    case 'iso_no_zone':
      return iso.replace(/Z$/, '');
    case 'date_only':
      return iso.slice(0, 10);
    case 'rfc2822':
      return new Date(ms).toUTCString();
    case 'garbage':
      return rng.pick(['not a date', '', 'Z', '2026-13-45T25:61:00Z', 'null']);
    case 'epoch_1904':
      return '1904-01-01T00:00:00.000Z';
  }
}

function evidence(rng: SeededRng, extreme: boolean): CaptureEvidenceV1 {
  const poseFrameCount = extreme ? rng.pick([0, 1, 100_000]) : rng.int(1, 240);
  const missing = extreme ? rng.pick([0, 100_000]) : rng.int(0, 60);
  return {
    schemaVersion: 1,
    window: 'detected_motion',
    poseSource: 'apple_vision_body_pose',
    poseModelVersion: 'apple-vision-bodypose-1',
    triggerAlgorithmVersion: 'temporal-stroke-heuristic-2',
    motionUnit: 'normalized_image_units_per_second',
    poseFrameCount,
    poseMissingFrameCount: missing,
    analysisInputFrameCount: poseFrameCount + missing,
    trackedDurationMs: extreme
      ? rng.pick([0, 1, 3_600_000])
      : rng.int(100, 4_000),
    meanCanonicalJointVisibility: extreme ? rng.pick([0, 1]) : rng.next(),
    meanJointCoverage: extreme ? rng.pick([0, 1]) : rng.next(),
    minimumJointCoverage: extreme ? rng.pick([0, 1]) : rng.next(),
    fullBodyVisibleFrameCount: extreme
      ? rng.pick([0, poseFrameCount])
      : rng.int(0, poseFrameCount),
    jointMotion: [],
  };
}

type RowKind =
  | 'camera_valid'
  | 'imported_measured'
  | 'imported_raw'
  | 'legacy_null_clip'
  | 'corrupt_null_clip'
  | 'metadata_mismatch_null_clip'
  | 'valid_status_but_clip_metadata_differs'
  | 'valid_status_but_no_clip';

const ROW_KINDS: readonly RowKind[] = [
  'camera_valid',
  'camera_valid',
  'camera_valid',
  'imported_measured',
  'imported_measured',
  'imported_raw',
  'legacy_null_clip',
  'corrupt_null_clip',
  'metadata_mismatch_null_clip',
  'valid_status_but_clip_metadata_differs',
  'valid_status_but_no_clip',
];

interface GeneratedRow {
  capture: PendingCapture;
  kind: RowKind;
  style: TimestampStyle;
  /** Instant the generator meant (before formatting); null for garbage. */
  intendedMs: number | null;
}

function makeRow(
  index: number,
  asOfMs: number,
  rng: SeededRng,
  hostile: boolean,
): GeneratedRow {
  const kind = rng.pick(ROW_KINDS);
  const style = rng.pick(TIMESTAMP_STYLES);
  // Mostly within the last 200 days; some in the future; some far past.
  const roll = rng.next();
  const offsetMs =
    roll < 0.08
      ? -rng.int(0, 2 * DAY_MS) // future
      : roll < 0.9
        ? rng.int(0, 200 * DAY_MS)
        : rng.int(200 * DAY_MS, 2_000 * DAY_MS);
  let intendedMs: number | null = asOfMs - offsetMs;
  let capturedAtIso = formatTimestamp(intendedMs, style, rng);
  if (
    style === 'garbage' ||
    style === 'iso_no_zone' ||
    style === 'date_only' ||
    style === 'rfc2822'
  ) {
    intendedMs = null; // no explicit zone → the module must exclude
  }
  if (style === 'epoch_1904') intendedMs = Date.parse(capturedAtIso);
  if (hostile && rng.chance(0.5)) {
    capturedAtIso = rng.pick([
      '0999-06-01T00:00:00.000Z',
      '0001-01-01T00:00:00.000Z',
      '-000100-01-01T00:00:00.000Z',
      '0000-12-31T23:59:59.000Z',
    ]);
    intendedMs = Date.parse(capturedAtIso);
  }

  const id = rng.chance(0.05) ? `dup-${rng.int(0, 3)}` : `cap-${index}`;
  const uri = `file:///captures/${id}.mov`;
  const durationMs = rng.int(500, 60_000);
  const fps = rng.pick([24, 30, 60, 120]);
  const width = rng.pick([720, 1080, 1920]);
  const height = rng.pick([1280, 1920, 1080]);
  const base = { uri, capturedAtIso, durationMs, fps, width, height };
  const extreme = rng.chance(0.15);
  const ev = evidence(rng, extreme);

  const cameraClip: CapturedClip = {
    ...base,
    captureMode: 'automatic_pose_trigger',
    recognition: {
      status: 'unknown',
      reason: 'validated_classifier_unavailable',
    },
    trigger: {
      startMs: 100,
      endMs: Math.min(durationMs, 900),
      peakMotionMs: 500,
      confidence: 0.8,
      source: 'temporal_pose_motion',
      modelVersion: 'temporal-stroke-heuristic-2',
    },
    captureEvidence: ev,
    ballSpeed: {
      status: 'unavailable',
      reason: 'calibrated_ball_tracker_unavailable',
    },
    preRollMs: 100,
    postRollMs: 100,
  } as CapturedClip;
  const importedClip = (measured: boolean): CapturedClip =>
    ({
      ...base,
      captureMode: 'imported_video',
      recognition: { status: 'unknown', reason: 'analysis_not_run' },
      ballSpeed: { status: 'unavailable', reason: 'analysis_not_run' },
      ...(measured
        ? {
            poseSequence: {
              schemaVersion: 1,
              format: 'pickle.pose-sequence.v1',
              uri: `file:///captures/${id}.pose.json`,
              frameCount: 117,
              sha256: 'c'.repeat(64),
              coordinateSystem: 'normalized_image_top_left',
              poseModelVersion: 'apple-vision-bodypose-1',
            },
          }
        : {}),
    }) as CapturedClip;

  const row = {
    id,
    shotType: 'unrecognized',
    declaredStroke: null,
    ...base,
  };
  let capture: PendingCapture;
  switch (kind) {
    case 'camera_valid':
      capture = { ...row, clip: cameraClip, evidenceStatus: 'valid' };
      break;
    case 'imported_measured':
      capture = { ...row, clip: importedClip(true), evidenceStatus: 'valid' };
      break;
    case 'imported_raw':
      capture = { ...row, clip: importedClip(false), evidenceStatus: 'valid' };
      break;
    case 'legacy_null_clip':
      capture = { ...row, clip: null, evidenceStatus: 'legacy' };
      break;
    case 'corrupt_null_clip':
      capture = { ...row, clip: null, evidenceStatus: 'corrupt' };
      break;
    case 'metadata_mismatch_null_clip':
      capture = { ...row, clip: null, evidenceStatus: 'metadata_mismatch' };
      break;
    case 'valid_status_but_clip_metadata_differs': {
      const field = rng.pick([
        'uri',
        'capturedAtIso',
        'durationMs',
        'fps',
        'width',
        'height',
      ] as const);
      const clip = { ...cameraClip } as Record<string, unknown>;
      clip[field] =
        field === 'uri'
          ? `${uri}.bak`
          : field === 'capturedAtIso'
            ? `${capturedAtIso} `
            : (clip[field] as number) + 1;
      capture = {
        ...row,
        clip: clip as unknown as CapturedClip,
        evidenceStatus: 'valid',
      };
      break;
    }
    case 'valid_status_but_no_clip':
      capture = { ...row, clip: null, evidenceStatus: 'valid' };
      break;
  }
  return { capture, kind, style, intendedMs };
}

// ─── Independent oracle ──────────────────────────────────────────────────────

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function oracleDay(ms: number, zone: string): string {
  let formatter = dayFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(zone, formatter);
  }
  // en-CA renders YYYY-MM-DD.
  return formatter.format(new Date(ms));
}

function oracleOrdinal(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
}

function oracleDayFromOrdinal(ordinal: number): string {
  const date = new Date(ordinal * DAY_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

interface OracleEligible {
  ms: number;
  ordinal: number;
  evidence: CaptureEvidenceV1 | null;
}

function oracleEligible(
  capture: PendingCapture,
  asOfMs: number,
  zone: string,
): OracleEligible | null {
  const clip = capture.clip;
  if (capture.evidenceStatus !== 'valid' || !clip) return null;
  if (
    clip.uri !== capture.uri ||
    clip.capturedAtIso !== capture.capturedAtIso ||
    clip.durationMs !== capture.durationMs ||
    clip.fps !== capture.fps ||
    clip.width !== capture.width ||
    clip.height !== capture.height
  ) {
    return null;
  }
  const camera = clip.captureMode === 'automatic_pose_trigger';
  if (!camera && clip.poseSequence === undefined) return null;
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(capture.capturedAtIso)) return null;
  const ms = Date.parse(capture.capturedAtIso);
  if (!Number.isFinite(ms) || ms > asOfMs) return null;
  return {
    ms,
    ordinal: oracleOrdinal(oracleDay(ms, zone)),
    evidence: camera ? clip.captureEvidence : null,
  };
}

interface OracleWindow {
  count: number;
  camera: number;
  imported: number;
  activeDays: number;
  trackedMs: number;
  poseRate: number | null;
  meanCoverage: number | null;
}

function oracleWindow(
  rows: OracleEligible[],
  from: number,
  to: number,
): OracleWindow {
  const inWindow = rows.filter(r => r.ordinal >= from && r.ordinal <= to);
  let camera = 0;
  let trackedMs = 0;
  let poseFrames = 0;
  let inputFrames = 0;
  let coverageSum = 0;
  const days = new Set<number>();
  for (const r of inWindow) {
    days.add(r.ordinal);
    if (r.evidence) {
      camera += 1;
      trackedMs += r.evidence.trackedDurationMs;
      poseFrames += r.evidence.poseFrameCount;
      inputFrames += r.evidence.analysisInputFrameCount;
      coverageSum += r.evidence.meanJointCoverage * r.evidence.poseFrameCount;
    }
  }
  return {
    count: inWindow.length,
    camera,
    imported: inWindow.length - camera,
    activeDays: days.size,
    trackedMs,
    poseRate: inputFrames > 0 ? poseFrames / inputFrames : null,
    meanCoverage: poseFrames > 0 ? coverageSum / poseFrames : null,
  };
}

function oracleStreak(ordinals: number[], asOfOrdinal: number) {
  const unique = [...new Set(ordinals)].sort((a, b) => a - b);
  if (unique.length === 0) return { current: 0, longest: 0, today: false };
  let longest = 1;
  let run = 1;
  for (let i = 1; i < unique.length; i++) {
    run = unique[i] === unique[i - 1]! + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const latest = unique[unique.length - 1]!;
  let current = 0;
  if (latest >= asOfOrdinal - 1) {
    current = 1;
    for (let i = unique.length - 2; i >= 0; i--) {
      if (unique[i] !== latest - current) break;
      current += 1;
    }
  }
  return { current, longest, today: latest === asOfOrdinal };
}

function close(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= 1e-9;
}

function walkNumbers(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(`${path}=${String(value)}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkNumbers(item, `${path}[${index}]`, out));
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(
      value as Record<string, unknown>,
    )) {
      walkNumbers(inner, `${path}.${key}`, out);
    }
  }
}

// ─── Scenario ────────────────────────────────────────────────────────────────

interface Scenario {
  zone: string;
  asOfIso: string;
  asOfMs: number;
  range: PracticeHistoryRangeKey;
  rows: GeneratedRow[];
  midnightEdge: boolean;
  dstEdge: boolean;
}

function buildScenario(rng: SeededRng, hostile: boolean): Scenario {
  const zone = rng.pick(REAL_ZONES);
  let asOfMs = randomInstantMs(rng);
  const dstEdge = rng.chance(0.2);
  const midnightEdge = !dstEdge && rng.chance(0.35);
  if (dstEdge)
    asOfMs = Date.parse(rng.pick(DST_EDGES)) + rng.int(-5, 5) * 1_000;
  if (midnightEdge) asOfMs = nearLocalMidnightMs(asOfMs, zone, rng);
  const range = rng.pick(PRACTICE_HISTORY_RANGES).key;
  const rowCount = rng.chance(0.1) ? 0 : rng.int(1, 60);
  const rows: GeneratedRow[] = [];
  for (let i = 0; i < rowCount; i++)
    rows.push(makeRow(i, asOfMs, rng, hostile));
  const asOfIso = formatTimestamp(
    asOfMs,
    rng.pick(['iso_z', 'iso_offset', 'iso_z_no_ms']),
    rng,
  );
  return {
    zone,
    asOfIso,
    asOfMs: Date.parse(asOfIso),
    range,
    rows,
    midnightEdge,
    dstEdge,
  };
}

function checkAgainstOracle(
  checker: Checker,
  result: PracticeHistoryResult,
  scenario: Scenario,
): void {
  const rangeDays = PRACTICE_HISTORY_RANGES.find(
    r => r.key === scenario.range,
  )!.days;
  const eligible = scenario.rows
    .map(r => oracleEligible(r.capture, scenario.asOfMs, scenario.zone))
    .filter((r): r is OracleEligible => r !== null);
  const asOfOrdinal = oracleOrdinal(oracleDay(scenario.asOfMs, scenario.zone));
  const currentFrom = asOfOrdinal - rangeDays + 1;
  const previousFrom = currentFrom - rangeDays;
  const current = oracleWindow(eligible, currentFrom, asOfOrdinal);
  const previous = oracleWindow(eligible, previousFrom, currentFrom - 1);
  const streak = oracleStreak(
    eligible.map(r => r.ordinal),
    asOfOrdinal,
  );

  const nonFinite: string[] = [];
  walkNumbers(result, 'result', nonFinite);
  checker.check('finite', nonFinite.length === 0, () => nonFinite.join(', '));
  for (const rate of [result.meanPoseAvailability, result.meanJointCoverage]) {
    checker.check(
      'finite',
      rate === null || (rate >= 0 && rate <= 1),
      () => `rate out of [0,1]: ${rate}`,
    );
  }

  const expectCounts = {
    captureCount: current.count,
    cameraCaptureCount: current.camera,
    importedCaptureCount: current.imported,
    excludedCaptureCount: scenario.rows.length - eligible.length,
    activeDays: current.activeDays,
    currentStreak: streak.current,
    longestStreak: streak.longest,
    trackedDurationMs: current.trackedMs,
    priorCaptureDelta: current.count - previous.count,
    priorActiveDayDelta: current.activeDays - previous.activeDays,
    priorTrackedDelta: current.trackedMs - previous.trackedMs,
  };
  const gotCounts = {
    captureCount: result.captureCount,
    cameraCaptureCount: result.cameraCaptureCount,
    importedCaptureCount: result.importedCaptureCount,
    excludedCaptureCount: result.excludedCaptureCount,
    activeDays: result.activeDays,
    currentStreak: result.currentStreak,
    longestStreak: result.longestStreak,
    trackedDurationMs: result.trackedDurationMs,
    priorCaptureDelta: result.priorPeriodDelta.captureCount,
    priorActiveDayDelta: result.priorPeriodDelta.activeDays,
    priorTrackedDelta: result.priorPeriodDelta.trackedDurationMs,
  };
  checker.check(
    'oracle',
    JSON.stringify(gotCounts) === JSON.stringify(expectCounts),
    () =>
      `counts ${describeValue(gotCounts)} ≠ oracle ${describeValue(expectCounts)}`,
  );
  checker.check(
    'oracle',
    close(result.meanPoseAvailability, current.poseRate) &&
      close(result.meanJointCoverage, current.meanCoverage) &&
      close(
        result.priorPeriodDelta.meanPoseAvailability,
        current.poseRate === null || previous.poseRate === null
          ? null
          : current.poseRate - previous.poseRate,
      ) &&
      close(
        result.priorPeriodDelta.meanJointCoverage,
        current.meanCoverage === null || previous.meanCoverage === null
          ? null
          : current.meanCoverage - previous.meanCoverage,
      ),
    () =>
      `rates ${describeValue({ pose: result.meanPoseAvailability, cov: result.meanJointCoverage, d: result.priorPeriodDelta })} ≠ oracle ${describeValue({ current, previous })}`,
  );

  // Buckets: contiguous ascending, ending on asOfDay, counts match per day.
  const expectedBuckets: Array<{ key: string; count: number }> = [];
  for (let o = currentFrom; o <= asOfOrdinal; o++) {
    expectedBuckets.push({
      key: oracleDayFromOrdinal(o),
      count: eligible.filter(r => r.ordinal === o).length,
    });
  }
  checker.check(
    'buckets',
    JSON.stringify(
      result.buckets.map(b => ({ key: b.key, count: b.count })),
    ) === JSON.stringify(expectedBuckets),
    () =>
      `buckets ${describeValue(result.buckets.map(b => [b.key, b.count]))} ≠ ${describeValue(expectedBuckets.map(b => [b.key, b.count]))}`,
  );
  checker.check(
    'buckets',
    result.buckets.every(b => /^[A-Z][a-z]{2} \d{1,2}$/.test(b.label)),
    () => `labels ${describeValue(result.buckets.map(b => b.label))}`,
  );
  checker.check(
    'buckets',
    result.buckets.reduce((n, b) => n + b.count, 0) === result.captureCount,
    () => 'bucket counts do not sum to captureCount',
  );
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

const main = planCampaign('practiceHistory', 60, TEST_FILE);
const options = planCampaign('practiceHistoryOptions', 24, TEST_FILE);
const hostile = planCampaign('practiceHistoryHostileRows', 12, TEST_FILE, {
  hardening: true,
});

const mainTable = new CampaignTable(main, {
  zones: REAL_ZONES,
  rowKinds: ROW_KINDS,
  timestampStyles: TIMESTAMP_STYLES,
});
const optionsTable = new CampaignTable(options, {
  invalidZones: INVALID_ZONES,
});
const hostileTable = new CampaignTable(hostile, {
  note: 'rows the repository cannot emit today: capturedAtIso with a year < 1000',
});

afterAll(() => {
  mainTable.flush();
  optionsTable.flush();
  hostileTable.flush();
});

describe('buildPracticeHistory over hostile repository rows, zones and instants', () => {
  for (const seed of main.seeds) {
    it(`seed ${seed}`, () => {
      const rng = new SeededRng(seed);
      const scenario = buildScenario(rng, false);
      const checker = new Checker();
      const started = Date.now();
      let observed = '';
      const params = {
        zone: scenario.zone,
        asOfIso: scenario.asOfIso,
        range: scenario.range,
        rows: scenario.rows.length,
        kinds: scenario.rows.map(r => `${r.kind}/${r.style}`),
        midnightEdge: scenario.midnightEdge,
        dstEdge: scenario.dstEdge,
      };
      try {
        const captures = scenario.rows.map(r => r.capture);
        const opts = {
          asOfIso: scenario.asOfIso,
          timeZone: scenario.zone,
          range: scenario.range,
        };
        const result = buildPracticeHistory(captures, opts);
        observed = `captures=${result.captureCount} excluded=${result.excludedCaptureCount} days=${result.activeDays} streak=${result.currentStreak}/${result.longestStreak}`;
        checkAgainstOracle(checker, result, scenario);
        const again = buildPracticeHistory(captures, opts);
        checker.check(
          'deterministic',
          JSON.stringify(again) === JSON.stringify(result),
          () => 'second run differs from first',
        );
        const shuffled = buildPracticeHistory(rng.shuffle(captures), opts);
        checker.check(
          'deterministic',
          JSON.stringify(shuffled) === JSON.stringify(result),
          () => 'shuffled input changes the result',
        );
      } catch (error) {
        observed = `threw ${describeValue(error)}`;
        checker.fail('no_throw', observed);
      }
      const result = mainTable.record(
        seed,
        'hostile_rows',
        params,
        checker,
        observed,
        Date.now() - started,
      );
      expect({
        outcome: result.outcome,
        failures: result.failures,
        replay: result.replay,
      }).toEqual({
        outcome: 'HELD',
        failures: [],
        replay: result.replay,
      });
    });
  }
});

describe('practice history option faults are refused, never absorbed', () => {
  type OptionFault =
    | 'invalid_zone'
    | 'asOf_no_zone'
    | 'asOf_garbage'
    | 'rangeDays_invalid'
    | 'range_key_invalid';
  const OPTION_FAULTS: readonly OptionFault[] = [
    'invalid_zone',
    'asOf_no_zone',
    'asOf_garbage',
    'rangeDays_invalid',
    'range_key_invalid',
  ];
  for (const seed of options.seeds) {
    it(`seed ${seed}`, () => {
      const rng = new SeededRng(seed);
      const fault = rng.pick(OPTION_FAULTS);
      const scenario = buildScenario(rng, false);
      const captures = scenario.rows.map(r => r.capture);
      const checker = new Checker();
      const started = Date.now();
      const params: Record<string, unknown> = {
        fault,
        zone: scenario.zone,
        asOfIso: scenario.asOfIso,
      };
      let observed = '';
      try {
        let value: unknown;
        switch (fault) {
          case 'invalid_zone': {
            const zone = rng.pick(INVALID_ZONES);
            params.zone = zone;
            value = buildPracticeHistory(captures, {
              asOfIso: scenario.asOfIso,
              timeZone: zone,
              range: scenario.range,
            });
            break;
          }
          case 'asOf_no_zone': {
            const asOfIso = rng.pick([
              scenario.asOfIso.replace(/(?:Z|[+-]\d{2}:\d{2})$/i, ''),
              scenario.asOfIso.slice(0, 10),
              new Date(scenario.asOfMs).toUTCString(),
            ]);
            params.asOfIso = asOfIso;
            value = buildPracticeHistory(captures, {
              asOfIso,
              timeZone: scenario.zone,
              range: scenario.range,
            });
            break;
          }
          case 'asOf_garbage': {
            const asOfIso = rng.pick([
              '',
              'Z',
              'now',
              '2026-13-45T25:61:00Z',
              'NaNZ',
              '+00:00',
            ]);
            params.asOfIso = asOfIso;
            value = buildPracticeHistory(captures, {
              asOfIso,
              timeZone: scenario.zone,
              range: scenario.range,
            });
            break;
          }
          case 'rangeDays_invalid': {
            const rangeDays = rng.pick([
              0,
              -1,
              367,
              1.5,
              NaN,
              Infinity,
              -Infinity,
              2 ** 53,
            ]);
            params.rangeDays = String(rangeDays);
            value = aggregatePracticeHistory(captures, {
              asOfIso: scenario.asOfIso,
              timeZone: scenario.zone,
              rangeDays,
            });
            break;
          }
          case 'range_key_invalid': {
            const range = rng.pick([
              '1d',
              '30d',
              '',
              'week',
              '7D',
            ]) as PracticeHistoryRangeKey;
            params.range = range;
            value = buildPracticeHistory(captures, {
              asOfIso: scenario.asOfIso,
              timeZone: scenario.zone,
              range,
            });
            break;
          }
        }
        observed = `returned ${describeValue(value).slice(0, 120)}`;
        checker.fail('options_reject', observed);
      } catch (error) {
        observed = `threw ${describeValue(error)}`;
        checker.check(
          'options_reject',
          error instanceof Error && error.message.trim().length > 0,
          () =>
            `thrown value is not an Error with a message: ${describeValue(error)}`,
        );
      }
      const result = optionsTable.record(
        seed,
        fault,
        params,
        checker,
        observed,
        Date.now() - started,
      );
      expect({
        outcome: result.outcome,
        failures: result.failures,
        replay: result.replay,
      }).toEqual({
        outcome: 'HELD',
        failures: [],
        replay: result.replay,
      });
    });
  }
});

describe('practice history over rows the repository cannot emit (hardening)', () => {
  for (const seed of hostile.seeds) {
    it(`seed ${seed}`, () => {
      const rng = new SeededRng(seed);
      const scenario = buildScenario(rng, true);
      const checker = new Checker();
      const started = Date.now();
      let observed = '';
      const params = {
        zone: scenario.zone,
        asOfIso: scenario.asOfIso,
        range: scenario.range,
        timestamps: scenario.rows.map(r => r.capture.capturedAtIso),
        kinds: scenario.rows.map(r => r.kind),
      };
      try {
        const result = buildPracticeHistory(
          scenario.rows.map(r => r.capture),
          {
            asOfIso: scenario.asOfIso,
            timeZone: scenario.zone,
            range: scenario.range,
          },
        );
        const nonFinite: string[] = [];
        walkNumbers(result, 'result', nonFinite);
        observed = `captures=${result.captureCount} excluded=${result.excludedCaptureCount} nonFinite=${nonFinite.length}`;
        checker.check('finite', nonFinite.length === 0, () =>
          nonFinite.join(', '),
        );
        checker.check(
          'buckets',
          result.buckets.every(b => /^\d{4}-\d{2}-\d{2}$/.test(b.key)),
          () => `bucket keys ${describeValue(result.buckets.map(b => b.key))}`,
        );
      } catch (error) {
        observed = `threw ${describeValue(error)}`;
        checker.fail('no_throw', observed);
      }
      const result = hostileTable.record(
        seed,
        'hostile_unreachable_rows',
        params,
        checker,
        observed,
        Date.now() - started,
      );
      expect({
        outcome: result.outcome,
        failures: result.failures,
        replay: result.replay,
      }).toEqual({
        outcome: 'HELD',
        failures: [],
        replay: result.replay,
      });
    });
  }
});
