/**
 * Score dot plot pins: one dot per comparable scored read at its exact score
 * in its own day column, same-day reads fanned out chronologically, the
 * newest read accented, direct value labels only while they can be read, an
 * honest empty state, and a screen-reader summary that says what the eye
 * sees. At default text size the plot height matches the volume bars so
 * Home's toggle never moves the card; enlarged text uses bounded data rows.
 */
import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { Polyline } from 'react-native-svg';
import {
  DOT_PLOT_HEIGHT,
  dotPlotGeometry,
  ScoreDotPlot,
  yForScore,
} from '../src/progress/ScoreDotPlot';
import { color, type } from '../src/design/tokens';
import { duprAccessibilityLabel } from '../src/progress/duprEstimate';
import type {
  ScoredReadPoint,
  ScoreTrendBucket,
} from '../src/progress/techniqueDashboard';

function bucket(day: string, label: string, count = 0): ScoreTrendBucket {
  return { key: `${day}:${day}`, label, avg: null, count };
}

const WEEK: ScoreTrendBucket[] = [
  bucket('2026-08-28', 'Aug 28'),
  bucket('2026-08-29', 'Aug 29'),
  bucket('2026-08-30', 'Aug 30'),
  bucket('2026-08-31', 'Aug 31'),
  bucket('2026-09-01', 'Sep 1'),
  bucket('2026-09-02', 'Sep 2'),
  bucket('2026-09-03', 'Sep 3'),
];

function read(
  id: string,
  day: string,
  score: number,
  hour = 12,
): ScoredReadPoint {
  return {
    id,
    shotType: 'forehand_drive',
    capturedAtMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00Z`),
    day,
    score,
  };
}

function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

function texts(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter(
      (child): child is string | number =>
        typeof child === 'string' || typeof child === 'number',
    )
    .map(String);
}

function hostViews(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(n => String(n.type) === 'View');
}

function flat(node: TestRenderer.ReactTestInstance) {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<
    string,
    unknown
  >;
}

/** Dots are the absolutely positioned neutral/volt discs. */
function dots(renderer: TestRenderer.ReactTestRenderer) {
  return hostViews(renderer).filter(node => {
    const style = flat(node);
    return (
      style['position'] === 'absolute' &&
      (style['backgroundColor'] === color.onDarkMuted ||
        style['backgroundColor'] === color.volt)
    );
  });
}

function summary(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    n => String(n.type) === 'View' && n.props.testID === 'score-dot-plot',
  )[0]!.props.accessibilityLabel as string;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    width: 393,
    height: 852,
    scale: 3,
    fontScale: 1,
  });
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('yForScore', () => {
  it('maps 10 to the top gridline and 0 to the baseline, linearly between', () => {
    const top = yForScore(10);
    const bottom = yForScore(0);
    expect(top).toBe(16);
    expect(bottom).toBe(74);
    expect(yForScore(5)).toBe(45);
    expect(top).toBeLessThan(bottom);
    expect(bottom).toBeLessThanOrEqual(DOT_PLOT_HEIGHT);
    expect(yForScore(5)).toBeCloseTo((top + bottom) / 2);
    // Out-of-range input is clamped, never drawn outside the band.
    expect(yForScore(12)).toBe(top);
    expect(yForScore(-1)).toBe(bottom);
  });
});

describe('dotPlotGeometry', () => {
  it('places each read in its day column at its score and marks the newest', () => {
    const points = dotPlotGeometry(WEEK, [
      read('a', '2026-08-29', 5.5),
      read('b', '2026-09-03', 3.7),
    ]);
    expect(points).toHaveLength(2);
    const [a, b] = points;
    // Seven columns: centers at 1.5/7 and 6.5/7 of the width.
    expect(a!.xPct).toBeCloseTo((1.5 / 7) * 100);
    expect(b!.xPct).toBeCloseTo((6.5 / 7) * 100);
    expect(a!.y).toBeCloseTo(yForScore(5.5));
    expect(b!.y).toBeCloseTo(yForScore(3.7));
    expect(a!.isLatest).toBe(false);
    expect(b!.isLatest).toBe(true);
    expect(a!.labelSide).toBe('above');
  });

  it('fans same-day reads out left→right in time order so no dot hides another', () => {
    const points = dotPlotGeometry(WEEK, [
      read('early', '2026-09-01', 6.0, 9),
      read('mid', '2026-09-01', 6.0, 12),
      read('late', '2026-09-01', 6.0, 18),
    ]);
    expect(points.map(point => point.id)).toEqual(['early', 'mid', 'late']);
    const xs = points.map(point => point.xPct);
    expect(new Set(xs).size).toBe(3);
    expect(xs[0]!).toBeLessThan(xs[1]!);
    expect(xs[1]!).toBeLessThan(xs[2]!);
    // The fan stays inside its own column.
    const columnStart = (4 / 7) * 100;
    const columnEnd = (5 / 7) * 100;
    expect(xs[0]!).toBeGreaterThan(columnStart);
    expect(xs[2]!).toBeLessThan(columnEnd);
    // Identical scores share one y — the spread is horizontal only.
    expect(new Set(points.map(point => point.y)).size).toBe(1);
  });

  it('drops a read whose day matches no column instead of parking it somewhere plausible', () => {
    const points = dotPlotGeometry(WEEK, [
      read('outside', '2026-08-20', 7),
      read('inside', '2026-08-30', 7),
    ]);
    expect(points.map(point => point.id)).toEqual(['inside']);
  });

  it('keeps value labels inside the plot: top-edge dots label below, baseline dots above', () => {
    const [top, mid, floor] = dotPlotGeometry(WEEK, [
      read('top', '2026-08-28', 10),
      read('mid', '2026-08-29', 5),
      read('floor', '2026-08-30', 0.3),
    ]);
    expect(top!.labelSide).toBe('below');
    expect(mid!.labelSide).toBe('above');
    expect(floor!.labelSide).toBe('above');
  });

  it('alternates label sides inside a same-day fan so neighbouring labels never overprint', () => {
    const points = dotPlotGeometry(WEEK, [
      read('a', '2026-09-01', 6.0, 9),
      read('b', '2026-09-01', 6.4, 12),
      read('c', '2026-09-01', 6.2, 18),
    ]);
    expect(points.map(point => point.labelSide)).toEqual([
      'above',
      'below',
      'above',
    ]);
  });

  it('handles multi-day columns keyed first:last', () => {
    const points = dotPlotGeometry(
      [
        { key: '2026-08-01:2026-08-03', label: 'Aug 1', avg: null, count: 0 },
        { key: '2026-08-04:2026-08-06', label: 'Aug 4', avg: null, count: 0 },
      ],
      [read('x', '2026-08-05', 6)],
    );
    expect(points).toHaveLength(1);
    expect(points[0]!.xPct).toBeCloseTo(75);
  });

  it('returns nothing for an empty window or no reads', () => {
    expect(dotPlotGeometry([], [read('a', '2026-08-30', 7)])).toEqual([]);
    expect(dotPlotGeometry(WEEK, [])).toEqual([]);
  });
});

describe('ScoreDotPlot', () => {
  it('keeps the 82pt plot, token-sized labels, neutral history and a crisp latest outline', () => {
    const renderer = render(
      <ScoreDotPlot
        buckets={WEEK}
        reads={[read('first', '2026-08-28', 10), read('last', '2026-09-03', 0)]}
        rangeLabel="Seven day"
      />,
    );
    const plot = hostViews(renderer).find(node => node.props.onLayout)!;
    expect(flat(plot)['height']).toBe(82);
    expect(DOT_PLOT_HEIGHT).toBe(82);
    for (const text of renderer.root.findAllByType(Text)) {
      expect(flat(text)['fontSize']).toBe(type.micro.fontSize);
      expect(flat(text)['lineHeight']).toBe(type.micro.lineHeight);
      expect(flat(text)['fontFamily']).toBe(type.micro.fontFamily);
      expect([color.onDarkMuted, color.volt]).toContain(flat(text)['color']);
    }
    expect(dots(renderer).map(node => flat(node)['backgroundColor'])).toEqual([
      color.onDarkMuted,
      color.volt,
    ]);
    const outlines = hostViews(renderer).filter(
      node => flat(node)['borderColor'] === color.volt,
    );
    expect(outlines).toHaveLength(1);
    expect(flat(outlines[0]!)['borderWidth']).toBeGreaterThan(0);
    expect(flat(outlines[0]!)['backgroundColor'] ?? 'transparent').toBe(
      'transparent',
    );
    expect(
      hostViews(renderer).some(
        node => flat(node)['backgroundColor'] === 'rgba(215,250,69,0.22)',
      ),
    ).toBe(false);
    expect(
      hostViews(renderer).filter(
        node => flat(node)['backgroundColor'] === color.onDarkTintFaint,
      ),
    ).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it.each([1.01, 1.118, 1.3, 2.64, 3.12])(
    'at %sx presents every score in flowing uncapped rows instead of fixed-position labels',
    fontScale => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width: 320,
        height: 568,
        scale: 2,
        fontScale,
      });
      const reads = Object.freeze([
        Object.freeze(read('first', '2026-08-28', 10)),
        Object.freeze(read('last', '2026-09-03', 0)),
      ]);
      const renderer = render(
        <ScoreDotPlot buckets={WEEK} reads={reads} rangeLabel="Seven day" />,
      );
      const root = hostViews(renderer).find(
        node => node.props.testID === 'score-dot-plot',
      )!;
      expect(root.props.accessible).toBe(false);
      expect(root.props.importantForAccessibility).toBe('no');
      expect(root.props.accessibilityLabel).toBe(
        'Seven day estimated DUPR: 2 scored reads across 2 days, latest Estimated DUPR 2.00, technique score 0.0 out of 10.',
      );
      expect(dots(renderer)).toHaveLength(0);
      expect(renderer.root.findAllByType(Polyline)).toHaveLength(0);
      const rows = renderer.root
        .findAllByType(Text)
        .filter(node => node.props.testID === 'chart-data-row');
      expect(rows.map(node => node.props.children)).toEqual([
        '2026-08-28 · Read 1: Estimated DUPR 6.00, technique score 10.0 out of 10',
        '2026-09-03 · Read 2: Estimated DUPR 2.00, technique score 0.0 out of 10 · Latest read',
      ]);
      expect(texts(renderer)).toContain('Showing reads 1–2 of 2.');
      expect(texts(renderer).join(' ')).toContain('Aug 28–Sep 3');
      for (const node of renderer.root.findAllByType(Text)) {
        expect(node.props.allowFontScaling).not.toBe(false);
        expect(node.props.maxFontSizeMultiplier).toBeUndefined();
        expect(node.props.adjustsFontSizeToFit).not.toBe(true);
        expect(node.props.numberOfLines).toBeUndefined();
        expect(flat(node)['fontSize']).toBeGreaterThanOrEqual(
          type.micro.fontSize,
        );
        expect(flat(node)['height']).toBeUndefined();
        expect(flat(node)['maxHeight']).toBeUndefined();
        expect(flat(node)['position']).not.toBe('absolute');
      }
      expect(
        hostViews(renderer).some(
          node =>
            node.props.importantForAccessibility === 'no-hide-descendants',
        ),
      ).toBe(false);
      act(() => renderer.unmount());
    },
  );

  it('bounds a dense large-text page while keeping every individual read reachable', () => {
    jest.spyOn(Dimensions, 'get').mockReturnValue({
      width: 393,
      height: 852,
      scale: 3,
      fontScale: 3.12,
    });
    const reads = Object.freeze(
      Array.from({ length: 1001 }, (_, index) =>
        Object.freeze(read(`read-${index}`, '2026-09-03', (index % 101) / 10)),
      ),
    );
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={reads} rangeLabel="Seven day" />,
    );
    const pageRows = () =>
      renderer.root
        .findAllByType(Text)
        .filter(node => node.props.testID === 'chart-data-row');
    const earlier = () =>
      renderer.root.findByProps({ testID: 'chart-data-earlier' });
    const later = () =>
      renderer.root.findByProps({ testID: 'chart-data-later' });
    expect(pageRows()).toHaveLength(7);
    expect(texts(renderer)).toContain('Showing reads 995–1001 of 1001.');
    expect(later().props.accessibilityState).toEqual({ disabled: true });
    expect(earlier().props.accessibilityRole).toBe('button');
    expect(flat(earlier())['minHeight']).toBeGreaterThanOrEqual(44);
    const shown = new Set<string>();
    for (let page = 0; page < Math.ceil(reads.length / 7); page += 1) {
      expect(pageRows().length).toBeLessThanOrEqual(7);
      for (const row of pageRows()) shown.add(row.props.children as string);
      if (!earlier().props.accessibilityState.disabled) {
        act(() => earlier().props.onPress());
      }
    }
    expect(shown.size).toBe(reads.length);
    reads.forEach((point, index) => {
      expect(shown).toContain(
        `${point.day} · Read ${index + 1}: ${duprAccessibilityLabel(point.score)}${index === reads.length - 1 ? ' · Latest read' : ''}`,
      );
    });
    expect(earlier().props.accessibilityState).toEqual({ disabled: true });
    act(() => later().props.onPress());
    expect(texts(renderer)).toContain('Showing reads 8–14 of 1001.');
    act(() =>
      renderer.update(
        <ScoreDotPlot
          buckets={WEEK}
          reads={reads.slice(0, 1)}
          rangeLabel="Seven day"
        />,
      ),
    );
    expect(texts(renderer)).toContain('Showing reads 1–1 of 1.');
    expect(pageRows()).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('reacts to live text-size changes and restores the same compact plot', () => {
    const reads = Object.freeze([
      Object.freeze(read('first', '2026-08-28', 10)),
      Object.freeze(read('last', '2026-09-03', 0)),
    ]);
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={reads} rangeLabel="Seven day" />,
    );
    for (const fontScale of [3.12, 1.3, 1]) {
      const window = { width: 393, height: 852, scale: 3, fontScale };
      jest.spyOn(Dimensions, 'get').mockReturnValue(window);
      act(() => Dimensions.set({ window, screen: window }));
      const rows = renderer.root
        .findAllByType(Text)
        .filter(node => node.props.testID === 'chart-data-row');
      expect(rows).toHaveLength(fontScale > 1 ? 2 : 0);
      expect(dots(renderer)).toHaveLength(fontScale > 1 ? 0 : 2);
    }
    const plot = hostViews(renderer).find(node => node.props.onLayout)!;
    expect(flat(plot)['height']).toBe(82);
    expect(dots(renderer).map(node => flat(node)['top'])).toEqual([
      16 - 4.5,
      74 - 5.5,
    ]);
    expect(reads.map(point => point.score)).toEqual([10, 0]);
    act(() => renderer.unmount());
  });

  it('keeps an empty enlarged window explicit without inventing scores', () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 3.12 });
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={[]} rangeLabel="Seven day" />,
    );
    expect(texts(renderer)).toContain('No scored reads in this window yet.');
    expect(texts(renderer)).toContain('No reads in this window.');
    expect(texts(renderer).join(' ')).toContain('Aug 28–Sep 3');
    expect(
      renderer.root
        .findAllByType(Text)
        .filter(node => node.props.testID === 'chart-data-row'),
    ).toHaveLength(0);
    expect(texts(renderer).join(' ')).not.toContain('0.0');
    act(() => renderer.unmount());
  });

  it('draws one dot per read, labels each value, and accents the newest', () => {
    const reads = [
      read('a', '2026-08-29', 5.5),
      read('b', '2026-08-31', 6.2),
      read('c', '2026-09-03', 3.7),
    ];
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={reads} rangeLabel="Seven day" />,
    );
    const drawn = dots(renderer);
    expect(drawn).toHaveLength(3);
    expect(
      drawn.filter(node => flat(node)['backgroundColor'] === color.volt),
    ).toHaveLength(1);
    const rendered = texts(renderer);
    // Value labels are each read's estimated DUPR (5.5 → 2.85, 6.2 → 2.95,
    // 3.7 → 2.57); the gridlines mark the Advanced (4.00) and Intermediate
    // (3.00) bands.
    expect(rendered).toEqual(
      expect.arrayContaining([
        '2.85',
        '2.95',
        '2.57',
        '4.00',
        '3.00',
        'Aug 28',
        'Sep 3',
      ]),
    );
    // The latest value label wears the accent.
    const latestLabel = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === '2.57')!;
    expect(flat(latestLabel)['color']).toBe(color.volt);
    expect(summary(renderer)).toBe(
      'Seven day estimated DUPR: 3 scored reads across 3 days, latest Estimated DUPR 2.57, technique score 3.7 out of 10.',
    );
    act(() => renderer.unmount());
  });

  it('keeps the dots but drops the value labels once they would collide', () => {
    const reads = Array.from({ length: 9 }, (_, index) =>
      read(`r${index}`, WEEK[index % 7]!.key.slice(0, 10), 4 + index * 0.5),
    );
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={reads} rangeLabel="Seven day" />,
    );
    expect(dots(renderer)).toHaveLength(9);
    expect(texts(renderer).filter(t => /^\d+\.\d$/.test(t))).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('traces the reads in time order once the plot knows its width', () => {
    const reads = [read('a', '2026-08-28', 4), read('b', '2026-09-03', 8)];
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={reads} rangeLabel="Seven day" />,
    );
    expect(renderer.root.findAllByType(Polyline)).toHaveLength(0);
    const plot = hostViews(renderer).find(
      node => typeof node.props.onLayout === 'function',
    )!;
    act(() => {
      plot.props.onLayout({ nativeEvent: { layout: { width: 280 } } });
    });
    const [line] = renderer.root.findAllByType(Polyline);
    expect(line!.props.stroke).toBe(color.onDarkMuted);
    // Coordinates are rounded to 2dp: no float noise in the path data.
    expect(line!.props.points).toBe(
      `20,${yForScore(4)} 260,${Math.round(yForScore(8) * 100) / 100}`,
    );
    act(() => renderer.unmount());
  });

  it('stays honest with no reads: empty columns, no labels, a plain summary', () => {
    const renderer = render(
      <ScoreDotPlot buckets={WEEK} reads={[]} rangeLabel="Seven day" />,
    );
    expect(dots(renderer)).toHaveLength(0);
    expect(texts(renderer).filter(t => /^\d+\.\d$/.test(t))).toHaveLength(0);
    expect(summary(renderer)).toBe('No scored reads in this window yet.');
    // Axis still names the window so the empty plot reads as "this week".
    expect(texts(renderer)).toEqual(
      expect.arrayContaining(['Aug 28', 'Aug 31', 'Sep 3']),
    );
    act(() => renderer.unmount());
  });

  it('uses the singular for a single read on a single day', () => {
    const renderer = render(
      <ScoreDotPlot
        buckets={WEEK}
        reads={[read('only', '2026-09-03', 3.7)]}
        rangeLabel="Seven day"
      />,
    );
    expect(summary(renderer)).toBe(
      'Seven day estimated DUPR: 1 scored read across 1 day, latest Estimated DUPR 2.57, technique score 3.7 out of 10.',
    );
    act(() => renderer.unmount());
  });
});
