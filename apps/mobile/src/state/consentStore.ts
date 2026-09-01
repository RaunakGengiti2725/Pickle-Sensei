import { create } from 'zustand';
import { Platform } from 'react-native';
import { getApiSession, type ApiSession } from '../account/apiSession';
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
  'loading' | 'ready' | 'signed_out' | 'unavailable';

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

const SIGNED_OUT_STATE: Pick<
  ConsentState,
  'availability' | 'modelTrainingActive' | 'lastActionAt' | 'busy' | 'error'
> = {
  availability: 'signed_out',
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,
};

/**
 * A response only belongs to the account that is still signed in when it
 * lands; a sign-out or account switch mid-flight makes it stale.
 */
function isCurrentSession(session: ApiSession): boolean {
  return getApiSession()?.canonicalAppUserId === session.canonicalAppUserId;
}

function staleSessionState(): Partial<ConsentState> {
  return getApiSession() ? { busy: false } : SIGNED_OUT_STATE;
}

function applyStatus(
  status: ConsentStatus,
): Pick<ConsentState, 'availability' | 'modelTrainingActive' | 'lastActionAt'> {
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
      set(SIGNED_OUT_STATE);
      return;
    }
    set({ availability: 'loading', error: null });
    try {
      const status = await fetchConsentStatus(session, fetchFn);
      if (!isCurrentSession(session)) {
        set(staleSessionState());
        return;
      }
      set(applyStatus(status));
    } catch (error) {
      if (!isCurrentSession(session)) {
        set(staleSessionState());
        return;
      }
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
    if (!session) {
      set({
        ...SIGNED_OUT_STATE,
        error: 'Sign in to change this setting. Nothing was changed.',
      });
      return;
    }
    if (get().busy) return;
    set({ busy: true, error: null });
    try {
      const status = granted
        ? await grantModelTrainingConsent(session, deviceLabel(), fetchFn)
        : await withdrawModelTrainingConsent(session, deviceLabel(), fetchFn);
      if (!isCurrentSession(session)) {
        set(staleSessionState());
        return;
      }
      set({ busy: false, ...applyStatus(status) });
    } catch (error) {
      if (!isCurrentSession(session)) {
        set(staleSessionState());
        return;
      }
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
