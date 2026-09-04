/**
 * ADVERSARIAL VARIANTS of the owner-scoped rank ceremony fix (0853e8c8).
 *
 * The fix reads the active owner INSIDE the serialized `run` closure, i.e.
 * when the queued evaluation starts — not when the surface reported the
 * summary. Home banner and Progress card are both mounted (tab navigator)
 * and both report A's rank; the second report waits in `evaluationQueue`
 * behind the first one's kv read. If A is signed out and B signs in while
 * that read is pending (implicit sign-out on refresh refusal), the queued
 * evaluation of A's summary runs with owner = B: it is compared against B's
 * (empty) record, B's durable record is written with A's tier/rating, and
 * A's placement ceremony is raised for B — the exact cluster symptom in a
 * concurrency variant. Baseline 4d812e1a has the same defect (no owner
 * scoping at all), so this is a hole in the fix rather than a regression.
 */
import {
  playerRankDivisionForRating,
  type PlayerRankSummary,
} from '@pickle/shared-types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
/** Resolvers for kv reads parked by the test. */
const mockReadGate: { hold: boolean; release: Array<() => void> } = {
  hold: false,
  release: [],
};

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/data/db', () => ({
  getDb: () => ({
    async execute(sql: string, params: unknown[] = []) {
      if (sql.startsWith('SELECT value FROM kv')) {
        if (mockReadGate.hold) {
          await new Promise<void>(resolve =>
            mockReadGate.release.push(resolve),
          );
        }
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
} from '../../../src/progress/rankCelebration';
import { useWalkthroughStore } from '../../../src/walkthrough/walkthroughStore';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

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
    nextTier: null,
  };
}

function storedRecord(owner: string): { tier: string; rating: number } | null {
  const raw = mockKvTable.get(rankCelebrationKeyForOwner(owner));
  return raw ? (JSON.parse(raw) as { tier: string; rating: number }) : null;
}

function transition() {
  const { current } = useRankCelebrationStore.getState();
  return current
    ? {
        fromTier: current.fromTier,
        toTier: current.toTier,
        rating: current.summary.rating,
      }
    : null;
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

beforeEach(() => {
  mockKvTable.clear();
  mockReadGate.hold = false;
  mockReadGate.release = [];
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  for (const release of mockReadGate.release) release();
  mockReadGate.release = [];
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('rank celebration: owner switch while evaluations are queued', () => {
  it('an evaluation of A’s rank queued before the switch must not be applied to B (record + overlay)', async () => {
    setActiveDataOwner(ownerA);
    mockReadGate.hold = true;

    // Two mounted surfaces (Home banner, Progress card) report A's rank; the
    // second waits in the queue behind the first one's kv read.
    const first = useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 1810));
    const second = useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 1810));
    await flush();
    expect(mockReadGate.release).toHaveLength(1);

    // Implicit sign-out of A, then B signs in — while the read is pending.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    setActiveDataOwner(ownerB);

    // Reads may proceed now.
    mockReadGate.hold = false;
    for (const release of mockReadGate.release.splice(0)) release();
    await first;
    await second;

    // B's record must not carry A's rank, and B must not see A's ceremony.
    expect({
      current: transition(),
      recordA: storedRecord(ownerA),
      recordB: storedRecord(ownerB),
    }).toEqual({ current: null, recordA: null, recordB: null });

    // B's own first resolve is B's placement.
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 1420));
    expect(transition()).toEqual({
      fromTier: null,
      toTier: 'silver',
      rating: 1420,
    });
    expect(storedRecord(ownerB)).toEqual({ tier: 'silver', rating: 1420 });
  });

  it('a report made while signed out that is evaluated after B signs in is dropped, not attributed to B', async () => {
    setActiveDataOwner(ownerA);
    mockReadGate.hold = true;
    const first = useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 1810));
    await flush();

    // A is signed out; a late effect still reports A's resolved rank.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const late = useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('gold', 1810));
    setActiveDataOwner(ownerB);

    mockReadGate.hold = false;
    for (const release of mockReadGate.release.splice(0)) release();
    await first;
    await late;

    expect({
      current: transition(),
      recordB: storedRecord(ownerB),
    }).toEqual({ current: null, recordB: null });
  });
});
