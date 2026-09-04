import type {
  CheckpointKey,
  CheckpointScore,
  FaultDirection,
  Measurement,
  PhaseKey,
  PhaseSpan,
  ScoreBand,
  ShotAnalysis,
  ShotTypeSlug,
} from '@pickle/shared-types';
import { CHECKPOINTS, PHASES, SHOT_TYPES } from '@pickle/shared-types';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { ContactEstimate } from '@pickle/vision-geometry';
import type { StrokeResultClip } from '../../src/components/StrokeResult';
import type {
  AttemptRef,
  StrokeResultEvidenceRecord,
  TemporalPhasesV2,
} from '../../src/components/strokeResultModel';
import {
  FONT_SCALES,
  LOCALES,
  Rng,
  TIMEZONES,
  WIDTHS,
  boundaryNumber,
  localeString,
  type Locale,
} from './strokeResultStress.helpers';

/**
 * Seed → scenario builder for the StrokeResult stress campaigns.
 *
 * Two tiers:
 *  - `typed`: every value satisfies the TypeScript contract of the props
 *    (strings where strings are declared, finite or non-finite `number`s
 *    where numbers are declared). Free-text fields (declared stroke, labels,
 *    limiting factors, metric keys, guidance…) draw from the 12-locale corpus
 *    and the script-hazard list, because persisted records are unvalidated
 *    JSON and the component must render whatever survived on disk.
 *  - `hostile`: the same generator plus shape drift a stale or corrupted
 *    persisted record could carry (missing nested objects, wrong primitive
 *    types, null entries in string arrays). These values violate the static
 *    types on purpose; they are cast once here and nowhere else.
 */

export type Tier = 'typed' | 'hostile';

export interface Scenario {
  seed: number;
  tier: Tier;
  locale: Locale;
  fontScale: (typeof FONT_SCALES)[number];
  width: (typeof WIDTHS)[number];
  timezone: (typeof TIMEZONES)[number];
  shape: ScenarioShape;
  analysis: ShotAnalysis | null;
  record: StrokeResultEvidenceRecord | null;
  clip: StrokeResultClip | null;
  attempts: AttemptRef[] | undefined;
  currentAnalysisId: string;
  /** Free-text strings fed in (for the copy-leak check). */
  inputs: string[];
  /** Slot content strings (rendered by the render suite as <Text>). */
  slots: {
    score: string | null;
    review: string | null;
    fix: string | null;
    children: string | null;
  };
  hideCtaRow: boolean;
  /** Hostile-tier mutations applied, for the outcome table. */
  mutations: string[];
}

export const SHAPES = [
  'scored_declared',
  'scored_predicted_l3',
  'predicted_family',
  'abstained_intent',
  'no_intent_saved',
  'analysis_only',
  'record_only_null_result',
  'all_null',
  'disagreement',
  'low_confidence',
  'unknown_basis',
] as const;
export type ScenarioShape = (typeof SHAPES)[number];

const VERSION_VECTOR = {
  appVersion: '0.1.0',
  modelBundleVersion: 'on-device-fusion-1',
  poseModelVersion: 'apple-vision-bodypose-1',
  paddleModelVersion: 'none',
  strokeDetectorVersion: 'temporal-stroke-heuristic-2',
  phaseModelVersion: 'phase-heuristic-1',
  scoringModelVersion: 'scoring-1',
  shotConfigVersion: 'config-1',
};

const STRUCTURAL_FACTORS = [
  'paddle_track_unavailable',
  'ball_track_unavailable',
  'court_geometry_unavailable',
];

const KNOWN_FACTORS = [
  'insufficient_pose_frames',
  'occlusion',
  'low_pose_confidence',
  'window_too_short',
  'motion_blur',
];

const UNITS = ['normalized', 'ratio', 'degrees', 'ms', 'count'] as const;
const BANDS: ScoreBand[] = ['green', 'yellow', 'red', 'unscored'];
const DIRECTIONS: FaultDirection[] = [
  'late',
  'early',
  'high',
  'low',
  'long',
  'none',
];

/** ISO-8601 renderings of one instant as different writers would emit it.
 * `ClipMediaStore.swift` uses ISO8601DateFormatter (UTC, seconds); JS
 * writers use `toISOString()` (UTC, milliseconds); the offset forms model a
 * hypothetical writer that keeps the device zone. */
export type IsoStyle = 'utc_seconds' | 'utc_millis' | 'offset';

export function isoFor(
  epochMs: number,
  style: IsoStyle,
  offsetMinutes: number,
): string {
  const date = new Date(epochMs);
  if (style === 'utc_millis') return date.toISOString();
  if (style === 'utc_seconds')
    return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const local = new Date(epochMs + offsetMinutes * 60_000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${local.toISOString().replace(/\.\d{3}Z$/, '')}${sign}${hh}:${mm}`;
}

/** UTC offset (minutes) of `zone` at `epochMs`, via Intl only. */
export function zoneOffsetMinutes(zone: string, epochMs: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(epochMs));
  const get = (type: string) =>
    Number(parts.find(part => part.type === type)?.value ?? '0');
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

/** DST edges and date-line instants worth sorting across. */
export const EDGE_INSTANTS_ISO = [
  '2026-03-08T06:59:59.000Z', // America/New_York spring-forward (07:00Z)
  '2026-03-08T07:00:00.000Z',
  '2026-10-25T00:59:59.500Z', // Europe/London fall-back (01:00Z)
  '2026-10-25T01:00:00.000Z',
  '2026-04-04T15:29:59.000Z', // Australia/Lord_Howe 30-min DST end (15:30Z)
  '2026-04-04T15:30:00.000Z',
  '2026-01-01T09:59:59.999Z', // Pacific/Kiritimati +14 date rollover (10:00Z)
  '2026-01-01T10:00:00.000Z',
  '2026-12-31T11:59:59.000Z', // Etc/GMT+12 (UTC−12) date rollover (12:00Z)
  '2026-12-31T12:00:00.000Z',
];

function shotType(rng: Rng, locale: Locale, inputs: string[]): ShotTypeSlug {
  if (rng.bool(0.5)) return rng.pick(SHOT_TYPES);
  const text = localeString(rng, locale);
  inputs.push(text);
  // Persisted records are unvalidated JSON: a slug can be any string.
  return text as ShotTypeSlug;
}

function phases(rng: Rng, nonFinite: boolean): PhaseSpan[] {
  const count = rng.pick([0, 0, 1, 2, 6, 6, 6, 12]);
  const keys: PhaseKey[] = [...PHASES];
  let cursor = rng.pick([0, 2000, 1e6]);
  const spans: PhaseSpan[] = [];
  for (let i = 0; i < count; i += 1) {
    const key = keys[i % keys.length] as PhaseKey;
    const sane = rng.bool(0.7);
    const startMs = sane ? cursor : boundaryNumber(rng, nonFinite);
    const length = sane ? rng.int(1, 400) : boundaryNumber(rng, nonFinite);
    const endMs = sane ? startMs + length : boundaryNumber(rng, nonFinite);
    cursor = sane ? endMs : cursor;
    spans.push({
      key,
      startMs,
      representativeMs: sane
        ? startMs + length / 2
        : boundaryNumber(rng, nonFinite),
      endMs,
      confidence: rng.pick([0, 0.3, 0.8, 1, -1, 2]),
    });
  }
  return spans;
}

function measurements(
  rng: Rng,
  locale: Locale,
  inputs: string[],
  nonFinite: boolean,
): Measurement[] {
  const count = rng.pick([0, 1, 4, 5, 9, 30]);
  const list: Measurement[] = [];
  for (let i = 0; i < count; i += 1) {
    // Keys stay unique per analysis (the engine emits one row per metric);
    // the duplicate-key hazard is pinned separately in the model suite.
    const key = rng.bool(0.5)
      ? `metric_${i}_wrist_speed`
      : `${localeString(rng, locale)}#${i}`;
    inputs.push(key);
    list.push({
      metricKey: key,
      value: boundaryNumber(rng, nonFinite),
      confidence: rng.pick([0, 0.5, 1]),
      unit: rng.pick(UNITS),
      source: 'real',
    });
  }
  return list;
}

function checkpoints(rng: Rng, nonFinite: boolean): CheckpointScore[] {
  if (rng.bool(0.2)) return [];
  return CHECKPOINTS.map((key: CheckpointKey) => {
    const score = rng.bool(0.15)
      ? null
      : rng.bool(0.7)
        ? rng.int(0, 100)
        : boundaryNumber(rng, nonFinite);
    return {
      key,
      score,
      confidence: rng.pick([0, 0.5, 0.8, 1]),
      band: rng.pick(BANDS),
      direction: rng.pick(DIRECTIONS),
      severity: score === null ? 0 : rng.pick([0, 0.5, 1, -1, 1e9]),
      applicable: rng.bool(0.85),
    };
  });
}

function analysisFor(
  rng: Rng,
  locale: Locale,
  inputs: string[],
  nonFinite: boolean,
  overrides: Partial<ShotAnalysis>,
): ShotAnalysis {
  const sane = rng.bool(0.6);
  const startMs = sane
    ? rng.pick([0, 2000, 1e6])
    : boundaryNumber(rng, nonFinite);
  const endMs = sane
    ? startMs + rng.int(1, 5000)
    : boundaryNumber(rng, nonFinite);
  const guidance = rng.bool(0.5) ? null : localeString(rng, locale);
  if (guidance !== null) inputs.push(guidance);
  return {
    id: 'analysis-current',
    sessionId: rng.pick([null, 'session-a']),
    shotType: shotType(rng, locale, inputs),
    cameraView: rng.pick(['side', 'rear_oblique']),
    handedness: rng.pick(['right', 'left', 'ambidextrous']),
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: {
      startMs,
      contactMs: rng.bool(0.4)
        ? null
        : sane
          ? startMs + rng.int(0, 5000)
          : boundaryNumber(rng, nonFinite),
      endMs,
    },
    phases: phases(rng, nonFinite),
    measurements: measurements(rng, locale, inputs, nonFinite),
    checkpoints: checkpoints(rng, nonFinite),
    overallScore: rng.bool(0.3)
      ? null
      : rng.bool(0.6)
        ? rng.int(0, 10)
        : boundaryNumber(rng, nonFinite),
    analysisConfidence: rng.pick([0, 0.5, 0.82, 1]),
    resultKind: 'scored',
    guidance,
    priorityFix: rng.bool(0.5)
      ? null
      : {
          checkpoint: rng.pick(CHECKPOINTS),
          reasonKey: 'lowest_score',
          severity: rng.pick([0, 0.52, 1]),
          confidence: 0.8,
        },
    versionVector: VERSION_VECTOR,
    source: 'real',
    ...overrides,
  };
}

function limitingFactors(rng: Rng, locale: Locale, inputs: string[]): string[] {
  const out: string[] = [];
  if (rng.bool(0.6)) out.push(...STRUCTURAL_FACTORS);
  const extra = rng.pick([0, 0, 1, 2, 5]);
  for (let i = 0; i < extra; i += 1) {
    const roll = rng.next();
    if (roll < 0.3) out.push(rng.pick(KNOWN_FACTORS));
    else if (roll < 0.5)
      out.push(`checkpoint_unobserved:${rng.pick(CHECKPOINTS)}`);
    else {
      const text = localeString(rng, locale);
      inputs.push(text);
      out.push(text);
    }
  }
  return rng.shuffle(out);
}

function contact(
  rng: Rng,
  locale: Locale,
  inputs: string[],
  nonFinite: boolean,
): ContactEstimate | null | undefined {
  const roll = rng.next();
  if (roll < 0.3) return undefined;
  if (roll < 0.4) return null;
  if (roll < 0.6) {
    const reason = localeString(rng, locale);
    inputs.push(reason);
    return {
      status: 'abstained',
      reason,
      limitingFactors: limitingFactors(rng, locale, inputs),
    };
  }
  return {
    status: 'estimated',
    estimatedContactMs: rng.bool(0.6)
      ? rng.int(0, 5000)
      : boundaryNumber(rng, nonFinite),
    confidence: rng.pick([
      0,
      0.5,
      0.5999,
      0.6,
      0.9,
      1,
      -0.5,
      1.5,
      ...(nonFinite ? [Number.NaN] : []),
    ]),
    ballConfirmed: rng.bool(0.4),
    paddleConfirmed: rng.bool(0.4),
    limitingFactors: limitingFactors(rng, locale, inputs),
    supportingEvidence: [],
  };
}

function temporalPhases(
  rng: Rng,
  locale: Locale,
  inputs: string[],
  nonFinite: boolean,
): TemporalPhasesV2 | null | undefined {
  const roll = rng.next();
  if (roll < 0.3) return undefined;
  if (roll < 0.4) return null;
  if (roll < 0.55) {
    const reason = localeString(rng, locale);
    inputs.push(reason);
    return { status: 'abstained', reason };
  }
  const sane = rng.bool(0.6);
  const b = (fallback: number) =>
    sane ? fallback : boundaryNumber(rng, nonFinite);
  const anchorFree = rng.bool(0.4);
  return {
    status: 'segmented',
    boundaries: {
      version: localeString(rng, locale),
      source: rng.pick(['paddle', 'wrist']),
      anchor: anchorFree ? 'speed_peak' : 'contact_estimate',
      ...(anchorFree ? { anchorBasis: 'event_peak' as const } : {}),
      confidence: rng.pick([0, 0.32, 0.8, 1]),
      preparationStartMs: rng.bool(0.3) ? null : b(2050),
      accelerationStartMs: b(2200),
      contactMs: anchorFree || rng.bool(0.2) ? null : b(2400),
      ...(rng.bool(0.5) ? { motionPeakMs: b(2380) } : {}),
      followThroughEndMs: b(2600),
      recoveryEndMs: rng.bool(0.3) ? null : b(2680),
    },
  };
}

function intentFor(
  rng: Rng,
  shape: ScenarioShape,
  locale: Locale,
  inputs: string[],
): StrokeIntentEnvelope | null | undefined {
  const declared = shotType(rng, locale, inputs);
  const label = rng.bool(0.5)
    ? rng.pick(['FOREHAND', 'BACKHAND', 'UNKNOWN'])
    : localeString(rng, locale);
  inputs.push(label);
  const leaf = rng.bool(0.5)
    ? rng.pick(['FOREHAND_DRIVE', 'OVERHEAD'])
    : localeString(rng, locale);
  inputs.push(leaf);
  const predicted = {
    taxonomyVersion: 'tax-1',
    classifierVersion: 'cls-1',
    label,
    leaf: rng.bool(0.5) ? leaf : null,
    taxonomyDepth: rng.pick([1, 2, 3] as const),
    confidence: rng.pick([0, 0.5, 1]),
    evidence: [],
    limitingFactors: limitingFactors(rng, locale, inputs),
  };
  const base = {
    declaredStroke: declared,
    predictedStroke: rng.bool(0.5) ? predicted : null,
    resolvedProfileId: rng.pick([null, 'FOREHAND_DRIVE']),
    resolvedProfileVersion: rng.pick([null, 'technique-profile-v1']),
    disagreement: null,
  };
  switch (shape) {
    case 'scored_declared':
    case 'low_confidence':
      return {
        ...base,
        resolutionBasis: 'declared',
        declaredStroke: rng.bool(0.9) ? declared : null,
      };
    case 'scored_predicted_l3':
      return {
        ...base,
        resolutionBasis: 'predicted_l3',
        declaredStroke: null,
        predictedStroke: predicted,
      };
    case 'predicted_family':
      return {
        ...base,
        resolutionBasis: 'predicted_family',
        declaredStroke: null,
        predictedStroke: rng.bool(0.7) ? predicted : null,
      };
    case 'abstained_intent':
      return {
        ...base,
        resolutionBasis: 'abstained',
        declaredStroke: null,
        predictedStroke: null,
      };
    case 'disagreement': {
      const predictedLabel = localeString(rng, locale);
      inputs.push(predictedLabel);
      return {
        ...base,
        resolutionBasis: 'declared',
        disagreement: { declared, predictedLabel, basis: 'leaf_vs_declared' },
      };
    }
    case 'unknown_basis':
      // Unvalidated JSON: a basis this build does not know.
      return {
        ...base,
        resolutionBasis: localeString(
          rng,
          locale,
        ) as StrokeIntentEnvelope['resolutionBasis'],
      };
    case 'no_intent_saved':
      return rng.bool(0.5) ? null : undefined;
    default:
      return null;
  }
}

function attemptsFor(
  rng: Rng,
  timezone: string,
  currentId: string,
): AttemptRef[] | undefined {
  const roll = rng.next();
  if (roll < 0.2) return undefined;
  if (roll < 0.3) return [];
  const count = rng.pick([1, 2, 3, 5, 8]);
  const style = rng.pick<IsoStyle>(['utc_seconds', 'utc_millis', 'utc_millis']);
  const session = rng.pick([null, 'session-a']);
  const startIso = rng.pick(EDGE_INSTANTS_ISO);
  const start = Date.parse(startIso);
  const stepMs = rng.pick([1000, 1000, 37_000, 250]);
  const list: AttemptRef[] = [];
  for (let i = 0; i < count; i += 1) {
    const epoch = start + i * stepMs;
    list.push({
      analysisId: i === 0 ? currentId : `attempt-${rng.int(0, 99_999)}-${i}`,
      capturedAtIso: isoFor(epoch, style, zoneOffsetMinutes(timezone, epoch)),
      sessionId: rng.bool(0.85) ? session : rng.pick([null, 'session-b']),
    });
  }
  return rng.shuffle(list);
}

export function buildScenario(seed: number, tier: Tier): Scenario {
  const rng = new Rng(seed);
  const locale = LOCALES[seed % LOCALES.length] as Locale;
  const fontScale = FONT_SCALES[
    Math.floor(seed / LOCALES.length) % FONT_SCALES.length
  ] as (typeof FONT_SCALES)[number];
  const width = WIDTHS[
    Math.floor(seed / (LOCALES.length * FONT_SCALES.length)) % WIDTHS.length
  ] as (typeof WIDTHS)[number];
  const timezone = TIMEZONES[
    seed % TIMEZONES.length
  ] as (typeof TIMEZONES)[number];
  const shape = SHAPES[rng.int(0, SHAPES.length - 1)] as ScenarioShape;
  const inputs: string[] = [];
  const nonFinite = tier === 'hostile';
  const currentAnalysisId = 'analysis-current';

  let analysis: ShotAnalysis | null = null;
  let record: StrokeResultEvidenceRecord | null = null;

  const intent = intentFor(rng, shape, locale, inputs);
  const uncertainty = rng.bool(0.15)
    ? null
    : {
        analysisConfidence: rng.pick([0, 0.5, 0.82, 1]),
        presentation: rng.pick(['normal', 'muted', localeString(rng, locale)]),
        limitingFactors: limitingFactors(rng, locale, inputs),
      };

  switch (shape) {
    case 'analysis_only':
      analysis = analysisFor(rng, locale, inputs, nonFinite, {});
      break;
    case 'all_null':
      break;
    case 'record_only_null_result':
      record = { id: 'rec', strokeIntent: intent, result: null, uncertainty };
      break;
    case 'low_confidence':
      analysis = analysisFor(rng, locale, inputs, nonFinite, {
        resultKind: 'low_confidence',
        overallScore: null,
      });
      record = {
        id: 'rec',
        strokeIntent: intent,
        result: rng.bool(0.5) ? analysis : null,
        uncertainty,
      };
      break;
    default:
      analysis = rng.bool(0.8)
        ? analysisFor(rng, locale, inputs, nonFinite, {})
        : null;
      record = {
        id: 'rec',
        ...(rng.bool(0.5) ? { captureId: 'capture-1' } : {}),
        strokeIntent: intent,
        result: rng.bool(0.5) ? analysis : null,
        uncertainty,
        contact: contact(rng, locale, inputs, nonFinite),
        temporalPhasesV2: temporalPhases(rng, locale, inputs, nonFinite),
      };
  }

  const clipRoll = rng.next();
  const clip: StrokeResultClip | null =
    clipRoll < 0.35
      ? null
      : {
          uri: 'file:///clip.mov',
          durationMs:
            clipRoll < 0.75
              ? rng.pick([1, 4200, 60_000, 1e9])
              : boundaryNumber(rng, nonFinite),
          ...(rng.bool(0.5) ? { posterUri: 'file:///poster.jpg' } : {}),
        };

  const slotText = () => {
    if (rng.bool(0.6)) return null;
    const text = localeString(rng, locale);
    inputs.push(text);
    return text;
  };
  const slots = {
    score: slotText(),
    review: slotText(),
    fix: slotText(),
    children: slotText(),
  };

  const mutations: string[] = [];
  if (tier === 'hostile')
    applyHostileMutations(rng, analysis, record, mutations);

  return {
    seed,
    tier,
    locale,
    fontScale,
    width,
    timezone,
    shape,
    analysis,
    record,
    clip,
    attempts: attemptsFor(rng, timezone, currentAnalysisId),
    currentAnalysisId,
    inputs,
    slots,
    hideCtaRow: rng.bool(0.2),
    mutations,
  };
}

/** Shape drift a stale/corrupted persisted record could carry. Each
 * mutation is named so the outcome table can attribute a throw to it. */
function applyHostileMutations(
  rng: Rng,
  analysis: ShotAnalysis | null,
  record: StrokeResultEvidenceRecord | null,
  mutations: string[],
): void {
  const loose = (value: unknown) => value as Record<string, unknown>;
  const picks = rng.int(1, 3);
  for (let i = 0; i < picks; i += 1) {
    const which = rng.int(0, 8);
    switch (which) {
      case 0:
        if (analysis) {
          delete loose(analysis)['timestamps'];
          mutations.push('analysis.timestamps=undefined');
        }
        break;
      case 1:
        if (analysis && analysis.measurements.length > 0) {
          loose(analysis.measurements[0])['value'] = '12.5';
          mutations.push('measurements[0].value="12.5"');
        }
        break;
      case 2:
        if (analysis && analysis.measurements.length > 0) {
          delete loose(analysis.measurements[0])['unit'];
          mutations.push('measurements[0].unit=undefined');
        }
        break;
      case 3:
        if (record?.uncertainty?.limitingFactors) {
          (record.uncertainty.limitingFactors as unknown[]).push(null);
          mutations.push('uncertainty.limitingFactors[]=null');
        }
        break;
      case 4:
        if (record?.contact && record.contact.status === 'abstained') {
          delete loose(record.contact)['reason'];
          mutations.push('contact.reason=undefined');
        }
        break;
      case 5:
        if (
          record?.temporalPhasesV2 &&
          record.temporalPhasesV2.status === 'abstained'
        ) {
          delete loose(record.temporalPhasesV2)['reason'];
          mutations.push('temporalPhasesV2.reason=undefined');
        }
        break;
      case 6:
        if (record?.strokeIntent?.disagreement) {
          delete loose(record.strokeIntent.disagreement)['declared'];
          mutations.push('disagreement.declared=undefined');
        }
        break;
      case 7:
        if (analysis) {
          loose(analysis)['phases'] = null;
          mutations.push('analysis.phases=null');
        }
        break;
      default:
        if (analysis) {
          loose(analysis)['checkpoints'] = [null];
          mutations.push('analysis.checkpoints=[null]');
        }
    }
  }
}
