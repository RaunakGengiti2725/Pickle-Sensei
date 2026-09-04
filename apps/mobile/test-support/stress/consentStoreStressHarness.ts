/**
 * Seeded randomized long-run harness for `src/state/consentStore.ts`.
 *
 * Drives the REAL store (`useConsentStore.hydrate` /
 * `setModelTrainingConsent`) and the REAL `consentApi.ts` client over the
 * real in-memory `apiSession.ts` store. Only `fetch` (injected through the
 * store's `fetchFn` parameter) and the clock (jest fake timers, for the
 * 15 s consent request timeout) are controlled.
 *
 * Every sequence is generated from a numeric seed by a hand-rolled PRNG
 * (mulberry32) into an explicit action list; EXECUTION uses no randomness
 * at all, so a sequence replays byte-for-byte from its action list — that
 * is what makes delta-debugging minimisation and the determinism check
 * (same seed twice → identical trace) possible.
 *
 * Invariants are checked after EVERY step against a reference model that
 * encodes the store's documented contract (doc comments in consentStore.ts,
 * AGENTS.md "consent" rules, `__tests__/wf/fix-11-consentStore-stale-session`):
 *
 *   shape                    availability ∈ {loading,ready,signed_out,unavailable};
 *                            booleans are booleans; error/lastActionAt string|null;
 *                            error is never the empty string.
 *   default_off              modelTrainingActive ⇒ the LAST applied status
 *                            response reported active=true and no signed-out /
 *                            unavailable reset happened since ("false until a
 *                            status response proves otherwise"); never true
 *                            while signed_out or unavailable. A re-hydrate keeps
 *                            the proven value while `loading` — by design.
 *   no_fetch_signed_out      hydrate/toggle with no ApiSession never issue a
 *                            request and land in the signed-out state.
 *   busy_guard               a toggle while busy issues no request.
 *   request_contract         every request goes to the CURRENT session's
 *                            apiBaseUrl with its bearer, JSON headers, the
 *                            right path/method, and (grant) the consent version.
 *   model_state              after each step, {availability, modelTrainingActive,
 *                            lastActionAt, busy, error} equal the reference model.
 *   stale_session            a response landing after sign-out yields the
 *                            signed-out state; after an account switch it
 *                            only clears `busy`.
 *   no_optimistic_state      a toggle never changes the ledger view before its
 *                            response lands, and a failed toggle never changes
 *                            modelTrainingActive (busy cleared, error surfaced).
 *   promise_settles          hydrate()/setModelTrainingConsent() never reject.
 *   quiescence               once every request has landed, busy === false.
 *   ordering (report-only)   stale_response_overwrites_newer_response /
 *                            stale_read_overwrites_newer_mutation — a response
 *                            to an OLDER request landing after a NEWER one and
 *                            changing the ledger view. Not part of the store's
 *                            stated contract, so it is recorded per seed but
 *                            does not fail `model_state`; the campaign reports
 *                            how often the generator reaches it.
 *
 * Replay one seed:
 *   STRESS_ONLY=<seed> npx jest __tests__/stress/consentStoreRandomized.stress.test.ts
 */
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  MODEL_TRAINING_CONSENT_VERSION,
  type ConsentFetch,
} from '../../src/account/consentApi';
import {
  useConsentStore,
  type ConsentAvailability,
} from '../../src/state/consentStore';

// ─── PRNG ────────────────────────────────────────────────────────────────────

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  /** mulberry32 — uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  weighted<T extends string>(table: Record<T, number>): T {
    const entries = Object.entries(table) as Array<[T, number]>;
    const total = entries.reduce((n, [, w]) => n + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    return entries[entries.length - 1]![0];
  }
}

// ─── Sessions & server bodies ────────────────────────────────────────────────

export const ACCOUNTS = ['A', 'B', 'C'] as const;
export type AccountId = (typeof ACCOUNTS)[number];

export function sessionFor(account: AccountId): ApiSession {
  const n = ACCOUNTS.indexOf(account) + 1;
  return {
    apiBaseUrl: `https://api-${account.toLowerCase()}.test`,
    bearerToken: `token-${account}-${n}`,
    canonicalAppUserId: `${n}0000000-0000-0000-0000-00000000000${n}`,
    provider: n % 2 === 1 ? 'apple' : 'google',
  };
}

/**
 * Server reply kinds. `ok_*` parse into a ConsentStatus; everything else is
 * an error path of consentApi.ts (HTTP error, invalid JSON, invalid schema,
 * transport rejection, 15 s timeout).
 */
export const BODY_KINDS = [
  'ok_active_true',
  'ok_active_false',
  'ok_active_true_no_timestamp',
  'ok_no_model_training_scope',
  'ok_empty_scopes',
  'ok_duplicate_model_training_scope',
  'ok_null_pseudonym',
  'http_error_valid_body',
  'http_error_null_json',
  'invalid_body_nonsense',
  'invalid_body_active_string',
  'invalid_body_unknown_scope',
  'invalid_body_scopes_not_array',
  'json_rejects',
  'network_reject',
] as const;
export type BodyKind = (typeof BODY_KINDS)[number];

const TS = '2026-08-29T00:00:00.000Z';
const TS2 = '2026-09-01T12:34:56.000Z';

function scopeRow(
  scope: string,
  active: unknown,
  lastActionAt: string | null = TS,
  consentVersion: string | null = MODEL_TRAINING_CONSENT_VERSION,
) {
  return {
    scope,
    active,
    consentVersion,
    lastAction: active === true ? 'granted' : 'withdrawn',
    lastActionAt,
  };
}

interface MockReply {
  ok: boolean;
  json: () => Promise<unknown>;
}

function jsonReply(body: unknown, ok = true): MockReply {
  return { ok, json: () => Promise.resolve(body) };
}

/** What the reference model expects the store to derive from a reply. */
export interface ExpectedOutcome {
  success: boolean;
  active: boolean;
  lastActionAt: string | null;
  errorMessage: string | null;
}

const UNAVAILABLE = 'Consent settings are temporarily unavailable.';
const INVALID = 'The consent server returned an invalid response.';

export function replyFor(kind: BodyKind): {
  reply: MockReply | null;
  expected: ExpectedOutcome;
} {
  const ok = (active: boolean, lastActionAt: string | null) => ({
    success: true,
    active,
    lastActionAt,
    errorMessage: null,
  });
  const fail = (errorMessage: string) => ({
    success: false,
    active: false,
    lastActionAt: null,
    errorMessage,
  });
  const video = scopeRow('video_analysis', false, null, null);
  switch (kind) {
    case 'ok_active_true':
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [video, scopeRow('model_training', true)],
        }),
        expected: ok(true, TS),
      };
    case 'ok_active_false':
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [video, scopeRow('model_training', false, TS2, null)],
        }),
        expected: ok(false, TS2),
      };
    case 'ok_active_true_no_timestamp':
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [scopeRow('model_training', true, null)],
        }),
        expected: ok(true, null),
      };
    case 'ok_no_model_training_scope':
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [video, scopeRow('evaluation_telemetry', true)],
        }),
        expected: ok(false, null),
      };
    case 'ok_empty_scopes':
      return {
        reply: jsonReply({ subjectPseudonym: null, scopes: [] }),
        expected: ok(false, null),
      };
    case 'ok_duplicate_model_training_scope':
      // Array.prototype.find → the FIRST row wins.
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [
            scopeRow('model_training', true, TS2),
            scopeRow('model_training', false, TS, null),
          ],
        }),
        expected: ok(true, TS2),
      };
    case 'ok_null_pseudonym':
      return {
        reply: jsonReply({
          subjectPseudonym: null,
          scopes: [scopeRow('model_training', false, null, null)],
        }),
        expected: ok(false, null),
      };
    case 'http_error_valid_body':
      return {
        reply: jsonReply(
          {
            subjectPseudonym: 'p-1',
            scopes: [scopeRow('model_training', true)],
          },
          false,
        ),
        expected: fail(UNAVAILABLE),
      };
    case 'http_error_null_json':
      return {
        reply: { ok: false, json: () => Promise.reject(new Error('no body')) },
        expected: fail(UNAVAILABLE),
      };
    case 'invalid_body_nonsense':
      return { reply: jsonReply({ nonsense: true }), expected: fail(INVALID) };
    case 'invalid_body_active_string':
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [scopeRow('model_training', 'true')],
        }),
        expected: fail(INVALID),
      };
    case 'invalid_body_unknown_scope':
      return {
        reply: jsonReply({
          subjectPseudonym: 'p-1',
          scopes: [scopeRow('model_training', true), scopeRow('future', false)],
        }),
        expected: fail(INVALID),
      };
    case 'invalid_body_scopes_not_array':
      return {
        reply: jsonReply({ subjectPseudonym: 'p-1', scopes: {} }),
        expected: fail(INVALID),
      };
    case 'json_rejects':
      return {
        reply: { ok: true, json: () => Promise.reject(new Error('bad json')) },
        expected: fail(INVALID),
      };
    case 'network_reject':
      return { reply: null, expected: fail(UNAVAILABLE) };
  }
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export type Action =
  | { kind: 'signIn'; account: AccountId }
  | { kind: 'signOut' }
  | { kind: 'hydrate'; body: BodyKind }
  | { kind: 'toggle'; granted: boolean; body: BodyKind }
  /** Land the n-th oldest pending request (0 = oldest). */
  | { kind: 'land'; index: number }
  /** Advance fake time; ≥ 15 000 ms aborts every pending request. */
  | { kind: 'advance'; ms: number }
  | { kind: 'flush' };

const ACTION_WEIGHTS = {
  signIn: 9,
  signOut: 6,
  hydrate: 20,
  toggle: 20,
  land: 28,
  advance: 6,
  flush: 11,
} as const;

export interface Scenario {
  seed: number;
  actions: Action[];
}

export function generateScenario(
  seed: number,
  minLen: number,
  maxLen: number,
): Scenario {
  const rng = new Rng(seed);
  const length = minLen + rng.int(maxLen - minLen + 1);
  const actions: Action[] = [];
  // The generator does not know the store; it just biases toward useful
  // interleavings: `land` refers to the pending queue by index and is
  // clamped at execution time (a no-op when nothing is pending).
  for (let i = 0; i < length; i++) {
    const kind = rng.weighted(ACTION_WEIGHTS);
    switch (kind) {
      case 'signIn':
        actions.push({ kind, account: rng.pick(ACCOUNTS) });
        break;
      case 'signOut':
        actions.push({ kind });
        break;
      case 'hydrate':
        actions.push({ kind, body: rng.pick(BODY_KINDS) });
        break;
      case 'toggle':
        actions.push({
          kind,
          granted: rng.next() < 0.55,
          body: rng.pick(BODY_KINDS),
        });
        break;
      case 'land':
        actions.push({ kind, index: rng.int(4) });
        break;
      case 'advance':
        actions.push({
          kind,
          ms: rng.next() < 0.5 ? 15_001 : 1 + rng.int(14_000),
        });
        break;
      case 'flush':
        actions.push({ kind });
        break;
    }
  }
  return { seed, actions };
}

// ─── Reference model ─────────────────────────────────────────────────────────

export interface StoreSnapshot {
  availability: ConsentAvailability;
  modelTrainingActive: boolean;
  lastActionAt: string | null;
  busy: boolean;
  error: string | null;
}

const SIGNED_OUT: StoreSnapshot = {
  availability: 'signed_out',
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,
};

const INITIAL: StoreSnapshot = {
  availability: 'loading',
  modelTrainingActive: false,
  lastActionAt: null,
  busy: false,
  error: null,
};

interface PendingRequest {
  id: number;
  kind: 'hydrate' | 'grant' | 'withdraw';
  body: BodyKind;
  session: ApiSession;
  resolve: (reply: MockReply) => void;
  reject: (error: Error) => void;
  aborted: boolean;
}

export interface RequestLogEntry {
  id: number;
  url: string;
  method: string | undefined;
  authorization: string | undefined;
  body: unknown;
  hasSignal: boolean;
}

export interface Violation {
  step: number;
  invariant: string;
  detail: string;
}

export interface TraceStep {
  step: number;
  action: Action;
  state: StoreSnapshot;
  pending: number;
  requestsIssued: number;
}

export interface RunResult {
  seed: number;
  length: number;
  ok: boolean;
  violations: Violation[];
  /** Report-only ordering observations (see file header). */
  orderingObservations: Violation[];
  stats: {
    requests: number;
    landedApplied: number;
    landedStale: number;
    aborted: number;
    fetchRejected: number;
    busyGuardHits: number;
    signedOutCalls: number;
  };
  trace: TraceStep[];
}

function snapshot(): StoreSnapshot {
  const s = useConsentStore.getState();
  return {
    availability: s.availability,
    modelTrainingActive: s.modelTrainingActive,
    lastActionAt: s.lastActionAt,
    busy: s.busy,
    error: s.error,
  };
}

function sameSnapshot(a: StoreSnapshot, b: StoreSnapshot): boolean {
  return (
    a.availability === b.availability &&
    a.modelTrainingActive === b.modelTrainingActive &&
    a.lastActionAt === b.lastActionAt &&
    a.busy === b.busy &&
    a.error === b.error
  );
}

export function resetConsentStore(): void {
  useConsentStore.setState({ ...INITIAL });
  clearApiSession();
}

/** Drains microtasks (and setImmediate, which must NOT be faked). */
export async function flushAsync(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

const AVAILABILITIES: ReadonlySet<string> = new Set([
  'loading',
  'ready',
  'signed_out',
  'unavailable',
]);

/**
 * Executes one scenario against the real store. Requires jest modern fake
 * timers with `setImmediate`/`nextTick` NOT faked (the suite sets that up).
 */
export async function runScenario(scenario: Scenario): Promise<RunResult> {
  resetConsentStore();

  const violations: Violation[] = [];
  const ordering: Violation[] = [];
  const trace: TraceStep[] = [];
  const requestLog: RequestLogEntry[] = [];
  const pending: PendingRequest[] = [];
  const stats: RunResult['stats'] = {
    requests: 0,
    landedApplied: 0,
    landedStale: 0,
    aborted: 0,
    fetchRejected: 0,
    busyGuardHits: 0,
    signedOutCalls: 0,
  };
  let step = 0;
  let nextId = 0;
  let model: StoreSnapshot = { ...INITIAL };
  /** Account whose applied status response proved modelTrainingActive=true. */
  let provenActiveFor: string | null = null;
  /** Issue id of the last request whose reply was APPLIED to the ledger view. */
  let lastAppliedId = -1;
  let lastAppliedMutationId = -1;
  const promises: Array<{ id: number; settled: boolean; rejected: unknown }> =
    [];

  const fail = (invariant: string, detail: string) => {
    violations.push({ step, invariant, detail });
  };

  /** One fetchFn per issued call so the harness knows which store call
   * produced which request. */
  const makeFetch = (
    kind: PendingRequest['kind'],
    body: BodyKind,
    session: ApiSession,
  ): ConsentFetch => {
    return (input, init) => {
      const id = nextId++;
      stats.requests += 1;
      const headers = (init?.headers ?? {}) as Record<string, string>;
      requestLog.push({
        id,
        url: input,
        method: init?.method,
        authorization: headers['Authorization'],
        body:
          init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        hasSignal: Boolean(init?.signal),
      });
      return new Promise<Response>((resolve, reject) => {
        const entry: PendingRequest = {
          id,
          kind,
          body,
          session,
          resolve: reply => resolve(reply as unknown as Response),
          reject,
          aborted: false,
        };
        pending.push(entry);
        init?.signal?.addEventListener('abort', () => {
          const idx = pending.indexOf(entry);
          if (idx === -1) return;
          pending.splice(idx, 1);
          entry.aborted = true;
          stats.aborted += 1;
          landModel(entry, 'network_reject');
          reject(new Error('AbortError'));
        });
      });
    };
  };

  /** Applies the documented landing rules to the reference model. */
  const landModel = (entry: PendingRequest, effectiveBody: BodyKind) => {
    const current = getApiSession();
    if (current?.canonicalAppUserId !== entry.session.canonicalAppUserId) {
      stats.landedStale += 1;
      model = current ? { ...model, busy: false } : { ...SIGNED_OUT };
      if (!current) provenActiveFor = null;
      return;
    }
    stats.landedApplied += 1;
    const { expected } = replyFor(effectiveBody);
    const before = model;
    if (entry.kind === 'hydrate') {
      model = expected.success
        ? {
            ...model,
            availability: 'ready',
            modelTrainingActive: expected.active,
            lastActionAt: expected.lastActionAt,
          }
        : {
            ...model,
            availability: 'unavailable',
            modelTrainingActive: false,
            error: expected.errorMessage,
          };
    } else {
      model = expected.success
        ? {
            ...model,
            busy: false,
            availability: 'ready',
            modelTrainingActive: expected.active,
            lastActionAt: expected.lastActionAt,
          }
        : { ...model, busy: false, error: expected.errorMessage };
    }
    if (expected.success) {
      provenActiveFor = expected.active ? current.canonicalAppUserId : null;
    } else if (entry.kind === 'hydrate') {
      provenActiveFor = null;
    }
    if (expected.success) {
      const changedView =
        before.modelTrainingActive !== model.modelTrainingActive ||
        before.lastActionAt !== model.lastActionAt;
      if (entry.id < lastAppliedId && changedView) {
        ordering.push({
          step,
          invariant:
            entry.kind === 'hydrate' && entry.id < lastAppliedMutationId
              ? 'stale_read_overwrites_newer_mutation'
              : 'stale_response_overwrites_newer_response',
          detail: `request#${entry.id} (${entry.kind}, ${effectiveBody}) landed after request#${lastAppliedId} and changed modelTrainingActive ${before.modelTrainingActive}→${model.modelTrainingActive}`,
        });
      }
      lastAppliedId = Math.max(lastAppliedId, entry.id);
      if (entry.kind !== 'hydrate')
        lastAppliedMutationId = Math.max(lastAppliedMutationId, entry.id);
    }
  };

  const checkShape = (s: StoreSnapshot) => {
    if (!AVAILABILITIES.has(s.availability))
      fail('shape', `availability=${String(s.availability)}`);
    if (typeof s.modelTrainingActive !== 'boolean')
      fail('shape', `modelTrainingActive=${String(s.modelTrainingActive)}`);
    if (typeof s.busy !== 'boolean') fail('shape', `busy=${String(s.busy)}`);
    if (!(s.error === null || (typeof s.error === 'string' && s.error !== '')))
      fail('shape', `error=${JSON.stringify(s.error)}`);
    if (!(s.lastActionAt === null || typeof s.lastActionAt === 'string'))
      fail('shape', `lastActionAt=${JSON.stringify(s.lastActionAt)}`);
  };

  const checkInvariants = (action: Action) => {
    const s = snapshot();
    checkShape(s);
    if (s.modelTrainingActive) {
      if (s.availability === 'signed_out' || s.availability === 'unavailable')
        fail(
          'default_off',
          `modelTrainingActive=true while availability=${s.availability}`,
        );
      else if (provenActiveFor === null)
        fail(
          'default_off',
          `modelTrainingActive=true (availability=${s.availability}) without an applied status response proving it`,
        );
      else if (provenActiveFor !== getApiSession()?.canonicalAppUserId)
        ordering.push({
          step,
          invariant: 'active_shown_for_other_account_until_hydrate',
          detail: `modelTrainingActive=true was proven for ${provenActiveFor} but the current session is ${String(getApiSession()?.canonicalAppUserId)} (no reset on session change; UI re-hydrates on session change)`,
        });
    }
    if (!sameSnapshot(s, model))
      fail(
        'model_state',
        `store=${JSON.stringify(s)} model=${JSON.stringify(model)}`,
      );
    trace.push({
      step,
      action,
      state: s,
      pending: pending.length,
      requestsIssued: stats.requests,
    });
  };

  const checkRequestContract = (
    entry: RequestLogEntry | undefined,
    kind: PendingRequest['kind'],
    session: ApiSession,
  ) => {
    if (!entry) {
      fail('request_contract', `${kind} issued no request`);
      return;
    }
    const path =
      kind === 'hydrate'
        ? '/v1/me/consent/status'
        : kind === 'grant'
          ? '/v1/me/consent/grant'
          : '/v1/me/consent/withdraw';
    if (entry.url !== `${session.apiBaseUrl}${path}`)
      fail(
        'request_contract',
        `url=${entry.url} expected ${session.apiBaseUrl}${path}`,
      );
    if (entry.method !== (kind === 'hydrate' ? 'GET' : 'POST'))
      fail('request_contract', `method=${String(entry.method)} for ${kind}`);
    if (entry.authorization !== `Bearer ${session.bearerToken}`)
      fail(
        'request_contract',
        `authorization=${String(entry.authorization)} expected bearer of ${session.canonicalAppUserId}`,
      );
    if (!entry.hasSignal) fail('request_contract', 'no AbortSignal attached');
    if (kind !== 'hydrate') {
      const body = entry.body as Record<string, unknown> | undefined;
      if (body?.['scope'] !== 'model_training')
        fail('request_contract', `body.scope=${String(body?.['scope'])}`);
      if (
        kind === 'grant' &&
        body?.['consentVersion'] !== MODEL_TRAINING_CONSENT_VERSION
      )
        fail(
          'request_contract',
          `grant consentVersion=${String(body?.['consentVersion'])}`,
        );
      if (kind === 'withdraw' && 'consentVersion' in (body ?? {}))
        fail('request_contract', 'withdraw carries a consentVersion');
      if (body?.['source'] !== 'mobile_settings')
        fail('request_contract', `body.source=${String(body?.['source'])}`);
    } else if (entry.body !== undefined) {
      fail('request_contract', 'GET status carries a body');
    }
  };

  const track = (id: number, p: Promise<void>) => {
    const rec = { id, settled: false, rejected: null as unknown };
    promises.push(rec);
    p.then(
      () => {
        rec.settled = true;
      },
      (e: unknown) => {
        rec.settled = true;
        rec.rejected = e ?? new Error('rejected with undefined');
      },
    );
  };

  const landPending = async (entry: PendingRequest) => {
    const idx = pending.indexOf(entry);
    if (idx !== -1) pending.splice(idx, 1);
    const { reply } = replyFor(entry.body);
    if (reply === null) {
      stats.fetchRejected += 1;
      entry.reject(new Error('network down'));
    } else {
      entry.resolve(reply);
    }
    await flushAsync();
    landModel(entry, entry.body);
  };

  for (const action of scenario.actions) {
    step += 1;
    switch (action.kind) {
      case 'signIn':
        establishApiSession(sessionFor(action.account));
        break;
      case 'signOut':
        clearApiSession();
        break;
      case 'hydrate': {
        const session = getApiSession();
        const before = stats.requests;
        const logBefore = requestLog.length;
        if (!session) {
          stats.signedOutCalls += 1;
          track(
            step,
            useConsentStore
              .getState()
              .hydrate(makeFetch('hydrate', action.body, sessionFor('A'))),
          );
          await flushAsync();
          if (stats.requests !== before)
            fail(
              'no_fetch_signed_out',
              'hydrate issued a request without a session',
            );
          model = { ...SIGNED_OUT };
          provenActiveFor = null;
          break;
        }
        track(
          step,
          useConsentStore
            .getState()
            .hydrate(makeFetch('hydrate', action.body, session)),
        );
        // The request is issued synchronously before the first await.
        model = { ...model, availability: 'loading', error: null };
        await flushAsync(1);
        checkRequestContract(requestLog[logBefore], 'hydrate', session);
        break;
      }
      case 'toggle': {
        const session = getApiSession();
        const before = stats.requests;
        const logBefore = requestLog.length;
        const kind = action.granted ? 'grant' : 'withdraw';
        if (!session) {
          stats.signedOutCalls += 1;
          track(
            step,
            useConsentStore
              .getState()
              .setModelTrainingConsent(
                action.granted,
                makeFetch(kind, action.body, sessionFor('A')),
              ),
          );
          await flushAsync();
          if (stats.requests !== before)
            fail(
              'no_fetch_signed_out',
              'toggle issued a request without a session',
            );
          model = {
            ...SIGNED_OUT,
            error: 'Sign in to change this setting. Nothing was changed.',
          };
          provenActiveFor = null;
          break;
        }
        const wasBusy = useConsentStore.getState().busy;
        const preToggle = snapshot();
        track(
          step,
          useConsentStore
            .getState()
            .setModelTrainingConsent(
              action.granted,
              makeFetch(kind, action.body, session),
            ),
        );
        await flushAsync(1);
        if (wasBusy) {
          stats.busyGuardHits += 1;
          if (stats.requests !== before)
            fail('busy_guard', 'toggle while busy issued a request');
          if (!sameSnapshot(snapshot(), preToggle))
            fail('busy_guard', 'toggle while busy mutated state');
          break;
        }
        model = { ...model, busy: true, error: null };
        const inFlight = snapshot();
        if (
          inFlight.modelTrainingActive !== preToggle.modelTrainingActive ||
          inFlight.lastActionAt !== preToggle.lastActionAt ||
          inFlight.availability !== preToggle.availability
        )
          fail(
            'no_optimistic_state',
            `${kind} changed the ledger view before its response landed: ${JSON.stringify(preToggle)} → ${JSON.stringify(inFlight)}`,
          );
        checkRequestContract(requestLog[logBefore], kind, session);
        break;
      }
      case 'land': {
        if (pending.length === 0) break;
        const entry = pending[Math.min(action.index, pending.length - 1)]!;
        const sessionBefore = getApiSession();
        const stale =
          sessionBefore?.canonicalAppUserId !==
          entry.session.canonicalAppUserId;
        const preLand = snapshot();
        const { expected } = replyFor(entry.body);
        await landPending(entry);
        const post = snapshot();
        if (stale) {
          const want: StoreSnapshot = sessionBefore
            ? { ...preLand, busy: false }
            : { ...SIGNED_OUT };
          if (!sameSnapshot(post, want))
            fail(
              'stale_session',
              `${sessionBefore ? 'switched' : 'signed_out'}: store=${JSON.stringify(post)} want=${JSON.stringify(want)}`,
            );
        } else if (entry.kind !== 'hydrate' && !expected.success) {
          if (post.modelTrainingActive !== preLand.modelTrainingActive)
            fail(
              'no_optimistic_state',
              `failed ${entry.kind} moved modelTrainingActive ${preLand.modelTrainingActive}→${post.modelTrainingActive}`,
            );
          if (post.busy)
            fail('no_optimistic_state', 'busy stuck after failed toggle');
          if (post.error === null)
            fail('no_optimistic_state', 'failed toggle surfaced no error');
        }
        break;
      }
      case 'advance': {
        // Aborts are delivered through the AbortSignal listener above, which
        // updates the model in abort order (oldest timer first).
        await jest.advanceTimersByTimeAsync(action.ms);
        await flushAsync();
        break;
      }
      case 'flush':
        await flushAsync();
        break;
    }
    checkInvariants(action);
  }

  // Quiescence: land everything still pending, oldest first.
  step += 1;
  while (pending.length > 0) {
    await landPending(pending[0]!);
  }
  await flushAsync();
  checkInvariants({ kind: 'flush' });
  const final = snapshot();
  if (final.busy) fail('quiescence', 'busy=true with no request pending');
  for (const p of promises) {
    if (!p.settled)
      fail('promise_settles', `store promise from step ${p.id} never settled`);
    if (p.rejected !== null)
      fail(
        'promise_settles',
        `store promise from step ${p.id} rejected: ${String(p.rejected)}`,
      );
  }

  return {
    seed: scenario.seed,
    length: scenario.actions.length,
    ok: violations.length === 0,
    violations,
    orderingObservations: ordering,
    stats,
    trace,
  };
}

// ─── Determinism & minimisation ──────────────────────────────────────────────

/** Trace fingerprint: per-step state + request count + violations. */
export function fingerprint(result: RunResult): string {
  return JSON.stringify({
    trace: result.trace.map(t => [t.state, t.pending, t.requestsIssued]),
    violations: result.violations,
    ordering: result.orderingObservations,
    stats: result.stats,
  });
}

/**
 * ddmin over the action list: keeps removing chunks while the reduced list
 * still trips the same invariant. Returns the smallest list found.
 */
export async function minimizeScenario(
  scenario: Scenario,
  invariant: string,
): Promise<Scenario> {
  const trips = async (actions: Action[]) => {
    const r = await runScenario({ seed: scenario.seed, actions });
    return (
      r.violations.some(v => v.invariant === invariant) ||
      r.orderingObservations.some(v => v.invariant === invariant)
    );
  };
  let actions = scenario.actions.slice();
  let n = 2;
  while (actions.length >= 2) {
    const chunk = Math.ceil(actions.length / n);
    let reduced = false;
    for (let start = 0; start < actions.length; start += chunk) {
      const candidate = [
        ...actions.slice(0, start),
        ...actions.slice(start + chunk),
      ];
      if (candidate.length > 0 && (await trips(candidate))) {
        actions = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= actions.length) break;
      n = Math.min(n * 2, actions.length);
    }
  }
  return { seed: scenario.seed, actions };
}
