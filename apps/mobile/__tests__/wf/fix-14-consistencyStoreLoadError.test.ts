const mockKv = new Map<string, string>();
let mockListShotsFails = false;

jest.mock('../../src/data/db', () => ({
  getDb: () => ({}),
}));

jest.mock('../../src/data/repository', () => ({
  getKv: async (_db: unknown, key: string) => mockKv.get(key) ?? null,
  setKv: async (_db: unknown, key: string, value: string) => {
    mockKv.set(key, value);
  },
  listActivityShots: async () => {
    if (mockListShotsFails) throw new Error('SQLITE_IOERR');
    return [
      {
        id: 'shot-1',
        sessionId: null,
        shotType: 'dink',
        capturedAt: new Date(Date.now() - 1_000).toISOString(),
        overallScore: 6,
        resultKind: 'scored',
      },
    ];
  },
}));

import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import { useConsistencyStore } from '../../src/consistency/store';

const owner = '33333333-3333-4333-8333-333333333333';

beforeEach(() => {
  mockKv.clear();
  mockListShotsFails = false;
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  setActiveDataOwner(owner);
});

afterEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
});

describe('useConsistencyStore loadError', () => {
  it('flags a failed history read instead of resolving silently', async () => {
    mockListShotsFails = true;
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState()).toMatchObject({
      ownerKey: owner,
      snapshot: null,
      loadError: true,
    });
  });

  it('clears the flag on the next successful refresh', async () => {
    mockListShotsFails = true;
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().loadError).toBe(true);

    mockListShotsFails = false;
    await useConsistencyStore.getState().refresh();
    const state = useConsistencyStore.getState();
    expect(state.loadError).toBe(false);
    expect(state.snapshot?.currentStreak).toBe(1);
  });

  it('keeps the last good snapshot when a later refresh fails', async () => {
    await useConsistencyStore.getState().refresh();
    expect(useConsistencyStore.getState().snapshot?.currentStreak).toBe(1);

    mockListShotsFails = true;
    await useConsistencyStore.getState().refresh();
    const state = useConsistencyStore.getState();
    expect(state.loadError).toBe(true);
    expect(state.snapshot?.currentStreak).toBe(1);
  });

  it('resets the flag for a signed-out process', async () => {
    mockListShotsFails = true;
    await useConsistencyStore.getState().refresh();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await useConsistencyStore.getState().hydrate();
    expect(useConsistencyStore.getState()).toMatchObject({
      snapshot: null,
      loadError: false,
    });
  });
});
