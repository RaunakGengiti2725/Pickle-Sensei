/**
 * STRESS — `cmp-progress-charts`, lens `boundary-i18n-a11y`.
 *
 * Seeded render campaign over the six Progress dashboard building blocks
 * (PracticeVolumeChart, ScoreDotPlot, ScoreTrendChart, StatDeltaRow,
 * PracticeSetCard, DashSectionHeader). Every iteration is a pure function of
 * its seed: it draws a component, boundary strings (200+ chars, CJK, Arabic
 * RTL, ZWJ emoji, combining marks, German compounds, bidi controls…), boundary
 * numerics (0 / negative / huge / NaN / ±Infinity), one of 12 locales, one of
 * 8 time zones, a Dynamic Type scale and a device width; renders it with
 * react-test-renderer; and audits the host tree:
 *
 * - VERIFIED: no throw on mount / timer flush / unmount; every `accessible`
 *   node carries a non-empty label; every interactive node has role + label
 *   and a ≥ 44pt target; no `NaN` / `undefined` / `null` / `Infinity` /
 *   `[object` reaches a label or visible text; no non-finite or negative
 *   geometry in emitted styles; component-specific content invariants
 *   (dot count == matched reads, pill count == attempts, latest flagged…).
 * - INFERRED (`layout-model`): arithmetic on the emitted style constants
 *   (slot heights, label boxes, row widths) under the drawn font scale and
 *   width. react-test-renderer has no Yoga — these rows flag where the
 *   component's fixed constants cannot fit the scaled text, they do not
 *   measure pixels.
 *
 * Replay:  STRESS_SEED=<seed> npx jest --ci progressChartsBoundaryI18nA11y
 * Scale:   STRESS_ITER=2000 npx jest --ci progressChartsBoundaryI18nA11y
 * Table:   apps/mobile/artifacts/stress/progressCharts.boundary-i18n-a11y.json
 *          (or $STRESS_OUT) — one row per executed iteration, seed → outcome.
 *
 * Defects the campaign reproduces deterministically are pinned below as
 * `test.failing` cases (the repo's convention for known-bad behaviour): they
 * state the EXPECTED behaviour and start passing — and so fail as
 * "unexpectedly passing" — the moment production fixes them. The campaign
 * itself classifies those exact defect signatures as BROKEN_KNOWN so the
 * suite stays green while nothing is hidden from the table.
 */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DashSectionHeader } from '../../src/progress/DashSectionHeader';
import { PracticeSetCard } from '../../src/progress/PracticeSetCard';
import { PracticeVolumeChart } from '../../src/progress/PracticeVolumeChart';
import { ScoreDotPlot } from '../../src/progress/ScoreDotPlot';
import { ScoreTrendChart } from '../../src/progress/ScoreTrendChart';
import { StatDeltaRow } from '../../src/progress/StatDeltaRow';
import type { IconName } from '../../src/design/icons';
import type { RealAnalysisFact } from '../../src/data/repository';
import type { PracticeHistoryChartBucket } from '../../src/progress/practiceHistory';
import {
  summarizePracticeSet,
  type PracticeSetAttempt,
  type PracticeSetSummary,
} from '../../src/progress/practiceSetProgress';
import type {
  ScoredReadPoint,
  ScoreTrendBucket,
} from '../../src/progress/techniqueDashboard';
import {
  FONT_SCALES,
  IN_DOMAIN_NUMERICS,
  LOCALES,
  NUMERIC_CASES,
  STRING_CLASSES,
  TIME_ZONES,
  WIDTHS,
  auditAccessibility,
  campaignIterations,
  estimateTextWidth,
  evidenceTree,
  flatStyle,
  hostNodes,
  hostType,
  leakToken,
  localizedDate,
  localizedNumber,
  makeRng,
  numericStyle,
  replaySeed,
  stringFor,
  visibleTexts,
  visibleTextsUnder,
  writeEvidence,
  writeResults,
  type AuditIssue,
  type Locale,
  type NumericCase,
  type ResultRow,
  type Rng,
  type StringClass,
} from '../../testing/stress/progressChartsStressKit';

const COMPONENTS = [
  'PracticeVolumeChart',
  'ScoreDotPlot',
  'ScoreTrendChart',
  'StatDeltaRow',
  'PracticeSetCard',
  'DashSectionHeader',
] as const;
type ComponentName = (typeof COMPONENTS)[number];

const ICONS: readonly IconName[] = [
  'camera',
  'check',
  'person',
  'flame',
  'star',
  'spark',
];

/** First seed of the default campaign; `STRESS_ITER` extends the same run. */
const BASE_SEED = 0x50c0_0001;
/** ≥ 150 rendered variants by default (lens requirement), fast enough for CI. */
const DEFAULT_ITERATIONS = 240;
const SCREEN_PADDING = 24; // ProgressScreen content paddingHorizontal (space.lg)
const CARD_PADDING = 24; // Card padding (space.lg)

// ---------------------------------------------------------------------------
// Known-defect signatures (each pinned by a `test.failing` case below).
// ---------------------------------------------------------------------------

interface DefectContext {
  component: string;
  outOfDomain: boolean;
  fontScale: number;
}

interface KnownDefect {
  id: string;
  matches(issue: AuditIssue, scenario: DefectContext): boolean;
}

function knownDefectFor(
  issue: AuditIssue,
  context: DefectContext,
): KnownDefect | undefined {
  return KNOWN_DEFECTS.find(defect => defect.matches(issue, context));
}

function contextOf(row: ResultRow): DefectContext {
  return {
    component: row.component,
    outOfDomain: row.outOfDomain ?? false,
    fontScale: row.fontScale ?? 1,
  };
}

const KNOWN_DEFECTS: readonly KnownDefect[] = [
  {
    // NaN / ±Infinity scores or counts are printed verbatim into visible
    // text and screen-reader labels (no finite guard in the components).
    id: 'PC-01 non-finite numeric leaks into text/a11y label',
    matches: (issue, scenario) =>
      scenario.outOfDomain &&
      (issue.code === 'text-leak' || issue.code === 'a11y-label-leak') &&
      /NaN|Infinity/.test(issue.detail),
  },
  {
    // Negative counts/averages produce negative Animated bar heights; NaN
    // produces NaN `top`/`height` geometry.
    id: 'PC-02 out-of-domain numeric yields negative/non-finite geometry',
    matches: (issue, scenario) =>
      scenario.outOfDomain &&
      (issue.code === 'geometry-negative-size' ||
        issue.code === 'geometry-nonfinite'),
  },
  {
    // StatDeltaRow: `delta > 0 ? up : down` sends NaN to the "down" branch,
    // so a NaN delta renders a falling triangle and says "trending down".
    id: 'PC-03 StatDeltaRow NaN delta renders as trending down',
    matches: (issue, scenario) =>
      scenario.component === 'StatDeltaRow' &&
      scenario.outOfDomain &&
      issue.code === 'content-mismatch' &&
      issue.detail.includes('NaN delta'),
  },
  {
    // Bar-chart value labels sit inside a fixed-height slot; lineHeight
    // scales with Dynamic Type but the slot does not, and the label has no
    // numberOfLines / ellipsis so wide values overprint the neighbour slot.
    id: 'PC-04 bar value label overflows fixed plot slot at Dynamic Type',
    matches: (issue, scenario) =>
      (scenario.component === 'PracticeVolumeChart' ||
        scenario.component === 'ScoreTrendChart') &&
      (issue.code === 'layout-model-vertical-overflow' ||
        (issue.code === 'layout-model-label-overlap' &&
          (scenario.fontScale > 1 || scenario.outOfDomain))),
  },
  {
    // `props.accessibilityLabel ?? summary` — an empty/whitespace custom
    // label is not nullish, so the accessible container speaks nothing.
    id: 'PC-09 PracticeVolumeChart empty accessibilityLabel suppresses summary',
    matches: (issue, scenario) =>
      scenario.component === 'PracticeVolumeChart' &&
      issue.code === 'a11y-empty-label',
  },
  {
    // Dot-plot label boxes use a 13pt LABEL_HEIGHT constant; scaled text
    // overprints the dot or the axis, and dense windows overprint neighbours.
    id: 'PC-05 dot-plot value labels overlap at Dynamic Type / dense windows',
    matches: (issue, scenario) =>
      scenario.component === 'ScoreDotPlot' &&
      (issue.code === 'layout-model-label-overlap' ||
        issue.code === 'layout-model-vertical-overflow'),
  },
  {
    // DashSectionHeader: two Text nodes in a row with default flexShrink 0 —
    // long or scaled title + right label exceed the row and overflow.
    id: 'PC-06 DashSectionHeader row cannot shrink; title/right overflow',
    matches: (issue, scenario) =>
      scenario.component === 'DashSectionHeader' &&
      issue.code === 'layout-model-no-shrink',
  },
  {
    // StatDeltaRow value column has no shrink/wrap; wide values overflow the
    // row once the label has been squeezed to zero.
    id: 'PC-07 StatDeltaRow value column overflows row at Dynamic Type',
    matches: (issue, scenario) =>
      scenario.component === 'StatDeltaRow' &&
      issue.code === 'layout-model-horizontal-overflow',
  },
  {
    // PracticeSetCard pill has fixed height 30 while its caption scales.
    id: 'PC-08 PracticeSetCard pill text taller than fixed 30pt pill',
    matches: (issue, scenario) =>
      scenario.component === 'PracticeSetCard' &&
      issue.code === 'layout-model-vertical-overflow',
  },
];

// ---------------------------------------------------------------------------
// Scenario generation.
// ---------------------------------------------------------------------------

interface Scenario {
  seed: number;
  component: ComponentName;
  variant: string;
  locale: Locale;
  timeZone: string;
  fontScale: number;
  width: number;
  outOfDomain: boolean;
  element: React.ReactElement;
  /** Component-specific content invariants (VERIFIED from the tree). */
  verify(renderer: TestRenderer.ReactTestRenderer): AuditIssue[];
  /** Layout arithmetic (INFERRED). */
  model(renderer: TestRenderer.ReactTestRenderer): AuditIssue[];
}

function pickNumeric(rng: Rng, allowOutOfDomain: boolean): NumericCase {
  return rng.pick(allowOutOfDomain ? NUMERIC_CASES : IN_DOMAIN_NUMERICS);
}

/** Scores live in [0, 10]; anything else (including large "counts") is out
 * of the score domain even when it is a fine count. */
function pickScore(
  rng: Rng,
  allowOutOfDomain: boolean,
): { value: number; outOfDomain: boolean } {
  if (allowOutOfDomain && rng.chance(0.25)) {
    const numeric = rng.pick(NUMERIC_CASES);
    const inScoreDomain =
      Number.isFinite(numeric.value) &&
      numeric.value >= 0 &&
      numeric.value <= 10;
    return { value: numeric.value, outOfDomain: !inScoreDomain };
  }
  return { value: rng.int(0, 100) / 10, outOfDomain: false };
}

function dayIso(ordinal: number): string {
  return new Date(ordinal * 86_400_000).toISOString().slice(0, 10);
}

function dayLabelFor(
  rng: Rng,
  locale: Locale,
  zone: string,
  day: string,
): string {
  // Production labels are English "Aug 30"; the lens also feeds localized and
  // boundary strings through the same axis-label slot.
  const ms = Date.parse(`${day}T12:00:00.000Z`);
  const roll = rng.next();
  if (roll < 0.5) return `${day.slice(5, 7)}/${day.slice(8, 10)}`;
  if (roll < 0.8) return localizedDate(locale, zone, ms);
  return stringFor(rng.pick(STRING_CLASSES), rng);
}

const BUCKET_COUNTS = [0, 1, 2, 3, 7, 8, 12, 13, 14, 26, 27, 28, 90, 91, 365];

function trendBuckets(
  rng: Rng,
  locale: Locale,
  zone: string,
  count: number,
  allowOutOfDomain: boolean,
): { buckets: ScoreTrendBucket[]; outOfDomain: boolean; days: string[][] } {
  const startOrdinal = 20_700 + rng.int(0, 400); // 2026-09-xx neighbourhood
  const groupSize = Math.max(1, Math.ceil(count / 13));
  const buckets: ScoreTrendBucket[] = [];
  const days: string[][] = [];
  let outOfDomain = false;
  for (let index = 0; index < count; index += groupSize) {
    const first = dayIso(startOrdinal + index);
    const lastIndex = Math.min(index + groupSize - 1, count - 1);
    const last = dayIso(startOrdinal + lastIndex);
    const members: string[] = [];
    for (let m = index; m <= lastIndex; m += 1)
      members.push(dayIso(startOrdinal + m));
    days.push(members);
    const empty = rng.chance(0.3);
    let avg: number | null = null;
    if (!empty) {
      const score = pickScore(rng, allowOutOfDomain);
      if (score.outOfDomain) outOfDomain = true;
      avg = score.value;
    }
    buckets.push({
      key: groupSize === 1 && rng.chance(0.5) ? first : `${first}:${last}`,
      label: dayLabelFor(rng, locale, zone, first),
      avg,
      count: empty ? 0 : rng.int(1, 6),
    });
  }
  return { buckets, outOfDomain, days };
}

function fact(
  id: string,
  capturedAt: string,
  overallScore: number | null,
  overrides: Partial<RealAnalysisFact> = {},
): RealAnalysisFact {
  return {
    id,
    shotType: 'forehand_drive',
    capturedAt,
    overallScore,
    confidence: 0.9,
    resultKind: 'scored',
    scoringModelVersion: 'sm-v2',
    shotConfigVersion: 'forehand_drive@1',
    sessionId: 'set-1',
    priorityCheckpoint: null,
    checkpointScores: {},
    ...overrides,
  };
}

function buildScenario(seed: number): Scenario {
  const rng = makeRng(seed);
  const component = rng.pick(COMPONENTS);
  const locale = rng.pick(LOCALES);
  const zone = rng.pick(TIME_ZONES).zone;
  const fontScale = rng.pick(FONT_SCALES).scale;
  const width = rng.pick(WIDTHS).width;
  const allowOutOfDomain = rng.chance(0.35);
  const base = { seed, locale, timeZone: zone, fontScale, width };

  switch (component) {
    case 'DashSectionHeader': {
      const titleClass = rng.pick(STRING_CLASSES);
      const title = stringFor(titleClass, rng);
      const rightMode = rng.pick(['undefined', 'empty', 'string'] as const);
      const rightClass = rng.pick(STRING_CLASSES);
      const right =
        rightMode === 'undefined'
          ? undefined
          : rightMode === 'empty'
            ? ''
            : stringFor(rightClass, rng);
      const contentWidth = width - 2 * SCREEN_PADDING;
      return {
        ...base,
        component,
        variant: `title=${titleClass}(${title.length}) right=${rightMode}${rightMode === 'string' ? `:${rightClass}` : ''}`,
        outOfDomain: false,
        element: <DashSectionHeader title={title} right={right} />,
        verify: renderer => {
          const issues: AuditIssue[] = [];
          const texts = visibleTexts(renderer);
          if (texts[0] !== title) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `title not rendered verbatim (${texts.length} texts)`,
            });
          }
          const expectRight = typeof right === 'string' && right.length > 0;
          if (expectRight !== (texts.length === 2)) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `right label presence mismatch: expected ${expectRight}, texts=${texts.length}`,
            });
          }
          return issues;
        },
        model: () => {
          const issues: AuditIssue[] = [];
          const titleW = estimateTextWidth(title, 11, 1.2, fontScale);
          const rightW = right
            ? estimateTextWidth(right, 11, 1.2, fontScale)
            : 0;
          // Yoga: each Text's flex basis is min(intrinsic, container); with
          // the RN default flexShrink 0 the pair cannot give way once their
          // bases plus the 16pt gap exceed the row.
          const basisTitle = Math.min(titleW, contentWidth);
          const basisRight = Math.min(rightW, contentWidth);
          const gap = right ? 16 : 0;
          const overflow = basisTitle + basisRight + gap - contentWidth;
          if (right && overflow > 0.5) {
            issues.push({
              code: 'layout-model-no-shrink',
              basis: 'INFERRED',
              detail: `row ${contentWidth}pt @×${fontScale}: title≈${Math.round(titleW)} + right≈${Math.round(rightW)} + gap 16 overflow ≈${Math.round(overflow)}pt (Text flexShrink defaults to 0, no numberOfLines)`,
            });
          }
          return issues;
        },
      };
    }

    case 'StatDeltaRow': {
      const icon = rng.pick(ICONS);
      const labelClass = rng.pick(STRING_CLASSES);
      const label = stringFor(labelClass, rng);
      const valueMode = rng.pick(['localized', 'string', 'duration'] as const);
      const valueNumeric = pickNumeric(rng, allowOutOfDomain);
      const value =
        valueMode === 'localized'
          ? localizedNumber(locale, valueNumeric.value)
          : valueMode === 'duration'
            ? `${rng.int(0, 999)}h ${rng.int(0, 59)}m`
            : stringFor(rng.pick(STRING_CLASSES), rng);
      const previousMode = rng.pick(['null', 'localized', 'string'] as const);
      const previousNumeric = pickNumeric(rng, allowOutOfDomain);
      const previous =
        previousMode === 'null'
          ? null
          : previousMode === 'localized'
            ? localizedNumber(locale, previousNumeric.value)
            : stringFor(rng.pick(STRING_CLASSES), rng);
      const deltaMode = rng.pick(['null', 'numeric'] as const);
      const deltaNumeric = pickNumeric(rng, allowOutOfDomain);
      const delta = deltaMode === 'null' ? null : deltaNumeric.value;
      const outOfDomain =
        (deltaMode === 'numeric' && deltaNumeric.outOfDomain) ||
        (valueMode === 'localized' && valueNumeric.outOfDomain) ||
        (previousMode === 'localized' && previousNumeric.outOfDomain);
      const contentWidth = width - 2 * SCREEN_PADDING;
      return {
        ...base,
        component,
        variant: `label=${labelClass}(${label.length}) value=${valueMode} previous=${previousMode} delta=${deltaMode === 'null' ? 'null' : deltaNumeric.label}`,
        outOfDomain,
        element: (
          <StatDeltaRow
            icon={icon}
            label={label}
            value={value}
            previous={previous}
            delta={delta}
            testID="stat-row"
          />
        ),
        verify: renderer => {
          const issues: AuditIssue[] = [];
          const root = hostNodes(renderer).find(
            n => n.props.testID === 'stat-row',
          );
          const a11y = String(root?.props.accessibilityLabel ?? '');
          if (!a11y.startsWith(`${label}: ${value}`)) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: 'a11y label does not start with "<label>: <value>"',
            });
          }
          const triangles = hostNodes(renderer).filter(n => {
            const style = flatStyle(n.props.style);
            return style.borderLeftWidth === 5 && style.borderRightWidth === 5;
          });
          // ±Infinity has a sign, so an arrow is legitimate; NaN does not.
          const expectTriangle =
            delta !== null && delta !== 0 && !Number.isNaN(delta);
          if (delta !== null && Number.isNaN(delta)) {
            const down = triangles.some(
              n => flatStyle(n.props.style).borderTopWidth === 7,
            );
            if (down || a11y.includes('trending down')) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `NaN delta rendered as a falling triangle / "trending down" (a11y: ${JSON.stringify(a11y.slice(0, 120))})`,
              });
            }
          } else if (expectTriangle !== (triangles.length === 1)) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `triangle presence mismatch for delta=${String(delta)}: ${triangles.length} triangles`,
            });
          }
          if (previous === null && a11y.includes('Prior period')) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: 'comparison spoken although previous is null',
            });
          }
          return issues;
        },
        model: () => {
          const issues: AuditIssue[] = [];
          const avail = contentWidth - 2 * 16 - 34 - 2 * 12; // padding, icon chip, gaps
          const valueW =
            estimateTextWidth(value, 20, 0, fontScale) +
            (delta !== null && delta !== 0 ? 10 + 6 : 0);
          const prevW = previous
            ? estimateTextWidth(previous, 13, 0, fontScale)
            : 0;
          const columnW = Math.max(valueW, prevW);
          const overflow = Math.min(columnW, contentWidth) - avail;
          if (overflow > 0.5) {
            issues.push({
              code: 'layout-model-horizontal-overflow',
              basis: 'INFERRED',
              detail: `value column ≈${Math.round(columnW)}pt exceeds ${Math.round(avail)}pt available @×${fontScale}, ${width}pt (label already squeezed to 0 by flex:1/minWidth:0)`,
            });
          }
          return issues;
        },
      };
    }

    case 'PracticeVolumeChart': {
      const count = rng.pick(BUCKET_COUNTS);
      const buckets: PracticeHistoryChartBucket[] = [];
      let outOfDomain = false;
      const startOrdinal = 20_700 + rng.int(0, 400);
      for (let index = 0; index < count; index += 1) {
        const day = dayIso(startOrdinal + index);
        const numeric =
          allowOutOfDomain && rng.chance(0.2)
            ? pickNumeric(rng, true)
            : rng.chance(0.4)
              ? { value: 0, outOfDomain: false, label: 'zero' }
              : { value: rng.int(1, 40), outOfDomain: false, label: 'count' };
        if (numeric.outOfDomain) outOfDomain = true;
        buckets.push({
          key: day,
          label: dayLabelFor(rng, locale, zone, day),
          count: numeric.value,
        });
      }
      const rangeClass = rng.pick(STRING_CLASSES);
      const rangeLabel = stringFor(rangeClass, rng);
      const activeNumeric = pickNumeric(rng, allowOutOfDomain);
      if (activeNumeric.outOfDomain) outOfDomain = true;
      const customLabel = rng.chance(0.25)
        ? stringFor(rng.pick(STRING_CLASSES), rng)
        : undefined;
      const compactedCount =
        count === 0 ? 0 : Math.ceil(count / Math.max(1, Math.ceil(count / 13)));
      const inCardWidth = width - 2 * SCREEN_PADDING - 2 * CARD_PADDING;
      return {
        ...base,
        component,
        variant: `buckets=${count} range=${rangeClass} activeDays=${activeNumeric.label} customA11y=${customLabel !== undefined}`,
        outOfDomain,
        element: (
          <PracticeVolumeChart
            buckets={buckets}
            rangeLabel={rangeLabel}
            activeDays={activeNumeric.value}
            accessibilityLabel={customLabel}
            testID="volume"
          />
        ),
        verify: renderer => {
          const issues: AuditIssue[] = [];
          const bars = hostNodes(renderer).filter(
            n => flatStyle(n.props.style).borderRadius === 5,
          );
          if (bars.length !== compactedCount) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `expected ${compactedCount} bars, rendered ${bars.length}`,
            });
          }
          const root = hostNodes(renderer).find(
            n => n.props.testID === 'volume',
          );
          const a11y = String(root?.props.accessibilityLabel ?? '');
          if (
            customLabel !== undefined &&
            a11y !== customLabel &&
            customLabel.trim() !== ''
          ) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: 'custom accessibilityLabel not applied verbatim',
            });
          }
          if (customLabel === undefined && !a11y.startsWith(rangeLabel)) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: 'default a11y label does not start with rangeLabel',
            });
          }
          // Axis: first/last labels are the first/last bucket labels.
          if (count > 0) {
            const texts = visibleTexts(renderer);
            const first = buckets[0]!.label;
            const last = buckets.at(-1)!.label;
            if (!texts.includes(first) || !texts.includes(last)) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: 'axis start/end labels missing from visible text',
              });
            }
          }
          return issues;
        },
        model: renderer => {
          const issues: AuditIssue[] = [];
          const showValues = compactedCount > 0 && compactedCount <= 7;
          if (!showValues) return issues;
          const bars = hostNodes(renderer).filter(
            n => flatStyle(n.props.style).borderRadius === 5,
          );
          const tallest = Math.max(
            0,
            ...bars.map(
              n => numericStyle(flatStyle(n.props.style), 'height') ?? 0,
            ),
          );
          const labelled = bars.some(n => {
            const h = numericStyle(flatStyle(n.props.style), 'height') ?? 0;
            return h > 4;
          });
          if (!labelled) return issues;
          const labelH = 13 * fontScale;
          const need = labelH + 3 + tallest;
          const slot = 78 + 4; // barSlot height + plot paddingTop
          if (need - slot > 0.5) {
            issues.push({
              code: 'layout-model-vertical-overflow',
              basis: 'INFERRED',
              detail: `label ${labelH.toFixed(1)} + 3 + bar ${tallest.toFixed(1)} = ${need.toFixed(1)}pt > ${slot}pt slot @×${fontScale} (overflows plot top by ${(need - slot).toFixed(1)}pt)`,
            });
          }
          const slotW =
            (inCardWidth - 4 * (compactedCount - 1)) / compactedCount;
          const widest = Math.max(
            ...buckets.map(b =>
              estimateTextWidth(String(b.count), 10, 0.2, fontScale),
            ),
          );
          if (widest > slotW + 4) {
            issues.push({
              code: 'layout-model-label-overlap',
              basis: 'INFERRED',
              detail: `value label ≈${widest.toFixed(1)}pt wider than ${slotW.toFixed(1)}pt slot @×${fontScale}, ${width}pt`,
            });
          }
          return issues;
        },
      };
    }

    case 'ScoreTrendChart': {
      const count = rng.pick(BUCKET_COUNTS);
      const built = trendBuckets(rng, locale, zone, count, allowOutOfDomain);
      const scored = built.buckets.filter(b => b.avg !== null);
      const latest =
        [...built.buckets].reverse().find(b => b.avg !== null) ?? null;
      const inCardWidth = width - 2 * SCREEN_PADDING - 2 * CARD_PADDING;
      return {
        ...base,
        component,
        variant: `buckets=${built.buckets.length} scored=${scored.length}`,
        outOfDomain: built.outOfDomain,
        element: <ScoreTrendChart buckets={built.buckets} />,
        verify: renderer => {
          const issues: AuditIssue[] = [];
          const bars = hostNodes(renderer).filter(
            n => flatStyle(n.props.style).borderRadius === 5,
          );
          if (bars.length !== built.buckets.length) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `expected ${built.buckets.length} bars, rendered ${bars.length}`,
            });
          }
          const root = hostNodes(renderer).find(
            n => n.props.accessible === true,
          );
          const a11y = String(root?.props.accessibilityLabel ?? '');
          if (scored.length === 0) {
            if (a11y !== 'No comparable scored reads in this window yet.') {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `empty summary wrong: ${a11y}`,
              });
            }
          } else if (
            !a11y.includes(
              `${scored.length} scored ${scored.length === 1 ? 'day' : 'days'}`,
            ) ||
            (latest &&
              Number.isFinite(latest.avg) &&
              !a11y.includes(
                `latest average ${latest.avg!.toFixed(1)} out of 10`,
              ))
          ) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `summary mismatch: ${a11y.slice(0, 160)}`,
            });
          }
          if (built.buckets.length <= 8) {
            const labels = visibleTexts(renderer).filter(t =>
              scored.some(b => b.avg!.toFixed(1) === t),
            );
            const finiteScored = scored.filter(b => Number.isFinite(b.avg));
            if (labels.length < finiteScored.length) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `expected ≥${finiteScored.length} bar value labels, saw ${labels.length}`,
              });
            }
          }
          return issues;
        },
        model: renderer => {
          const issues: AuditIssue[] = [];
          if (
            built.buckets.length === 0 ||
            built.buckets.length > 8 ||
            scored.length === 0
          )
            return issues;
          const bars = hostNodes(renderer).filter(
            n => flatStyle(n.props.style).borderRadius === 5,
          );
          const tallest = Math.max(
            0,
            ...bars.map(
              n => numericStyle(flatStyle(n.props.style), 'height') ?? 0,
            ),
          );
          const labelH = 13 * fontScale;
          const need = labelH + 3 + tallest;
          const slot = 92 + 4;
          if (need - slot > 0.5) {
            issues.push({
              code: 'layout-model-vertical-overflow',
              basis: 'INFERRED',
              detail: `label ${labelH.toFixed(1)} + 3 + bar ${tallest.toFixed(1)} = ${need.toFixed(1)}pt > ${slot}pt slot @×${fontScale} (overflows plot top by ${(need - slot).toFixed(1)}pt)`,
            });
          }
          const slotW =
            (inCardWidth - 4 * (built.buckets.length - 1)) /
            built.buckets.length;
          const widest = Math.max(
            ...scored.map(b =>
              estimateTextWidth(b.avg!.toFixed(1), 10, 0.2, fontScale),
            ),
          );
          if (widest > slotW + 4) {
            issues.push({
              code: 'layout-model-label-overlap',
              basis: 'INFERRED',
              detail: `value label ≈${widest.toFixed(1)}pt wider than ${slotW.toFixed(1)}pt slot @×${fontScale}, ${width}pt`,
            });
          }
          return issues;
        },
      };
    }

    case 'ScoreDotPlot': {
      const count = rng.pick(BUCKET_COUNTS.filter(c => c > 0));
      const built = trendBuckets(rng, locale, zone, count, false);
      const allDays = built.days.flat();
      const readCount = rng.pick([0, 1, 2, 3, 7, 8, 9, 12, 30, 200]);
      const reads: ScoredReadPoint[] = [];
      let outOfDomain = false;
      let matched = 0;
      const baseMs = Date.parse(`${allDays[0]}T00:00:00.000Z`);
      for (let index = 0; index < readCount; index += 1) {
        const unmatched = rng.chance(0.1);
        const day = unmatched
          ? dayIso(20_000 + rng.int(0, 10)) // years earlier → matches no bucket
          : rng.pick(allDays);
        if (!unmatched) matched += 1;
        const score = pickScore(rng, allowOutOfDomain);
        if (score.outOfDomain) outOfDomain = true;
        reads.push({
          id: `r${index}`,
          shotType: rng.pick(['forehand_drive', 'backhand_dink', 'serve']),
          capturedAtMs: baseMs + index * 60_000,
          day,
          score: score.value,
        });
      }
      const rangeClass = rng.pick(STRING_CLASSES);
      const rangeLabel = stringFor(rangeClass, rng);
      const inCardWidth = width - 2 * SCREEN_PADDING - 2 * CARD_PADDING;
      return {
        ...base,
        component,
        variant: `buckets=${built.buckets.length} reads=${readCount} matched=${matched} range=${rangeClass}`,
        outOfDomain,
        element: (
          <ScoreDotPlot
            buckets={built.buckets}
            reads={reads}
            rangeLabel={rangeLabel}
          />
        ),
        verify: renderer => {
          const issues: AuditIssue[] = [];
          const dots = hostNodes(renderer).filter(n => {
            const s = flatStyle(n.props.style);
            return (
              s.position === 'absolute' &&
              (s.borderRadius === 4.5 || s.borderRadius === 5.5)
            );
          });
          if (dots.length !== matched) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `expected ${matched} dots (reads matching a bucket), rendered ${dots.length}`,
            });
          }
          const latestDots = dots.filter(
            n => flatStyle(n.props.style).borderRadius === 5.5,
          );
          const lastRead = reads.at(-1);
          const lastMatched = lastRead ? allDays.includes(lastRead.day) : false;
          if (latestDots.length !== (lastMatched ? 1 : 0)) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `expected ${lastMatched ? 1 : 0} latest dot, rendered ${latestDots.length}`,
            });
          }
          const root = hostNodes(renderer).find(
            n => n.props.testID === 'score-dot-plot',
          );
          const a11y = String(root?.props.accessibilityLabel ?? '');
          if (readCount === 0) {
            if (a11y !== 'No scored reads in this window yet.') {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `empty summary wrong: ${a11y}`,
              });
            }
          } else if (
            !a11y.startsWith(rangeLabel) ||
            !a11y.includes(
              `${readCount} scored ${readCount === 1 ? 'read' : 'reads'}`,
            )
          ) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `summary mismatch: ${a11y.slice(0, 160)}`,
            });
          }
          return issues;
        },
        model: renderer => {
          const issues: AuditIssue[] = [];
          const labelWraps = hostNodes(renderer).filter(n => {
            const s = flatStyle(n.props.style);
            return (
              s.position === 'absolute' &&
              s.width === 36 &&
              s.marginLeft === -18
            );
          });
          if (labelWraps.length === 0) return issues;
          const plotH = 82;
          const rects = labelWraps.map(n => {
            const s = flatStyle(n.props.style);
            const left = String(s.left ?? '0%');
            const xPct = Number.parseFloat(left);
            const x = (xPct / 100) * inCardWidth;
            const text = visibleTextsUnder(n)[0] ?? '0.0';
            const w = estimateTextWidth(text, 10, 0.2, fontScale);
            const top = numericStyle(s, 'top') ?? 0;
            return {
              x0: x - w / 2,
              x1: x + w / 2,
              y0: top,
              y1: top + 13 * fontScale,
              text,
            };
          });
          let overlaps = 0;
          for (let a = 0; a < rects.length; a += 1) {
            for (let b = a + 1; b < rects.length; b += 1) {
              const A = rects[a]!;
              const B = rects[b]!;
              if (A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1)
                overlaps += 1;
            }
          }
          if (overlaps > 0) {
            issues.push({
              code: 'layout-model-label-overlap',
              basis: 'INFERRED',
              detail: `${overlaps} pair(s) of value labels overprint @×${fontScale}, plot ${inCardWidth}pt (${rects.length} labels)`,
            });
          }
          const spill = rects.filter(
            r => r.y1 > plotH + 7 + 0.5 || r.y0 < -0.5,
          );
          if (spill.length > 0) {
            issues.push({
              code: 'layout-model-vertical-overflow',
              basis: 'INFERRED',
              detail: `${spill.length} label(s) leave the ${plotH}pt plot (+7pt axis gap) @×${fontScale}: ${spill
                .slice(0, 3)
                .map(r => `${r.text}@[${r.y0.toFixed(1)},${r.y1.toFixed(1)}]`)
                .join(' ')}`,
            });
          }
          if (fontScale > 1) {
            // "above" labels are anchored by their top edge at y - r - 3 - 13;
            // taller text grows downward into the dot.
            const dots = hostNodes(renderer).filter(n => {
              const s = flatStyle(n.props.style);
              return (
                s.position === 'absolute' &&
                (s.borderRadius === 4.5 || s.borderRadius === 5.5)
              );
            });
            const intoDot = rects.filter(r =>
              dots.some(d => {
                const s = flatStyle(d.props.style);
                const dotTop = numericStyle(s, 'top') ?? 0;
                const left = Number.parseFloat(String(s.left ?? '0%'));
                const dx = (left / 100) * inCardWidth;
                return (
                  Math.abs(dx - (r.x0 + r.x1) / 2) < 1 &&
                  r.y0 < dotTop &&
                  r.y1 > dotTop + 0.5
                );
              }),
            );
            if (intoDot.length > 0) {
              issues.push({
                code: 'layout-model-label-overlap',
                basis: 'INFERRED',
                detail: `${intoDot.length} "above" label(s) grow into their dot @×${fontScale} (LABEL_HEIGHT fixed at 13pt)`,
              });
            }
          }
          return issues;
        },
      };
    }

    case 'PracticeSetCard': {
      const attemptCount = rng.pick([2, 2, 3, 5, 8, 20]);
      const shotClass = rng.pick([
        'ascii',
        'cjk',
        'arabic-rtl',
        'turkish-dotted',
        'german-compound',
        'zwj-emoji',
        'long-ascii',
        'combining-marks',
      ] as StringClass[]);
      const shotType =
        shotClass === 'ascii'
          ? rng.pick(['forehand_drive', 'backhand_dink', 'third_shot_drop'])
          : stringFor(shotClass, rng);
      const direct = allowOutOfDomain && rng.chance(0.5);
      let outOfDomain = false;
      let summary: PracticeSetSummary;
      if (direct) {
        // Bypass the pure module (which filters non-finite scores) to feed
        // the card out-of-domain attempt scores directly.
        const attempts: PracticeSetAttempt[] = [];
        for (let index = 0; index < attemptCount; index += 1) {
          const score = pickScore(rng, true);
          if (score.outOfDomain) outOfDomain = true;
          attempts.push({
            id: `a${index}`,
            capturedAt: new Date(
              1_788_000_000_000 + index * 60_000,
            ).toISOString(),
            overallScore: score.value,
            priorityCheckpoint: rng.chance(0.5)
              ? stringFor(rng.pick(STRING_CLASSES), rng)
              : null,
            checkpointScores: {},
          });
        }
        const first = attempts[0]!;
        const latest = attempts.at(-1)!;
        summary = {
          sessionId: 'set-1',
          shotType,
          attempts,
          first,
          latest,
          best: latest,
          deltaTenths: rng.pick([0, 3, -3, 100, -100, Number.NaN]),
          trend: rng.pick(['improved', 'slipped', 'held']),
          fixedCheckpoints: [],
          stillOpen: latest.priorityCheckpoint,
          excludedCount: rng.pick([0, 1, 2, 1e6]),
          startedAt: first.capturedAt,
          endedAt: latest.capturedAt,
        };
        if (Number.isNaN(summary.deltaTenths)) outOfDomain = true;
      } else {
        const facts: RealAnalysisFact[] = [];
        for (let index = 0; index < attemptCount; index += 1) {
          facts.push(
            fact(
              `a${index}`,
              new Date(1_788_000_000_000 + index * 60_000).toISOString(),
              rng.int(0, 100) / 10,
              {
                shotType,
                shotConfigVersion: `${shotType}@1`,
                priorityCheckpoint: rng.chance(0.4)
                  ? rng.pick([
                      'contact_point',
                      'weight_transfer',
                      stringFor('cjk', rng),
                    ])
                  : null,
                checkpointScores: rng.chance(0.5)
                  ? {
                      contact_point: rng.int(0, 100),
                      weight_transfer: rng.int(0, 100),
                    }
                  : {},
              },
            ),
          );
        }
        if (rng.chance(0.3)) {
          facts.push(
            fact(
              'excluded',
              new Date(1_788_000_000_000 - 60_000).toISOString(),
              5,
              {
                shotType,
                scoringModelVersion: 'sm-v1',
                shotConfigVersion: `${shotType}@1`,
              },
            ),
          );
        }
        const built = summarizePracticeSet(facts, 'set-1');
        if (!built)
          throw new Error(
            `seed ${seed}: summarizePracticeSet returned null for ${attemptCount} attempts`,
          );
        summary = built;
      }
      const interactive = rng.chance(0.6);
      const compact = rng.chance(0.4);
      const opened: string[] = [];
      return {
        ...base,
        component,
        variant: `attempts=${summary.attempts.length} shot=${shotClass} interactive=${interactive} compact=${compact} direct=${direct}`,
        outOfDomain,
        element: (
          <PracticeSetCard
            summary={summary}
            onOpenAttempt={interactive ? id => opened.push(id) : undefined}
            compact={compact}
          />
        ),
        verify: renderer => {
          const issues: AuditIssue[] = [];
          const total = summary.attempts.length;
          const targets = hostNodes(renderer).filter(n =>
            String(n.props.testID ?? '').startsWith('practice-set-attempt-'),
          );
          if (targets.length !== total) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `expected ${total} attempt targets, rendered ${targets.length}`,
            });
          }
          targets.forEach((node, index) => {
            const label = String(node.props.accessibilityLabel ?? '');
            const expectedPrefix = `Attempt ${index + 1} of ${total}, score `;
            if (!label.startsWith(expectedPrefix)) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `attempt ${index + 1} label "${label.slice(0, 80)}" lacks "${expectedPrefix}"`,
              });
            }
            if ((index === total - 1) !== label.endsWith(', latest')) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `attempt ${index + 1} latest suffix wrong: "${label.slice(-40)}"`,
              });
            }
            if (interactive) {
              if (node.props.accessibilityRole !== 'button') {
                issues.push({
                  code: 'a11y-interactive-no-role',
                  basis: 'VERIFIED',
                  detail: `attempt ${index + 1} role=${String(node.props.accessibilityRole)}`,
                });
              }
              if (
                node.props.accessibilityHint !== "Opens this attempt's result"
              ) {
                issues.push({
                  code: 'content-mismatch',
                  basis: 'VERIFIED',
                  detail: `attempt ${index + 1} hint missing`,
                });
              }
              const [pressable] = renderer.root.findAll(
                n =>
                  n.props.testID === node.props.testID &&
                  typeof n.props.onPress === 'function',
              );
              if (!pressable) {
                issues.push({
                  code: 'content-mismatch',
                  basis: 'VERIFIED',
                  detail: `attempt ${index + 1} has no onPress handler`,
                });
              } else {
                act(() => {
                  pressable.props.onPress();
                });
              }
            } else if (typeof node.props.onClick === 'function') {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: 'non-interactive card exposes a press handler',
              });
            }
          });
          if (interactive) {
            const expectedIds = summary.attempts.map(a => a.id);
            if (JSON.stringify(opened) !== JSON.stringify(expectedIds)) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: `pressing every pill opened ${JSON.stringify(opened.slice(0, 5))}, expected ${JSON.stringify(expectedIds.slice(0, 5))}`,
              });
            }
          }
          const latestPills = hostNodes(renderer).filter(
            n => n.props.testID === 'practice-set-latest-pill',
          );
          if (latestPills.length !== 1) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: `expected exactly one latest pill, saw ${latestPills.length}`,
            });
          }
          const header = hostNodes(renderer).find(
            n => n.props.accessibilityRole === 'header',
          );
          if (
            !header ||
            typeof header.props.accessibilityLabel !== 'string' ||
            header.props.accessibilityLabel.length === 0
          ) {
            issues.push({
              code: 'a11y-missing-label',
              basis: 'VERIFIED',
              detail: 'headline lacks header role/label',
            });
          }
          const texts = visibleTexts(renderer);
          if (!compact) {
            const stroke = shotType.replace(/_/g, ' ').toUpperCase();
            if (!texts.includes(stroke)) {
              issues.push({
                code: 'content-mismatch',
                basis: 'VERIFIED',
                detail: 'stroke label not rendered uppercased',
              });
            }
          } else if (
            texts.some(
              t =>
                t === shotType.replace(/_/g, ' ').toUpperCase() &&
                t !== 'THIS SET',
            )
          ) {
            issues.push({
              code: 'content-mismatch',
              basis: 'VERIFIED',
              detail: 'compact card still renders the stroke label',
            });
          }
          return issues;
        },
        model: () => {
          const issues: AuditIssue[] = [];
          const captionH = 18 * fontScale; // type.caption lineHeight
          if (captionH - 30 > 0.5) {
            issues.push({
              code: 'layout-model-vertical-overflow',
              basis: 'INFERRED',
              detail: `pill caption lineHeight ${captionH.toFixed(1)}pt > fixed pill height 30pt @×${fontScale}`,
            });
          }
          return issues;
        },
      };
    }

    default: {
      const exhaustive: never = component;
      throw new Error(`unknown component ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------

interface Executed {
  row: ResultRow;
  tree: unknown;
}

function execute(seed: number, campaign: string): Executed {
  const started = Date.now();
  let scenario: Scenario | null = null;
  let renderer: TestRenderer.ReactTestRenderer | null = null;
  let tree: unknown = null;
  const issues: AuditIssue[] = [];
  let textSample: string[] = [];
  try {
    scenario = buildScenario(seed);
    act(() => {
      renderer = TestRenderer.create(scenario!.element);
    });
    act(() => {
      jest.advanceTimersByTime(1_000);
    });
    tree = evidenceTree(renderer!);
    textSample = visibleTexts(renderer!).map(t =>
      t.length > 60 ? `${t.slice(0, 57)}…` : t,
    );
    issues.push(...auditAccessibility(renderer!));
    issues.push(...scenario.verify(renderer!));
    issues.push(...scenario.model(renderer!));
    act(() => {
      renderer!.update(scenario!.element); // re-render with identical props
      jest.advanceTimersByTime(1_000);
    });
    act(() => {
      renderer!.unmount();
    });
  } catch (error) {
    issues.push({
      code: 'crash',
      basis: 'VERIFIED',
      detail:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
    });
  }
  const known = new Set<string>();
  let broken = false;
  for (const issue of issues) {
    const defect = scenario
      ? knownDefectFor(issue, {
          component: scenario.component,
          outOfDomain: scenario.outOfDomain,
          fontScale: scenario.fontScale,
        })
      : undefined;
    if (defect) known.add(defect.id);
    else broken = true;
  }
  const outcome: ResultRow['outcome'] = broken
    ? 'BROKEN'
    : known.size > 0
      ? 'BROKEN_KNOWN'
      : 'HELD';
  return {
    tree,
    row: {
      seed,
      campaign,
      component: scenario?.component ?? 'unknown',
      variant: scenario?.variant ?? 'build failed',
      locale: scenario?.locale,
      timeZone: scenario?.timeZone,
      fontScale: scenario?.fontScale,
      width: scenario?.width,
      outOfDomain: scenario?.outOfDomain,
      outcome,
      known: known.size > 0 ? [...known].sort() : undefined,
      issues,
      textSample: textSample.slice(0, 12),
      durationMs: Date.now() - started,
    },
  };
}

/** Shrinks a failing seed's scenario description to the smallest campaign
 * neighbour that reproduces the same unknown issue codes (seed-space
 * minimization: the smallest seed with an identical BROKEN signature). */
function minimize(rows: readonly ResultRow[]): Record<string, number> {
  const smallest: Record<string, number> = {};
  for (const row of rows) {
    if (row.outcome !== 'BROKEN') continue;
    const signature = `${row.component}|${row.issues
      .filter(i => !knownDefectFor(i, contextOf(row)))
      .map(i => i.code)
      .sort()
      .join(',')}`;
    if (smallest[signature] === undefined || row.seed < smallest[signature]!) {
      smallest[signature] = row.seed;
    }
  }
  return smallest;
}

/** Smallest seed reproducing each known defect (replay with STRESS_SEED). */
function minimizeKnown(rows: readonly ResultRow[]): Record<string, number> {
  const smallest: Record<string, number> = {};
  for (const row of rows) {
    for (const id of row.known ?? []) {
      if (smallest[id] === undefined || row.seed < smallest[id]!) {
        smallest[id] = row.seed;
      }
    }
  }
  return smallest;
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('progress charts — seeded boundary/i18n/a11y campaign', () => {
  const only = replaySeed();
  const iterations = only === null ? campaignIterations(DEFAULT_ITERATIONS) : 1;

  test(`renders ${iterations} seeded variant(s) with no unclassified failure`, () => {
    const rows: ResultRow[] = [];
    const evidence: Record<string, unknown> = {};
    for (let index = 0; index < iterations; index += 1) {
      const seed = only ?? BASE_SEED + index;
      const { row, tree } = execute(seed, 'fuzz');
      rows.push(row);
      if (row.outcome !== 'HELD' && Object.keys(evidence).length < 40) {
        evidence[String(seed)] = { row, tree };
      }
    }
    const minimized = minimize(rows);
    const table = writeResults('progressCharts.boundary-i18n-a11y', rows, {
      baseSeed: only ?? BASE_SEED,
      iterations,
      components: COMPONENTS,
      locales: LOCALES,
      timeZones: TIME_ZONES.map(t => t.zone),
      fontScales: FONT_SCALES.map(f => f.scale),
      widths: WIDTHS.map(w => w.width),
      knownDefects: KNOWN_DEFECTS.map(d => d.id),
      minimizedBrokenSeeds: minimized,
      minimizedKnownSeeds: minimizeKnown(rows),
    });
    const evidencePath = writeEvidence(
      'progressCharts.boundary-i18n-a11y.trees',
      evidence,
    );

    const broken = rows.filter(r => r.outcome === 'BROKEN');
    const perComponent = Object.fromEntries(
      COMPONENTS.map(c => [c, rows.filter(r => r.component === c).length]),
    );
    // Every component must actually have been exercised in a default run.
    if (only === null && iterations >= 150) {
      for (const component of COMPONENTS) {
        expect(perComponent[component]).toBeGreaterThan(0);
      }
      expect(new Set(rows.map(r => r.locale)).size).toBe(LOCALES.length);
      expect(new Set(rows.map(r => r.timeZone)).size).toBe(TIME_ZONES.length);
      expect(new Set(rows.map(r => r.fontScale)).size).toBe(FONT_SCALES.length);
      expect(new Set(rows.map(r => r.width)).size).toBe(WIDTHS.length);
    }
    expect({
      table,
      evidencePath,
      broken: broken.map(r => ({
        seed: r.seed,
        component: r.component,
        variant: r.variant,
        issues: r.issues.filter(i => !knownDefectFor(i, contextOf(r))),
      })),
    }).toEqual({ table, evidencePath, broken: [] });
  });
});

// ---------------------------------------------------------------------------
// Pinned defects (expected behaviour; flips to "unexpected pass" once fixed).
// ---------------------------------------------------------------------------

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  act(() => {
    jest.advanceTimersByTime(1_000);
  });
  return renderer;
}

describe('pinned boundary defects (test.failing — start passing when fixed)', () => {
  test.failing(
    'PC-01 ScoreTrendChart never prints NaN / Infinity for a non-finite avg',
    () => {
      const renderer = render(
        <ScoreTrendChart
          buckets={[
            { key: '2026-09-01', label: 'Sep 1', avg: Number.NaN, count: 1 },
            {
              key: '2026-09-02',
              label: 'Sep 2',
              avg: Number.POSITIVE_INFINITY,
              count: 1,
            },
          ]}
        />,
      );
      const texts = visibleTexts(renderer);
      const label = String(hostNodes(renderer)[0]?.props.accessibilityLabel);
      expect(texts.map(leakToken).filter(Boolean)).toEqual([]);
      expect(leakToken(label)).toBeNull();
    },
  );

  test.failing(
    'PC-01 ScoreDotPlot never prints NaN for a non-finite score',
    () => {
      const renderer = render(
        <ScoreDotPlot
          buckets={[{ key: '2026-09-01', label: 'Sep 1', avg: null, count: 1 }]}
          reads={[
            {
              id: 'r',
              shotType: 'serve',
              capturedAtMs: 0,
              day: '2026-09-01',
              score: Number.NaN,
            },
          ]}
          rangeLabel="7 days"
        />,
      );
      const label = String(hostNodes(renderer)[0]?.props.accessibilityLabel);
      expect(visibleTexts(renderer).map(leakToken).filter(Boolean)).toEqual([]);
      expect(leakToken(label)).toBeNull();
    },
  );

  test.failing('PC-01 PracticeVolumeChart never speaks NaN active days', () => {
    const renderer = render(
      <PracticeVolumeChart
        buckets={[]}
        rangeLabel="7 days"
        activeDays={Number.NaN}
        testID="v"
      />,
    );
    const label = String(hostNodes(renderer)[0]?.props.accessibilityLabel);
    expect(leakToken(label)).toBeNull();
  });

  test.failing(
    'PC-02 PracticeVolumeChart clamps a negative count to a non-negative bar height',
    () => {
      const renderer = render(
        <PracticeVolumeChart
          buckets={[
            { key: 'a', label: 'A', count: 3 },
            { key: 'b', label: 'B', count: -5 },
          ]}
          rangeLabel="7 days"
          activeDays={1}
        />,
      );
      const heights = hostNodes(renderer)
        .filter(n => flatStyle(n.props.style).borderRadius === 5)
        .map(n => numericStyle(flatStyle(n.props.style), 'height'));
      expect(heights.every(h => h !== null && h >= 0)).toBe(true);
    },
  );

  test.failing(
    'PC-02 ScoreTrendChart clamps a negative avg to a non-negative bar height',
    () => {
      const renderer = render(
        <ScoreTrendChart
          buckets={[{ key: 'a', label: 'A', avg: -100, count: 1 }]}
        />,
      );
      const heights = hostNodes(renderer)
        .filter(n => flatStyle(n.props.style).borderRadius === 5)
        .map(n => numericStyle(flatStyle(n.props.style), 'height'));
      expect(heights.every(h => h !== null && h >= 0)).toBe(true);
    },
  );

  test.failing(
    'PC-09 PracticeVolumeChart falls back to its summary when accessibilityLabel is empty',
    () => {
      const renderer = render(
        <PracticeVolumeChart
          buckets={[{ key: 'a', label: 'A', count: 2 }]}
          rangeLabel="7 days"
          activeDays={1}
          accessibilityLabel=""
          testID="v"
        />,
      );
      const label = hostNodes(renderer)[0]?.props.accessibilityLabel;
      expect(typeof label === 'string' && label.trim().length > 0).toBe(true);
    },
  );

  test.failing(
    'PC-03 StatDeltaRow treats a NaN delta like null (no triangle, no trend)',
    () => {
      const renderer = render(
        <StatDeltaRow
          icon="camera"
          label="CAPTURES"
          value="3"
          previous="2"
          delta={Number.NaN}
          testID="row"
        />,
      );
      const label = String(hostNodes(renderer)[0]?.props.accessibilityLabel);
      const triangles = hostNodes(renderer).filter(
        n => flatStyle(n.props.style).borderLeftWidth === 5,
      );
      expect(label).not.toContain('trending');
      expect(triangles).toHaveLength(0);
    },
  );
});

describe('Dynamic Type contract (VERIFIED from tree)', () => {
  test('no chart text opts out of font scaling or caps the multiplier', () => {
    // Documents the premise of the layout-model rows: every Text in these
    // components scales with the user's Dynamic Type setting, so fixed
    // pixel slots really do receive taller text.
    const summary = summarizePracticeSet(
      [
        fact('a', '2026-09-02T17:00:00.000Z', 6),
        fact('b', '2026-09-02T17:05:00.000Z', 7),
      ],
      'set-1',
    )!;
    const elements = [
      <PracticeVolumeChart
        key="v"
        buckets={[{ key: 'a', label: 'A', count: 2 }]}
        rangeLabel="7 days"
        activeDays={1}
      />,
      <ScoreTrendChart
        key="t"
        buckets={[{ key: 'a', label: 'A', avg: 7, count: 1 }]}
      />,
      <ScoreDotPlot
        key="d"
        buckets={[{ key: 'a', label: 'A', avg: 7, count: 1 }]}
        reads={[
          { id: 'r', shotType: 's', capturedAtMs: 0, day: 'a', score: 7 },
        ]}
        rangeLabel="7 days"
      />,
      <StatDeltaRow
        key="s"
        icon="camera"
        label="CAPTURES"
        value="3"
        previous="2"
        delta={1}
      />,
      <PracticeSetCard key="p" summary={summary} onOpenAttempt={() => {}} />,
      <DashSectionHeader
        key="h"
        title="KEY STATISTICS"
        right="VS. PRIOR 90 DAYS"
      />,
    ];
    for (const element of elements) {
      const renderer = render(element);
      const texts = hostNodes(renderer).filter(n => hostType(n) === 'Text');
      expect(texts.length).toBeGreaterThan(0);
      for (const text of texts) {
        expect(text.props.allowFontScaling).not.toBe(false);
        expect(text.props.maxFontSizeMultiplier).toBeUndefined();
      }
      act(() => renderer.unmount());
    }
  });
});
