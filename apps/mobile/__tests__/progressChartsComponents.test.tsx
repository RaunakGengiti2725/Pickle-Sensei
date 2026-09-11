/**
 * Render pins for the Progress dashboard building blocks: the WHOOP-style
 * stat rows and trend bars must label real values, hide labels when the
 * window is too dense to read, and never fabricate a comparison.
 */
import React from 'react';
import { Dimensions, StyleSheet, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { StatDeltaRow } from '../src/progress/StatDeltaRow';
import { ScoreTrendChart } from '../src/progress/ScoreTrendChart';
import {
  compactPracticeBuckets,
  PracticeVolumeChart,
} from '../src/progress/PracticeVolumeChart';
import { color, type } from '../src/design/tokens';
import type { ScoreTrendBucket } from '../src/progress/techniqueDashboard';

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
    .filter((child): child is string | number => {
      return typeof child === 'string' || typeof child === 'number';
    })
    .map(String);
}

function hostByTestId(
  renderer: TestRenderer.ReactTestRenderer,
  testID: string,
) {
  const [node] = renderer.root.findAll(
    n => typeof n.type === 'string' && n.props.testID === testID,
  );
  return node ?? null;
}

function flat(node: TestRenderer.ReactTestInstance) {
  return (StyleSheet.flatten(node.props.style) ?? {}) as Record<
    string,
    unknown
  >;
}

function dataRows(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .filter(node => node.props.testID === 'chart-data-row');
}

function expectFlowingText(renderer: TestRenderer.ReactTestRenderer) {
  for (const node of renderer.root.findAllByType(Text)) {
    expect(node.props.allowFontScaling).not.toBe(false);
    expect(node.props.maxFontSizeMultiplier).toBeUndefined();
    expect(node.props.adjustsFontSizeToFit).not.toBe(true);
    expect(node.props.numberOfLines).toBeUndefined();
    expect(flat(node)['fontSize']).toBeGreaterThanOrEqual(type.micro.fontSize);
    expect(flat(node)['height']).toBeUndefined();
    expect(flat(node)['maxHeight']).toBeUndefined();
    expect(flat(node)['position']).not.toBe('absolute');
  }
  const views = renderer.root.findAll(node => String(node.type) === 'View');
  expect(
    views.some(
      node => node.props.importantForAccessibility === 'no-hide-descendants',
    ),
  ).toBe(false);
  expect(
    views.some(
      node =>
        node.props.accessible && node.props.accessibilityRole !== 'button',
    ),
  ).toBe(false);
  expect(views.some(node => flat(node)['height'] !== undefined)).toBe(false);
}

beforeEach(() => {
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    width: 393,
    height: 852,
    scale: 3,
    fontScale: 1,
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('StatDeltaRow', () => {
  it('renders value only — no triangle, no prior line — without history', () => {
    const renderer = render(
      <StatDeltaRow
        icon="camera"
        label="CAPTURES"
        value="3"
        previous={null}
        delta={null}
        testID="row"
      />,
    );
    expect(texts(renderer)).toEqual(['CAPTURES', '3']);
    expect(hostByTestId(renderer, 'row')!.props.accessibilityLabel).toBe(
      'CAPTURES: 3',
    );
    act(() => renderer.unmount());
  });

  it('announces an upward comparison and shows the prior value', () => {
    const renderer = render(
      <StatDeltaRow
        icon="spark"
        label="SCORED REPS"
        value="12"
        previous="8"
        delta={4}
        testID="row"
      />,
    );
    expect(texts(renderer)).toEqual(['SCORED REPS', '12', '8']);
    expect(hostByTestId(renderer, 'row')!.props.accessibilityLabel).toBe(
      'SCORED REPS: 12. Prior period 8, trending up',
    );
    act(() => renderer.unmount());
  });

  it('announces a downward comparison', () => {
    const renderer = render(
      <StatDeltaRow
        icon="progress"
        label="AVG SCORE"
        value="6.1"
        previous="6.4"
        delta={-0.3}
        testID="row"
      />,
    );
    expect(hostByTestId(renderer, 'row')!.props.accessibilityLabel).toBe(
      'AVG SCORE: 6.1. Prior period 6.4, trending down',
    );
    act(() => renderer.unmount());
  });

  it('treats a zero delta as flat: prior value shown, no trend claim', () => {
    const renderer = render(
      <StatDeltaRow
        icon="check"
        label="SCORED DAYS"
        value="4"
        previous="4"
        delta={0}
        testID="row"
      />,
    );
    expect(hostByTestId(renderer, 'row')!.props.accessibilityLabel).toBe(
      'SCORED DAYS: 4. Prior period 4',
    );
    expect(texts(renderer)).toEqual(['SCORED DAYS', '4', '4']);
    act(() => renderer.unmount());
  });
});

function bucket(
  key: string,
  label: string,
  avg: number | null,
  count: number,
): ScoreTrendBucket {
  return { key, label, avg, count };
}

const SEVEN_BUCKETS: ScoreTrendBucket[] = [
  bucket('d1:d1', 'Aug 25', null, 0),
  bucket('d2:d2', 'Aug 26', 6.0, 2),
  bucket('d3:d3', 'Aug 27', null, 0),
  bucket('d4:d4', 'Aug 28', 7.5, 1),
  bucket('d5:d5', 'Aug 29', null, 0),
  bucket('d6:d6', 'Aug 30', 8.05, 2),
  bucket('d7:d7', 'Aug 31', null, 0),
];

describe('ScoreTrendChart', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  it('uses the micro token and muted labels/history, reserving volt for the latest scored bar', () => {
    const renderer = render(<ScoreTrendChart buckets={SEVEN_BUCKETS} />);
    for (const text of renderer.root.findAllByType(Text)) {
      expect(flat(text)['fontSize']).toBe(type.micro.fontSize);
      expect(flat(text)['lineHeight']).toBe(type.micro.lineHeight);
      expect(flat(text)['fontFamily']).toBe(type.micro.fontFamily);
      expect([color.onDarkMuted, color.volt]).toContain(flat(text)['color']);
    }
    const views = renderer.root.findAll(node => String(node.type) === 'View');
    const bars = views.filter(node => flat(node)['minWidth'] === 3);
    expect(bars.map(node => flat(node)['backgroundColor'])).toEqual([
      color.lineMutedDark,
      color.onDarkMuted,
      color.lineMutedDark,
      color.onDarkMuted,
      color.lineMutedDark,
      color.volt,
      color.lineMutedDark,
    ]);
    expect(
      views.filter(
        node => flat(node)['backgroundColor'] === color.onDarkTintFaint,
      ),
    ).toHaveLength(1);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it.each([1.01, 1.118, 1.3, 2.64, 3.12])(
    'at %sx shows full grouped date ranges, original averages/counts and honest gaps in flowing rows',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 320, height: 568, scale: 2, fontScale });
      const buckets = Object.freeze([
        Object.freeze(bucket('2026-08-25:2026-08-26', 'Aug 25', 8.05, 2)),
        Object.freeze(bucket('2026-08-27:2026-08-28', 'Aug 27', null, 0)),
        Object.freeze(bucket('2026-08-29:2026-08-31', 'Aug 29', 0, 1)),
      ]);
      const renderer = render(<ScoreTrendChart buckets={buckets} />);
      // Rows speak the headline unit (estimated DUPR, D-046) and keep the
      // 0–10 average beside it; 8.05 → 4.03, 0 → 2.00.
      expect(dataRows(renderer).map(node => node.props.children)).toEqual([
        '2026-08-25–2026-08-26: Estimated DUPR 4.03, technique score 8.1 out of 10 · 2 scored reads',
        '2026-08-27–2026-08-28: No comparable scored reads',
        '2026-08-29–2026-08-31: Estimated DUPR 2.00, technique score 0.0 out of 10 · 1 scored read · Latest scored period',
      ]);
      expect(texts(renderer)).toContain(
        'Average estimated DUPR by period. 2 scored periods, latest average: Estimated DUPR 2.00, technique score 0.0 out of 10.',
      );
      expect(texts(renderer)).toContain('Showing periods 1–3 of 3.');
      expect(texts(renderer).join(' ')).toContain('grouped date range');
      expectFlowingText(renderer);
      act(() => {
        jest.runOnlyPendingTimers();
        renderer.unmount();
      });
    },
  );

  it('keeps a long large-text trend bounded, exposes earlier periods and resets for a changed window', () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 3.12 });
    const buckets = Object.freeze(
      Array.from({ length: 13 }, (_, index) =>
        Object.freeze(
          bucket(
            `d${index}:d${index}`,
            `Day ${index + 1}`,
            index === 0 ? null : index / 2,
            index,
          ),
        ),
      ),
    );
    const renderer = render(<ScoreTrendChart buckets={buckets} />);
    expect(dataRows(renderer)).toHaveLength(7);
    expect(texts(renderer)).toContain('Showing periods 7–13 of 13.');
    const earlier = renderer.root.findByProps({ testID: 'chart-data-earlier' });
    expect(earlier.props.accessibilityLabel).toBe('Earlier periods');
    expect(earlier.props.accessibilityState).toEqual({ disabled: false });
    expect(flat(earlier)['minHeight']).toBeGreaterThanOrEqual(44);
    act(() => earlier.props.onPress());
    expect(dataRows(renderer)).toHaveLength(6);
    expect(texts(renderer)).toContain('Showing periods 1–6 of 13.');
    expect(dataRows(renderer)[0]!.props.children).toBe(
      'Day 1: No comparable scored reads',
    );
    act(() =>
      renderer.update(
        <ScoreTrendChart buckets={[bucket('new:new', 'New day', 10, 1)]} />,
      ),
    );
    expect(texts(renderer)).toContain('Showing periods 1–1 of 1.');
    expect(dataRows(renderer)[0]!.props.children).toBe(
      'New day: Estimated DUPR 6.00, technique score 10.0 out of 10 · 1 scored read · Latest scored period',
    );
    expect(hostByTestId(renderer, 'chart-data-earlier')).toBeNull();
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('labels every scored bar in a short window and skips honest gaps', () => {
    const renderer = render(<ScoreTrendChart buckets={SEVEN_BUCKETS} />);
    const rendered = texts(renderer);
    // Bar labels are the estimated DUPR of each average, two decimals:
    // 6.0 → 2.92, 7.5 → 3.67, 8.05 → 4.03.
    expect(rendered).toContain('2.92');
    expect(rendered).toContain('3.67');
    expect(rendered).toContain('4.03');
    // Three scored buckets → exactly three value labels + three axis labels.
    expect(rendered.filter(t => /^\d+\.\d\d$/.test(t))).toHaveLength(3);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('summarizes the window for screen readers', () => {
    const renderer = render(<ScoreTrendChart buckets={SEVEN_BUCKETS} />);
    const [root] = renderer.root.findAll(
      n => typeof n.props.accessibilityLabel === 'string' && n.props.accessible,
    );
    expect(root!.props.accessibilityLabel).toBe(
      'Average estimated DUPR by day. 3 scored days, latest average: Estimated DUPR 4.03, technique score 8.1 out of 10.',
    );
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('drops per-bar labels once the window is too dense to read', () => {
    const dense = Array.from({ length: 10 }, (_, index) =>
      bucket(`k${index}:k${index}`, `Aug ${index + 1}`, 5 + index * 0.1, 1),
    );
    const renderer = render(<ScoreTrendChart buckets={dense} />);
    expect(texts(renderer).filter(t => /^\d+\.\d\d$/.test(t))).toHaveLength(0);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('stays honest when nothing in the window is scored', () => {
    const empty = SEVEN_BUCKETS.map(b => ({ ...b, avg: null, count: 0 }));
    const renderer = render(<ScoreTrendChart buckets={empty} />);
    const [root] = renderer.root.findAll(
      n => typeof n.props.accessibilityLabel === 'string' && n.props.accessible,
    );
    expect(root!.props.accessibilityLabel).toBe(
      'No comparable scored reads in this window yet.',
    );
    expect(texts(renderer).filter(t => /^\d+\.\d\d$/.test(t))).toHaveLength(0);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('renders out-of-range averages without crashing (defensive clamp)', () => {
    const renderer = render(
      <ScoreTrendChart
        buckets={[
          bucket('a:a', 'Aug 30', 12, 1),
          bucket('b:b', 'Aug 31', 0, 1),
        ]}
      />,
    );
    // The estimate clamps to the app's scale ends rather than inventing a
    // number past 6.00 or below 2.00.
    expect(texts(renderer)).toContain('6.00');
    expect(texts(renderer)).toContain('2.00');
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });
});

describe('PracticeVolumeChart value labels', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  function volumeBuckets(counts: number[]) {
    return counts.map((count, index) => ({
      key: `2026-08-${String(index + 1).padStart(2, '0')}`,
      label: `Aug ${index + 1}`,
      count,
    }));
  }

  it('preserves the 82pt Home plot with token-sized labels and a single latest accent', () => {
    const renderer = render(
      <PracticeVolumeChart
        buckets={volumeBuckets([0, 2, 0, 4, 1, 0, 3])}
        rangeLabel="7 days"
        activeDays={4}
      />,
    );
    const views = renderer.root.findAll(node => String(node.type) === 'View');
    const plot = views.find(
      node =>
        node.props.importantForAccessibility === 'no-hide-descendants' &&
        flat(node)['height'] !== undefined,
    )!;
    expect(flat(plot)['height']).toBe(82);
    for (const text of renderer.root.findAllByType(Text)) {
      expect(flat(text)['fontSize']).toBe(type.micro.fontSize);
      expect(flat(text)['lineHeight']).toBe(type.micro.lineHeight);
      expect(flat(text)['fontFamily']).toBe(type.micro.fontFamily);
      expect([color.onDarkMuted, color.volt]).toContain(flat(text)['color']);
    }
    expect(
      views
        .filter(node => flat(node)['minWidth'] === 3)
        .map(node => flat(node)['backgroundColor']),
    ).toEqual([
      color.lineMutedDark,
      color.onDarkMuted,
      color.lineMutedDark,
      color.onDarkMuted,
      color.onDarkMuted,
      color.lineMutedDark,
      color.volt,
    ]);
    expect(
      views.filter(
        node => flat(node)['backgroundColor'] === color.onDarkTintFaint,
      ),
    ).toHaveLength(1);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it.each([1.01, 1.118, 1.3, 2.64, 3.12])(
    'at %sx shows every daily count, including zero, without relabeling Home scored reads as captures',
    fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 320, height: 568, scale: 2, fontScale });
      const buckets = Object.freeze(
        volumeBuckets([0, 2, 0, 4, 1, 0, 3]).map(value => Object.freeze(value)),
      );
      const summary =
        'Seven day read volume: 10 scored reads across 4 scored days.';
      const renderer = render(
        <PracticeVolumeChart
          buckets={buckets}
          rangeLabel="Seven day"
          activeDays={4}
          accessibilityLabel={summary}
          testID="practice-volume-chart"
        />,
      );
      const root = hostByTestId(renderer, 'practice-volume-chart')!;
      expect(root.props.accessible).toBe(false);
      expect(root.props.importantForAccessibility).toBe('no');
      expect(root.props.accessibilityLabel).toBe(summary);
      expect(texts(renderer)).toContain(summary);
      expect(texts(renderer).join(' ')).not.toContain('capture');
      expect(dataRows(renderer).map(node => node.props.children)).toEqual([
        'Aug 1: 0',
        'Aug 2: 2',
        'Aug 3: 0',
        'Aug 4: 4',
        'Aug 5: 1',
        'Aug 6: 0',
        'Aug 7: 3 · Latest period',
      ]);
      expect(texts(renderer)).toContain('Showing periods 1–7 of 7.');
      expectFlowingText(renderer);
      act(() => {
        jest.runOnlyPendingTimers();
        renderer.unmount();
      });
    },
  );

  it('uses exactly the same compacted totals on bounded large-text pages for long windows', () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 3.12 });
    const buckets = Object.freeze(
      Array.from({ length: 365 }, (_, index) =>
        Object.freeze({
          key: `day-${index}`,
          label: `Day ${index + 1}`,
          count: index % 5,
        }),
      ),
    );
    const compacted = compactPracticeBuckets(buckets);
    const renderer = render(
      <PracticeVolumeChart
        buckets={buckets}
        rangeLabel="One year"
        activeDays={292}
      />,
    );
    const shown = dataRows(renderer).map(node => node.props.children as string);
    expect(shown).toHaveLength(7);
    expect(texts(renderer)).toContain('Showing periods 7–13 of 13.');
    expect(texts(renderer).join(' ')).toContain(
      'same totals as the chart bars',
    );
    act(() =>
      renderer.root
        .findByProps({ testID: 'chart-data-earlier' })
        .props.onPress(),
    );
    shown.unshift(
      ...dataRows(renderer).map(node => node.props.children as string),
    );
    expect(shown).toEqual(
      compacted.map(
        (value, index) =>
          `${value.firstLabel}–${value.lastLabel}: ${value.count}${index === compacted.length - 1 ? ' · Latest period' : ''}`,
      ),
    );
    expectFlowingText(renderer);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('keeps empty large-text windows explicit without fabricating rows', () => {
    jest
      .spyOn(Dimensions, 'get')
      .mockReturnValue({ width: 393, height: 852, scale: 3, fontScale: 3.12 });
    const renderer = render(
      <PracticeVolumeChart buckets={[]} rangeLabel="7 days" activeDays={0} />,
    );
    expect(dataRows(renderer)).toHaveLength(0);
    expect(texts(renderer)).toContain(
      '7 days capture volume: 0 verified captures across 0 active days.',
    );
    expect(texts(renderer)).toContain('No periods in this window.');
    expectFlowingText(renderer);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('shows per-bar counts for a 7-day window', () => {
    const renderer = render(
      <PracticeVolumeChart
        buckets={volumeBuckets([0, 2, 0, 4, 1, 0, 3])}
        rangeLabel="7 days"
        activeDays={4}
      />,
    );
    const rendered = texts(renderer);
    expect(rendered).toContain('2');
    expect(rendered).toContain('4');
    expect(rendered).toContain('3');
    // Zero-capture days stay unlabeled — a stub, not a fake zero.
    expect(rendered.filter(t => t === '0')).toHaveLength(0);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });

  it('hides counts on long windows where labels would collide', () => {
    const renderer = render(
      <PracticeVolumeChart
        buckets={volumeBuckets(Array.from({ length: 28 }, (_, i) => i % 3))}
        rangeLabel="4 weeks"
        activeDays={18}
      />,
    );
    // Only the three axis labels remain; no numeric bar labels.
    expect(texts(renderer).filter(t => /^\d+$/.test(t))).toHaveLength(0);
    act(() => {
      jest.runOnlyPendingTimers();
      renderer.unmount();
    });
  });
});
