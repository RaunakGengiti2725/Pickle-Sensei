import {
  clearApiSession,
  establishApiSession,
  reportApiUnauthorized,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import {
  captureDataOwnerContext,
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';
import {
  configureConsentStore,
  resetConsentStore,
  useConsentStore,
} from '../../src/state/consentStore';

/**
 * INT-state-consistency adversarial pass (attacked HEAD 30a40650).
 * consentStore hydrate/mutation races across sign-out, account switch and
 * failed mutations; apiSession late-401 fencing after bearer rotation.
 */

const sessionA: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-a-1',
  canonicalAppUserId: 'a0000000-0000-4000-8000-000000000001',
  provider: 'apple',
};

const sessionB: ApiSession = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-b-1',
  canonicalAppUserId: 'b0000000-0000-4000-8000-000000000002',
  provider: 'apple',
};

function statusBody(modelTrainingActive: boolean) {
  return {
    subjectPseudonym: 'c0000000-0000-0000-0000-000000000003',
    scopes: [
      {
        scope: 'video_analysis',
        active: false,
        consentVersion: null,
        lastAction: null,
        lastActionAt: null,
      },
      {
        scope: 'model_training',
        active: modelTrainingActive,
        consentVersion: modelTrainingActive
          ? MODEL_TRAINING_CONSENT_VERSION
          : null,
        lastAction: modelTrainingActive ? 'granted' : 'withdrawn',
        lastActionAt: '2026-09-08T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flush() {
  for (let turn = 0; turn < 40; turn += 1) await Promise.resolve();
}

function signIn(session: ApiSession) {
  setActiveDataOwner(session.canonicalAppUserId);
  configureConsentStore(captureDataOwnerContext());
  establishApiSession(session);
}

function signOut() {
  clearApiSession();
  resetConsentStore();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

beforeEach(() => {
  signOut();
});

afterEach(() => {
  setApiUnauthorizedListener(null);
  signOut();
});

describe('ATTACK consentStore: races across sign-out, account switch and failed mutations', () => {
  it('C1 a grant for A that lands after sign-out and a B sign-in never marks B as consenting', async () => {
    signIn(sessionA);
    const lateA = deferred<Response>();
    const hydrationA = useConsentStore.getState().hydrate(() => lateA.promise);
    await flush();
    expect(useConsentStore.getState().availability).toBe('loading');

    signOut();
    signIn(sessionB);
    const fetchB = jest.fn(async () => jsonResponse(statusBody(false)));
    const hydrationB = useConsentStore.getState().hydrate(fetchB);
    lateA.resolve(jsonResponse(statusBody(true)));
    await Promise.all([hydrationA, hydrationB]);
    await flush();

    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      modelTrainingActive: false,
      busy: false,
      error: null,
    });
    expect(useConsentStore.getState().ownerContext?.ownerKey).toBe(
      sessionB.canonicalAppUserId,
    );
  });

  it('C2 a toggle that fails while the initial status read is still in flight must not leave consent neither loading nor ready', async () => {
    signIn(sessionA);
    const lateStatus = deferred<Response>();
    const hydration = useConsentStore
      .getState()
      .hydrate(() => lateStatus.promise);
    await flush();
    expect(useConsentStore.getState().availability).toBe('loading');

    await useConsentStore.getState().setModelTrainingConsent(true, async () => {
      throw new Error('network lost');
    });
    expect(useConsentStore.getState().busy).toBe(false);
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
    expect(useConsentStore.getState().error).not.toBeNull();

    lateStatus.resolve(jsonResponse(statusBody(false)));
    await hydration;
    await flush();

    const state = useConsentStore.getState();
    expect(state.modelTrainingActive).toBe(false);
    // Nothing is in flight any more: the screen must be able to show either
    // the ledger ("ready") or a retryable failure ("unavailable"), not a
    // permanent spinner.
    expect(['ready', 'unavailable']).toContain(state.availability);
  });

  it('C3 a withdraw that resolves after A signed out and back in (new generation) is dropped, and the fresh read wins', async () => {
    signIn(sessionA);
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(true)));
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    const lateWithdraw = deferred<Response>();
    const withdraw = useConsentStore
      .getState()
      .setModelTrainingConsent(false, () => lateWithdraw.promise);
    await flush();
    expect(useConsentStore.getState().busy).toBe(true);

    signOut();
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'signed_out',
      modelTrainingActive: false,
      busy: false,
    });

    signIn({ ...sessionA, bearerToken: 'token-a-2' });
    const rehydrate = useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(true)));
    lateWithdraw.resolve(jsonResponse(statusBody(false)));
    await Promise.all([withdraw, rehydrate]);
    await flush();

    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      modelTrainingActive: true,
      busy: false,
      error: null,
    });
  });

  it('C4 a double-tapped grant performs one request and a bearer rotation mid-flight does not drop its result', async () => {
    signIn(sessionA);
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(false)));

    const grant = deferred<Response>();
    const fetchFn = jest.fn(() => grant.promise);
    const first = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    const second = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    await flush();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    establishApiSession({ ...sessionA, bearerToken: 'token-a-rotated' });
    grant.resolve(jsonResponse(statusBody(true)));
    await Promise.all([first, second]);
    await flush();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      modelTrainingActive: true,
      busy: false,
      error: null,
    });
  });
});

describe('ATTACK apiSession: late unauthorized reports after rotation and sign-out', () => {
  it('S1 a 401 for a rotated-out bearer is ignored; only the live bearer can tear down the session', () => {
    const listener = jest.fn();
    setApiUnauthorizedListener(listener);
    establishApiSession(sessionA);
    establishApiSession({ ...sessionA, bearerToken: 'token-a-2' });

    reportApiUnauthorized(sessionA.bearerToken);
    expect(listener).not.toHaveBeenCalled();

    clearApiSession();
    reportApiUnauthorized('token-a-2');
    expect(listener).not.toHaveBeenCalled();

    establishApiSession(sessionB);
    reportApiUnauthorized('token-a-2');
    expect(listener).not.toHaveBeenCalled();
    reportApiUnauthorized(sessionB.bearerToken);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(sessionB);
  });
});
