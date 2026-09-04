/**
 * The rank-up ceremony overlay is mounted at the App root, ABOVE the auth
 * gate, so its store state outlives a sign-out. It must therefore be scoped
 * to the account that earned it: switching to SIGNED_OUT or to another owner
 * drops `current` and `pending`, and the next owner's own placement ceremony
 * must still fire — which also means the durable record for an owner is not
 * written when their ceremony is skipped, or that placement would be lost.
 *
 * Reachability (INFERRED from App.tsx + sessionKeeper): a refresh refusal
 * signs the user out implicitly while the ceremony Modal is up; the next
 * account signs in underneath it.
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

jest.mock('../../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../../src/data/db', () => ({
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

import { useAuthStore } from '../../../src/auth/authStore';
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

function transition() {
  const { current } = useRankCelebrationStore.getState();
  return current
    ? { fromTier: current.fromTier, toTier: current.toTier }
    : null;
}

function storedTier(owner: string): string | null {
  const raw = mockKvTable.get(rankCelebrationKeyForOwner(owner));
  return raw ? (JSON.parse(raw) as { tier: string }).tier : null;
}

/** Owner A earns a ceremony while signed in (A's session is the live one). */
async function aCelebratesGold(): Promise<void> {
  setActiveDataOwner(ownerA);
  await useRankCelebrationStore
    .getState()
    .maybeCelebrate(summaryFor('gold', 1810));
}

beforeEach(() => {
  mockKvTable.clear();
  useRankCelebrationStore.setState({ current: null, pending: null });
  useWalkthroughStore.setState({ visible: false, queued: false });
  useAuthStore.setState({
    hydrated: true,
    session: null,
    busy: false,
    error: null,
  });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

afterEach(() => {
  useWalkthroughStore.setState({ visible: false, queued: false });
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('rank celebration across an account switch', () => {
  it('sign-out clears A’s showing ceremony; B’s first resolve is B’s own placement', async () => {
    await aCelebratesGold();
    expect(transition()).toEqual({ fromTier: null, toTier: 'gold' });

    await useAuthStore.getState().signOut();
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending).toBeNull();

    setActiveDataOwner(ownerB);
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 1420));
    expect(transition()).toEqual({ fromTier: null, toTier: 'silver' });
    expect(storedTier(ownerB)).toBe('silver');
    // A's own durable record is untouched by B's ceremony.
    expect(storedTier(ownerA)).toBe('gold');
  });

  it('pending-behind-walkthrough: A’s pending is dropped on sign-out and B’s walkthrough dismissal raises nothing from A', async () => {
    useWalkthroughStore.setState({ visible: true });
    await aCelebratesGold();
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending?.toTier).toBe('gold');

    await useAuthStore.getState().signOut();
    expect(useRankCelebrationStore.getState().pending).toBeNull();
    expect(useRankCelebrationStore.getState().current).toBeNull();

    // B signs in; the device walkthrough is still up, then B dismisses it.
    setActiveDataOwner(ownerB);
    useWalkthroughStore.setState({ visible: false });
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending).toBeNull();

    // B's own placement still fires, and it is B's — not A's gold.
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 1420));
    expect(transition()).toEqual({ fromTier: null, toTier: 'silver' });
  });

  it('B’s ceremony earned behind the walkthrough is raised for B when the walkthrough closes', async () => {
    useWalkthroughStore.setState({ visible: true });
    await aCelebratesGold();
    await useAuthStore.getState().signOut();

    setActiveDataOwner(ownerB);
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 1420));
    expect(useRankCelebrationStore.getState().current).toBeNull();
    expect(useRankCelebrationStore.getState().pending?.toTier).toBe('silver');

    useWalkthroughStore.setState({ visible: false });
    expect(transition()).toEqual({ fromTier: null, toTier: 'silver' });
    expect(useRankCelebrationStore.getState().pending).toBeNull();
  });

  it('an overlay left over from another owner never suppresses (or is shown over) the active owner’s placement', async () => {
    // Owner switch WITHOUT the auth store (defensive path): the store itself
    // must recognise that its overlay belongs to someone else.
    await aCelebratesGold();
    setActiveDataOwner(ownerB);

    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('silver', 1420));

    expect(transition()).toEqual({ fromTier: null, toTier: 'silver' });
    expect(useRankCelebrationStore.getState().pending).toBeNull();
    expect(storedTier(ownerB)).toBe('silver');
  });

  it('a skipped ceremony does not write the durable record, so the promotion fires after dismissal', async () => {
    await aCelebratesGold();
    expect(transition()).toEqual({ fromTier: null, toTier: 'gold' });

    // A second screen resolves a higher tier while the gold ceremony is up.
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 2010));
    expect(transition()).toEqual({ fromTier: null, toTier: 'gold' });
    expect(storedTier(ownerA)).toBe('gold');

    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore
      .getState()
      .maybeCelebrate(summaryFor('platinum', 2010));
    expect(transition()).toEqual({ fromTier: 'gold', toTier: 'platinum' });
    expect(storedTier(ownerA)).toBe('platinum');
  });
});
