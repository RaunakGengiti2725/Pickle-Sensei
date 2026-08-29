import { create } from 'zustand';
import { Platform } from 'react-native';
import { getApiSession } from '../account/apiSession';
import {
  ConsentApiError,
  fetchConsentStatus,
  grantModelTrainingConsent,
  withdrawModelTrainingConsent,
  type ConsentFetch,
  type ConsentStatus,
} from '../account/consentApi';

/**
 * Model-training consent state. The server ledger is the only truth: this
 * store never assumes a grant, defaults to NOT consented, and surfaces
 * every failure — a toggle that silently fails would be a dark pattern.
 */

export type ConsentAvailability =
  | 'loading'
  | 'ready'
  | 'signed_out'
  | 'unavailable';

interface ConsentState {
  availability: ConsentAvailability;
  /** Server-derived; false until a status response proves otherwise. */
  modelTrainingActive: boolean;
  lastActionAt: string | null;
  busy: boolean;
  error: string | null;
  hydrate: (fetchFn?: ConsentFetch) => Promise<void>;
  setModelTrainingConsent: (
    granted: boolean,
    fetchFn?: ConsentFetch,
  ) => Promise<void>;
}

function deviceLabel(): string {
  return `${Platform.OS} ${String(Platform.Version)}`;
}

function applyStatus(status: ConsentStatus): Pick<
  ConsentState,
  'availability' | 'modelTrainingActive' | 'lastActionAt'
> {
  const training = status.scopes.find(s => s.scope === 'model_training');
  return {
    availability: 'ready',
    modelTrainingActive: training?.active ?? false,
    lastActionAt: training?.lastActionAt ?? null,
  };
}

export const useConsentStore = create<ConsentState>((set, get) => ({
  availability: 'loading',
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,

  hydrate: async fetchFn => {
    const session = getApiSession();
    if (!session) {
      set({
        availability: 'signed_out',
        modelTrainingActive: false,
        lastActionAt: null,
        error: null,
      });
      return;
    }
    set({ availability: 'loading', error: null });
    try {
      set(applyStatus(await fetchConsentStatus(session, fetchFn)));
    } catch (error) {
      set({
        availability: 'unavailable',
        modelTrainingActive: false,
        error:
          error instanceof ConsentApiError
            ? error.message
            : 'Consent settings are temporarily unavailable.',
      });
    }
  },

  setModelTrainingConsent: async (granted, fetchFn) => {
    const session = getApiSession();
    if (!session || get().busy) return;
    set({ busy: true, error: null });
    try {
      const status = granted
        ? await grantModelTrainingConsent(session, deviceLabel(), fetchFn)
        : await withdrawModelTrainingConsent(session, deviceLabel(), fetchFn);
      set({ busy: false, ...applyStatus(status) });
    } catch (error) {
      // The optimistic state is never kept: the ledger did not change.
      set({
        busy: false,
        error:
          error instanceof ConsentApiError
            ? error.message
            : 'Your consent change could not be saved. Nothing was changed.',
      });
    }
  },
}));
