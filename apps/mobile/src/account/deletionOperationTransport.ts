import type { DataOwnerContext } from '../data/accountScope';
import {
  DELETION_FOUNDATION_LIMITS,
  deletionCapability,
  deletionExact,
  deletionInteger,
  deletionOrigin,
  deletionRecord,
  deletionUuid,
  parseDeletionRequest,
  parseDeletionSecret,
  parseDeletionStatus,
  sameDeletionBinding,
  type DeletionBinding,
  type DeletionHttpPort,
  type DeletionReceipt,
  type DeletionRequestWire,
  type DeletionRuntimePort,
  type DeletionScope,
  type DeletionSecretRecord,
  type DeletionStatusWire,
} from './deletionOperationContracts';

export interface DeletionTransportContext extends DeletionScope {
  readonly activeOwner: DataOwnerContext;
  readonly originGeneration: number;
}

const completedReceipts = new WeakMap<DeletionReceipt, DeletionBinding>();
const completedStatuses = new WeakMap<DeletionStatusWire, DeletionReceipt>();

function completionEvidence(
  binding: DeletionBinding,
  receipt: DeletionReceipt,
): DeletionReceipt {
  const evidence = Object.freeze({
    completedAt: receipt.completedAt,
    appleAuthorizationRevocation: receipt.appleAuthorizationRevocation,
  });
  completedReceipts.set(
    evidence,
    Object.freeze({
      jobId: binding.jobId,
      ownerId: binding.ownerId,
      apiOrigin: binding.apiOrigin,
      operationId: binding.operationId,
    }),
  );
  return evidence;
}

export function isVerifiedDeletionReceipt(
  receipt: DeletionReceipt,
  binding: DeletionBinding,
): boolean {
  const verified = completedReceipts.get(receipt);
  return verified !== undefined && sameDeletionBinding(verified, binding);
}

export function receiptFromVerifiedDeletionStatus(
  status: DeletionStatusWire,
): DeletionReceipt | null {
  return completedStatuses.get(status) ?? null;
}

export type DeletionTransportFailure =
  | {
      readonly kind:
        | 'stale'
        | 'session_required'
        | 'invalid_binding'
        | 'invalid_response'
        | 'unknown'
        | 'confirmation_expired'
        | 'blocked'
        | 'rejected';
    }
  | {
      readonly kind: 'in_progress' | 'rate_limited';
      readonly retryAfterMs: number;
    };

export type DeletionRequestReply =
  | { readonly kind: 'requested'; readonly request: DeletionRequestWire }
  | DeletionTransportFailure;
export type DeletionConfirmReply =
  | { readonly kind: 'completed'; readonly receipt: DeletionReceipt }
  | DeletionTransportFailure;
export type DeletionStatusReply =
  | { readonly kind: 'status'; readonly status: DeletionStatusWire }
  | DeletionTransportFailure;

type HttpReply =
  | {
      readonly kind: 'response';
      readonly status: number;
      readonly payload: unknown;
      readonly retryAfterMs: number | null;
    }
  | { readonly kind: 'unknown' | 'invalid_response' };

function responseWithinLimit(text: string): boolean {
  if (text.length > DELETION_FOUNDATION_LIMITS.responseBytes) return false;
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes > DELETION_FOUNDATION_LIMITS.responseBytes) return false;
  }
  return true;
}

function retryAfter(value: string | null): number | null {
  if (value === null || !/^\d{1,5}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds > 0 && seconds <= 86_400 ? seconds * 1000 : null;
}

function failure(
  reply: Extract<HttpReply, { kind: 'response' }>,
  statusOnly: boolean,
): DeletionTransportFailure {
  if (reply.status === 429)
    return { kind: 'rate_limited', retryAfterMs: reply.retryAfterMs ?? 60_000 };
  if (statusOnly) return { kind: 'unknown' };
  if (reply.status === 401) return { kind: 'session_required' };
  const error =
    deletionRecord(reply.payload) && deletionRecord(reply.payload.error)
      ? reply.payload.error
      : null;
  if (reply.status === 409 && error?.code === 'account.deletion_in_progress')
    return { kind: 'in_progress', retryAfterMs: reply.retryAfterMs ?? 3000 };
  if (
    reply.status === 403 &&
    error?.code === 'account.deletion_challenge_expired'
  )
    return { kind: 'confirmation_expired' };
  if (reply.status === 409 && error?.code === 'account.deletion_blocked')
    return { kind: 'blocked' };
  if (reply.status === 400 || reply.status === 403) return { kind: 'rejected' };
  return { kind: 'unknown' };
}

export function createDeletionOperationTransport(dependencies: {
  readonly runtime: DeletionRuntimePort;
  readonly http: DeletionHttpPort;
  readonly now?: () => number;
  readonly timeoutMs?: number;
}) {
  const contexts = new WeakSet<DeletionTransportContext>();
  const timeoutMs =
    deletionInteger(dependencies.timeoutMs) &&
    dependencies.timeoutMs > 0 &&
    dependencies.timeoutMs <= 30_000
      ? dependencies.timeoutMs
      : 15_000;
  let disposed = false;

  function snapshots() {
    try {
      const origin = dependencies.runtime.originSnapshot();
      const activeOwner = dependencies.runtime.ownerSnapshot();
      if (
        disposed ||
        !deletionOrigin(origin.apiOrigin) ||
        !deletionInteger(origin.generation) ||
        !deletionInteger(activeOwner.generation) ||
        (!deletionUuid(activeOwner.ownerKey) &&
          activeOwner.ownerKey !== 'signed-out' &&
          activeOwner.ownerKey !== 'device-guest')
      )
        return null;
      return {
        origin: Object.freeze({
          apiOrigin: origin.apiOrigin,
          generation: origin.generation,
        }),
        activeOwner: Object.freeze({
          ownerKey: activeOwner.ownerKey,
          generation: activeOwner.generation,
        }),
      };
    } catch {
      return null;
    }
  }

  function capture(scope?: DeletionScope): DeletionTransportContext | null {
    const current = snapshots();
    if (!current) return null;
    try {
      const ownerId = scope ? scope.ownerId : current.activeOwner.ownerKey;
      if (
        !deletionUuid(ownerId) ||
        (scope &&
          (!deletionOrigin(scope.apiOrigin) ||
            scope.apiOrigin !== current.origin.apiOrigin))
      )
        return null;
      const context = Object.freeze({
        ownerId,
        apiOrigin: current.origin.apiOrigin,
        activeOwner: current.activeOwner,
        originGeneration: current.origin.generation,
      });
      contexts.add(context);
      return context;
    } catch {
      return null;
    }
  }

  function isCurrent(context: DeletionTransportContext): boolean {
    if (!contexts.has(context)) return false;
    const current = snapshots();
    return (
      current !== null &&
      current.origin.apiOrigin === context.apiOrigin &&
      current.origin.generation === context.originGeneration &&
      current.activeOwner.ownerKey === context.activeOwner.ownerKey &&
      current.activeOwner.generation === context.activeOwner.generation
    );
  }

  function sessionBearer(context: DeletionTransportContext): string | null {
    if (!isCurrent(context) || context.ownerId !== context.activeOwner.ownerKey)
      return null;
    try {
      const bearer = dependencies.runtime.bearerFor(context.activeOwner);
      return typeof bearer === 'string' &&
        /^[A-Za-z0-9._~-]{1,8192}$/.test(bearer) &&
        !deletionCapability(bearer) &&
        isCurrent(context)
        ? bearer
        : null;
    } catch {
      return null;
    }
  }

  function secretsFor(
    context: DeletionTransportContext,
    value: DeletionSecretRecord,
  ): DeletionSecretRecord | null {
    const record = parseDeletionSecret(value);
    return record &&
      record.ownerId === context.ownerId &&
      record.apiOrigin === context.apiOrigin
      ? record
      : null;
  }

  async function post(
    context: DeletionTransportContext,
    path: string,
    bearer: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<HttpReply> {
    const controller = new AbortController();
    const url = `${context.apiOrigin}/v1/me/${path}`;
    let finished = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<HttpReply>(resolve => {
      timer = setTimeout(() => {
        finished = true;
        controller.abort();
        resolve({ kind: 'unknown' });
      }, timeoutMs);
    });
    const request = (async (): Promise<HttpReply> => {
      try {
        const response = await dependencies.http.fetchNoRedirect(url, {
          method: 'POST',
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
          referrerPolicy: 'no-referrer',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${bearer}`,
          },
          body: JSON.stringify(body),
        });
        if (finished) return { kind: 'unknown' };
        if (
          !response ||
          response.redirected !== false ||
          response.url !== url ||
          !Number.isInteger(response.status) ||
          response.status < 100 ||
          response.status > 599
        )
          return { kind: 'invalid_response' };
        const declared = response.headers.get('Content-Length');
        if (
          declared !== null &&
          (!/^\d+$/.test(declared) ||
            Number(declared) > DELETION_FOUNDATION_LIMITS.responseBytes)
        )
          return { kind: 'invalid_response' };
        const text = await response.text();
        if (finished) return { kind: 'unknown' };
        if (typeof text !== 'string' || !responseWithinLimit(text))
          return { kind: 'invalid_response' };
        let payload: unknown;
        try {
          payload = JSON.parse(text);
        } catch {
          return { kind: 'invalid_response' };
        }
        return {
          kind: 'response',
          status: response.status,
          payload,
          retryAfterMs: retryAfter(response.headers.get('Retry-After')),
        };
      } catch {
        return { kind: 'unknown' };
      }
    })();
    try {
      return await Promise.race([request, deadline]);
    } finally {
      finished = true;
      clearTimeout(timer);
    }
  }

  return Object.freeze({
    captureOwner: () => capture(),
    captureRecovery: (scope: DeletionScope) => capture(scope),
    isCurrent,
    dispose() {
      disposed = true;
    },
    async request(
      context: DeletionTransportContext,
      body: Readonly<Record<string, unknown>> = {},
    ): Promise<DeletionRequestReply> {
      if (!isCurrent(context)) return { kind: 'stale' };
      const bearer = sessionBearer(context);
      if (!bearer) return { kind: 'session_required' };
      const reply = await post(context, 'delete-request', bearer, body);
      if (reply.kind !== 'response') return reply;
      if (reply.status !== 200) return failure(reply, false);
      const request = parseDeletionRequest(reply.payload);
      return request
        ? { kind: 'requested', request }
        : { kind: 'invalid_response' };
    },
    async confirm(
      context: DeletionTransportContext,
      value: DeletionSecretRecord,
    ): Promise<DeletionConfirmReply> {
      if (!isCurrent(context)) return { kind: 'stale' };
      const record = secretsFor(context, value);
      if (!record) return { kind: 'invalid_binding' };
      const bearer = sessionBearer(context);
      if (!bearer) return { kind: 'session_required' };
      const reply = await post(context, 'delete-confirm', bearer, {
        challenge: record.challenge,
        operationId: record.operationId,
      });
      if (reply.kind !== 'response') return reply;
      if (reply.status === 202) {
        return deletionExact(reply.payload, ['operationId', 'state']) &&
          reply.payload.operationId === record.operationId &&
          reply.payload.state === 'in_progress'
          ? { kind: 'in_progress', retryAfterMs: reply.retryAfterMs ?? 3000 }
          : { kind: 'invalid_response' };
      }
      if (reply.status !== 200) return failure(reply, false);
      if (
        !deletionExact(reply.payload, [
          'deleted',
          'operationId',
          'completionReceipt',
          'appleAuthorizationRevocation',
        ]) ||
        reply.payload.deleted !== true ||
        reply.payload.operationId !== record.operationId
      )
        return { kind: 'invalid_response' };
      const status = parseDeletionStatus({
        state: 'completed',
        completionReceipt: reply.payload.completionReceipt,
        appleAuthorizationRevocation:
          reply.payload.appleAuthorizationRevocation,
      });
      return status?.completionReceipt && status.appleAuthorizationRevocation
        ? {
            kind: 'completed',
            receipt: completionEvidence(record, {
              completedAt: status.completionReceipt.completedAt,
              appleAuthorizationRevocation: status.appleAuthorizationRevocation,
            }),
          }
        : { kind: 'invalid_response' };
    },
    async status(
      context: DeletionTransportContext,
      value: DeletionSecretRecord,
    ): Promise<DeletionStatusReply> {
      if (!isCurrent(context)) return { kind: 'stale' };
      const record = secretsFor(context, value);
      if (!record) return { kind: 'invalid_binding' };
      const reply = await post(
        context,
        'delete-status',
        record.statusCapability,
        { operationId: record.operationId },
      );
      if (reply.kind !== 'response') return reply;
      if (reply.status !== 200) return failure(reply, true);
      const status = parseDeletionStatus(reply.payload);
      if (status?.completionReceipt && status.appleAuthorizationRevocation) {
        completedStatuses.set(
          status,
          completionEvidence(record, {
            completedAt: status.completionReceipt.completedAt,
            appleAuthorizationRevocation: status.appleAuthorizationRevocation,
          }),
        );
      }
      return status ? { kind: 'status', status } : { kind: 'invalid_response' };
    },
  });
}
