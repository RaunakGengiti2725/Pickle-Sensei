import { create } from 'zustand';

/**
 * Authenticated API material held in memory only.
 *
 * `canonicalAppUserId` is always the UUID returned by `/v1/account/bootstrap`.
 * It is never an Apple user identifier or Google subject. `bearerToken` is
 * the short-lived Supabase access token minted by the bootstrap exchange (the
 * provider ID token is never reused as an API bearer); `refreshToken` rotates
 * it via `/v1/auth/refresh` and is revoked server-side by `/v1/auth/logout`.
 * None of this material is written to SQLite, AsyncStorage, logs, crash
 * metadata, or UI state.
 */
export interface ApiSession {
  apiBaseUrl: string;
  bearerToken: string;
  refreshToken: string;
  bearerExpiresAtMs: number;
  canonicalAppUserId: string;
  provider: 'apple' | 'google';
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

/** Used only after a successful, server-verified account bootstrap. */
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
