import type { ApiSession } from './apiSession';
import type { AccountBootstrapEnvironment } from './deviceContext';

export type AccountProvider = ApiSession['provider'];

export interface CanonicalAccount {
  id: string;
  email: string | null;
  onboardingState: 'pending' | 'complete';
}

export interface AccountBootstrapResult {
  account: CanonicalAccount;
  apiSession: ApiSession;
}

export type AccountBootstrapFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

export interface AccountBootstrapInput {
  apiBaseUrl: string | null | undefined;
  bearerToken: string | null | undefined;
  provider: AccountProvider;
  /** One-use credential returned beside an Apple identity token. It is sent
   * directly to the backend for Apple's token exchange and is never persisted
   * by the app. Google bootstrap leaves this absent. */
  appleAuthorizationCode?: string | null;
  environment: AccountBootstrapEnvironment;
  fetchFn?: AccountBootstrapFetch;
}

export class AccountBootstrapError extends Error {
  constructor(
    readonly code:
      | 'account.not_configured'
      | 'account.invalid_token'
      | 'account.unavailable'
      | 'account.rejected'
      | 'account.invalid_response',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AccountBootstrapError';
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** The configured API origin, validated the same way for every caller
 * (bootstrap and session restore alike). Throws a non-retryable
 * `account.not_configured` when the build has no usable API URL. */
export function normalizeApiBaseUrl(value: string | null | undefined): string {
  const baseUrl = value?.trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new AccountBootstrapError(
      'account.not_configured',
      'Synced accounts need a public API URL in the release configuration.',
      false,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new AccountBootstrapError(
      'account.not_configured',
      'The configured account API URL is invalid.',
      false,
    );
  }
  const localDevelopmentHost =
    parsed.hostname === 'localhost' ||
    parsed.hostname === '127.0.0.1' ||
    parsed.hostname === '10.0.2.2';
  if (parsed.protocol !== 'https:' && !localDevelopmentHost) {
    throw new AccountBootstrapError(
      'account.not_configured',
      'The account API must use HTTPS outside local development.',
      false,
    );
  }
  return baseUrl;
}

async function readPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new AccountBootstrapError(
      'account.invalid_response',
      'The account server returned an unreadable response.',
      true,
    );
  }
}

function serverMessage(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload['error'])) return null;
  const message = payload['error']['message'];
  return typeof message === 'string' && message.trim() ? message : null;
}

function parseCanonicalAccount(payload: unknown): CanonicalAccount {
  if (!isRecord(payload) || !isRecord(payload['user'])) {
    throw new AccountBootstrapError(
      'account.invalid_response',
      'The account server did not return a canonical account.',
      true,
    );
  }
  const id = payload['user']['id'];
  const email = payload['user']['email'];
  const onboardingState = payload['onboardingState'];
  if (
    typeof id !== 'string' ||
    !UUID_PATTERN.test(id) ||
    !(email === null || typeof email === 'string') ||
    (onboardingState !== 'pending' && onboardingState !== 'complete')
  ) {
    throw new AccountBootstrapError(
      'account.invalid_response',
      'The account server returned invalid canonical account data.',
      true,
    );
  }
  return { id, email, onboardingState };
}

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

/**
 * The durable Supabase session minted by the bootstrap exchange: the access
 * token the app bears from now on plus the refresh token that restores it on
 * the next launch. Null when the server predates the session contract — the
 * app then bears the provider token for this run, exactly as before, and
 * simply has nothing to persist.
 */
function parseSessionTokens(payload: unknown): SessionTokens | null {
  const session = isRecord(payload) ? payload['session'] : null;
  if (!isRecord(session)) return null;
  const accessToken = session['accessToken'];
  const refreshToken = session['refreshToken'];
  const expiresAt = session['expiresAt'];
  if (
    typeof accessToken !== 'string' ||
    !accessToken.trim() ||
    typeof refreshToken !== 'string' ||
    !refreshToken.trim() ||
    typeof expiresAt !== 'number' ||
    !Number.isFinite(expiresAt)
  ) {
    return null;
  }
  return { accessToken, refreshToken, expiresAtMs: expiresAt * 1000 };
}

/**
 * Exchanges a provider-issued OIDC bearer for this app's canonical account
 * and its durable Supabase session. The provider subject is deliberately
 * absent from the result.
 */
export async function bootstrapCanonicalAccount(
  input: AccountBootstrapInput,
): Promise<AccountBootstrapResult> {
  const apiBaseUrl = normalizeApiBaseUrl(input.apiBaseUrl);
  const bearerToken = input.bearerToken?.trim();
  if (!bearerToken) {
    throw new AccountBootstrapError(
      'account.invalid_token',
      'The identity provider did not return a token for secure account setup.',
      false,
    );
  }
  const fetchFn = input.fetchFn ?? globalThis.fetch;
  if (!fetchFn) {
    throw new AccountBootstrapError(
      'account.not_configured',
      'Network access is not available in this build.',
      false,
    );
  }

  let response: Response;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    response = await fetchFn(`${apiBaseUrl}/v1/account/bootstrap`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
        'X-Client-Version': input.environment.device.appVersion,
      },
      body: JSON.stringify({
        ...input.environment,
        ...(input.provider === 'apple' && input.appleAuthorizationCode?.trim()
          ? { appleAuthorizationCode: input.appleAuthorizationCode.trim() }
          : {}),
      }),
    });
  } catch {
    throw new AccountBootstrapError(
      'account.unavailable',
      'Secure account setup is temporarily unavailable.',
      true,
    );
  } finally {
    clearTimeout(timeout);
  }

  const payload = await readPayload(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new AccountBootstrapError(
        'account.rejected',
        serverMessage(payload) ??
          'The account server could not verify this identity provider token.',
        false,
      );
    }
    throw new AccountBootstrapError(
      'account.unavailable',
      serverMessage(payload) ?? 'Secure account setup could not be completed.',
      response.status >= 500 || response.status === 429,
    );
  }

  const account = parseCanonicalAccount(payload);
  const tokens = parseSessionTokens(payload);
  return {
    account,
    apiSession: {
      apiBaseUrl,
      bearerToken: tokens?.accessToken ?? bearerToken,
      canonicalAppUserId: account.id,
      provider: input.provider,
      refreshToken: tokens?.refreshToken ?? null,
      bearerExpiresAtMs: tokens?.expiresAtMs ?? null,
    },
  };
}
