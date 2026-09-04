/**
 * STRUCTURAL AUDIT #1 — training store: post-mutation reload and same-
 * configuration load ordering (apps/mobile/src/training/store.ts).
 *
 * Each test states the invariant the store SHOULD hold. A failing test is a
 * reproduced defect on the audited commit, not a broken test. Nothing here
 * modifies production code or existing suites.
 */
const mockRecordDrillCompletion = jest.fn(async () => undefined);
jest.mock('../../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../../../src/training/store';
import {
  TrainingError,
  type DrillDetail,
  type SavedDrill,
  type TrainingApi,
  type TrainingPlan,
} from '../../../src/training/types';

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

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

function savedDrill(slug: string, id: string): SavedDrill {
  return {
    id,
    slug,
    title: `Drill ${slug}`,
    description: 'Coach-reviewed prescription.',
    coachName: 'Coach Rivera',
    equipment: ['paddle'],
    difficultyMin: null,
    difficultyMax: null,
    savedAt: '2026-08-27T18:00:00.000Z',
  };
}

const drillA = savedDrill(
  'contact-shadow',
  '80184be3-3e97-4eaf-8d8e-55fa214fe6de',
);
const drillB = savedDrill(
  'dink-ladder',
  '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
);

function detailFor(drill: SavedDrill): DrillDetail {
  return { ...drill, saved: true, mappings: [], instructionalMedia: [] };
}

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
  items: [],
};

function fakeApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => [drillA, drillB]),
    getDrill: jest.fn(async (slug: string) =>
      detailFor(slug === drillA.slug ? drillA : drillB),
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

const transient = () =>
  new TrainingError('training.unavailable', 'Training is offline.', true);

describe('training store — post-mutation reload (store.ts setDrillSaved → loadSavedDrills)', () => {
  afterEach(() => {
    clearTrainingStoreConfiguration();
  });

  it('keeps the remaining saved drills when the follow-up reload after a successful unsave fails', async () => {
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([drillA, drillB])
      .mockRejectedValueOnce(transient());
    configureTrainingStore(fakeApi({ listSavedDrills }));
    await useTrainingStore.getState().loadSavedDrills();
    expect(useTrainingStore.getState().savedDrills.map(d => d.slug)).toEqual([
      drillA.slug,
      drillB.slug,
    ]);

    const result = await useTrainingStore
      .getState()
      .setDrillSaved(drillA.slug, false);
    const state = useTrainingStore.getState();

    // The server accepted the unsave; drill B is still saved server-side.
    expect(result).toBe(true);
    expect(state.savedDrills.map(d => d.slug)).toEqual([drillB.slug]);
    expect(state.savedStatus).toBe('ready');
    expect(state.savedError).toBeNull();
  });

  it('does not report a successful save while the store shows an error and an empty list', async () => {
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([drillA])
      .mockRejectedValueOnce(transient());
    configureTrainingStore(fakeApi({ listSavedDrills }));
    await useTrainingStore.getState().loadSavedDrills();

    const result = await useTrainingStore
      .getState()
      .setDrillSaved(drillB.slug, true);
    const state = useTrainingStore.getState();

    // Either the call reports failure, or the state reflects the success —
    // never "true" with an error banner and zero saved drills.
    const consistent =
      result === false ||
      (state.savedStatus === 'ready' && state.savedDrills.length >= 1);
    expect({
      result,
      savedStatus: state.savedStatus,
      savedDrills: state.savedDrills.map(d => d.slug),
      consistent,
    }).toEqual(expect.objectContaining({ consistent: true }));
  });

  it('never drops a non-empty saved list into the loading state during a successful unsave', async () => {
    configureTrainingStore(fakeApi());
    await useTrainingStore.getState().loadSavedDrills();
    const statuses: string[] = [];
    const unsubscribe = useTrainingStore.subscribe(state => {
      statuses.push(`${state.savedStatus}:${state.savedDrills.length}`);
    });
    await useTrainingStore.getState().setDrillSaved(drillA.slug, false);
    unsubscribe();
    // LibraryScreen renders <LoadingState/> INSTEAD of the list whenever
    // savedStatus === 'loading' (LibraryScreen.tsx:298), so a 'loading' hop
    // with a non-empty list is a visible flash of the whole saved section.
    expect(statuses.filter(s => s.startsWith('loading:'))).toEqual([]);
  });
});

describe('training store — overlapping loads under the SAME configuration', () => {
  afterEach(() => {
    clearTrainingStoreConfiguration();
  });

  it('two quick unsaves: the older reload settling last must not resurrect the second unsaved drill', async () => {
    const reloads: Deferred<SavedDrill[]>[] = [];
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([drillA, drillB])
      .mockImplementation(() => {
        const d = deferred<SavedDrill[]>();
        reloads.push(d);
        return d.promise;
      });
    configureTrainingStore(fakeApi({ listSavedDrills }));
    await useTrainingStore.getState().loadSavedDrills();

    // Unsave A: the mutation resolves, the reload (#1) stays in flight.
    const unsaveA = useTrainingStore
      .getState()
      .setDrillSaved(drillA.slug, false);
    await flush();
    expect(reloads).toHaveLength(1);
    // `mutation` is already idle, so the UI lets the user unsave B too.
    expect(useTrainingStore.getState().mutation).toBe('idle');
    const unsaveB = useTrainingStore
      .getState()
      .setDrillSaved(drillB.slug, false);
    await flush();
    expect(reloads).toHaveLength(2);

    // Server truth: reload #1 was issued before B was unsaved → [B];
    // reload #2 after → []. Network reorders them: #2 lands first.
    reloads[1]!.resolve([]);
    await flush();
    reloads[0]!.resolve([drillB]);
    await Promise.all([unsaveA, unsaveB]);

    const state = useTrainingStore.getState();
    expect(state.savedStatus).toBe('ready');
    expect(state.savedDrills.map(d => d.slug)).toEqual([]);
  });

  it('overlapping loadSavedDrills calls settle in issue order (newest wins)', async () => {
    const loads: Deferred<SavedDrill[]>[] = [];
    configureTrainingStore(
      fakeApi({
        listSavedDrills: jest.fn(() => {
          const d = deferred<SavedDrill[]>();
          loads.push(d);
          return d.promise;
        }),
      }),
    );
    const first = useTrainingStore.getState().loadSavedDrills();
    const second = useTrainingStore.getState().loadSavedDrills();
    await flush();
    expect(loads).toHaveLength(2);
    loads[1]!.resolve([drillB]);
    await flush();
    loads[0]!.resolve([drillA, drillB]);
    await Promise.all([first, second]);
    expect(useTrainingStore.getState().savedDrills.map(d => d.slug)).toEqual([
      drillB.slug,
    ]);
  });

  it('overlapping loadCurrentPlan calls settle in issue order (newest wins)', async () => {
    const loads: Deferred<TrainingPlan | null>[] = [];
    configureTrainingStore(
      fakeApi({
        getCurrentPlan: jest.fn(() => {
          const d = deferred<TrainingPlan | null>();
          loads.push(d);
          return d.promise;
        }),
      }),
    );
    const first = useTrainingStore.getState().loadCurrentPlan();
    const second = useTrainingStore.getState().loadCurrentPlan();
    await flush();
    expect(loads).toHaveLength(2);
    // Newest truth: the plan was completed/cleared server-side.
    loads[1]!.resolve(null);
    await flush();
    loads[0]!.resolve(plan);
    await Promise.all([first, second]);
    expect(useTrainingStore.getState().currentPlan).toBeNull();
  });
});
