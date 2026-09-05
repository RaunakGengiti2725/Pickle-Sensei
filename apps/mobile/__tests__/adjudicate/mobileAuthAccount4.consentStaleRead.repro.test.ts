/**
 * Adjudication reproduction (stress area mobile-auth-account-4).
 *
 * Replays the consent-store stale-read witness (randomized seed 16, minimised
 * to four actions) WITHOUT the tester's harness: a status read that is still
 * in flight when a newer withdraw lands overwrites the withdrawn state when it
 * finally resolves. The store has no request epoch; `isCurrentSession` only
 * guards against a session change, not against ordering within one session.
 *
 * UI-realistic path: SettingsScreen mounts (hydrate #0) → user opens
 * "Data & consent" (hydrate #1, toggle disabled while loading) → #0 lands
 * (toggle enabled) → user withdraws (lands) → #1 lands late and shows the
 * toggle ON again although the server ledger says OFF.
 *
 * This test documents the CURRENT (defective) behaviour: it asserts the
 * stale overwrite happens. A fix must invert the final assertion.
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

function statusBody(modelTrainingActive: boolean, at: string) {
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
        lastActionAt: at,
      },
    ],
  };
}

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

interface Deferred {
  resolve: (r: Response) => void;
  promise: Promise<Response>;
}
function deferred(): Deferred {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>(r => {
    resolve = r;
  });
  return { resolve, promise };
}

const flush = () => new Promise<void>(r => setTimeout(r, 0));

describe('adjudication: consentStore stale status read overwrites newer mutation', () => {
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

  it('seed 16 (minimised): late hydrate flips a withdrawn consent back to active', async () => {
    const requests: Deferred[] = [];
    const fetchFn: ConsentFetch = () => {
      const d = deferred();
      requests.push(d);
      return d.promise;
    };
    const store = useConsentStore.getState();

    // request#0 — SettingsScreen mount hydrate, slow.
    const hydrate0 = store.hydrate(fetchFn);
    // request#1 — ConsentSettingsScreen mount hydrate, fast.
    const hydrate1 = store.hydrate(fetchFn);
    expect(requests).toHaveLength(2);
    requests[1]!.resolve(
      jsonResponse(statusBody(true, '2026-09-01T12:00:00.000Z')),
    );
    await hydrate1;
    expect(useConsentStore.getState()).toMatchObject({
      availability: 'ready',
      modelTrainingActive: true,
    });

    // request#2 — user withdraws; the server confirms active=false.
    const withdraw = store.setModelTrainingConsent(false, fetchFn);
    await flush();
    expect(requests).toHaveLength(3);
    requests[2]!.resolve(
      jsonResponse(statusBody(false, '2026-09-01T12:00:05.000Z')),
    );
    await withdraw;
    expect(useConsentStore.getState()).toMatchObject({
      busy: false,
      modelTrainingActive: false,
      lastActionAt: '2026-09-01T12:00:05.000Z',
    });

    // request#0 lands last with the pre-withdraw snapshot.
    requests[0]!.resolve(
      jsonResponse(statusBody(true, '2026-09-01T12:00:00.000Z')),
    );
    await hydrate0;

    // DEFECT: the older read wins over the newer, server-confirmed withdraw.
    expect(useConsentStore.getState().modelTrainingActive).toBe(true);
    expect(useConsentStore.getState().lastActionAt).toBe(
      '2026-09-01T12:00:00.000Z',
    );
  });
});
