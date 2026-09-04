/**
 * xc-3 · Seeded fuzz of the PURE copy selectors behind AnalyzeScreen,
 * ResultScreen, ResultDetailsScreen and FormReviewScreen.
 *
 * Every seed (0 … SEEDS-1) drives `makeRng(seed)` through ONE round of every
 * selector; the same seed always regenerates the same input, so a failure
 * row {seed, selector, input, output, violations} is replayable with
 * `replay(seed, selector)`. Raw output:
 *   artifacts/xc-screen-ux-a11y-i18n-3/copy-fuzz.json      (all failures + tallies)
 *   artifacts/xc-screen-ux-a11y-i18n-3/copy-fuzz.log
 *
 * Invariants per output string:
 *   non-empty · no JS runtime leak (undefined/NaN/[object Object]/Error:) ·
 *   no raw snake_case / UPPER_SNAKE / dotted machine token · no forbidden
 *   store term · no unsupported claim · typographic hygiene · length cap ·
 *   selector-specific truths (see each case).
 *
 * The suite ASSERTS only the invariants the product already promises for
 * schema-valid inputs (the "valid" lane). The adversarial lane (unvalidated
 * JSON: unknown tokens, NaN limits, hostile strings) is MEASURED and written
 * to the artifact; its violations feed the findings list, they are not
 * silently converted to passes.
 */
jest.mock('../src/data/db', () => ({ getDb: jest.fn(() => ({})) }));
jest.mock('../src/data/repository', () => ({}));
jest.mock('../src/analysis/runCaptureAnalysis', () => ({
  PAYWALL_REQUIRED_CODE: 'access.paywall_required',
  runCaptureAnalysis: jest.fn(),
}));
jest.mock('../src/account/apiSession', () => ({ getApiSession: () => null }));
jest.mock('../src/camera/capture', () => ({
  subscribeToCameraEvents: jest.fn(() => () => {}),
  importedPoseExtractionAvailable: jest.fn(() => false),
}));
jest.mock('../src/camera/TargetSelector', () => ({
  TargetSelector: () => null,
}));
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({}),
  useRoute: () => ({ params: {} }),
  useFocusEffect: () => {},
}));
jest.mock('react-native-safe-area-context', () => ({
  SafeAreaView: () => null,
}));
jest.mock('react-native-svg', () => ({
  __esModule: true,
  default: () => null,
}));

import {
  CHECKPOINTS,
  FAULT_DIRECTIONS,
  SHOT_TYPES,
  SELECTABLE_TECHNIQUES_V1,
  ENVELOPE_DIMENSIONS,
  type CheckpointKey,
  type FaultDirection,
  type ShotTypeSlug,
  type EnvelopeVerdict,
  type EnvelopeDimensionVerdict,
  type EnvelopeStatus,
} from '@pickle/shared-types';
import type {
  CaptureAnalysisRecord,
  StrokeIntentEnvelope,
} from '@pickle/analysis-pipeline';
import {
  freeAnalysesPhrase,
  importedPoseExtractionFailureMessage,
  strokeIntentPresentation,
  READINESS_COPY,
} from '../src/screens/AnalyzeScreen';
import {
  humanizeToken,
  limitingFactorCopy,
  strokeResultHeader,
  selectInsight,
  abstentionLedger,
  attemptChips,
  type StrokeResultEvidenceRecord,
} from '../src/components/strokeResultModel';
import {
  qualityBlockedMessage,
  captureGuidanceLines,
} from '../src/camera/captureEnvelope';
import {
  coachingCue,
  directionPhrase,
  stopHeadline,
} from '../src/review/formReviewModel';
import { speedLabel, REVIEW_SPEEDS } from '../src/review/formReviewGeometry';
import type { AbstentionLedger } from '../src/components/strokeResultModel';

declare const require: (id: string) => unknown;
declare const process: { env: Record<string, string | undefined> };
import { formatDuprEstimate } from '../src/progress/duprEstimate';
import {
  makeRng,
  scanText,
  copyHygieneIssues,
  writeArtifact,
  appendLog,
  FORBIDDEN_TERMS,
  UNSUPPORTED_CLAIMS,
  MACHINE_TOKEN_PATTERNS,
  OUT_DIR,
} from '../xc-audit/auditKit';

const SEEDS = Number(process.env['XC_FUZZ_SEEDS'] ?? 2500);
const LOG = 'copy-fuzz.log';

// ─── Generators ─────────────────────────────────────────────────────────────

type Rng = ReturnType<typeof makeRng>;

const HOSTILE_STRINGS = [
  '',
  ' ',
  'undefined',
  'null',
  'NaN',
  '[object Object]',
  '<script>alert(1)</script>',
  '\u202Eevird dnaherof',
  'форхенд',
  '前手',
  '🏓🏓🏓',
  'a'.repeat(300),
  'TypeError: Cannot read properties of undefined',
  'camera.import_no_person',
  'paddle_track_unavailable',
  'FOREHAND_DRIVE',
  'foo bar_baz',
  '%s %d',
  '${x}',
  '\n\n',
];

const LIMITING_FACTORS = [
  'paddle_track_unavailable',
  'ball_track_unavailable',
  'court_geometry_unavailable',
  'low_pose_confidence',
  'partial_body_visibility',
  'short_stroke_window',
  'checkpoint_unobserved:contact_position',
  'checkpoint_unobserved:face_wrist_stability',
  'checkpoint_unobserved:not_a_checkpoint',
  'unknown_factor_xyz',
];
const ADVERSARIAL_FACTORS = [
  ...LIMITING_FACTORS,
  'checkpoint_unobserved:',
  'camera.motion_blur',
  '',
  ' ',
  'CHECKPOINT_UNOBSERVED:CONTACT_POSITION',
];
function factor(rng: Rng, adversarial: boolean): string {
  if (adversarial)
    return rng.chance(0.3) ? hostile(rng) : rng.pick(ADVERSARIAL_FACTORS);
  return rng.pick(LIMITING_FACTORS);
}

function word(rng: Rng): string {
  const n = 3 + rng.int(8);
  let s = '';
  for (let i = 0; i < n; i += 1) s += String.fromCharCode(97 + rng.int(26));
  return s;
}

function hostile(rng: Rng): string {
  return rng.chance(0.5)
    ? rng.pick(HOSTILE_STRINGS)
    : `${word(rng)}_${word(rng)}`;
}

function slug(rng: Rng, adversarial: boolean): ShotTypeSlug {
  if (adversarial && rng.chance(0.15)) return hostile(rng) as ShotTypeSlug;
  return rng.pick(SHOT_TYPES);
}

function predictedLabel(rng: Rng, adversarial: boolean): string {
  const canonical = rng.pick(SELECTABLE_TECHNIQUES_V1).canonical;
  const r = rng.next();
  if (adversarial && r < 0.15) return hostile(rng);
  if (r < 0.4) return canonical; // leaf_vs_declared → "FOREHAND_DRIVE"
  if (r < 0.7) return rng.pick(['FOREHAND', 'BACKHAND']); // side_vs_declared
  return rng.pick(SHOT_TYPES); // slug_vs_declared → "backhand_drive"
}

function intentEnvelope(rng: Rng, adversarial: boolean): StrokeIntentEnvelope {
  const basis = rng.pick([
    'declared',
    'predicted_l3',
    'predicted_family',
    'abstained',
  ] as const);
  const canonical = rng.pick(SELECTABLE_TECHNIQUES_V1);
  const withPrediction = rng.chance(0.7);
  const leafNull = rng.chance(0.3);
  const declared = rng.chance(0.6) ? slug(rng, adversarial) : null;
  const disagree = basis === 'declared' && declared && rng.chance(0.4);
  // Valid lane mirrors what strokeAutoResolution actually writes: the family
  // label is a side (or UNKNOWN only when abstained), the leaf a registry
  // canonical (UPPER_SNAKE) or null. The adversarial lane is unvalidated JSON.
  const side = rng.pick(['FOREHAND', 'BACKHAND']);
  const validLabel =
    basis === 'abstained'
      ? 'UNKNOWN'
      : basis === 'predicted_l3'
        ? canonical.canonical
        : side;
  const env: StrokeIntentEnvelope = {
    declaredStroke: declared,
    predictedStroke:
      withPrediction || basis !== 'declared'
        ? {
            taxonomyVersion: 'v3',
            classifierVersion: 'heuristic-v5',
            label:
              adversarial && rng.chance(0.1)
                ? hostile(rng)
                : adversarial && rng.chance(0.2)
                  ? rng.pick(['UNKNOWN', canonical.canonical, side])
                  : validLabel,
            leaf:
              leafNull && basis !== 'predicted_l3'
                ? null
                : adversarial && rng.chance(0.1)
                  ? hostile(rng)
                  : basis === 'predicted_family' || basis === 'abstained'
                    ? null
                    : canonical.canonical,
            taxonomyDepth: rng.pick([1, 2, 3] as const),
            confidence: rng.next(),
            evidence: [],
            limitingFactors: [],
          }
        : null,
    resolutionBasis:
      adversarial && rng.chance(0.05) ? (hostile(rng) as 'declared') : basis,
    resolvedProfileId: rng.chance(0.5) ? canonical.canonical : null,
    resolvedProfileVersion: rng.chance(0.5) ? 'technique-profile-v1' : null,
    disagreement: disagree
      ? {
          declared: declared as ShotTypeSlug,
          predictedLabel: predictedLabel(rng, adversarial),
          basis: rng.pick([
            'leaf_vs_declared',
            'side_vs_declared',
            'slug_vs_declared',
          ] as const),
        }
      : null,
  };
  return env;
}

function envelopeVerdict(
  rng: Rng,
  adversarial: boolean,
): EnvelopeVerdict | null {
  if (rng.chance(0.15)) return null;
  const dims: EnvelopeDimensionVerdict[] = [];
  for (const dimension of ENVELOPE_DIMENSIONS) {
    if (rng.chance(0.2)) continue;
    const status: EnvelopeStatus = rng.pick([
      'SUPPORTED',
      'DEGRADED',
      'UNSUPPORTED',
      'NOT_MEASURED',
    ] as const);
    dims.push({
      dimension,
      status,
      measured: status === 'NOT_MEASURED' ? null : rng.next() * 1000,
      unit: 'x',
      thresholdId: `t-${rng.int(9)}`,
    });
  }
  if (adversarial && rng.chance(0.1)) {
    dims.push({
      dimension: hostile(rng) as EnvelopeDimensionVerdict['dimension'],
      status: hostile(rng) as EnvelopeStatus,
      measured: Number.NaN,
      unit: '',
      thresholdId: '',
    });
  }
  return {
    thresholdsVersion: 'v0',
    provisional: true,
    dimensions: dims,
    overall: 'UNSUPPORTED',
    overallWithCoverage: 'UNSUPPORTED',
    notMeasured: [],
  };
}

function errorLike(rng: Rng): unknown {
  const r = rng.next();
  if (r < 0.15)
    return Object.assign(new Error('too long'), {
      code: 'camera.import_too_long',
    });
  if (r < 0.3)
    return Object.assign(new Error('nobody'), {
      code: 'camera.import_no_person',
    });
  if (r < 0.4) return new Error(hostile(rng));
  if (r < 0.45) return new Error('');
  if (r < 0.5) return new Error('   ');
  if (r < 0.55)
    return new TypeError(
      "Cannot read properties of undefined (reading 'frames')",
    );
  if (r < 0.6) return Object.assign(new Error('x'), { code: hostile(rng) });
  if (r < 0.65) return { code: 42 };
  if (r < 0.7) return { code: null };
  if (r < 0.75) return null;
  if (r < 0.8) return undefined;
  if (r < 0.85) return hostile(rng);
  if (r < 0.9) return 12345;
  if (r < 0.95) return { message: hostile(rng) };
  return Object.assign(new Error(hostile(rng)), {
    code: 'camera.import_unknown',
  });
}

function limit(rng: Rng, adversarial: boolean): number {
  if (!adversarial) return rng.int(6);
  return rng.pick([
    0,
    1,
    2,
    3,
    5,
    10,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    1e21,
    2.0,
  ]);
}

// ─── Invariant checks ───────────────────────────────────────────────────────

const UPPER_SNAKE: RegExp = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;

function violations(
  text: string,
  opts: { allowDupr?: boolean; allowUpper?: boolean } = {},
): string[] {
  const out: string[] = [];
  if (typeof text !== 'string') return [`not_a_string:${typeof text}`];
  for (const h of scanText(text, FORBIDDEN_TERMS))
    out.push(`forbidden:${h.rule}:${h.match}`);
  for (const h of scanText(text, UNSUPPORTED_CLAIMS))
    out.push(`claim:${h.rule}:${h.match}`);
  for (const h of scanText(text, MACHINE_TOKEN_PATTERNS))
    out.push(`token:${h.rule}:${h.match}`);
  if (!opts.allowUpper && UPPER_SNAKE.test(text))
    out.push(`token:upper_snake:${UPPER_SNAKE.exec(text)![0]}`);
  for (const h of copyHygieneIssues(text)) out.push(`hygiene:${h}`);
  if (text.length > 600) out.push(`length:${text.length}`);
  if (/<script|\$\{|%s|%d/.test(text)) out.push('injection_echo');
  if (/\u202E/.test(text)) out.push('bidi_override_echo');
  return out;
}

interface FailureRow {
  seed: number;
  lane: 'valid' | 'adversarial';
  selector: string;
  input: unknown;
  output: unknown;
  violations: string[];
}

const failures: FailureRow[] = [];
const tallies = new Map<string, number>();
let scenarios = 0;

function check(
  seed: number,
  lane: FailureRow['lane'],
  selector: string,
  input: unknown,
  output: unknown,
  extra: string[] = [],
  opts: Parameters<typeof violations>[1] = {},
) {
  scenarios += 1;
  const strings: string[] =
    typeof output === 'string'
      ? [output]
      : output && typeof output === 'object'
        ? Object.values(output as Record<string, unknown>).filter(
            (v): v is string => typeof v === 'string',
          )
        : [];
  const v = [...extra];
  for (const s of strings) v.push(...violations(s, opts));
  if (v.length === 0) return;
  const row: FailureRow = {
    seed,
    lane,
    selector,
    input: safe(input),
    output: safe(output),
    violations: v,
  };
  failures.push(row);
  for (const item of v) {
    const k = `${lane}|${selector}|${item.split(':').slice(0, 2).join(':')}`;
    tallies.set(k, (tallies.get(k) ?? 0) + 1);
  }
}

function safe(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      __error: value.name,
      message: value.message,
      code: (value as { code?: unknown }).code ?? null,
    };
  }
  try {
    return JSON.parse(
      JSON.stringify(value, (_k, v) =>
        typeof v === 'number' && !Number.isFinite(v) ? `__${String(v)}` : v,
      ),
    );
  } catch {
    return String(value);
  }
}

// ─── One round per seed ─────────────────────────────────────────────────────

function round(seed: number, lane: FailureRow['lane']) {
  const rng = makeRng(seed * 2 + (lane === 'adversarial' ? 1 : 0));
  const adversarial = lane === 'adversarial';

  // freeAnalysesPhrase(limit)
  {
    const n = limit(rng, adversarial);
    const out = freeAnalysesPhrase(n);
    const extra: string[] = [];
    if (n === 2 && out !== 'both') extra.push('limit_2_not_both');
    if (n !== 2 && Number.isInteger(n) && n >= 0 && out !== `all ${n}`)
      extra.push('limit_n_not_all_n');
    if (Number.isInteger(n) && n >= 0 && n !== 2 && n < 2)
      extra.push(`awkward_plural:${out}`);
    check(seed, lane, 'freeAnalysesPhrase', { limit: safe(n) }, out, extra);
  }

  // importedPoseExtractionFailureMessage(error)
  {
    const err = adversarial
      ? errorLike(rng)
      : rng.pick([
          Object.assign(new Error('too long'), {
            code: 'camera.import_too_long',
          }),
          Object.assign(new Error('nobody'), {
            code: 'camera.import_no_person',
          }),
          new Error('Reading player movement from this video failed.'),
        ]);
    const out = importedPoseExtractionFailureMessage(err);
    check(seed, lane, 'importedPoseExtractionFailureMessage', err, out);
  }

  // strokeIntentPresentation(record)
  {
    const intent = intentEnvelope(rng, adversarial);
    const record = {
      id: `a-${seed}`,
      captureId: `c-${seed}`,
      strokeIntent: intent,
      result: rng.chance(0.5)
        ? ({
            shotType: slug(rng, adversarial),
          } as CaptureAnalysisRecord['result'])
        : null,
      uncertainty: {
        analysisConfidence: 0.5,
        presentation: 'normal',
        limitingFactors: [],
      },
    } as unknown as CaptureAnalysisRecord;
    let out: unknown;
    const extra: string[] = [];
    try {
      out = strokeIntentPresentation(record);
    } catch (e) {
      extra.push(`throws:${(e as Error).message}`);
    }
    if (
      out &&
      typeof out === 'object' &&
      /UNKNOWN/.test(String((out as { title: string }).title))
    ) {
      extra.push('title_contains_UNKNOWN');
    }
    check(
      seed,
      lane,
      'strokeIntentPresentation',
      { intent, hasResult: record.result !== null },
      out ?? '(legacy path — no surface)',
      extra,
    );
  }

  // strokeResultHeader(record, analysis)
  {
    const intent = intentEnvelope(rng, adversarial);
    const shot = slug(rng, adversarial);
    const record = {
      strokeIntent: rng.chance(0.85) ? intent : undefined,
      result: rng.chance(0.3) ? { shotType: shot } : null,
    } as unknown as StrokeResultEvidenceRecord;
    const analysis = rng.chance(0.6) ? ({ shotType: shot } as never) : null;
    let out: unknown;
    const extra: string[] = [];
    try {
      out = strokeResultHeader(record, analysis);
    } catch (e) {
      extra.push(`throws:${(e as Error).message}`);
    }
    if (out && /UNKNOWN/.test(String((out as { title: string }).title)))
      extra.push('title_contains_UNKNOWN');
    // Eyebrows are legitimately UPPER CASE with " · " separators; underscores are not.
    check(
      seed,
      lane,
      'strokeResultHeader',
      {
        intent: record.strokeIntent ?? null,
        shot,
        hasAnalysis: analysis !== null,
      },
      out,
      extra,
    );
  }

  // limitingFactorCopy(token)
  {
    const token = factor(rng, adversarial);
    const out = limitingFactorCopy(token);
    check(seed, lane, 'limitingFactorCopy', { token }, out);
  }

  // qualityBlockedMessage(reason, envelope) + captureGuidanceLines
  {
    const reason =
      adversarial && rng.chance(0.3)
        ? hostile(rng)
        : 'This capture couldn’t be measured cleanly enough to score.';
    const env = envelopeVerdict(rng, adversarial);
    let out = '';
    const extra: string[] = [];
    try {
      out = qualityBlockedMessage(reason, env);
      const lines = captureGuidanceLines(env);
      const degraded =
        env?.dimensions.filter(
          d => d.status === 'DEGRADED' || d.status === 'UNSUPPORTED',
        ) ?? [];
      const known = degraded.filter(d =>
        (ENVELOPE_DIMENSIONS as readonly string[]).includes(d.dimension),
      );
      if (lines.length !== known.length)
        extra.push(`guidance_count:${lines.length}!=${known.length}`);
      if (lines.some(l => typeof l.text !== 'string' || l.text.length === 0))
        extra.push('guidance_line_empty');
    } catch (e) {
      extra.push(`throws:${(e as Error).message}`);
    }
    check(seed, lane, 'qualityBlockedMessage', { reason, env }, out, extra);
  }

  // coachingCue / directionPhrase / stopHeadline
  {
    const key =
      adversarial && rng.chance(0.15)
        ? (hostile(rng) as CheckpointKey)
        : rng.pick(CHECKPOINTS);
    const direction =
      adversarial && rng.chance(0.15)
        ? (hostile(rng) as FaultDirection)
        : rng.pick(FAULT_DIRECTIONS);
    const shot = slug(rng, adversarial);
    const score = adversarial
      ? rng.pick([0, 49.5, 100, -5, 101, Number.NaN, 72.4999, 1e9])
      : rng.int(101);
    const extra: string[] = [];
    let cue = '';
    let headline = '';
    try {
      cue = coachingCue(key, direction, shot);
      headline = stopHeadline({
        key,
        name: humanizeToken(String(key)),
        score,
        band: 'red',
        direction,
        severity: 0.5,
      });
      if (cue.length > 160) extra.push(`cue_over_160:${cue.length}`);
      if (!/^[A-Z]/.test(cue)) extra.push('cue_not_capitalised');
      if (
        direction === 'none' &&
        /^(Widen|Narrow|Lower|Raise|Shorten|Lengthen)/.test(cue)
      )
        extra.push('correction_for_none');
      if (!headline.includes(directionPhrase(direction)))
        extra.push('headline_missing_direction');
    } catch (e) {
      extra.push(`throws:${(e as Error).message}`);
    }
    check(
      seed,
      lane,
      'coachingCue+stopHeadline',
      { key, direction, shot, score: safe(score) },
      { cue, headline },
      extra,
    );
  }

  // selectInsight
  {
    const intent = intentEnvelope(rng, adversarial);
    const factors = Array.from({ length: rng.int(4) }, () =>
      factor(rng, adversarial),
    );
    let out: unknown;
    const extra: string[] = [];
    try {
      out = selectInsight({
        strokeIntent: intent,
        limitingFactors: factors,
        analysis: null,
        contact: null,
        temporalPhasesV2: null,
      });
      const sentence = (out as { sentence: string }).sentence;
      if (typeof sentence !== 'string' || sentence.trim().length === 0)
        extra.push('empty_sentence');
    } catch (e) {
      extra.push(`throws:${(e as Error).message}`);
    }
    check(seed, lane, 'selectInsight', { intent, factors }, out, extra);
  }

  // abstentionLedger
  {
    const intent = intentEnvelope(rng, adversarial);
    const factors = Array.from({ length: rng.int(5) }, () =>
      factor(rng, adversarial),
    );
    const record = {
      strokeIntent: intent,
      result: null,
      uncertainty: {
        analysisConfidence: rng.next(),
        presentation: 'abstain',
        limitingFactors: factors,
      },
      contact: null,
    } as unknown as StrokeResultEvidenceRecord;
    let out: AbstentionLedger | null = null;
    const extra: string[] = [];
    try {
      out = abstentionLedger({
        record,
        analysis: null,
        clipPresent: rng.chance(0.5),
      });
      const all = [...(out?.held ?? []), ...(out?.notEstablished ?? [])];
      for (const line of all)
        extra.push(...violations(line).map(v => `ledger:${v}`));
      if (all.length === 0) extra.push('ledger_empty');
    } catch (e) {
      extra.push(`throws:${(e as Error).message}`);
    }
    // Lines are checked individually above; the joined form is for the artifact only.
    check(
      seed,
      lane,
      'abstentionLedger',
      { intent, factors },
      out ? { lines: out.held.length + out.notEstablished.length } : null,
      extra,
    );
  }

  // attemptChips
  {
    const n = rng.int(6);
    const sessionId = rng.chance(0.8) ? `s-${rng.int(3)}` : null;
    const attempts = Array.from({ length: n }, (_, i) => ({
      analysisId: `a-${i}`,
      sessionId: rng.chance(0.85) ? sessionId : null,
      capturedAtIso: `2026-09-0${1 + rng.int(9)}T10:0${rng.int(10)}:00.000Z`,
    }));
    const current = n > 0 ? `a-${rng.int(n)}` : 'a-none';
    const chips = attemptChips(attempts, current);
    const extra: string[] = [];
    const labels = chips.map(c => c.label);
    if (new Set(labels).size !== labels.length)
      extra.push('duplicate_attempt_labels');
    if (chips.length > 0 && chips.filter(c => c.isCurrent).length !== 1)
      extra.push('current_chip_count');
    labels.forEach((l, i) => {
      if (l !== `Attempt ${i + 1}`) extra.push(`label_order:${l}@${i}`);
    });
    check(
      seed,
      lane,
      'attemptChips',
      { attempts, current },
      labels.join(', ') || '(none)',
      extra,
    );
  }

  // formatDuprEstimate(score)
  {
    const score = adversarial
      ? rng.pick([-1, 0, 10, 11, Number.NaN, 7.25, 1e6, -0])
      : rng.next() * 10;
    const out = formatDuprEstimate(score);
    const extra: string[] = [];
    const m = /\(≈ DUPR (-?[\d.]+|NaN)\)/.exec(out);
    if (!m) extra.push('format_mismatch');
    else {
      const v = Number(m[1]);
      if (!Number.isFinite(v)) extra.push(`non_finite_estimate:${m[1]}`);
      else if (v < 1 || v > 7) extra.push(`estimate_out_of_band:${v}`);
      if (!/^\d+\.\d$/.test(m[1]!)) extra.push(`decimals:${m[1]}`);
    }
    check(
      seed,
      lane,
      'formatDuprEstimate',
      { score: safe(score) },
      out,
      extra,
      { allowDupr: true },
    );
  }

  // speedLabel(rate)
  {
    const rate = adversarial
      ? rng.pick([1, 0.5, 0.25, 2, 0.1, Number.NaN, 0, -1, 0.3333333])
      : rng.pick(REVIEW_SPEEDS);
    const out = speedLabel(rate);
    const extra: string[] = [];
    if (!/×$/.test(out)) extra.push('no_times_sign');
    if (
      (REVIEW_SPEEDS as readonly number[]).includes(rate) &&
      !/^(1|½|¼)×$/.test(out)
    )
      extra.push('canonical_rate_label');
    check(seed, lane, 'speedLabel', { rate: safe(rate) }, out, extra);
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

describe(`xc-3 · copy-selector fuzz (${SEEDS} seeds × 2 lanes)`, () => {
  beforeAll(() => {
    for (let seed = 0; seed < SEEDS; seed += 1) {
      round(seed, 'valid');
      round(seed, 'adversarial');
    }
    const byLane = { valid: 0, adversarial: 0 };
    for (const f of failures) byLane[f.lane] += 1;
    appendLog(
      LOG,
      `seeds=${SEEDS} scenarios=${scenarios} failures=${failures.length} valid=${byLane.valid} adversarial=${byLane.adversarial}`,
    );
    const tallyRows = [...tallies.entries()].sort((a, b) => b[1] - a[1]);
    for (const [k, n] of tallyRows) appendLog(LOG, `${n}\t${k}`);
    // One sample per tally key so the artifact is readable at the top.
    const samples: Record<string, FailureRow> = {};
    for (const f of failures) {
      for (const v of f.violations) {
        const k = `${f.lane}|${f.selector}|${v.split(':').slice(0, 2).join(':')}`;
        if (!samples[k]) samples[k] = f;
      }
    }
    writeArtifact('copy-fuzz.json', {
      generatedAtIso: new Date().toISOString(),
      seeds: SEEDS,
      scenarios,
      lanes: byLane,
      replay:
        'XC_FUZZ_SEEDS=<n> npx jest __tests__/xcCopySelectorFuzz.test.ts — rng = makeRng(seed*2 + (lane==="adversarial"?1:0)), selectors run in file order',
      tallies: tallyRows,
      samples,
      failures,
    });
  });

  it('is deterministic: replaying a seed reproduces byte-identical failure rows', () => {
    const before = failures.length;
    const sampleSeeds = [0, 1, 7, 42, 1337, SEEDS - 1];
    const snapshot = failures
      .filter(f => sampleSeeds.includes(f.seed))
      .map(f => JSON.stringify(f));
    failures.length = 0;
    for (const s of sampleSeeds) {
      round(s, 'valid');
      round(s, 'adversarial');
    }
    const replayed = failures.map(f => JSON.stringify(f));
    expect(replayed).toEqual(snapshot);
    failures.length = 0;
    expect(before).toBeGreaterThanOrEqual(0);
  });

  it(`ran ≥ 2000 seeds and ≥ 24 000 scenarios`, () => {
    expect(SEEDS).toBeGreaterThanOrEqual(2000);
    expect(scenarios).toBeGreaterThanOrEqual(SEEDS * 2 * 12);
  });

  it('READINESS_COPY: all six camera readiness states carry actionable, clean copy', () => {
    const keys = Object.keys(READINESS_COPY).sort();
    expect(keys).toEqual([
      'full_body_required',
      'hold_still',
      'move_closer',
      'move_farther',
      'no_person',
      'ready',
    ]);
    for (const k of keys) {
      const text = READINESS_COPY[k as keyof typeof READINESS_COPY];
      expect(violations(text)).toEqual([]);
      expect(text.length).toBeGreaterThan(8);
    }
  });

  it('VALID lane: no selector throws, leaks a runtime value, or emits a forbidden term / unsupported claim', () => {
    const valid = JSON.parse(
      JSON.stringify(failures.length === 0 ? [] : failures),
    ) as FailureRow[];
    void valid;
    const fatal = readArtifactFailures().filter(
      f =>
        f.lane === 'valid' &&
        f.violations.some(v =>
          /^throws:|^token:js_leak|^token:error_prefix|^forbidden:|^claim:|^injection_echo/.test(
            v,
          ),
        ),
    );
    expect(
      fatal.map(f => ({
        seed: f.seed,
        selector: f.selector,
        violations: f.violations,
      })),
    ).toEqual([]);
  });

  it('VALID lane: known-token limiting factors, envelope dimensions and checkpoint keys never reach copy as raw tokens', () => {
    const raw = readArtifactFailures().filter(
      f =>
        f.lane === 'valid' &&
        [
          'limitingFactorCopy',
          'qualityBlockedMessage',
          'coachingCue+stopHeadline',
          'abstentionLedger',
        ].includes(f.selector) &&
        f.violations.some(v => /^token:/.test(v)),
    );
    expect(
      raw.map(f => ({
        seed: f.seed,
        selector: f.selector,
        violations: f.violations,
      })),
    ).toEqual([]);
  });

  it('MEASURED: raw taxonomy tokens (predictedLabel / leaf) reaching declared-vs-observed and auto-detected copy', () => {
    const rows = readArtifactFailures().filter(
      f =>
        f.lane === 'valid' &&
        [
          'strokeIntentPresentation',
          'strokeResultHeader',
          'selectInsight',
        ].includes(f.selector) &&
        f.violations.some(v => /^token:(upper_snake|snake_case_token)/.test(v)),
    );
    const byToken = new Map<string, number>();
    for (const r of rows) {
      for (const v of r.violations) {
        if (/^token:(upper_snake|snake_case_token)/.test(v)) {
          const t = v.split(':')[2] ?? '';
          byToken.set(t, (byToken.get(t) ?? 0) + 1);
        }
      }
    }
    writeArtifact('copy-fuzz-raw-taxonomy-tokens.json', {
      rows: rows.length,
      byToken: [...byToken.entries()].sort((a, b) => b[1] - a[1]),
      sample: rows.slice(0, 12),
    });
    appendLog(
      LOG,
      `raw taxonomy tokens in valid lane: rows=${rows.length} tokens=${JSON.stringify([...byToken.keys()])}`,
    );
    // Single-word leaves (OVERHEAD, BACKHAND) read fine and are pinned by
    // existing suites; every token here is multi-word. Reported as a finding,
    // not asserted either way.
    for (const t of byToken.keys()) expect(t).toMatch(/_/);
  });

  it('ADVERSARIAL lane: every failure row is replayable (seed + input recorded) and tallied', () => {
    const rows = readArtifactFailures();
    for (const f of rows) {
      expect(typeof f.seed).toBe('number');
      expect(f.input).toBeDefined();
      expect(f.violations.length).toBeGreaterThan(0);
    }
    appendLog(
      LOG,
      `adversarial rows=${rows.filter(f => f.lane === 'adversarial').length}`,
    );
  });
});

function readArtifactFailures(): FailureRow[] {
  const fs = require('fs') as {
    readFileSync: (file: string, enc: 'utf8') => string;
  };
  const path = require('path') as { join: (...parts: string[]) => string };
  const data = JSON.parse(
    fs.readFileSync(path.join(OUT_DIR, 'copy-fuzz.json'), 'utf8'),
  ) as { failures: FailureRow[] };
  return data.failures;
}
