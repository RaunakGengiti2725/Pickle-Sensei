/**
 * Render pins for the Progress dashboard building blocks: the WHOOP-style
 * stat rows and trend bars must label real values, hide labels when the
 * window is too dense to read, and never fabricate a comparison.
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { StatDeltaRow } from '../src/progress/StatDeltaRow';
import { ScoreTrendChart } from '../src/progress/ScoreTrendChart';
import { PracticeVolumeChart } from '../src/progress/PracticeVolumeChart';
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

afterEach(() => {
  jest.useRealTimers();
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

  it('labels every scored bar in a short window and skips honest gaps', () => {
    const renderer = render(<ScoreTrendChart buckets={SEVEN_BUCKETS} />);
    const rendered = texts(renderer);
    expect(rendered).toContain('6.0');
    expect(rendered).toContain('7.5');
    // Bar labels round to one readable decimal.
    expect(rendered).toContain('8.1');
    // Three scored buckets → exactly three value labels + three axis labels.
    expect(rendered.filter(t => /^\d+\.\d$/.test(t))).toHaveLength(3);
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
      'Average technique score by day. 3 scored days, latest average 8.1 out of 10.',
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
    expect(texts(renderer).filter(t => /^\d+\.\d$/.test(t))).toHaveLength(0);
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
    expect(texts(renderer).filter(t => /^\d+\.\d$/.test(t))).toHaveLength(0);
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
    expect(texts(renderer)).toContain('12.0');
    expect(texts(renderer)).toContain('0.0');
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
