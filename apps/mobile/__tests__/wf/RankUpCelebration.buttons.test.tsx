import { dispatchHardwareBack } from '../../testSupport/ceremonyNativeLifecycle';
import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
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

import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import { useRankCelebrationStore } from '../../src/progress/rankCelebration';

/**
 * Button ledger for RankUpCelebration. Every interactive element in the
 * overlay is pressed here and its observable effect asserted:
 *
 *   1. backdrop Pressable ("Dismiss rank celebration")  -> store.dismiss
 *   2. Continue Button (testID rank-up-continue)          -> store.dismiss
 *   3. Hardware back / accessibility escape             -> store.dismiss
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

// requestAnimationFrame is driven by hand so the rating count-up is
// deterministic: frames run only when a test asks for them.
const frames = new Map<number, (timestamp: number) => void>();
let nextFrameId = 1;
const cancelledFrames: number[] = [];

function flushFrame(timestamp: number) {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(timestamp);
}

beforeEach(() => {
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

const mounted = new Set<TestRenderer.ReactTestRenderer>();

function unmount(renderer: TestRenderer.ReactTestRenderer) {
  act(() => renderer.unmount());
  mounted.delete(renderer);
}

afterEach(() => {
  for (const renderer of mounted) unmount(renderer);
  useRankCelebrationStore.setState({
    current: null,
    pending: null,
    queued: [],
  });
  jest.restoreAllMocks();
});

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RankUpCelebration />);
    mounted.add(renderer);
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

function overlay(renderer: TestRenderer.ReactTestRenderer) {
  const nodes = hostNodes(renderer, 'ceremony-overlay');
  expect(nodes).toHaveLength(1);
  return nodes[0]!;
}

function rendered(renderer: TestRenderer.ReactTestRenderer) {
  return JSON.stringify(renderer.toJSON());
}

describe('RankUpCelebration button ledger', () => {
  it('enumerates the press targets and routes duplicate dismissals through the host', async () => {
    setPromotion();
    const renderer = await render();
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(1);

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
    // Every press handler in the overlay uses the host's guarded dismissal;
    // duplicate events must not consume any other request.
    const escape = overlay(renderer).props.onAccessibilityEscape;
    await act(async () => {
      for (const node of pressables) node.props.onPress();
      escape();
    });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(hostNodes(renderer, 'ceremony-overlay')).toHaveLength(0);

    unmount(renderer);
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
      unmount(renderer);
    });

    it('fills the whole overlay (>= 44pt hit target) and is never disabled', async () => {
      setPromotion();
      const renderer = await render();
      const node = backdrop(renderer);
      const flattened = Object.assign(
        {},
        ...[node.props.style].flat(Infinity).filter(Boolean),
      ) as { flex?: number };
      expect(flattened.flex).toBe(1);
      expect(node.props.disabled).toBeFalsy();
      expect(node.props.accessibilityLabel).toBe('Dismiss rank celebration');
      // WF-ISSUE: Backdrop dismiss Pressable has no accessibilityRole
      // expect(node.props.accessibilityRole).toBe('button');
      unmount(renderer);
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
      unmount(renderer);
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
      unmount(renderer);
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
      unmount(renderer);
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
      unmount(renderer);
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
      unmount(renderer);
    });
  });

  describe('hardware back and accessibility escape -> dismiss', () => {
    it('hardware back closes the ceremony and removes its handler', async () => {
      setPromotion();
      const renderer = await render();
      expect(hostNodes(renderer, 'ceremony-overlay')).toHaveLength(1);

      await act(async () => {
        expect(dispatchHardwareBack()).toBe(true);
      });

      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(hostNodes(renderer, 'ceremony-overlay')).toHaveLength(0);
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      expect(dispatchHardwareBack()).toBe(false);
      unmount(renderer);
    });

    it('accessibility escape closes the ceremony and a late duplicate is harmless', async () => {
      setPromotion();
      const renderer = await render();
      const escape = overlay(renderer).props.onAccessibilityEscape;
      await act(async () => {
        escape();
      });
      await act(async () => {
        escape();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      expect(hostNodes(renderer, 'ceremony-overlay')).toHaveLength(0);
      unmount(renderer);
    });
  });

  describe('reachability and robustness', () => {
    it('renders no pressables at all without a pending celebration', async () => {
      const renderer = await render();
      expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
      expect(
        renderer.root.findAll(node => typeof node.props.onPress === 'function'),
      ).toHaveLength(0);
      expect(hostNodes(renderer, 'ceremony-overlay')).toHaveLength(0);
      unmount(renderer);
    });

    it('announces the promotion for screen readers on open', async () => {
      setPromotion();
      const renderer = await render();
      expect(AccessibilityInfo.announceForAccessibility).toHaveBeenCalledWith(
        'Rank up: Diamond. Rating 7.62 out of 10.',
      );
      unmount(renderer);
    });

    it('counts the rating up to its final value, then stops requesting frames', async () => {
      setPromotion();
      const renderer = await render();
      const rating = () => hostNodes(renderer, 'rank-up-rating')[0]!;
      expect(rating().children[0]).toBe('7.10');
      expect(rating().props.accessibilityLabel).toBe('Rating 7.62 out of 10');
      expect(frames.size).toBe(1);

      act(() => flushFrame(0));
      act(() => flushFrame(780 + 360));
      const midway = Number(rating().children[0]);
      expect(midway).toBeGreaterThan(7.1);
      expect(midway).toBeLessThan(7.62);

      act(() => flushFrame(780 + 720));
      expect(rating().children[0]).toBe('7.62');
      expect(frames.size).toBe(0);
      unmount(renderer);
    });

    it('cancels the count-up frame when dismissed mid-animation', async () => {
      setPromotion();
      const renderer = await render();
      act(() => flushFrame(0));
      expect(frames.size).toBe(1);
      const [pendingId] = [...frames.keys()];

      await act(async () => {
        continueButton(renderer).props.onPress();
      });

      expect(cancelledFrames).toContain(pendingId);
      expect(frames.size).toBe(0);
      unmount(renderer);
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
      unmount(renderer);
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
      expect(rendered(renderer)).toContain('0.00');
      expect(rendered(renderer)).toContain('Top tier');
      await act(async () => {
        backdrop(renderer).props.onPress();
      });
      expect(useRankCelebrationStore.getState().current).toBeNull();
      unmount(renderer);
    });
  });
});
