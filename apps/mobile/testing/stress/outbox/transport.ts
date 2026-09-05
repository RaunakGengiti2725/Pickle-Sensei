/**
 * Scripted `SyncTransport` for the outbox stress harness.
 *
 * Replays a `DrainPolicy`: every endpoint call is logged with the ids it
 * carried and the exact response/exception the stub produced, so invariants
 * can be checked against what the server actually acknowledged rather than
 * against what the policy intended. The 2xx path mirrors the edge function's
 * per-item validation (`POST /v1/shots:sync` rejects non-string ids with
 * `shot.invalid_payload` under the `unknown` id) before applying the
 * scripted verdicts.
 *
 * Test-only harness; never imported by production code.
 */
import { ApiError } from '../../../src/data/api';
import type { SyncTransport } from '../../../src/data/sync';
import type {
  BatchBehavior,
  DrainPolicy,
  EndpointBehavior,
  Thrown,
  Verdict,
} from './actions';

export const FOREIGN_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export type ShotsResponse = {
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string; message: string }>;
};
export type TrialsResponse = {
  acceptedTrialIds: string[];
  rejected: Array<{ trialId: string; code: string; message: string }>;
};

export interface TransportCall {
  drain: number;
  endpoint:
    | 'createSession'
    | 'finalizeSession'
    | 'syncShots'
    | 'uploadEvaluationTrials';
  /** Ids the client sent (session id, shot ids, trial ids). */
  ids: unknown[];
  /** Ids the stub acknowledged as accepted (subset of `ids`, as strings). */
  accepted: string[];
  /** Ids the stub rejected, with the code. */
  rejected: Array<{ id: string; code: string }>;
  outcome: 'resolved' | 'threw' | 'malformed';
  detail: string;
}

export function materializeThrown(behavior: Thrown): unknown {
  switch (behavior.throw) {
    case 'api':
      return new ApiError(behavior.status, behavior.code, behavior.message);
    case 'error':
      return new Error(behavior.message);
    case 'type_error':
      return new TypeError(behavior.message);
    case 'string':
      return behavior.value;
  }
}

function describeThrown(behavior: Thrown): string {
  switch (behavior.throw) {
    case 'api':
      return `ApiError ${behavior.status} ${behavior.code}`;
    case 'error':
      return `Error ${behavior.message}`;
    case 'type_error':
      return `TypeError ${behavior.message}`;
    case 'string':
      return `string ${behavior.value}`;
  }
}

const idOf = (payload: unknown, key: 'id' | 'trialId'): unknown =>
  typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)[key]
    : undefined;

/** Server-side verdicts for a batch (before any malformed reshaping). */
export function serverVerdicts(
  behavior: { kind: 'ok' } | { kind: 'verdicts'; verdicts: Verdict[] },
  ids: unknown[],
): { accepted: string[]; rejected: Array<{ id: string; code: string }> } {
  const accepted: string[] = [];
  const rejected: Array<{ id: string; code: string }> = [];
  ids.forEach((id, index) => {
    if (typeof id !== 'string') {
      rejected.push({ id: 'unknown', code: 'shot.invalid_payload' });
      return;
    }
    const verdict: Verdict =
      behavior.kind === 'ok'
        ? 'accept'
        : behavior.verdicts[index % behavior.verdicts.length]!;
    if (verdict === 'accept') accepted.push(id);
    else if (verdict !== 'omit') rejected.push({ id, code: verdict.reject });
  });
  return { accepted, rejected };
}

function malformedShots(shape: string, ids: unknown[]): unknown {
  const strings = ids.filter((id): id is string => typeof id === 'string');
  switch (shape) {
    case 'empty_object':
      return {};
    case 'null':
      return null;
    case 'string_ids':
      return { acceptedIds: 'abc', rejected: [] };
    case 'rejected_null':
      return { acceptedIds: strings, rejected: null };
    case 'foreign_ids':
      return { acceptedIds: [FOREIGN_ID], rejected: [] };
    case 'dup_ids':
      return { acceptedIds: [...strings, ...strings], rejected: [] };
    case 'accept_and_reject':
      return {
        acceptedIds: strings,
        rejected: strings.map(id => ({
          id,
          code: 'shot.invalid_payload',
          message: 'conflicting',
        })),
      };
    default:
      throw new Error(`unknown malformed shape ${shape}`);
  }
}

function malformedTrials(shape: string, ids: unknown[]): unknown {
  const strings = ids.filter((id): id is string => typeof id === 'string');
  switch (shape) {
    case 'empty_object':
      return {};
    case 'null':
      return null;
    case 'string_ids':
      return { acceptedTrialIds: 'abc', rejected: [] };
    case 'rejected_null':
      return { acceptedTrialIds: strings, rejected: null };
    case 'foreign_ids':
      return { acceptedTrialIds: [FOREIGN_ID], rejected: [] };
    case 'dup_ids':
      return { acceptedTrialIds: [...strings, ...strings], rejected: [] };
    case 'accept_and_reject':
      return {
        acceptedTrialIds: strings,
        rejected: strings.map(trialId => ({
          trialId,
          code: 'evaluation.trial_invalid',
          message: 'conflicting',
        })),
      };
    default:
      throw new Error(`unknown malformed shape ${shape}`);
  }
}

export interface ScriptedTransport {
  transport: SyncTransport;
  calls: TransportCall[];
}

export function createScriptedTransport(
  drain: number,
  policy: DrainPolicy,
  calls: TransportCall[],
): SyncTransport {
  let sessionCursor = 0;
  const nextSession = (): EndpointBehavior => {
    const behavior =
      policy.session[Math.min(sessionCursor, policy.session.length - 1)]!;
    sessionCursor += 1;
    return behavior;
  };

  const sessionCall = async (
    endpoint: 'createSession' | 'finalizeSession',
    id: unknown,
  ): Promise<void> => {
    const behavior = nextSession();
    if ('throw' in behavior) {
      calls.push({
        drain,
        endpoint,
        ids: [id],
        accepted: [],
        rejected: [],
        outcome: 'threw',
        detail: describeThrown(behavior),
      });
      throw materializeThrown(behavior);
    }
    calls.push({
      drain,
      endpoint,
      ids: [id],
      accepted: typeof id === 'string' ? [id] : [],
      rejected: [],
      outcome: 'resolved',
      detail: 'ok',
    });
  };

  const batchCall = <R>(
    endpoint: 'syncShots' | 'uploadEvaluationTrials',
    behavior: BatchBehavior,
    ids: unknown[],
    shape: (
      accepted: string[],
      rejected: Array<{ id: string; code: string }>,
    ) => R,
    malformed: (shape: string, ids: unknown[]) => unknown,
  ): R => {
    if ('throw' in behavior) {
      calls.push({
        drain,
        endpoint,
        ids,
        accepted: [],
        rejected: [],
        outcome: 'threw',
        detail: describeThrown(behavior),
      });
      throw materializeThrown(behavior);
    }
    if (behavior.kind === 'malformed') {
      const body = malformed(behavior.shape, ids);
      const acceptedField =
        body !== null && typeof body === 'object'
          ? (body as Record<string, unknown>)[
              endpoint === 'syncShots' ? 'acceptedIds' : 'acceptedTrialIds'
            ]
          : undefined;
      const accepted = Array.isArray(acceptedField)
        ? acceptedField.filter((id): id is string => typeof id === 'string')
        : [];
      calls.push({
        drain,
        endpoint,
        ids,
        accepted,
        rejected: [],
        outcome: 'malformed',
        detail: behavior.shape,
      });
      return body as R;
    }
    const { accepted, rejected } = serverVerdicts(behavior, ids);
    calls.push({
      drain,
      endpoint,
      ids,
      accepted,
      rejected,
      outcome: 'resolved',
      detail: behavior.kind,
    });
    return shape(accepted, rejected);
  };

  const transport: SyncTransport = {
    createSession: session => sessionCall('createSession', idOf(session, 'id')),
    finalizeSession: id => sessionCall('finalizeSession', id),
    async syncShots(shots) {
      return batchCall<ShotsResponse>(
        'syncShots',
        policy.shots,
        shots.map(shot => idOf(shot, 'id')),
        (accepted, rejected) => ({
          acceptedIds: accepted,
          rejected: rejected.map(({ id, code }) => ({
            id,
            code,
            message: `msg:${code}`,
          })),
        }),
        malformedShots,
      );
    },
  };
  if (policy.trials !== 'absent') {
    const trials = policy.trials;
    transport.uploadEvaluationTrials = async input =>
      batchCall<TrialsResponse>(
        'uploadEvaluationTrials',
        trials,
        input.map(trial => idOf(trial, 'trialId')),
        (accepted, rejected) => ({
          acceptedTrialIds: accepted,
          rejected: rejected.map(({ id, code }) => ({
            trialId: id,
            code,
            message: `msg:${code}`,
          })),
        }),
        malformedTrials,
      );
  }
  return transport;
}
