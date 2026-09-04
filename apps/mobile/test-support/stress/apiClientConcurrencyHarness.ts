/**
 * CONCURRENCY stress harness for `src/data/api.ts` (unit `mod-api-client`).
 *
 * Every iteration is a seeded Promise.all burst against the REAL api.ts
 * surface — `createTransport`, `createAnalysisPermitClient`,
 * `submitAnalysisFeedback` — wired to the real `src/account/apiSession.ts`
 * store (bearer resolution + 401 reporting). Only `fetch` and the clock are
 * replaced. The seeded scheduler decides, per request, its latency (some past
 * the client timeout), whether the network loses it, and the body class it
 * gets back (valid / 401 / consumed permit / 4xx / 5xx / malformed JSON /
 * `null` body / wrong shape / oversized), and interleaves session events
 * (bearer rotation, sign-out, re-sign-in as the same or another account,
 * wall-clock skew) while requests are in flight. Ops are launched as a
 * synchronous burst, chained off other ops' settlement (call-during-call:
 * release-after-reserve, two actors releasing the same permit), or from
 * timers; some callers abandon their promise (cancel-during-call).
 *
 * Invariants judged per iteration (each failure names the seed):
 *   bounded          every op settles, no later than start + API_REQUEST_TIMEOUT_MS
 *   timeout_typed    latency > timeout ⇒ ApiError 408 network.timeout + abort
 *                    latency ≤ timeout ⇒ never 408; lost ⇒ raw TypeError
 *   one_fetch        each op that reaches the network makes exactly ONE fetch
 *                    (no client retries → no double spend of a permit key)
 *   token_once       the bearer SENT is the one current at call time
 *   unauthorized     a 401 reaches the listener iff its bearer is still the
 *                    current session bearer at delivery — never after
 *                    sign-out or for a rotated-away token, and never twice
 *   isolation        a resolved op holds exactly the body ITS fetch received
 *   permit_contract  reserve/release settle per the api.ts contract
 *   signed_out       permit calls without a bearer fail before the network
 *   no_leak          no live timers and no unhandled rejections afterwards
 *
 * Replay one seed:
 *   STRESS_ONLY=<seed> npx jest --ci __tests__/stress/apiClientConcurrency.stress.test.ts
 */
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createAnalysisPermitClient,
  createTransport,
  submitAnalysisFeedback,
  type ApiConfigState,
  type ReservedAnalysisPermitWithAccess,
} from '../../src/data/api';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';

declare const process: {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

export const API_BASE = 'https://api.stress.test';
export const CANONICAL_ID = '2f3c9d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const OTHER_CANONICAL_ID = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

/** Real wall clock, captured before jest fakes `Date`. */
const REAL_NOW: () => number = Date.now.bind(Date);

// ─── Seeded RNG (mulberry32) ─────────────────────────────────────────────────

export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(minInclusive: number, maxInclusive: number): number {
    return (
      minInclusive + Math.floor(this.next() * (maxInclusive - minInclusive + 1))
    );
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  weighted<T extends string>(table: Readonly<Record<T, number>>): T {
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

// ─── Scenario ────────────────────────────────────────────────────────────────

export type OpKind =
  | 'reserve'
  | 'release'
  | 'syncShots'
  | 'createSession'
  | 'finalizeSession'
  | 'uploadTrials'
  | 'feedback';

export const OP_KINDS: readonly OpKind[] = [
  'reserve',
  'release',
  'syncShots',
  'createSession',
  'finalizeSession',
  'uploadTrials',
  'feedback',
];

/** What the mock server answers once the planned latency elapses. */
export type BodyClass =
  | 'ok'
  | 'ok_oversized'
  | 'http_401'
  | 'permit_consumed'
  | 'http_4xx'
  | 'http_5xx'
  | 'malformed_json'
  | 'null_body'
  | 'wrong_shape';

export interface ResponsePlan {
  latencyMs: number;
  /** Network drops the request: fetch rejects with a TypeError after latency. */
  lost: boolean;
  body: BodyClass;
  /** Non-2xx: the error envelope itself is unparsable. */
  errorBodyMalformed: boolean;
  /** A stale (rotated-away) bearer is refused with 401 by the server. */
  refuseStaleBearer: boolean;
}

export type OpStart =
  | { mode: 'burst' }
  | { mode: 'timer'; atMs: number }
  | {
      mode: 'chained';
      afterOp: number;
      /** For release-after-reserve: use the permit id the parent returned. */
      usesParentPermit: boolean;
    };

export interface SeededOp {
  index: number;
  kind: OpKind;
  /** idempotency key / entity id / permit id / analysis id. */
  key: string;
  start: OpStart;
  plan: ResponsePlan;
  /** Caller stops awaiting immediately (cancel-during-call). */
  abandoned: boolean;
}

export type SessionEventKind =
  'rotate' | 'logout' | 'relogin_same' | 'relogin_other' | 'skew';

export interface SessionEvent {
  atMs: number;
  kind: SessionEventKind;
  /** skew only: wall-clock jump applied via jest.setSystemTime. */
  skewMs: number;
}

export interface Scenario {
  seed: number;
  ops: SeededOp[];
  events: SessionEvent[];
  /** Permit client config style: production has both call sites. */
  permitConfig: 'getter' | 'captured';
}

const OP_WEIGHTS: Record<OpKind, number> = {
  reserve: 28,
  release: 12,
  syncShots: 20,
  createSession: 10,
  finalizeSession: 8,
  uploadTrials: 7,
  feedback: 15,
};

const BODY_WEIGHTS: Record<BodyClass, number> = {
  ok: 58,
  ok_oversized: 3,
  http_401: 9,
  permit_consumed: 5,
  http_4xx: 6,
  http_5xx: 5,
  malformed_json: 5,
  null_body: 4,
  wrong_shape: 5,
};

function planResponse(rng: Rng): ResponsePlan {
  const bucket = rng.weighted({ fast: 62, slow: 20, beyond: 18 });
  const latencyMs =
    bucket === 'fast'
      ? rng.int(0, 2_500)
      : bucket === 'slow'
        ? rng.int(2_500, API_REQUEST_TIMEOUT_MS - 1)
        : rng.int(API_REQUEST_TIMEOUT_MS + 1, API_REQUEST_TIMEOUT_MS * 2);
  return {
    latencyMs,
    lost: rng.chance(0.08),
    body: rng.weighted(BODY_WEIGHTS),
    errorBodyMalformed: rng.chance(0.3),
    refuseStaleBearer: rng.chance(0.5),
  };
}

function uuidLike(rng: Rng, prefix: string): string {
  const hex = (n: number) =>
    Math.floor(rng.next() * 16 ** n)
      .toString(16)
      .padStart(n, '0');
  return `${prefix}${hex(4)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(8)}${hex(4)}`;
}

export function buildScenario(seed: number): Scenario {
  const rng = new Rng((seed * 2_654_435_761) >>> 0);
  const opCount = rng.int(6, 32);
  const ops: SeededOp[] = [];
  const keysByKind = new Map<OpKind, string[]>();
  for (let index = 0; index < opCount; index++) {
    const kind = rng.weighted(OP_WEIGHTS);
    const existing = keysByKind.get(kind) ?? [];
    // Two actors on the same row/id: reuse a key already in play.
    const reuse = existing.length > 0 && rng.chance(0.35);
    const key = reuse ? rng.pick(existing) : uuidLike(rng, '');
    if (!reuse) keysByKind.set(kind, [...existing, key]);

    let start: OpStart = { mode: 'burst' };
    if (index > 0) {
      const mode = rng.weighted({ burst: 55, timer: 20, chained: 25 });
      if (mode === 'timer') {
        start = { mode: 'timer', atMs: rng.int(1, 24_000) };
      } else if (mode === 'chained') {
        const afterOp = rng.int(0, index - 1);
        const parent = ops[afterOp]!;
        start = {
          mode: 'chained',
          afterOp,
          usesParentPermit:
            kind === 'release' && parent.kind === 'reserve' && rng.chance(0.8),
        };
      }
    }
    ops.push({
      index,
      kind,
      key,
      start,
      plan: planResponse(rng),
      abandoned: rng.chance(0.12),
    });
  }

  const events: SessionEvent[] = [];
  const eventCount = rng.weighted({ 0: 25, 1: 35, 2: 25, 3: 15 });
  for (let i = 0; i < Number(eventCount); i++) {
    const kind = rng.weighted<SessionEventKind>({
      rotate: 35,
      logout: 20,
      relogin_same: 15,
      relogin_other: 10,
      skew: 20,
    });
    events.push({
      atMs: rng.int(0, 26_000),
      kind,
      skewMs:
        kind === 'skew'
          ? rng.pick([
              -7_200_000, -60_000, -1, 1, 45_000, 3_600_000, 86_400_000,
            ])
          : 0,
    });
  }
  events.sort((a, b) => a.atMs - b.atMs);

  return {
    seed,
    ops,
    events,
    permitConfig: rng.chance(0.5) ? 'getter' : 'captured',
  };
}

// ─── Mock transport ──────────────────────────────────────────────────────────

export interface FetchRecord {
  seq: number;
  opIndex: number | null;
  url: string;
  method: string;
  bearerSent: string | null;
  bearerCurrentAtSend: string | null;
  requestBody: unknown;
  plan: ResponsePlan | null;
  /** Bearer current when the response was delivered (null = signed out). */
  bearerCurrentAtDelivery: string | null;
  servedStatus: number | null;
  servedBody: unknown;
  outcome: 'pending' | 'served' | 'lost' | 'aborted';
  abortedBeforeServe: boolean;
}

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function makeResponse(
  status: number,
  body: unknown,
  unparsable: boolean,
): MockResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    json: unparsable
      ? () =>
          Promise.reject(
            new SyntaxError('Unexpected token < in JSON at position 0'),
          )
      : () => Promise.resolve(body),
  };
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

const OVERSIZED_FILLER = 'x'.repeat(256 * 1024);

/** Serves the body class for a request; `seq` tags the body so isolation is
 * checkable on whatever the client returns. */
function serve(
  record: FetchRecord,
  op: SeededOp,
  rotatedAway: boolean,
): { status: number; body: unknown; unparsable: boolean } {
  const plan = op.plan;
  const seq = record.seq;
  const envelope = (code: string, message: string) =>
    plan.errorBodyMalformed
      ? { status: 0, body: null, unparsable: true }
      : { status: 0, body: { error: { code, message } }, unparsable: false };
  if (rotatedAway && plan.refuseStaleBearer) {
    return { ...envelope('auth.required', 'stale bearer'), status: 401 };
  }
  switch (plan.body) {
    case 'http_401':
      return { ...envelope('auth.required', 'bearer rejected'), status: 401 };
    case 'http_4xx':
      return {
        ...envelope('access.free_ratings_exhausted', 'no ratings left'),
        status: 402,
      };
    case 'http_5xx':
      return { ...envelope('server.failed', 'oops'), status: 503 };
    case 'malformed_json':
      return { status: 200, body: null, unparsable: true };
    case 'null_body':
      return { status: 200, body: null, unparsable: false };
    default:
      break;
  }
  const oversized =
    plan.body === 'ok_oversized' ? { filler: OVERSIZED_FILLER } : {};
  const wrong = plan.body === 'wrong_shape';
  switch (op.kind) {
    case 'reserve': {
      if (wrong) {
        return {
          status: 200,
          body: { permit: { id: '', accessSource: 'trial', status: 1 }, seq },
          unparsable: false,
        };
      }
      const status = plan.body === 'permit_consumed' ? 'consumed' : 'reserved';
      return {
        status: 200,
        body: {
          permit: {
            id: `permit-${seq}-${op.key}`,
            accessSource: seq % 2 === 0 ? 'free' : 'premium',
            status,
            expiresAt: `2026-09-04T12:00:${String(seq % 60).padStart(2, '0')}.${String(seq).padStart(3, '0')}Z`,
          },
          access:
            seq % 3 === 0
              ? {
                  premium: false,
                  freeRatings: {
                    limit: 2,
                    used: 1,
                    reserved: 1,
                    remaining: 1,
                    availableToReserve: 0,
                  },
                }
              : seq % 3 === 1
                ? { premium: 'yes', freeRatings: { limit: 'two' } }
                : undefined,
          ...oversized,
        },
        unparsable: false,
      };
    }
    case 'release':
      return {
        status: 200,
        body: wrong
          ? { seq }
          : { permit: { id: op.key, status: 'released' }, seq, ...oversized },
        unparsable: false,
      };
    case 'syncShots':
      return {
        status: 200,
        body: wrong
          ? { accepted: 'yes', seq }
          : {
              acceptedIds: [op.key],
              rejected: [],
              seq,
              ...(plan.body === 'ok_oversized'
                ? {
                    rejected: Array.from({ length: 4_000 }, (_, i) => ({
                      id: `r-${i}`,
                      code: 'shot.invalid',
                      message: OVERSIZED_FILLER.slice(0, 64),
                    })),
                  }
                : {}),
            },
        unparsable: false,
      };
    case 'uploadTrials':
      return {
        status: 200,
        body: wrong
          ? [op.key, seq]
          : { acceptedTrialIds: [op.key], rejected: [], seq, ...oversized },
        unparsable: false,
      };
    case 'createSession':
    case 'finalizeSession':
      return {
        status: 200,
        body: wrong ? 'ok' : { id: op.key, seq, ...oversized },
        unparsable: false,
      };
    case 'feedback':
      return {
        status: 200,
        body: wrong
          ? { feedback: 'thanks', seq }
          : { feedback: { reviewEligible: seq % 2 === 0 }, seq, ...oversized },
        unparsable: false,
      };
  }
}

// ─── Iteration ───────────────────────────────────────────────────────────────

export interface OpRecord {
  index: number;
  kind: OpKind;
  key: string;
  startMode: OpStart['mode'];
  abandoned: boolean;
  plan: ResponsePlan;
  /** Virtual ms (skew-corrected) when the client call was made. */
  startedAtMs: number | null;
  settledAtMs: number | null;
  fetchSeq: number | null;
  settlement: 'pending' | 'resolved' | 'rejected';
  resolvedSummary: string | null;
  error: {
    type: 'ApiError' | 'TypeError' | 'AbortError' | 'other';
    status: number | null;
    code: string | null;
    message: string;
  } | null;
}

export interface Failure {
  invariant: string;
  op: number | null;
  detail: string;
}

export interface IterationStats {
  ops: number;
  launched: number;
  fetches: number;
  fetchesWithoutBearer: number;
  timeouts: number;
  lost: number;
  served401: number;
  listenerFires: number;
  rotations: number;
  logouts: number;
  relogins: number;
  skews: number;
  duplicatesKeys: number;
  chained: number;
  abandoned: number;
  timerSteps: number;
  virtualElapsedMs: number;
  realElapsedMs: number;
}

export interface IterationResult {
  seed: number;
  ok: boolean;
  failures: Failure[];
  /** Contract violations by class → count, for pinning known ones. */
  violationClasses: Record<string, number>;
  stats: IterationStats;
  permitConfig: Scenario['permitConfig'];
  ops: OpRecord[];
  fetches: FetchRecord[];
  events: SessionEvent[];
  replay: string;
}

function sessionFor(token: string, canonicalAppUserId: string): ApiSession {
  return {
    apiBaseUrl: API_BASE,
    bearerToken: token,
    canonicalAppUserId,
    provider: 'apple',
    refreshToken: null,
    bearerExpiresAtMs: null,
  };
}

function describeError(error: unknown): OpRecord['error'] {
  if (error instanceof ApiError) {
    return {
      type: 'ApiError',
      status: error.status,
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof TypeError) {
    return {
      type: 'TypeError',
      status: null,
      code: null,
      message: error.message,
    };
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      type: 'AbortError',
      status: null,
      code: null,
      message: error.message,
    };
  }
  return {
    type: 'other',
    status: null,
    code: null,
    message: error instanceof Error ? error.message : String(error),
  };
}

function summarize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  const text = JSON.stringify(value);
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export const MAX_TIMER_STEPS = 20_000;

export async function runIteration(seed: number): Promise<IterationResult> {
  const scenario = buildScenario(seed);
  const realStart = REAL_NOW();
  jest.useFakeTimers();
  const startMs = Date.UTC(2026, 8, 4, 12, 0, 0);
  jest.setSystemTime(startMs);
  let skewOffsetMs = 0;
  const virtualNow = () => Date.now() - startMs - skewOffsetMs;

  const failures: Failure[] = [];
  const violationClasses: Record<string, number> = {};
  const fail = (invariant: string, op: number | null, detail: string) => {
    failures.push({ invariant, op, detail });
    violationClasses[invariant] = (violationClasses[invariant] ?? 0) + 1;
  };

  // Session wiring: the real store, a spy as the auth store's listener.
  let tokenCounter = 0;
  const nextToken = () => `bearer-${seed}-${++tokenCounter}`;
  const rotatedAway = new Set<string>();
  const listenerFires: Array<{ token: string; atMs: number }> = [];
  setApiUnauthorizedListener(session => {
    listenerFires.push({ token: session.bearerToken, atMs: virtualNow() });
  });
  establishApiSession(sessionFor(nextToken(), CANONICAL_ID));

  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on('unhandledRejection', onUnhandled);

  // Mock fetch.
  const fetches: FetchRecord[] = [];
  const opRecords: OpRecord[] = scenario.ops.map(op => ({
    index: op.index,
    kind: op.kind,
    key: op.key,
    startMode: op.start.mode,
    abandoned: op.abandoned,
    plan: op.plan,
    startedAtMs: null,
    settledAtMs: null,
    fetchSeq: null,
    settlement: 'pending',
    resolvedSummary: null,
    error: null,
  }));
  let currentOp: SeededOp | null = null;
  let seq = 0;
  const previousFetch = globalThis.fetch;
  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    const op = currentOp;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authHeader = headers['authorization'];
    const record: FetchRecord = {
      seq: seq++,
      opIndex: op?.index ?? null,
      url,
      method: init?.method ?? 'GET',
      bearerSent: authHeader ? authHeader.replace(/^Bearer /, '') : null,
      bearerCurrentAtSend: getApiSession()?.bearerToken ?? null,
      requestBody:
        typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      plan: op?.plan ?? null,
      bearerCurrentAtDelivery: null,
      servedStatus: null,
      servedBody: null,
      outcome: 'pending',
      abortedBeforeServe: false,
    };
    fetches.push(record);
    if (!op) {
      fail('one_fetch', null, `unattributed fetch #${record.seq} to ${url}`);
      return Promise.reject(new TypeError('unattributed fetch'));
    }
    const opRecord = opRecords[op.index]!;
    if (opRecord.fetchSeq !== null) {
      fail(
        'one_fetch',
        op.index,
        `op made a second fetch (#${opRecord.fetchSeq} then #${record.seq})`,
      );
    }
    opRecord.fetchSeq = record.seq;

    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        record.bearerCurrentAtDelivery = getApiSession()?.bearerToken ?? null;
        if (op.plan.lost) {
          record.outcome = 'lost';
          reject(new TypeError('Network request failed'));
          return;
        }
        const stale =
          record.bearerSent !== null && rotatedAway.has(record.bearerSent);
        const served = serve(record, op, stale);
        record.outcome = 'served';
        record.servedStatus = served.status;
        record.servedBody = served.unparsable ? '<unparsable>' : served.body;
        resolve(
          makeResponse(
            served.status,
            served.body,
            served.unparsable,
          ) as unknown as Response,
        );
      }, op.plan.latencyMs);
      const onAbort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        record.outcome = 'aborted';
        record.abortedBeforeServe = true;
        reject(abortError());
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort);
      }
    });
  };
  globalThis.fetch = fetchImpl as unknown as typeof fetch;

  // Clients under test — exactly how production builds them.
  const getterConfig: ApiConfigState = {
    baseUrl: API_BASE,
    get token() {
      return bearerTokenFor(CANONICAL_ID);
    },
  };
  const transport = createTransport(getterConfig);
  const permitConfigFor = (): ApiConfigState =>
    scenario.permitConfig === 'getter'
      ? getterConfig
      : {
          baseUrl: getApiSession()?.apiBaseUrl ?? '',
          token: getApiSession()?.bearerToken ?? null,
        };

  const resolvedValues = new Map<number, unknown>();
  const parentPermitId = new Map<number, string>();
  let launched = 0;

  const launch = (op: SeededOp): void => {
    const record = opRecords[op.index]!;
    if (record.startedAtMs !== null) return;
    record.startedAtMs = virtualNow();
    launched += 1;
    const tokenAtCall = bearerTokenFor(CANONICAL_ID);
    const sessionAtCall = getApiSession();
    let permitKey = op.key;
    if (op.start.mode === 'chained' && op.start.usesParentPermit) {
      permitKey = parentPermitId.get(op.start.afterOp) ?? op.key;
    }
    const fetchesBefore = fetches.length;
    currentOp = op;
    let promise: Promise<unknown>;
    try {
      switch (op.kind) {
        default:
          throw new Error(`unknown op kind ${String(op.kind)}`);
        case 'reserve':
          promise = createAnalysisPermitClient(permitConfigFor()).reserve(
            op.key,
          );
          break;
        case 'release':
          promise = createAnalysisPermitClient(permitConfigFor()).release(
            permitKey,
            'low_confidence',
          );
          break;
        case 'syncShots':
          promise = transport.syncShots([{ id: op.key, stress: op.index }]);
          break;
        case 'createSession':
          promise = transport.createSession({ id: op.key, stress: op.index });
          break;
        case 'finalizeSession':
          promise = transport.finalizeSession(op.key);
          break;
        case 'uploadTrials':
          promise = transport.uploadEvaluationTrials!([
            { trialId: op.key, stress: op.index },
          ]);
          break;
        case 'feedback':
          promise = submitAnalysisFeedback(
            permitConfigFor(),
            op.key,
            op.index % 2 === 0 ? 'accurate' : 'not_quite',
            op.index % 2 === 0 ? null : 'wrong_stroke',
          );
          break;
      }
    } finally {
      currentOp = null;
    }
    const madeFetch = fetches.length > fetchesBefore;

    // token_once: what went on the wire is the bearer current at call time.
    if (madeFetch) {
      const sent = fetches[fetches.length - 1]!;
      const expected =
        op.kind === 'reserve' || op.kind === 'release' || op.kind === 'feedback'
          ? scenario.permitConfig === 'getter'
            ? tokenAtCall
            : (sessionAtCall?.bearerToken ?? null)
          : tokenAtCall;
      if (sent.bearerSent !== expected) {
        fail(
          'token_once',
          op.index,
          `sent bearer ${sent.bearerSent} but ${expected} was current at call time`,
        );
      }
    }
    // signed_out: permit calls without a bearer never reach the network.
    const permitBearer =
      scenario.permitConfig === 'getter'
        ? tokenAtCall
        : (sessionAtCall?.bearerToken ?? null);
    if (
      (op.kind === 'reserve' || op.kind === 'release') &&
      !permitBearer?.trim() &&
      madeFetch
    ) {
      fail(
        'signed_out',
        op.index,
        'permit call reached fetch without a bearer',
      );
    }

    const tracked = promise.then(
      value => {
        record.settlement = 'resolved';
        record.settledAtMs = virtualNow();
        record.resolvedSummary = summarize(value);
        resolvedValues.set(op.index, value);
        if (op.kind === 'reserve') {
          const permit = value as ReservedAnalysisPermitWithAccess;
          parentPermitId.set(op.index, permit.permit.id);
        }
        return value;
      },
      (error: unknown) => {
        record.settlement = 'rejected';
        record.settledAtMs = virtualNow();
        record.error = describeError(error);
        return undefined;
      },
    );
    // Chained children start when the parent settles (call-during-call).
    void tracked.then(() => {
      for (const child of scenario.ops) {
        if (
          child.start.mode === 'chained' &&
          child.start.afterOp === op.index
        ) {
          launch(child);
        }
      }
    });
    if (op.abandoned) {
      // Cancel-during-call: the caller walks away; nothing awaits `promise`.
      void promise.catch(() => undefined);
    }
  };

  // Harness-owned timers (session events, timer-started ops) so the leak
  // check afterwards only sees timers the client under test left behind.
  const harnessTimers = new Set<ReturnType<typeof setTimeout>>();
  const schedule = (fn: () => void, atMs: number) => {
    const handle: ReturnType<typeof setTimeout> = setTimeout(() => {
      harnessTimers.delete(handle);
      fn();
    }, atMs);
    harnessTimers.add(handle);
  };

  // Session events on the fake clock.
  for (const event of scenario.events) {
    schedule(() => {
      const current = getApiSession();
      switch (event.kind) {
        case 'rotate':
          if (current) {
            rotatedAway.add(current.bearerToken);
            establishApiSession({ ...current, bearerToken: nextToken() });
          }
          break;
        case 'logout':
          if (current) rotatedAway.add(current.bearerToken);
          clearApiSession();
          break;
        case 'relogin_same':
          if (current) rotatedAway.add(current.bearerToken);
          establishApiSession(sessionFor(nextToken(), CANONICAL_ID));
          break;
        case 'relogin_other':
          if (current) rotatedAway.add(current.bearerToken);
          establishApiSession(sessionFor(nextToken(), OTHER_CANONICAL_ID));
          break;
        case 'skew':
          skewOffsetMs += event.skewMs;
          jest.setSystemTime(Date.now() + event.skewMs);
          break;
      }
    }, event.atMs);
  }
  // Timer-started ops.
  for (const op of scenario.ops) {
    if (op.start.mode === 'timer') {
      const atMs = op.start.atMs;
      schedule(() => launch(op), atMs);
    }
  }
  // The burst: every burst op is called in the same synchronous tick.
  for (const op of scenario.ops) {
    if (op.start.mode === 'burst') launch(op);
  }

  // Drive the fake clock timer by timer until every op has settled or the
  // bound is exhausted (deadlock detection).
  const allSettled = () =>
    scenario.ops.every(op => {
      const record = opRecords[op.index]!;
      if (record.settlement !== 'pending') return true;
      if (record.startedAtMs !== null) return false;
      // Never launched: a chained child whose parent never settled, or a
      // parent chain rooted at an op that never launched — both are covered
      // by the parent's own pending state.
      return op.start.mode === 'chained';
    });
  let timerSteps = 0;
  const bound = API_REQUEST_TIMEOUT_MS * 3 + 30_000;
  while (!allSettled() && timerSteps < MAX_TIMER_STEPS) {
    if (jest.getTimerCount() === 0) break;
    await jest.advanceTimersToNextTimerAsync();
    timerSteps += 1;
    if (virtualNow() > bound) break;
  }
  // Flush any trailing microtasks (listener reports run after json()).
  await jest.advanceTimersByTimeAsync(1);
  const virtualElapsedMs = virtualNow();

  // ── Judge ─────────────────────────────────────────────────────────────────
  for (const op of scenario.ops) {
    const record = opRecords[op.index]!;
    if (record.startedAtMs === null) {
      // Chained off an op that itself never launched — only legal when the
      // whole chain is rooted at a chained op (never happens: op 0 bursts).
      fail('bounded', op.index, 'op was never launched');
      continue;
    }
    if (record.settlement === 'pending') {
      fail(
        'bounded',
        op.index,
        `still pending after ${virtualElapsedMs} virtual ms (started ${record.startedAtMs}, plan ${JSON.stringify(op.plan)})`,
      );
      continue;
    }
    const elapsed = record.settledAtMs! - record.startedAtMs;
    if (elapsed > API_REQUEST_TIMEOUT_MS + 1) {
      fail(
        'bounded',
        op.index,
        `settled after ${elapsed} ms > ${API_REQUEST_TIMEOUT_MS} timeout`,
      );
    }

    const fetchRecord =
      record.fetchSeq === null ? null : fetches[record.fetchSeq]!;
    const isPermitOp = op.kind === 'reserve' || op.kind === 'release';

    if (!fetchRecord) {
      // Must be the signed-out short-circuit of the permit client.
      if (!isPermitOp) {
        fail('one_fetch', op.index, `${op.kind} settled without a fetch`);
      } else if (
        record.error?.type !== 'ApiError' ||
        record.error.status !== 401 ||
        record.error.code !== 'auth.required'
      ) {
        fail(
          'signed_out',
          op.index,
          `no fetch but settled ${record.settlement} ${JSON.stringify(record.error)} instead of ApiError 401 auth.required`,
        );
      }
      continue;
    }

    // timeout_typed
    if (fetchRecord.outcome === 'aborted') {
      if (op.plan.latencyMs <= API_REQUEST_TIMEOUT_MS) {
        fail(
          'timeout_typed',
          op.index,
          `aborted although latency ${op.plan.latencyMs} ≤ timeout`,
        );
      }
      if (
        record.error?.type !== 'ApiError' ||
        record.error.status !== 408 ||
        record.error.code !== 'network.timeout'
      ) {
        fail(
          'timeout_typed',
          op.index,
          `aborted request settled as ${JSON.stringify(record.error ?? record.resolvedSummary)}`,
        );
      }
      if (Math.abs(elapsed - API_REQUEST_TIMEOUT_MS) > 1) {
        fail(
          'timeout_typed',
          op.index,
          `timed out after ${elapsed} ms, expected ${API_REQUEST_TIMEOUT_MS}`,
        );
      }
      continue;
    }
    if (op.plan.latencyMs > API_REQUEST_TIMEOUT_MS) {
      fail(
        'timeout_typed',
        op.index,
        `latency ${op.plan.latencyMs} > timeout but fetch outcome ${fetchRecord.outcome}`,
      );
      continue;
    }
    if (record.error?.status === 408) {
      fail('timeout_typed', op.index, 'spurious 408 on an in-time response');
    }
    if (fetchRecord.outcome === 'lost') {
      if (
        record.settlement !== 'rejected' ||
        record.error?.type !== 'TypeError' ||
        record.error.message !== 'Network request failed'
      ) {
        fail(
          'timeout_typed',
          op.index,
          `lost request settled as ${record.settlement} ${JSON.stringify(record.error ?? record.resolvedSummary)}`,
        );
      }
      continue;
    }

    // Served. Non-2xx must be a typed ApiError carrying status + code.
    const status = fetchRecord.servedStatus!;
    const body = fetchRecord.servedBody;
    const unparsable = body === '<unparsable>';
    if (status < 200 || status >= 300) {
      const envelope = unparsable
        ? null
        : (body as { error?: { code: string; message: string } } | null);
      const expectedCode = envelope?.error?.code ?? 'unknown';
      const expectedMessage = envelope?.error?.message ?? `status-${status}`;
      if (
        record.settlement !== 'rejected' ||
        record.error?.type !== 'ApiError' ||
        record.error.status !== status ||
        record.error.code !== expectedCode ||
        record.error.message !== expectedMessage
      ) {
        fail(
          'error_typed',
          op.index,
          `HTTP ${status} settled as ${record.settlement} ${JSON.stringify(record.error ?? record.resolvedSummary)}; expected ApiError(${status}, ${expectedCode}, ${expectedMessage})`,
        );
      }
      continue;
    }

    // 2xx.
    const readable = !unparsable && body !== null && typeof body === 'object';
    switch (op.kind) {
      case 'reserve': {
        const permitBody = readable
          ? (body as { permit?: Record<string, unknown>; access?: unknown })
          : null;
        const permit = permitBody?.permit;
        const validPermit =
          permit !== undefined &&
          typeof permit['id'] === 'string' &&
          permit['id'].trim() !== '' &&
          (permit['accessSource'] === 'free' ||
            permit['accessSource'] === 'premium') &&
          typeof permit['expiresAt'] === 'string';
        if (!validPermit) {
          if (
            record.error?.type !== 'ApiError' ||
            record.error.status !== 502 ||
            record.error.code !== 'access.permit_invalid'
          ) {
            fail(
              readable ? 'permit_contract' : 'permit_contract_unreadable_2xx',
              op.index,
              `invalid permit body ${summarize(body)} settled as ${record.settlement} ${JSON.stringify(record.error ?? record.resolvedSummary)}; expected ApiError 502 access.permit_invalid`,
            );
          }
          break;
        }
        if (permit['status'] !== 'reserved') {
          if (
            record.error?.type !== 'ApiError' ||
            record.error.status !== 409 ||
            record.error.code !== 'access.permit_not_reserved'
          ) {
            fail(
              'permit_contract',
              op.index,
              `status ${String(permit['status'])} settled as ${record.settlement} ${JSON.stringify(record.error ?? record.resolvedSummary)}; expected ApiError 409`,
            );
          }
          break;
        }
        if (record.settlement !== 'resolved') {
          fail(
            'permit_contract',
            op.index,
            `valid permit rejected ${JSON.stringify(record.error)}`,
          );
          break;
        }
        const access = permitBody!.access as
          { premium?: unknown; freeRatings?: unknown } | undefined;
        const expectedAccess =
          access && typeof access.premium === 'boolean' && access.freeRatings
            ? access
            : null;
        const expected = {
          permit: {
            id: permit['id'],
            accessSource: permit['accessSource'],
            status: 'reserved',
            expiresAt: permit['expiresAt'],
          },
          access: expectedAccess,
        };
        if (!deepEqual(resolvedValues.get(op.index), expected)) {
          fail(
            'isolation',
            op.index,
            `resolved ${record.resolvedSummary} but its fetch #${fetchRecord.seq} served ${summarize(expected)}`,
          );
        }
        break;
      }
      case 'release':
      case 'createSession':
      case 'finalizeSession':
        if (
          record.settlement !== 'resolved' ||
          record.resolvedSummary !== 'undefined'
        ) {
          fail(
            'isolation',
            op.index,
            `void call settled ${record.settlement} ${JSON.stringify(record.error ?? record.resolvedSummary)}`,
          );
        }
        break;
      case 'syncShots':
      case 'uploadTrials': {
        const shaped =
          readable &&
          (op.kind === 'syncShots'
            ? Array.isArray((body as { acceptedIds?: unknown }).acceptedIds)
            : Array.isArray(
                (body as { acceptedTrialIds?: unknown }).acceptedTrialIds,
              ));
        if (shaped) {
          if (
            record.settlement !== 'resolved' ||
            !deepEqual(resolvedValues.get(op.index), body)
          ) {
            fail(
              'isolation',
              op.index,
              `resolved ${record.resolvedSummary} but its fetch #${fetchRecord.seq} served ${summarize(body)}`,
            );
          }
        } else if (record.settlement === 'resolved') {
          // Unreadable / wrong-shape 2xx handed to the caller as success.
          fail(
            'fake_success_2xx',
            op.index,
            `${op.kind} resolved ${record.resolvedSummary} for body ${summarize(body)}`,
          );
        }
        break;
      }
      case 'feedback': {
        const feedback = readable
          ? (body as { feedback?: { reviewEligible?: unknown } }).feedback
          : undefined;
        if (feedback && typeof feedback.reviewEligible === 'boolean') {
          if (
            record.settlement !== 'resolved' ||
            !deepEqual(resolvedValues.get(op.index), {
              reviewEligible: feedback.reviewEligible,
            })
          ) {
            fail(
              'isolation',
              op.index,
              `feedback resolved ${record.resolvedSummary}, served ${summarize(body)}`,
            );
          }
        } else if (record.settlement === 'resolved') {
          fail(
            'fake_success_2xx',
            op.index,
            `feedback resolved ${record.resolvedSummary} for body ${summarize(body)}`,
          );
        } else if (record.error?.type !== 'ApiError') {
          fail(
            'untyped_rejection_2xx',
            op.index,
            `feedback unreadable 2xx rejected with ${record.error?.type}: ${record.error?.message}`,
          );
        }
        break;
      }
    }
  }

  // unauthorized: listener fires exactly for 401s whose bearer is still
  // current at delivery, in delivery order.
  const expectedFires = fetches
    .filter(
      f =>
        f.outcome === 'served' &&
        f.servedStatus === 401 &&
        f.bearerSent !== null &&
        f.bearerSent === f.bearerCurrentAtDelivery,
    )
    .map(f => f.bearerSent!);
  const actualFires = listenerFires.map(f => f.token);
  if (!deepEqual(expectedFires, actualFires)) {
    fail(
      'unauthorized',
      null,
      `listener fired for ${JSON.stringify(actualFires)}, expected ${JSON.stringify(expectedFires)} (401s: ${JSON.stringify(
        fetches
          .filter(f => f.servedStatus === 401)
          .map(f => ({
            seq: f.seq,
            sent: f.bearerSent,
            currentAtDelivery: f.bearerCurrentAtDelivery,
          })),
      )})`,
    );
  }
  for (const fire of listenerFires) {
    if (rotatedAway.has(fire.token) && !expectedFires.includes(fire.token)) {
      fail(
        'unauthorized',
        null,
        `listener fired for stale bearer ${fire.token}`,
      );
    }
  }

  // one_fetch / no double spend: reserve fetches per key == reserve calls
  // that reached the network for that key, each carrying that key.
  for (const f of fetches) {
    if (f.opIndex === null) continue;
    const op = scenario.ops[f.opIndex]!;
    if (op.kind === 'reserve') {
      const sentKey = (
        f.requestBody as { idempotencyKey?: unknown } | undefined
      )?.idempotencyKey;
      if (sentKey !== op.key) {
        fail(
          'one_fetch',
          op.index,
          `reserve sent idempotencyKey ${String(sentKey)} instead of ${op.key}`,
        );
      }
    }
  }

  // no_leak: after every op settled, only the harness's own not-yet-due
  // session events may still be scheduled.
  for (const handle of harnessTimers) clearTimeout(handle);
  harnessTimers.clear();
  const liveTimers = jest.getTimerCount();
  if (liveTimers !== 0) {
    fail('no_leak', null, `${liveTimers} timers still live after settlement`);
  }
  if (unhandled.length > 0) {
    fail(
      'no_leak',
      null,
      `${unhandled.length} unhandled rejection(s): ${unhandled.map(r => (r instanceof Error ? r.message : String(r))).join('; ')}`,
    );
  }

  // Teardown.
  globalThis.fetch = previousFetch;
  process.off('unhandledRejection', onUnhandled);
  setApiUnauthorizedListener(null);
  clearApiSession();
  jest.useRealTimers();

  const keyCounts = new Map<string, number>();
  for (const op of scenario.ops)
    keyCounts.set(op.key, (keyCounts.get(op.key) ?? 0) + 1);

  return {
    seed,
    ok: failures.length === 0,
    failures,
    violationClasses,
    stats: {
      ops: scenario.ops.length,
      launched,
      fetches: fetches.length,
      fetchesWithoutBearer: fetches.filter(f => f.bearerSent === null).length,
      timeouts: fetches.filter(f => f.outcome === 'aborted').length,
      lost: fetches.filter(f => f.outcome === 'lost').length,
      served401: fetches.filter(f => f.servedStatus === 401).length,
      listenerFires: listenerFires.length,
      rotations: scenario.events.filter(e => e.kind === 'rotate').length,
      logouts: scenario.events.filter(e => e.kind === 'logout').length,
      relogins: scenario.events.filter(e => e.kind.startsWith('relogin'))
        .length,
      skews: scenario.events.filter(e => e.kind === 'skew').length,
      duplicatesKeys: [...keyCounts.values()].filter(n => n > 1).length,
      chained: scenario.ops.filter(o => o.start.mode === 'chained').length,
      abandoned: scenario.ops.filter(o => o.abandoned).length,
      timerSteps,
      virtualElapsedMs,
      realElapsedMs: REAL_NOW() - realStart,
    },
    permitConfig: scenario.permitConfig,
    ops: opRecords,
    fetches: fetches.map(f => ({
      ...f,
      servedBody: summarize(f.servedBody),
      requestBody: summarize(f.requestBody),
    })),
    events: scenario.events,
    replay: `STRESS_ONLY=${seed} npx jest --ci __tests__/stress/apiClientConcurrency.stress.test.ts`,
  };
}
