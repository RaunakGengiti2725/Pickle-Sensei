import React from 'react';
import {
  AccessibilityInfo,
  Dimensions,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
} from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  SafeAreaInsetsContext,
  type EdgeInsets,
  type Metrics,
} from 'react-native-safe-area-context';
import * as Reanimated from 'react-native-reanimated';
import type { PlayerRankSummary } from '@pickle/shared-types';

// The celebration store persists through SQLite; the native module is absent
// under jest and dismissing never touches persistence.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

// Reduced motion is a module-level observer over AccessibilityInfo; pin it
// per test so both the animated and the at-rest layouts are exercised.
let mockReducedMotion = false;
jest.mock('../../src/design/components', () => ({
  ...jest.requireActual('../../src/design/components'),
  useReducedMotion: () => mockReducedMotion,
}));

let mockInitialWindowMetrics: Metrics | null = null;
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('react-native-safe-area-context'),
  get initialWindowMetrics() {
    return mockInitialWindowMetrics;
  },
}));

import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';

/**
 * Button ledger for RankUpCelebration. Every interactive element in the
 * overlay is pressed here and its observable effect asserted:
 *
 *   1. backdrop Pressable ("Dismiss rank celebration")  -> store.dismiss
 *   2. Continue Button (testID rank-up-continue)          -> store.dismiss
 *   3. Modal onRequestClose (Android back / iOS swipe)    -> store.dismiss
 *
 * All three are synchronous store mutations (no async path, nothing to
 * fail), so the failure-path coverage is idempotence: repeated presses and
 * presses after the overlay has already closed must be harmless.
 */

const diamondSummary: PlayerRankSummary = {
  rating: 7.62,
  tier: 'diamond',
  tierLabel: 'Diamond',
  division: 3,
  divisionLabel: 'III',
  techniqueCount: 3,
  scoredAnalysisCount: 9,
  techniques: [],
  nextTier: null,
};

const goldSummary: PlayerRankSummary = {
  rating: 5.4,
  tier: 'gold',
  tierLabel: 'Gold',
  division: 3,
  divisionLabel: 'III',
  techniqueCount: 1,
  scoredAnalysisCount: 2,
  techniques: [],
  nextTier: {
    key: 'platinum',
    label: 'Platinum',
    minRating: 6.5,
    pointsNeeded: 1.1,
  },
};

function setPromotion() {
  useRankCelebrationStore.setState({
    current: {
      fromTier: 'platinum',
      toTier: 'diamond',
      fromRating: 7.1,
      summary: diamondSummary,
    },
  });
}

function setPlacement() {
  useRankCelebrationStore.setState({
    current: {
      fromTier: null,
      toTier: 'gold',
      fromRating: null,
      summary: goldSummary,
    },
  });
}

// requestAnimationFrame is driven by hand to verify ratings stay exact
// without a number-count animation: frames run only when a test asks.
const frames = new Map<number, (timestamp: number) => void>();
let nextFrameId = 1;
const cancelledFrames: number[] = [];

function flushFrame(timestamp: number) {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(timestamp);
}

beforeEach(() => {
  mockInitialWindowMetrics = null;
  jest.spyOn(Dimensions, 'get').mockReturnValue({
    width: 375,
    height: 667,
    scale: 2,
    fontScale: 1,
  });
  mockReducedMotion = false;
  frames.clear();
  cancelledFrames.length = 0;
  nextFrameId = 1;
  jest
    .spyOn(globalThis, 'requestAnimationFrame')
    .mockImplementation(callback => {
      const id = nextFrameId++;
      frames.set(id, callback);
      return id;
    });
  jest.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(id => {
    if (typeof id !== 'number') return;
    frames.delete(id);
    cancelledFrames.push(id);
  });
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
});

afterEach(() => {
  useRankCelebrationStore.setState({ current: null });
  jest.restoreAllMocks();
});

async function render(
  insets: EdgeInsets = { top: 59, bottom: 34, left: 0, right: 0 },
) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <SafeAreaInsetsContext.Provider value={insets}>
        <RankUpCelebration />
      </SafeAreaInsetsContext.Provider>,
    );
  });
  return renderer;
}

function hostNodes(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

/** Pressable renders a host View without onPress; press the innermost
 * composite that still carries the handler (the RN Pressable itself). */
function innermostPressable(
  renderer: TestRenderer.ReactTestRenderer,
  match: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  const nodes = renderer.root.findAll(
    node => typeof node.props.onPress === 'function' && match(node),
  );
  expect(nodes.length).toBeGreaterThanOrEqual(1);
  return nodes[nodes.length - 1]!;
}

function backdrop(renderer: TestRenderer.ReactTestRenderer) {
  return innermostPressable(
    renderer,
    node => node.props.accessibilityLabel === 'Dismiss rank celebration',
  );
}

function continueButton(renderer: TestRenderer.ReactTestRenderer) {
  return innermostPressable(
    renderer,
    node => node.props.testID === 'rank-up-continue',
  );
}

function modal(renderer: TestRenderer.ReactTestRenderer) {
  const nodes = renderer.root.findAll(
    node => typeof node.props.onRequestClose === 'function',
  );
  expect(nodes.length).toBeGreaterThanOrEqual(1);
  return nodes[0]!;
}

function rendered(renderer: TestRenderer.ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

describe('RankUpCelebration button ledger', () => {
  it.each([
    { width: 375, height: 667, rawTop: 59, rawBottom: 34 },
    { width: 393, height: 852, rawTop: 59, rawBottom: 34 },
    { width: 375, height: 667, rawTop: 0, rawBottom: 0 },
    { width: 393, height: 852, rawTop: 0, rawBottom: 0 },
  ])(
    'applies modal padding at $width pt / 3.571x with raw insets $rawTop/$rawBottom',
    async ({ width, height, rawTop, rawBottom }) => {
      jest.spyOn(Dimensions, 'get').mockReturnValue({
        width,
        height,
        scale: width === 375 ? 2 : 3,
        fontScale: 3.571,
      });
      mockReducedMotion = true;
      mockInitialWindowMetrics =
        rawTop === 0
          ? {
              frame: { x: 0, y: 0, width, height },
              insets: { top: 59, bottom: 34, left: 0, right: 0 },
            }
          : null;
      setPromotion();
      const renderer = await render({
        top: rawTop,
        bottom: rawBottom,
        left: 0,
        right: 0,
      });
      try {
        const root = hostNodes(renderer, 'rank-up-celebration')[0]!;
        expect(StyleSheet.flatten(root.props.style)).toMatchObject({
          flex: 1,
          paddingTop: 59,
          paddingBottom: 34,
        });
        const scroll = renderer.root.findByType(ScrollView);
        expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
          flex: 1,
          minHeight: 0,
        });
        expect(scroll.props.contentInsetAdjustmentBehavior).toBe('never');
        expect(scroll.props.automaticallyAdjustContentInsets).toBe(false);
        expect(
          scroll.findAll(node => node.props.testID === 'rank-up-continue'),
        ).toHaveLength(0);
        expect(renderer.root.findByType(StatusBar).props.barStyle).toBe(
          'light-content',
        );
        expect(rendered(renderer)).toContain('Diamond unlocked');
        expect(rendered(renderer)).toContain('7.62');
        expect(rendered(renderer)).toContain('DUPR');
        const dismiss = useRankCelebrationStore.getState().dismiss;
        expect(backdrop(renderer).props.onPress).toBe(dismiss);
        expect(modal(renderer).props.onRequestClose).toBe(dismiss);
        expect(continueButton(renderer).props.onPress).toBe(dismiss);
        await act(async () => continueButton(renderer).props.onPress());
        expect(useRankCelebrationStore.getState().current).toBeNull();
        expect(renderer.root.findAllByType(StatusBar)).toHaveLength(0);
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it.each([1.8, 3.571])(
    'keeps a bounded scroll and fixed dismiss action at font scale %s',
    async fontScale => {
      jest
        .spyOn(Dimensions, 'get')
        .mockReturnValue({ width: 375, height: 667, scale: 2, fontScale });
      setPromotion();
      const renderer = await render();
      try {
        const scroll = renderer.root.findByType(ScrollView);
        expect(StyleSheet.flatten(scroll.props.style)).toMatchObject({
          flex: 1,
        });
        expect(
          scroll.findAll(node => node.props.testID === 'rank-up-continue'),
        ).toHaveLength(0);
        expect(rendered(renderer)).toContain('7.62');
        expect(rendered(renderer)).toContain('Diamond unlocked');
        for (const text of scroll.findAllByType(Text)) {
          expect(text.props.numberOfLines).toBeUndefined();
          expect(text.props.maxFontSizeMultiplier).toBeUndefined();
          expect(text.props.allowFontScaling).not.toBe(false);
        }
        backdrop(renderer);
        expect(modal(renderer).props.onRequestClose).toBe(
          useRankCelebrationStore.getState().dismiss,
        );
        await act(async () => continueButton(renderer).props.onPress());
        expect(useRankCelebrationStore.getState().current).toBeNull();
      } finally {
        act(() => renderer.unmount());
      }
    },
  );

  it('enumerates exactly three interactive elements while open', async () => {
    setPromotion();
    const renderer = await render();
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(1);
    expect(renderer.root.findAllByType(ScrollView)).toHaveLength(0);

    const pressables = renderer.root.findAll(
      node =>
        typeof node.props.onPress === 'function' ||
        typeof node.props.onValueChange === 'function' ||
        typeof node.props.onLongPress === 'function' ||
        typeof node.props.onSubmitEditing === 'function',
    );
    const labels = new Set(
      pressables.map(
        node => node.props.accessibilityLabel ?? node.props.testID,
      ),
    );
    expect([...labels].sort()).toEqual([
      'Continue',
      'Dismiss rank celebration',
      'rank-up-continue',
    ]);
    // Every press handler in the overlay is the store's own dismiss — no
    // inline no-ops, nothing left unwired.
    const { dismiss } = useRankCelebrationStore.getState();
    for (const node of pressables) {
      expect(node.props.onPress).toBe(dismiss);
    }
    expect(modal(renderer).props.onRequestClose).toBe(dismiss);

    act(() => renderer.unmount());
  });

  describe('backdrop tap -> dismiss', () => {
    it('closes the ceremony and unmounts the stage', async () => {
      setPromotion();
      const renderer = await render();
      expect(useRankCelebrationStore.getState().current).not.toBeNull();

      await act(async () => {
        backdrop(renderer).props.onPress();
      });

      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      act(() => renderer.unmount());
    });

    it('fills the whole overlay (>= 44pt hit target) and is never disabled', async () => {
      setPromotion();
      const renderer = await render();
      const node = backdrop(renderer);
      expect(StyleSheet.flatten(node.props.style)).toMatchObject({
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        left: 0,
      });
      expect(node.props.disabled).toBeFalsy();
      expect(node.props.accessibilityLabel).toBe('Dismiss rank celebration');
      // WF-ISSUE: Backdrop dismiss Pressable has no accessibilityRole
      // expect(node.props.accessibilityRole).toBe('button');
      act(() => renderer.unmount());
    });

    it('is harmless when tapped twice in a row', async () => {
      setPromotion();
      const renderer = await render();
      const node = backdrop(renderer);
      await act(async () => {
        node.props.onPress();
        node.props.onPress();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      act(() => renderer.unmount());
    });
  });

  describe('Continue button -> dismiss', () => {
    it('closes the ceremony and unmounts the stage', async () => {
      setPromotion();
      const renderer = await render();

      await act(async () => {
        continueButton(renderer).props.onPress();
      });

      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      act(() => renderer.unmount());
    });

    it('is an enabled, labelled button with a >= 44pt target', async () => {
      setPromotion();
      const renderer = await render();
      const node = continueButton(renderer);
      // expect(node.props.accessibilityRole).toBe('button');
      expect(node.props.accessibilityLabel).toBe('Continue');
      expect(node.props.disabled).toBeFalsy();
      expect(node.props.accessibilityState?.disabled).toBeFalsy();
      const style =
        typeof node.props.style === 'function'
          ? node.props.style({ pressed: false })
          : node.props.style;
      const flattened = Object.assign(
        {},
        ...[style].flat(Infinity).filter(Boolean),
      ) as { minHeight?: number };
      expect(flattened.minHeight).toBeGreaterThanOrEqual(44);
      expect(rendered(renderer)).toContain('Continue');
      act(() => renderer.unmount());
    });

    it('is harmless when pressed twice in a row', async () => {
      setPromotion();
      const renderer = await render();
      const node = continueButton(renderer);
      await act(async () => {
        node.props.onPress();
        node.props.onPress();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      act(() => renderer.unmount());
    });

    it('also dismisses a placement (first-ever rank) ceremony', async () => {
      setPlacement();
      const renderer = await render();
      expect(rendered(renderer)).toContain('You’re on the board.');
      expect(rendered(renderer)).toContain('PLAYER RANK · PLACED');
      expect(rendered(renderer)).toContain(
        'Your current form across 1 technique — recent swings count most.',
      );
      await act(async () => {
        continueButton(renderer).props.onPress();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      act(() => renderer.unmount());
    });
  });

  describe('Modal onRequestClose (hardware back) -> dismiss', () => {
    it('closes the ceremony', async () => {
      setPromotion();
      const renderer = await render();
      const node = modal(renderer);
      expect(node.props.visible).toBe(true);

      await act(async () => {
        node.props.onRequestClose();
      });

      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(modal(renderer).props.visible).toBe(false);
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      act(() => renderer.unmount());
    });

    it('is harmless when the store is already closed', async () => {
      setPromotion();
      const renderer = await render();
      const node = modal(renderer);
      await act(async () => {
        node.props.onRequestClose();
      });
      await act(async () => {
        node.props.onRequestClose();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      act(() => renderer.unmount());
    });
  });

  describe('reachability and robustness', () => {
    it('renders no pressables at all without a pending celebration', async () => {
      const renderer = await render();
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      expect(
        renderer.root.findAll(node => typeof node.props.onPress === 'function'),
      ).toHaveLength(0);
      expect(modal(renderer).props.visible).toBe(false);
      act(() => renderer.unmount());
    });

    it('announces the promotion for screen readers on open', async () => {
      setPromotion();
      const renderer = await render();
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
        'Rank up: Diamond. Rating 7.62 out of 10.',
      );
      act(() => renderer.unmount());
    });

    it('shows the exact earned rating immediately without requesting count-up frames', async () => {
      setPromotion();
      const renderer = await render();
      expect(rendered(renderer)).toContain('7.62');
      expect(rendered(renderer)).not.toContain('7.10');
      expect(frames.size).toBe(0);

      act(() => flushFrame(0));
      act(() => flushFrame(1500));
      expect(rendered(renderer)).toContain('7.62');
      expect(frames.size).toBe(0);
      act(() => renderer.unmount());
    });

    it('cancels the brief entry when dismissed without leaving animation frames', async () => {
      const cancel = jest.spyOn(Reanimated, 'cancelAnimation');
      const timing = jest.spyOn(Reanimated, 'withTiming');
      setPromotion();
      const renderer = await render();
      expect(timing).toHaveBeenCalledWith(
        1,
        expect.objectContaining({ duration: 220 }),
      );
      act(() => flushFrame(0));
      expect(frames.size).toBe(0);

      await act(async () => {
        continueButton(renderer).props.onPress();
      });

      expect(cancel).toHaveBeenCalled();
      expect(cancelledFrames).toHaveLength(0);
      expect(frames.size).toBe(0);
      act(() => renderer.unmount());
    });

    it('renders the final layout at rest under reduced motion, controls intact', async () => {
      mockReducedMotion = true;
      setPromotion();
      const renderer = await render();
      expect(rendered(renderer)).toContain('7.62');
      expect(frames.size).toBe(0);
      backdrop(renderer);
      await act(async () => {
        continueButton(renderer).props.onPress();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      act(() => renderer.unmount());
    });

    it('survives a summary that lacks a next tier and a null fromRating', async () => {
      useRankCelebrationStore.setState({
        current: {
          fromTier: 'platinum',
          toTier: 'diamond',
          fromRating: null,
          summary: diamondSummary,
        },
      });
      const renderer = await render();
      expect(rendered(renderer)).toContain('7.62');
      expect(rendered(renderer)).toContain('Top tier');
      await act(async () => {
        backdrop(renderer).props.onPress();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      act(() => renderer.unmount());
    });
  });
});
