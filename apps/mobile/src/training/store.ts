import { create } from 'zustand';
import { makeUuid } from '../util/uuid';
import {
  TrainingError,
  type DrillDetail,
  type SavedDrill,
  type TrainingApi,
  type TrainingErrorState,
  type TrainingLoadStatus,
  type TrainingPlan,
  type TrainingPlanItem,
} from './types';

export type TrainingMutation =
  | 'idle'
  | 'creating-plan'
  | 'reassessing'
  | `saving:${string}`
  | `completing:${string}`;

export interface TrainingStoreState {
  savedStatus: TrainingLoadStatus;
  planStatus: TrainingLoadStatus;
  mutation: TrainingMutation;
  savedDrills: SavedDrill[];
  drillDetails: Record<string, DrillDetail>;
  currentPlan: TrainingPlan | null;
  savedError: TrainingErrorState | null;
  planError: TrainingErrorState | null;
  mutationError: TrainingErrorState | null;
  loadSavedDrills(): Promise<boolean>;
  loadCurrentPlan(): Promise<boolean>;
  createPlan(sourceShotId: string): Promise<boolean>;
  reassessCurrentPlan(shotId: string): Promise<boolean>;
  setDrillSaved(slug: string, saved: boolean): Promise<boolean>;
  completePlanItem(item: TrainingPlanItem): Promise<boolean>;
  clearMutationError(): void;
  reset(): void;
}

let trainingApi: TrainingApi | null = null;
let trainingConfigurationVersion = 0;

function isCurrentConfiguration(api: TrainingApi, version: number): boolean {
  return trainingApi === api && trainingConfigurationVersion === version;
}

const defaults = () => ({
  savedStatus: 'idle' as TrainingLoadStatus,
  planStatus: 'idle' as TrainingLoadStatus,
  mutation: 'idle' as TrainingMutation,
  savedDrills: [] as SavedDrill[],
  drillDetails: {} as Record<string, DrillDetail>,
  currentPlan: null as TrainingPlan | null,
  savedError: null as TrainingErrorState | null,
  planError: null as TrainingErrorState | null,
  mutationError: null as TrainingErrorState | null,
});

function toError(error: unknown): TrainingError {
  if (error instanceof TrainingError) return error;
  return new TrainingError(
    'training.unavailable',
    'Training is temporarily unavailable.',
    true,
  );
}

function statusFor(error: TrainingError): TrainingLoadStatus {
  return error.code === 'training.unconfigured' ? 'unconfigured' : 'error';
}

function missingApi(): TrainingError {
  return new TrainingError(
    'training.unconfigured',
    'Connect a synced account to load saved drills and personalized plans.',
    false,
  );
}

async function loadDetails(
  api: TrainingApi,
  slugs: string[],
): Promise<Record<string, DrillDetail>> {
  const unique = [...new Set(slugs)];
  const settled = await Promise.allSettled(
    unique.map(async slug => [slug, await api.getDrill(slug)] as const),
  );
  const details: Record<string, DrillDetail> = {};
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      details[result.value[0]] = result.value[1];
    }
  }
  return details;
}

function withPlanItem(
  plan: TrainingPlan,
  itemId: string,
  update: (item: TrainingPlanItem) => TrainingPlanItem,
): TrainingPlan {
  return {
    ...plan,
    items: plan.items.map(item => (item.id === itemId ? update(item) : item)),
  };
}

export const useTrainingStore = create<TrainingStoreState>((set, get) => ({
  ...defaults(),

  loadSavedDrills: async () => {
    const api = trainingApi;
    if (!api) {
      const error = missingApi();
      set({
        savedStatus: 'unconfigured',
        savedDrills: [],
        savedError: error.toState(),
      });
      return false;
    }
    const version = trainingConfigurationVersion;
    set({ savedStatus: 'loading', savedError: null });
    try {
      const savedDrills = await api.listSavedDrills();
      const drillDetails = await loadDetails(
        api,
        savedDrills.map(drill => drill.slug),
      );
      if (!isCurrentConfiguration(api, version)) return false;
      set(state => ({
        savedStatus: 'ready',
        savedDrills,
        drillDetails: { ...state.drillDetails, ...drillDetails },
        savedError: null,
      }));
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(api, version)) return false;
      const error = toError(cause);
      set({
        savedStatus: statusFor(error),
        savedDrills: [],
        savedError: error.toState(),
      });
      return false;
    }
  },

  loadCurrentPlan: async () => {
    const api = trainingApi;
    if (!api) {
      const error = missingApi();
      set({
        planStatus: 'unconfigured',
        currentPlan: null,
        planError: error.toState(),
      });
      return false;
    }
    const version = trainingConfigurationVersion;
    set({ planStatus: 'loading', planError: null });
    try {
      const currentPlan = await api.getCurrentPlan();
      const details = currentPlan
        ? await loadDetails(
            api,
            currentPlan.items.flatMap(item =>
              item.drill ? [item.drill.slug] : [],
            ),
          )
        : {};
      if (!isCurrentConfiguration(api, version)) return false;
      set(state => ({
        planStatus: 'ready',
        currentPlan,
        drillDetails: { ...state.drillDetails, ...details },
        planError: null,
      }));
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(api, version)) return false;
      const error = toError(cause);
      set({
        planStatus: statusFor(error),
        currentPlan: null,
        planError: error.toState(),
      });
      return false;
    }
  },

  createPlan: async sourceShotId => {
    if (get().mutation !== 'idle') return false;
    const api = trainingApi;
    if (!api) {
      const error = missingApi();
      set({ mutationError: error.toState() });
      return false;
    }
    const version = trainingConfigurationVersion;
    set({ mutation: 'creating-plan', mutationError: null });
    try {
      const currentPlan = await api.createPlan(sourceShotId);
      const details = await loadDetails(
        api,
        currentPlan.items.flatMap(item =>
          item.drill ? [item.drill.slug] : [],
        ),
      );
      if (!isCurrentConfiguration(api, version)) return false;
      set(state => ({
        mutation: 'idle',
        planStatus: 'ready',
        currentPlan,
        drillDetails: { ...state.drillDetails, ...details },
        planError: null,
        mutationError: null,
      }));
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(api, version)) return false;
      const error = toError(cause);
      set({ mutation: 'idle', mutationError: error.toState() });
      return false;
    }
  },

  reassessCurrentPlan: async shotId => {
    if (get().mutation !== 'idle') return false;
    const api = trainingApi;
    const plan = get().currentPlan;
    if (!api) {
      const error = missingApi();
      set({ mutationError: error.toState() });
      return false;
    }
    if (!plan || plan.status !== 'active') {
      const error = new TrainingError(
        'training.request_failed',
        'There is no active plan ready for reassessment.',
        false,
      );
      set({ mutationError: error.toState() });
      return false;
    }
    const version = trainingConfigurationVersion;
    set({ mutation: 'reassessing', mutationError: null });
    try {
      const currentPlan = await api.reassessPlan(plan.id, shotId);
      if (!isCurrentConfiguration(api, version)) return false;
      set({
        mutation: 'idle',
        planStatus: 'ready',
        currentPlan,
        planError: null,
        mutationError: null,
      });
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(api, version)) return false;
      const error = toError(cause);
      set({ mutation: 'idle', mutationError: error.toState() });
      return false;
    }
  },

  setDrillSaved: async (slug, saved) => {
    if (get().mutation !== 'idle') return false;
    const api = trainingApi;
    if (!api) {
      const error = missingApi();
      set({ mutationError: error.toState() });
      return false;
    }
    const version = trainingConfigurationVersion;
    set({ mutation: `saving:${slug}`, mutationError: null });
    try {
      if (saved) await api.saveDrill(slug);
      else await api.unsaveDrill(slug);
      if (!isCurrentConfiguration(api, version)) return false;
      set(state => ({
        mutation: 'idle',
        currentPlan: state.currentPlan
          ? {
              ...state.currentPlan,
              items: state.currentPlan.items.map(item =>
                item.drill?.slug === slug
                  ? { ...item, drill: { ...item.drill, saved } }
                  : item,
              ),
            }
          : null,
        drillDetails: state.drillDetails[slug]
          ? {
              ...state.drillDetails,
              [slug]: { ...state.drillDetails[slug]!, saved },
            }
          : state.drillDetails,
        savedDrills: saved
          ? state.savedDrills
          : state.savedDrills.filter(drill => drill.slug !== slug),
        mutationError: null,
      }));
      await get().loadSavedDrills();
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(api, version)) return false;
      const error = toError(cause);
      set({ mutation: 'idle', mutationError: error.toState() });
      return false;
    }
  },

  completePlanItem: async item => {
    if (get().mutation !== 'idle') return false;
    const api = trainingApi;
    const sets = item.targetSets;
    const repetitions = item.targetRepetitionsPerSet;
    const seconds = item.targetDurationSeconds;
    if (!api) {
      const error = missingApi();
      set({ mutationError: error.toState() });
      return false;
    }
    if (
      !item.drill ||
      item.completion ||
      !sets ||
      (repetitions === null && seconds === null)
    ) {
      const error = new TrainingError(
        'training.invalid_completion',
        'This reviewed prescription does not have a valid completion target.',
        false,
      );
      set({ mutationError: error.toState() });
      return false;
    }
    const version = trainingConfigurationVersion;
    set({ mutation: `completing:${item.id}`, mutationError: null });
    try {
      const completion = await api.completeDrill({
        id: makeUuid(),
        drillSlug: item.drill.slug,
        trainingPlanItemId: item.id,
        completedAt: new Date().toISOString(),
        actualRepetitions: repetitions === null ? null : sets * repetitions,
        actualDurationSeconds: seconds === null ? null : sets * seconds,
      });
      if (!isCurrentConfiguration(api, version)) return false;
      set(state => ({
        mutation: 'idle',
        currentPlan: state.currentPlan
          ? withPlanItem(state.currentPlan, item.id, current => ({
              ...current,
              completion,
            }))
          : null,
        mutationError: null,
      }));
      // A finished prescribed drill is a meaningful training day: mirror it
      // into the owner-scoped consistency ledger (server evidence remains
      // authoritative for the plan itself). Fire-and-forget by design; the
      // require is lazy so this store never drags SQLite into hosts (and
      // tests) that only exercise training plans.
      if (completion.qualifiesForStreak !== false && item.drill) {
        const { useConsistencyStore } =
          require('../consistency/store') as typeof import('../consistency/store');
        void useConsistencyStore.getState().recordDrillCompletion({
          id: completion.id,
          slug: item.drill.slug,
          title: item.drill.title,
          completedAtIso: completion.completedAt,
        });
      }
      return true;
    } catch (cause) {
      if (!isCurrentConfiguration(api, version)) return false;
      const error = toError(cause);
      set({ mutation: 'idle', mutationError: error.toState() });
      return false;
    }
  },

  clearMutationError: () => set({ mutationError: null }),
  reset: () => set(defaults()),
}));

export function configureTrainingStore(api: TrainingApi): void {
  trainingApi = api;
  trainingConfigurationVersion += 1;
  useTrainingStore.getState().reset();
}

export function clearTrainingStoreConfiguration(): void {
  trainingApi = null;
  trainingConfigurationVersion += 1;
  useTrainingStore.getState().reset();
}
