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
