/**
 * stress / mod-sync-runtime — FAILURE-INJECTION lens (shared harness).
 *
 * Drives the REAL `configureSyncRuntime` / `triggerOutboxSync` /
 * `clearSyncRuntime` → `drainOutbox` → `createTransport` → `fetch` chain
 * with every dependency of the unit replaced by a fault-injecting double:
 *
 *   fetch / api      global `fetch` is a scripted fake server: per request it
 *                    can throw synchronously, reject (Error / TypeError /
 *                    string / null), hang honouring the abort signal, hang
 *                    IGNORING the abort signal, answer slowly, answer with a
 *                    non-Response, any HTTP status, a non-JSON / null / array
 *                    / string / shape-less body, `json()` that throws, rejects,
 *                    hangs or is slow, partial acceptance, conflicting
 *                    accepted+rejected verdicts, unknown ids, duplicates.
 *   SQLite (getDb)   `getDb` can throw; every `execute` can throw
 *                    synchronously, reject, hang, be slow, return malformed
 *                    rows, return a result without `rows`, return `null`, or
 *                    silently no-op (a DELETE that deletes nothing).
 *   bearer store     the in-memory ApiSession store (the only "Keychain"
 *                    analogue this unit touches — refresh tokens never reach
 *                    it) is cleared, rotated or swapped to another account
 *                    while a request is in flight.
 *   AppState         `addEventListener` throws, returns no subscription,
 *                    returns a subscription whose `remove` throws, fires
 *                    synchronously during registration, fires non-'active'
 *                    and non-string states, and fires 'active' in bursts.
 *   clock            `Math.random` (the only clock-ish input: retry jitter)
 *                    pinned to 0 / 1 / NaN; fake timers advanced through the
 *                    request timeout and the maximum backoff.
 *   runtime config   `getRuntimePublicConfig` (client-version header) throws.
 *
 * The unit does NOT depend on camera, Vision, TTS, RevenueCat, permissions
 * or navigation — those injections are out of scope here by construction
 * and the suites say so explicitly.
 *
 * Invariants (a headless module's version of "recoverable state with a
 * visible retry control, no infinite spinner, no silent failure, no fake
 * success, no corrupted persisted state"):
 *   NO_STALL          after a fault settles, a retry timer is armed and the
 *                     next drain happens within the request timeout + the
 *                     maximum backoff (the module's "no infinite spinner").
 *   RETRY_CONTROL     an explicit `triggerOutboxSync()` / foreground 'active'
 *                     after the fault produces a drain at once (the "retry
 *                     control" of a headless module).
 *   NO_FAKE_SUCCESS   a receipt exists / a row is deleted ONLY for an id the
 *                     fake server actually returned as accepted in a 2xx body
 *                     (sessions: a 2xx create/finalize).
 *   NO_SILENT_FAILURE every row that failed a drain carries `last_error`;
 *                     `deriveUploadQueueStatus` is never 'idle' while rows
 *                     remain and is 'needs_attention' once one is exhausted.
 *   NO_CORRUPTION     no orphaned BEGIN, attempts ∈ [0, OUTBOX_MAX_ATTEMPTS]
 *                     and monotonic, foreign owners' rows untouched.
 *   ONE_INFLIGHT      never two concurrent requests from one generation.
 *   ONE_TIMER         exactly one retry timer while configured, none after
 *                     `clearSyncRuntime`.
 *   NO_STORM          ≤ 4 requests in any 60 s window (30 s ± 20 % floor).
 *   RECOVERY          once every fault is lifted, the next drains deliver
 *                     every well-formed row and the outbox empties.
 *   NO_UNHANDLED      no promise rejection escapes the runtime.
 *
 * Scale: `STRESS_ITER` seeds for the randomized campaign (default 24);
 * `STRESS_SEED` pins one seed; `STRESS_RUN_ID` names the evidence directory
 * `artifacts/stress/mod-sync-runtime/<run>/` (repo-root relative).
 */
import type { LocalDb } from '../../src/data/db';
import { OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import type { ApiSession } from '../../src/account/apiSession';
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
  version: string;
  hrtime: { (): [number, number]; bind(self: unknown): () => [number, number] };
  memoryUsage(): { heapUsed: number; rss: number };
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

export { randomInt, seededRandom };

// ─── Seeds / scale ─────────────────────────────────────────────────────────

export const STRESS_ITER_DEFAULT = 24;

export function stressIterations(): number {
  const raw = process.env['STRESS_ITER'];
  const n = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : STRESS_ITER_DEFAULT;
}

export function fnv1a(text: string): number {
  let hash = 2166136261;
  for (const ch of text) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

/** One pinned seed in replay mode, else `STRESS_ITER` deterministic seeds
 * derived from the family name (FNV-1a) so equal scales cover equal inputs. */
export function stressSeeds(family: string): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  const hash = fnv1a(family);
  const seeds: number[] = [];
  for (let i = 0; i < stressIterations(); i += 1) {
    seeds.push((hash + i * 104729) >>> 0);
  }
  return seeds;
}

/** Seeded RNG (the xcBehavioral mulberry32) with the draw helpers the
 * randomized campaign needs; every iteration replays from its seed alone. */
export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  chance(p: number): boolean;
  pick<T>(items: readonly T[]): T;
  /** Weighted pick; weights need not sum to 1. */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T;
}

export function seededRng(seed: number): Rng {
  const next = seededRandom(seed);
  return {
    next,
    int: (min, max) => randomInt(next, min, max),
    chance: p => next() < p,
    pick: items => items[Math.floor(next() * items.length)]!,
    weighted: items => {
      const total = items.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [item, w] of items) {
        roll -= w;
        if (roll < 0) return item;
      }
      return items[items.length - 1]![0];
    },
  };
}

// ─── Evidence sink ─────────────────────────────────────────────────────────

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export function stressEvidenceDir(): string {
  // apps/mobile/testing/stress → repo root
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(root, 'artifacts', 'stress', 'mod-sync-runtime', RUN_ID);
}

export type Verdict = 'HELD' | 'BROKEN' | 'KNOWN_BROKEN';

export interface FaultRecord {
  suite: string;
  family: string;
  /** Catalog id (e.g. `F05`) or `seed:<n>` for the randomized campaign. */
  id: string;
  seed: number | null;
  /** Distinct injected faults in this scenario (counted, never estimated). */
  faultsInjected: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  verdict: Verdict;
  error: string | null;
  wallMs: number;
  heapUsedMb: number;
  rssMb: number;
  atIso: string;
}

const records: FaultRecord[] = [];

// Captured at load, before any suite installs fake timers (which replace
// `process.hrtime`), so `wallMs` measures real wall time.
const realHrtime = process.hrtime.bind(process);
const RealDate = Date;

function wallNowMs(): number {
  const [sec, nano] = realHrtime();
  return sec * 1000 + nano / 1e6;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

/** Runs one scenario, appends its record pass or fail, re-throws. `body`
 * fills the `observed` sink before asserting so a failing record still
 * carries everything gathered up to the assertion. `knownBroken` marks a
 * scenario whose CURRENT (broken) behaviour is pinned on purpose. */
export async function recordFault(
  suite: string,
  family: string,
  id: string,
  seed: number | null,
  inputs: Record<string, unknown>,
  body: (observed: Record<string, unknown>) => Promise<number>,
  options: { knownBroken?: boolean } = {},
): Promise<Record<string, unknown>> {
  const started = wallNowMs();
  const observed: Record<string, unknown> = {};
  let verdict: Verdict = options.knownBroken ? 'KNOWN_BROKEN' : 'HELD';
  let error: string | null = null;
  let faultsInjected = 0;
  try {
    faultsInjected = await body(observed);
    return observed;
  } catch (thrown) {
    verdict = 'BROKEN';
    error = thrown instanceof Error ? thrown.message : String(thrown);
    throw thrown;
  } finally {
    const memory = process.memoryUsage();
    records.push({
      suite,
      family,
      id,
      seed,
      faultsInjected,
      inputs,
      observed,
      verdict,
      error,
      wallMs: Math.round((wallNowMs() - started) * 100) / 100,
      heapUsedMb: mb(memory.heapUsed),
      rssMb: mb(memory.rss),
      atIso: new RealDate().toISOString(),
    });
  }
}

/** Writes `<suite>.ndjson` (one record per scenario) and `<suite>.json`
 * (the seed → outcome table) under the evidence directory. Call from
 * `afterAll`. */
export function flushFaultRecords(suite: string): {
  dir: string;
  table: string;
  scenarios: number;
  faults: number;
} {
  const dir = stressEvidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  const mine = records.filter(r => r.suite === suite);
  const ndjson = path.join(dir, `${suite}.ndjson`);
  fs.writeFileSync(ndjson, mine.map(r => JSON.stringify(r)).join('\n') + '\n');
  const table = path.join(dir, `${suite}.json`);
  const faults = mine.reduce((n, r) => n + r.faultsInjected, 0);
  fs.writeFileSync(
    table,
    JSON.stringify(
      {
        suite,
        runId: RUN_ID,
        node: process.version,
        stressIter: stressIterations(),
        scenarios: mine.length,
        faultsInjected: faults,
        verdicts: {
          HELD: mine.filter(r => r.verdict === 'HELD').length,
          KNOWN_BROKEN: mine.filter(r => r.verdict === 'KNOWN_BROKEN').length,
          BROKEN: mine.filter(r => r.verdict === 'BROKEN').length,
        },
        rows: mine.map(r => ({
          id: r.id,
          seed: r.seed,
          family: r.family,
          faultsInjected: r.faultsInjected,
          verdict: r.verdict,
          error: r.error,
          inputs: r.inputs,
          observed: r.observed,
          wallMs: r.wallMs,
        })),
      },
      null,
      2,
    ),
  );
  return { dir, table, scenarios: mine.length, faults };
}

// ─── Unhandled-rejection sentinel ──────────────────────────────────────────

/** Installs a process-level sentinel; `take()` returns and clears what leaked
 * since the last call. jest does not reliably fail a test for a rejection
 * that escapes between awaits, so the suites assert on this explicitly. */
export function unhandledRejectionSentinel(): {
  take: () => string[];
  dispose: () => void;
} {
  const leaked: string[] = [];
  const listener = (reason: unknown) => {
    leaked.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', listener);
  return {
    take: () => leaked.splice(0, leaked.length),
    dispose: () => process.off('unhandledRejection', listener),
  };
}

// ─── Fixtures ──────────────────────────────────────────────────────────────

export const USER_A = '11111111-1111-4111-8111-111111111111';
export const USER_B = '22222222-2222-4222-8222-222222222222';
export const API_BASE_URL = 'https://api.stress.test';

export function sessionFor(user: string, tokenSuffix = ''): ApiSession {
  return {
    apiBaseUrl: API_BASE_URL,
    bearerToken: `bearer-${user.slice(0, 4)}${tokenSuffix}`,
    canonicalAppUserId: user,
    provider: 'apple',
  };
}

export function shotPayload(id: string, sessionId: string | null) {
  return {
    id,
    sessionId,
    shotType: 'drive',
    stroke: 'drive',
    handedness: 'right',
    cameraView: 'side',
    createdAt: '2026-09-05T10:00:00.000Z',
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
      captureRecordedAt: '2026-09-05T10:00:00.000Z',
      poseSource: 'apple_vision_body_pose',
    },
    analysisPermitId: `permit-${id}`,
  };
}

export function sessionPayload(id: string) {
  return { id, startedAt: '2026-09-05T10:00:00.000Z' };
}

export function trialPayload(trialId: string) {
  return { trialId, stroke: 'drive', outcome: 'scored' };
}

// ─── Fake server (installed as global fetch) ───────────────────────────────

export interface ShotRejection {
  id: unknown;
  code: unknown;
  message?: string;
}

export type FetchOutcome =
  /** 2xx well-formed answer. `accept` defaults to every id sent. */
  | {
      kind: 'ok';
      accept?: 'all' | 'none' | string[];
      reject?: ShotRejection[];
      /** Also list these ids as accepted although they were never sent. */
      acceptUnknown?: string[];
      /** Repeat every accepted id twice. */
      duplicateAccepted?: boolean;
      /** Send accepted ids as numbers instead of strings. */
      acceptedAsNumbers?: boolean;
      /** Bytes of junk appended as an extra field beside the verdicts. */
      junkBytes?: number;
      status?: number;
    }
  /** Any HTTP status with an optional JSON body (`nonJson` sends text). */
  | { kind: 'status'; status: number; body?: unknown; nonJson?: boolean }
  /** `fetch` throws synchronously (not a rejected promise). */
  | { kind: 'throwSync'; error?: unknown }
  /** `fetch` rejects with the given reason. */
  | { kind: 'reject'; error: unknown }
  /** Never settles; `honorAbort` rejects when the signal aborts. */
  | { kind: 'hang'; honorAbort: boolean }
  /** Waits `ms` of fake time, then applies `then`. Honors abort meanwhile. */
  | { kind: 'slow'; ms: number; then: FetchOutcome }
  /** 200 with an arbitrary parsed body (malformed shapes). */
  | { kind: 'body'; body: unknown; status?: number }
  /** `fetch` resolves to something that is not a Response. */
  | { kind: 'nonResponse'; value: unknown }
  /** 200 whose `json()` throws synchronously / rejects / hangs / is slow. */
  | { kind: 'jsonThrows' }
  | { kind: 'jsonRejects' }
  | { kind: 'jsonHangs' }
  | { kind: 'jsonSlow'; ms: number }
  /** status 200 but `ok === false` (a broken Response implementation). */
  | { kind: 'okFalse200' };

export interface ServerRequest {
  seq: number;
  atMs: number;
  method: string;
  path: string;
  authorization: string | null;
  clientVersion: string | null;
  /** Shot ids / session id / trial ids carried by the request body. */
  entityIds: string[];
  outcome: FetchOutcome['kind'];
  status: number | null;
}

export interface FakeServer {
  /** Consumed one per request; when exhausted `defaultOutcome` applies. */
  script: FetchOutcome[];
  defaultOutcome: FetchOutcome;
  /** When true, shots whose sessionId is unknown are rejected with
   * `sessionNotFoundCode` (mirrors apply_synced_shot). */
  strictSessions: boolean;
  sessionNotFoundCode: string;
  requests: ServerRequest[];
  inFlight: number;
  maxInFlight: number;
  /** Ids the server ACTUALLY returned as accepted in a 2xx body. */
  acceptedShotIds: Set<string>;
  acceptedTrialIds: Set<string>;
  /** Session ids whose create / finalize got a 2xx. */
  createdSessions: Set<string>;
  finalizedSessions: Set<string>;
  knownSessions: Set<string>;
  /** Requests that were abandoned by an abort (fetch rejected on signal). */
  aborted: number;
  /** Requests still hanging (never settled) at the time of reading. */
  hanging: number;
  /** `slow` outcomes whose timer has not fired yet. */
  pendingSlow: number;
  fetch: typeof fetch;
}

interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

function parseBody(init: FetchInit): Record<string, unknown> {
  if (typeof init.body !== 'string') return {};
  try {
    return JSON.parse(init.body) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function entityIdsOf(
  pathname: string,
  body: Record<string, unknown>,
): string[] {
  if (pathname === '/v1/shots:sync') {
    const shots = Array.isArray(body['shots']) ? body['shots'] : [];
    return shots.map(shot =>
      String((shot as Record<string, unknown>)['id'] ?? '<no-id>'),
    );
  }
  if (pathname === '/v1/me/evaluation/trials') {
    const trials = Array.isArray(body['trials']) ? body['trials'] : [];
    return trials.map(trial =>
      String((trial as Record<string, unknown>)['trialId'] ?? '<no-id>'),
    );
  }
  if (pathname === '/v1/sessions') return [String(body['id'] ?? '<no-id>')];
  const finalize = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(pathname);
  if (finalize) return [decodeURIComponent(finalize[1]!)];
  return [];
}

interface FakeResponseOptions {
  status: number;
  ok?: boolean;
  json: () => Promise<unknown>;
}

function fakeResponse(options: FakeResponseOptions): Response {
  return {
    ok: options.ok ?? (options.status >= 200 && options.status < 300),
    status: options.status,
    statusText: `status-${options.status}`,
    json: options.json,
  } as unknown as Response;
}

function neverSettles<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function afterFakeMs<T>(ms: number, value: () => T): Promise<T> {
  return new Promise<T>(resolve => {
    setTimeout(() => resolve(value()), ms);
  });
}

export function createFakeServer(): FakeServer {
  const server: FakeServer = {
    script: [],
    defaultOutcome: { kind: 'ok' },
    strictSessions: false,
    sessionNotFoundCode: 'shot.session_not_found',
    requests: [],
    inFlight: 0,
    maxInFlight: 0,
    acceptedShotIds: new Set(),
    acceptedTrialIds: new Set(),
    createdSessions: new Set(),
    finalizedSessions: new Set(),
    knownSessions: new Set(),
    aborted: 0,
    hanging: 0,
    pendingSlow: 0,
    fetch: (() =>
      Promise.reject(new Error('unset'))) as unknown as typeof fetch,
  };

  /** Session create / finalize carry no verdict list: the client treats any
   * `ok` response whose body parses (or fails to parse) as acceptance, so
   * the server-side ledger must agree whenever it answers 2xx. */
  const markSessionAccepted = (
    pathname: string,
    body: Record<string, unknown>,
    status: number,
  ): boolean => {
    if (status < 200 || status >= 300) return false;
    if (pathname === '/v1/sessions') {
      const id = String(body['id']);
      server.knownSessions.add(id);
      server.createdSessions.add(id);
      return true;
    }
    const finalize = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(pathname);
    if (finalize) {
      server.finalizedSessions.add(decodeURIComponent(finalize[1]!));
      return true;
    }
    return false;
  };

  const wellFormedVerdict = (
    pathname: string,
    body: Record<string, unknown>,
    outcome: Extract<FetchOutcome, { kind: 'ok' }>,
  ): unknown => {
    if (markSessionAccepted(pathname, body, outcome.status ?? 200)) {
      return pathname === '/v1/sessions'
        ? { session: { id: String(body['id']) } }
        : { ok: true };
    }
    const isTrials = pathname === '/v1/me/evaluation/trials';
    const items = isTrials
      ? (Array.isArray(body['trials']) ? body['trials'] : []).map(
          t => (t as Record<string, unknown>)['trialId'],
        )
      : (Array.isArray(body['shots']) ? body['shots'] : []).map(s => ({
          id: (s as Record<string, unknown>)['id'],
          sessionId: (s as Record<string, unknown>)['sessionId'],
        }));
    const ids = isTrials
      ? (items as unknown[]).map(String)
      : (items as Array<{ id: unknown }>).map(item => String(item.id));
    let accepted: string[];
    if (outcome.accept === 'none') accepted = [];
    else if (Array.isArray(outcome.accept)) accepted = [...outcome.accept];
    else accepted = [...ids];
    const rejected: ShotRejection[] = [...(outcome.reject ?? [])];
    if (!isTrials && server.strictSessions) {
      for (const item of items as Array<{ id: unknown; sessionId: unknown }>) {
        const id = String(item.id);
        if (
          accepted.includes(id) &&
          typeof item.sessionId === 'string' &&
          !server.knownSessions.has(item.sessionId)
        ) {
          accepted = accepted.filter(a => a !== id);
          rejected.push({
            id,
            code: server.sessionNotFoundCode,
            message: 'session unknown',
          });
        }
      }
    }
    let acceptedOut: unknown[] = [
      ...accepted,
      ...(outcome.acceptUnknown ?? []),
    ];
    if (outcome.duplicateAccepted)
      acceptedOut = [...acceptedOut, ...acceptedOut];
    if (outcome.acceptedAsNumbers) acceptedOut = acceptedOut.map((_, i) => i);
    for (const id of acceptedOut) {
      // "accepted" is exactly what the body claims (even when the same id
      // also appears in `rejected`); the receipt invariant compares to this.
      if (typeof id === 'string' && ids.includes(id)) {
        if (isTrials) server.acceptedTrialIds.add(id);
        else server.acceptedShotIds.add(id);
      }
    }
    const verdict: Record<string, unknown> = isTrials
      ? {
          acceptedTrialIds: acceptedOut,
          rejected: rejected.map(r => ({
            trialId: r.id,
            code: r.code,
            message: r.message ?? 'rejected',
          })),
        }
      : {
          acceptedIds: acceptedOut,
          rejected: rejected.map(r => ({
            id: r.id,
            code: r.code,
            message: r.message ?? 'rejected',
          })),
        };
    if (outcome.junkBytes) verdict['junk'] = 'x'.repeat(outcome.junkBytes);
    return verdict;
  };

  const respond = (
    outcome: FetchOutcome,
    pathname: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    record: ServerRequest,
  ): Promise<Response> => {
    record.outcome = outcome.kind;
    switch (outcome.kind) {
      case 'ok': {
        const status = outcome.status ?? 200;
        record.status = status;
        const verdict = wellFormedVerdict(pathname, body, outcome);
        return Promise.resolve(
          fakeResponse({ status, json: () => Promise.resolve(verdict) }),
        );
      }
      case 'status': {
        record.status = outcome.status;
        markSessionAccepted(pathname, body, outcome.status);
        const json = outcome.nonJson
          ? () => Promise.reject(new SyntaxError('Unexpected token <'))
          : () => Promise.resolve(outcome.body ?? null);
        return Promise.resolve(fakeResponse({ status: outcome.status, json }));
      }
      case 'throwSync':
        throw outcome.error ?? new TypeError('fetch threw synchronously');
      case 'reject':
        return Promise.reject(outcome.error);
      case 'hang':
        server.hanging += 1;
        return new Promise<Response>((_resolve, reject) => {
          if (outcome.honorAbort && signal) {
            signal.addEventListener('abort', () => {
              server.hanging -= 1;
              server.aborted += 1;
              reject(new Error('Aborted'));
            });
          }
        });
      case 'slow':
        server.pendingSlow += 1;
        return new Promise<Response>((resolve, reject) => {
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            server.pendingSlow -= 1;
            let next: Promise<Response>;
            try {
              next = respond(outcome.then, pathname, body, signal, record);
            } catch (error) {
              reject(error);
              return;
            }
            next.then(resolve, reject);
          }, outcome.ms);
          signal?.addEventListener('abort', () => {
            if (settled) return;
            settled = true;
            server.pendingSlow -= 1;
            clearTimeout(timer);
            server.aborted += 1;
            reject(new Error('Aborted'));
          });
        });
      case 'body': {
        const status = outcome.status ?? 200;
        record.status = status;
        markSessionAccepted(pathname, body, status);
        return Promise.resolve(
          fakeResponse({ status, json: () => Promise.resolve(outcome.body) }),
        );
      }
      case 'nonResponse':
        return Promise.resolve(outcome.value as Response);
      case 'jsonThrows':
        record.status = 200;
        return Promise.resolve(
          fakeResponse({
            status: 200,
            json: () => {
              throw new SyntaxError('json() threw synchronously');
            },
          }),
        );
      case 'jsonRejects':
        record.status = 200;
        markSessionAccepted(pathname, body, 200);
        return Promise.resolve(
          fakeResponse({
            status: 200,
            json: () => Promise.reject(new SyntaxError('bad json')),
          }),
        );
      case 'jsonHangs':
        record.status = 200;
        server.hanging += 1;
        return Promise.resolve(
          fakeResponse({ status: 200, json: () => neverSettles() }),
        );
      case 'jsonSlow':
        record.status = 200;
        return Promise.resolve(
          fakeResponse({
            status: 200,
            json: () => {
              server.pendingSlow += 1;
              return afterFakeMs(outcome.ms, () => {
                server.pendingSlow -= 1;
                return wellFormedVerdict(pathname, body, { kind: 'ok' });
              });
            },
          }),
        );
      case 'okFalse200':
        record.status = 200;
        return Promise.resolve(
          fakeResponse({
            status: 200,
            ok: false,
            json: () =>
              Promise.resolve({
                error: { code: 'weird.ok_false', message: 'ok=false' },
              }),
          }),
        );
      default: {
        const never: never = outcome;
        return never;
      }
    }
  };

  server.fetch = ((input: unknown, init?: FetchInit): Promise<Response> => {
    const url = String(input);
    const pathname = url.startsWith(API_BASE_URL)
      ? url.slice(API_BASE_URL.length)
      : url;
    const headers = init?.headers ?? {};
    const body = parseBody(init ?? {});
    const record: ServerRequest = {
      seq: server.requests.length + 1,
      atMs: Date.now(),
      method: init?.method ?? 'GET',
      path: pathname,
      authorization: headers['authorization'] ?? null,
      clientVersion: headers['x-client-version'] ?? null,
      entityIds: entityIdsOf(pathname, body),
      outcome: 'ok',
      status: null,
    };
    server.requests.push(record);
    server.inFlight += 1;
    server.maxInFlight = Math.max(server.maxInFlight, server.inFlight);
    const outcome = server.script.shift() ?? server.defaultOutcome;
    let result: Promise<Response>;
    try {
      result = respond(outcome, pathname, body, init?.signal, record);
    } catch (error) {
      server.inFlight -= 1;
      throw error;
    }
    return result.finally(() => {
      server.inFlight -= 1;
    });
  }) as unknown as typeof fetch;

  return server;
}

// ─── Fault-injecting SQLite double ─────────────────────────────────────────

export type DbFaultMode =
  | 'throwSync'
  | 'reject'
  | 'hang'
  | 'slow'
  | 'malformedRows'
  | 'noRowsField'
  | 'nullResult'
  | 'noop';

export interface DbFault {
  /** Substring of the SQL the fault applies to. */
  needle: string;
  mode: DbFaultMode;
  /** How many matching statements to fault (default 1; Infinity = always). */
  times?: number;
  slowMs?: number;
  rows?: unknown[];
  error?: Error;
}

export interface FaultingDb {
  db: LocalDb;
  inner: FakeLocalDb;
  faults: DbFault[];
  /** Number of statements that were actually faulted, by mode. */
  faulted: Record<DbFaultMode, number>;
  /** Statements still hanging (never settled). */
  hanging: number;
  /** Pending `slow` timers that have not fired yet. */
  pendingSlow: number;
  addFault(fault: DbFault): void;
  clearFaults(): void;
}

export function createFaultingDb(): FaultingDb {
  const inner = createFakeLocalDb();
  const faults: Array<DbFault & { remaining: number }> = [];
  const faulted: Record<DbFaultMode, number> = {
    throwSync: 0,
    reject: 0,
    hang: 0,
    slow: 0,
    malformedRows: 0,
    noRowsField: 0,
    nullResult: 0,
    noop: 0,
  };
  const wrapper: FaultingDb = {
    inner,
    faults,
    faulted,
    hanging: 0,
    pendingSlow: 0,
    addFault(fault) {
      faults.push({ ...fault, remaining: fault.times ?? 1 });
    },
    clearFaults() {
      faults.length = 0;
    },
    db: {
      close() {
        inner.db.close();
      },
      execute(sql: string, params?: unknown[]) {
        const fault = faults.find(
          f => f.remaining > 0 && sql.includes(f.needle),
        );
        if (!fault) return inner.db.execute(sql, params);
        fault.remaining -= 1;
        faulted[fault.mode] += 1;
        const error =
          fault.error ??
          new Error(`injected sqlite ${fault.mode}: ${fault.needle}`);
        switch (fault.mode) {
          case 'throwSync':
            throw error;
          case 'reject':
            return Promise.reject(error);
          case 'hang':
            wrapper.hanging += 1;
            return neverSettles();
          case 'slow':
            wrapper.pendingSlow += 1;
            return afterFakeMs(fault.slowMs ?? 1_000, () => {
              wrapper.pendingSlow -= 1;
              return inner.db.execute(sql, params);
            }).then(result => result);
          case 'malformedRows':
            return Promise.resolve({
              rows: (fault.rows ?? [
                { id: undefined, kind: undefined, payload: undefined },
                { id: 'x', kind: 'shot.sync', payload: 42, attempts: '3' },
                {
                  id: null,
                  kind: 'session.create',
                  payload: '{not json',
                  attempts: NaN,
                },
              ]) as Array<Record<string, unknown>>,
            });
          case 'noRowsField':
            return Promise.resolve(
              {} as { rows: Array<Record<string, unknown>> },
            );
          case 'nullResult':
            return Promise.resolve(
              null as unknown as { rows: Array<Record<string, unknown>> },
            );
          case 'noop':
            return Promise.resolve({ rows: [] });
          default: {
            const never: never = fault.mode;
            return never;
          }
        }
      },
    },
  };
  return wrapper;
}

// ─── AppState double ───────────────────────────────────────────────────────

export type AppStateMode =
  | 'normal'
  | 'throwOnAdd'
  | 'removeThrows'
  | 'returnsUndefined'
  | 'fireActiveDuringAdd';

export interface AppStateHarness {
  mode: AppStateMode;
  handlers: Array<(state: unknown) => void>;
  removals: number;
  addCalls: number;
  /** Implementation for `jest.spyOn(AppState, 'addEventListener')`. */
  addEventListener: (event: unknown, handler: unknown) => unknown;
  fire(state: unknown): void;
}

export function createAppStateHarness(): AppStateHarness {
  const harness: AppStateHarness = {
    mode: 'normal',
    handlers: [],
    removals: 0,
    addCalls: 0,
    addEventListener(_event, handler) {
      harness.addCalls += 1;
      if (harness.mode === 'throwOnAdd') {
        throw new Error('injected AppState.addEventListener failure');
      }
      const fn = handler as (state: unknown) => void;
      harness.handlers.push(fn);
      if (harness.mode === 'fireActiveDuringAdd') fn('active');
      if (harness.mode === 'returnsUndefined') return undefined;
      return {
        remove: () => {
          harness.removals += 1;
          harness.handlers = harness.handlers.filter(h => h !== fn);
          if (harness.mode === 'removeThrows') {
            throw new Error('injected subscription.remove failure');
          }
        },
      };
    },
    fire(state) {
      for (const handler of [...harness.handlers]) handler(state);
    },
  };
  return harness;
}

// ─── Timing helpers (fake timers, real setImmediate) ───────────────────────

/** Drains the microtask queue (setImmediate is left real). */
export async function flushMicrotasks(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** Advances fake time in steps so timer-driven drains get their microtasks. */
export async function advance(ms: number, stepMs = 5_000): Promise<void> {
  let left = ms;
  while (left > 0) {
    const step = Math.min(stepMs, left);
    jest.advanceTimersByTime(step);
    left -= step;
    await flushMicrotasks(3);
  }
  await flushMicrotasks(6);
}

// ─── Read-outs ─────────────────────────────────────────────────────────────

export function drainCount(db: FaultingDb): number {
  return db.inner.statements.filter(s =>
    s.sql.startsWith('SELECT id, kind, payload'),
  ).length;
}

export function drainsCompleted(db: FaultingDb): number {
  return db.inner.statements.filter(s => s.sql.includes('count(*)')).length;
}

/** Max requests observed in any sliding 60 s window of fake time. */
export function maxRequestsInAnyMinute(server: FakeServer): number {
  const times = server.requests.map(r => r.atMs).sort((a, b) => a - b);
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < times.length; hi += 1) {
    while (times[hi]! - times[lo]! > 60_000) lo += 1;
    best = Math.max(best, hi - lo + 1);
  }
  return best;
}

export function uniqueReceipts(
  db: FaultingDb,
): Array<{ owner: string; entityId: string }> {
  const seen = new Set<string>();
  const out: Array<{ owner: string; entityId: string }> = [];
  for (const r of db.inner.receipts) {
    const key = `${r.owner}\u0000${r.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner: r.owner, entityId: r.entityId });
  }
  return out;
}

export interface EnqueuedRow {
  id: number;
  owner: string;
  kind: string;
  entityId: string;
  wellFormed: boolean;
}

export function outboxRowsFor(db: FaultingDb, owner: string) {
  return db.inner.outbox.filter(r => r.owner_key === owner);
}

/** Violations of the persisted-state invariants that hold for EVERY
 * scenario, regardless of which fault was injected. */
export function persistedStateViolations(
  db: FaultingDb,
  server: FakeServer,
  enqueued: readonly EnqueuedRow[],
): string[] {
  const violations: string[] = [];
  if (db.inner.openTransactions() !== 0) {
    violations.push(`orphaned transactions: ${db.inner.openTransactions()}`);
  }
  for (const row of db.inner.outbox) {
    if (
      !Number.isInteger(row.attempts) ||
      row.attempts < 0 ||
      row.attempts > OUTBOX_MAX_ATTEMPTS
    ) {
      violations.push(`row ${row.id} attempts out of range: ${row.attempts}`);
    }
    if (row.attempts > 0 && row.last_error === null) {
      violations.push(`row ${row.id} consumed attempts without last_error`);
    }
  }
  for (const receipt of uniqueReceipts(db)) {
    if (!server.acceptedShotIds.has(receipt.entityId)) {
      violations.push(
        `receipt for ${receipt.entityId} but the server never accepted it`,
      );
    }
  }
  const present = new Set(db.inner.outbox.map(r => r.id));
  for (const row of enqueued) {
    if (present.has(row.id)) continue;
    if (row.kind === 'shot.sync' && !server.acceptedShotIds.has(row.entityId)) {
      violations.push(`shot row ${row.entityId} deleted without acceptance`);
    }
    if (row.kind === 'shot.sync') {
      const receipted = uniqueReceipts(db).some(
        r => r.entityId === row.entityId && r.owner === row.owner,
      );
      if (!receipted) {
        violations.push(`shot row ${row.entityId} deleted without a receipt`);
      }
    }
    if (
      row.kind === 'session.create' &&
      !server.createdSessions.has(row.entityId)
    ) {
      violations.push(
        `session row ${row.entityId} deleted without a 2xx create`,
      );
    }
    if (
      row.kind === 'session.finalize' &&
      !server.finalizedSessions.has(row.entityId)
    ) {
      violations.push(
        `finalize row ${row.entityId} deleted without a 2xx finalize`,
      );
    }
    if (
      row.kind === 'evaluation.trial' &&
      !server.acceptedTrialIds.has(row.entityId)
    ) {
      violations.push(`trial row ${row.entityId} deleted without acceptance`);
    }
  }
  return violations;
}
