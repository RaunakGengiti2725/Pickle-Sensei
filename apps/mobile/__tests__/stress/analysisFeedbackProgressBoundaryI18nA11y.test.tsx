/**
 * STRESS — unit `cmp-analysis-feedback-progress`, lens `boundary-i18n-a11y`.
 *
 * Campaign over AnalysisFeedbackPrompt + AnalysisProgressBar + UncertaintyNote:
 *   hostile strings (200+ chars ASCII, CJK, Arabic RTL, bidi controls, ZWJ
 *   emoji, combining marks, German compounds, Thai, Devanagari, Cyrillic,
 *   empty/whitespace/newlines, lone surrogates, format bait, localized huge
 *   numerals) × zero/negative/huge/non-finite numerics × 3 Dynamic Type
 *   scales × 3 container widths × 12 locales × 8 timezones (UTC±14, DST edges).
 *
 * Every variant is replayable from its seed:
 *   cd apps/mobile && STRESS_ONLY=<seed> npx jest --ci --silent \
 *     analysisFeedbackProgressBoundaryI18nA11y
 * Scale (default 60/30/30 = 120 variants, ~2s):
 *   STRESS_ITER=<n> multiplies the per-campaign counts by n/60.
 * Output: artifacts/stress/boundary-i18n-a11y.json (seed → outcome table),
 *   override the directory with STRESS_OUT=<dir>.
 *
 * Two defects this campaign FOUND are asserted in dedicated minimized repro
 * suites (they are recorded as `broken` in the JSON table here and excluded
 * from this file's assertions by their finding id, so this campaign keeps
 * signalling NEW regressions instead of re-reporting the known two). The
 * repros are RED until production is fixed, so they live outside jest's
 * default testMatch and run on demand:
 *   npx jest --ci --rootDir . --testMatch '<rootDir>/test-support/stress/repro/*.repro.@(ts|tsx)'
 *   F1 → test-support/stress/repro/analysisProgressLabelRowClipped.repro.tsx
 *   F2 → test-support/stress/repro/uncertaintyNotesMalformedRecord.repro.ts
 *
 * Invariants asserted (a failure is a finding, never a tolerated diff):
 *   A11Y-1  every interactive element declares accessibilityRole
 *   A11Y-2  every interactive element has an accessible name (explicit label
 *           or text content) — hostile text must not erase it
 *   A11Y-3  every interactive element declares a ≥44pt height AND models
 *           ≥44pt wide at every Dynamic Type scale
 *   A11Y-4  the progress surface keeps role=progressbar, a non-empty label
 *           for every production-reachable stage, and an integer 0..100
 *           `now` only in determinate mode
 *   BOUND-1 no rendered string ever leaks NaN / undefined / null / Infinity /
 *           [object Object] / scientific notation
 *   BOUND-2 no render, state transition or ETA fold throws
 *   BOUND-3 ETA math stays finite, ≥1s and null-at-100% across DST edges
 *   COPY-1  component-owned copy honours APP_STORE_SUBMISSION.md
 *
 * Layout numbers are MODELLED: Manrope advances are read from the shipped
 * .ttf files (exact, unkerned); scripts Manrope lacks use a documented
 * per-script estimate. Rendered-tree props are VERIFIED in the jest renderer,
 * which is not an iOS runtime.
 */
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  AnalysisProgressBar,
  ANALYSIS_DURATION_HINT,
  ANALYSIS_STAGE_LABELS,
  analysisStageProgress,
  extractionProgress,
  extractionEtaSeconds,
  extractionSublabel,
  observeExtractionProgress,
  type AnalysisStageKey,
  type ExtractionEtaState,
} from '../../src/components/AnalysisProgress';
import { AnalysisFeedbackPrompt } from '../../src/components/AnalysisFeedbackPrompt';
import {
  UncertaintyNote,
  uncertaintyNotes,
} from '../../src/components/UncertaintyNote';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { submitAnalysisFeedback } from '../../src/data/api';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidenceRecord } from '../../src/components/strokeResultModel';
import {
  CONTAINER_WIDTHS,
  DST_EDGE_INSTANTS_MS,
  FONT_SCALES,
  LOCALES,
  STRING_CATEGORIES,
  TIMEZONES,
  Rng,
  auditPressable,
  findPressables,
  forbiddenCopyIn,
  hostileString,
  leaksIn,
  measureSingleLine,
  modelLabelRow,
  rendererText,
  seedFrom,
  stressIterations,
  stressOnlySeed,
  writeArtifact,
  envSnapshot,
  type StringCategory,
} from '../../test-support/stress/boundaryI18nA11yHarness';

jest.mock('../../src/data/api', () => {
  const actual =
    jest.requireActual<typeof import('../../src/data/api')>(
      '../../src/data/api',
    );
  return { ...actual, submitAnalysisFeedback: jest.fn() };
});

const submitMock = submitAnalysisFeedback as jest.MockedFunction<
  typeof submitAnalysisFeedback
>;

declare const process: { env: Record<string, string | undefined> };

const CAPTION_PT = 13; // type.caption fontSize
const CAPTION_FONT = 'Manrope_500Medium' as const;
const MIN_TARGET = 44;
const STAGE_KEYS: AnalysisStageKey[] = [
  'verifying',
  'extracting',
  'measuring',
  'saving',
];

const BASE_ITER = stressIterations(60);
const ONLY = stressOnlySeed();
const PROGRESS_VARIANTS = BASE_ITER;
const FEEDBACK_VARIANTS = Math.ceil(BASE_ITER / 2);
const NOTE_VARIANTS = Math.ceil(BASE_ITER / 2);

/**
 * Known findings with their own minimized repro suites. Violations tagged
 * with one of these ids are still recorded in the JSON table (outcome
 * `broken`) but do not re-fail this campaign.
 *   F1  stage label clipped/collapsed by the non-shrinking sublabel
 *   F2  uncertaintyNotes throws on a shape-corrupt persisted record
 */
const KNOWN_FINDINGS = ['F1', 'F2'] as const;
type FindingId = (typeof KNOWN_FINDINGS)[number];

/** Tag a violation with the finding it belongs to, or null when it is new. */
function findingFor(violation: string): FindingId | null {
  if (violation.startsWith('LAYOUT-F1')) return 'F1';
  if (violation.startsWith('BOUND-2-F2')) return 'F2';
  return null;
}

function unknownViolations(result: VariantResult): string[] {
  return result.violations.filter(v => findingFor(v) === null);
}

interface VariantResult {
  seed: number;
  campaign: 'progress' | 'feedback' | 'uncertainty';
  replay: string;
  locale: string;
  timeZone: string;
  fontScale: number;
  fontScaleName: string;
  containerWidth: number;
  device: string;
  stringCategory: StringCategory | null;
  reachable: boolean;
  outcome: 'held' | 'broken';
  violations: string[];
  notes: Record<string, unknown>;
}

const results: VariantResult[] = [];

function replayCmd(seed: number, pattern: string): string {
  return `cd apps/mobile && STRESS_ONLY=${seed} npx jest --ci --silent ${pattern}`;
}

function withTimeZone<T>(zone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function localizedNumber(value: number, locale: string): string {
  try {
    return new Intl.NumberFormat(locale).format(value);
  } catch {
    return String(value);
  }
}

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function pickEnv(rng: Rng) {
  const fontScale = rng.pick(FONT_SCALES);
  const container = rng.pick(CONTAINER_WIDTHS);
  const locale = rng.pick(LOCALES);
  const zone = rng.pick(TIMEZONES);
  return { fontScale, container, locale, zone };
}

function auditAllPressables(
  renderer: TestRenderer.ReactTestRenderer,
  fontScale: number,
): { violations: string[]; audited: number; audits: unknown[] } {
  const violations: string[] = [];
  const audits = findPressables(renderer).map(node => {
    const audit = auditPressable(node, {
      fontScale,
      fontSizePt: CAPTION_PT,
      font: CAPTION_FONT,
    });
    for (const issue of audit.issues) {
      violations.push(`A11Y ${audit.testID ?? '<no testID>'}: ${issue}`);
    }
    return audit;
  });
  return { violations, audited: audits.length, audits };
}

/**
 * Leak/copy lint over rendered strings. A hostile prop echoed VERBATIM is the
 * component doing its job (it must not sanitize user data), so exact echoes
 * of `injected` strings are exempt from the leak lint; anything the
 * component composed itself (owned copy, formatted numbers) is linted.
 */
function textViolations(
  texts: string[],
  ownedCopy: boolean,
  injected: ReadonlyArray<string | null> = [],
): string[] {
  const violations: string[] = [];
  const echoes = new Set(injected.filter((s): s is string => s !== null));
  for (const text of texts) {
    if (!echoes.has(text)) {
      for (const leak of leaksIn(text)) {
        violations.push(`BOUND-1 leaked ${leak} in rendered text`);
      }
    }
    if (ownedCopy) {
      for (const forbidden of forbiddenCopyIn(text)) {
        violations.push(`COPY-1 forbidden pattern ${forbidden}`);
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Campaign 1 — AnalysisProgressBar
// ---------------------------------------------------------------------------

const NUMERIC_EDGES: Array<{ name: string; value: number | null }> = [
  { name: 'null-indeterminate', value: null },
  { name: 'zero', value: 0 },
  { name: 'negative-zero', value: -0 },
  { name: 'negative-one', value: -1 },
  { name: 'negative-huge', value: -1e308 },
  { name: 'one', value: 1 },
  { name: 'just-under-one', value: 1 - Number.EPSILON },
  { name: 'over-one', value: 1.0000001 },
  { name: 'huge', value: 1e308 },
  { name: 'max-safe-int', value: Number.MAX_SAFE_INTEGER },
  { name: 'min-value', value: Number.MIN_VALUE },
  { name: 'nan', value: Number.NaN },
  { name: 'infinity', value: Number.POSITIVE_INFINITY },
  { name: 'negative-infinity', value: Number.NEGATIVE_INFINITY },
];

async function runProgressVariant(seed: number): Promise<VariantResult> {
  const rng = new Rng(seed);
  const { fontScale, container, locale, zone } = pickEnv(rng);
  const numeric = rng.pick(NUMERIC_EDGES);
  const reachable = rng.chance(0.5);
  const category = rng.pick(STRING_CATEGORIES);
  const stage = rng.pick(STAGE_KEYS);
  const violations: string[] = [];
  const notes: Record<string, unknown> = {
    numericEdge: numeric.name,
    stage,
    zoneNote: zone.note,
  };

  let label: string;
  let sublabel: string | null;
  // Production couples the extraction bar's `progress` to the same ETA state
  // that produced its "x%" sublabel (`extractionProgress`); every other
  // combination gets the hostile numeric edge.
  let progress: number | null = numeric.value;
  if (reachable) {
    // Production-reachable props: the real stage labels and the real
    // extraction sublabel produced by the ETA model.
    if (stage === 'extracting') {
      const instant = rng.pick(DST_EDGE_INSTANTS_MS);
      let eta: ExtractionEtaState | null = null;
      const events = rng.int(1, 6);
      for (let i = 0; i < events; i += 1) {
        eta = observeExtractionProgress(
          eta,
          instant + i * rng.int(0, 4000),
          rng.float() * (rng.chance(0.2) ? 1.4 : 1),
        );
      }
      const ui = extractionProgress(eta);
      label = ui.label;
      sublabel = ui.sublabel;
      progress = ui.progress;
      notes.progressSource = 'extractionProgress';
      notes.etaSeconds = extractionEtaSeconds(eta);
      notes.etaEvents = events;
      notes.dstInstantMs = instant;
      // BOUND-3: the ETA model must stay finite and honest at DST edges.
      const seconds = extractionEtaSeconds(eta);
      if (seconds !== null && (!Number.isFinite(seconds) || seconds < 1)) {
        violations.push(`BOUND-3 dishonest ETA ${seconds}s`);
      }
      if (eta && eta.lastProgress >= 1 && seconds !== null) {
        violations.push('BOUND-3 ETA survives 100% progress');
      }
    } else {
      const ui = analysisStageProgress(stage);
      label = ui.label;
      sublabel = ui.sublabel;
    }
    // Worst realistic ETA sublabel (production never localizes digits).
    notes.reachableWorstSublabel = '100% · ~999s left';
  } else {
    label = hostileString(category, seed ^ 0x5f5e100);
    sublabel = rng.chance(0.25)
      ? null
      : rng.chance(0.5)
        ? hostileString(rng.pick(STRING_CATEGORIES), seed ^ 0x1234567)
        : `${localizedNumber(rng.int(-999999, 999999999), locale)}% · ~${localizedNumber(
            rng.int(0, 99999),
            locale,
          )}s left`;
  }
  notes.labelLength = label.length;
  notes.sublabelLength = sublabel === null ? null : sublabel.length;
  notes.stringCategory = reachable ? 'reachable-copy' : category;

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  try {
    renderer = await withTimeZone(zone.id, () =>
      render(
        <AnalysisProgressBar
          progress={progress}
          label={label}
          sublabel={sublabel}
        />,
      ),
    );
  } catch (error) {
    violations.push(`BOUND-2 render threw: ${String(error)}`);
  }

  if (renderer) {
    const root = renderer.root.findByProps({ testID: 'analysis-progress' });
    // A11Y-4
    if (root.props.accessibilityRole !== 'progressbar') {
      violations.push(
        `A11Y-4 progress role is ${String(root.props.accessibilityRole)}`,
      );
    }
    const a11yLabel = root.props.accessibilityLabel;
    if (typeof a11yLabel !== 'string') {
      violations.push('A11Y-4 progress accessibilityLabel is not a string');
    } else if (reachable && a11yLabel.trim().length === 0) {
      violations.push('A11Y-4 reachable progress state has no accessible name');
    }
    const value = root.props.accessibilityValue as
      { min?: number; max?: number; now?: number } | undefined;
    const determinate = progress !== null;
    if (!value || value.min !== 0 || value.max !== 100) {
      violations.push('A11Y-4 progress accessibilityValue bounds missing');
    } else if (determinate) {
      const now = value.now;
      if (
        typeof now !== 'number' ||
        !Number.isInteger(now) ||
        now < 0 ||
        now > 100
      ) {
        violations.push(`A11Y-4 progress now=${String(now)} outside 0..100`);
      }
      notes.now = now;
    } else if ('now' in value && value.now !== undefined) {
      violations.push('A11Y-4 indeterminate progress exposes a percentage');
    }

    const texts = rendererText(renderer);
    notes.renderedTexts = texts.map(t =>
      t.length > 80 ? `${t.slice(0, 80)}…` : t,
    );
    // Injected hostile props are echoed verbatim by design, so leak/copy
    // linting only applies to the copy the component owns.
    violations.push(
      ...textViolations(texts, reachable, reachable ? [] : [label, sublabel]),
    );
    if (!determinate) {
      for (const text of texts) {
        if (/\d\s*%/.test(text) && reachable) {
          violations.push('BOUND-1 indeterminate bar rendered a percentage');
        }
      }
    }

    // Layout model of the label row.
    const labelMeasure = measureSingleLine(
      label,
      CAPTION_FONT,
      CAPTION_PT,
      fontScale.scale,
    );
    const subMeasure =
      sublabel === null || sublabel === ''
        ? null
        : measureSingleLine(
            sublabel,
            CAPTION_FONT,
            CAPTION_PT,
            fontScale.scale,
          );
    const layout = modelLabelRow(
      container.width,
      labelMeasure.widthPt,
      subMeasure ? subMeasure.widthPt : null,
    );
    notes.layout = {
      ...layout,
      labelFallbackGlyphs: labelMeasure.fallbackGlyphs,
      sublabelFallbackGlyphs: subMeasure ? subMeasure.fallbackGlyphs : null,
      labelGraphemes: labelMeasure.graphemeCount,
    };
    // Only production-reachable copy is asserted: hostile 200-char labels are
    // SUPPOSED to ellipsize under numberOfLines={1}.
    if (reachable && layout.labelClipped) {
      violations.push(
        `LAYOUT-F1 reachable stage label ${layout.labelCollapsed ? 'collapsed to 0pt' : `clipped to ${Math.round(layout.labelVisibleFraction * 100)}%`} (row ${container.width}pt, label ${layout.labelNatural.toFixed(1)}pt, sublabel ${layout.sublabelNatural.toFixed(1)}pt) at ${fontScale.name}`,
      );
    }
    await act(async () => {
      renderer?.unmount();
    });
  }

  return {
    seed,
    campaign: 'progress',
    replay: replayCmd(seed, 'analysisFeedbackProgressBoundaryI18nA11y'),
    locale,
    timeZone: zone.id,
    fontScale: fontScale.scale,
    fontScaleName: fontScale.name,
    containerWidth: container.width,
    device: container.device,
    stringCategory: reachable ? null : category,
    reachable,
    outcome: violations.length === 0 ? 'held' : 'broken',
    violations,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Campaign 2 — AnalysisFeedbackPrompt
// ---------------------------------------------------------------------------

async function runFeedbackVariant(seed: number): Promise<VariantResult> {
  const rng = new Rng(seed);
  const { fontScale, container, locale, zone } = pickEnv(rng);
  const category = rng.pick(STRING_CATEGORIES);
  const analysisId = hostileString(category, seed ^ 0xabcdef);
  const violations: string[] = [];
  const notes: Record<string, unknown> = {
    analysisIdLength: analysisId.length,
    zoneNote: zone.note,
    steps: [] as string[],
  };
  const steps = notes.steps as string[];

  const failure = rng.chance(0.5);
  submitMock.mockReset();
  const announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => undefined);
  if (failure) submitMock.mockRejectedValue(new Error('transport down'));
  else submitMock.mockResolvedValue(undefined as never);

  let renderer: TestRenderer.ReactTestRenderer | null = null;
  try {
    await withTimeZone(zone.id, async () => {
      renderer = await render(
        <AnalysisFeedbackPrompt analysisId={analysisId} />,
      );
    });
  } catch (error) {
    violations.push(`BOUND-2 render threw: ${String(error)}`);
  }

  if (renderer) {
    const live = renderer as TestRenderer.ReactTestRenderer;
    const auditStep = (step: string) => {
      steps.push(step);
      const audit = auditAllPressables(live, fontScale.scale);
      violations.push(...audit.violations.map(v => `${step}: ${v}`));
      violations.push(...textViolations(rendererText(live), true));
      return audit;
    };
    const press = async (testID: string) => {
      const node = live.root.findByProps({ testID });
      await act(async () => {
        (node.props.onPress as () => void)();
      });
    };

    const ask = auditStep('ask');
    if (ask.audited !== 2) {
      violations.push(`ask step exposed ${ask.audited} controls, expected 2`);
    }

    const path = rng.pick([
      'yes',
      'not-quite',
      'not-quite-then-retry',
    ] as const);
    notes.path = path;
    try {
      if (path === 'yes') {
        await press('feedback-yes');
        auditStep(failure ? 'failed' : 'done');
        if (failure) {
          await press('feedback-retry');
          auditStep('ask-after-retry');
        }
      } else {
        await press('feedback-not-quite');
        const cats = auditStep('categories');
        if (cats.audited !== 5) {
          violations.push(
            `categories step exposed ${cats.audited} chips, expected 5`,
          );
        }
        const chip = rng.pick([
          'feedback-category-wrong_stroke',
          'feedback-category-wrong_player',
          'feedback-category-contact_looks_wrong',
          'feedback-category-feedback_mismatch',
          'feedback-category-other',
        ]);
        notes.chip = chip;
        await press(chip);
        auditStep(failure ? 'failed' : 'done');
        if (failure && path === 'not-quite-then-retry') {
          await press('feedback-retry');
          auditStep('ask-after-retry');
        }
      }
    } catch (error) {
      violations.push(`BOUND-2 interaction threw: ${String(error)}`);
    }

    // The hostile analysisId must reach the API verbatim, never be rendered.
    if (submitMock.mock.calls.length > 0) {
      const call = submitMock.mock.calls[0];
      if (call && call[1] !== analysisId) {
        violations.push('analysisId mutated before submit');
      }
      notes.submitCalls = submitMock.mock.calls.length;
    }
    // Only ids that cannot occur inside English copy by accident are probed
    // (a whitespace / single-glyph id is a substring of everything).
    if (analysisId.trim().length >= 4) {
      for (const text of rendererText(live)) {
        if (text.includes(analysisId)) {
          violations.push('analysisId leaked into rendered copy');
        }
      }
    }
    // F3 evidence (P3, not asserted): the ask→sending→done/failed transitions
    // unmount the pressed control and render new copy with no VoiceOver
    // announcement and no live-region props — recorded for the report.
    notes.announceCalls = announce.mock.calls.length;
    notes.liveRegionProps = live.root.findAll(
      node =>
        typeof node.type === 'string' &&
        (node.props.accessibilityLiveRegion !== undefined ||
          node.props['aria-live'] !== undefined),
    ).length;
    notes.finalStepTexts = rendererText(live);
    await act(async () => {
      live.unmount();
    });
  }
  announce.mockRestore();

  return {
    seed,
    campaign: 'feedback',
    replay: replayCmd(seed, 'analysisFeedbackProgressBoundaryI18nA11y'),
    locale,
    timeZone: zone.id,
    fontScale: fontScale.scale,
    fontScaleName: fontScale.name,
    containerWidth: container.width,
    device: container.device,
    stringCategory: category,
    reachable: true,
    outcome: violations.length === 0 ? 'held' : 'broken',
    violations,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Campaign 3 — UncertaintyNote
// ---------------------------------------------------------------------------

const HOSTILE_NUMBERS: ReadonlyArray<number> = [
  0,
  -0,
  -1,
  101,
  1e308,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  Number.MAX_SAFE_INTEGER,
  Number.MIN_VALUE,
];

function hostileAnalysis(rng: Rng, seed: number): ShotAnalysis | null {
  if (rng.chance(0.2)) return null;
  return {
    id: hostileString('format-bait', seed),
    stroke: rng.pick(['dink', 'drive', 'serve', 'volley', '']),
    overallScore: rng.chance(0.4) ? null : rng.pick(HOSTILE_NUMBERS),
    lowConfidence: rng.chance(0.5),
    timestamps: rng.chance(0.4)
      ? undefined
      : { contactMs: rng.pick([...HOSTILE_NUMBERS, null]) },
    phases: rng.chance(0.5) ? undefined : {},
    metrics: rng.chance(0.5)
      ? undefined
      : { contactMs: rng.pick(HOSTILE_NUMBERS) },
  } as unknown as ShotAnalysis;
}

function hostileRecord(
  rng: Rng,
  seed: number,
): StrokeResultEvidenceRecord | null {
  if (rng.chance(0.25)) return null;
  const withContact = rng.chance(0.6);
  return {
    id: hostileString('cjk', seed),
    captureId: hostileString('lone-surrogate', seed),
    createdAtIso: rng.pick([
      '',
      '1970-01-01T00:00:00.000Z',
      '+275760-09-13T00:00:00.000Z',
      'not-a-date',
      new Date(DST_EDGE_INSTANTS_MS[0] ?? 0).toISOString(),
    ]),
    result: hostileAnalysis(rng, seed),
    strokeIntent: rng.chance(0.4)
      ? { resolutionBasis: 'abstained' }
      : { resolutionBasis: rng.pick(['declared', 'measured', '']) },
    contact: withContact
      ? {
          status: rng.pick(['estimated', 'abstained']),
          reason: hostileString('german-compound', seed),
          estimatedContactMs: rng.pick(HOSTILE_NUMBERS),
          confidence: rng.pick([...HOSTILE_NUMBERS, 0.9]),
          ballConfirmed: rng.chance(0.3),
          paddleConfirmed: rng.chance(0.3),
        }
      : null,
    temporalPhasesV2: PHASE_VARIANTS(seed)[rng.int(0, 6)],
    captureEnvelope: rng.chance(0.5)
      ? null
      : { overall: rng.pick(['GOOD', 'DEGRADED', 'UNSUPPORTED', '']) },
  } as unknown as StrokeResultEvidenceRecord;
}

/** temporalPhasesV2 shapes, index 0..6 (undefined = key absent on old rows). */
function PHASE_VARIANTS(seed: number): ReadonlyArray<unknown> {
  return [
    null,
    undefined,
    // Honest abstention.
    { status: 'abstained', reason: hostileString('thai', seed) },
    // Valid segmented boundaries (anchored + anchor-free).
    {
      status: 'segmented',
      boundaries: {
        version: 'v2',
        source: 'wrist',
        anchor: 'contact_estimate',
        confidence: 0.8,
        preparationStartMs: 0,
        accelerationStartMs: 100,
        contactMs: 200,
        followThroughEndMs: 300,
        recoveryEndMs: 400,
      },
    },
    {
      status: 'segmented',
      boundaries: {
        version: 'v2',
        source: 'paddle',
        anchor: 'speed_peak',
        anchorBasis: 'event_peak',
        confidence: Number.NaN,
        preparationStartMs: null,
        accelerationStartMs: -1,
        contactMs: null,
        motionPeakMs: Number.NaN,
        followThroughEndMs: 1e308,
        recoveryEndMs: null,
      },
    },
    // Shape-corrupt rows: `local_analysis_record` payloads are JSON.parsed
    // and cast with no shape validation (strokeResultData.ts:70).
    { status: 'segmented' },
    {},
  ];
}

async function runNoteVariant(seed: number): Promise<VariantResult> {
  const rng = new Rng(seed);
  const { fontScale, container, locale, zone } = pickEnv(rng);
  const category = rng.pick(STRING_CATEGORIES);
  const violations: string[] = [];
  const notes: Record<string, unknown> = { zoneNote: zone.note };

  const record = hostileRecord(rng, seed);
  const analysis = record?.result ?? hostileAnalysis(rng, seed ^ 0x777);
  let views: ReturnType<typeof uncertaintyNotes> = [];
  try {
    views = withTimeZone(zone.id, () => uncertaintyNotes({ record, analysis }));
  } catch (error) {
    const phases = (
      record as {
        temporalPhasesV2?: { status?: string; boundaries?: unknown } | null;
      } | null
    )?.temporalPhasesV2;
    const malformedSegmented =
      !!phases &&
      phases.status !== 'abstained' &&
      phases.boundaries === undefined;
    notes.malformedPhases = malformedSegmented;
    violations.push(
      `${malformedSegmented ? 'BOUND-2-F2' : 'BOUND-2'} uncertaintyNotes threw: ${String(error)}`,
    );
  }
  notes.noteKinds = views.map(v => v.kind);

  // Selector output plus a hostile injected note body.
  const bodies: string[] = views.map(v => v.text);
  bodies.push(hostileString(category, seed ^ 0x2468ace));
  for (const body of bodies) {
    let renderer: TestRenderer.ReactTestRenderer | null = null;
    const owned = body !== bodies[bodies.length - 1];
    try {
      renderer = await withTimeZone(zone.id, () =>
        render(<UncertaintyNote text={body} />),
      );
    } catch (error) {
      violations.push(`BOUND-2 note render threw: ${String(error)}`);
      continue;
    }
    const root = renderer.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityRole === 'text',
    );
    if (root.length === 0) {
      violations.push('A11Y-1 uncertainty note has no accessibilityRole=text');
    } else {
      const label = root[0]?.props.accessibilityLabel;
      if (typeof label !== 'string' || label.trim().length === 0) {
        violations.push('A11Y-2 uncertainty note has no accessible name');
      }
    }
    const texts = rendererText(renderer);
    violations.push(...textViolations(texts, owned, owned ? [] : [body]));
    const audit = auditAllPressables(renderer, fontScale.scale);
    violations.push(...audit.violations);
    const live = renderer;
    await act(async () => {
      live.unmount();
    });
  }
  notes.bodiesRendered = bodies.length;

  return {
    seed,
    campaign: 'uncertainty',
    replay: replayCmd(seed, 'analysisFeedbackProgressBoundaryI18nA11y'),
    locale,
    timeZone: zone.id,
    fontScale: fontScale.scale,
    fontScaleName: fontScale.name,
    containerWidth: container.width,
    device: container.device,
    stringCategory: category,
    reachable: true,
    outcome: violations.length === 0 ? 'held' : 'broken',
    violations,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

function seedsFor(campaign: string, count: number): number[] {
  if (ONLY !== null) return [ONLY];
  const base = seedFrom(campaign);
  return Array.from({ length: count }, (_, i) => (base + i * 0x9e3779b1) >>> 0);
}

describe('cmp-analysis-feedback-progress · boundary/i18n/a11y stress', () => {
  beforeAll(() => {
    establishApiSession({
      apiBaseUrl: 'https://api.test',
      bearerToken: 'token-stress',
      canonicalAppUserId: 'user-stress',
      provider: 'apple',
    });
  });

  afterAll(() => {
    clearApiSession();
    const broken = results.filter(r => r.outcome === 'broken');
    writeArtifact('boundary-i18n-a11y.json', {
      unit: 'cmp-analysis-feedback-progress',
      lens: 'boundary-i18n-a11y',
      environment: envSnapshot(),
      grid: {
        locales: LOCALES,
        timezones: TIMEZONES,
        fontScales: FONT_SCALES,
        containerWidths: CONTAINER_WIDTHS,
        stringCategories: STRING_CATEGORIES,
        numericEdges: NUMERIC_EDGES.map(n => n.name),
      },
      counts: {
        executed: results.length,
        held: results.length - broken.length,
        broken: broken.length,
        brokenByFinding: {
          F1: results.filter(r =>
            r.violations.some(v => findingFor(v) === 'F1'),
          ).length,
          F2: results.filter(r =>
            r.violations.some(v => findingFor(v) === 'F2'),
          ).length,
          unclassified: results.filter(r => unknownViolations(r).length > 0)
            .length,
        },
      },
      knownFindings: KNOWN_FINDINGS,
      table: results.map(r => ({
        seed: r.seed,
        campaign: r.campaign,
        outcome: r.outcome,
        locale: r.locale,
        timeZone: r.timeZone,
        fontScale: r.fontScaleName,
        device: r.device,
        stringCategory: r.stringCategory,
        reachable: r.reachable,
        violations: r.violations,
        replay: r.replay,
        notes: r.notes,
      })),
    });
  });

  it('AnalysisProgressBar holds a11y + boundary invariants across the grid', async () => {
    for (const seed of seedsFor('progress', PROGRESS_VARIANTS)) {
      results.push(await runProgressVariant(seed));
    }
    const broken = results.filter(
      r => r.campaign === 'progress' && unknownViolations(r).length > 0,
    );
    expect(
      broken.map(r => ({
        seed: r.seed,
        violations: unknownViolations(r),
        replay: r.replay,
      })),
    ).toEqual([]);
  });

  it('AnalysisFeedbackPrompt keeps every control labelled and ≥44pt', async () => {
    for (const seed of seedsFor('feedback', FEEDBACK_VARIANTS)) {
      results.push(await runFeedbackVariant(seed));
    }
    const broken = results.filter(
      r => r.campaign === 'feedback' && unknownViolations(r).length > 0,
    );
    expect(
      broken.map(r => ({
        seed: r.seed,
        violations: unknownViolations(r),
        replay: r.replay,
      })),
    ).toEqual([]);
  });

  it('UncertaintyNote stays labelled and leak-free on hostile evidence', async () => {
    for (const seed of seedsFor('uncertainty', NOTE_VARIANTS)) {
      results.push(await runNoteVariant(seed));
    }
    const broken = results.filter(
      r => r.campaign === 'uncertainty' && unknownViolations(r).length > 0,
    );
    expect(
      broken.map(r => ({
        seed: r.seed,
        violations: unknownViolations(r),
        replay: r.replay,
      })),
    ).toEqual([]);
  });

  it('executes at least 150 rendered variants at the default scale', () => {
    if (ONLY !== null) return;
    // 60 progress + 30 feedback (2-4 rendered steps each) + 30 uncertainty
    // (1-5 rendered note bodies each) — every one is a real render.
    const renders = results.reduce((sum, r) => {
      if (r.campaign === 'progress') return sum + 1;
      if (r.campaign === 'feedback') {
        return sum + ((r.notes.steps as string[] | undefined)?.length ?? 1);
      }
      return sum + ((r.notes.bodiesRendered as number | undefined) ?? 1);
    }, 0);
    expect(renders).toBeGreaterThanOrEqual(150);
  });

  it('records the production-reachable label-row layout grid (F1 evidence)', () => {
    if (ONLY !== null) return;
    const grid: Array<Record<string, unknown>> = [];
    const etaSamples: Array<{ name: string; sublabel: string }> = [];
    let eta: ExtractionEtaState | null = null;
    eta = observeExtractionProgress(eta, 0, 0);
    eta = observeExtractionProgress(eta, 1000, 0.1);
    etaSamples.push({
      name: 'eta-early',
      sublabel: extractionSublabel(eta) ?? '',
    });
    eta = observeExtractionProgress(eta, 100_000, 0.11);
    etaSamples.push({
      name: 'eta-slow-3-digit',
      sublabel: extractionSublabel(eta) ?? '',
    });
    etaSamples.push({
      name: 'percent-only',
      sublabel:
        extractionSublabel(observeExtractionProgress(null, 0, 0.5)) ?? '',
    });
    for (const fontScale of FONT_SCALES) {
      for (const container of CONTAINER_WIDTHS) {
        const cells: Array<{
          stage: string;
          label: string;
          sublabel: string | null;
        }> = [
          ...(['verifying', 'measuring', 'saving'] as const).map(stage => {
            const ui = analysisStageProgress(stage);
            return { stage, label: ui.label, sublabel: ui.sublabel };
          }),
          ...etaSamples.map(s => ({
            stage: `extracting/${s.name}`,
            label: ANALYSIS_STAGE_LABELS.extracting,
            sublabel: s.sublabel,
          })),
        ];
        for (const cell of cells) {
          const label = measureSingleLine(
            cell.label,
            CAPTION_FONT,
            CAPTION_PT,
            fontScale.scale,
          );
          const sub = cell.sublabel
            ? measureSingleLine(
                cell.sublabel,
                CAPTION_FONT,
                CAPTION_PT,
                fontScale.scale,
              )
            : null;
          const layout = modelLabelRow(
            container.width,
            label.widthPt,
            sub ? sub.widthPt : null,
          );
          grid.push({
            stage: cell.stage,
            label: cell.label,
            sublabel: cell.sublabel,
            fontScale: fontScale.name,
            fontPt: +(CAPTION_PT * fontScale.scale).toFixed(2),
            device: container.device,
            rowWidthPt: container.width,
            labelNaturalPt: +label.widthPt.toFixed(1),
            sublabelNaturalPt: sub ? +sub.widthPt.toFixed(1) : null,
            labelAllocatedPt: +layout.labelAllocated.toFixed(1),
            labelVisiblePct: Math.round(layout.labelVisibleFraction * 100),
            labelClipped: layout.labelClipped,
            labelCollapsed: layout.labelCollapsed,
            manropeGlyphs: label.manropeGlyphs + (sub?.manropeGlyphs ?? 0),
            fallbackGlyphs: label.fallbackGlyphs + (sub?.fallbackGlyphs ?? 0),
          });
        }
      }
    }
    writeArtifact('reachable-layout-grid.json', {
      provenance:
        'MODELLED: Manrope_500Medium advances from assets/fonts (exact, unkerned) × type.caption 13pt × RN iOS fontScale; Yoga row model per modelLabelRow(). Not an iOS runtime measurement.',
      cells: grid,
    });
    // Every glyph in the reachable copy is a real Manrope glyph (no estimate).
    expect(grid.every(c => c.fallbackGlyphs === 0)).toBe(true);
    expect(grid.length).toBe(FONT_SCALES.length * CONTAINER_WIDTHS.length * 6);
  });

  it('exposes the honest stage labels and duration hint unchanged', () => {
    expect(Object.values(ANALYSIS_STAGE_LABELS).every(l => l.length > 0)).toBe(
      true,
    );
    expect(ANALYSIS_DURATION_HINT.length).toBeGreaterThan(0);
    for (const label of [
      ...Object.values(ANALYSIS_STAGE_LABELS),
      ANALYSIS_DURATION_HINT,
    ]) {
      expect(forbiddenCopyIn(label)).toEqual([]);
      expect(leaksIn(label)).toEqual([]);
    }
  });

  it('ETA math survives DST edges, clock ties and regressions', () => {
    for (const zone of TIMEZONES) {
      withTimeZone(zone.id, () => {
        for (const instant of DST_EDGE_INSTANTS_MS) {
          let state: ExtractionEtaState | null = null;
          for (const [dt, progress] of [
            [0, 0],
            [0, 0.1], // clock tie
            [1000, 0.2],
            [500, 0.15], // regression
            [0, 0.15], // tie at regression
            [2000, 1],
          ] as const) {
            state = observeExtractionProgress(
              state,
              instant + dt,
              progress as number,
            );
            const eta = extractionEtaSeconds(state);
            if (eta !== null) {
              expect(Number.isFinite(eta)).toBe(true);
              expect(eta).toBeGreaterThanOrEqual(1);
            }
            const sub = extractionSublabel(state);
            expect(sub === null || leaksIn(sub).length === 0).toBe(true);
          }
          expect(extractionEtaSeconds(state)).toBeNull();
        }
      });
    }
  });

  it('every chip keeps a ≥44pt modelled target at every Dynamic Type scale', async () => {
    for (const fontScale of FONT_SCALES) {
      const renderer = await render(
        <AnalysisFeedbackPrompt analysisId="a11y-grid" />,
      );
      await act(async () => {
        (
          renderer.root.findByProps({ testID: 'feedback-not-quite' }).props
            .onPress as () => void
        )();
      });
      for (const node of findPressables(renderer)) {
        const audit = auditPressable(node, {
          fontScale: fontScale.scale,
          fontSizePt: CAPTION_PT,
          font: CAPTION_FONT,
        });
        expect({
          scale: fontScale.name,
          id: audit.testID,
          issues: audit.issues,
        }).toEqual({ scale: fontScale.name, id: audit.testID, issues: [] });
        expect(audit.minHeight ?? audit.height ?? 0).toBeGreaterThanOrEqual(
          MIN_TARGET,
        );
      }
      renderer.unmount();
    }
  });
});
