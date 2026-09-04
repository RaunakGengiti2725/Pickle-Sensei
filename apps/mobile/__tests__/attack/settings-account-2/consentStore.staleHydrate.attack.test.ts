/**
 * ADVERSARIAL PASS 3 — mobile-settings-account #2 (target 4d812e1a).
 *
 * Extra scenario (consentStore is in scope): Settings' useFocusEffect fires
 * `hydrate()` (GET /v1/me/consent/status) and the player immediately opens
 * Consent settings and flips the model-training switch (POST …/grant). The
 * GET is slow, the POST is fast. When the stale GET lands it carries the
 * PRE-grant ledger. The store's own doc says "the server ledger is the only
 * truth" — after both settle, the screen must show the ledger as it IS
 * (granted), not as it WAS.
 */
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import type { ConsentFetch } from '../../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../../src/account/consentApi';
import { useConsentStore } from '../../../src/state/consentStore';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

function statusBody(modelTrainingActive: boolean, lastActionAt: string) {
  return {
    subjectPseudonym: 'b0000000-0000-0000-0000-000000000002',
    scopes: [
      {
        scope: 'model_training',
        active: modelTrainingActive,
        consentVersion: modelTrainingActive
          ? MODEL_TRAINING_CONSENT_VERSION
          : null,
        lastAction: modelTrainingActive ? 'granted' : 'withdrawn',
        lastActionAt,
      },
    ],
  };
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: () => Promise.resolve(body) } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Ledger with a real clock: every POST appends and GET reads the head. */
class FakeConsentLedger {
  active = false;
  lastActionAt = '2026-08-29T00:00:00.000Z';
  pendingGets: Array<ReturnType<typeof deferred<Response>>> = [];
  postCount = 0;
  getCount = 0;

  readonly fetch: ConsentFetch = async (input, init) => {
    const url = String(input);
    if (init?.method === 'GET' && url.endsWith('/v1/me/consent/status')) {
      this.getCount += 1;
      // Snapshot NOW (the server serialised its response) but deliver later.
      const snapshot = statusBody(this.active, this.lastActionAt);
      const gate = deferred<Response>();
      this.pendingGets.push(gate);
      await gate.promise;
      return jsonResponse(snapshot);
    }
    if (init?.method === 'POST' && url.endsWith('/v1/me/consent/grant')) {
      this.postCount += 1;
      this.active = true;
      this.lastActionAt = '2026-09-04T12:00:00.000Z';
      return jsonResponse(statusBody(this.active, this.lastActionAt));
    }
    if (init?.method === 'POST' && url.endsWith('/v1/me/consent/withdraw')) {
      this.postCount += 1;
      this.active = false;
      this.lastActionAt = '2026-09-04T12:00:01.000Z';
      return jsonResponse(statusBody(this.active, this.lastActionAt));
    }
    throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`);
  };
}

beforeEach(() => {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  clearApiSession();
  establishApiSession(session);
});

afterEach(() => clearApiSession());

describe('consentStore — slow Settings hydrate vs fast grant', () => {
  it('[BROKEN on 4d812e1a] a stale status GET that lands AFTER a successful grant flips the switch back to OFF although the ledger says granted', async () => {
    const ledger = new FakeConsentLedger();
    const store = useConsentStore.getState();

    // Settings focus → hydrate; the GET is in flight (slow network).
    const hydrating = store.hydrate(ledger.fetch);
    await Promise.resolve();
    expect(ledger.getCount).toBe(1);

    // Player opens Consent settings and grants; POST is fast.
    await store.setModelTrainingConsent(true, ledger.fetch);
    expect(ledger.active).toBe(true);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().availability).toBe('ready');

    // The slow GET now lands with the PRE-grant snapshot.
    ledger.pendingGets[0]!.resolve(jsonResponse(null));
    await hydrating;

    const state = useConsentStore.getState();
    expect({
      ledgerActive: ledger.active,
      uiActive: state.modelTrainingActive,
      uiLastActionAt: state.lastActionAt,
      availability: state.availability,
      error: state.error,
    }).toEqual({
      ledgerActive: true,
      uiActive: true,
      uiLastActionAt: ledger.lastActionAt,
      availability: 'ready',
      error: null,
    });
  });

  it('[BROKEN on 4d812e1a] the mirror image: stale GET after a WITHDRAW shows the switch ON for a player who just withdrew consent', async () => {
    const ledger = new FakeConsentLedger();
    ledger.active = true;
    const store = useConsentStore.getState();
    // Warm state: previously hydrated as granted.
    useConsentStore.setState({
      availability: 'ready',
      modelTrainingActive: true,
      lastActionAt: ledger.lastActionAt,
    });

    const hydrating = store.hydrate(ledger.fetch);
    await Promise.resolve();
    await store.setModelTrainingConsent(false, ledger.fetch);
    expect(ledger.active).toBe(false);
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    ledger.pendingGets[0]!.resolve(jsonResponse(null));
    await hydrating;

    expect({
      ledgerActive: ledger.active,
      uiActive: useConsentStore.getState().modelTrainingActive,
    }).toEqual({ ledgerActive: false, uiActive: false });
  });

  it('control: the same interleaving with the GET completing BEFORE the grant converges on the ledger (HELD)', async () => {
    const ledger = new FakeConsentLedger();
    const store = useConsentStore.getState();
    const hydrating = store.hydrate(ledger.fetch);
    await Promise.resolve();
    ledger.pendingGets[0]!.resolve(jsonResponse(null));
    await hydrating;
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);
    await store.setModelTrainingConsent(true, ledger.fetch);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(ledger.active).toBe(true);
  });

  it('the busy guard drops a second tap while a POST is in flight — the ledger sees exactly one write (HELD)', async () => {
    const ledger = new FakeConsentLedger();
    const store = useConsentStore.getState();
    // Make the POST slow by routing it through a gate.
    const gate = deferred<void>();
    const slowFetch: ConsentFetch = async (input, init) => {
      if (init?.method === 'POST') await gate.promise;
      return ledger.fetch(input, init);
    };
    const first = store.setModelTrainingConsent(true, slowFetch);
    await Promise.resolve();
    expect(useConsentStore.getState().busy).toBe(true);
    const second = store.setModelTrainingConsent(false, slowFetch);
    await second;
    gate.resolve();
    await first;
    expect(ledger.postCount).toBe(1);
    expect(ledger.active).toBe(true);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().busy).toBe(false);
  });
});
