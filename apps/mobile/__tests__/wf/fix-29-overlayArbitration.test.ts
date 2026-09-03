import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

/**
 * The first-run walkthrough and the rank ceremony are both full-screen
 * Modals mounted as siblings in App.tsx. On a fresh install for a returning
 * account both fire on the first signed-in landing; they must never be
 * visible at once — whichever raises second waits for the first to dismiss.
 */

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

import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../src/progress/rankCelebration';
import {
  WALKTHROUGH_KV_KEY,
  WALKTHROUGH_SEEN_VALUE,
  useWalkthroughStore,
} from '../../src/walkthrough/walkthroughStore';

const owner = '55555555-5555-4555-8555-555555555555';

function summaryFor(tier: string, rating: number): PlayerRankSummary {
  const { division, label: divisionLabel } =
    playerRankDivisionForRating(rating);
  return {
    rating,
    tier: tier as PlayerRankSummary['tier'],
    tierLabel: tier,
    division,
    divisionLabel,
    techniqueCount: 2,
    scoredAnalysisCount: 4,
    techniques: [],
    nextTier: null,
  };
}

const rank = () => useRankCelebrationStore.getState();
const tour = () => useWalkthroughStore.getState();

beforeEach(() => {
  mockKvTable.clear();
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
  setActiveDataOwner(owner);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('walkthrough + rank ceremony arbitration', () => {
  it('holds a placement ceremony while the tour shows, then raises it on dismiss', async () => {
    await tour().maybeShowFirstRun();
    expect(tour().visible).toBe(true);

    await rank().maybeCelebrate(summaryFor('gold', 5.5));

    expect(rank().current).toBeNull();
    expect(rank().pending?.toTier).toBe('gold');
    expect(
      JSON.parse(mockKvTable.get(rankCelebrationKeyForOwner(owner))!).tier,
    ).toBe('gold');

    tour().dismiss();

    expect(tour().visible).toBe(false);
    expect(rank().pending).toBeNull();
    expect(rank().current?.toTier).toBe('gold');
    expect(rank().current?.fromTier).toBeNull();
  });

  it('queues the tour while a ceremony shows, then raises it on dismiss', async () => {
    await rank().maybeCelebrate(summaryFor('silver', 4.1));
    expect(rank().current).not.toBeNull();

    await tour().maybeShowFirstRun();

    expect(tour().visible).toBe(false);
    expect(tour().queued).toBe(true);
    expect(mockKvTable.get(WALKTHROUGH_KV_KEY)).toBe(WALKTHROUGH_SEEN_VALUE);

    rank().dismiss();

    expect(tour().queued).toBe(false);
    expect(tour().visible).toBe(true);
    expect(rank().current).toBeNull();
  });

  it('never shows both overlays at once when both land in the same commit', async () => {
    const seen: Array<[boolean, boolean]> = [];
    const record = () => seen.push([tour().visible, rank().current !== null]);
    const unsubscribeTour = useWalkthroughStore.subscribe(record);
    const unsubscribeRank = useRankCelebrationStore.subscribe(record);

    await Promise.all([
      tour().maybeShowFirstRun(),
      rank().maybeCelebrate(summaryFor('gold', 5.5)),
    ]);
    const first = tour().visible ? 'tour' : 'rank';
    if (first === 'tour') tour().dismiss();
    else rank().dismiss();
    if (first === 'tour') rank().dismiss();
    else tour().dismiss();

    unsubscribeTour();
    unsubscribeRank();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every(([a, b]) => !(a && b))).toBe(true);
    expect(tour().visible).toBe(false);
    expect(rank().current).toBeNull();
  });

  it('a later ceremony is not held once the tour has been dismissed', async () => {
    await tour().maybeShowFirstRun();
    tour().dismiss();

    await rank().maybeCelebrate(summaryFor('gold', 5.5));

    expect(rank().pending).toBeNull();
    expect(rank().current?.toTier).toBe('gold');
  });

  it('a queued tour that is dismissed before raising stays down', async () => {
    await rank().maybeCelebrate(summaryFor('silver', 4.1));
    await tour().maybeShowFirstRun();
    expect(tour().queued).toBe(true);

    tour().dismiss();
    rank().dismiss();

    expect(tour().visible).toBe(false);
    expect(tour().queued).toBe(false);
  });

  it('replay from Settings waits for a showing ceremony too', async () => {
    await rank().maybeCelebrate(summaryFor('silver', 4.1));

    tour().replay();
    expect(tour().visible).toBe(false);
    expect(tour().queued).toBe(true);

    rank().dismiss();
    expect(tour().visible).toBe(true);
  });
});
