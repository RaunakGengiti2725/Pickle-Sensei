export const SESSION_RESTORE_KV_KEY = 'auth.restore-state';

export type SyncedProvider = 'apple' | 'google';
export type ReturningSessionReason =
  'legacy_credentials_missing' | 'credentials_missing' | 'revoked';

export interface ReturningSessionState {
  status: 'reauth_required';
  reason: ReturningSessionReason;
  provider: SyncedProvider | null;
  noticePending: boolean;
}

export type AuthRestoreState =
  | { status: 'restoring' }
  | { status: 'restored'; connectivity: 'online' | 'offline' }
  | { status: 'guest' }
  | {
      status: 'signed_out';
      reason: 'new_install' | 'user_sign_out' | 'account_deleted';
    }
  | ReturningSessionState
  | {
      status: 'unavailable';
      reason:
        | 'vault_unavailable'
        | 'vault_invalid'
        | 'vault_unsupported'
        | 'local_storage_unavailable'
        | 'legacy_restore_unavailable';
    };

export type SessionRestoreRecord = (
  | { version: 1; status: 'active'; provider: SyncedProvider }
  | {
      version: 1;
      status: 'replacing';
      provider: SyncedProvider;
      generation: number;
    }
  | { version: 1; status: 'guest' }
  | {
      version: 1;
      status: 'signed_out';
      reason: 'user_sign_out' | 'account_deleted';
    }
  | ({ version: 1 } & ReturningSessionState)
) & { generation?: number };

export function parseSessionRestoreRecord(
  raw: string | null,
): SessionRestoreRecord | null {
  if (raw === null || raw === '') return null;
  const value: unknown = JSON.parse(raw);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const provider = record['provider'];
    const isProvider = provider === 'apple' || provider === 'google';
    const reason = record['reason'];
    const generation = record['generation'];
    if (
      generation !== undefined &&
      (typeof generation !== 'number' ||
        !Number.isSafeInteger(generation) ||
        generation < 0)
    ) {
      throw new Error('The saved restore generation is unreadable.');
    }
    const scope = generation === undefined ? {} : { generation };
    if (record['version'] === 1) {
      if (record['status'] === 'guest') {
        return { version: 1, status: 'guest', ...scope };
      }
      if (record['status'] === 'active' && isProvider) {
        return { version: 1, status: 'active', provider, ...scope };
      }
      if (
        record['status'] === 'replacing' &&
        isProvider &&
        typeof generation === 'number' &&
        generation > 0
      ) {
        return { version: 1, status: 'replacing', provider, generation };
      }
      if (
        record['status'] === 'signed_out' &&
        (reason === 'user_sign_out' || reason === 'account_deleted')
      ) {
        return { version: 1, status: 'signed_out', reason, ...scope };
      }
      if (
        record['status'] === 'reauth_required' &&
        (reason === 'legacy_credentials_missing' ||
          reason === 'credentials_missing' ||
          reason === 'revoked') &&
        (provider === null || isProvider) &&
        typeof record['noticePending'] === 'boolean'
      ) {
        return {
          version: 1,
          status: 'reauth_required',
          reason,
          provider,
          noticePending: record['noticePending'],
          ...scope,
        };
      }
    }
  }
  throw new Error('The saved restore state is unreadable.');
}

export function permitsPersistedSession(
  record: SessionRestoreRecord | null,
  generation = 0,
): boolean {
  if (!record) return true;
  if (record.status === 'active' || record.status === 'replacing') {
    return generation >= (record.generation ?? 0);
  }
  if (
    record.status === 'reauth_required' &&
    record.reason === 'legacy_credentials_missing' &&
    record.generation === undefined
  ) {
    return true;
  }
  return record.generation !== undefined && generation > record.generation;
}

export function returningSessionState(
  reason: ReturningSessionReason,
  provider: SyncedProvider | null,
  previous: SessionRestoreRecord | null = null,
): ReturningSessionState {
  return {
    status: 'reauth_required',
    reason,
    provider,
    noticePending:
      previous?.status === 'reauth_required' &&
      previous.reason === reason &&
      previous.provider === provider
        ? previous.noticePending
        : true,
  };
}
