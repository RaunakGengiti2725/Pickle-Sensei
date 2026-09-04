/**
 * Reference model for `src/account/sessionVault.ts`.
 *
 * The model is written from the module's documented contract (AGENTS.md
 * "Auth sessions", the file header, REVIEW.md "Auth & session on mobile"),
 * NOT from its implementation:
 *
 *  - the vault owns exactly one Keychain item, service
 *    `com.picklesensei.auth.session`, account `session`, accessibility
 *    `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`;
 *  - `savePersistedSession` reports whether the record is now durable — a
 *    Keychain refusal (throw or `false`) is reported, never thrown;
 *  - `loadPersistedSession` returns the record only when it parses as a
 *    version-1 session with a usable provider, canonical id and refresh
 *    token; anything else yields `null` AND is discarded;
 *  - `clearPersistedSession` removes the item and swallows every error;
 *  - no operation ever throws, and no operation ever touches another item.
 */
import type { PersistedSession } from '../../src/account/sessionVault';
import type { KeychainItem, KeychainOpMode } from './keychainFake';

export const VAULT_SERVICE = 'com.picklesensei.auth.session';
export const VAULT_ACCOUNT = 'session';
export const VAULT_ACCESSIBLE = 'AccessibleAfterFirstUnlockThisDeviceOnly';
export const PERSISTED_SESSION_KEYS = [
  'canonicalAppUserId',
  'displayName',
  'email',
  'provider',
  'refreshToken',
  'version',
] as const;

export interface ModelState {
  items: Map<string, KeychainItem>;
  setMode: KeychainOpMode;
  getMode: KeychainOpMode;
  resetMode: KeychainOpMode;
}

export function initialModel(): ModelState {
  return {
    items: new Map<string, KeychainItem>(),
    setMode: 'ok',
    getMode: 'ok',
    resetMode: 'ok',
  };
}

export function modelSnapshot(state: ModelState): Record<string, KeychainItem> {
  const out: Record<string, KeychainItem> = {};
  for (const [service, item] of [...state.items.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    out[service] = { ...item };
  }
  return out;
}

/** The contract's parser, restated. */
export function modelParse(raw: string): PersistedSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const provider = record['provider'];
  const canonicalAppUserId = record['canonicalAppUserId'];
  const refreshToken = record['refreshToken'];
  const usableString = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0;
  if (
    record['version'] !== 1 ||
    (provider !== 'apple' && provider !== 'google') ||
    !usableString(canonicalAppUserId) ||
    !usableString(refreshToken)
  ) {
    return null;
  }
  const optional = (value: unknown): string | null =>
    typeof value === 'string' ? value : null;
  return {
    version: 1,
    provider,
    canonicalAppUserId,
    refreshToken,
    email: optional(record['email']),
    displayName: optional(record['displayName']),
  };
}

/** Model of `clearPersistedSession()`. */
export function modelClear(state: ModelState): void {
  if (state.resetMode !== 'ok') return;
  state.items.delete(VAULT_SERVICE);
}

/** Model of `savePersistedSession(session)`. */
export function modelSave(state: ModelState, raw: string): boolean {
  if (state.setMode !== 'ok') return false;
  state.items.set(VAULT_SERVICE, {
    username: VAULT_ACCOUNT,
    password: raw,
    accessible: VAULT_ACCESSIBLE,
  });
  return true;
}

export interface ModelLoad {
  session: PersistedSession | null;
  /** True when the step had a stored item that the contract rejects. */
  discardAttempted: boolean;
}

/** Model of `loadPersistedSession()`. */
export function modelLoad(state: ModelState): ModelLoad {
  if (state.getMode !== 'ok') return { session: null, discardAttempted: false };
  const item = state.items.get(VAULT_SERVICE);
  if (!item) return { session: null, discardAttempted: false };
  const session = modelParse(item.password);
  if (session) return { session, discardAttempted: false };
  modelClear(state);
  return { session: null, discardAttempted: true };
}
