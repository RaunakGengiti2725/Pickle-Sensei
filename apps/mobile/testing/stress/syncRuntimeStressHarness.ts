/**
 * stress / mod-sync-runtime — concurrency lens.
 *
 * Drives the REAL `configureSyncRuntime` / `triggerOutboxSync` /
 * `clearSyncRuntime` → `drainOutbox` → `createTransport` → `fetch` chain
 * against an in-memory LocalDb (with single-connection SQLite transaction
 * semantics) and a fetch-level fake server whose responses are held until a
 * seeded scheduler releases them. Every scenario is a seeded plan of steps
 * (Promise.all bursts of triggers and app-state flaps, account sign-in /
 * sign-out / rotation while a request is in flight, timer advances past the
 * request timeout, clock skew, DB faults, per-response outcomes), so any
 * failing line is replayable from `STRESS_SEED=<seed>`.
 *
 * Scale: `STRESS_ITER` seeds per family (default 24, keeps the suite fast);
 * `STRESS_SEED` pins one seed; `STRESS_RUN_ID` names the evidence directory
 * `artifacts/stress/<run>/events.ndjson` (repo-root relative).
 *
 * Invariants are collected as violations (never thrown inside `fetch`, where
 * the drain would swallow them as a network error) and asserted per
 * iteration by the suites in `__tests__/stress/`.
 */
import { AppState } from 'react-native';
import type { LocalDb } from '../../src/data/db';
import type { SyncTransport } from '../../src/data/sync';
import {
  OUTBOX_MAX_ATTEMPTS,
  SESSION_NOT_FOUND_REJECTION,
} from '../../src/data/sync';
import {
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../../src/data/syncRuntime';
import {
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  createFakeLocalDb,
  type FakeLocalDb,
} from '../xcBehavioral/fakeLocalDb';
import { randomInt, seededRandom } from '../xcBehavioral/evidence';

// Node built-ins for the evidence sink (mobile tsconfig has no node typings;
// same shim convention as testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  hrtime(): [number, number];
  memoryUsage(): { heapUsed: number; rss: number };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export { randomInt, seededRandom };

// ─── Seeds / evidence ──────────────────────────────────────────────────────

export const STRESS_ITER_DEFAULT = 24;

export function stressIterations(): number {
  const raw = process.env['STRESS_ITER'];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : STRESS_ITER_DEFAULT;
}

/** One pinned seed in replay mode, else `STRESS_ITER` deterministic seeds
 * derived from the family name (FNV-1a) so equal scales cover equal inputs. */
export function stressSeeds(family: string): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  let hash = 2166136261;
  for (const ch of family) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  const seeds: number[] = [];
  for (let i = 0; i < stressIterations(); i += 1) {
    seeds.push((hash + i * 104729) >>> 0);
  }
  return seeds;
}

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export function stressEvidenceDir(): string {
  // apps/mobile/testing/stress → repo root
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(root, 'artifacts', 'stress', RUN_ID);
}

export function stressEvidenceFile(): string {
  return path.join(stressEvidenceDir(), 'events.ndjson');
}

export interface StressEvidence {
  suite: string;
  family: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: 'pass' | 'fail';
  wallMs: number;
  heapUsedMb: number;
  rssMb: number;
  atIso: string;
}

export function wallNowMs(): number {
  const [sec, nano] = process.hrtime();
  return sec * 1000 + nano / 1e6;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/** Runs one iteration, appends its NDJSON line pass or fail, re-throws.
 * `body` fills the `observed` sink before asserting so a failing line still
 * carries everything gathered up to the assertion. */
export async function recordStress(
  suite: string,
  family: string,
  seed: number,
  inputs: Record<string, unknown>,
  body: (observed: Record<string, unknown>) => Promise<void>,
): Promise<Record<string, unknown>> {
  const started = wallNowMs();
  const observed: Record<string, unknown> = {};
  let verdict: StressEvidence['verdict'] = 'pass';
  try {
    await body(observed);
    return observed;
  } catch (error) {
    verdict = 'fail';
    observed['error'] = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    const mem = process.memoryUsage();
    fs.mkdirSync(stressEvidenceDir(), { recursive: true });
    fs.appendFileSync(
      stressEvidenceFile(),
      `${JSON.stringify({
        suite,
        family,
        seed,
        inputs,
        observed,
        verdict,
        wallMs: Math.round((wallNowMs() - started) * 100) / 100,
        heapUsedMb: mb(mem.heapUsed),
        rssMb: mb(mem.rss),
        atIso: new Date().toISOString(),
      } satisfies StressEvidence)}\n`,
    );
  }
}

// ─── Actors ────────────────────────────────────────────────────────────────

export const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const USER_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const USERS = [USER_A, USER_B] as const;
export type User = (typeof USERS)[number];
export const OWNER_A = canonicalDataOwner(USER_A);
export const OWNER_B = canonicalDataOwner(USER_B);
export const API_BASE_URL = 'https://api.stress.test';

export function ownerOf(user: User): string {
  return user === USER_A ? OWNER_A : OWNER_B;
}

function userOfOwner(owner: string | null): User | null {
  if (owner === OWNER_A) return USER_A;
  if (owner === OWNER_B) return USER_B;
  return null;
}

export function shotPayload(id: string, sessionId: string | null) {
  return {
    id,
    sessionId,
    shotType: 'drive',
    stroke: 'drive',
    handedness: 'right',
    cameraView: 'side',
    createdAt: '2026-09-04T10:00:00.000Z',
    modelVersion: 'm1',
    pipelineVersion: 'p1',
    versionVector: { model: 'm1', pipeline: 'p1' },
    overallScore: 70,
    checkpoints: [],
    provenance: {
      appVersion: 't',
      modelVersion: 'm1',
      pipelineVersion: 'p1',
      captureMode: 'automatic_pose_trigger',
      captureRecordedAt: '2026-09-04T10:00:00.000Z',
      poseSource: 'apple_vision_body_pose',
    },
    analysisPermitId: `permit-${id}`,
  };
}

// ─── Fake server (fetch level) ─────────────────────────────────────────────

export type ServerOutcome =
  | 'accept'
  | 'reject_transient'
  | 'reject_permanent'
  | 'unacknowledged'
  | 'http_400'
  | 'http_401'
  | 'http_429'
  | 'http_500'
  | 'network_error';

/** Outcomes that consume a row's attempt budget when a drain processes them
 * (see sync.ts isPermanentSyncFailure / isTransientSyncRejection). */
export const PERMANENT_OUTCOMES: ReadonlySet<ServerOutcome> = new Set([
  'reject_permanent',
  'unacknowledged',
  'http_400',
]);

export interface RequestRecord {
  seq: number;
  step: number;
  runtimeId: number;
  path: string;
  bearer: string | null;
  /** Shot ids in a /v1/shots:sync body (empty for session routes). */
  shotIds: string[];
  /** Session id for /v1/sessions routes. */
  sessionId: string | null;
  /** Owner the rows belong to (from the enqueue ledger); null if mixed. */
  rowOwner: string | null;
  outcome: ServerOutcome | 'timeout' | 'pending';
  /** Whether the bearer sent was still the current session token when the
   * response was released (null until released, or when no bearer). */
  bearerCurrentAtResponse: boolean | null;
}

interface PendingCall {
  record: RequestRecord;
  settle: (outcome: ServerOutcome) => void;
}

export interface EnqueuedRow {
  rowId: number;
  owner: string;
  kind: 'shot.sync' | 'session.create';
  entityId: string;
  sessionId: string | null;
}

export interface Violation {
  invariant: string;
  detail: Record<string, unknown>;
}

export interface StressWorld {
  fake: FakeLocalDb;
  db: LocalDb;
  requests: RequestRecord[];
  pending: PendingCall[];
  violations: Violation[];
  enqueued: Map<string, EnqueuedRow>;
  /** Server ledger: ids the server has accepted (idempotent replay after). */
  acceptedIds: Set<string>;
  knownSessions: Set<string>;
  /** Per-entity-id server outcomes, in response order. */
  outcomesById: Map<string, ServerOutcome[]>;
  issuedTokens: Map<string, Set<string>>;
  tokenSeq: number;
  runtimeSeq: number;
  callerRuntimeId: number;
  /** Owner each runtime was configured for. */
  runtimeOwner: Map<number, string>;
  /** Runtime ids that have been superseded by clearSyncRuntime(). */
  clearedRuntimes: Set<number>;
  liveRuntimeId: number | null;
  liveUser: User | null;
  drainStarts: number;
  appStateHandlers: Array<(state: string) => void>;
  listenerAdds: number;
  listenerRemovals: number;
  /** (bearer the API reported, bearer current at that moment). */
  unauthorizedEvents: Array<{ reported: string; current: string | null }>;
  stats: {
    maxInFlight: number;
    maxInFlightSameOwner: number;
    nestedBeginAttempts: number;
    txErrors: number;
    duplicateSends: number;
    faultsInjected: number;
    timeouts: number;
    maxTimers: number;
    maxTxDepth: number;
  };
  step: number;
  nextEntity: number;
}

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

function parseBody(init: FetchInit): Record<string, unknown> {
  if (!init || typeof init.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function headerValue(init: FetchInit, name: string): string | null {
  const headers = init?.headers;
  if (!headers || typeof headers !== 'object') return null;
  const value = (headers as Record<string, string | undefined>)[name];
  return typeof value === 'string' ? value : null;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status-${status}`,
    json: async () => body,
  } as unknown as Response;
}

export interface StressMocks {
  getDb: jest.Mock;
  createTransport: jest.Mock;
  actualCreateTransport: (config: {
    baseUrl: string;
    token: string | null;
  }) => SyncTransport;
}

/**
 * Builds the world and installs it: the mocked `getDb` returns a LocalDb
 * with SQLite single-connection transaction semantics over the fake, the
 * mocked `createTransport` tags each runtime's transport so `fetch` knows
 * which runtime generation issued a request, `fetch` is the fake server, and
 * AppState subscriptions are captured. Callers must run `teardownWorld` in
 * afterEach (and `jest.restoreAllMocks()`).
 */
export function createStressWorld(mocks: StressMocks): StressWorld {
  const fake = createFakeLocalDb();
  const world: StressWorld = {
    fake,
    db: fake.db,
    requests: [],
    pending: [],
    violations: [],
    enqueued: new Map(),
    acceptedIds: new Set(),
    knownSessions: new Set(),
    outcomesById: new Map(),
    issuedTokens: new Map(),
    tokenSeq: 0,
    runtimeSeq: 0,
    callerRuntimeId: 0,
    runtimeOwner: new Map(),
    clearedRuntimes: new Set(),
    liveRuntimeId: null,
    liveUser: null,
    drainStarts: 0,
    appStateHandlers: [],
    listenerAdds: 0,
    listenerRemovals: 0,
    unauthorizedEvents: [],
    stats: {
      maxInFlight: 0,
      maxInFlightSameOwner: 0,
      nestedBeginAttempts: 0,
      txErrors: 0,
      duplicateSends: 0,
      faultsInjected: 0,
      timeouts: 0,
      maxTimers: 0,
      maxTxDepth: 0,
    },
    step: 0,
    nextEntity: 0,
  };

  // Single SQLite connection: a BEGIN inside an open transaction and a
  // COMMIT/ROLLBACK outside one are errors, exactly as SQLite reports them
  // when two concurrent drains interleave their statements.
  world.db = {
    async execute(sql, params = []) {
      if (sql === 'BEGIN IMMEDIATE' && fake.openTransactions() > 0) {
        world.stats.nestedBeginAttempts += 1;
        world.stats.txErrors += 1;
        world.stats.maxTxDepth = Math.max(world.stats.maxTxDepth, 2);
        fake.statements.push({ sql: `${sql} -- REJECTED nested`, params });
        throw new Error('cannot start a transaction within a transaction');
      }
      if (
        (sql === 'COMMIT' || sql === 'ROLLBACK') &&
        fake.openTransactions() === 0
      ) {
        world.stats.txErrors += 1;
        fake.statements.push({ sql: `${sql} -- REJECTED no tx`, params });
        throw new Error(
          `cannot ${sql.toLowerCase()} - no transaction is active`,
        );
      }
      const result = await fake.db.execute(sql, params);
      world.stats.maxTxDepth = Math.max(
        world.stats.maxTxDepth,
        fake.openTransactions(),
      );
      return result;
    },
    close() {},
  };
  // `getDb()` is called exactly once per drain start (trigger → drainOutbox).
  mocks.getDb.mockImplementation(() => {
    world.drainStarts += 1;
    if (world.liveRuntimeId === null) {
      violate(world, 'drain_starts_only_for_live_runtime', {
        step: world.step,
        drainStarts: world.drainStarts,
      });
    } else if (
      world.pending.some(p => p.record.runtimeId === world.liveRuntimeId)
    ) {
      violate(world, 'no_overlapping_drain_per_runtime', {
        step: world.step,
        runtimeId: world.liveRuntimeId,
        at: 'drain_start',
      });
    }
    return world.db;
  });

  mocks.createTransport.mockImplementation(
    (config: { baseUrl: string; token: string | null }) => {
      world.runtimeSeq += 1;
      const runtimeId = world.runtimeSeq;
      world.liveRuntimeId = runtimeId;
      world.runtimeOwner.set(runtimeId, getActiveDataOwner());
      const actual = mocks.actualCreateTransport(config);
      const tagged: SyncTransport = {
        syncShots: shots => {
          world.callerRuntimeId = runtimeId;
          return actual.syncShots(shots);
        },
        createSession: session => {
          world.callerRuntimeId = runtimeId;
          return actual.createSession(session);
        },
        finalizeSession: id => {
          world.callerRuntimeId = runtimeId;
          return actual.finalizeSession(id);
        },
      };
      return tagged;
    },
  );

  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      world.listenerAdds += 1;
      const fn = handler as (state: string) => void;
      world.appStateHandlers.push(fn);
      return {
        remove: () => {
          world.listenerRemovals += 1;
          const idx = world.appStateHandlers.indexOf(fn);
          if (idx >= 0) world.appStateHandlers.splice(idx, 1);
        },
      } as ReturnType<typeof AppState.addEventListener>;
    });

  setApiUnauthorizedListener(session => {
    world.unauthorizedEvents.push({
      reported: session.bearerToken,
      current: getApiSession()?.bearerToken ?? null,
    });
  });

  globalThis.fetch = ((input: FetchInput, init?: FetchInit) =>
    fakeFetch(world, String(input), init)) as typeof fetch;

  return world;
}

export function teardownWorld(
  world: StressWorld,
  originalFetch: typeof fetch,
): void {
  for (const call of [...world.pending]) call.settle('network_error');
  clearSyncRuntime();
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  setApiUnauthorizedListener(null);
  globalThis.fetch = originalFetch;
}

function violate(
  world: StressWorld,
  invariant: string,
  detail: Record<string, unknown>,
): void {
  world.violations.push({ invariant, detail });
}

function fakeFetch(
  world: StressWorld,
  url: string,
  init: FetchInit,
): Promise<Response> {
  const pathname = url.startsWith(API_BASE_URL)
    ? url.slice(API_BASE_URL.length)
    : url;
  const authorization = headerValue(init, 'authorization');
  const bearer = authorization?.startsWith('Bearer ')
    ? authorization.slice('Bearer '.length)
    : null;
  const body = parseBody(init);
  const shots = Array.isArray(body['shots'])
    ? (body['shots'] as Array<{ id: string; sessionId: string | null }>)
    : [];
  const shotIds = shots.map(shot => shot.id);
  const sessionId =
    pathname === '/v1/sessions' && typeof body['id'] === 'string'
      ? body['id']
      : null;
  const entityIds = sessionId ? [sessionId] : shotIds;
  const owners = new Set(
    entityIds.map(id => world.enqueued.get(id)?.owner ?? '<unknown>'),
  );
  const rowOwner = owners.size === 1 ? [...owners][0]! : null;
  const record: RequestRecord = {
    seq: world.requests.length + 1,
    step: world.step,
    runtimeId: world.callerRuntimeId,
    path: pathname,
    bearer,
    shotIds,
    sessionId,
    rowOwner,
    outcome: 'pending',
    bearerCurrentAtResponse: null,
  };
  world.requests.push(record);

  // ── request-time invariants ──
  if (owners.size > 1) {
    violate(world, 'batch_single_owner', {
      seq: record.seq,
      owners: [...owners],
    });
  }
  if (owners.has('<unknown>')) {
    violate(world, 'batch_known_rows', { seq: record.seq, entityIds });
  }
  const runtimeOwner = world.runtimeOwner.get(record.runtimeId) ?? null;
  if (rowOwner !== null && runtimeOwner !== rowOwner) {
    violate(world, 'rows_belong_to_runtime_owner', {
      seq: record.seq,
      runtimeId: record.runtimeId,
      runtimeOwner,
      rowOwner,
    });
  }
  if (
    record.runtimeId === world.liveRuntimeId &&
    rowOwner !== null &&
    getActiveDataOwner() !== rowOwner
  ) {
    violate(world, 'live_runtime_drains_active_owner_only', {
      seq: record.seq,
      active: getActiveDataOwner(),
      rowOwner,
    });
  }
  const session = getApiSession();
  const rowUser = userOfOwner(rowOwner);
  if (bearer !== null) {
    const issuedTo = rowUser ? world.issuedTokens.get(rowUser) : undefined;
    if (!rowUser || !issuedTo?.has(bearer)) {
      violate(world, 'bearer_issued_to_row_owner', {
        seq: record.seq,
        bearer,
        rowOwner,
      });
    }
    if (!session || session.bearerToken !== bearer) {
      violate(world, 'bearer_is_current_session_token', {
        seq: record.seq,
        bearer,
        current: session?.bearerToken ?? null,
      });
    }
    if (session && rowUser && session.canonicalAppUserId !== rowUser) {
      violate(world, 'bearer_user_matches_row_owner', {
        seq: record.seq,
        sessionUser: session.canonicalAppUserId,
        rowUser,
      });
    }
  } else if (session && rowUser && session.canonicalAppUserId === rowUser) {
    violate(world, 'bearer_present_when_owner_signed_in', { seq: record.seq });
  }
  for (const id of shotIds) {
    const row = world.enqueued.get(id);
    if (!row) continue;
    const durable = world.fake.outbox.find(r => r.id === row.rowId);
    if (durable && durable.attempts >= OUTBOX_MAX_ATTEMPTS) {
      violate(world, 'exhausted_rows_never_sent', {
        seq: record.seq,
        id,
        attempts: durable.attempts,
      });
    }
  }
  const sameRuntime = world.pending.filter(
    p => p.record.runtimeId === record.runtimeId,
  );
  if (sameRuntime.length > 0) {
    violate(world, 'no_overlapping_drain_per_runtime', {
      seq: record.seq,
      runtimeId: record.runtimeId,
      overlaps: sameRuntime.map(p => p.record.seq),
      at: 'request',
    });
  }
  const pendingShotIds = new Set(world.pending.flatMap(p => p.record.shotIds));
  world.stats.duplicateSends += shotIds.filter(id =>
    pendingShotIds.has(id),
  ).length;
  if (rowOwner !== null) {
    world.stats.maxInFlightSameOwner = Math.max(
      world.stats.maxInFlightSameOwner,
      world.pending.filter(p => p.record.rowOwner === rowOwner).length + 1,
    );
  }
  world.stats.maxInFlight = Math.max(
    world.stats.maxInFlight,
    world.pending.length + 1,
  );

  return new Promise<Response>((resolve, reject) => {
    let done = false;
    const remove = () => {
      const idx = world.pending.findIndex(p => p.record === record);
      if (idx >= 0) world.pending.splice(idx, 1);
    };
    const signal = init?.signal ?? null;
    const onAbort = () => {
      if (done) return;
      done = true;
      remove();
      record.outcome = 'timeout';
      world.stats.timeouts += 1;
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    };
    signal?.addEventListener('abort', onAbort);
    const settle = (outcome: ServerOutcome) => {
      if (done) return;
      done = true;
      signal?.removeEventListener('abort', onAbort);
      remove();
      record.outcome = outcome;
      record.bearerCurrentAtResponse =
        bearer === null ? null : getApiSession()?.bearerToken === bearer;
      for (const id of entityIds) {
        const list = world.outcomesById.get(id) ?? [];
        list.push(outcome);
        world.outcomesById.set(id, list);
      }
      switch (outcome) {
        case 'network_error':
          reject(new TypeError('Network request failed'));
          return;
        case 'http_400':
          resolve(
            jsonResponse(400, {
              error: { code: 'shot.invalid', message: 'bad request' },
            }),
          );
          return;
        case 'http_401':
          resolve(
            jsonResponse(401, {
              error: { code: 'auth.required', message: 'unauthorized' },
            }),
          );
          return;
        case 'http_429':
          resolve(
            jsonResponse(429, {
              error: { code: 'rate_limited', message: 'slow down' },
            }),
          );
          return;
        case 'http_500':
          resolve(
            jsonResponse(500, {
              error: { code: 'internal', message: 'server error' },
            }),
          );
          return;
        default:
          break;
      }
      if (sessionId !== null) {
        if (outcome === 'accept') {
          world.knownSessions.add(sessionId);
          resolve(jsonResponse(200, { ok: true }));
        } else if (outcome === 'reject_transient') {
          resolve(
            jsonResponse(503, {
              error: { code: 'session.write_failed', message: 'retry' },
            }),
          );
        } else {
          resolve(
            jsonResponse(422, {
              error: { code: 'session.invalid', message: 'refused' },
            }),
          );
        }
        return;
      }
      if (pathname.endsWith('/finalize')) {
        resolve(jsonResponse(200, { ok: true }));
        return;
      }
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots) {
        if (outcome === 'unacknowledged') continue;
        if (outcome === 'reject_transient') {
          rejected.push({
            id: shot.id,
            code: 'shot.write_failed',
            message: 'transient',
          });
          continue;
        }
        if (outcome === 'reject_permanent') {
          rejected.push({
            id: shot.id,
            code: 'access.permit_expired',
            message: 'permanent',
          });
          continue;
        }
        // accept: idempotent replay for ids already owned; a shot whose
        // session the server never saw is a transient session_not_found.
        if (
          shot.sessionId &&
          !world.knownSessions.has(shot.sessionId) &&
          !world.acceptedIds.has(shot.id)
        ) {
          rejected.push({
            id: shot.id,
            code: SESSION_NOT_FOUND_REJECTION,
            message: 'unknown session',
          });
          continue;
        }
        world.acceptedIds.add(shot.id);
        acceptedIds.push(shot.id);
      }
      resolve(jsonResponse(200, { acceptedIds, rejected }));
    };
    world.pending.push({ record, settle });
  });
}

// ─── Actions (what the app / OS / server can do) ───────────────────────────

export function sessionFor(world: StressWorld, user: User): ApiSession {
  world.tokenSeq += 1;
  const token = `bearer-${user.slice(0, 1)}-${world.tokenSeq}`;
  const issued = world.issuedTokens.get(user) ?? new Set<string>();
  issued.add(token);
  world.issuedTokens.set(user, issued);
  return {
    apiBaseUrl: API_BASE_URL,
    bearerToken: token,
    canonicalAppUserId: user,
    provider: 'apple',
  };
}

/** authStore.clearSyncedRuntime + installApiSession for `user`. */
export function signIn(world: StressWorld, user: User): void {
  clearRuntime(world);
  clearApiSession();
  setActiveDataOwner(ownerOf(user));
  const session = sessionFor(world, user);
  establishApiSession(session);
  configureSyncRuntime(session);
  world.liveUser = user;
}

/** authStore.signOut(): runtime, bearer store and owner all go. */
export function signOut(world: StressWorld): void {
  clearRuntime(world);
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
}

/** clearSyncRuntime() alone (the first half of hydrate / re-sign-in). */
export function clearRuntime(world: StressWorld): void {
  if (world.liveRuntimeId !== null) {
    world.clearedRuntimes.add(world.liveRuntimeId);
  }
  world.liveRuntimeId = null;
  world.liveUser = null;
  clearSyncRuntime();
}

/** sessionKeeper rotation: same user, new access token, no reconfigure. */
export function rotateBearer(world: StressWorld): boolean {
  const current = getApiSession();
  if (!current) return false;
  const user = current.canonicalAppUserId === USER_A ? USER_A : USER_B;
  establishApiSession({ ...sessionFor(world, user), refreshToken: 'r' });
  return true;
}

export function appState(world: StressWorld, state: string): void {
  for (const handler of [...world.appStateHandlers]) handler(state);
}

export function trigger(): void {
  triggerOutboxSync();
}

export function enqueueShot(
  world: StressWorld,
  user: User,
  sessionId: string | null,
): string {
  world.nextEntity += 1;
  const id = `shot-${user.slice(0, 1)}-${world.nextEntity}`;
  const rowId = world.fake.push(
    'shot.sync',
    shotPayload(id, sessionId),
    ownerOf(user),
  );
  world.enqueued.set(id, {
    rowId,
    owner: ownerOf(user),
    kind: 'shot.sync',
    entityId: id,
    sessionId,
  });
  return id;
}

export function enqueueSession(world: StressWorld, user: User): string {
  world.nextEntity += 1;
  const id = `session-${user.slice(0, 1)}-${world.nextEntity}`;
  const rowId = world.fake.push(
    'session.create',
    { id, mode: 'practice_set', startedAt: '2026-09-04T10:00:00.000Z' },
    ownerOf(user),
  );
  world.enqueued.set(id, {
    rowId,
    owner: ownerOf(user),
    kind: 'session.create',
    entityId: id,
    sessionId: null,
  });
  return id;
}

/** Drains the microtask queue (setImmediate stays real under fake timers). */
export async function flush(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** Advance fake time in slices so timer-driven drains get their microtasks. */
export async function advance(world: StressWorld, ms: number): Promise<void> {
  let left = ms;
  while (left > 0) {
    const slice = Math.min(left, 5_000);
    jest.advanceTimersByTime(slice);
    left -= slice;
    await flush(2);
    world.stats.maxTimers = Math.max(
      world.stats.maxTimers,
      jest.getTimerCount(),
    );
  }
  await flush(2);
}

/** Advance fake time in 1s slices until a request goes out (or `maxMs`),
 * so a server that answers promptly is modelled instead of a 20s timeout. */
export async function advanceUntilRequest(
  world: StressWorld,
  maxMs: number,
): Promise<number> {
  let elapsed = 0;
  while (elapsed < maxMs && world.pending.length === 0) {
    jest.advanceTimersByTime(1_000);
    elapsed += 1_000;
    await flush(2);
  }
  return elapsed;
}

export function release(
  world: StressWorld,
  index: number,
  outcome: ServerOutcome,
): boolean {
  const call = world.pending[index];
  if (!call) return false;
  call.settle(outcome);
  return true;
}

export function releaseAll(world: StressWorld, outcome: ServerOutcome): number {
  const calls = [...world.pending];
  for (const call of calls) call.settle(outcome);
  return calls.length;
}

export const DB_FAULT_NEEDLES = [
  'INSERT OR REPLACE INTO sync_receipt',
  'DELETE FROM outbox',
  'COMMIT',
  'SELECT id, kind, payload',
] as const;
export type DbFaultNeedle = (typeof DB_FAULT_NEEDLES)[number];

export function injectDbFault(world: StressWorld, needle: DbFaultNeedle): void {
  world.stats.faultsInjected += 1;
  world.fake.failNext(needle);
}

// ─── Plans ─────────────────────────────────────────────────────────────────

export type BurstAction = 'trigger' | 'active' | 'flap' | 'rotate';
export type AppStateName = 'active' | 'background' | 'inactive';

export type Step =
  | { op: 'enqueue'; user: User; withSession: boolean }
  | { op: 'enqueueSession'; user: User }
  | { op: 'signIn'; user: User }
  | { op: 'signOut' }
  | { op: 'clearRuntime' }
  | { op: 'rotate' }
  | { op: 'trigger' }
  | { op: 'appState'; state: AppStateName }
  | { op: 'burst'; mix: BurstAction[]; scatter: boolean }
  | { op: 'release'; index: number; outcome: ServerOutcome }
  | { op: 'releaseAll'; outcome: ServerOutcome }
  | { op: 'advance'; ms: number }
  | { op: 'skew'; deltaMs: number }
  | { op: 'dbFault'; needle: DbFaultNeedle }
  | { op: 'flush' };

export type StepOp = Step['op'];

export const DEFAULT_WEIGHTS: Record<StepOp, number> = {
  enqueue: 12,
  enqueueSession: 3,
  signIn: 3,
  signOut: 2,
  clearRuntime: 2,
  rotate: 3,
  trigger: 8,
  appState: 8,
  burst: 8,
  release: 14,
  releaseAll: 4,
  advance: 8,
  skew: 2,
  dbFault: 2,
  flush: 5,
};

const OUTCOME_WEIGHTS: Array<[ServerOutcome, number]> = [
  ['accept', 10],
  ['reject_transient', 3],
  ['reject_permanent', 3],
  ['unacknowledged', 1],
  ['http_400', 2],
  ['http_401', 2],
  ['http_429', 2],
  ['http_500', 2],
  ['network_error', 3],
];

export function pickWeighted<T>(
  random: () => number,
  entries: ReadonlyArray<readonly [T, number]>,
): T {
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [value, weight] of entries) {
    roll -= weight;
    if (roll < 0) return value;
  }
  return entries[entries.length - 1]![0];
}

export function pickOutcome(random: () => number): ServerOutcome {
  return pickWeighted(random, OUTCOME_WEIGHTS);
}

export interface PlanOptions {
  steps: readonly [number, number];
  weights?: Partial<Record<StepOp, number>>;
  users?: readonly User[];
}

/**
 * The runtime's only randomness is the retry jitter (`nextSyncRetryDelayMs`
 * defaults `random` to Math.random). Pin it to a seeded stream so the
 * timer-driven interleavings replay bit-for-bit from the seed. Restored by
 * `jest.restoreAllMocks()` in the suite's afterEach.
 */
export function seedRuntimeJitter(seed: number): void {
  const jitter = seededRandom(seed ^ 0x5bd1e995);
  jest.spyOn(Math, 'random').mockImplementation(jitter);
}

export function buildPlan(
  seed: number,
  options: PlanOptions,
): { plan: Step[]; random: () => number } {
  seedRuntimeJitter(seed);
  const random = seededRandom(seed);
  const weights: Record<StepOp, number> = {
    ...DEFAULT_WEIGHTS,
    ...options.weights,
  };
  const users = options.users ?? USERS;
  const entries = (Object.keys(weights) as StepOp[])
    .filter(op => weights[op] > 0)
    .map(op => [op, weights[op]] as const);
  const length = randomInt(random, options.steps[0], options.steps[1]);
  const plan: Step[] = [];
  const pickUser = (): User => users[randomInt(random, 0, users.length - 1)]!;
  for (let i = 0; i < length; i += 1) {
    const op = pickWeighted(random, entries);
    switch (op) {
      case 'enqueue':
        plan.push({ op, user: pickUser(), withSession: random() < 0.25 });
        break;
      case 'enqueueSession':
        plan.push({ op, user: pickUser() });
        break;
      case 'signIn':
        plan.push({ op, user: pickUser() });
        break;
      case 'appState':
        plan.push({
          op,
          state: (['active', 'background', 'inactive'] as const)[
            randomInt(random, 0, 2)
          ]!,
        });
        break;
      case 'burst': {
        const size = randomInt(random, 2, 24);
        const mix = Array.from({ length: size }, () =>
          pickWeighted<BurstAction>(random, [
            ['trigger', 5],
            ['active', 4],
            ['flap', 3],
            ['rotate', 1],
          ]),
        );
        plan.push({ op, mix, scatter: random() < 0.5 });
        break;
      }
      case 'release':
        plan.push({
          op,
          index: randomInt(random, 0, 3),
          outcome: pickOutcome(random),
        });
        break;
      case 'releaseAll':
        plan.push({ op, outcome: pickOutcome(random) });
        break;
      case 'advance': {
        const band = randomInt(random, 0, 7);
        const ms =
          band < 3
            ? randomInt(random, 0, 1_000)
            : band < 6
              ? randomInt(random, 1_000, 25_000)
              : randomInt(random, 25_000, SYNC_RETRY_MAX_MS + 60_000);
        plan.push({ op, ms });
        break;
      }
      case 'skew':
        plan.push({
          op,
          deltaMs:
            (random() < 0.5 ? -1 : 1) *
            randomInt(random, 1_000, 36 * 3_600_000),
        });
        break;
      case 'dbFault':
        plan.push({
          op,
          needle:
            DB_FAULT_NEEDLES[
              randomInt(random, 0, DB_FAULT_NEEDLES.length - 1)
            ]!,
        });
        break;
      case 'signOut':
      case 'clearRuntime':
      case 'rotate':
      case 'trigger':
      case 'flush':
        plan.push({ op });
        break;
    }
  }
  return { plan, random };
}

function afterMicrotasks(n: number): Promise<void> {
  let p: Promise<void> = Promise.resolve();
  for (let k = 0; k < n; k += 1) p = p.then(() => undefined);
  return p;
}

/** Executes one step; returns after the microtask queue is drained so the
 * next step observes a stable world. */
export async function runStep(world: StressWorld, step: Step): Promise<void> {
  world.step += 1;
  switch (step.op) {
    case 'enqueue': {
      let sessionId: string | null = null;
      if (step.withSession) {
        // Reference the newest session row of this user when one exists,
        // else an id the server has never seen (orphan → session_not_found).
        const sessions = [...world.enqueued.values()].filter(
          r => r.kind === 'session.create' && r.owner === ownerOf(step.user),
        );
        sessionId = sessions.length
          ? sessions[sessions.length - 1]!.entityId
          : `orphan-${step.user.slice(0, 1)}`;
      }
      enqueueShot(world, step.user, sessionId);
      trigger();
      break;
    }
    case 'enqueueSession':
      enqueueSession(world, step.user);
      trigger();
      break;
    case 'signIn':
      signIn(world, step.user);
      break;
    case 'signOut':
      signOut(world);
      break;
    case 'clearRuntime':
      clearRuntime(world);
      break;
    case 'rotate':
      rotateBearer(world);
      break;
    case 'trigger':
      trigger();
      break;
    case 'appState':
      appState(world, step.state);
      break;
    case 'burst': {
      const actions = step.mix.map(kind => () => {
        if (kind === 'trigger') trigger();
        else if (kind === 'active') appState(world, 'active');
        else if (kind === 'rotate') rotateBearer(world);
        else {
          appState(world, 'background');
          appState(world, 'active');
        }
      });
      // Promise.all burst: either every action in the same tick, or spread
      // over the first few microtask turns so they land between the drain's
      // own awaits.
      await Promise.all(
        actions.map((fn, i) =>
          step.scatter
            ? afterMicrotasks(i % 4).then(fn)
            : Promise.resolve(fn()),
        ),
      );
      break;
    }
    case 'release':
      release(
        world,
        step.index % Math.max(1, world.pending.length),
        step.outcome,
      );
      break;
    case 'releaseAll':
      releaseAll(world, step.outcome);
      break;
    case 'advance':
      await advance(world, step.ms);
      break;
    case 'skew':
      jest.setSystemTime(Date.now() + step.deltaMs);
      break;
    case 'dbFault':
      injectDbFault(world, step.needle);
      break;
    case 'flush':
      break;
  }
  await flush(3);
  world.stats.maxTimers = Math.max(world.stats.maxTimers, jest.getTimerCount());
  // Timers alive: at most one retry timer plus one request timeout per
  // in-flight request.
  if (jest.getTimerCount() > 1 + world.pending.length) {
    violate(world, 'timers_bounded_by_retry_plus_inflight', {
      step: world.step,
      timers: jest.getTimerCount(),
      pending: world.pending.length,
    });
  }
}

// ─── Quiescence + end-of-iteration invariants ──────────────────────────────

export interface Settlement {
  rounds: number;
  requestsDuringSettle: number;
  /** Per round: fake ms advanced, requests so far, pending, timers. */
  trace: string[];
}

/**
 * Brings the world to rest with a healthy, prompt server: every held
 * response is accepted, USER_A is signed in with a live runtime, and retry
 * timers are advanced (stopping as soon as a request goes out, which is then
 * accepted) until two consecutive full-backoff windows produce no request.
 * Bounded by `maxRounds`; the caller asserts on what remains.
 */
export async function settle(
  world: StressWorld,
  maxRounds = 96,
): Promise<Settlement> {
  const before = world.requests.length;
  releaseAll(world, 'accept');
  await flush(8);
  if (world.liveUser !== USER_A || getActiveDataOwner() !== OWNER_A) {
    signIn(world, USER_A);
    await flush(8);
  }
  let rounds = 0;
  let idle = 0;
  const trace: string[] = [];
  while (rounds < maxRounds && idle < 2) {
    rounds += 1;
    const seenRequests = world.requests.length;
    const seenDrains = world.drainStarts;
    let advanced = 0;
    if (world.pending.length === 0) {
      advanced = await advanceUntilRequest(world, SYNC_RETRY_MAX_MS * 1.25);
    }
    const released = releaseAll(world, 'accept');
    if (released > 0) await flush(8);
    // A round is idle only when nothing happened at all: a drain that ran
    // and failed (e.g. on an injected DB fault) is progress, not rest.
    const quiet =
      world.requests.length === seenRequests &&
      world.drainStarts === seenDrains;
    idle = quiet ? idle + 1 : 0;
    trace.push(
      `r${rounds} +${advanced}ms released=${released} requests=${world.requests.length} drains=${world.drainStarts} timers=${jest.getTimerCount()} rows=${world.fake.outbox.length}`,
    );
  }
  releaseAll(world, 'accept');
  await flush(8);
  return {
    rounds,
    requestsDuringSettle: world.requests.length - before,
    trace,
  };
}

export interface EndState {
  outboxRows: number;
  outboxByOwner: Record<string, number>;
  exhaustedRows: number;
  orphanRows: number;
  receipts: number;
  duplicateReceiptWrites: number;
  lostIds: string[];
  receiptWithoutAccept: string[];
  receiptOwnerMismatch: string[];
  receiptAndRowBoth: string[];
  attemptsOverBudget: string[];
  attemptsOverServerPermanent: string[];
  attemptsUnderServerPermanent: string[];
  unexpectedRemaining: string[];
  timers: number;
  openTransactions: number;
  listenersLive: number;
}

/** Computes the durable end state and the invariants over it. */
export function inspectEnd(world: StressWorld): EndState {
  const fake = world.fake;
  const receiptsByKey = new Map<string, number>();
  for (const r of fake.receipts) {
    const key = `${r.owner}|${r.entityId}`;
    receiptsByKey.set(key, (receiptsByKey.get(key) ?? 0) + 1);
  }
  const duplicateReceiptWrites = [...receiptsByKey.values()].reduce(
    (sum, n) => sum + (n - 1),
    0,
  );
  const lostIds: string[] = [];
  const receiptAndRowBoth: string[] = [];
  const receiptWithoutAccept: string[] = [];
  const receiptOwnerMismatch: string[] = [];
  const attemptsOverBudget: string[] = [];
  const attemptsOverServerPermanent: string[] = [];
  const attemptsUnderServerPermanent: string[] = [];
  const unexpectedRemaining: string[] = [];
  const outboxByOwner: Record<string, number> = {};
  let exhaustedRows = 0;
  let orphanRows = 0;
  for (const row of fake.outbox) {
    outboxByOwner[row.owner_key] = (outboxByOwner[row.owner_key] ?? 0) + 1;
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) exhaustedRows += 1;
    if (row.attempts > OUTBOX_MAX_ATTEMPTS) {
      attemptsOverBudget.push(String(row.id));
    }
  }
  for (const r of fake.receipts) {
    if (!world.acceptedIds.has(r.entityId)) {
      receiptWithoutAccept.push(r.entityId);
    }
    const row = world.enqueued.get(r.entityId);
    if (row && row.owner !== r.owner) receiptOwnerMismatch.push(r.entityId);
  }
  for (const [id, row] of world.enqueued) {
    const durable = fake.outbox.find(r => r.id === row.rowId);
    const receipted = fake.receipts.some(
      r => r.entityId === id && r.owner === row.owner,
    );
    if (row.kind === 'shot.sync') {
      if (!durable && !receipted) lostIds.push(id);
      if (durable && receipted) receiptAndRowBoth.push(id);
    } else if (!durable && !world.knownSessions.has(id)) {
      lostIds.push(id);
    }
    if (durable) {
      const permanent = (world.outcomesById.get(id) ?? []).filter(o =>
        PERMANENT_OUTCOMES.has(o),
      ).length;
      if (durable.attempts > permanent) attemptsOverServerPermanent.push(id);
      if (durable.attempts < permanent) attemptsUnderServerPermanent.push(id);
      const orphan =
        row.kind === 'shot.sync' &&
        row.sessionId !== null &&
        !world.knownSessions.has(row.sessionId);
      if (orphan && durable.attempts < OUTBOX_MAX_ATTEMPTS) orphanRows += 1;
      if (
        row.owner === OWNER_A &&
        durable.attempts < OUTBOX_MAX_ATTEMPTS &&
        !orphan
      ) {
        unexpectedRemaining.push(id);
      }
    }
  }
  return {
    outboxRows: fake.outbox.length,
    outboxByOwner,
    exhaustedRows,
    orphanRows,
    receipts: fake.receipts.length,
    duplicateReceiptWrites,
    lostIds,
    receiptWithoutAccept,
    receiptOwnerMismatch,
    receiptAndRowBoth,
    attemptsOverBudget,
    attemptsOverServerPermanent,
    attemptsUnderServerPermanent,
    unexpectedRemaining,
    timers: jest.getTimerCount(),
    openTransactions: fake.openTransactions(),
    listenersLive: world.listenerAdds - world.listenerRemovals,
  };
}

export function statementTrace(world: StressWorld, limit = 400): string[] {
  return world.fake.statements
    .slice(-limit)
    .map(
      s =>
        `${s.sql.replace(/\s+/g, ' ').trim().slice(0, 80)} ${JSON.stringify(
          s.params,
        ).slice(0, 60)}`,
    );
}

export function requestSummary(
  world: StressWorld,
): Array<Record<string, unknown>> {
  return world.requests.map(r => ({
    seq: r.seq,
    step: r.step,
    rt: r.runtimeId,
    path: r.path,
    bearer: r.bearer,
    ids: r.sessionId ? [r.sessionId] : r.shotIds,
    owner: r.rowOwner,
    outcome: r.outcome,
    bearerCurrent: r.bearerCurrentAtResponse,
  }));
}
