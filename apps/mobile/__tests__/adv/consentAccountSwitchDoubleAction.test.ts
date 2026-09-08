/**
 * INT-ui-flows-a11y adversary — Data & consent under repeated taps, network
 * loss and an account switch mid-request.
 *
 *  1. Double tap on the training toggle in one tick sends ONE grant request.
 *  2. Network loss while granting: consent stays off, the toggle is
 *     re-enabled (busy=false) and the error is visible — never an optimistic
 *     "granted".
 *  3. Owner A's slow grant lands after owner B became live: B's ledger must
 *     stay off and B must not be left stuck busy.
 *  4. Offline hydrate for a signed-in owner reports `unavailable` with an
 *     honest error, never a fabricated grant.
 *  5. Toggle while signed out changes nothing and says so.
 */
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';
import {
  setActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../../src/data/accountScope';

const ownerA = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-a',
  canonicalAppUserId: 'a0000000-0000-4000-8000-000000000001',
  provider: 'apple' as const,
};
const ownerB = {
  ...ownerA,
  bearerToken: 'token-b',
  canonicalAppUserId: 'b0000000-0000-4000-8000-000000000002',
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
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

async function flush() {
  for (let turn = 0; turn < 30; turn += 1) await Promise.resolve();
}

beforeEach(() => {
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  clearApiSession();
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
});

describe('adv: consent store double actions / network loss / account switch', () => {
  it('a same-tick double tap sends exactly one grant request', async () => {
    setActiveDataOwner(ownerA.canonicalAppUserId);
    establishApiSession(ownerA);
    const fetchFn = jest.fn(async () => jsonResponse(statusBody(true)));
    const first = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    const second = useConsentStore
      .getState()
      .setModelTrainingConsent(true, fetchFn);
    await Promise.all([first, second]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: true,
      error: null,
    });
  });

  it('network loss while granting leaves consent off, busy cleared and an error visible', async () => {
    setActiveDataOwner(ownerA.canonicalAppUserId);
    establishApiSession(ownerA);
    await useConsentStore.getState().setModelTrainingConsent(true, async () => {
      throw new TypeError('Network request failed');
    });
    const state = useConsentStore.getState();
    expect(state.busy).toBe(false);
    expect(state.modelTrainingActive).toBe(false);
    expect(typeof state.error).toBe('string');
    expect(state.error).toMatch(/could not be saved|unavailable/i);
  });

  it("owner A's slow grant landing after owner B is live never flips B on or leaves B busy", async () => {
    setActiveDataOwner(ownerA.canonicalAppUserId);
    establishApiSession(ownerA);
    let resolveA!: (value: Response) => void;
    const slowGrant = useConsentStore.getState().setModelTrainingConsent(
      true,
      () =>
        new Promise(resolve => {
          resolveA = resolve;
        }),
    );
    expect(useConsentStore.getState().busy).toBe(true);

    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    clearApiSession();
    setActiveDataOwner(ownerB.canonicalAppUserId);
    establishApiSession(ownerB);
    await useConsentStore
      .getState()
      .hydrate(async () => jsonResponse(statusBody(false)));
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: false,
    });

    resolveA(jsonResponse(statusBody(true)));
    await slowGrant;
    await flush();
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: false,
      error: null,
    });
  });

  it('an offline hydrate for a signed-in owner is unavailable with an honest error, not a grant', async () => {
    setActiveDataOwner(ownerA.canonicalAppUserId);
    establishApiSession(ownerA);
    await useConsentStore.getState().hydrate(async () => {
      throw new TypeError('Network request failed');
    });
    const state = useConsentStore.getState();
    expect(state.availability).toBe('unavailable');
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).toMatch(/unavailable/i);
    expect(state.busy).toBe(false);
  });

  it('toggling while signed out changes nothing and says so', async () => {
    const fetchFn = jest.fn();
    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    expect(fetchFn).not.toHaveBeenCalled();
    const state = useConsentStore.getState();
    expect(state.modelTrainingActive).toBe(false);
    expect(state.error).toMatch(/Sign in/);
  });
});
