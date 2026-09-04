// The store mirrors finished drills into the consistency ledger (lazily
// required so SQLite never loads here); the double records the calls.
const mockRecordDrillCompletion = jest.fn(async () => undefined);
jest.mock('../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => ({ recordDrillCompletion: mockRecordDrillCompletion }),
  },
}));

import {
  clearTrainingStoreConfiguration,
  configureTrainingStore,
  useTrainingStore,
} from '../src/training/store';
import type {
  DrillDetail,
  SavedDrill,
  TrainingApi,
  TrainingPlan,
} from '../src/training/types';

const sourceShotId = 'b8aece05-d9dc-49eb-af98-54fe0b6e8db7';
const itemId = 'd32bb05c-d72c-42dd-8075-3af93a63e700';

const saved: SavedDrill = {
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

const detail: DrillDetail = {
  ...saved,
  saved: true,
  mappings: [],
  instructionalMedia: [],
};

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
      id: itemId,
      position: 1,
      kind: 'targeted',
      drill: {
        slug: saved.slug,
        title: saved.title,
        description: saved.description,
        coachName: saved.coachName,
        equipment: saved.equipment,
        saved: true,
      },
      cueText: 'Meet the ball comfortably in front.',
      targetSets: 3,
      targetRepetitionsPerSet: 8,
      targetDurationSeconds: null,
      restSeconds: 20,
      completion: null,
    },
    {
      id: '391b4bf2-c9d6-45bb-b471-250651e4e226',
      position: 4,
      kind: 'reassessment',
      drill: null,
      cueText: null,
      targetSets: null,
      targetRepetitionsPerSet: null,
      targetDurationSeconds: null,
      restSeconds: null,
      completion: null,
    },
  ],
};

function fakeApi(overrides: Partial<TrainingApi> = {}): TrainingApi {
  return {
    listSavedDrills: jest.fn(async () => [saved]),
    getDrill: jest.fn(async () => detail),
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
    reassessPlan: jest.fn(async (_planId, shotId): Promise<TrainingPlan> => ({
      ...plan,
      status: 'completed',
      reassessmentShotId: shotId,
      scoreDelta: 0.7,
      completedAt: '2026-08-27T20:00:00.000Z',
    })),
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

afterEach(() => {
  clearTrainingStoreConfiguration();
  mockRecordDrillCompletion.mockClear();
});

describe('real training state', () => {
  it('exposes an explicit unconfigured state instead of local demo drills', async () => {
    clearTrainingStoreConfiguration();
    await useTrainingStore.getState().loadSavedDrills();
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'unconfigured',
      savedDrills: [],
      savedError: { code: 'training.unconfigured', retryable: false },
    });
  });

  it('loads only server-returned saved drills and their reviewed detail', async () => {
    configureTrainingStore(fakeApi());
    await useTrainingStore.getState().loadSavedDrills();
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'ready',
      savedDrills: [{ slug: 'contact-shadow' }],
      drillDetails: { 'contact-shadow': { coachName: 'Coach Rivera' } },
    });
  });

  it('creates a canonical plan and records the prescribed real repetition count', async () => {
    const api = fakeApi();
    configureTrainingStore(api);
    await useTrainingStore.getState().createPlan(sourceShotId);
    const item = useTrainingStore.getState().currentPlan!.items[0]!;
    await useTrainingStore.getState().completePlanItem(item);
    expect(api.createPlan).toHaveBeenCalledWith(sourceShotId);
    expect(api.completeDrill).toHaveBeenCalledWith(
      expect.objectContaining({
        drillSlug: 'contact-shadow',
        trainingPlanItemId: itemId,
        actualRepetitions: 24,
        actualDurationSeconds: null,
      }),
    );
    expect(
      useTrainingStore.getState().currentPlan?.items[0]?.completion,
    ).toMatchObject({ qualifiesForStreak: true, actualRepetitions: 24 });
    // The finished drill lands in the consistency ledger so the training
    // day counts toward the streak.
    expect(mockRecordDrillCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: 'contact-shadow',
        title: 'Contact Shadow Reps',
      }),
    );
  });

  it('keeps non-qualifying drill completions out of the streak ledger', async () => {
    const api = fakeApi({
      completeDrill: jest.fn(async evidence => ({
        id: evidence.id,
        completedAt: evidence.completedAt,
        actualRepetitions: evidence.actualRepetitions,
        actualDurationSeconds: evidence.actualDurationSeconds,
        qualifiesForStreak: false,
      })),
    });
    configureTrainingStore(api);
    await useTrainingStore.getState().createPlan(sourceShotId);
    const item = useTrainingStore.getState().currentPlan!.items[0]!;
    await useTrainingStore.getState().completePlanItem(item);
    expect(mockRecordDrillCompletion).not.toHaveBeenCalled();
  });

  it('sends reassessment to the server and keeps its comparable score delta', async () => {
    const api = fakeApi();
    configureTrainingStore(api);
    await useTrainingStore.getState().loadCurrentPlan();
    const shotId = '9c32cbd4-b6aa-491a-b23f-2f982eabb380';
    await useTrainingStore.getState().reassessCurrentPlan(shotId);
    expect(api.reassessPlan).toHaveBeenCalledWith(plan.id, shotId);
    expect(useTrainingStore.getState().currentPlan).toMatchObject({
      status: 'completed',
      reassessmentShotId: shotId,
      scoreDelta: 0.7,
    });
  });

  it('keeps the remaining saved drills when the refresh after a server-accepted unsave fails transiently', async () => {
    const other: SavedDrill = {
      ...saved,
      id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
      slug: 'dink-ladder',
      title: 'Dink Target Ladder',
    };
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([saved, other])
      .mockRejectedValueOnce(new Error('network down'));
    const api = fakeApi({ listSavedDrills });
    configureTrainingStore(api);
    await useTrainingStore.getState().loadSavedDrills();

    const result = await useTrainingStore
      .getState()
      .setDrillSaved(saved.slug, false);

    expect(api.unsaveDrill).toHaveBeenCalledWith(saved.slug);
    expect(result).toBe(true);
    expect(useTrainingStore.getState()).toMatchObject({
      mutation: 'idle',
      savedStatus: 'ready',
      savedDrills: [{ slug: other.slug }],
      savedError: null,
    });
  });

  it('a failed cold load still reports the error state (nothing valid to keep)', async () => {
    configureTrainingStore(
      fakeApi({
        listSavedDrills: jest.fn(async () => {
          throw new Error('network down');
        }),
      }),
    );
    const result = await useTrainingStore.getState().loadSavedDrills();
    expect(result).toBe(false);
    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'error',
      savedDrills: [],
      savedError: { code: 'training.unavailable', retryable: true },
    });
  });

  it('overlapping saved-drill reloads settle newest-wins, not in arrival order', async () => {
    const other: SavedDrill = {
      ...saved,
      id: '0b96363e-4a11-47c5-9d2c-3f5b8e6f2a17',
      slug: 'dink-ladder',
    };
    const pending: Array<(value: SavedDrill[]) => void> = [];
    const listSavedDrills = jest
      .fn<Promise<SavedDrill[]>, []>()
      .mockResolvedValueOnce([saved, other])
      .mockImplementation(
        () => new Promise<SavedDrill[]>(resolve => pending.push(resolve)),
      );
    configureTrainingStore(fakeApi({ listSavedDrills }));
    await useTrainingStore.getState().loadSavedDrills();

    const unsaveFirst = useTrainingStore
      .getState()
      .setDrillSaved(saved.slug, false);
    await flush();
    const unsaveSecond = useTrainingStore
      .getState()
      .setDrillSaved(other.slug, false);
    await flush();
    expect(pending).toHaveLength(2);

    // The later reload (server truth: nothing saved) arrives first; the
    // earlier one (server truth then: [other]) must not resurrect it.
    pending[1]!([]);
    await flush();
    pending[0]!([other]);
    await Promise.all([unsaveFirst, unsaveSecond]);

    expect(useTrainingStore.getState()).toMatchObject({
      savedStatus: 'ready',
      savedDrills: [],
      savedError: null,
    });
  });

  it('a stale plan load does not overwrite a newer plan load under the same configuration', async () => {
    const pending: Array<(value: TrainingPlan | null) => void> = [];
    configureTrainingStore(
      fakeApi({
        getCurrentPlan: jest.fn(
          () =>
            new Promise<TrainingPlan | null>(resolve => pending.push(resolve)),
        ),
      }),
    );
    const first = useTrainingStore.getState().loadCurrentPlan();
    const second = useTrainingStore.getState().loadCurrentPlan();
    expect(pending).toHaveLength(2);
    pending[1]!(null);
    await flush();
    pending[0]!(plan);
    await Promise.all([first, second]);
    expect(useTrainingStore.getState()).toMatchObject({
      planStatus: 'ready',
      currentPlan: null,
      planError: null,
    });
  });

  it('a stale plan load does not overwrite a plan the user just created', async () => {
    let resolveLoad!: (value: TrainingPlan | null) => void;
    configureTrainingStore(
      fakeApi({
        getCurrentPlan: jest.fn(
          () =>
            new Promise<TrainingPlan | null>(resolve => {
              resolveLoad = resolve;
            }),
        ),
      }),
    );
    const loading = useTrainingStore.getState().loadCurrentPlan();
    await useTrainingStore.getState().createPlan(sourceShotId);
    expect(useTrainingStore.getState().currentPlan?.id).toBe(plan.id);
    resolveLoad(null);
    await loading;
    expect(useTrainingStore.getState()).toMatchObject({
      planStatus: 'ready',
      currentPlan: { id: plan.id },
    });
  });

  it('does not let a previous account repopulate training after reconfiguration', async () => {
    let resolvePrevious!: (value: TrainingPlan | null) => void;
    const previousPlan = new Promise<TrainingPlan | null>(resolve => {
      resolvePrevious = resolve;
    });
    configureTrainingStore(
      fakeApi({ getCurrentPlan: jest.fn(() => previousPlan) }),
    );

    const loading = useTrainingStore.getState().loadCurrentPlan();
    configureTrainingStore(
      fakeApi({ getCurrentPlan: jest.fn(async () => null) }),
    );
    resolvePrevious(plan);
    await loading;

    expect(useTrainingStore.getState()).toMatchObject({
      planStatus: 'idle',
      currentPlan: null,
      planError: null,
    });
  });
});
