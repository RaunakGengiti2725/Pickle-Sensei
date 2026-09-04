// Structural audit #2 (pass 1) — training store concurrency/error handling.
// Each `REPRO:` case asserts the behaviour the store SHOULD have; a failing
// REPRO case on 4d812e1a is the evidence for the corresponding finding.
// `VERIFY:` cases pin behaviour that was checked and holds.
const mockRecordDrillCompletion = jest.fn(async () => undefined);
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../src/training/store';
import { createTrainingApi } from '../../src/training/api';
import {
  TrainingError,
  type DrillDetail,
  type SavedDrill,
  type TrainingApi,
  type TrainingPlan,
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

const savedA: SavedDrill = {
  id: '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
  slug: 'contact-shadow',
  title: 'Contact Shadow Reps',
  description: 'A coach-reviewed contact prescription.',
  coachName: 'Coach Rivera',
  equipment: ['paddle'],
  difficultyMin: '2.5',
  difficultyMax: '4.5',
  savedAt: '2026-08-27T18:00:00.000Z',
};

const savedB: SavedDrill = {
  ...savedA,
  id: '9d0a1c9e-2f65-4b7a-8c3d-6e5f4a3b2c1d',
  slug: 'volley-wall-intervals',
  title: 'Volley Wall Intervals',
  savedAt: '2026-08-27T17:00:00.000Z',
};

function detailFor(drill: SavedDrill): DrillDetail {
  return { ...drill, saved: true, mappings: [], instructionalMedia: [] };
}

const sourceShotId = 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7';
const plan: TrainingPlan = {
  id: '78a7815a-176a-4487-a736-66eb2cc04455',
  status: 'active',
  algorithmVersion: 'reviewed-plan-v1',
  sourceShotId,
  shotType: 'forehand_drive',
  priorityCheckpoint: 'contact_position',
  priorityDirection: 'late',
  baselineScore: 7.4,
  baselineCheckpointScore: 58,
  reassessmentShotId: null,
  scoreDelta: null,
  createdAt: '2026-08-27T18:00:00.000Z',
  completedAt: null,
  items: [
    {
      id: 'd32bb05c-d72c-42dd-8075-3af93a63e700',
      position: 1,
      kind: 'targeted',
      drill: {
        slug: savedA.slug,
        title: savedA.title,
        description: savedA.description,
        coachName: savedA.coachName,
        equipment: savedA.equipment,
        saved: true,
      },
      cueText: 'Meet the ball comfortably in front.',
      targetSets: 3,
      targetRepetitionsPerSet: 8,
      targetDurationSeconds: null,
      restSeconds: 20,
      completion: null,
    },
  ],
};

function fakeApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => [savedA, savedB]),
    getDrill: jest.fn(async slug =>
      detailFor(slug === savedA.slug ? savedA : savedB),
    ),
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
    reassessPlan: jest.fn(async () => plan),
    ...overrides,
  };
}

afterEach(() => {
  clearTrainingStoreConfiguration();
  mockRecordDrillCompletion.mockClear();
});

describe('training store — structural audit #2', () => {
  it('REPRO: a transient reload failure right after a server-accepted unsave wipes the remaining saved drills (store.ts:306)', async () => {
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([savedA, savedB])
      .mockRejectedValueOnce(
        new TrainingError('training.unavailable', 'Offline for a moment', true),
      );
    const api = fakeApi({ listSavedDrills });
    configureTrainingStore(api);
    await useTrainingStore.getState().loadSavedDrills();
    expect(useTrainingStore.getState().savedDrills).toHaveLength(2);

    const ok = await useTrainingStore
      .getState()
      .setDrillSaved(savedB.slug, false);
    expect(api.unsaveDrill).toHaveBeenCalledWith(savedB.slug);
    // The server accepted the mutation and the store reports success…
    expect(ok).toBe(true);
    // …so the drill that was NOT touched must still be listed. Only the
    // reload's own error may be surfaced.
    expect(useTrainingStore.getState().savedDrills).toEqual([savedA]);
  });

  it('REPRO: two overlapping loadSavedDrills under ONE configuration commit in settle order, so a stale list re-adds an unsaved drill (store.ts:112-149)', async () => {
    const first = deferred<SavedDrill[]>();
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      // #1: focus-effect load that stays in flight (slow network)…
      .mockImplementationOnce(() => first.promise)
      // #2: the reload issued by setDrillSaved after the DELETE succeeded.
      .mockResolvedValueOnce([savedA]);
    const api = fakeApi({ listSavedDrills });
    configureTrainingStore(api);

    const slowLoad = useTrainingStore.getState().loadSavedDrills();
    const ok = await useTrainingStore
      .getState()
      .setDrillSaved(savedB.slug, false);
    expect(ok).toBe(true);
    expect(useTrainingStore.getState().savedDrills).toEqual([savedA]);

    // The stale response (captured BEFORE the unsave) settles last.
    first.resolve([savedA, savedB]);
    await slowLoad;
    expect(api.unsaveDrill).toHaveBeenCalledTimes(1);
    expect(useTrainingStore.getState().savedStatus).toBe('ready');
    // The server no longer has savedB; the store must not resurrect it.
    expect(useTrainingStore.getState().savedDrills).toEqual([savedA]);
  });

  it('VERIFY: a code-less 404 from the edge fn (unrouted POST /v1/drill-completions) surfaces as a non-retryable request_failed with status 404', async () => {
    const fetchFn = jest.fn(
      async () =>
        ({
          ok: false,
          status: 404,
          statusText: 'Not Found',
          json: async () => ({
            error: {
              message: 'Unknown endpoint: POST /v1/drill-completions.',
            },
          }),
        }) as Response,
    );
    const api = createTrainingApi({
      baseUrl: 'https://api.pickle.test',
      token: 'signed-token',
      fetchFn,
    });
    configureTrainingStore(api);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });
    const ok = await useTrainingStore
      .getState()
      .completePlanItem(plan.items[0]!);
    expect(ok).toBe(false);
    expect(useTrainingStore.getState()).toMatchObject({
      mutation: 'idle',
      mutationError: {
        code: 'training.request_failed',
        retryable: false,
        status: 404,
        message: 'Unknown endpoint: POST /v1/drill-completions.',
      },
    });
    expect(mockRecordDrillCompletion).not.toHaveBeenCalled();
    // The plan item is NOT marked complete on a failed request.
    expect(useTrainingStore.getState().currentPlan?.items[0]?.completion).toBe(
      null,
    );
  });

  it('VERIFY: a slow consistency-ledger write never blocks or undoes a server-accepted completion', async () => {
    const ledgerWrite = deferred<undefined>();
    mockRecordDrillCompletion.mockImplementationOnce(() => ledgerWrite.promise);
    const api = fakeApi();
    configureTrainingStore(api);
    useTrainingStore.setState({ currentPlan: plan, planStatus: 'ready' });
    const ok = await useTrainingStore
      .getState()
      .completePlanItem(plan.items[0]!);
    // The mutation settled while the ledger write is still pending.
    expect(ok).toBe(true);
    expect(mockRecordDrillCompletion).toHaveBeenCalledTimes(1);
    expect(
      useTrainingStore.getState().currentPlan?.items[0]?.completion,
    ).toMatchObject({ qualifiesForStreak: true });
    expect(useTrainingStore.getState()).toMatchObject({
      mutation: 'idle',
      mutationError: null,
    });
    ledgerWrite.resolve(undefined);
  });

  it('VERIFY: detail failures never drop a saved drill from the list (orphaned bookmark keeps its card)', async () => {
    const api = fakeApi({
      getDrill: jest.fn(async slug => {
        if (slug === savedB.slug) {
          throw new TrainingError(
            'drill.not_found',
            'This drill is not in the catalog.',
            false,
            404,
          );
        }
        return detailFor(savedA);
      }),
    });
    configureTrainingStore(api);
    await useTrainingStore.getState().loadSavedDrills();
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'ready',
      savedDrills: [{ slug: savedA.slug }, { slug: savedB.slug }],
    });
    expect(
      useTrainingStore.getState().drillDetails[savedB.slug],
    ).toBeUndefined();
  });

  it('VERIFY: a save that completes after reconfiguration never touches the new configuration', async () => {
    const save = deferred<void>();
    const api = fakeApi({
      saveDrill: jest.fn(() => save.promise),
      listSavedDrills: jest.fn(async () => [savedA, savedB]),
    });
    configureTrainingStore(api);
    const pending = useTrainingStore
      .getState()
      .setDrillSaved(savedB.slug, true);
    clearTrainingStoreConfiguration();
    const next = fakeApi({ listSavedDrills: jest.fn(async () => []) });
    configureTrainingStore(next);
    save.resolve();
    expect(await pending).toBe(false);
    expect(next.listSavedDrills).not.toHaveBeenCalled();
    expect(useTrainingStore.getState().savedDrills).toEqual([]);
    expect(useTrainingStore.getState().mutation).toBe('idle');
  });
});
