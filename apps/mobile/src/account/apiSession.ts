import { create } from 'zustand';

/**
 * Authenticated API material held in memory.
 *
 * `canonicalAppUserId` is always the UUID returned by `/v1/account/bootstrap`.
 * It is never an Apple user identifier or Google subject. `bearerToken` is
 * the Supabase access token minted by the bootstrap exchange (transitionally
 * the provider ID token itself when an older server returned no session);
 * `refreshToken` rotates it through `/v1/auth/refresh`. The access token is
 * never written to SQLite, AsyncStorage, logs, crash metadata, or UI state;
 * the refresh token's only durable home is the device Keychain
 * (`sessionVault.ts`), so a relaunch restores the session without asking the
 * user to sign in again.
 */
export interface ApiSession {
  apiBaseUrl: string;
  bearerToken: string;
  canonicalAppUserId: string;
  provider: 'apple' | 'google';
  /** Absent for a legacy provider-token session — nothing to rotate. */
  refreshToken?: string | null;
  /** Access-token expiry (ms since epoch); absent when unknown. */
  bearerExpiresAtMs?: number | null;
}

interface ApiSessionState {
  session: ApiSession | null;
}

export const useApiSessionStore = create<ApiSessionState>(() => ({
  session: null,
}));

export function getApiSession(): ApiSession | null {
  return useApiSessionStore.getState().session;
}

/**
 * The bearer long-lived API clients (sync transport, billing, training) must
 * resolve on EVERY request: it follows the rotating access token without
 * reconfiguring them, and it is bound to one account — once another account's
 * session is current (or none is), it yields null, so a request that was
 * queued for the previous owner can never go out under the new bearer.
 */
export function bearerTokenFor(canonicalAppUserId: string): string | null {
  const session = getApiSession();
  return session && session.canonicalAppUserId === canonicalAppUserId
    ? session.bearerToken
    : null;
}

/** Used only after a successful, server-verified account bootstrap or
 * session refresh. */
export function establishApiSession(session: ApiSession): void {
  useApiSessionStore.setState({ session });
}

/** Clears bearer + canonical account binding synchronously on sign-out. */
export function clearApiSession(): void {
  useApiSessionStore.setState({ session: null });
}

export function subscribeToApiSession(
  listener: (session: ApiSession | null) => void,
): () => void {
  return useApiSessionStore.subscribe(state => listener(state.session));
}

type ApiUnauthorizedListener = (session: ApiSession) => void;

let unauthorizedListener: ApiUnauthorizedListener | null = null;

/** Installed by the auth store; receives the session whose bearer the API
 * rejected so it can re-establish or end the signed-in state. */
export function setApiUnauthorizedListener(
  listener: ApiUnauthorizedListener | null,
): void {
  unauthorizedListener = listener;
}

/**
 * API clients call this after a 401. Only a rejection of the bearer that is
 * still current counts; late responses for an already replaced or cleared
 * session are ignored so one expiry cannot tear down its successor.
 */
export function reportApiUnauthorized(bearerToken: string): void {
  const session = getApiSession();
  if (!session || session.bearerToken !== bearerToken) return;
  unauthorizedListener?.(session);
}
