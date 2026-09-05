/**
 * NETWORK × AUTH scenario-matrix harness (cell 1: {normal, slow, timeout} ×
 * {valid, expired, refreshing}).
 *
 * Drives the REAL mobile modules — `src/data/api.ts` (createTransport +
 * request), `src/data/sync.ts` (drainOutbox), `src/account/sessionKeeper.ts`
 * (startSessionKeeper / refreshSessionNow) and `src/account/apiSession.ts`
 * (bearerTokenFor / reportApiUnauthorized) — over a seeded, abort-aware mock
 * transport and a fake LocalDb, under jest fake timers. Nothing in
 * production code is mocked; only `fetch`, the SQLite db and the clock are.
 *
 * The auth-store wiring that production performs around these modules is
 * mirrored here in its minimal form (see `wireSession`): a 401 for the
 * current bearer asks the keeper to rotate now, `onRotated` re-establishes
 * the ApiSession, `onRevoked` clears it. That is exactly what
 * `src/auth/authStore.ts` does (`handleApiUnauthorized`,
 * `adoptRotatedTokens`, `dropRevokedSession`).
 *
 * The mock server models Supabase GoTrue refresh-token semantics as
 * documented at https://supabase.com/docs/guides/auth/sessions and
 * implemented in supabase/auth internal/tokens/service.go: a refresh token
 * is single use, EXCEPT (a) within the reuse interval (10 s) and (b) when it
 * is the parent of the currently active token — the client lost the
 * response — in which case the active pair is returned again. Any other
 * reuse revokes the family and answers 401 (the edge fn maps every GoTrue
 * refusal to 401, supabase/functions/api/index.ts refreshSessionRoute).
 *
 * Every failure carries the seed and the cell so it can be replayed with
 *   MATRIX_ONLY=<network>:<auth>:<seed> npx jest __tests__/matrix/networkAuthMatrix.test.ts
 */
import { AppState } from 'react-native';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { LocalDb } from '../../src/data/db';
import {
  API_REQUEST_TIMEOUT_MS,
  createTransport,
  type ApiConfigState,
} from '../../src/data/api';
import { drainOutbox, OUTBOX_MAX_ATTEMPTS } from '../../src/data/sync';
import {
  bearerTokenFor,
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  refreshSessionNow,
  startSessionKeeper,
  stopSessionKeeper,
} from '../../src/account/sessionKeeper';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';

// ─── Cells ───────────────────────────────────────────────────────────────────

export const NETWORK_CELLS = ['normal', 'slow', 'timeout'] as const;
export const AUTH_CELLS = ['valid', 'expired', 'refreshing'] as const;
export type NetworkCell = (typeof NETWORK_CELLS)[number];
export type AuthCell = (typeof AUTH_CELLS)[number];

/** Mirrors sessionLifecycle.ts REQUEST_TIMEOUT_MS (not exported there). */
export const REFRESH_REQUEST_TIMEOUT_MS = 15_000;
/** GoTrue default SECURITY_REFRESH_TOKEN_REUSE_INTERVAL. */
export const REFRESH_REUSE_INTERVAL_MS = 10_000;
/** Recovery drains per combination once the network is back. */
export const RECOVERY_DRAINS = 8;

/** Mirrors syncRuntime.nextSyncRetryDelayMs (30 s base, ×2 per failed
 * drain, 5 min cap, ±20 % jitter) with the seeded RNG. */
export function syncRetryDelayMs(
  consecutiveFailures: number,
  rng: Rng,
): number {
  const exponent = Math.max(0, Math.min(consecutiveFailures, 10));
  const base = Math.min(30_000 * 2 ** exponent, 5 * 60_000);
  return Math.round(base + base * 0.2 * (rng.next() * 2 - 1));
}

export const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const API_BASE = 'https://api.example.test';

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
}

/** Distinct per-cell seed stream so cell (a, s) and (b, s) differ. */
export function combinationSeed(
  network: NetworkCell,
  auth: AuthCell,
  seed: number,
): number {
  const n = NETWORK_CELLS.indexOf(network) + 1;
  const a = AUTH_CELLS.indexOf(auth) + 1;
  return (seed * 1_000_003 + n * 7919 + a * 104_729) >>> 0;
}

// ─── Scenario ────────────────────────────────────────────────────────────────

export type SeededRowKind =
  'shot.sync' | 'session.create' | 'session.finalize' | 'evaluation.trial';

export interface SeededRow {
  kind: SeededRowKind;
  entityId: string;
  /** Row body is not parseable / lacks the permit → client-side permanent. */
  corrupt: boolean;
  /** Server answers a contract rejection every time → permanent. */
  permanentReject: boolean;
  /** Server answers a retryable rejection for the first N visits. */
  transientRejectVisits: number;
}

export interface Scenario {
  network: NetworkCell;
  auth: AuthCell;
  seed: number;
  rows: SeededRow[];
  /** Virtual ms after start at which the network returns to `normal`. */
  recoverAtMs: number;
  /** auth=refreshing: ms between refreshSessionNow() and the first drain. */
  refreshingLeadMs: number;
  /** auth=refreshing: the bearer being rotated is still accepted server-side. */
  oldBearerValid: boolean;
  /** Optional AppState 'active' event during phase 1. */
  foregroundAtMs: number | null;
  /** Recorded bearer expiry the client believes (ms from start). */
  bearerLifetimeMs: number;
}

export function buildScenario(
  network: NetworkCell,
  auth: AuthCell,
  seed: number,
): Scenario {
  const rng = new Rng(combinationSeed(network, auth, seed));
  const rows: SeededRow[] = [];
  const shotCount = rng.int(0, 6);
  const sessionCount = rng.int(0, 2);
  const finalizeCount = rng.int(0, 1);
  const trialCount = rng.int(0, 2);
  let n = 0;
  const id = (prefix: string) =>
    `${prefix}${(n++).toString(16).padStart(4, '0')}-0000-4000-8000-${seed
      .toString(16)
      .padStart(12, '0')
      .slice(-12)}`;
  const push = (kind: SeededRowKind) => {
    rows.push({
      kind,
      entityId: id(kind === 'shot.sync' ? 'aaaa' : kind[1] + 'bbb'),
      corrupt: rng.chance(0.08),
      permanentReject: rng.chance(0.12),
      transientRejectVisits: rng.chance(0.15) ? rng.int(1, 2) : 0,
    });
  };
  for (let i = 0; i < sessionCount; i++) push('session.create');
  for (let i = 0; i < shotCount; i++) push('shot.sync');
  for (let i = 0; i < finalizeCount; i++) push('session.finalize');
  for (let i = 0; i < trialCount; i++) push('evaluation.trial');
  // Guarantee at least one row so every combination exercises a request.
  if (rows.length === 0) push('shot.sync');
  return {
    network,
    auth,
    seed,
    rows,
    recoverAtMs: rng.int(30_000, 90_000),
    refreshingLeadMs: rng.int(0, 500),
    oldBearerValid: rng.chance(0.5),
    foregroundAtMs: rng.chance(0.4) ? rng.int(500, 25_000) : null,
    bearerLifetimeMs: 3_600_000,
  };
}

// ─── Fake LocalDb (outbox + sync_receipt) ────────────────────────────────────

export interface OutboxRow {
  id: number;
  owner_key: string;
  kind: string;
  payload: string;
  attempts: number;
  last_error: string | null;
}

export function fakeDb() {
  const outbox: OutboxRow[] = [];
  const receipts: Array<{ owner: string; entityId: string }> = [];
  let nextId = 1;
  let inTransaction = false;
  const db: LocalDb = {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement === 'BEGIN IMMEDIATE') {
        if (inTransaction) throw new Error('fakeDb: nested transaction');
        inTransaction = true;
        return { rows: [] };
      }
      if (statement === 'COMMIT' || statement === 'ROLLBACK') {
        inTransaction = false;
        return { rows: [] };
      }
      if (statement.includes('INSERT OR REPLACE INTO sync_receipt')) {
        receipts.push({
          owner: String(params[0]),
          entityId: String(params[1]),
        });
        return { rows: [] };
      }
      if (statement.startsWith('SELECT id, kind, payload')) {
        return {
          rows: outbox
            .filter(
              r =>
                r.owner_key === String(params[0]) &&
                r.attempts < Number(params[1]),
            )
            .sort((a, b) => a.id - b.id)
            .slice(0, 50)
            .map(r => ({ ...r })),
        };
      }
      if (statement.startsWith('DELETE FROM outbox')) {
        const idx = outbox.findIndex(
          r => r.owner_key === params[0] && r.id === params[1],
        );
        if (idx >= 0) outbox.splice(idx, 1);
        return { rows: [] };
      }
      if (statement.startsWith('UPDATE outbox')) {
        const row = outbox.find(
          r => r.owner_key === params[1] && r.id === params[2],
        );
        if (row) {
          if (statement.includes('attempts = attempts + 1')) row.attempts += 1;
          const quarantine = /SET attempts = (\d+),/.exec(statement);
          if (quarantine) row.attempts = Number(quarantine[1]);
          row.last_error = String(params[0]);
        }
        return { rows: [] };
      }
      if (statement.startsWith('SELECT ls.id AS id FROM local_session')) {
        // No local_session rows exist in this fake: no parked set to re-queue.
        return { rows: [] };
      }
      if (statement.startsWith('SELECT count(*)')) {
        return {
          rows: [{ n: outbox.filter(r => r.owner_key === params[0]).length }],
        };
      }
      throw new Error(`fakeDb: unhandled sql ${statement}`);
    },
    close() {},
  };
  const push = (owner: string, kind: string, payload: string) => {
    outbox.push({
      id: nextId++,
      owner_key: owner,
      kind,
      payload,
      attempts: 0,
      last_error: null,
    });
  };
  return { db, push, outbox, receipts };
}

const baseAnalysis: ShotAnalysis = {
  id: 'placeholder',
  sessionId: null,
  shotType: 'forehand_drive',
  cameraView: 'side',
  handedness: 'right',
  capturedAtIso: '2026-08-26T18:00:00.000Z',
  timestamps: { startMs: 0, contactMs: 1040, endMs: 2000 },
  phases: [],
  measurements: [],
  checkpoints: [],
  overallScore: 7.4,
  analysisConfidence: 0.9,
  resultKind: 'scored',
  guidance: null,
  priorityFix: null,
  versionVector: {
    appVersion: '0.1.0',
    modelBundleVersion: 'test-native-1',
    poseModelVersion: 'test-pose-1',
    paddleModelVersion: 'test-paddle-1',
    strokeDetectorVersion: 'test-stroke-1',
    phaseModelVersion: 'test-phase-1',
    scoringModelVersion: 'sm-v1',
    shotConfigVersion: 'forehand_drive@1',
  },
  source: 'real',
};

export function rowPayload(row: SeededRow): string {
  if (row.corrupt) {
    return row.kind === 'shot.sync'
      ? JSON.stringify({ ...baseAnalysis, id: row.entityId }) // no permit id
      : '{not json';
  }
  switch (row.kind) {
    case 'shot.sync':
      return JSON.stringify({
        ...baseAnalysis,
        id: row.entityId,
        analysisPermitId: `cccccccc-0000-4000-8000-${row.entityId.slice(-12)}`,
      });
    case 'session.create':
      return JSON.stringify({
        id: row.entityId,
        mode: 'practice',
        startedAt: '2026-08-26T18:00:00.000Z',
      });
    case 'session.finalize':
      return JSON.stringify({ id: row.entityId });
    case 'evaluation.trial':
      return JSON.stringify({ trialId: row.entityId, outcome: 'scored' });
  }
}

// ─── Mock server + transport ─────────────────────────────────────────────────

export interface RequestLog {
  atMs: number;
  url: string;
  bearer: string | null;
  /** bearerTokenFor(CANONICAL_ID) at the instant fetch was invoked. */
  currentBearerAtSend: string | null;
  outcome:
    'ok' | '401' | 'aborted' | 'lost-request' | 'lost-response' | 'error';
  status: number | null;
  latencyMs: number;
}

export interface ServerState {
  /** Access tokens the server accepts. */
  validBearers: Set<string>;
  /** refresh token → { child (next token) | null, usedAtMs } */
  refreshTokens: Map<
    string,
    { child: string | null; usedAtMs: number | null; revoked: boolean }
  >;
  activeRefreshToken: string;
  acceptedShots: Set<string>;
  createdSessions: Set<string>;
  finalizedSessions: Set<string>;
  acceptedTrials: Set<string>;
  visits: Map<string, number>;
  refreshInflight: number;
  maxRefreshInflight: number;
  refreshRefusals: number;
  refreshRotations: number;
  refreshReuseServed: number;
  mintCounter: number;
}

export interface Transport {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  server: ServerState;
  log: RequestLog[];
  /** Switch the active network profile (phase 2 = recovery). */
  setNetwork: (cell: NetworkCell) => void;
  pendingLatencyTimers: () => number;
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText:
      status === 401 ? 'Unauthorized' : status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

export function createMockTransport(
  scenario: Scenario,
  rng: Rng,
  startMs: number,
): Transport {
  let network: NetworkCell = scenario.network;
  const server: ServerState = {
    validBearers: new Set(),
    refreshTokens: new Map(),
    activeRefreshToken: 'R0',
    acceptedShots: new Set(),
    createdSessions: new Set(),
    finalizedSessions: new Set(),
    acceptedTrials: new Set(),
    visits: new Map(),
    refreshInflight: 0,
    maxRefreshInflight: 0,
    refreshRefusals: 0,
    refreshRotations: 0,
    refreshReuseServed: 0,
    mintCounter: 0,
  };
  server.refreshTokens.set('R0', {
    child: null,
    usedAtMs: null,
    revoked: false,
  });
  const rowsByEntity = new Map(scenario.rows.map(r => [r.entityId, r]));
  const log: RequestLog[] = [];
  let pendingTimers = 0;

  const latencyFor = (isRefresh: boolean): number => {
    const timeout = isRefresh
      ? REFRESH_REQUEST_TIMEOUT_MS
      : API_REQUEST_TIMEOUT_MS;
    switch (network) {
      case 'normal':
        return rng.int(5, 200);
      case 'slow':
        // Strictly inside the client's budget, biased toward the edge.
        return rng.int(Math.floor(timeout * 0.3), timeout - 100);
      case 'timeout':
        return rng.int(timeout + 100, timeout * 3);
    }
  };

  const visit = (entityId: string): number => {
    const count = (server.visits.get(entityId) ?? 0) + 1;
    server.visits.set(entityId, count);
    return count;
  };

  const rejectionFor = (
    entityId: string,
    transientCode: string,
    permanentCode: string,
  ): { code: string; message: string } | null => {
    const row = rowsByEntity.get(entityId);
    const count = visit(entityId);
    if (!row) return { code: permanentCode, message: 'unknown entity' };
    if (row.permanentReject) return { code: permanentCode, message: 'invalid' };
    if (count <= row.transientRejectVisits)
      return { code: transientCode, message: 'retry later' };
    return null;
  };

  const mintSession = () => {
    server.mintCounter += 1;
    const access = `B${server.mintCounter}`;
    const refresh = `R${server.mintCounter}`;
    server.validBearers.add(access);
    return { access, refresh };
  };

  /** Processed at receipt (before response latency), like a real server. */
  const handleRefresh = (
    body: unknown,
    nowMs: number,
  ): { status: number; body: unknown } => {
    const refreshToken = (body as { refreshToken?: unknown } | null)
      ?.refreshToken;
    if (typeof refreshToken !== 'string' || !refreshToken.trim()) {
      return {
        status: 400,
        body: {
          error: { code: 'validation.refresh', message: 'refreshToken req.' },
        },
      };
    }
    const record = server.refreshTokens.get(refreshToken);
    const refuse = () => {
      server.refreshRefusals += 1;
      // Family revocation: every token of this session dies.
      for (const entry of server.refreshTokens.values()) entry.revoked = true;
      return {
        status: 401,
        body: {
          error: {
            code: 'unauthorized',
            message: 'The session could not be refreshed. Sign in again.',
          },
        },
      };
    };
    if (!record || record.revoked) return refuse();
    const sessionBody = (access: string, refresh: string) => ({
      status: 200,
      body: {
        session: {
          accessToken: access,
          refreshToken: refresh,
          expiresAt: Math.floor((nowMs + scenario.bearerLifetimeMs) / 1000),
        },
      },
    });
    if (record.usedAtMs !== null) {
      const isParentOfActive =
        record.child !== null && record.child === server.activeRefreshToken;
      const withinReuse = nowMs - record.usedAtMs <= REFRESH_REUSE_INTERVAL_MS;
      if (isParentOfActive || withinReuse) {
        server.refreshReuseServed += 1;
        const child = record.child!;
        const access = `B${child.slice(1)}`;
        return sessionBody(access, child);
      }
      return refuse();
    }
    const minted = mintSession();
    record.usedAtMs = nowMs;
    record.child = minted.refresh;
    server.refreshTokens.set(minted.refresh, {
      child: null,
      usedAtMs: null,
      revoked: false,
    });
    server.activeRefreshToken = minted.refresh;
    server.refreshRotations += 1;
    return sessionBody(minted.access, minted.refresh);
  };

  const handleApi = (
    url: string,
    bearer: string | null,
    body: unknown,
  ): { status: number; body: unknown } => {
    if (!bearer || !server.validBearers.has(bearer)) {
      return {
        status: 401,
        body: {
          error: {
            code: 'unauthorized',
            message: 'The access token could not be verified.',
          },
        },
      };
    }
    const path = url.slice(API_BASE.length);
    if (path === '/v1/shots:sync') {
      const shots = (body as { shots: Array<{ id: string }> }).shots;
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots) {
        const rejection = rejectionFor(
          shot.id,
          'shot.write_failed',
          'shot.invalid_payload',
        );
        if (rejection) rejected.push({ id: shot.id, ...rejection });
        else {
          server.acceptedShots.add(shot.id);
          acceptedIds.push(shot.id);
        }
      }
      return { status: 200, body: { acceptedIds, rejected } };
    }
    if (path === '/v1/sessions') {
      const id = (body as { id: string }).id;
      const rejection = rejectionFor(id, 'session.write_failed', 'validation');
      if (rejection) {
        // Whole-request failure: transient ⇒ 503, permanent ⇒ 400.
        return rejection.code === 'session.write_failed'
          ? { status: 503, body: { error: rejection } }
          : { status: 400, body: { error: rejection } };
      }
      server.createdSessions.add(id);
      return { status: 200, body: { session: { id } } };
    }
    const finalize = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(path);
    if (finalize) {
      const id = finalize[1]!;
      const rejection = rejectionFor(
        id,
        'session.write_failed',
        'session.not_found',
      );
      if (rejection) {
        return rejection.code === 'session.write_failed'
          ? { status: 503, body: { error: rejection } }
          : { status: 404, body: { error: rejection } };
      }
      server.finalizedSessions.add(id);
      return { status: 200, body: { session: { id } } };
    }
    if (path === '/v1/me/evaluation/trials') {
      const trials = (body as { trials: Array<{ trialId: string }> }).trials;
      const acceptedTrialIds: string[] = [];
      const rejected: Array<{
        trialId: string;
        code: string;
        message: string;
      }> = [];
      for (const trial of trials) {
        const rejection = rejectionFor(
          trial.trialId,
          'evaluation.trial_write_failed',
          'evaluation.trial_invalid',
        );
        if (rejection) rejected.push({ trialId: trial.trialId, ...rejection });
        else {
          server.acceptedTrials.add(trial.trialId);
          acceptedTrialIds.push(trial.trialId);
        }
      }
      return { status: 200, body: { acceptedTrialIds, rejected } };
    }
    return {
      status: 404,
      body: { error: { code: 'not_found', message: path } },
    };
  };

  const fetchImpl = (url: string, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authHeader = headers['authorization'] ?? headers['Authorization'];
    const bearer = authHeader ? authHeader.replace(/^Bearer /, '') : null;
    const isRefresh = url === `${API_BASE}/v1/auth/refresh`;
    const nowMs = Date.now();
    const latencyMs = latencyFor(isRefresh);
    const timeout = isRefresh
      ? REFRESH_REQUEST_TIMEOUT_MS
      : API_REQUEST_TIMEOUT_MS;
    const entry: RequestLog = {
      atMs: nowMs - startMs,
      url,
      bearer,
      currentBearerAtSend: bearerTokenFor(CANONICAL_ID),
      outcome: 'error',
      status: null,
      latencyMs,
    };
    log.push(entry);
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : null;

    // Will the client give up before we answer? Then decide whether the
    // request even reached the server (lost-request) or only the response
    // was lost (lost-response) — processing happens at receipt either way.
    const willTimeOut = latencyMs > timeout;
    const lostRequest = willTimeOut && rng.chance(0.5);
    let result: { status: number; body: unknown } | null = null;
    if (!lostRequest) {
      if (isRefresh) {
        server.refreshInflight += 1;
        server.maxRefreshInflight = Math.max(
          server.maxRefreshInflight,
          server.refreshInflight,
        );
        result = handleRefresh(body, nowMs);
      } else {
        result = handleApi(url, bearer, body);
      }
    }

    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal ?? null;
      let settled = false;
      pendingTimers += 1;
      const finish = () => {
        pendingTimers -= 1;
        if (isRefresh && !lostRequest) server.refreshInflight -= 1;
      };
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        finish();
        if (!result) {
          entry.outcome = 'lost-request';
          reject(new TypeError('Network request failed'));
          return;
        }
        entry.status = result.status;
        entry.outcome = result.status === 401 ? '401' : 'ok';
        resolve(jsonResponse(result.status, result.body));
      }, latencyMs);
      if (signal) {
        if (signal.aborted) {
          settled = true;
          clearTimeout(timer);
          finish();
          entry.outcome = lostRequest ? 'lost-request' : 'lost-response';
          reject(abortError());
          return;
        }
        signal.addEventListener('abort', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          finish();
          entry.outcome = lostRequest ? 'lost-request' : 'lost-response';
          reject(abortError());
        });
      }
    });
  };

  return {
    fetch: fetchImpl,
    server,
    log,
    setNetwork: cell => {
      network = cell;
    },
    pendingLatencyTimers: () => pendingTimers,
  };
}

// ─── Session wiring (mirrors authStore) ──────────────────────────────────────

export interface KeeperEvents {
  rotated: Array<{ atMs: number; bearer: string; refreshToken: string }>;
  revoked: number[];
  deferred: Array<{ atMs: number; error: string }>;
}

export function wireSession(
  transport: Transport,
  scenario: Scenario,
  startMs: number,
  events: KeeperEvents,
  foreground: { handler: ((state: string) => void) | null },
): void {
  const initial: ApiSession = {
    apiBaseUrl: API_BASE,
    bearerToken: 'B0',
    canonicalAppUserId: CANONICAL_ID,
    provider: 'apple',
    refreshToken: 'R0',
    bearerExpiresAtMs: startMs + scenario.bearerLifetimeMs,
  };
  transport.server.validBearers.add('B0');
  if (scenario.auth === 'expired') transport.server.validBearers.delete('B0');
  if (scenario.auth === 'refreshing' && !scenario.oldBearerValid) {
    transport.server.validBearers.delete('B0');
  }
  setActiveDataOwner(CANONICAL_ID);
  establishApiSession(initial);
  // authStore.handleApiUnauthorized: a 401 on the current bearer with a
  // refresh token available ⇒ rotate now, never sign out on its own.
  setApiUnauthorizedListener(expired => {
    if (expired.refreshToken) refreshSessionNow();
  });
  jest
    .spyOn(AppState, 'addEventListener')
    .mockImplementation((_event, handler) => {
      foreground.handler = handler as (state: string) => void;
      return { remove: () => {} } as ReturnType<
        typeof AppState.addEventListener
      >;
    });
  startSessionKeeper({
    apiBaseUrl: API_BASE,
    refreshToken: 'R0',
    bearerExpiresAtMs: initial.bearerExpiresAtMs ?? null,
    fetchFn: transport.fetch,
    onRotated: tokens => {
      events.rotated.push({
        atMs: Date.now() - startMs,
        bearer: tokens.bearerToken,
        refreshToken: tokens.refreshToken,
      });
      // authStore.adoptRotatedTokens
      if (getApiSession()?.canonicalAppUserId !== CANONICAL_ID) return;
      establishApiSession({
        ...initial,
        bearerToken: tokens.bearerToken,
        refreshToken: tokens.refreshToken,
        bearerExpiresAtMs: tokens.bearerExpiresAtMs,
      });
    },
    onRevoked: () => {
      events.revoked.push(Date.now() - startMs);
      // authStore.dropRevokedSession
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    },
    onDeferred: error => {
      events.deferred.push({
        atMs: Date.now() - startMs,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });
}

export function liveTransportConfig(): ApiConfigState {
  return {
    baseUrl: API_BASE,
    get token(): string | null {
      return bearerTokenFor(CANONICAL_ID);
    },
  };
}

// ─── Runner ──────────────────────────────────────────────────────────────────

export interface Failure {
  invariant: string;
  detail: string;
}

export interface DrainRecord {
  startedAtMs: number;
  durationMs: number;
  settled: boolean;
  result: { synced: number; failed: number; remaining: number } | null;
  error: string | null;
}

export interface CombinationResult {
  network: NetworkCell;
  auth: AuthCell;
  seed: number;
  combinationSeed: number;
  replay: string;
  ok: boolean;
  failures: Failure[];
  scenario: Omit<Scenario, 'rows'> & { rowCount: number; rows: SeededRow[] };
  stats: {
    requests: number;
    apiRequests: number;
    refreshRequests: number;
    aborted: number;
    lostRequests: number;
    lostResponses: number;
    unauthorized: number;
    rotations: number;
    refreshReuseServed: number;
    refreshRefusals: number;
    maxRefreshInflight: number;
    revoked: number;
    deferred: number;
    drains: DrainRecord[];
    remainingRows: number;
    remainingRetryable: number;
    receipts: number;
    finalBearer: string | null;
    virtualElapsedMs: number;
  };
}

/** Advance fake time in small steps until `done()` or `maxMs` elapsed;
 * `afterStep` runs after every step (used to inject the foreground event
 * from the same clock loop, never from a concurrent one). */
async function advanceUntil(
  done: () => boolean,
  maxMs: number,
  afterStep: () => void = () => {},
  stepMs = 250,
): Promise<number> {
  let elapsed = 0;
  while (!done() && elapsed < maxMs) {
    await jest.advanceTimersByTimeAsync(stepMs);
    elapsed += stepMs;
    afterStep();
  }
  return elapsed;
}

async function runDrain(
  db: LocalDb,
  transport: Transport,
  boundMs: number,
  startMs: number,
  afterStep: () => void = () => {},
): Promise<DrainRecord> {
  const record: DrainRecord = {
    startedAtMs: Date.now() - startMs,
    durationMs: 0,
    settled: false,
    result: null,
    error: null,
  };
  const t0 = Date.now();
  const promise = drainOutbox(db, createTransport(liveTransportConfig()))
    .then(result => {
      record.result = result;
    })
    .catch((error: unknown) => {
      record.error = error instanceof Error ? error.message : String(error);
    })
    .finally(() => {
      record.settled = true;
      record.durationMs = Date.now() - t0;
    });
  await advanceUntil(() => record.settled, boundMs, afterStep);
  if (!record.settled) {
    // Give the abort path one more chance before declaring it hung.
    await advanceUntil(
      () => record.settled,
      API_REQUEST_TIMEOUT_MS * 2,
      afterStep,
    );
  }
  void promise;
  return record;
}

export async function runCombination(
  network: NetworkCell,
  auth: AuthCell,
  seed: number,
): Promise<CombinationResult> {
  const scenario = buildScenario(network, auth, seed);
  const rng = new Rng(combinationSeed(network, auth, seed) ^ 0x9e3779b9);
  jest.useFakeTimers();
  const startMs = Date.UTC(2026, 8, 4, 12, 0, 0);
  jest.setSystemTime(startMs);
  const { db, push, outbox, receipts } = fakeDb();
  for (const row of scenario.rows)
    push(CANONICAL_ID, row.kind, rowPayload(row));
  const transport = createMockTransport(scenario, rng, startMs);
  const events: KeeperEvents = { rotated: [], revoked: [], deferred: [] };
  const foreground: { handler: ((state: string) => void) | null } = {
    handler: null,
  };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = transport.fetch as unknown as typeof fetch;
  const failures: Failure[] = [];
  const fail = (invariant: string, detail: string) =>
    failures.push({ invariant, detail });
  const drains: DrainRecord[] = [];
  let finalBearer: string | null = null;
  let virtualElapsedMs = 0;

  try {
    wireSession(transport, scenario, startMs, events, foreground);

    if (scenario.auth === 'refreshing') {
      refreshSessionNow();
      await jest.advanceTimersByTimeAsync(scenario.refreshingLeadMs);
    }

    // Sequential requests: each non-shot row is its own request, shots are
    // one request, trials one request.
    const nonShotRows = scenario.rows.filter(
      r => r.kind === 'session.create' || r.kind === 'session.finalize',
    ).length;
    const drainBoundMs = (nonShotRows + 2) * (API_REQUEST_TIMEOUT_MS + 1_000);

    // Phase 1: the cell's network profile. The AppState 'active' event is
    // injected from the clock loop while the drain is in progress (or after
    // it, if the drain settled first — either is a valid interleaving).
    const foregroundAt = scenario.foregroundAtMs;
    let foregroundFired = false;
    const maybeForeground = () => {
      if (
        foregroundAt !== null &&
        !foregroundFired &&
        Date.now() - startMs >= foregroundAt
      ) {
        foregroundFired = true;
        foreground.handler?.('active');
      }
    };
    const drain1 = await runDrain(
      db,
      transport,
      drainBoundMs,
      startMs,
      maybeForeground,
    );
    drains.push(drain1);
    if (!drain1.settled) {
      fail(
        'I1.drain-bounded',
        `drainOutbox did not settle within ${drainBoundMs}ms (+${API_REQUEST_TIMEOUT_MS * 2}ms grace)`,
      );
    } else if (drain1.durationMs > drainBoundMs) {
      fail(
        'I1.drain-bounded',
        `drainOutbox took ${drain1.durationMs}ms > bound ${drainBoundMs}ms`,
      );
    }
    if (drain1.error) {
      fail('I1.drain-throws', `drainOutbox rejected: ${drain1.error}`);
    }

    // Phase-1 attempt accounting: only client-side corrupt rows and
    // server contract rejections may consume the budget.
    for (const row of outbox) {
      const seeded = scenario.rows.find(r => rowPayload(r) === row.payload);
      if (!seeded) continue;
      if (row.attempts > 0 && !seeded.corrupt && !seeded.permanentReject) {
        fail(
          'I3.transient-never-consumes-budget',
          `${seeded.kind} ${seeded.entityId} attempts=${row.attempts} last_error=${row.last_error}`,
        );
      }
    }

    // Phase 2: network recovers; drains must converge.
    await advanceUntil(
      () => Date.now() - startMs >= scenario.recoverAtMs,
      scenario.recoverAtMs + 1_000,
      maybeForeground,
    );
    if (foregroundAt !== null && !foregroundFired) {
      foregroundFired = true;
      foreground.handler?.('active');
    }
    transport.setNetwork('normal');
    const retryableLeft = () => outbox.filter(r => r.attempts === 0).length;
    // Recovery drains follow syncRuntime's cadence: 30 s × 2^failures,
    // capped at 5 min, ±20 % jitter — the phase-1 drain counts as failure 1
    // when it left rows behind.
    let consecutiveFailures = drain1.result && drain1.result.failed > 0 ? 1 : 0;
    let converged = retryableLeft() === 0;
    for (let i = 0; i < RECOVERY_DRAINS && !converged; i++) {
      await jest.advanceTimersByTimeAsync(
        syncRetryDelayMs(consecutiveFailures, rng),
      );
      const drain = await runDrain(db, transport, drainBoundMs, startMs);
      drains.push(drain);
      if (!drain.settled) {
        fail('I1.drain-bounded', `recovery drain #${i + 1} did not settle`);
        break;
      }
      if (drain.error) {
        fail(
          'I1.drain-throws',
          `recovery drain #${i + 1} rejected: ${drain.error}`,
        );
      }
      consecutiveFailures =
        drain.error || (drain.result && drain.result.failed > 0)
          ? consecutiveFailures + 1
          : 0;
      converged = retryableLeft() === 0;
    }
    if (!converged) {
      fail(
        'I2.converges-after-recovery',
        `${retryableLeft()} retryable row(s) still queued after ${RECOVERY_DRAINS} recovery drains: ${JSON.stringify(
          outbox
            .filter(r => r.attempts === 0)
            .map(r => ({
              kind: r.kind,
              last_error: r.last_error,
            })),
        )}`,
      );
    }

    // Let the keeper's backoff/rotation settle (10 virtual minutes).
    await jest.advanceTimersByTimeAsync(10 * 60_000);

    // I2: no loss — a row leaves the outbox only once the server holds it.
    for (const seeded of scenario.rows) {
      const payload = rowPayload(seeded);
      const still = outbox.some(r => r.payload === payload);
      if (still) continue;
      const held =
        seeded.kind === 'shot.sync'
          ? transport.server.acceptedShots.has(seeded.entityId)
          : seeded.kind === 'session.create'
            ? transport.server.createdSessions.has(seeded.entityId)
            : seeded.kind === 'session.finalize'
              ? transport.server.finalizedSessions.has(seeded.entityId)
              : transport.server.acceptedTrials.has(seeded.entityId);
      if (!held) {
        fail(
          'I2.no-loss',
          `${seeded.kind} ${seeded.entityId} left the outbox but the server never accepted it`,
        );
      }
      if (seeded.kind === 'shot.sync') {
        const receipt = receipts.some(r => r.entityId === seeded.entityId);
        if (!receipt) {
          fail(
            'I2.receipt',
            `shot ${seeded.entityId} deleted from outbox without a sync_receipt`,
          );
        }
      }
    }
    // Permanent rows are still here with attempts == server/client visits.
    for (const seeded of scenario.rows) {
      const row = outbox.find(r => r.payload === rowPayload(seeded));
      if (!row) continue;
      if (seeded.corrupt) {
        if (row.attempts === 0) {
          fail(
            'I3.permanent-consumes-budget',
            `corrupt ${seeded.kind} ${seeded.entityId} has attempts=0`,
          );
        }
        continue;
      }
      if (seeded.permanentReject) {
        const visits = transport.server.visits.get(seeded.entityId) ?? 0;
        if (visits > 0 && row.attempts === 0) {
          fail(
            'I3.permanent-consumes-budget',
            `${seeded.kind} ${seeded.entityId} rejected by server ${visits}x but attempts=0`,
          );
        }
        if (row.attempts > Math.min(visits, OUTBOX_MAX_ATTEMPTS)) {
          fail(
            'I3.attempts-le-visits',
            `${seeded.kind} ${seeded.entityId} attempts=${row.attempts} > server visits=${visits}`,
          );
        }
        continue;
      }
      // Neither corrupt nor permanently rejected: must be gone after recovery.
      fail(
        'I2.retryable-row-stuck',
        `${seeded.kind} ${seeded.entityId} still queued (attempts=${row.attempts}, last_error=${row.last_error})`,
      );
    }

    // I4: bearer discipline.
    const minted = new Set(['B0']);
    for (let i = 1; i <= transport.server.mintCounter; i++) minted.add(`B${i}`);
    for (const entry of transport.log) {
      if (entry.url.endsWith('/v1/auth/refresh')) {
        if (entry.bearer !== null) {
          fail(
            'I4.refresh-has-no-bearer',
            `refresh sent bearer ${entry.bearer}`,
          );
        }
        continue;
      }
      if (entry.bearer === null) {
        fail(
          'I4.bearer-present',
          `${entry.url} at +${entry.atMs}ms sent without a bearer (session=${entry.currentBearerAtSend})`,
        );
        continue;
      }
      if (entry.bearer.startsWith('R')) {
        fail(
          'I4.refresh-token-leak',
          `${entry.url} sent refresh token as bearer`,
        );
      }
      if (!minted.has(entry.bearer)) {
        fail('I4.unknown-bearer', `${entry.url} sent ${entry.bearer}`);
      }
      if (entry.bearer !== entry.currentBearerAtSend) {
        fail(
          'I4.stale-bearer',
          `${entry.url} at +${entry.atMs}ms sent ${entry.bearer} while current was ${entry.currentBearerAtSend}`,
        );
      }
    }
    // After a rotation landed, no later request may carry the pre-rotation bearer.
    for (const rotation of events.rotated) {
      for (const entry of transport.log) {
        if (entry.url.endsWith('/v1/auth/refresh')) continue;
        if (entry.atMs > rotation.atMs && entry.bearer !== null) {
          const sentGen = Number(entry.bearer.slice(1));
          const rotGen = Number(rotation.bearer.slice(1));
          if (sentGen < rotGen) {
            fail(
              'I4.pre-rotation-bearer-after-rotation',
              `${entry.url} at +${entry.atMs}ms sent ${entry.bearer} after rotation to ${rotation.bearer} at +${rotation.atMs}ms`,
            );
          }
        }
      }
    }

    // I5: never more than one refresh in flight.
    if (transport.server.maxRefreshInflight > 1) {
      fail(
        'I5.single-refresh-inflight',
        `server saw ${transport.server.maxRefreshInflight} concurrent refreshes`,
      );
    }

    // I6: no spurious sign-out. The server only refuses a refresh when the
    // family is dead; nothing in this matrix revokes it.
    if (transport.server.refreshRefusals > 0) {
      fail(
        'I6.server-refused-refresh',
        `server refused ${transport.server.refreshRefusals} refresh(es) — client presented a token that was neither active nor the parent of the active one`,
      );
    }
    if (events.revoked.length > 0) {
      fail(
        'I6.no-spurious-signout',
        `onRevoked fired at +${events.revoked.join(',+')}ms`,
      );
    }
    const session = getApiSession();
    const sawUnauthorized = transport.log.some(e => e.outcome === '401');
    if (!session || session.canonicalAppUserId !== CANONICAL_ID) {
      fail('I6.session-kept', 'ApiSession is gone at the end of the scenario');
    } else if (
      sawUnauthorized &&
      !transport.server.validBearers.has(session.bearerToken)
    ) {
      fail(
        'I6.final-bearer-valid',
        `final bearer ${session.bearerToken} is not accepted by the server`,
      );
    } else if (
      session.refreshToken !== transport.server.activeRefreshToken &&
      !(
        transport.server.refreshTokens.get(session.refreshToken ?? '')
          ?.child === transport.server.activeRefreshToken
      )
    ) {
      fail(
        'I6.refresh-token-recoverable',
        `client holds ${session.refreshToken}, server active is ${transport.server.activeRefreshToken} and the client's is not its parent`,
      );
    }

    // I7: when the bearer was rejected, the keeper must have rotated it.
    if (sawUnauthorized && events.rotated.length === 0) {
      fail(
        'I7.401-triggers-rotation',
        'a 401 for the current bearer never led to a rotation',
      );
    }
    // A 401 for a bearer that was already replaced must not trigger a
    // second rotation on its own: rotations ≤ distinct rejected bearers + 1
    // (the +1 covers the proactive `refreshing` rotation).
    const rejectedBearers = new Set(
      transport.log.filter(e => e.outcome === '401').map(e => e.bearer),
    );
    if (events.rotated.length > rejectedBearers.size + 1) {
      fail(
        'I7.no-rotation-storm',
        `${events.rotated.length} rotations for ${rejectedBearers.size} rejected bearer(s)`,
      );
    }
  } finally {
    finalBearer = getApiSession()?.bearerToken ?? null;
    virtualElapsedMs = Date.now() - startMs;
    stopSessionKeeper();
    setApiUnauthorizedListener(null);
    // I8: timer hygiene — after the keeper stops, only the mock transport's
    // own latency timers may be outstanding.
    const pending = jest.getTimerCount() - transport.pendingLatencyTimers();
    if (pending > 0) {
      fail(
        'I8.timer-leak',
        `${pending} timer(s) still pending after stopSessionKeeper()`,
      );
    }
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS * 4);
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    globalThis.fetch = previousFetch;
    jest.restoreAllMocks();
    jest.useRealTimers();
  }

  const apiLog = transport.log.filter(e => !e.url.endsWith('/v1/auth/refresh'));
  const refreshLog = transport.log.filter(e =>
    e.url.endsWith('/v1/auth/refresh'),
  );
  return {
    network,
    auth,
    seed,
    combinationSeed: combinationSeed(network, auth, seed),
    replay: `MATRIX_ONLY=${network}:${auth}:${seed} npx jest --ci __tests__/matrix/networkAuthMatrix.test.ts`,
    ok: failures.length === 0,
    failures,
    scenario: { ...scenario, rowCount: scenario.rows.length },
    stats: {
      requests: transport.log.length,
      apiRequests: apiLog.length,
      refreshRequests: refreshLog.length,
      aborted: transport.log.filter(
        e => e.outcome === 'lost-request' || e.outcome === 'lost-response',
      ).length,
      lostRequests: transport.log.filter(e => e.outcome === 'lost-request')
        .length,
      lostResponses: transport.log.filter(e => e.outcome === 'lost-response')
        .length,
      unauthorized: transport.log.filter(e => e.outcome === '401').length,
      rotations: events.rotated.length,
      refreshReuseServed: transport.server.refreshReuseServed,
      refreshRefusals: transport.server.refreshRefusals,
      maxRefreshInflight: transport.server.maxRefreshInflight,
      revoked: events.revoked.length,
      deferred: events.deferred.length,
      drains,
      remainingRows: outbox.length,
      remainingRetryable: outbox.filter(r => r.attempts === 0).length,
      receipts: receipts.length,
      finalBearer,
      virtualElapsedMs,
    },
  };
}
