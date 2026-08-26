/**
 * Zero-silent-failure policy (directive §6): every operation resolves to a
 * typed outcome. No invisible exceptions, no silent fallbacks.
 */

export type FailureKind =
  | "timeout"
  | "retryable"
  | "permanent"
  | "low_confidence"
  | "permission_denied"
  | "network"
  | "unsupported_device"
  | "corrupted_media"
  | "auth_failed"
  | "not_implemented";

export interface OperationFailure {
  kind: FailureKind;
  /** Stable machine-readable code, e.g. "media.upload.timeout". */
  code: string;
  /** Human-readable, safe to show in dev tooling; UI maps code → copy. */
  message: string;
  retryable: boolean;
  cause?: unknown;
}

export type Result<T> = { ok: true; value: T } | { ok: false; failure: OperationFailure };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function fail<T = never>(failure: OperationFailure): Result<T> {
  return { ok: false, failure };
}

export function failure(
  kind: FailureKind,
  code: string,
  message: string,
  cause?: unknown,
): OperationFailure {
  const retryable = kind === "timeout" || kind === "retryable" || kind === "network";
  return cause === undefined
    ? { kind, code, message, retryable }
    : { kind, code, message, retryable, cause };
}
