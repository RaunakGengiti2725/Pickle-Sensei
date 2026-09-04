/**
 * Structural audit #2: the ReplayCard fallback playhead (no native player)
 * runs on a setInterval whose callback closes over the `base` window that
 * was current when Play was pressed. If the clip prop changes while playing,
 * the ticking interval keeps driving the playhead against the OLD end bound.
 *
 * Reachability note: ResultScreen swaps attempts with `navigation.replace`,
 * which remounts the surface; this probe exercises the component contract
 * directly (same instance, new clip prop mid-play).
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { StrokeResult } from '../../src/components/StrokeResult';

function textOf(root: TestRenderer.ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .map(node => React.Children.toArray(node.props.children).join(''))
    .join('\n');
}

function clockSeconds(root: TestRenderer.ReactTestRenderer): number {
  const match = /(\d+\.\d\d)s/.exec(textOf(root));
  if (!match) throw new Error('replay clock not rendered');
  return Number(match[1]);
}

function surface(durationMs: number) {
  return (
    <StrokeResult
      analysis={null}
      record={null}
      clip={{ uri: 'file:///clip.mov', durationMs }}
      currentAnalysisId="analysis-1"
      onTryAgain={() => {}}
      onDone={() => {}}
    />
  );
}

describe('ReplayCard fallback playback across a clip prop change', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('stops at the CURRENT clip end when the clip shrinks mid-play', () => {
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(surface(4000));
    });
    const play = root.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Play replay' &&
        typeof node.props.onClick === 'function',
    );
    act(() => {
      play.props.onClick({ nativeEvent: {} });
    });
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(clockSeconds(root)).toBeCloseTo(1, 1);

    act(() => {
      root.update(surface(1000));
    });
    act(() => {
      jest.advanceTimersByTime(2000);
    });

    // The replay must never report a position beyond the clip it now shows.
    expect(clockSeconds(root)).toBeLessThanOrEqual(1.0);
    const pauseButtons = root.root.findAll(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Pause replay',
    );
    expect(pauseButtons).toHaveLength(0);

    act(() => root.unmount());
  });

  it('runs to the end and stops for an unchanged clip (verified invariant)', () => {
    let root!: TestRenderer.ReactTestRenderer;
    act(() => {
      root = TestRenderer.create(surface(1000));
    });
    const play = root.root.find(
      node =>
        typeof node.type === 'string' &&
        node.props.accessibilityLabel === 'Play replay' &&
        typeof node.props.onClick === 'function',
    );
    act(() => {
      play.props.onClick({ nativeEvent: {} });
    });
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(clockSeconds(root)).toBeCloseTo(1, 2);
    expect(
      root.root.findAll(
        node =>
          typeof node.type === 'string' &&
          node.props.accessibilityLabel === 'Play replay',
      ),
    ).toHaveLength(1);
    act(() => root.unmount());
  });
});
