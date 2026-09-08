import { NativeModules, Platform } from 'react-native';

/**
 * Typed JS surface of the native `PickleOfflineWallet` module
 * (ios/LocalPods/PickleNative/Sources/PickleOfflineWallet.swift): signed
 * offline execution grants and not-yet-submitted receipts kept in their own
 * `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` Keychain service, replaced as one
 * atomic item per owner, fenced by a revision counter, and integrity-tagged
 * so corruption surfaces as a typed failure instead of an empty wallet.
 *
 * The wallet stores what it is given; verifying a grant's signature, owner,
 * device and policy binding before use stays with the caller
 * (@pickle/shared-types offlineAuthorization). `null` from `loadOfflineWallet`
 * means "nothing stored" — an unreadable wallet always rejects with
 * `tampered` / `integrity_key_missing` / `unsupported_version`, and only
 * `discardCorruptOfflineWallet` (after online reconciliation) removes it.
 */

export const OFFLINE_WALLET_NATIVE_FAILURES = [
  'invalid_owner',
  'invalid_grant',
  'invalid_receipt',
  'invalid_revision',
  'capacity_exceeded',
  'revision_conflict',
  'tampered',
  'integrity_key_missing',
  'unsupported_version',
  'not_corrupt',
  'storage_unavailable',
  'storage_denied',
  'storage_failure',
] as const;

export type OfflineWalletNativeFailure =
  (typeof OFFLINE_WALLET_NATIVE_FAILURES)[number];

/** Native failures plus the two the JS side can raise on its own. */
export type OfflineWalletFailure =
  OfflineWalletNativeFailure | 'not_configured' | 'bridge_contract';

export const OFFLINE_WALLET_ERROR_CODE_PREFIX = 'wallet.';

export interface OfflineWalletGrant {
  grantId: string;
  compactJws: string;
}

export type OfflineWalletReceiptKind = 'result' | 'unused_ticket_return';

export interface OfflineWalletReceipt {
  receiptId: string;
  kind: OfflineWalletReceiptKind;
  /** Serialized receipt object, submitted verbatim once online. */
  payloadJson: string;
}

export interface OfflineWalletContents {
  grants: readonly OfflineWalletGrant[];
  receipts: readonly OfflineWalletReceipt[];
}

export interface OfflineWalletSnapshot {
  ownerId: string;
  /** Per-owner write counter; pass it back as `expectedRevision`. */
  revision: number;
  grants: OfflineWalletGrant[];
  receipts: OfflineWalletReceipt[];
}

export class OfflineWalletError extends Error {
  readonly failure: OfflineWalletFailure;
  /** Stable code, `wallet.<failure>`. */
  readonly code: string;
  /** Keychain `OSStatus` when a Security call caused the failure. */
  readonly status: number | null;

  constructor(
    failure: OfflineWalletFailure,
    message: string,
    status: number | null = null,
  ) {
    super(message);
    this.name = 'OfflineWalletError';
    this.failure = failure;
    this.code = `${OFFLINE_WALLET_ERROR_CODE_PREFIX}${failure}`;
    this.status = status;
  }
}

/** Stored bytes exist but cannot be trusted; reconcile online, then discard. */
export function isOfflineWalletUnreadable(
  failure: OfflineWalletFailure,
): boolean {
  return (
    failure === 'tampered' ||
    failure === 'integrity_key_missing' ||
    failure === 'unsupported_version'
  );
}

/** Transient Keychain state (device not yet unlocked); retry later. */
export function isOfflineWalletRetryable(
  failure: OfflineWalletFailure,
): boolean {
  return failure === 'storage_unavailable';
}

interface NativePickleOfflineWallet {
  loadWallet(ownerId: string): Promise<unknown>;
  replaceWallet(
    ownerId: string,
    expectedRevision: number,
    contents: {
      grants: OfflineWalletGrant[];
      receipts: OfflineWalletReceipt[];
    },
  ): Promise<unknown>;
  clearWallet(ownerId: string, expectedRevision: number): Promise<unknown>;
  discardCorruptWallet(ownerId: string): Promise<unknown>;
}

function nativeModule(): NativePickleOfflineWallet | null {
  if (Platform.OS !== 'ios') return null;
  const module = (
    NativeModules as { PickleOfflineWallet?: NativePickleOfflineWallet }
  ).PickleOfflineWallet;
  if (
    !module ||
    typeof module.loadWallet !== 'function' ||
    typeof module.replaceWallet !== 'function' ||
    typeof module.clearWallet !== 'function' ||
    typeof module.discardCorruptWallet !== 'function'
  ) {
    return null;
  }
  return module;
}

export function offlineWalletAvailable(): boolean {
  return nativeModule() !== null;
}

function requireNative(): NativePickleOfflineWallet {
  const module = nativeModule();
  if (!module) {
    throw new OfflineWalletError(
      'not_configured',
      'The native offline wallet module is not linked on this platform.',
    );
  }
  return module;
}

export async function loadOfflineWallet(
  ownerId: string,
): Promise<OfflineWalletSnapshot | null> {
  const native = requireNative();
  const result = await native
    .loadWallet(ownerId)
    .catch(error => rethrowTyped(error));
  if (result === null || result === undefined) return null;
  return parseSnapshot(result);
}

export async function replaceOfflineWallet(
  ownerId: string,
  expectedRevision: number,
  contents: OfflineWalletContents,
): Promise<OfflineWalletSnapshot> {
  const native = requireNative();
  const result = await native
    .replaceWallet(ownerId, expectedRevision, {
      grants: contents.grants.map(grant => ({
        grantId: grant.grantId,
        compactJws: grant.compactJws,
      })),
      receipts: contents.receipts.map(receipt => ({
        receiptId: receipt.receiptId,
        kind: receipt.kind,
        payloadJson: receipt.payloadJson,
      })),
    })
    .catch(error => rethrowTyped(error));
  return parseSnapshot(result);
}

export async function clearOfflineWallet(
  ownerId: string,
  expectedRevision: number,
): Promise<void> {
  const native = requireNative();
  await native
    .clearWallet(ownerId, expectedRevision)
    .catch(error => rethrowTyped(error));
}

/** Resolves with the failure the discarded wallet had. */
export async function discardCorruptOfflineWallet(
  ownerId: string,
): Promise<OfflineWalletNativeFailure> {
  const native = requireNative();
  const result = await native
    .discardCorruptWallet(ownerId)
    .catch(error => rethrowTyped(error));
  if (typeof result !== 'string' || !isNativeFailure(result)) {
    throw new OfflineWalletError(
      'bridge_contract',
      'The native offline wallet reported an unknown discard outcome.',
    );
  }
  return result;
}

function isNativeFailure(value: string): value is OfflineWalletNativeFailure {
  return (OFFLINE_WALLET_NATIVE_FAILURES as readonly string[]).includes(value);
}

function rethrowTyped(error: unknown): never {
  throw toOfflineWalletError(error);
}

/** Maps a native rejection onto `OfflineWalletError`; unknown codes are a contract breach. */
export function toOfflineWalletError(error: unknown): OfflineWalletError {
  if (error instanceof OfflineWalletError) return error;
  const record =
    error && typeof error === 'object'
      ? (error as {
          code?: unknown;
          message?: unknown;
          userInfo?: unknown;
        })
      : {};
  const message =
    typeof record.message === 'string' && record.message.length > 0
      ? record.message
      : 'The native offline wallet call failed.';
  const status = readStatus(record.userInfo);
  if (
    typeof record.code === 'string' &&
    record.code.startsWith(OFFLINE_WALLET_ERROR_CODE_PREFIX)
  ) {
    const failure = record.code.slice(OFFLINE_WALLET_ERROR_CODE_PREFIX.length);
    if (isNativeFailure(failure)) {
      return new OfflineWalletError(failure, message, status);
    }
  }
  return new OfflineWalletError('bridge_contract', message, status);
}

function readStatus(userInfo: unknown): number | null {
  if (!userInfo || typeof userInfo !== 'object') return null;
  const status = (userInfo as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) ? status : null;
}

function parseSnapshot(value: unknown): OfflineWalletSnapshot {
  const contract = (detail: string) =>
    new OfflineWalletError(
      'bridge_contract',
      `The native offline wallet returned a malformed snapshot: ${detail}.`,
    );
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw contract('not an object');
  }
  const record = value as Record<string, unknown>;
  if (typeof record.ownerId !== 'string') throw contract('ownerId');
  if (
    typeof record.revision !== 'number' ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    throw contract('revision');
  }
  if (!Array.isArray(record.grants)) throw contract('grants');
  if (!Array.isArray(record.receipts)) throw contract('receipts');
  const grants = record.grants.map((raw: unknown): OfflineWalletGrant => {
    if (!raw || typeof raw !== 'object') throw contract('grant');
    const grant = raw as Record<string, unknown>;
    if (
      typeof grant.grantId !== 'string' ||
      typeof grant.compactJws !== 'string'
    ) {
      throw contract('grant fields');
    }
    return { grantId: grant.grantId, compactJws: grant.compactJws };
  });
  const receipts = record.receipts.map((raw: unknown): OfflineWalletReceipt => {
    if (!raw || typeof raw !== 'object') throw contract('receipt');
    const receipt = raw as Record<string, unknown>;
    if (
      typeof receipt.receiptId !== 'string' ||
      typeof receipt.payloadJson !== 'string' ||
      (receipt.kind !== 'result' && receipt.kind !== 'unused_ticket_return')
    ) {
      throw contract('receipt fields');
    }
    return {
      receiptId: receipt.receiptId,
      kind: receipt.kind,
      payloadJson: receipt.payloadJson,
    };
  });
  return {
    ownerId: record.ownerId,
    revision: record.revision,
    grants,
    receipts,
  };
}
