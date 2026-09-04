/**
 * AUDIT PROBE (structural #2, mobile-settings-account).
 *
 * consentStore.hydrate has no in-flight sequencing. Cross-session staleness
 * is guarded (isCurrentSession) but SAME-session ordering is not: a slow
 * status GET that started before a grant/withdraw POST can land after it and
 * overwrite the ledger's newer answer with the older snapshot.
 *
 * Reachable path: SettingsScreen mounts → hydrate() (GET #1); the user taps
 * "Data & consent" right away → ConsentSettingsScreen mounts → hydrate()
 * (GET #2) while Settings stays mounted below it. If #2 answers first the
 * toggle becomes usable (availability 'ready'); the user grants; then #1
 * (slow) lands with the pre-grant snapshot and overwrites the ledger's newer
 * answer. Retry-button spam is NOT parallel (the button is hidden while
 * loading), so only this two-screen path is asserted.
 *
 * Run: cd apps/mobile && npx jest __tests__/audit-structural2/consentStore-same-session-ordering.test.ts
 */
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';
import type { ConsentFetch } from '../../src/account/consentApi';
import { MODEL_TRAINING_CONSENT_VERSION } from '../../src/account/consentApi';
import { useConsentStore } from '../../src/state/consentStore';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

function statusBody(modelTrainingActive: boolean) {
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
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

function resetStore() {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
}

describe('AUDIT: consentStore same-session response ordering', () => {
  beforeEach(() => {
    resetStore();
    clearApiSession();
    establishApiSession(session);
  });
  afterEach(() => clearApiSession());

  it('a status GET that started before a grant must not overwrite the grant’s authoritative response', async () => {
    // GET #1 (SettingsScreen mount) is slow; GET #2 (ConsentSettingsScreen
    // mount) answers immediately.
    const settingsGet = deferred<Response>();
    let statusCalls = 0;
    const fetchFn: ConsentFetch = jest.fn((input: string) => {
      if (input.endsWith('/v1/me/consent/status')) {
        statusCalls += 1;
        return statusCalls === 1
          ? settingsGet.promise
          : Promise.resolve(jsonResponse(statusBody(false)));
      }
      if (input.endsWith('/v1/me/consent/grant')) {
        return Promise.resolve(jsonResponse(statusBody(true)));
      }
      return Promise.resolve(jsonResponse(statusBody(false)));
    });

    const settingsHydrate = useConsentStore.getState().hydrate(fetchFn);
    await useConsentStore.getState().hydrate(fetchFn);
    // Toggle is usable now (availability 'ready') while GET #1 is pending.
    expect(useConsentStore.getState().availability).toBe('ready');
    expect(useConsentStore.getState().modelTrainingActive).toBe(false);

    await useConsentStore.getState().setModelTrainingConsent(true, fetchFn);
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);

    // The older GET now lands with the pre-grant snapshot.
    settingsGet.resolve(jsonResponse(statusBody(false)));
    await settingsHydrate;

    const state = useConsentStore.getState();
    console.log(
      JSON.stringify({
        probe: 'consentStore-same-session-ordering',
        modelTrainingActive: state.modelTrainingActive,
        availability: state.availability,
      }),
    );
    // Ledger says granted (POST response is authoritative and newer).
    expect(state.modelTrainingActive).toBe(true);
  });

  it('two overlapping hydrates: the earlier response must not win over the later one', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    let calls = 0;
    const fetchFn: ConsentFetch = jest.fn(() => {
      calls += 1;
      return calls === 1 ? a.promise : b.promise;
    });
    const hydrateA = useConsentStore.getState().hydrate(fetchFn);
    const hydrateB = useConsentStore.getState().hydrate(fetchFn);
    // Newer request (B) answers first with the current ledger (granted);
    // the older one (A) straggles in with a snapshot from before the grant.
    b.resolve(jsonResponse(statusBody(true)));
    await hydrateB;
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    a.resolve(jsonResponse(statusBody(false)));
    await hydrateA;
    const state = useConsentStore.getState();
    console.log(
      JSON.stringify({
        probe: 'consentStore-overlapping-hydrates',
        modelTrainingActive: state.modelTrainingActive,
      }),
    );
    expect(state.modelTrainingActive).toBe(true);
  });
});
