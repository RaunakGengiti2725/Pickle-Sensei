import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import type { ConsentFetch } from '../src/account/consentApi';
import { useConsentStore } from '../src/state/consentStore';

/**
 * Throwaway probe (audit pass 2). PASS = failure mode reproduced,
 * FAIL = hypothesis refuted (code is well-behaved).
 */

const sessionA = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-a',
  canonicalAppUserId: 'a0000000-0000-0000-0000-00000000000a',
  provider: 'apple' as const,
};
const sessionB = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-b',
  canonicalAppUserId: 'b0000000-0000-0000-0000-00000000000b',
  provider: 'google' as const,
};

function statusBody(active: boolean) {
  return {
    subjectPseudonym: 'c0000000-0000-0000-0000-00000000000c',
    scopes: [
      {
        scope: 'model_training',
        active,
        consentVersion: active ? 'model-training-v1' : null,
        lastAction: active ? 'granted' : 'withdrawn',
        lastActionAt: '2026-08-29T00:00:00.000Z',
      },
    ],
  };
}
const ok = (body: unknown) =>
  ({ ok: true, json: () => Promise.resolve(body) }) as unknown as Response;

function deferred() {
  let reject: (e: Error) => void = () => {};
  let resolve: (r: Response) => void = () => {};
  const fetchFn: ConsentFetch = jest.fn(
    () =>
      new Promise<Response>((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return { fetchFn, reject: (e: Error) => reject(e), resolve };
}

beforeEach(() => {
  clearApiSession();
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
});

describe('probe: consentStore', () => {
  it('C1 REPRO?: grant FAILING after sign-out surfaces error / leaves busy (expect refuted)', async () => {
    establishApiSession(sessionA);
    await useConsentStore.getState().hydrate(async () => ok(statusBody(false)));
    const pending = deferred();
    const inFlight = useConsentStore
      .getState()
      .setModelTrainingConsent(true, pending.fetchFn);
    clearApiSession();
    await useConsentStore.getState().hydrate();
    pending.reject(new Error('network down'));
    await inFlight;
    const s = useConsentStore.getState();
    // eslint-disable-next-line no-console
    console.log('C1', s);
    expect(s.busy || s.error !== null || s.availability !== 'signed_out').toBe(
      true,
    );
  });

  it('C2 REPRO?: grant FAILING after account switch shows A\'s error to B (expect refuted)', async () => {
    establishApiSession(sessionA);
    await useConsentStore.getState().hydrate(async () => ok(statusBody(false)));
    const pending = deferred();
    const inFlight = useConsentStore
      .getState()
      .setModelTrainingConsent(true, pending.fetchFn);
    establishApiSession(sessionB);
    await useConsentStore.getState().hydrate(async () => ok(statusBody(true)));
    pending.reject(new Error('network down'));
    await inFlight;
    const s = useConsentStore.getState();
    // eslint-disable-next-line no-console
    console.log('C2', s);
    expect(s.error !== null || s.modelTrainingActive !== true || s.busy).toBe(
      true,
    );
  });

  it('C3 REPRO?: HTTP 401 (expired bearer) is reported as generic "temporarily unavailable" (no re-auth hint)', async () => {
    establishApiSession(sessionA);
    await useConsentStore
      .getState()
      .hydrate(async () =>
        ({ ok: false, status: 401, json: () => Promise.resolve({ error: { code: 'auth.invalid' } }) }) as unknown as Response,
      );
    const s = useConsentStore.getState();
    // eslint-disable-next-line no-console
    console.log('C3', s);
    expect(s.availability).toBe('unavailable');
    expect(s.error).toBe('Consent settings are temporarily unavailable.');
  });
});
