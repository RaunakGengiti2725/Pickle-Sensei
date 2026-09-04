// Adversarial pass 3 — subsystem `mobile-training-drills`, store surface.
//
// Every test performs one attack against apps/mobile/src/training/store.ts
// (+ api.ts where the wire format matters) and asserts the CURRENT behaviour
// at 4d812e1a. Tests whose name starts with `BROKEN:` reproduce a failure
// mode on purpose (the assertion pins what happens today so the report can
// carry an executable repro); tests whose name starts with `HELD:` pin a
// guarantee that survived the attack.

const mockRecordDrillCompletion = jest.fn(async () => undefined);
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

import { createTrainingApi } from '../../src/training/api';
import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import type {
  DrillDetail,
  SavedDrill,
  TrainingApi,
  TrainingPlan,
  TrainingPlanItem,
} from '../../src/training/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-scheduled microtask/promise continuation run. */
async function flush(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Deterministic PRNG (mulberry32) so interleavings are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x5eed2026;

const itemId = 'd32bb05c-d72c-42dd-8075-3af93a63e700';

function savedDrill(slug: string): SavedDrill {
  return {
    id: `80184be3-3e97-4eaf-8d8e-${slug.padEnd(12, '0').slice(0, 12)}`,
    slug,
    title: `Drill ${slug}`,
    description: 'A coach-reviewed prescription.',
    coachName: 'Coach Rivera',
    equipment: ['paddle'],
    difficultyMin: '2.5',
    difficultyMax: '4.5',
    savedAt: '2026-08-27T18:00:00.000Z',
  };
}

function detailFor(slug: string): DrillDetail {
  return {
    ...savedDrill(slug),
    saved: true,
    mappings: [],
    instructionalMedia: [],
  };
}

const planItem: TrainingPlanItem = {
  id: itemId,
  position: 1,
  kind: 'targeted',
  drill: {
    slug: 'contact-shadow',
    title: 'Contact Shadow Reps',
    description: 'A coach-reviewed contact prescription.',
    coachName: 'Coach Rivera',
    equipment: ['paddle'],
    saved: true,
  },
  cueText: 'Meet the ball comfortably in front.',
  targetSets: 3,
  targetRepetitionsPerSet: 8,
  targetDurationSeconds: null,
  restSeconds: 20,
  completion: null,
};

const plan: TrainingPlan = {
  id: '78a7815a-176a-4487-a736-66eb2cc04455',
  status: 'active',
  algorithmVersion: 'reviewed-plan-v1',
  sourceShotId: 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7',
  shotType: 'forehand_drive',
  priorityCheckpoint: 'contact_position',
  priorityDirection: 'late',
  baselineScore: 7.4,
  baselineCheckpointScore: 58,
  reassessmentShotId: null,
  scoreDelta: null,
  createdAt: '2026-08-27T18:00:00.000Z',
  completedAt: null,
  items: [planItem],
};

function fakeApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => [savedDrill('contact-shadow')]),
    getDrill: jest.fn(async (slug: string) => detailFor(slug)),
    saveDrill: jest.fn(async () => undefined),
    unsaveDrill: jest.fn(async () => undefined),
    getCurrentPlan: jest.fn(async () => plan),
    createPlan: jest.fn(async () => plan),
    completeDrill: jest.fn(async evidence => ({
      id: evidence.id,
      completedAt: evidence.completedAt,
      actualRepetitions: evidence.actualRepetitions,
      actualDurationSeconds: evidence.actualDurationSeconds,
      qualifiesForStreak: true,
    })),
    reassessPlan: jest.fn(async (): Promise<TrainingPlan> => plan),
    ...overrides,
  };
}

function httpResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => payload,
  } as Response;
}

afterEach(() => {
  clearTrainingStoreConfiguration();
  mockRecordDrillCompletion.mockClear();
});

describe('S1 — completePlanItem against an unrouted edge endpoint (404)', () => {
  it('HELD: 404 {error:{message:"Unknown endpoint"}} maps to training.request_failed, retryable false, mutation idle', async () => {
    const fetchFn = jest.fn(async () =>
      httpResponse(404, { error: { message: 'Unknown endpoint' } }),
    );
    const api = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn,
    });
    configureTrainingStore(api);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });

    const pending = useTrainingStore.getState().completePlanItem(planItem);
    expect(useTrainingStore.getState().mutation).toBe(`completing:${itemId}`);
    await expect(pending).resolves.toBe(false);

    const state = useTrainingStore.getState();
    expect(state.mutation).toBe('idle');
    expect(state.mutationError).toEqual({
      code: 'training.request_failed',
      message: 'Unknown endpoint',
      retryable: false,
      status: 404,
    });
    // The wire request went out exactly once, to the completions route.
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://api.pickle.test/v1/drill-completions');
    expect(init.method).toBe('POST');
    // Nothing was mirrored into the consistency ledger and the plan item is
    // still open.
    expect(mockRecordDrillCompletion).not.toHaveBeenCalled();
    expect(state.currentPlan?.items[0]?.completion).toBeNull();
    // The store is immediately usable again.
    expect(useTrainingStore.getState().mutation).toBe('idle');
  });

  it('HELD: a 404 with a non-JSON body still returns the mutation to idle (training.invalid_response)', async () => {
    const fetchFn = jest.fn(
      async () =>
        ({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => {
            throw new SyntaxError('Unexpected token <');
          },
        }) as unknown as Response,
    );
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://api.pickle.test',
        token: 'signed-token',
        fetchFn,
      }),
    );
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });
    await expect(
      useTrainingStore.getState().completePlanItem(planItem),
    ).resolves.toBe(false);
    expect(useTrainingStore.getState().mutation).toBe('idle');
    expect(useTrainingStore.getState().mutationError).toMatchObject({
      code: 'training.invalid_response',
      status: null,
    });
    expect(mockRecordDrillCompletion).not.toHaveBeenCalled();
  });

  it('HELD: a 404 whose error body carries a server code keeps that code and stays non-retryable', async () => {
    const fetchFn = jest.fn(async () =>
      httpResponse(404, {
        error: { code: 'plan_item.not_found', message: 'No such item' },
      }),
    );
    configureTrainingStore(
      createTrainingApi({
        baseUrl: 'https://api.pickle.test',
        token: 'signed-token',
        fetchFn,
      }),
    );
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });
    await expect(
      useTrainingStore.getState().completePlanItem(planItem),
    ).resolves.toBe(false);
    expect(useTrainingStore.getState()).toMatchObject({
      mutation: 'idle',
      mutationError: {
        code: 'plan_item.not_found',
        message: 'No such item',
        retryable: false,
        status: 404,
      },
    });
  });
});

describe('S2 — completePlanItem fired twice synchronously for one item', () => {
  it('HELD: the second call returns false without a request; the first mirrors exactly one recordDrillCompletion', async () => {
    const api = fakeApi();
    configureTrainingStore(api);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });

    const store = useTrainingStore.getState();
    const first = store.completePlanItem(planItem);
    const second = store.completePlanItem(planItem);

    // The guard is synchronous: the rejection of the second call is decided
    // before any await.
    expect(api.completeDrill).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toBe(false);
    await expect(first).resolves.toBe(true);
    await flush();

    expect(api.completeDrill).toHaveBeenCalledTimes(1);
    expect(mockRecordDrillCompletion).toHaveBeenCalledTimes(1);
    const evidence = (api.completeDrill as jest.Mock).mock.calls[0]![0] as {
      id: string;
      completedAt: string;
    };
    expect(mockRecordDrillCompletion).toHaveBeenCalledWith({
      id: evidence.id,
      slug: 'contact-shadow',
      title: 'Contact Shadow Reps',
      completedAtIso: evidence.completedAt,
    });
    const state = useTrainingStore.getState();
    expect(state.mutation).toBe('idle');
    expect(state.mutationError).toBeNull();
    expect(state.currentPlan?.items[0]?.completion).toMatchObject({
      id: evidence.id,
      actualRepetitions: 24,
      actualDurationSeconds: null,
    });
  });

  it('HELD: a same-tick burst of 25 calls yields one request and one ledger mirror', async () => {
    const api = fakeApi();
    configureTrainingStore(api);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });
    const results = await Promise.all(
      Array.from({ length: 25 }, () =>
        useTrainingStore.getState().completePlanItem(planItem),
      ),
    );
    await flush();
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results[0]).toBe(true);
    expect(api.completeDrill).toHaveBeenCalledTimes(1);
    expect(mockRecordDrillCompletion).toHaveBeenCalledTimes(1);
  });

  it('BROKEN: a stale item snapshot (completion:null) re-completes an already-completed item — second POST + second ledger mirror', async () => {
    // ResultScreen.confirmCompletion captures `item` in a dialog closure; the
    // store only inspects the ARGUMENT's `completion`, never the plan item
    // currently in state. Once the first completion landed, re-firing with
    // the captured snapshot is accepted as a brand-new completion.
    const api = fakeApi();
    configureTrainingStore(api);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });

    await expect(
      useTrainingStore.getState().completePlanItem(planItem),
    ).resolves.toBe(true);
    expect(
      useTrainingStore.getState().currentPlan?.items[0]?.completion,
    ).not.toBeNull();

    // Same snapshot, sequentially (mutation is idle again).
    await expect(
      useTrainingStore.getState().completePlanItem(planItem),
    ).resolves.toBe(true);
    await flush();

    expect(api.completeDrill).toHaveBeenCalledTimes(2);
    expect(mockRecordDrillCompletion).toHaveBeenCalledTimes(2);
    const ids = (api.completeDrill as jest.Mock).mock.calls.map(
      call => (call[0] as { id: string }).id,
    );
    expect(new Set(ids).size).toBe(2);
    expect(useTrainingStore.getState().mutationError).toBeNull();
  });
});

describe('S3 — configureTrainingStore(apiB) while account A has 2 of 5 getDrill in flight', () => {
  it("HELD: none of A's details (or A's saved list) land after the pending promises settle", async () => {
    const slugsA = ['a-one', 'a-two', 'a-three', 'a-four', 'a-five'];
    const pendingA = new Map<string, Deferred<DrillDetail>>();
    const apiA = fakeApi({
      listSavedDrills: jest.fn(async () => slugsA.map(savedDrill)),
      getDrill: jest.fn((slug: string) => {
        if (slug === 'a-four' || slug === 'a-five') {
          const gate = deferred<DrillDetail>();
          pendingA.set(slug, gate);
          return gate.promise;
        }
        return Promise.resolve(detailFor(slug));
      }),
    });
    configureTrainingStore(apiA);
    const loadA = useTrainingStore.getState().loadSavedDrills();
    await flush();
    expect(apiA.getDrill).toHaveBeenCalledTimes(5);
    expect(pendingA.size).toBe(2);
    expect(useTrainingStore.getState().savedStatus).toBe('loading');

    // Account switch while two of A's detail requests are still pending.
    const apiB = fakeApi({
      listSavedDrills: jest.fn(async () => [savedDrill('b-only')]),
    });
    configureTrainingStore(apiB);
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'idle',
      savedDrills: [],
      drillDetails: {},
    });
    const loadB = useTrainingStore.getState().loadSavedDrills();

    // Let A's stragglers settle: one success, one failure, in that order.
    pendingA.get('a-four')!.resolve(detailFor('a-four'));
    pendingA.get('a-five')!.reject(new Error('late failure from A'));
    await expect(loadA).resolves.toBe(false);
    await expect(loadB).resolves.toBe(true);
    await flush();

    const state = useTrainingStore.getState();
    expect(Object.keys(state.drillDetails).sort()).toEqual(['b-only']);
    expect(state.savedDrills.map(drill => drill.slug)).toEqual(['b-only']);
    expect(state.savedStatus).toBe('ready');
    expect(state.savedError).toBeNull();
    for (const slug of slugsA) {
      expect(state.drillDetails[slug]).toBeUndefined();
    }
  });

  it("HELD: the same switch while A's listSavedDrills itself is pending leaves B untouched, and A's late rejection does not flip B to error", async () => {
    const listA = deferred<SavedDrill[]>();
    const apiA = fakeApi({ listSavedDrills: jest.fn(() => listA.promise) });
    configureTrainingStore(apiA);
    const loadA = useTrainingStore.getState().loadSavedDrills();

    const apiB = fakeApi({
      listSavedDrills: jest.fn(async () => [savedDrill('b-only')]),
    });
    configureTrainingStore(apiB);
    await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
      true,
    );
    listA.reject(new Error('A blew up late'));
    await expect(loadA).resolves.toBe(false);
    await flush();
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'ready',
      savedDrills: [{ slug: 'b-only' }],
      savedError: null,
    });
  });

  it('HELD: clearTrainingStoreConfiguration() mid-flight also discards A and reports unconfigured on the next load', async () => {
    const gate = deferred<DrillDetail>();
    const apiA = fakeApi({
      listSavedDrills: jest.fn(async () => [savedDrill('a-one')]),
      getDrill: jest.fn(() => gate.promise),
    });
    configureTrainingStore(apiA);
    const loadA = useTrainingStore.getState().loadSavedDrills();
    await flush();
    clearTrainingStoreConfiguration();
    gate.resolve(detailFor('a-one'));
    await expect(loadA).resolves.toBe(false);
    expect(useTrainingStore.getState().drillDetails).toEqual({});
    await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
      false,
    );
    expect(useTrainingStore.getState().savedStatus).toBe('unconfigured');
  });
});

describe('S4 — setDrillSaved(slug, true) succeeds but the follow-up listSavedDrills rejects', () => {
  it('BROKEN: savedDrills is wiped to [] with savedStatus error while setDrillSaved still reports true', async () => {
    const api = fakeApi({
      listSavedDrills: jest
        .fn<Promise<SavedDrill[]>, []>()
        .mockResolvedValueOnce([savedDrill('already-saved')])
        .mockRejectedValueOnce(new TypeError('Network request failed')),
    });
    configureTrainingStore(api);
    await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
      true,
    );
    expect(useTrainingStore.getState().savedDrills).toHaveLength(1);
    useTrainingStore.setState(state => ({
      drillDetails: {
        ...state.drillDetails,
        'new-drill': { ...detailFor('new-drill'), saved: false },
      },
    }));

    const result = await useTrainingStore
      .getState()
      .setDrillSaved('new-drill', true);

    expect(api.saveDrill).toHaveBeenCalledWith('new-drill');
    expect(api.listSavedDrills).toHaveBeenCalledTimes(2);
    // The mutation itself is reported as a success…
    expect(result).toBe(true);
    const state = useTrainingStore.getState();
    expect(state.mutation).toBe('idle');
    expect(state.mutationError).toBeNull();
    // …and the detail card flips to saved…
    expect(state.drillDetails['new-drill']?.saved).toBe(true);
    // …but the saved ledger — including the drill that was ALREADY saved and
    // visible a moment ago — is emptied and the section shows "offline".
    expect(state.savedDrills).toEqual([]);
    expect(state.savedStatus).toBe('error');
    expect(state.savedError).toMatchObject({
      code: 'training.unavailable',
      retryable: true,
    });
    expect(state.savedDrills.some(d => d.slug === 'new-drill')).toBe(false);
    expect(state.savedDrills.some(d => d.slug === 'already-saved')).toBe(false);
  });

  it('BROKEN: the mirror image — unsave succeeds, refresh fails — also wipes the remaining saved drills', async () => {
    const api = fakeApi({
      listSavedDrills: jest
        .fn<Promise<SavedDrill[]>, []>()
        .mockResolvedValueOnce([savedDrill('keep-me'), savedDrill('drop-me')])
        .mockRejectedValueOnce(new TypeError('Network request failed')),
    });
    configureTrainingStore(api);
    await useTrainingStore.getState().loadSavedDrills();
    expect(useTrainingStore.getState().savedDrills).toHaveLength(2);
    await expect(
      useTrainingStore.getState().setDrillSaved('drop-me', false),
    ).resolves.toBe(true);
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'error',
      savedDrills: [],
      mutation: 'idle',
    });
  });

  it('HELD: a retry of loadSavedDrills after the failed refresh restores the list including the just-saved drill', async () => {
    const api = fakeApi({
      listSavedDrills: jest
        .fn<Promise<SavedDrill[]>, []>()
        .mockResolvedValueOnce([savedDrill('already-saved')])
        .mockRejectedValueOnce(new TypeError('Network request failed'))
        .mockResolvedValueOnce([
          savedDrill('already-saved'),
          savedDrill('new-drill'),
        ]),
    });
    configureTrainingStore(api);
    await useTrainingStore.getState().loadSavedDrills();
    await useTrainingStore.getState().setDrillSaved('new-drill', true);
    expect(useTrainingStore.getState().savedDrills).toEqual([]);
    await expect(useTrainingStore.getState().loadSavedDrills()).resolves.toBe(
      true,
    );
    expect(
      useTrainingStore
        .getState()
        .savedDrills.map(drill => drill.slug)
        .sort(),
    ).toEqual(['already-saved', 'new-drill']);
    expect(useTrainingStore.getState().savedStatus).toBe('ready');
  });
});

describe('S7 — two loadSavedDrills() under one configuration, first resolves last with an older list', () => {
  it('BROKEN: the stale (older) list overwrites the newer one', async () => {
    const first = deferred<SavedDrill[]>();
    const second = deferred<SavedDrill[]>();
    const responses = [first, second];
    const api = fakeApi({
      listSavedDrills: jest.fn(() => responses.shift()!.promise),
    });
    configureTrainingStore(api);

    const store = useTrainingStore.getState();
    const loadOne = store.loadSavedDrills();
    const loadTwo = store.loadSavedDrills();
    expect(api.listSavedDrills).toHaveBeenCalledTimes(2);

    // Newer request answers first with the newer server state.
    second.resolve([savedDrill('old-drill'), savedDrill('newly-saved')]);
    await expect(loadTwo).resolves.toBe(true);
    expect(
      useTrainingStore.getState().savedDrills.map(drill => drill.slug),
    ).toEqual(['old-drill', 'newly-saved']);

    // Older request answers last with the older server state.
    first.resolve([savedDrill('old-drill')]);
    await expect(loadOne).resolves.toBe(true);

    const state = useTrainingStore.getState();
    expect(state.savedStatus).toBe('ready');
    // Observed: the stale list wins; `newly-saved` vanishes from the ledger.
    expect(state.savedDrills.map(drill => drill.slug)).toEqual(['old-drill']);
    // The detail cache still holds the newer drill — state is now internally
    // inconsistent (detail present, ledger entry gone).
    expect(state.drillDetails['newly-saved']).toBeDefined();
  });

  it('BROKEN (user-visible form): an unsave confirmed by the server is undone by a slow focus-triggered refresh', async () => {
    // LibraryScreen fires loadSavedDrills() on focus; the user taps "Remove"
    // on a saved card while that read is still in flight.
    const focusLoad = deferred<SavedDrill[]>();
    const api = fakeApi({
      listSavedDrills: jest
        .fn<Promise<SavedDrill[]>, []>()
        .mockImplementationOnce(() => focusLoad.promise) // focus read (slow)
        .mockResolvedValueOnce([savedDrill('keep-me')]), // post-unsave refresh
    });
    configureTrainingStore(api);
    useTrainingStore.setState({
      savedStatus: 'ready',
      savedDrills: [savedDrill('keep-me'), savedDrill('remove-me')],
    });

    const focus = useTrainingStore.getState().loadSavedDrills();
    await expect(
      useTrainingStore.getState().setDrillSaved('remove-me', false),
    ).resolves.toBe(true);
    expect(api.unsaveDrill).toHaveBeenCalledWith('remove-me');
    expect(
      useTrainingStore.getState().savedDrills.map(drill => drill.slug),
    ).toEqual(['keep-me']);

    // The slow focus read now answers with the pre-unsave snapshot.
    focusLoad.resolve([savedDrill('keep-me'), savedDrill('remove-me')]);
    await expect(focus).resolves.toBe(true);

    // Observed: the removed drill is resurrected in the saved list.
    expect(
      useTrainingStore.getState().savedDrills.map(drill => drill.slug),
    ).toEqual(['keep-me', 'remove-me']);
    expect(useTrainingStore.getState().savedStatus).toBe('ready');
  });

  it('BROKEN: a late-failing older request flips a fresh ready list to error/[] (seeded interleaving fuzz)', async () => {
    // Seeded: SEED=0x5eed2026. For each round, N in-flight loads settle in a
    // random permutation; the final state always mirrors whichever settled
    // LAST, never whichever was ISSUED last.
    const random = seededRandom(SEED);
    const observations: { round: number; issuedLast: string; final: string }[] =
      [];
    for (let round = 0; round < 12; round += 1) {
      clearTrainingStoreConfiguration();
      const count = 2 + Math.floor(random() * 4); // 2..5 concurrent loads
      const gates = Array.from({ length: count }, () =>
        deferred<SavedDrill[]>(),
      );
      const queue = [...gates];
      const api = fakeApi({
        listSavedDrills: jest.fn(() => queue.shift()!.promise),
      });
      configureTrainingStore(api);
      const loads = gates.map(() =>
        useTrainingStore.getState().loadSavedDrills(),
      );
      const order = gates.map((_, i) => i);
      for (let i = order.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [order[i], order[j]] = [order[j]!, order[i]!];
      }
      let settledLast = -1;
      for (const index of order) {
        if (index === count - 1) {
          gates[index]!.resolve([savedDrill(`list-${index}`)]);
        } else if (random() < 0.3) {
          gates[index]!.reject(new Error(`load ${index} failed late`));
        } else {
          gates[index]!.resolve([savedDrill(`list-${index}`)]);
        }
        // Let this response fully commit before the next one settles, so
        // "settled last" is well defined regardless of microtask depth.
        await flush(16);
        settledLast = index;
      }
      await Promise.all(loads);
      const state = useTrainingStore.getState();
      const final =
        state.savedStatus === 'ready'
          ? state.savedDrills.map(drill => drill.slug).join(',')
          : `${state.savedStatus}:${state.savedDrills.length}`;
      observations.push({
        round,
        issuedLast: `list-${count - 1}`,
        final,
      });
      // Invariant of the CURRENT code: last-settled wins.
      if (state.savedStatus === 'ready') {
        expect(state.savedDrills.map(drill => drill.slug)).toEqual([
          `list-${settledLast}`,
        ]);
      } else {
        expect(state.savedStatus).toBe('error');
        expect(state.savedDrills).toEqual([]);
        expect(settledLast).not.toBe(count - 1);
      }
    }
    // At least one round must show the issued-last list losing, otherwise the
    // fuzz did not exercise the race (seed is fixed, so this is deterministic).
    const lost = observations.filter(o => o.final !== o.issuedLast);
    expect(lost.length).toBeGreaterThan(0);
    console.info(
      `S7 fuzz seed=0x${SEED.toString(16)} rounds=${observations.length} issued-last-lost=${lost.length}`,
      JSON.stringify(observations),
    );
  });

  it('BROKEN (sibling): loadCurrentPlan has the same last-settled-wins race', async () => {
    const first = deferred<TrainingPlan | null>();
    const second = deferred<TrainingPlan | null>();
    const queue = [first, second];
    const api = fakeApi({
      getCurrentPlan: jest.fn(() => queue.shift()!.promise),
    });
    configureTrainingStore(api);
    const loadOne = useTrainingStore.getState().loadCurrentPlan();
    const loadTwo = useTrainingStore.getState().loadCurrentPlan();
    second.resolve({ ...plan, status: 'completed' });
    await expect(loadTwo).resolves.toBe(true);
    expect(useTrainingStore.getState().currentPlan?.status).toBe('completed');
    first.resolve({ ...plan, status: 'active' });
    await expect(loadOne).resolves.toBe(true);
    expect(useTrainingStore.getState().currentPlan?.status).toBe('active');
  });
});

describe('extra — completion racing an account switch', () => {
  it("HELD: a completion that lands after configureTrainingStore(apiB) is dropped and never reaches B's ledger", async () => {
    const gate = deferred<{
      id: string;
      completedAt: string;
      actualRepetitions: number | null;
      actualDurationSeconds: number | null;
      qualifiesForStreak: boolean;
    }>();
    const apiA = fakeApi({ completeDrill: jest.fn(() => gate.promise) });
    configureTrainingStore(apiA);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });
    const pending = useTrainingStore.getState().completePlanItem(planItem);
    expect(useTrainingStore.getState().mutation).toBe(`completing:${itemId}`);

    configureTrainingStore(fakeApi());
    expect(useTrainingStore.getState().mutation).toBe('idle');
    gate.resolve({
      id: 'c0ffee00-0000-4000-8000-000000000001',
      completedAt: '2026-09-04T10:00:00.000Z',
      actualRepetitions: 24,
      actualDurationSeconds: null,
      qualifiesForStreak: true,
    });
    await expect(pending).resolves.toBe(false);
    await flush();
    expect(mockRecordDrillCompletion).not.toHaveBeenCalled();
    expect(useTrainingStore.getState().currentPlan).toBeNull();
    expect(useTrainingStore.getState().mutationError).toBeNull();
  });
});

describe('extra — slug and query encoding at the wire', () => {
  it('HELD: hostile slugs are percent-encoded exactly once on save/unsave/detail paths', async () => {
    const hostile = '../v1/admin?x=1#frag/ü 🥒\\';
    const fetchFn = jest.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? httpResponse(200, { slug: hostile, saved: true })
        : httpResponse(204, null),
    );
    const api = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn,
    });
    await api.saveDrill(hostile);
    await api.unsaveDrill(hostile);
    const urls = fetchFn.mock.calls.map(call => call[0]);
    const encoded = encodeURIComponent(hostile);
    const prefix = 'https://api.pickle.test/v1/me/saved-drills/';
    expect(urls).toEqual([`${prefix}${encoded}`, `${prefix}${encoded}`]);
    for (const url of urls) {
      expect(url).not.toContain('%25');
      expect(url.split('?')).toHaveLength(1);
      expect(url.split('#')).toHaveLength(1);
      expect(url.slice(prefix.length)).not.toContain('/');
      expect(decodeURIComponent(url.slice(prefix.length))).toBe(hostile);
    }
  });
});
