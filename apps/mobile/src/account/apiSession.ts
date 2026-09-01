import { create } from 'zustand';

/**
 * Authenticated API material held in memory only.
 *
 * `canonicalAppUserId` is always the UUID returned by `/v1/account/bootstrap`.
 * It is never an Apple user identifier or Google subject. The bearer is not
 * written to SQLite, AsyncStorage, logs, crash metadata, or UI state.
 */
export interface ApiSession {
  apiBaseUrl: string;
  bearerToken: string;
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
