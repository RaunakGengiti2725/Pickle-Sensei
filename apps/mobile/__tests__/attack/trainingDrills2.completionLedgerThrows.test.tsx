import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

/**
 * ADVERSARIAL PASS 3 — mobile-training-drills, scenario S4.
 *
 * Attack: `useConsistencyStore.getState().recordDrillCompletion` throws
 * SYNCHRONOUSLY (the real implementation is async and can only reject, so
 * this models a broken consistency module — e.g. the lazy `require` pulling
 * in a native SQLite binding that is unavailable in the host — or a future
 * refactor that throws before the first await).
 *
 * The contract under test: the server already accepted the completion and
 * the store already wrote `completion` onto the plan item, so
 * `completePlanItem` must still resolve `true`, the item must render as
 * completed, and no mutation error may be surfaced for a ledger mirror the
 * store itself documents as fire-and-forget.
 */

const mockRecordDrillCompletion = jest.fn<Promise<void>, [unknown]>();
let mockGetStateThrows = false;
jest.mock('../../src/consistency/store', () => ({
  useConsistencyStore: {
    getState: () => {
      if (mockGetStateThrows) {
        throw new Error('consistency store is not available on this host');
      }
      return {
        recordDrillCompletion: (record: unknown) =>
          mockRecordDrillCompletion(record),
      };
    },
  },
}));

import { PlanDrillCard } from '../../src/training/components';
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
    reassessPlan: jest.fn(async () => plan),
    ...overrides,
  };
}

function renderCard(item: TrainingPlanItem) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <PlanDrillCard
        item={item}
        detail={detail}
        busy={false}
        onToggleSaved={jest.fn()}
        onConfirmComplete={jest.fn()}
        onOpenMedia={jest.fn()}
      />,
    );
  });
  return renderer;
}

function cardText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAll(n => typeof n.type === 'string' && /Text$/.test(n.type))
    .flatMap(n => {
      const children = n.props.children;
      return Array.isArray(children) ? children : [children];
    })
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function completionButton(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      typeof node.props.accessibilityLabel === 'string' &&
      /completion/i.test(node.props.accessibilityLabel),
  );
  return node ?? null;
}

async function completeFirstItem(): Promise<boolean> {
  await useTrainingStore.getState().loadCurrentPlan();
  const item = useTrainingStore.getState().currentPlan!.items[0]!;
  return useTrainingStore.getState().completePlanItem(item);
}

describe('S4 — consistency ledger mirror throws synchronously', () => {
  beforeEach(() => {
    mockGetStateThrows = false;
    mockRecordDrillCompletion.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    clearTrainingStoreConfiguration();
  });

  it('control: with a healthy ledger, completePlanItem resolves true and clears the mutation', async () => {
    configureTrainingStore(fakeApi());
    await expect(completeFirstItem()).resolves.toBe(true);
    expect(useTrainingStore.getState()).toMatchObject({
      mutation: 'idle',
      mutationError: null,
    });
    expect(
      useTrainingStore.getState().currentPlan?.items[0]?.completion,
    ).toMatchObject({ qualifiesForStreak: true, actualRepetitions: 24 });
  });

  it('recordDrillCompletion throws synchronously → still true, no mutation error, item completed', async () => {
    mockRecordDrillCompletion.mockImplementation(() => {
      throw new Error('ledger exploded synchronously');
    });
    const api = fakeApi();
    configureTrainingStore(api);
    const result = await completeFirstItem();
    const state = useTrainingStore.getState();
    const item = state.currentPlan!.items[0]!;

    // Server evidence was accepted and applied to the plan item…
    expect(api.completeDrill).toHaveBeenCalledTimes(1);
    expect(item.completion).toMatchObject({
      qualifiesForStreak: true,
      actualRepetitions: 24,
    });
    // …so the item renders as completed regardless of the ledger.
    const renderer = renderCard(item);
    expect(cardText(renderer)).toContain('Completed · streak credit earned');
    expect(completionButton(renderer)?.props.accessibilityLabel).toBe(
      `${saved.title} completion logged`,
    );
    act(() => renderer.unmount());

    // The fire-and-forget ledger mirror must not turn a successful
    // completion into a failure or surface a mutation error.
    expect(state.mutation).toBe('idle');
    expect({ result, mutationError: state.mutationError }).toEqual({
      result: true,
      mutationError: null,
    });
  });

  it('useConsistencyStore.getState() itself throwing → still true and no mutation error', async () => {
    mockGetStateThrows = true;
    configureTrainingStore(fakeApi());
    const result = await completeFirstItem();
    const state = useTrainingStore.getState();
    expect(state.currentPlan?.items[0]?.completion).not.toBeNull();
    expect(state.mutation).toBe('idle');
    expect({ result, mutationError: state.mutationError }).toEqual({
      result: true,
      mutationError: null,
    });
  });

  it('a REJECTING (async) ledger mirror is harmless — pins the intended fire-and-forget contract', async () => {
    // The store fires the mirror with `void` and never attaches a handler,
    // so a raw rejected promise would surface as an unhandled rejection in
    // the host; handle it here so this test observes only the store's state.
    mockRecordDrillCompletion.mockImplementation(() => {
      const rejected = Promise.reject(new Error('async failure'));
      rejected.catch(() => undefined);
      return rejected;
    });
    configureTrainingStore(fakeApi());
    await expect(completeFirstItem()).resolves.toBe(true);
    // Let the rejected promise settle; nothing may leak into the store.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(useTrainingStore.getState()).toMatchObject({
      mutation: 'idle',
      mutationError: null,
    });
  });

  it('after a synchronous ledger throw the store is not wedged: the next mutation can proceed', async () => {
    mockRecordDrillCompletion.mockImplementationOnce(() => {
      throw new Error('ledger exploded synchronously');
    });
    configureTrainingStore(fakeApi());
    await completeFirstItem();
    // `mutation` must be idle or every later completion/save is refused.
    expect(useTrainingStore.getState().mutation).toBe('idle');
  });
});
