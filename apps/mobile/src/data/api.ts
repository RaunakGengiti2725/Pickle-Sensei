import type {
  AnalysisFeedbackCategory,
  AnalysisFeedbackRating,
} from '@pickle/shared-types';
import type { SyncTransport } from './sync';
import { reportApiUnauthorized } from '../account/apiSession';
import { getRuntimePublicConfig } from '../config/runtimeConfig';

/**
 * API client. Base URL/token come from app state; in development the API's
 * dev-token issuer is used (the API refuses dev tokens outside dev/test).
 */

export interface ApiConfigState {
  baseUrl: string;
  token: string | null;
}

export type ReleasableAnalysisOutcome =
  | 'low_confidence'
  | 'cancelled'
  | 'failed'
  | 'unsupported'
  | 'incorrect_recognition';

export interface ReservedAnalysisPermit {
  id: string;
  accessSource: 'free' | 'premium';
  status: 'reserved';
  expiresAt: string;
}

/** Post-reservation access snapshot returned beside every reserved permit. */
export interface ReserveAccessSnapshot {
  premium: boolean;
  freeRatings: {
    limit: number;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
}

export interface ReservedAnalysisPermitWithAccess {
  permit: ReservedAnalysisPermit;
  /** Absent when the server predates the access snapshot in this response. */
  access: ReserveAccessSnapshot | null;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Every request is bounded: a backend that stops responding must surface as
 * a typed timeout the caller can retry, never an indefinitely pending await
 * (which the capture flow would render as an unbounded spinner). */
export const API_REQUEST_TIMEOUT_MS = 20_000;

async function request<T>(
  config: ApiConfigState,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        'x-client-version': getRuntimePublicConfig().appVersion,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError(
        408,
        'network.timeout',
        'The server took too long to respond. Your work is saved on this device — try again when the connection recovers.',
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const json = (await response.json().catch(() => null)) as
    (T & { error?: { code: string; message: string } }) | null;
  if (!response.ok) {
    if (response.status === 401 && config.token) {
      reportApiUnauthorized(config.token);
    }
    throw new ApiError(
      response.status,
      json?.error?.code ?? 'unknown',
      json?.error?.message ?? response.statusText,
    );
  }
  return json as T;
}

export function createTransport(config: ApiConfigState): SyncTransport {
  return {
    async syncShots(shots) {
      return request(config, 'POST', '/v1/shots:sync', { shots });
    },
    async createSession(session) {
      await request(config, 'POST', '/v1/sessions', session);
    },
    async finalizeSession(id) {
      await request(config, 'POST', `/v1/sessions/${id}/finalize`);
    },
    async uploadEvaluationTrials(trials) {
      return request(config, 'POST', '/v1/me/evaluation/trials', { trials });
    },
  };
}

/** Reserve before inference. Successful scores are never finalized here: the
 * shot-sync transaction consumes them. Only abstentions and failures use the
 * explicit release path, so a client cannot create an unbound rating UUID. */
export function createAnalysisPermitClient(config: ApiConfigState) {
  const requireSignedIn = () => {
    if (!config.token?.trim()) {
      throw new ApiError(
        401,
        'auth.required',
        'Sign in before reserving an analysis rating.',
      );
    }
  };
  return {
    async reserve(
      idempotencyKey: string,
    ): Promise<ReservedAnalysisPermitWithAccess> {
      requireSignedIn();
      const response = await request<{
        permit: ReservedAnalysisPermit;
        access?: ReserveAccessSnapshot;
      }>(config, 'POST', '/v1/analysis-permits', { idempotencyKey });
      if (response.permit.status !== 'reserved') {
        throw new ApiError(
          409,
          'access.permit_not_reserved',
          'The analysis permit is no longer reserved.',
        );
      }
      return {
        permit: response.permit,
        access: parseReserveAccess(response.access),
      };
    },

    async release(
      permitId: string,
      outcome: ReleasableAnalysisOutcome,
    ): Promise<void> {
      requireSignedIn();
      await request(
        config,
        'POST',
        `/v1/analysis-permits/${encodeURIComponent(permitId)}/finalize`,
        { outcome, ratingId: null },
      );
    },
  };
}

/** Defensive parse of the reserve-time access snapshot: a malformed or
 * missing block degrades to null (no popup heuristics run on it) instead of
 * failing the reservation that gates the user's analysis. */
function parseReserveAccess(value: unknown): ReserveAccessSnapshot | null {
  if (typeof value !== 'object' || value === null) return null;
  const access = value as {
    premium?: unknown;
    freeRatings?: Record<string, unknown>;
  };
  const ratings = access.freeRatings;
  if (typeof access.premium !== 'boolean' || !ratings) return null;
  const numbers = [
    ratings.limit,
    ratings.used,
    ratings.reserved,
    ratings.remaining,
    ratings.availableToReserve,
  ];
  if (numbers.some(n => typeof n !== 'number' || !Number.isFinite(n))) {
    return null;
  }
  return {
    premium: access.premium,
    freeRatings: {
      limit: ratings.limit as number,
      used: ratings.used as number,
      reserved: ratings.reserved as number,
      remaining: ratings.remaining as number,
      availableToReserve: ratings.availableToReserve as number,
    },
  };
}

/** "Was this analysis accurate?" — a failure-mining signal, never gold.
 * The server derives review eligibility from the consent ledger and copies
 * the version vector from the synced shot row; the client sends only the
 * rating and, for a negative one, a category. */
export async function submitAnalysisFeedback(
  config: ApiConfigState,
  analysisId: string,
  rating: AnalysisFeedbackRating,
  category: AnalysisFeedbackCategory | null,
): Promise<{ reviewEligible: boolean }> {
  const response = await request<{
    feedback: { reviewEligible: boolean };
  }>(
    config,
    'POST',
    `/v1/analyses/${encodeURIComponent(analysisId)}/feedback`,
    {
      rating,
      category,
    },
  );
  return { reviewEligible: response.feedback.reviewEligible };
}

export const api = { request };
