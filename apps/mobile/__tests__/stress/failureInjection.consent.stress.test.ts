/**
 * STRESS — failure injection — `src/account/consentApi.ts` + its consumer
 * `src/state/consentStore.ts`.
 *
 * Dependencies injected: fetch (every catalog fault), the runtime config the
 * `X-Client-Version` header reads (throws), the clock (15s deadline, fake
 * clock advanced 60s) and the ApiSession (cleared / switched mid-flight).
 *
 * Invariants asserted per iteration:
 *   - the request settles by the deadline with a `ConsentApiError` (no raw
 *     error, no silent failure) or a fully validated `ConsentStatus`;
 *   - a 2xx body resolves ONLY when every scope row is well-formed (no fake
 *     status);
 *   - the store never stays `loading`/`busy`, never keeps an optimistic
 *     grant, defaults to NOT consented on failure, surfaces an error string,
 *     and never applies a response that belongs to a signed-out / switched
 *     account.
 *
 * Replay: `STRESS_SEED=<seed> npx jest __tests__/stress/failureInjection.consent`
 */
let mockRuntimeConfigThrows = false;
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => {
    if (mockRuntimeConfigThrows) {
      throw new Error('runtime config unavailable');
    }
    return { appVersion: '1.0.0-stress' };
  },
}));

import {
  ConsentApiError,
  CONSENT_REQUEST_TIMEOUT_MS,
  fetchConsentStatus,
  grantModelTrainingConsent,
  withdrawModelTrainingConsent,
  type ConsentStatus,
} from '../../src/account/consentApi';
import {
  clearApiSession,
  establishApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import { useConsentStore } from '../../src/state/consentStore';
import {
  chance,
  describeError,
  pick,
  probe,
  randomInt,
  recordIteration,
  scenarioCases,
  seededRandom,
  type Rng,
} from '../../testing/stress/harness';
import {
  drawFault,
  faultFetch,
  REQUEST_DEADLINE_MS,
  transportFailureExpected,
  type Fault,
  type MalformedShape,
} from '../../testing/stress/faultFetch';

const SUITE = 'consent';
const API_BASE = 'https://api.example.test/functions/v1/api';
const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '22222222-2222-4222-8222-222222222222';

const sessionA: ApiSession = {
  apiBaseUrl: API_BASE,
  bearerToken: 'token-a',
  canonicalAppUserId: OWNER_A,
  provider: 'apple',
};
const sessionB: ApiSession = {
  apiBaseUrl: API_BASE,
  bearerToken: 'token-b',
  canonicalAppUserId: OWNER_B,
  provider: 'google',
};

const UNAVAILABLE_COPY = 'Consent settings are temporarily unavailable.';
const INVALID_COPY = 'The consent server returned an invalid response.';

function row(
  scope: string,
  active: boolean,
  extra: Record<string, unknown> = {},
) {
  return {
    scope,
    active,
    consentVersion: active ? 'model-training-v1' : null,
    lastAction: active ? 'granted' : null,
    lastActionAt: active ? '2026-09-01T00:00:00.000Z' : null,
    ...extra,
  };
}

function validStatus(active: boolean): unknown {
  return {
    subjectPseudonym: 'pseud-1',
    scopes: [row('video_analysis', true), row('model_training', active)],
  };
}

function malformedStatus(rng: Rng): MalformedShape {
  return pick(rng, [
    { shape: 'null', payload: null },
    { shape: 'array', payload: [] },
    { shape: 'empty_object', payload: {} },
    { shape: 'scopes_object', payload: { subjectPseudonym: null, scopes: {} } },
    { shape: 'scopes_null', payload: { subjectPseudonym: null, scopes: null } },
    {
      shape: 'pseudonym_number',
      payload: { subjectPseudonym: 42, scopes: [] },
    },
    { shape: 'pseudonym_missing', payload: { scopes: [] } },
    {
      shape: 'unknown_scope',
      payload: { subjectPseudonym: null, scopes: [row('bogus', true)] },
    },
    {
      shape: 'active_string',
      payload: {
        subjectPseudonym: null,
        scopes: [row('model_training', true, { active: 'true' })],
      },
    },
    {
      shape: 'row_not_object',
      payload: { subjectPseudonym: null, scopes: ['model_training'] },
    },
    {
      shape: 'lastAction_missing',
      payload: {
        subjectPseudonym: null,
        scopes: [
          {
            scope: 'model_training',
            active: true,
            consentVersion: null,
            lastActionAt: null,
          },
        ],
      },
    },
    {
      shape: 'lastAction_revoked',
      payload: {
        subjectPseudonym: null,
        scopes: [row('model_training', true, { lastAction: 'revoked' })],
      },
    },
    {
      shape: 'lastActionAt_number',
      payload: {
        subjectPseudonym: null,
        scopes: [row('model_training', true, { lastActionAt: 1234 })],
      },
    },
    {
      shape: 'consentVersion_number',
      payload: {
        subjectPseudonym: null,
        scopes: [row('model_training', true, { consentVersion: 1 })],
      },
    },
    // Well-formed but incomplete statuses (the store must default to false).
    {
      shape: 'no_scopes_valid',
      payload: { subjectPseudonym: null, scopes: [] },
    },
    {
      shape: 'video_only_valid',
      payload: { subjectPseudonym: 'p', scopes: [row('video_analysis', true)] },
    },
    {
      shape: 'duplicate_training_rows_valid',
      payload: {
        subjectPseudonym: 'p',
        scopes: [row('model_training', true), row('model_training', false)],
      },
    },
    {
      shape: 'active_true_no_version_valid',
      payload: {
        subjectPseudonym: null,
        scopes: [
          row('model_training', true, {
            consentVersion: null,
            lastAction: null,
            lastActionAt: null,
          }),
        ],
      },
    },
  ]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Reference validator for the wire contract. */
function statusAccepted(payload: unknown): payload is ConsentStatus {
  if (!isRecord(payload) || !Array.isArray(payload['scopes'])) return false;
  const pseud = payload['subjectPseudonym'];
  if (!(pseud === null || typeof pseud === 'string')) return false;
  return payload['scopes'].every(entry => {
    if (!isRecord(entry)) return false;
    if (
      !['video_analysis', 'model_training', 'evaluation_telemetry'].includes(
        String(entry['scope']),
      )
    ) {
      return false;
    }
    if (typeof entry['active'] !== 'boolean') return false;
    const la = entry['lastAction'];
    const laa = entry['lastActionAt'];
    const cv = entry['consentVersion'];
    return (
      (la === null || la === 'granted' || la === 'withdrawn') &&
      (laa === null || typeof laa === 'string') &&
      (cv === null || typeof cv === 'string')
    );
  });
}

function expectedTrainingActive(payload: unknown): boolean {
  return (
    (payload as ConsentStatus).scopes.find(s => s.scope === 'model_training')
      ?.active ?? false
  );
}

/** A 2xx that the module is expected to accept (reference contract). */
function successExpected(fault: Fault): boolean {
  return (
    (fault.kind === 'ok' ||
      fault.kind === 'ok_malformed' ||
      (fault.kind === 'slow_ok' &&
        (fault.delayMs ?? 0) < REQUEST_DEADLINE_MS) ||
      fault.kind === 'slow_body') &&
    statusAccepted(fault.payload)
  );
}

type Op = 'status' | 'grant' | 'withdraw';
const OPS: readonly Op[] = ['status', 'grant', 'withdraw'];

function callOp(op: Op, session: ApiSession, fetchFn: FaultFetchFn) {
  switch (op) {
    case 'status':
      return fetchConsentStatus(session, fetchFn);
    case 'grant':
      return grantModelTrainingConsent(session, 'ios 26', fetchFn);
    case 'withdraw':
      return withdrawModelTrainingConsent(session, 'ios 26', fetchFn);
  }
}
type FaultFetchFn = ReturnType<typeof faultFetch>['fetch'];

beforeEach(() => {
  jest.useFakeTimers();
  mockRuntimeConfigThrows = false;
  clearApiSession();
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
  clearApiSession();
});

// ─── module level ──────────────────────────────────────────────────────────

describe('consentApi — injected fetch faults', () => {
  const scenario = 'consent.api';
  const cases = scenarioCases(scenario);
  it.each(cases)(
    'seed %d (iteration %d) settles with a typed error or a validated status',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const op = pick(rng, OPS);
      const fault = drawFault(
        rng,
        iteration,
        validStatus(chance(rng, 0.5)),
        malformedStatus,
      );
      const configThrows = fault.kind === 'ok' && chance(rng, 0.5);
      const faultId = configThrows
        ? `${fault.id}+runtimeConfig_throws`
        : fault.id;
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: faultId,
          inputs: { op, fault, configThrows },
        },
        async () => {
          mockRuntimeConfigThrows = configThrows;
          const transport = faultFetch([fault]);
          const settlement = probe(callOp(op, sessionA, transport.fetch));
          await jest.advanceTimersByTimeAsync(60_000);
          const observed: Record<string, unknown> = {
            settled: settlement.settled,
            resolved: settlement.resolved,
            settledAfterMs: settlement.settledAfterMs,
            calls: transport.calls.length,
            aborted: transport.calls[0]?.aborted ?? null,
            timersLeft: jest.getTimerCount(),
            error:
              settlement.settled && !settlement.resolved
                ? describeError(settlement.error)
                : null,
          };
          expect(jest.getTimerCount()).toBe(0);
          if (configThrows) {
            // The header read throws inside the guarded request: surfaced as
            // the generic unavailable error, the deadline timer released, and
            // the stub never called.
            expect(settlement.settled).toBe(true);
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(ConsentApiError);
            expect((settlement.error as Error).message).toBe(UNAVAILABLE_COPY);
            expect(transport.calls).toHaveLength(0);
            return { observed };
          }
          if (!fault.realistic) {
            if (settlement.resolved) {
              expect(statusAccepted(fault.payload)).toBe(true);
            }
            const bypasses =
              !settlement.settled ||
              (settlement.settledAfterMs ?? 0) > REQUEST_DEADLINE_MS;
            return {
              observed: { ...observed, bypassesDeadline: bypasses },
              classification:
                bypasses ||
                (settlement.settled &&
                  !settlement.resolved &&
                  !(settlement.error instanceof ConsentApiError))
                  ? 'KNOWN_LIMIT'
                  : 'HELD',
            };
          }
          expect(settlement.settled).toBe(true);
          expect(transport.calls).toHaveLength(1);
          const call = transport.calls[0]!;
          expect(call.hadSignal).toBe(true);
          const headers = call.init?.headers as Record<string, string>;
          expect(headers.Authorization).toBe('Bearer token-a');
          expect(headers['X-Client-Version']).toBe('1.0.0-stress');
          expect(settlement.settledAfterMs!).toBeLessThanOrEqual(
            CONSENT_REQUEST_TIMEOUT_MS,
          );
          if (transportFailureExpected(fault)) {
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(ConsentApiError);
            expect((settlement.error as Error).message).toBe(UNAVAILABLE_COPY);
            const onDeadline =
              fault.kind === 'hang_until_abort' ||
              (fault.delayMs ?? 0) >= REQUEST_DEADLINE_MS;
            expect(call.aborted).toBe(onDeadline);
            if (onDeadline) {
              expect(settlement.settledAfterMs).toBe(
                CONSENT_REQUEST_TIMEOUT_MS,
              );
            }
            return { observed };
          }
          expect(call.aborted).toBe(false);
          if (fault.kind === 'http_error') {
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(ConsentApiError);
            expect((settlement.error as Error).message).toBe(UNAVAILABLE_COPY);
            return {
              observed: {
                ...observed,
                // 401 is reported with the same generic copy as a 503.
                status401MaskedAsUnavailable: fault.status === 401,
              },
            };
          }
          if (fault.kind === 'ok_json_throws') {
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(ConsentApiError);
            expect((settlement.error as Error).message).toBe(INVALID_COPY);
            return { observed };
          }
          // ok / slow_ok (< deadline) / ok_malformed
          if (statusAccepted(fault.payload)) {
            expect(settlement.resolved).toBe(true);
            expect(settlement.value).toEqual(fault.payload);
          } else {
            expect(settlement.resolved).toBe(false);
            expect(settlement.error).toBeInstanceOf(ConsentApiError);
            expect((settlement.error as Error).message).toBe(INVALID_COPY);
          }
          return { observed };
        },
      );
    },
  );
});

// ─── store level ───────────────────────────────────────────────────────────

type PreState = {
  availability: 'loading' | 'ready' | 'unavailable';
  modelTrainingActive: boolean;
  lastActionAt: string | null;
};

function drawPreState(rng: Rng): PreState {
  const active = chance(rng, 0.5);
  return {
    availability: pick(rng, ['loading', 'ready', 'unavailable'] as const),
    modelTrainingActive: active,
    lastActionAt: active ? '2026-08-01T00:00:00.000Z' : null,
  };
}

describe('consentStore.hydrate — injected faults', () => {
  const scenario = 'consentStore.hydrate';
  const cases = scenarioCases(scenario);
  it.each(cases)(
    'seed %d (iteration %d) never strands loading, never assumes consent',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const serverActive = chance(rng, 0.5);
      const fault = drawFault(
        rng,
        iteration,
        validStatus(serverActive),
        malformedStatus,
      );
      const pre = drawPreState(rng);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: fault.id,
          inputs: { fault, pre, serverActive },
        },
        async () => {
          establishApiSession(sessionA);
          useConsentStore.setState({ ...pre, busy: false, error: null });
          const transport = faultFetch([fault]);
          const settlement = probe(
            useConsentStore.getState().hydrate(transport.fetch),
          );
          await jest.advanceTimersByTimeAsync(0);
          const midFlight = useConsentStore.getState();
          const midFlightSnapshot = {
            availability: midFlight.availability,
            modelTrainingActive: midFlight.modelTrainingActive,
          };
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useConsentStore.getState();
          const observed = {
            settled: settlement.settled,
            midFlight: midFlightSnapshot,
            availability: state.availability,
            modelTrainingActive: state.modelTrainingActive,
            lastActionAt: state.lastActionAt,
            busy: state.busy,
            error: state.error,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);
          expect(state.busy).toBe(false);
          if (!fault.realistic && !settlement.settled) {
            // Contract-violating fetch that never settles: the screen shows
            // its loading state indefinitely (no retry control while loading).
            expect(state.availability).toBe('loading');
            return { observed, classification: 'KNOWN_LIMIT' };
          }
          expect(settlement.settled).toBe(true);
          expect(settlement.resolved).toBe(true); // hydrate never rejects
          if (successExpected(fault)) {
            expect(state.availability).toBe('ready');
            expect(state.modelTrainingActive).toBe(
              expectedTrainingActive(fault.payload),
            );
            expect(state.error).toBeNull();
            return {
              observed,
              classification:
                fault.kind === 'slow_body' &&
                (fault.delayMs ?? 0) > REQUEST_DEADLINE_MS
                  ? 'KNOWN_LIMIT'
                  : 'HELD',
            };
          }
          // Failure path: visible, non-optimistic, retryable from the screen
          // (availability 'unavailable' renders the Try again control).
          expect(state.availability).toBe('unavailable');
          expect(state.modelTrainingActive).toBe(false);
          expect(typeof state.error).toBe('string');
          expect(state.error!.length).toBeGreaterThan(0);
          return {
            observed: { ...observed, faultRealistic: fault.realistic },
            classification: 'HELD',
          };
        },
      );
    },
  );
});

describe('consentStore.setModelTrainingConsent — injected faults', () => {
  const scenario = 'consentStore.set';
  const cases = scenarioCases(scenario);
  it.each(cases)(
    'seed %d (iteration %d) never keeps an optimistic grant, never strands busy',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const preActive = chance(rng, 0.5);
      const granted = chance(rng, 0.7) ? !preActive : preActive;
      const serverActive = chance(rng, 0.8) ? granted : !granted;
      const fault = drawFault(
        rng,
        iteration,
        validStatus(serverActive),
        malformedStatus,
      );
      const doubleTap = chance(rng, 0.3);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: fault.id,
          inputs: { fault, preActive, granted, serverActive, doubleTap },
        },
        async () => {
          establishApiSession(sessionA);
          useConsentStore.setState({
            availability: 'ready',
            modelTrainingActive: preActive,
            lastActionAt: preActive ? '2026-08-01T00:00:00.000Z' : null,
            busy: false,
            error: null,
          });
          const transport = faultFetch([fault]);
          const store = useConsentStore.getState();
          const first = probe(
            store.setModelTrainingConsent(granted, transport.fetch),
          );
          let second: ReturnType<typeof probe<void>> | null = null;
          if (doubleTap) {
            second = probe(
              store.setModelTrainingConsent(!granted, transport.fetch),
            );
          }
          await jest.advanceTimersByTimeAsync(0);
          const mid = useConsentStore.getState();
          // While in flight the toggle must NOT already show the new value.
          const optimisticMidFlight =
            !first.settled && mid.modelTrainingActive !== preActive;
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useConsentStore.getState();
          const observed = {
            settled: first.settled,
            secondSettledImmediately: second ? second.settled : null,
            optimisticMidFlight,
            availability: state.availability,
            modelTrainingActive: state.modelTrainingActive,
            busy: state.busy,
            error: state.error,
            calls: transport.calls.length,
            timersLeft: jest.getTimerCount(),
          };
          expect(jest.getTimerCount()).toBe(0);
          expect(optimisticMidFlight).toBe(false);
          if (doubleTap) {
            // busy guard: the second tap is a no-op, one request on the wire.
            expect(second!.settled).toBe(true);
            expect(transport.calls.length).toBeLessThanOrEqual(1);
          }
          if (!fault.realistic && !first.settled) {
            expect(state.busy).toBe(true);
            expect(state.modelTrainingActive).toBe(preActive);
            return { observed, classification: 'KNOWN_LIMIT' };
          }
          expect(first.settled).toBe(true);
          expect(state.busy).toBe(false);
          expect(state.availability).toBe('ready');
          if (successExpected(fault)) {
            expect(state.modelTrainingActive).toBe(
              expectedTrainingActive(fault.payload as ConsentStatus),
            );
            expect(state.error).toBeNull();
            return {
              observed,
              classification:
                fault.kind === 'slow_body' &&
                (fault.delayMs ?? 0) > REQUEST_DEADLINE_MS
                  ? 'KNOWN_LIMIT'
                  : 'HELD',
            };
          }
          expect(state.modelTrainingActive).toBe(preActive);
          expect(typeof state.error).toBe('string');
          expect(state.error!.length).toBeGreaterThan(0);
          return {
            observed: { ...observed, faultRealistic: fault.realistic },
            classification: 'HELD',
          };
        },
      );
    },
  );
});

describe('consentStore — session cleared / switched mid-flight', () => {
  const scenario = 'consentStore.sessionRace';
  const cases = scenarioCases(scenario);
  const variants = [
    'hydrate+clear',
    'hydrate+switch',
    'set+clear',
    'set+switch',
    'set+signed_out_before',
  ] as const;
  it.each(cases)(
    'seed %d (iteration %d) never applies a stale account response',
    async (seed, iteration) => {
      const rng = seededRandom(seed);
      const variant = variants[iteration % variants.length]!;
      const serverActive = chance(rng, 0.5);
      const delayMs = randomInt(rng, 1, 14_000);
      const succeeds = chance(rng, 0.6);
      const fault: Fault = succeeds
        ? {
            kind: 'slow_ok',
            id: `slow_ok:${delayMs}`,
            realistic: true,
            delayMs,
            payload: validStatus(serverActive),
          }
        : {
            kind: 'slow_reject',
            id: `slow_reject:${delayMs}`,
            realistic: true,
            delayMs,
          };
      const preActive = chance(rng, 0.5);
      const raceAt = randomInt(rng, 0, delayMs - 1);
      await recordIteration(
        {
          suite: SUITE,
          scenario,
          seed,
          iteration,
          fault: `${variant}:${fault.id}`,
          inputs: { variant, fault, preActive, raceAt, serverActive },
        },
        async () => {
          if (variant !== 'set+signed_out_before')
            establishApiSession(sessionA);
          useConsentStore.setState({
            availability: 'ready',
            modelTrainingActive: preActive,
            lastActionAt: null,
            busy: false,
            error: null,
          });
          const transport = faultFetch([fault]);
          const store = useConsentStore.getState();
          const settlement = probe(
            variant.startsWith('hydrate')
              ? store.hydrate(transport.fetch)
              : store.setModelTrainingConsent(!preActive, transport.fetch),
          );
          await jest.advanceTimersByTimeAsync(raceAt);
          if (variant.endsWith('+clear')) clearApiSession();
          if (variant.endsWith('+switch')) establishApiSession(sessionB);
          const beforeLanding = useConsentStore.getState();
          await jest.advanceTimersByTimeAsync(60_000);
          const state = useConsentStore.getState();
          const observed = {
            settled: settlement.settled,
            calls: transport.calls.length,
            availability: state.availability,
            modelTrainingActive: state.modelTrainingActive,
            busy: state.busy,
            error: state.error,
          };
          expect(settlement.settled).toBe(true);
          expect(state.busy).toBe(false);
          expect(jest.getTimerCount()).toBe(0);
          if (variant === 'set+signed_out_before') {
            expect(transport.calls).toHaveLength(0);
            expect(state.availability).toBe('signed_out');
            expect(state.modelTrainingActive).toBe(false);
            expect(state.error).toBe(
              'Sign in to change this setting. Nothing was changed.',
            );
            return { observed };
          }
          if (variant.endsWith('+clear')) {
            expect(state.availability).toBe('signed_out');
            expect(state.modelTrainingActive).toBe(false);
            expect(state.error).toBeNull();
            return { observed };
          }
          // switched: the stale response for A must not describe B.
          expect(state.modelTrainingActive).toBe(
            beforeLanding.modelTrainingActive,
          );
          expect(state.lastActionAt).toBe(beforeLanding.lastActionAt);
          expect(state.error).toBeNull();
          return { observed };
        },
      );
    },
  );
});
