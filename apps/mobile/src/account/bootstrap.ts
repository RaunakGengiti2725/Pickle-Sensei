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

function normalizeBaseUrl(value: string | null | undefined): string {
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

interface SessionTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

/** The revocable Supabase session minted by the one-time bootstrap exchange.
 * Required: without it the app would have to keep bearing the provider ID
 * token, which no server-side logout can revoke. */
function parseSessionTokens(payload: unknown): SessionTokens {
  const session = isRecord(payload) ? payload['session'] : null;
  if (isRecord(session)) {
    const accessToken = session['accessToken'];
    const refreshToken = session['refreshToken'];
    const expiresAt = session['expiresAt'];
    if (
      typeof accessToken === 'string' &&
      accessToken.trim() &&
      typeof refreshToken === 'string' &&
      refreshToken.trim() &&
      typeof expiresAt === 'number' &&
      Number.isFinite(expiresAt)
    ) {
      return { accessToken, refreshToken, expiresAtMs: expiresAt * 1000 };
    }
  }
  throw new AccountBootstrapError(
    'account.invalid_response',
    'The account server did not return a revocable session.',
    true,
  );
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

/**
 * Exchanges a provider-issued OIDC bearer — exactly once — for this app's
 * canonical account plus a revocable Supabase session. The provider subject
 * is deliberately absent from the result, and the provider token is never
 * used as an API bearer again.
 */
export async function bootstrapCanonicalAccount(
  input: AccountBootstrapInput,
): Promise<AccountBootstrapResult> {
  const apiBaseUrl = normalizeBaseUrl(input.apiBaseUrl);
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
      body: JSON.stringify(input.environment),
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
      bearerToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      bearerExpiresAtMs: tokens.expiresAtMs,
      canonicalAppUserId: account.id,
      provider: input.provider,
    },
  };
}
