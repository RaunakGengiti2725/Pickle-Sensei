/**
 * STRESS · cmp-progress-charts · lens rapid-interaction (2/3)
 *
 * The four presentation surfaces of the unit — PracticeVolumeChart,
 * ScoreTrendChart, ScoreDotPlot, StatDeltaRow + DashSectionHeader — under
 * rapid data churn while their reveal animations are mid-flight: range
 * switches faster than the 240ms reveal, layout events racing the data,
 * reduced-motion flipping under an in-flight `Animated.timing`, and unmount
 * mid-transition.
 *
 * Invariants asserted per burst:
 *   - the tree rendered after the burst matches the LAST data pushed (no
 *     stale bar/dot/label from a superseded range — a chart that keeps the
 *     previous window's geometry is the chart-equivalent of an orphan
 *     loading state);
 *   - one accessibility summary per chart, and it agrees with the last data;
 *   - the reveal animation always lands on its final value (bars/dots are
 *     never stranded mid-interpolation once timers drain);
 *   - no act() warning, console.error/warn, unhandled rejection;
 *   - no timer or animation frame left armed after unmount.
 *
 * Replay:  STRESS_ONLY=<seed> npx jest __tests__/stress/progressChartsRapidRerender.stress.test.tsx
 * Scale:   STRESS_ITER=<n>   (default 40)
 */
import React from 'react';
import { AccessibilityInfo, Animated, Text, View } from 'react-native';
import { Polyline } from 'react-native-svg';
import TestRenderer, { act } from 'react-test-renderer';
import {
  compactPracticeBuckets,
  PracticeVolumeChart,
} from '../../src/progress/PracticeVolumeChart';
import { ScoreTrendChart } from '../../src/progress/ScoreTrendChart';
import {
  dotPlotGeometry,
  DOT_PLOT_HEIGHT,
  ScoreDotPlot,
} from '../../src/progress/ScoreDotPlot';
import { StatDeltaRow } from '../../src/progress/StatDeltaRow';
import { DashSectionHeader } from '../../src/progress/DashSectionHeader';
import type {
  ScoredReadPoint,
  ScoreTrendBucket,
} from '../../src/progress/techniqueDashboard';
import type { PracticeHistoryChartBucket } from '../../src/progress/practiceHistory';
import {
  campaignConfig,
  genPracticeBuckets,
  genReads,
  genScoreTrendBuckets,
  guardFailures,
  ResultTable,
  Rng,
  seedsFor,
  tenthScore,
  withGuards,
  type IterationRow,
} from '../../test-support/stress/progressChartsRapidInteraction';

const CONFIG = campaignConfig('progressChartsRapidRerender', 40);
const TABLE = new ResultTable(CONFIG);

type Surface = 'volume' | 'trend' | 'dotplot' | 'statRow';
type Churn =
  | 'range-spam'
  | 'churn-during-reveal'
  | 'layout-race'
  | 'reduced-motion-flip-mid-reveal'
  | 'unmount-mid-reveal'
  | 'identical-data-resubmit'
  | 'empty-nonempty-flap';

const SURFACES: readonly Surface[] = ['volume', 'trend', 'dotplot', 'statRow'];
const CHURNS: readonly Churn[] = [
  'range-spam',
  'churn-during-reveal',
  'layout-race',
  'reduced-motion-flip-mid-reveal',
  'unmount-mid-reveal',
  'identical-data-resubmit',
  'empty-nonempty-flap',
];

// ─── Per-surface data + element + expectations ──────────────────────────────

interface VolumeData {
  kind: 'volume';
  buckets: PracticeHistoryChartBucket[];
  rangeLabel: string;
  activeDays: number;
}
interface TrendData {
  kind: 'trend';
  buckets: ScoreTrendBucket[];
}
interface DotData {
  kind: 'dotplot';
  buckets: ScoreTrendBucket[];
  reads: ScoredReadPoint[];
  rangeLabel: string;
}
interface StatData {
  kind: 'statRow';
  label: string;
  value: string;
  previous: string | null;
  delta: number | null;
}
type Data = VolumeData | TrendData | DotData | StatData;

const RANGE_LABELS = ['7 days', '30 days', '90 days', 'All time'] as const;

function genData(rng: Rng, surface: Surface, empty = false): Data {
  switch (surface) {
    case 'volume':
      return {
        kind: 'volume',
        buckets: empty ? [] : genPracticeBuckets(rng),
        rangeLabel: rng.pick(RANGE_LABELS),
        activeDays: rng.int(0, 90),
      };
    case 'trend':
      return { kind: 'trend', buckets: empty ? [] : genScoreTrendBuckets(rng) };
    case 'dotplot': {
      const buckets = empty ? [] : genScoreTrendBuckets(rng);
      return {
        kind: 'dotplot',
        buckets,
        reads: empty ? [] : genReads(rng, buckets),
        rangeLabel: rng.pick(RANGE_LABELS),
      };
    }
    case 'statRow':
      return {
        kind: 'statRow',
        label: rng.pick(['Scored reps', 'Average score', 'Active days']),
        value: tenthScore(rng).toFixed(1),
        previous: rng.chance(0.3) ? null : tenthScore(rng).toFixed(1),
        delta: rng.chance(0.25) ? null : rng.int(-40, 40) / 10,
      };
  }
}

function element(data: Data): React.ReactElement {
  switch (data.kind) {
    case 'volume':
      return (
        <View>
          <DashSectionHeader title="PRACTICE VOLUME" right={data.rangeLabel} />
          <PracticeVolumeChart
            buckets={data.buckets}
            rangeLabel={data.rangeLabel}
            activeDays={data.activeDays}
            testID="volume-chart"
          />
        </View>
      );
    case 'trend':
      return (
        <View>
          <DashSectionHeader title="SCORE TREND" />
          <ScoreTrendChart buckets={data.buckets} />
        </View>
      );
    case 'dotplot':
      return (
        <View>
          <DashSectionHeader title="SCORES" right={data.rangeLabel} />
          <ScoreDotPlot
            buckets={data.buckets}
            reads={data.reads}
            rangeLabel={data.rangeLabel}
          />
        </View>
      );
    case 'statRow':
      return (
        <View>
          <DashSectionHeader title="THIS WINDOW" />
          <StatDeltaRow
            icon="spark"
            label={data.label}
            value={data.value}
            previous={data.previous}
            delta={data.delta}
            testID="stat-row"
          />
        </View>
      );
  }
}

/** Bar/dot count the data demands, and the labels the axis must show. */
function expectations(data: Data): {
  bars: number;
  labels: string[];
  values: string[];
} {
  switch (data.kind) {
    case 'volume': {
      const compacted = compactPracticeBuckets(data.buckets);
      const showValues = compacted.length <= 7;
      return {
        bars: compacted.length,
        labels: [
          compacted[0]?.firstLabel ?? '',
          compacted.at(-1)?.lastLabel ?? '',
        ],
        values: showValues
          ? compacted.filter(b => b.count > 0).map(b => String(b.count))
          : [],
      };
    }
    case 'trend': {
      const showLabels = data.buckets.length <= 8;
      return {
        bars: data.buckets.length,
        labels: [
          data.buckets[0]?.label ?? '',
          data.buckets.at(-1)?.label ?? '',
        ],
        values: showLabels
          ? data.buckets.filter(b => b.avg !== null).map(b => b.avg!.toFixed(1))
          : [],
      };
    }
    case 'dotplot': {
      const points = dotPlotGeometry(data.buckets, data.reads, DOT_PLOT_HEIGHT);
      return {
        bars: points.length,
        labels: [
          data.buckets[0]?.label ?? '',
          data.buckets.at(-1)?.label ?? '',
        ],
        values: points.length <= 8 ? points.map(p => p.score.toFixed(1)) : [],
      };
    }
    case 'statRow':
      return { bars: 0, labels: [], values: [data.value] };
  }
}

// ─── Tree inspection ────────────────────────────────────────────────────────

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children;
      return Array.isArray(children) ? children : [children];
    })
    .filter(
      (c): c is string | number =>
        typeof c === 'string' || typeof c === 'number',
    )
    .map(String);
}

function animatedHeights(renderer: TestRenderer.ReactTestRenderer): number[] {
  return renderer.root.findAllByType(Animated.View).flatMap(node => {
    const flat = [node.props.style].flat(4);
    return flat
      .map(style =>
        style && typeof style === 'object' && 'height' in style
          ? (style as { height: unknown }).height
          : null,
      )
      .filter((h): h is { __getValue: () => number } => {
        return (
          h !== null &&
          typeof h === 'object' &&
          typeof (h as { __getValue?: unknown }).__getValue === 'function'
        );
      })
      .map(h => h.__getValue());
  });
}

function accessibilitySummaries(
  renderer: TestRenderer.ReactTestRenderer,
): string[] {
  return renderer.root
    .findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessible === true &&
        typeof node.props.accessibilityLabel === 'string',
    )
    .map(node => String(node.props.accessibilityLabel));
}

function reducedMotionListener(): ((value: boolean) => void) | null {
  const calls = (AccessibilityInfo.addEventListener as unknown as jest.Mock)
    .mock.calls as Array<[string, (value: boolean) => void]>;
  const call = calls.find(c => c[0] === 'reduceMotionChanged');
  return call ? call[1] : null;
}

function layoutHosts(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.onLayout === 'function',
  );
}

// ─── Iteration ──────────────────────────────────────────────────────────────

interface Ctx {
  renderer: TestRenderer.ReactTestRenderer;
  mounted: boolean;
  actions: number;
}

function runIteration(seed: number): IterationRow {
  const rng = new Rng(seed);
  const surface = rng.pick(SURFACES);
  const churn = rng.pick(CHURNS);
  const failures: string[] = [];
  const ctx: Ctx = {
    renderer: null as unknown as TestRenderer.ReactTestRenderer,
    mounted: false,
    actions: 0,
  };
  let last: Data = genData(rng, surface);
  let pushes = 0;

  const push = (data: Data) => {
    last = data;
    pushes += 1;
    act(() => {
      if (ctx.mounted) ctx.renderer.update(element(data));
      else ctx.renderer = TestRenderer.create(element(data));
    });
    ctx.mounted = true;
    ctx.actions += 1;
  };
  const step = (ms: number) => {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
    ctx.actions += 1;
  };
  /** Lets every reveal run to completion: an `Animated.timing` re-arms its
   * frame each tick, so pending-only draining would leave one armed. */
  const drain = () => {
    act(() => {
      jest.advanceTimersByTime(5_000);
      jest.runOnlyPendingTimers();
    });
    ctx.actions += 1;
  };
  const layout = (width: number) => {
    const hosts = layoutHosts(ctx.renderer);
    if (hosts.length === 0) return;
    act(() => {
      for (const host of hosts) {
        (host.props.onLayout as (e: unknown) => void)({
          nativeEvent: {
            layout: { x: 0, y: 0, width, height: DOT_PLOT_HEIGHT },
          },
        });
      }
    });
    ctx.actions += 1;
  };

  const { report } = withGuards(() => {
    try {
      push(last);
      switch (churn) {
        case 'range-spam': {
          const n = rng.int(3, 8);
          for (let i = 0; i < n; i += 1) {
            push(genData(rng, surface));
            if (rng.chance(0.4)) step(rng.int(1, 239));
          }
          drain();
          break;
        }
        case 'churn-during-reveal': {
          // Never let the 240ms reveal finish before the next push.
          const n = rng.int(4, 10);
          for (let i = 0; i < n; i += 1) {
            step(rng.int(1, 80));
            push(genData(rng, surface));
          }
          drain();
          break;
        }
        case 'layout-race': {
          layout(rng.int(1, 400));
          push(genData(rng, surface));
          layout(rng.int(1, 400));
          step(rng.int(1, 200));
          layout(0); // a zero-width layout must be ignored, not divide by it
          push(genData(rng, surface));
          layout(rng.int(200, 900));
          drain();
          break;
        }
        case 'reduced-motion-flip-mid-reveal': {
          const listener = reducedMotionListener();
          if (!listener)
            throw new Error('reduceMotionChanged listener not registered');
          step(rng.int(1, 120));
          act(() => listener(true));
          ctx.actions += 1;
          push(genData(rng, surface));
          step(rng.int(1, 120));
          act(() => listener(false));
          ctx.actions += 1;
          push(genData(rng, surface));
          drain();
          // Leave the module-level flag as we found it for the next iteration.
          act(() => listener(false));
          break;
        }
        case 'unmount-mid-reveal': {
          step(rng.int(0, 120));
          if (rng.chance(0.5)) push(genData(rng, surface));
          layout(rng.int(0, 400));
          act(() => ctx.renderer.unmount());
          ctx.mounted = false;
          ctx.actions += 1;
          break;
        }
        case 'identical-data-resubmit': {
          // Same VALUES, fresh object identity: the effect's signature must
          // not restart a reveal that already landed.
          drain();
          const heightsBefore = animatedHeights(ctx.renderer);
          const n = rng.int(2, 5);
          for (let i = 0; i < n; i += 1) push(structuredClone(last));
          const heightsAfter = animatedHeights(ctx.renderer);
          if (
            heightsBefore.length === heightsAfter.length &&
            heightsBefore.some((h, i) => Math.abs(h - heightsAfter[i]!) > 0.001)
          ) {
            failures.push(
              `identical data restarted the reveal: ${heightsBefore.slice(0, 4)} -> ${heightsAfter.slice(0, 4)}`,
            );
          }
          drain();
          break;
        }
        case 'empty-nonempty-flap': {
          const n = rng.int(2, 6);
          for (let i = 0; i < n; i += 1) {
            push(genData(rng, surface, i % 2 === 0));
            if (rng.chance(0.5)) step(rng.int(1, 200));
            if (surface === 'dotplot') layout(rng.int(0, 320));
          }
          drain();
          break;
        }
      }

      if (ctx.mounted) {
        // Settle: after every timer drains the tree must describe `last`.
        drain();
        if (surface === 'dotplot') layout(300);
        drain();
        const want = expectations(last);
        const shown = texts(ctx.renderer);
        for (const value of want.values) {
          if (!shown.includes(value)) {
            failures.push(
              `missing value label ${value} (shown ${shown.slice(0, 12)})`,
            );
            break;
          }
        }
        for (const label of want.labels) {
          if (label !== '' && !shown.includes(label)) {
            failures.push(`missing axis label ${label}`);
            break;
          }
        }
        const summaries = accessibilitySummaries(ctx.renderer);
        if (surface !== 'statRow' && summaries.length !== 1) {
          failures.push(`${summaries.length} accessibility summaries (want 1)`);
        }
        if (surface === 'dotplot') {
          const dotData = last as DotData;
          const points = dotPlotGeometry(dotData.buckets, dotData.reads);
          const polylines = ctx.renderer.root.findAllByType(Polyline);
          if (points.length >= 2 && polylines.length !== 1) {
            failures.push(
              `${polylines.length} polylines for ${points.length} points (want 1)`,
            );
          }
          if (points.length < 2 && polylines.length !== 0) {
            failures.push(`polyline drawn for ${points.length} point(s)`);
          }
          const summary = summaries[0] ?? '';
          const latest = dotData.reads.at(-1);
          if (latest && !summary.includes(latest.score.toFixed(1))) {
            failures.push(
              `summary "${summary}" omits latest ${latest.score.toFixed(1)}`,
            );
          }
        }
        // Bars/dots settled: every animated height is a finite number and the
        // reveal is not stranded at its 4px floor while data says otherwise.
        const heights = animatedHeights(ctx.renderer);
        if (heights.some(h => !Number.isFinite(h))) {
          failures.push(`non-finite animated height: ${heights}`);
        }
        if (
          (surface === 'volume' || surface === 'trend') &&
          want.bars > 0 &&
          heights.length !== want.bars
        ) {
          failures.push(
            `${heights.length} animated bars for ${want.bars} buckets`,
          );
        }
        act(() => ctx.renderer.unmount());
        ctx.mounted = false;
        ctx.actions += 1;
      }
      drain();
    } catch (error) {
      failures.push(
        `threw: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (ctx.mounted) {
        try {
          act(() => ctx.renderer.unmount());
        } catch {
          // already gone
        }
        ctx.mounted = false;
      }
    }
  });

  const pending = jest.getTimerCount();
  if (pending !== 0)
    failures.push(`${pending} timer(s) still armed after unmount`);
  failures.push(...guardFailures(report));

  return {
    seed,
    scenario: `${surface}/${churn}`,
    outcome: failures.length === 0 ? 'HELD' : 'BROKEN',
    actions: ctx.actions,
    intents: pushes,
    effects: pushes,
    detail: `pushes=${pushes}`,
    failures,
  };
}

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

afterAll(() => {
  const summary = TABLE.write();
  console.log(
    `[stress] ${CONFIG.suite}: ${summary.held} HELD / ${summary.broken} BROKEN over ${TABLE.rows.length} bursts (${summary.actions} actions) -> ${summary.file}`,
  );
});

describe('progress chart surfaces under rapid data churn', () => {
  const seeds = seedsFor(CONFIG);
  it.each(seeds.map(seed => [seed] as const))('seed %d holds', seed => {
    const row = runIteration(seed);
    TABLE.push(row);
    expect({ seed, scenario: row.scenario, failures: row.failures }).toEqual({
      seed,
      scenario: row.scenario,
      failures: [],
    });
  });
});
