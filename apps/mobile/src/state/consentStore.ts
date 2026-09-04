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
 * Every hydrate/set is one generation; only the newest generation may write
 * the ledger. Overlapping requests within a session (a status GET racing the
 * grant it was in flight for, Settings and Data & consent hydrating at once,
 * a slow request that eventually fails) resolve in any order, and the last
 * response to land would otherwise overwrite the newest truth.
 */
let requestGeneration = 0;

function nextGeneration(): number {
  requestGeneration += 1;
  return requestGeneration;
}

/**
 * A response only belongs to the account that is still signed in when it
 * lands and to the newest request issued; a sign-out, an account switch, or
 * a later hydrate/set mid-flight makes it stale.
 */
function isCurrentRequest(session: ApiSession, generation: number): boolean {
  return (
    generation === requestGeneration &&
    getApiSession()?.canonicalAppUserId === session.canonicalAppUserId
  );
}

/**
 * A stale hydrate writes nothing while signed in — a newer request owns the
 * state (including `busy`, which belongs to the one set that can be in
 * flight). A stale set only releases `busy`. Signed out, both restore the
 * signed-out state in case no hydrate ran after the sign-out.
 */
function staleHydrateState(): Partial<ConsentState> {
  return getApiSession() ? {} : SIGNED_OUT_STATE;
}

function staleSetState(): Partial<ConsentState> {
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
    const generation = nextGeneration();
    const session = getApiSession();
    if (!session) {
      set(SIGNED_OUT_STATE);
      return;
    }
    set({ availability: 'loading', error: null });
    try {
      const status = await fetchConsentStatus(session, fetchFn);
      if (!isCurrentRequest(session, generation)) {
        set(staleHydrateState());
        return;
      }
      set(applyStatus(status));
    } catch (error) {
      if (!isCurrentRequest(session, generation)) {
        set(staleHydrateState());
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
      nextGeneration();
      set({
        ...SIGNED_OUT_STATE,
        error: 'Sign in to change this setting. Nothing was changed.',
      });
      return;
    }
    if (get().busy) return;
    const generation = nextGeneration();
    set({ busy: true, error: null });
    try {
      const status = granted
        ? await grantModelTrainingConsent(session, deviceLabel(), fetchFn)
        : await withdrawModelTrainingConsent(session, deviceLabel(), fetchFn);
      if (!isCurrentRequest(session, generation)) {
        set(staleSetState());
        return;
      }
      set({ busy: false, ...applyStatus(status) });
    } catch (error) {
      if (!isCurrentRequest(session, generation)) {
        set(staleSetState());
        return;
      }
      // The optimistic state is never kept: the ledger did not change. A
      // hydrate this request superseded never lands either, so a ledger that
      // was still loading stays unknown rather than loading forever.
      set({
        busy: false,
        ...(get().availability === 'loading'
          ? { availability: 'unavailable' as const }
          : {}),
        error:
          error instanceof ConsentApiError
            ? error.message
            : 'Your consent change could not be saved. Nothing was changed.',
      });
    }
  },
}));
