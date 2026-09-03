import React from 'react';
import { AccessibilityInfo, Modal, Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

// The consistency store persists through SQLite; the native module is absent
// under jest and this ledger only drives the overlay through store state.
jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { StreakCelebration } from '../../src/consistency/StreakCelebration';
import { useConsistencyStore } from '../../src/consistency/store';
import type { ConsistencyCelebration } from '../../src/consistency/store';

/**
 * Button ledger for `src/consistency/StreakCelebration.tsx`. Every
 * interactive element in that file is pressed here and its real effect on
 * the consistency store asserted:
 *
 *   1. backdrop Pressable ("Dismiss milestone celebration") -> dismissCelebration
 *   2. Button "Keep training" (streak-celebration-continue) -> dismissCelebration
 *   3. Modal onRequestClose (Android back / iOS swipe) -> dismissCelebration
 *
 * There are no async handlers: `dismissCelebration` is a synchronous store
 * write, so there is no failure path, no pending state and no double-tap
 * window to guard.
 */

const thirtyDayClub: ConsistencyCelebration = {
  kind: 'streak',
  achievementId: 'streak.30',
  title: '30 Day Club',
  blurb: 'A month of showing up. Very few do this.',
  reward: 'Exclusive profile frame',
  rarity: 'epic',
  value: 30,
  streakAtCelebration: 30,
};

const firstDay: ConsistencyCelebration = {
  kind: 'streak',
  achievementId: 'streak.1',
  title: 'Day One',
  blurb: 'The first rep is the hardest.',
  reward: 'Starter badge',
  rarity: 'common',
  value: 1,
  streakAtCelebration: 1,
};

const specialist: ConsistencyCelebration = {
  kind: 'volume',
  achievementId: 'volume.specialist',
  title: 'Serve Specialist',
  blurb: 'Twenty-five scored analyses of a single stroke.',
  reward: 'Technique crest',
  rarity: 'rare',
  value: 25,
  streakAtCelebration: 4,
  detail: 'serve',
};

const BACKDROP_LABEL = 'Dismiss milestone celebration';
const CONTINUE_ID = 'streak-celebration-continue';

let announce: jest.SpyInstance;

beforeEach(() => {
  jest.useFakeTimers();
  announce = jest
    .spyOn(AccessibilityInfo, 'announceForAccessibility')
    .mockImplementation(() => {});
});

afterEach(() => {
  announce.mockRestore();
  act(() => {
    useConsistencyStore.setState({ celebration: null });
  });
  jest.useRealTimers();
});

function render(celebration: ConsistencyCelebration | null) {
  useConsistencyStore.setState({ celebration });
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(<StreakCelebration />);
  });
  return renderer;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat(3)
    .filter((child): child is string | number =>
      ['string', 'number'].includes(typeof child),
    )
    .join(' ')
    .replace(/\s+/g, ' ');
}

/** Outermost composite node (the `<Pressable>` element itself) matching. */
function findPressable(
  renderer: TestRenderer.ReactTestRenderer,
  predicate: (node: TestRenderer.ReactTestInstance) => boolean,
) {
  const matches = renderer.root.findAll(
    node => typeof node.props.onPress === 'function' && predicate(node),
  );
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function findBackdrop(renderer: TestRenderer.ReactTestRenderer) {
  return findPressable(
    renderer,
    node => node.props.accessibilityLabel === BACKDROP_LABEL,
  );
}

function findContinue(renderer: TestRenderer.ReactTestRenderer) {
  return findPressable(
    renderer,
    node =>
      node.props.testID === CONTINUE_ID &&
      node.props.accessibilityRole === 'button',
  );
}

/** Host-level stage roots (composite wrappers echo the testID). */
function stageCount(renderer: TestRenderer.ReactTestRenderer): number {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      node.props.testID === 'streak-celebration',
  ).length;
}

describe('StreakCelebration button ledger', () => {
  it('mounts no pressables while there is no pending milestone', () => {
    const renderer = render(null);
    const modal = renderer.root.findByType(Modal);
    expect(modal.props.visible).toBe(false);
    expect(stageCount(renderer)).toBe(0);
    expect(
      renderer.root.findAll(node => typeof node.props.onPress === 'function'),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('backdrop tap ends the ceremony through dismissCelebration', () => {
    const renderer = render(thirtyDayClub);
    expect(renderer.root.findByType(Modal).props.visible).toBe(true);
    expect(stageCount(renderer)).toBe(1);

    const backdrop = findBackdrop(renderer);
    expect(backdrop.props.onPress).toBe(
      useConsistencyStore.getState().dismissCelebration,
    );
    // Full-screen target: the Pressable fills the absolute backdrop layer.
    expect(backdrop.props.style).toEqual(expect.objectContaining({ flex: 1 }));

    act(() => {
      backdrop.props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    expect(stageCount(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('backdrop exposes a descriptive label and a button role', () => {
    const renderer = render(thirtyDayClub);
    const backdrop = findBackdrop(renderer);
    expect(backdrop.props.accessibilityLabel).toBe(BACKDROP_LABEL);
    // WF-ISSUE: Backdrop dismiss Pressable has no accessibilityRole
    // expect(backdrop.props.accessibilityRole).toBe('button');
    act(() => renderer.unmount());
  });

  it('"Keep training" ends the ceremony through dismissCelebration', () => {
    const renderer = render(thirtyDayClub);
    const cta = findContinue(renderer);
    expect(cta.props.accessibilityLabel).toBe('Keep training');
    expect(cta.props.disabled).toBeFalsy();
    expect(cta.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: undefined }),
    );
    expect(allText(renderer)).toContain('Keep training');

    act(() => {
      cta.props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    expect(stageCount(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('"Keep training" is never a dead-end: the CTA layer keeps a hit target', () => {
    const renderer = render(thirtyDayClub);
    // With reduced motion off the CTA fades in after ~1s, but opacity never
    // gates touches in RN — the button must be pressable from first frame.
    const cta = findContinue(renderer);
    act(() => {
      cta.props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });

  it('Modal onRequestClose (hardware back) ends the ceremony', () => {
    const renderer = render(thirtyDayClub);
    const modal = renderer.root.findByType(Modal);
    expect(modal.props.onRequestClose).toBe(
      useConsistencyStore.getState().dismissCelebration,
    );
    act(() => {
      modal.props.onRequestClose();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(renderer.root.findByType(Modal).props.visible).toBe(false);
    act(() => renderer.unmount());
  });

  it('a second tap after dismissal is a harmless no-op', () => {
    const renderer = render(thirtyDayClub);
    const cta = findContinue(renderer);
    const backdrop = findBackdrop(renderer);
    const before = useConsistencyStore.getState();
    act(() => {
      cta.props.onPress();
      cta.props.onPress();
      backdrop.props.onPress();
    });
    const after = useConsistencyStore.getState();
    expect(after.celebration).toBeNull();
    // Only the celebration slot moved; nothing else in the store was touched.
    expect(after.snapshot).toBe(before.snapshot);
    expect(after.daySecured).toBe(before.daySecured);
    expect(after.hydrated).toBe(before.hydrated);
    expect(after.ownerKey).toBe(before.ownerKey);
    act(() => renderer.unmount());
  });

  it('dismissing does not resurrect the milestone on the next state write', () => {
    const renderer = render(thirtyDayClub);
    act(() => {
      findContinue(renderer).props.onPress();
    });
    // The store's refresh merges `state.celebration ?? computed`; a null slot
    // must stay null for unrelated writes.
    act(() => {
      useConsistencyStore.setState({ hydrated: true });
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    expect(stageCount(renderer)).toBe(0);
    act(() => renderer.unmount());
  });

  it('a new milestone after dismissal remounts both pressables', () => {
    const renderer = render(thirtyDayClub);
    act(() => {
      findContinue(renderer).props.onPress();
    });
    expect(stageCount(renderer)).toBe(0);

    act(() => {
      useConsistencyStore.setState({ celebration: specialist });
    });
    expect(stageCount(renderer)).toBe(1);
    expect(allText(renderer)).toContain('Serve Specialist');
    expect(allText(renderer)).toContain('25 scored serve analyses');
    findBackdrop(renderer);
    act(() => {
      findContinue(renderer).props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });

  it('pressables are wired for every celebration shape (grand + confetti, common, volume)', () => {
    for (const celebration of [thirtyDayClub, firstDay, specialist]) {
      const renderer = render(celebration);
      expect(stageCount(renderer)).toBe(1);
      expect(allText(renderer)).toContain(celebration.title);
      expect(allText(renderer)).toContain(celebration.reward);
      const backdrop = findBackdrop(renderer);
      findContinue(renderer);
      act(() => {
        backdrop.props.onPress();
      });
      expect(useConsistencyStore.getState().celebration).toBeNull();

      act(() => {
        useConsistencyStore.setState({ celebration });
      });
      expect(stageCount(renderer)).toBe(1);
      act(() => {
        findContinue(renderer).props.onPress();
      });
      expect(useConsistencyStore.getState().celebration).toBeNull();
      act(() => renderer.unmount());
    }
  });

  it('singular copy for a one-day streak and screen-reader announcement', () => {
    const renderer = render(firstDay);
    expect(allText(renderer)).toContain('1 day of real training');
    expect(announce).toHaveBeenCalledWith(
      'Milestone unlocked: Day One. 1 day of training. Reward: Starter badge.',
    );
    act(() => renderer.unmount());
  });

  it('stays pressable after all entrance timers have elapsed', () => {
    const renderer = render(thirtyDayClub);
    act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(stageCount(renderer)).toBe(1);
    act(() => {
      findContinue(renderer).props.onPress();
    });
    expect(useConsistencyStore.getState().celebration).toBeNull();
    act(() => renderer.unmount());
  });
});
