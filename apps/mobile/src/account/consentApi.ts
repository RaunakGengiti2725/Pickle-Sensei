import type { ApiSession } from './apiSession';

/**
 * First-party consent client. Two independent scopes: `video_analysis`
 * ("analyze my video") and `model_training` ("use my video to improve
 * models"). model_training is granted only by an explicit user action —
 * this client never sends a grant the user did not tap.
 */

export type ConsentScope = 'video_analysis' | 'model_training';
export type ConsentAction = 'granted' | 'withdrawn';

export const MODEL_TRAINING_CONSENT_VERSION = 'model-training-v1';

export interface ConsentScopeStatus {
  scope: ConsentScope;
  active: boolean;
  consentVersion: string | null;
  lastAction: ConsentAction | null;
  lastActionAt: string | null;
}

export interface ConsentStatus {
  subjectPseudonym: string | null;
  scopes: ConsentScopeStatus[];
}

export type ConsentFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export class ConsentApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConsentApiError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isScope(value: unknown): value is ConsentScope {
  return value === 'video_analysis' || value === 'model_training';
}

function parseStatus(payload: unknown): ConsentStatus {
  if (!isRecord(payload) || !Array.isArray(payload['scopes'])) {
    throw new ConsentApiError(
      'The consent server returned an invalid response.',
    );
  }
  const subjectPseudonym = payload['subjectPseudonym'];
  if (!(subjectPseudonym === null || typeof subjectPseudonym === 'string')) {
    throw new ConsentApiError(
      'The consent server returned an invalid response.',
    );
  }
  const scopes = payload['scopes'].map((row): ConsentScopeStatus => {
    if (
      !isRecord(row) ||
      !isScope(row['scope']) ||
      typeof row['active'] !== 'boolean'
    ) {
      throw new ConsentApiError(
        'The consent server returned an invalid response.',
      );
    }
    const lastAction = row['lastAction'];
    const lastActionAt = row['lastActionAt'];
    const consentVersion = row['consentVersion'];
    if (
      !(
        lastAction === null ||
        lastAction === 'granted' ||
        lastAction === 'withdrawn'
      ) ||
      !(lastActionAt === null || typeof lastActionAt === 'string') ||
      !(consentVersion === null || typeof consentVersion === 'string')
    ) {
      throw new ConsentApiError(
        'The consent server returned an invalid response.',
      );
    }
    return {
      scope: row['scope'],
      active: row['active'],
      consentVersion,
      lastAction,
      lastActionAt,
    };
  });
  return { subjectPseudonym, scopes };
}

async function consentRequest(
  session: ApiSession,
  fetchFn: ConsentFetch,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<ConsentStatus> {
  let response: Response;
  try {
    response = await fetchFn(`${session.apiBaseUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${session.bearerToken}`,
        'X-Client-Version': '0.1.0',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ConsentApiError('Consent settings are temporarily unavailable.');
  }
  const payload = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new ConsentApiError('Consent settings are temporarily unavailable.');
  }
  return parseStatus(payload);
}

export async function fetchConsentStatus(
  session: ApiSession,
  fetchFn: ConsentFetch = globalThis.fetch,
): Promise<ConsentStatus> {
  return consentRequest(session, fetchFn, 'GET', '/v1/me/consent/status');
}

export async function grantModelTrainingConsent(
  session: ApiSession,
  device: string,
  fetchFn: ConsentFetch = globalThis.fetch,
): Promise<ConsentStatus> {
  return consentRequest(session, fetchFn, 'POST', '/v1/me/consent/grant', {
    scope: 'model_training',
    consentVersion: MODEL_TRAINING_CONSENT_VERSION,
    source: 'mobile_settings',
    device,
    captureMode: 'all_captures',
  });
}

export async function withdrawModelTrainingConsent(
  session: ApiSession,
  device: string,
  fetchFn: ConsentFetch = globalThis.fetch,
): Promise<ConsentStatus> {
  return consentRequest(session, fetchFn, 'POST', '/v1/me/consent/withdraw', {
    scope: 'model_training',
    source: 'mobile_settings',
    device,
  });
}
