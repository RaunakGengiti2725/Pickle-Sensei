/** Unsigned creation metadata, NOT durable native authority, media ownership,
 * rights, original-camera proof or attestation. Never synthesize it for legacy
 * clips. A fresh read can only compare current bytes to this supplied expectation. */
export interface NativeMediaIdentityV1 {
  readonly schemaVersion: 1;
  readonly format: 'pickle.native-media-identity.v1';
  readonly receiptId: string;
  /** Native creation UUID, distinct from a JS retry/comparison operation id. */
  readonly operationId: string;
  readonly videoFileName: string;
  readonly origin: 'import_copy' | 'native_export';
  readonly algorithm: 'sha256';
  readonly sha256: string;
  readonly byteSize: number;
}

export const MAX_NATIVE_MEDIA_BYTES = 536870912;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const IDENTITY_KEYS = [
  'schemaVersion',
  'format',
  'receiptId',
  'operationId',
  'videoFileName',
  'origin',
  'algorithm',
  'sha256',
  'byteSize',
];

export interface NativeClipByteComparisonRequest {
  uri: string;
  byteSize: number;
  nativeMediaIdentity: NativeMediaIdentityV1;
  operationId: string;
}

export type CurrentClipBytesResult =
  | { status: 'legacy' | 'mismatch' | 'unavailable' | 'cancelled' | 'invalid' }
  | {
      status: 'verified-current-bytes';
      /** Only the expectation compared during this read, not a reusable permit. */
      comparedExpectation: NativeMediaIdentityV1;
    };

export class InvalidNativeMediaIdentityError extends Error {
  constructor() {
    super('The native media byte expectation or comparison is invalid.');
    this.name = 'InvalidNativeMediaIdentityError';
  }
}

function exactDataRecord(
  value: unknown,
  keys: string[],
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false;
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    keys.every(key => {
      const field = Object.getOwnPropertyDescriptor(value, key);
      return field?.enumerable === true && 'value' in field;
    })
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

/** Parse without URL normalization: query/fragment, traversal, encoded path
 * separators and control bytes must not become a different native file path. */
function videoFileName(uri: string): string | null {
  if (uri.length > 4096 || /[\\ ?#]/.test(uri) || hasControlCharacters(uri))
    return null;
  const match = /^file:\/\/(?:localhost)?(\/.*)$/.exec(uri);
  if (!match || /%(?:2f|5c)/i.test(uri)) return null;
  try {
    const path = decodeURIComponent(match[1]!);
    if (/[\\?#%]/.test(path) || hasControlCharacters(path)) return null;
    const parts = path.split('/').slice(1);
    if (parts.some(part => !part || part === '.' || part === '..')) return null;
    return parts.at(-1) ?? null;
  } catch {
    return null;
  }
}

export function assertNativeMediaIdentity(
  value: unknown,
  outer: { uri: string; byteSize?: number },
): NativeMediaIdentityV1 {
  if (
    !exactDataRecord(value, IDENTITY_KEYS) ||
    value.schemaVersion !== 1 ||
    value.format !== 'pickle.native-media-identity.v1' ||
    typeof value.receiptId !== 'string' ||
    value.receiptId.length !== 36 ||
    !UUID.test(value.receiptId) ||
    typeof value.operationId !== 'string' ||
    value.operationId.length !== 36 ||
    !UUID.test(value.operationId) ||
    (value.origin !== 'import_copy' && value.origin !== 'native_export') ||
    value.algorithm !== 'sha256' ||
    typeof value.sha256 !== 'string' ||
    value.sha256.length !== 64 ||
    !/^[0-9a-f]{64}$/.test(value.sha256) ||
    typeof value.byteSize !== 'number' ||
    !Number.isSafeInteger(value.byteSize) ||
    value.byteSize < 1 ||
    value.byteSize > MAX_NATIVE_MEDIA_BYTES ||
    value.byteSize !== outer.byteSize ||
    typeof value.videoFileName !== 'string' ||
    value.videoFileName.length > 240 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(mov|mp4|m4v)$/.test(value.videoFileName) ||
    value.videoFileName !== videoFileName(outer.uri)
  )
    throw new InvalidNativeMediaIdentityError();
  return value as unknown as NativeMediaIdentityV1;
}

/** Response shape/echo validation only. Calling this parser by itself is not
 * a native byte read and does not authenticate the supplied creation metadata. */
export function assertCurrentClipByteComparison(
  value: unknown,
  expectation: NativeMediaIdentityV1,
  operationId: string,
): CurrentClipBytesResult {
  if (
    !exactDataRecord(value, [
      'status',
      'operationId',
      'receiptId',
      'videoFileName',
      'expectedSha256',
      'expectedByteSize',
    ]) ||
    (value.status !== 'verified-current-bytes' &&
      value.status !== 'mismatch') ||
    value.operationId !== operationId ||
    value.receiptId !== expectation.receiptId ||
    value.videoFileName !== expectation.videoFileName ||
    value.expectedSha256 !== expectation.sha256 ||
    value.expectedByteSize !== expectation.byteSize
  )
    throw new InvalidNativeMediaIdentityError();
  return value.status === 'mismatch'
    ? { status: 'mismatch' }
    : {
        status: 'verified-current-bytes',
        comparedExpectation: expectation,
      };
}
