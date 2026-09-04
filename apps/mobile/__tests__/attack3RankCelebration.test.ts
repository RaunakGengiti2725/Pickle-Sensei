/**
 * Adversarial pass 3 — rank celebration store.
 *
 * Attacks the owner-scoped "one ceremony per upward tier change" contract
 * with corrupt durable state and owner switches interleaved with the async
 * boundaries inside `maybeCelebrate`:
 *
 *   B1 the kv record exists but is unparseable (missing rating / wrong tier
 *      case / string rating) → the module must not replay a placement
 *      ceremony nor overwrite the record it could not read;
 *   B2 a promotion held `pending` behind the walkthrough must be dropped
 *      when the owner changes (sign-out, or another account) before the
 *      walkthrough dismisses — never raised for the wrong owner;
 *   B3 an owner switch while the record write is in flight must not raise
 *      the ceremony for the new owner;
 *   B4 rapid concurrent reports still produce exactly one ceremony.
 */
import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';

const mockKvTable = new Map<string, string>();
const mockKvLog: Array<{ op: 'get' | 'set'; key: string; value?: string }> = [];
/** When set, the next INSERT waits on this promise before committing. */
let mockWriteGate: Promise<void> | null = null;

jest.mock('../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        const key = String(params[0]);
        mockKvLog.push({ op: 'get', key });
        const value = mockKvTable.get(key);
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (sql.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockWriteGate) {
          const gate = mockWriteGate;
          mockWriteGate = null;
          await gate;
        }
        const key = String(params[0]);
        const value = String(params[1]);
        mockKvLog.push({ op: 'set', key, value });
        mockKvTable.set(key, value);
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
} from '../src/progress/rankCelebration';
import { useWalkthroughStore } from '../src/walkthrough/walkthroughStore';

const ownerA = '44444444-4444-4444-8444-444444444444';
const ownerB = '55555555-5555-4555-8555-555555555555';

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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

beforeEach(() => {
  mockKvTable.clear();
  mockKvLog.length = 0;
  mockWriteGate = null;
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  useWalkthroughStore.setState({ visible: false, queued: false });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('B1 — corrupt durable rank record', () => {
  const corruptRecords: Array<[string, string]> = [
    ['missing rating', JSON.stringify({ tier: 'Gold' })],
    ['capitalized tier key', JSON.stringify({ tier: 'Gold', rating: 5.5 })],
    ['lowercase tier, missing rating', JSON.stringify({ tier: 'gold' })],
    ['string rating', JSON.stringify({ tier: 'gold', rating: '5.5' })],
    ['NaN rating', '{"version":1,"tier":"gold","rating":NaN}'],
  ];

  it.each(corruptRecords)(
    'does not replay a placement ceremony nor overwrite the record — %s',
    async (_label, raw) => {
      setActiveDataOwner(ownerA);
      const key = rankCelebrationKeyForOwner(ownerA);
      mockKvTable.set(key, raw);

      await useRankCelebrationStore
        .getState()
        .maybeCelebrate(summaryFor('gold', 5.5));

      const { current, pending } = useRankCelebrationStore.getState();
      // A record already exists for this owner: the account has SEEN a
      // ceremony before. Whatever the module decides about the unreadable
      // rating, it must not raise a placement ceremony as if this were the
      // first resolved rank ...
      // ... and must not silently replace state it could not read.
      expect({
        current,
        pending,
        writes: mockKvLog.filter(entry => entry.op === 'set'),
        storedAfter: mockKvTable.get(key),
      }).toEqual({
        current: null,
        pending: null,
        writes: [],
        storedAfter: raw,
      });
    },
  );

  it('control: an empty kv IS a first placement (the honest path)', async () => {
    setActiveDataOwner(ownerA);
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.5));
    expect(useRankCelebrationStore.getState().current).toMatchObject({
      fromTier: null,
      toTier: 'gold',
    });
    expect(
      JSON.parse(mockKvTable.get(rankCelebrationKeyForOwner(ownerA))!),
    ).toEqual({ version: 1, tier: 'gold', rating: 5.5 });
  });
});

describe('B2 — pending ceremony survives an owner switch behind the walkthrough', () => {
  it('drops the pending ceremony when the owner signs out before the tour hides', async () => {
    setActiveDataOwner(ownerA);
    mockKvTable.set(
      rankCelebrationKeyForOwner(ownerA),
      JSON.stringify({ version: 1, tier: 'bronze', rating: 2.1 }),
    );
    useWalkthroughStore.setState({ visible: true });

    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.6));
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending).toMatchObject({
      fromTier: 'bronze',
      toTier: 'gold',
    });

    // The player signs out while the tour is still up.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useWalkthroughStore.getState().dismiss();
    await flush();

    // A signed-out process has no rank; nothing may be shown.
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending).toBeNull();
  });

  it('never shows owner A’s promotion to owner B, and never suppresses B’s own', async () => {
    setActiveDataOwner(ownerA);
    mockKvTable.set(
      rankCelebrationKeyForOwner(ownerA),
      JSON.stringify({ version: 1, tier: 'silver', rating: 4.0 }),
    );
    useWalkthroughStore.setState({ visible: true });
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 6.9));
    expect(useRankCelebrationStore.getState().pending).toMatchObject({
      fromTier: 'silver',
      toTier: 'platinum',
    });

    // Account switch while the tour is up; B resolves their own first rank.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(ownerB);
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('bronze', 1.2));
    useWalkthroughStore.getState().dismiss();
    await flush();

    const { current, pending } = useRankCelebrationStore.getState();
    // B's own placement is the only ceremony B may ever see; the stale
    // pending must neither leak onto B's screen nor starve B's ceremony.
    expect({
      currentFromTier: current?.fromTier,
      currentToTier: current?.toTier,
      currentRating: current?.summary.rating,
      pendingToTier: pending?.toTier,
      recordB: mockKvTable.get(rankCelebrationKeyForOwner(ownerB)),
    }).toEqual({
      currentFromTier: null,
      currentToTier: 'bronze',
      currentRating: 1.2,
      pendingToTier: undefined,
      recordB: JSON.stringify({ version: 1, tier: 'bronze', rating: 1.2 }),
    });
  });
});

describe('B3 — owner switch while the record write is in flight', () => {
  it('does not raise owner A’s ceremony after A signed out mid-write', async () => {
    setActiveDataOwner(ownerA);
    mockKvTable.set(
      rankCelebrationKeyForOwner(ownerA),
      JSON.stringify({ version: 1, tier: 'bronze', rating: 2.0 }),
    );
    const gate = deferred();
    mockWriteGate = gate.promise;

    const run = useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.4));
    await flush();
    // The INSERT is parked; the player signs out now.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    gate.resolve();
    await run;

    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending).toBeNull();
  });

  it('does not raise owner A’s ceremony for owner B who signed in mid-write', async () => {
    setActiveDataOwner(ownerA);
    mockKvTable.set(
      rankCelebrationKeyForOwner(ownerA),
      JSON.stringify({ version: 1, tier: 'bronze', rating: 2.0 }),
    );
    const gate = deferred();
    mockWriteGate = gate.promise;

    const run = useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 5.4));
    await flush();
    setActiveDataOwner(ownerB);
    gate.resolve();
    await run;

    expect(useRankCelebrationStore.getState().current).toBeNull();
    // A's record write itself is fine (it is A's key) — only the ceremony
    // must not leak onto B's screen.
    expect(mockKvTable.get(rankCelebrationKeyForOwner(ownerB))).toBeUndefined();
  });
});

describe('B4 — rapid concurrent reports', () => {
  it('twenty simultaneous promotions → one ceremony, one record write', async () => {
    setActiveDataOwner(ownerA);
    mockKvTable.set(
      rankCelebrationKeyForOwner(ownerA),
      JSON.stringify({ version: 1, tier: 'bronze', rating: 2.0 }),
    );
    const store = useRankCelebrationStore.getState();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        store.maybeCelebrate(summaryFor('silver', 3.9)),
      ),
    );
    expect(useRankCelebrationStore.getState().current).toMatchObject({
      fromTier: 'bronze',
      toTier: 'silver',
    });
    expect(mockKvLog.filter(entry => entry.op === 'set')).toHaveLength(1);
  });

  it('a dismissed promotion is not re-raised by a repeat of the same rank', async () => {
    setActiveDataOwner(ownerA);
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 3.9));
    expect(useRankCelebrationStore.getState().current).not.toBeNull();
    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 3.9));
    expect(useRankCelebrationStore.getState().current).toBeNull();
  });
});
