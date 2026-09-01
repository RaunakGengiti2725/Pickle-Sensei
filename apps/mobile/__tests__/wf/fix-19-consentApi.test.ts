import type { ConsentFetch } from '../../src/account/consentApi';
import {
  CONSENT_REQUEST_TIMEOUT_MS,
  ConsentApiError,
  fetchConsentStatus,
  grantModelTrainingConsent,
} from '../../src/account/consentApi';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

const session = {
  apiBaseUrl: 'https://api.test',
  bearerToken: 'token-1',
  canonicalAppUserId: 'a0000000-0000-0000-0000-000000000001',
  provider: 'apple' as const,
};

const statusBody = {
  subjectPseudonym: null,
  scopes: [
    {
      scope: 'model_training',
      active: false,
      consentVersion: null,
      lastAction: null,
      lastActionAt: null,
    },
  ],
};

function jsonResponse(body: unknown): Response {
  return { ok: true, json: () => Promise.resolve(body) } as unknown as Response;
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  return init?.headers as Record<string, string>;
}

describe('consentApi request envelope', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('sends the shipped app version as X-Client-Version', async () => {
    const fetchFn = jest.fn<ReturnType<ConsentFetch>, Parameters<ConsentFetch>>(
      () => Promise.resolve(jsonResponse(statusBody)),
    );
    await fetchConsentStatus(session, fetchFn);
    await grantModelTrainingConsent(session, 'iPhone', fetchFn);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const appVersion = getRuntimePublicConfig().appVersion;
    expect(appVersion).toBe('1.0');
    for (const [, init] of fetchFn.mock.calls) {
      expect(headersOf(init)['X-Client-Version']).toBe(appVersion);
    }
  });

  it('aborts a hung request after the deadline and reports it as unavailable', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn<ReturnType<ConsentFetch>, Parameters<ConsentFetch>>(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
        }),
    );

    const pending = fetchConsentStatus(session, fetchFn);
    const settled = jest.fn();
    pending.then(settled, settled);

    jest.advanceTimersByTime(CONSENT_REQUEST_TIMEOUT_MS - 1);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    await expect(pending).rejects.toBeInstanceOf(ConsentApiError);
    await expect(pending).rejects.toThrow(
      'Consent settings are temporarily unavailable.',
    );
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('clears the deadline timer once the request settles', async () => {
    jest.useFakeTimers();
    const fetchFn = jest.fn<ReturnType<ConsentFetch>, Parameters<ConsentFetch>>(
      () => Promise.resolve(jsonResponse(statusBody)),
    );
    await fetchConsentStatus(session, fetchFn);
    expect(jest.getTimerCount()).toBe(0);
    expect(fetchFn.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
  });
});
