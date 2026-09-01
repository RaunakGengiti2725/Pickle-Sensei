import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

/**
 * Rank-shift detection: exactly one ceremony per upward tier change, a
 * durable owner-scoped record, and no ceremony for sideways/downward moves
 * (though the record follows the rating down so re-promotions celebrate).
 */

const mockKvTable = new Map<string, string>();

jest.mock('../src/data/db', () => ({
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
  evaluateRankTransition,
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../src/progress/rankCelebration';

const owner = '44444444-4444-4444-8444-444444444444';

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

beforeEach(() => {
  mockKvTable.clear();
  useRankCelebrationStore.setState({ current: null });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

describe('evaluateRankTransition', () => {
  it('treats the first resolved rank as a placement', () => {
    const result = evaluateRankTransition(null, summaryFor('gold', 5.5));
    expect(result).not.toBeNull();
    expect(result!.fromTier).toBeNull();
    expect(result!.toTier).toBe('gold');
    expect(result!.fromRating).toBeNull();
  });

  it('celebrates upward moves with the stored rating as the start', () => {
    const result = evaluateRankTransition(
      { version: 1, tier: 'platinum', rating: 7.1 },
      summaryFor('diamond', 7.62),
    );
    expect(result).not.toBeNull();
    expect(result!.fromTier).toBe('platinum');
    expect(result!.toTier).toBe('diamond');
    expect(result!.fromRating).toBe(7.1);
  });

  it('never celebrates sideways or downward moves', () => {
    expect(
      evaluateRankTransition(
        { version: 1, tier: 'gold', rating: 5.2 },
        summaryFor('gold', 5.9),
      ),
    ).toBeNull();
    expect(
      evaluateRankTransition(
        { version: 1, tier: 'diamond', rating: 7.8 },
        summaryFor('platinum', 7.2),
      ),
    ).toBeNull();
  });
});

describe('rank celebration store', () => {
  it('does nothing while signed out', async () => {
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.5));
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(mockKvTable.size).toBe(0);
  });

  it('raises one placement ceremony and records it durably', async () => {
    setActiveDataOwner(owner);
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.5));
    const current = useRankCelebrationStore.getState().current;
    expect(current).not.toBeNull();
    expect(current!.fromTier).toBeNull();
    expect(current!.toTier).toBe('gold');
    const record = JSON.parse(
      mockKvTable.get(rankCelebrationKeyForOwner(owner))!,
    );
    expect(record.tier).toBe('gold');

    // The same resolve arriving again (other screen) must not duplicate.
    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.5));
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });

  it('celebrates platinum → diamond exactly once', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      rankCelebrationKeyForOwner(owner),
      JSON.stringify({ version: 1, tier: 'platinum', rating: 7.1 }),
    );
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('diamond', 7.62));
    const current = useRankCelebrationStore.getState().current;
    expect(current!.fromTier).toBe('platinum');
    expect(current!.toTier).toBe('diamond');
    expect(current!.fromRating).toBe(7.1);

    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('diamond', 7.62));
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });

  it('concurrent reports from two screens produce a single ceremony', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      rankCelebrationKeyForOwner(owner),
      JSON.stringify({ version: 1, tier: 'platinum', rating: 7.1 }),
    );
    const summary = summaryFor('diamond', 7.62);
    await Promise.all([
      useRankCelebrationStore.getState().maybeCelebrate(summary),
      useRankCelebrationStore.getState().maybeCelebrate(summary),
    ]);
    const current = useRankCelebrationStore.getState().current;
    expect(current).not.toBeNull();
    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });

  it('follows an honest rating down silently, then re-celebrates the climb', async () => {
    setActiveDataOwner(owner);
    mockKvTable.set(
      rankCelebrationKeyForOwner(owner),
      JSON.stringify({ version: 1, tier: 'platinum', rating: 6.8 }),
    );
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 6.2));
    expect(useRankCelebrationStore.getState().current).toBeNull();
    const record = JSON.parse(
      mockKvTable.get(rankCelebrationKeyForOwner(owner))!,
    );
    expect(record.tier).toBe('gold');

    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 6.9));
    const current = useRankCelebrationStore.getState().current;
    expect(current).not.toBeNull();
    expect(current!.fromTier).toBe('gold');
    expect(current!.toTier).toBe('platinum');
  });

  it('skips the ceremony when the record cannot be persisted', async () => {
    setActiveDataOwner(owner);
    const summary = summaryFor('gold', 5.5);
    const originalSet = mockKvTable.set.bind(mockKvTable);
    // Simulate a write failure: INSERT throws once.
    mockKvTable.set = () => {
      mockKvTable.set = originalSet;
      throw new Error('disk full');
    };
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
    expect(useRankCelebrationStore.getState().current).toBeNull();
    // The next resolve retries and succeeds.
    await useRankCelebrationStore.getState().maybeCelebrate(summary);
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
  });
});
