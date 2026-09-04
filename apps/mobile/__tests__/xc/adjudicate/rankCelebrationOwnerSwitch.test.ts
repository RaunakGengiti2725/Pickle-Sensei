/**
 * Adjudication reproduction (xc-journeys / journey-account-switch): the rank
 * ceremony overlay state (`current` / `pending` in useRankCelebrationStore)
 * is module memory that nothing in the sign-out / owner-switch path clears
 * (authStore.clearSyncedRuntime + setActiveDataOwner never touch it;
 * RankUpCelebration is mounted at the App root above the auth gate). After an
 * implicit sign-out of A while A's ceremony shows, B signs in on the device:
 * B's first resolved rank writes B's record, then `maybeCelebrate` bails on
 * the stale `current`, so B sees A's summary and B's own placement ceremony
 * can never fire again.
 */
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../../src/data/accountScope';

const mockKvTable = new Map<string, string>();
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

import type { PlayerRankSummary } from '@pickle/shared-types';
import {
  rankCelebrationKeyForOwner,
  useRankCelebrationStore,
} from '../../../src/progress/rankCelebration';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

const GOLD = {
  tier: 'gold',
  rating: 1810,
  techniqueCount: 1,
} as unknown as PlayerRankSummary;
const SILVER = {
  tier: 'silver',
  rating: 1420,
  techniqueCount: 2,
} as unknown as PlayerRankSummary;

describe('adjudication: rank ceremony carries across an owner switch', () => {
  beforeEach(() => {
    mockKvTable.clear();
    useRankCelebrationStore.setState({ current: null, pending: null });
  });
  afterEach(() => setActiveDataOwner(SIGNED_OUT_DATA_OWNER));

  it("B's placement is suppressed by A's stale ceremony and B sees A's rating", async () => {
    setActiveDataOwner(OWNER_A);
    await useRankCelebrationStore.getState().maybeCelebrate(GOLD);
    expect(useRankCelebrationStore.getState().current?.toTier).toBe('gold');

    // Implicit sign-out (refresh refused) while the ceremony Modal is up; the
    // owner switch is the only state transition the store could observe.
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    const afterSignOut = useRankCelebrationStore.getState().current;

    setActiveDataOwner(OWNER_B);
    await useRankCelebrationStore.getState().maybeCelebrate(SILVER);
    const bSees = useRankCelebrationStore.getState().current;
    const bRecord = mockKvTable.get(rankCelebrationKeyForOwner(OWNER_B));
    useRankCelebrationStore.getState().dismiss();
    await useRankCelebrationStore.getState().maybeCelebrate(SILVER);
    const bLater = useRankCelebrationStore.getState().current;

    console.log(
      `[adjudicate] afterSignOut=${JSON.stringify(afterSignOut?.summary)} bSees=${JSON.stringify(bSees?.summary)} bRecord=${bRecord} bPlacementLater=${JSON.stringify(bLater)}`,
    );
    expect(bRecord).toContain('"silver"');
    // Expected product behaviour: A's overlay does not outlive A's session and
    // B gets B's own placement ceremony.
    expect(afterSignOut).toBeNull();
    expect(bSees).toMatchObject({ fromTier: null, toTier: 'silver' });
  });
});
