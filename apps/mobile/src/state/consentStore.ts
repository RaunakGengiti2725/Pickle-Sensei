import { create } from 'zustand';
import { Platform } from 'react-native';
import {
  getApiSession,
  subscribeToApiSession,
  type ApiSession,
} from '../account/apiSession';
import {
  captureDataOwnerContext,
  getActiveDataOwner,
  GUEST_DATA_OWNER,
  isDataOwnerContextCurrent,
  SIGNED_OUT_DATA_OWNER,
  type DataOwnerContext,
} from '../data/accountScope';
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
  'loading' | 'ready' | 'restoring' | 'signed_out' | 'unavailable';

interface ConsentState {
  availability: ConsentAvailability;
  ownerContext: DataOwnerContext | null;
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

let requestRevision = 0;
let waitingForSession: {
  context: DataOwnerContext;
  fetchFn?: ConsentFetch;
} | null = null;
let hydrationInFlight: { revision: number; promise: Promise<void> } | null =
  null;

function currentConsentContext(): DataOwnerContext | null {
  const owner = getActiveDataOwner();
  return owner === SIGNED_OUT_DATA_OWNER || owner === GUEST_DATA_OWNER
    ? null
    : captureDataOwnerContext();
}

function sessionFor(context: DataOwnerContext | null): ApiSession | null {
  const session = getApiSession();
  return context &&
    session?.canonicalAppUserId.toLowerCase() === context.ownerKey
    ? session
    : null;
}

export function resetConsentStore(
  context: DataOwnerContext | null = null,
): void {
  requestRevision += 1;
  waitingForSession = null;
  hydrationInFlight = null;
  useConsentStore.setState({
    ...SIGNED_OUT_STATE,
    ownerContext: context,
    availability: context
      ? sessionFor(context)
        ? 'loading'
        : 'restoring'
      : 'signed_out',
  });
}

export function configureConsentStore(context: DataOwnerContext | null): void {
  const previous = useConsentStore.getState().ownerContext;
  if (
    previous?.ownerKey !== context?.ownerKey ||
    previous?.generation !== context?.generation
  ) {
    resetConsentStore(context);
  }
}

/**
 * A response only belongs to the account that is still signed in when it
 * lands; a sign-out or account switch mid-flight makes it stale.
 */
function isCurrentSession(
  session: ApiSession,
  context: DataOwnerContext,
  revision: number,
): boolean {
  return (
    revision === requestRevision &&
    isDataOwnerContextCurrent(context) &&
    getApiSession()?.canonicalAppUserId === session.canonicalAppUserId
  );
}

function staleSessionState(
  context: DataOwnerContext | null,
): Partial<ConsentState> {
  return {
    ...SIGNED_OUT_STATE,
    ownerContext: context,
    availability: context ? 'restoring' : 'signed_out',
  };
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
  ownerContext: null,
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,

  hydrate: fetchFn => {
    watchApiSession();
    const context = currentConsentContext();
    configureConsentStore(context);
    const session = sessionFor(context);
    if (!session || !context) {
      requestRevision += 1;
      waitingForSession = context ? { context, fetchFn } : null;
      set(staleSessionState(context));
      return Promise.resolve();
    }
    if (get().busy) return Promise.resolve();
    if (hydrationInFlight?.revision === requestRevision) {
      return hydrationInFlight.promise;
    }
    waitingForSession = null;
    const revision = ++requestRevision;
    set({ availability: 'loading', error: null });
    const promise = (async () => {
      try {
        const status = await fetchConsentStatus(session, fetchFn);
        if (!isCurrentSession(session, context, revision)) return;
        set(applyStatus(status));
      } catch (error) {
        if (!isCurrentSession(session, context, revision)) return;
        set({
          availability: 'unavailable',
          modelTrainingActive: false,
          lastActionAt: null,
          error:
            error instanceof ConsentApiError
              ? error.message
              : 'Consent settings are temporarily unavailable.',
        });
      }
    })();
    const inFlight = { revision, promise };
    hydrationInFlight = inFlight;
    void promise.then(() => {
      if (hydrationInFlight === inFlight) hydrationInFlight = null;
    });
    return promise;
  },

  setModelTrainingConsent: async (granted, fetchFn) => {
    watchApiSession();
    const context = currentConsentContext();
    configureConsentStore(context);
    const session = sessionFor(context);
    if (!session || !context) {
      requestRevision += 1;
      waitingForSession = context ? { context, fetchFn } : null;
      set({
        ...staleSessionState(context),
        error: context
          ? 'Your account is still reconnecting. Check your connection before changing this setting.'
          : 'Sign in to change this setting. Nothing was changed.',
      });
      return;
    }
    if (get().busy) return;
    waitingForSession = null;
    const revision = ++requestRevision;
    set({ busy: true, error: null });
    try {
      const status = granted
        ? await grantModelTrainingConsent(session, deviceLabel(), fetchFn)
        : await withdrawModelTrainingConsent(session, deviceLabel(), fetchFn);
      if (!isCurrentSession(session, context, revision)) return;
      set({ busy: false, ...applyStatus(status) });
    } catch (error) {
      if (!isCurrentSession(session, context, revision)) return;
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

let watchingApiSession = false;
function watchApiSession(): void {
  if (watchingApiSession) return;
  subscribeToApiSession(session => {
    const context = currentConsentContext();
    if (!session || !sessionFor(context)) {
      resetConsentStore(context);
      return;
    }
    configureConsentStore(context);
    const waiting = waitingForSession;
    if (
      waiting &&
      isDataOwnerContextCurrent(waiting.context) &&
      sessionFor(context)
    ) {
      waitingForSession = null;
      void useConsentStore.getState().hydrate(waiting.fetchFn);
    }
  });
  watchingApiSession = true;
}
