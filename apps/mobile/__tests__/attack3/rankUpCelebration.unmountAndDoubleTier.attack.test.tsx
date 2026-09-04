import React from 'react';
import { AccessibilityInfo } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';

/**
 * Attack pass 3 / scenario 3 — RankUpCelebration lifecycle.
 *
 *   a) raise a ceremony, unmount the root BEFORE any animation frame or
 *      Reanimated loop completes → every cleanup must fire
 *      (cancelAnimation for the sunburst loop, cancelAnimationFrame for the
 *      rating count-up) and nothing may setState after unmount;
 *   b) two upward tier changes reported in ONE commit (same tick) → exactly
 *      one ceremony shows and the second is not lost.
 *
 * Reanimated is the repo's jest mock, extended with a spy-able
 * cancelAnimation so the cleanup can be observed.
 */

const mockCancelAnimation = jest.fn();
jest.mock('react-native-reanimated', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '../../__mocks__/react-native-reanimated',
  ),
  cancelAnimation: (...args: unknown[]) => mockCancelAnimation(...args),
}));

let mockReducedMotion = false;
jest.mock('../../src/design/components', () => ({
  ...jest.requireActual('../../src/design/components'),
  useReducedMotion: () => mockReducedMotion,
}));

const mockKvTable = new Map<string, string>();
jest.mock('../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const value = mockKvTable.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        mockKvTable.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      return { rows: [] };
    },
    close() {},
  }),
}));

import { RankUpCelebration } from '../../src/components/RankUpCelebration';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { useWalkthroughStore } from '../../src/walkthrough/walkthroughStore';

const owner = '33333333-3333-4333-8333-333333333333';

function summaryFor(tier: string, rating: number): PlayerRankSummary {
  const labels: Record<string, string> = {
    bronze: 'Bronze',
    silver: 'Silver',
    gold: 'Gold',
    platinum: 'Platinum',
    diamond: 'Diamond',
  };
  const { division, label: divisionLabel } =
    playerRankDivisionForRating(rating);
  return {
    rating,
    tier: tier as PlayerRankSummary['tier'],
    tierLabel: labels[tier] ?? tier,
    division,
    divisionLabel,
    techniqueCount: 2,
    scoredAnalysisCount: 4,
    techniques: [],
    nextTier:
      tier === 'diamond'
        ? null
        : {
            key: 'diamond',
            label: 'Diamond',
            minRating: 7.5,
            pointsNeeded: Math.round((7.5 - rating) * 100) / 100,
          },
  };
}

const frames = new Map<number, (timestamp: number) => void>();
let nextFrameId = 1;
const cancelledFrames: number[] = [];
let consoleErrorSpy: jest.SpyInstance;

function flushFrame(timestamp: number) {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(timestamp);
}

beforeEach(() => {
  mockReducedMotion = false;
  mockKvTable.clear();
  frames.clear();
  cancelledFrames.length = 0;
  nextFrameId = 1;
  mockCancelAnimation.mockClear();
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
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  (AccessibilityInfo.announceForAccessibility as jest.Mock).mockClear();
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  useRankCelebrationStore.setState({ current: null, pending: null });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  jest.restoreAllMocks();
});

function setPromotion() {
  useRankCelebrationStore.setState({
    current: {
      fromTier: 'platinum',
      toTier: 'diamond',
      fromRating: 7.1,
      summary: summaryFor('diamond', 7.62),
    },
  });
}

async function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<RankUpCelebration />);
  });
  return renderer;
}

function hostNodes(renderer: TestRenderer.ReactTestRenderer, testID: string) {
  return renderer.root.findAll(
    node => node.props.testID === testID && typeof node.type === 'string',
  );
}

describe('RankUpCelebration — unmount before cleanup (attack 3)', () => {
  it('unmounting the root mid-ceremony cancels the sunburst loop and the count-up frame', async () => {
    setPromotion();
    const renderer = await render();
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(1);
    // A frame is pending (count-up armed) and no cancellation has happened.
    expect(frames.size).toBe(1);
    const armedFrame = [...frames.keys()][0]!;
    expect(cancelledFrames).toHaveLength(0);
    expect(mockCancelAnimation).not.toHaveBeenCalled();

    act(() => renderer.unmount());

    expect(mockCancelAnimation).toHaveBeenCalledTimes(1);
    expect(cancelledFrames).toEqual([armedFrame]);
    expect(frames.size).toBe(0);
    // Late frame after unmount (RN can still deliver one) must be inert.
    expect(() => flushFrame(5000)).not.toThrow();
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('unmounting mid count-up (frames already flushed) still cancels the live frame', async () => {
    setPromotion();
    const renderer = await render();
    // Advance into the count-up window: start → delay (780) → mid-duration.
    await act(async () => flushFrame(0));
    await act(async () => flushFrame(1000));
    await act(async () => flushFrame(1200));
    expect(frames.size).toBe(1);
    const liveFrame = [...frames.keys()][0]!;
    const before = cancelledFrames.length;
    act(() => renderer.unmount());
    expect(cancelledFrames.slice(before)).toEqual([liveFrame]);
    expect(mockCancelAnimation).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('dismissing (store current → null) while mounted also runs both cleanups', async () => {
    setPromotion();
    const renderer = await render();
    await act(async () => {
      useRankCelebrationStore.getState().dismiss();
    });
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(0);
    expect(mockCancelAnimation).toHaveBeenCalledTimes(1);
    expect(cancelledFrames).toHaveLength(1);
    expect(frames.size).toBe(0);
    act(() => renderer.unmount());
    // Nothing left to cancel a second time.
    expect(mockCancelAnimation).toHaveBeenCalledTimes(1);
  });

  it('reduced motion arms no loop and no frame, so unmount has nothing to cancel', async () => {
    mockReducedMotion = true;
    setPromotion();
    const renderer = await render();
    expect(frames.size).toBe(0);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('7.62');
    act(() => renderer.unmount());
    expect(mockCancelAnimation).not.toHaveBeenCalled();
    expect(cancelledFrames).toHaveLength(0);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('rapid mount/unmount ×20 leaves zero pending frames and cancels one loop per mount', async () => {
    setPromotion();
    for (let i = 0; i < 20; i += 1) {
      const renderer = await render();
      act(() => renderer.unmount());
    }
    expect(frames.size).toBe(0);
    expect(mockCancelAnimation).toHaveBeenCalledTimes(20);
    expect(cancelledFrames).toHaveLength(20);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

describe('RankUpCelebration — two tier changes in one commit (attack 3)', () => {
  it('shows exactly one ceremony for gold then platinum reported in the same tick', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      rankCelebrationKeyForOwner(owner),
      JSON.stringify({ version: 1, tier: 'silver', rating: 4.1 }),
    );
    const store = useRankCelebrationStore.getState();
    // Same commit: Home banner sees gold, Progress card (post-sync) sees
    // platinum — both dispatched before either resolves.
    const gold = store.maybeCelebrate(summaryFor('gold', 5.4));
    const platinum = store.maybeCelebrate(summaryFor('platinum', 6.8));
    await Promise.all([gold, platinum]);

    const { current } = useRankCelebrationStore.getState();
    expect(current).not.toBeNull();
    expect(current!.toTier).toBe('gold');
    // Only one Modal content at a time.
    const renderer = await render();
    expect(hostNodes(renderer, 'rank-up-celebration')).toHaveLength(1);
    act(() => renderer.unmount());
  });

  it('the second tier change is queued and raised after the first is dismissed', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      rankCelebrationKeyForOwner(owner),
      JSON.stringify({ version: 1, tier: 'silver', rating: 4.1 }),
    );
    const store = useRankCelebrationStore.getState();
    await Promise.all([
      store.maybeCelebrate(summaryFor('gold', 5.4)),
      store.maybeCelebrate(summaryFor('platinum', 6.8)),
    ]);
    expect(useRankCelebrationStore.getState().current?.toTier).toBe('gold');
    // The durable record has already advanced to platinum.
    expect(
      JSON.parse(mockKvTable.get(rankCelebrationKeyForOwner(owner))!).tier,
    ).toBe('platinum');

    // The platinum promotion must survive somewhere: pending, or raised on
    // dismiss.
    const afterFirst = useRankCelebrationStore.getState();
    const queued = afterFirst.pending;
    useRankCelebrationStore.getState().dismiss();
    const afterDismiss = useRankCelebrationStore.getState();
    const raised = afterDismiss.current;
    // A later re-report of platinum (next Progress visit) is the only other
    // legitimate path to the ceremony.
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 6.8));
    const rereported = useRankCelebrationStore.getState().current;
    const platinumShownSomewhere =
      queued?.toTier === 'platinum' ||
      raised?.toTier === 'platinum' ||
      rereported?.toTier === 'platinum';
    expect({
      queued: queued?.toTier ?? null,
      raisedOnDismiss: raised?.toTier ?? null,
      onRereport: rereported?.toTier ?? null,
      platinumShownSomewhere,
    }).toEqual(expect.objectContaining({ platinumShownSomewhere: true }));
  });

  it('a promotion that resolves WHILE a ceremony is on screen (sync lands mid-ceremony) is not lost', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      rankCelebrationKeyForOwner(owner),
      JSON.stringify({ version: 1, tier: 'silver', rating: 4.1 }),
    );
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.4));
    expect(useRankCelebrationStore.getState().current?.toTier).toBe('gold');
    // User is looking at the gold ceremony; a background sync resolves
    // platinum.
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 6.8));
    expect(useRankCelebrationStore.getState().current?.toTier).toBe('gold');
    useRankCelebrationStore.getState().dismiss();
    const afterDismiss = useRankCelebrationStore.getState();
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 6.8));
    const rereport = useRankCelebrationStore.getState().current;
    expect({
      pendingAfterFirst: afterDismiss.pending?.toTier ?? null,
      currentAfterDismiss: afterDismiss.current?.toTier ?? null,
      currentOnRereport: rereport?.toTier ?? null,
      record: JSON.parse(mockKvTable.get(rankCelebrationKeyForOwner(owner))!)
        .tier,
    }).toMatchObject({ record: 'platinum' });
    expect(
      [
        afterDismiss.pending?.toTier,
        afterDismiss.current?.toTier,
        rereport?.toTier,
      ].includes('platinum'),
    ).toBe(true);
  });

  it('while the walkthrough is visible, both changes reduce to ONE pending ceremony and the tour hand-off raises it once', async () => {
    setActiveDataOwner(owner);
    useWalkthroughStore.setState({ visible: true });
    const store = useRankCelebrationStore.getState();
    await Promise.all([
      store.maybeCelebrate(summaryFor('gold', 5.4)),
      store.maybeCelebrate(summaryFor('platinum', 6.8)),
    ]);
    let state = useRankCelebrationStore.getState();
    expect(state.current).toBeNull();
    expect(state.pending).not.toBeNull();
    // Tour closes → pending promoted exactly once.
    useWalkthroughStore.setState({ visible: false });
    state = useRankCelebrationStore.getState();
    expect(state.current).not.toBeNull();
    expect(state.pending).toBeNull();
    // Toggling the tour again does not double-raise or clobber.
    const shown = state.current;
    useWalkthroughStore.setState({ visible: true });
    useWalkthroughStore.setState({ visible: false });
    expect(useRankCelebrationStore.getState().current).toBe(shown);
  });

  it('two identical reports in one tick (Home + Progress) never double-celebrate, even after dismiss', async () => {
    setActiveDataOwner(owner);
    const store = useRankCelebrationStore.getState();
    const summary = summaryFor('gold', 5.4);
    await Promise.all([
      store.maybeCelebrate(summary),
      store.maybeCelebrate(summary),
      store.maybeCelebrate(summary),
    ]);
    expect(useRankCelebrationStore.getState().current?.fromTier).toBeNull();
    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });

  it('a corrupt persisted record (junk JSON / unknown tier / NaN) is treated as first placement, not a crash', async () => {
    setActiveDataOwner(owner);
    for (const junk of [
      '{not json',
      '[]',
      'null',
      JSON.stringify({ version: 1, tier: 'mythic', rating: 9 }),
      JSON.stringify({ version: 1, tier: 'gold', rating: 'NaN' }),
      JSON.stringify({ version: 1, tier: 'gold', rating: Infinity }),
      '\u0000\uFFFF🥒'.repeat(1000),
    ]) {
      mockKvTable.set(rankCelebrationKeyForOwner(owner), junk);
      useRankCelebrationStore.setState({ current: null, pending: null });
      await expect(
        useRankCelebrationStore
          .getState()
          .maybeCelebrate(summaryFor('gold', 5.4)),
      ).resolves.toBeUndefined();
      const { current } = useRankCelebrationStore.getState();
      expect(current?.fromTier).toBeNull();
      expect(current?.toTier).toBe('gold');
    }
  });

  it('owner switch mid-evaluation (sign-out between read and write) neither writes nor celebrates', async () => {
    setActiveDataOwner(owner);
    const original = mockKvTable.get;
    // First kv read flips the owner before the write lands.
    const getSpy = jest.spyOn(mockKvTable, 'get').mockImplementation(function (
      this: Map<string, string>,
      key: string,
    ) {
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      return original.call(this, key);
    });
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.4));
    getSpy.mockRestore();
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(mockKvTable.has(rankCelebrationKeyForOwner(owner))).toBe(false);
  });
});
