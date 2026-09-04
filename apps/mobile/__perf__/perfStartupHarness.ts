/**
 * xc-perf-startup-hydrate — shared fake-clock instrumentation for the launch
 * hydration harnesses (`perfStartupHydrateTimeline.test.ts`,
 * `perfStartupGateLaunch.test.tsx`).
 *
 * Every I/O seam the launch path touches is replaced by an instrumented fake
 * that (a) records start/end on the FAKE clock and (b) costs a configurable
 * amount of fake time, so a launch's wall-clock is fully determined by the
 * scenario inputs and every timeline is replayable from its seed.
 *
 *   - SQLite kv  : `getDb().execute` (SELECT / INSERT OR REPLACE on kv,
 *                  outbox reads issued by the sync runtime)
 *   - Keychain   : react-native-keychain auto-mock wrapped with latency
 *   - Network    : `globalThis.fetch`, route table with latency / hang /
 *                  status, honouring AbortSignal so the 15s request timeouts
 *                  in sessionLifecycle.ts / onboarding.ts fire for real
 *
 * Nothing here touches production code. Artifacts go to `XC_PERF_OUT_DIR`
 * (default `<repo>/artifacts/xc-perf-startup-hydrate`, git-ignored).
 */
import type { LocalDb } from '../src/data/db';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import { canonicalDataOwner } from '../src/data/accountScope';

// ─── Clock + event log ───────────────────────────────────────────────────────

export interface IoEvent {
  seq: number;
  kind: 'sqlite' | 'keychain' | 'fetch' | 'mark';
  op: string;
  detail: string;
  startMs: number;
  endMs: number | null;
  result?: string;
}

/** Fixed fake epoch so timelines are comparable across runs. */
export const T0 = 1_760_000_000_000;
export const log: IoEvent[] = [];
let seq = 0;
export const nowMs = (): number => Date.now() - T0;

export function begin(
  kind: IoEvent['kind'],
  op: string,
  detail: string,
): IoEvent {
  const event: IoEvent = {
    seq: seq++,
    kind,
    op,
    detail,
    startMs: nowMs(),
    endMs: null,
  };
  log.push(event);
  return event;
}
export function end(event: IoEvent, result?: string): void {
  event.endMs = nowMs();
  if (result !== undefined) event.result = result;
}
export function mark(op: string, detail = ''): IoEvent {
  const event = begin('mark', op, detail);
  event.endMs = event.startMs;
  return event;
}
export function resetLog(): void {
  log.length = 0;
  seq = 0;
}

export const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise<void>(r => setTimeout(r, ms)) : Promise.resolve();

// ─── Latency knobs (fake ms) ─────────────────────────────────────────────────

export interface LatencyProfile {
  sqliteReadMs: number;
  sqliteWriteMs: number;
  keychainReadMs: number;
  keychainWriteMs: number;
}
export const ZERO_LATENCY: LatencyProfile = {
  sqliteReadMs: 0,
  sqliteWriteMs: 0,
  keychainReadMs: 0,
  keychainWriteMs: 0,
};
/** Order-of-magnitude device numbers used for the named scenarios (INFERRED, not measured on iOS). */
export const REALISTIC_LATENCY: LatencyProfile = {
  sqliteReadMs: 4,
  sqliteWriteMs: 8,
  keychainReadMs: 25,
  keychainWriteMs: 30,
};
let latency: LatencyProfile = ZERO_LATENCY;
export const getLatency = (): LatencyProfile => latency;
export const setLatency = (next: LatencyProfile): void => {
  latency = next;
};

// ─── SQLite seam ─────────────────────────────────────────────────────────────

export const mockKv = new Map<string, string>();
export const mockOutbox: Array<Record<string, unknown>> = [];

export function createInstrumentedDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const event = begin('sqlite', 'kv.get', String(params[0]));
        await sleep(latency.sqliteReadMs);
        const value = mockKv.get(String(params[0]));
        end(event, value === undefined ? 'miss' : 'hit');
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        const event = begin('sqlite', 'kv.set', String(params[0]));
        await sleep(latency.sqliteWriteMs);
        mockKv.set(String(params[0]), String(params[1]));
        end(event);
        return { rows: [] };
      }
      if (
        statement.startsWith('SELECT id, kind, payload, attempts FROM outbox')
      ) {
        const event = begin('sqlite', 'outbox.select', String(params[0]));
        await sleep(latency.sqliteReadMs);
        end(event, `${mockOutbox.length} rows`);
        return { rows: mockOutbox.slice(0, 50) };
      }
      const event = begin('sqlite', 'other', statement.slice(0, 60));
      await sleep(latency.sqliteWriteMs);
      end(event);
      return { rows: [] };
    },
    close() {},
  };
}

// ─── Keychain seam ───────────────────────────────────────────────────────────

type KeychainFn = (...args: unknown[]) => Promise<unknown>;

/** Wraps the in-memory `__mocks__/react-native-keychain` with latency + logging. */
export function wrapKeychain(
  actual: Record<string, unknown>,
): Record<string, unknown> {
  const wrap = (name: string, isWrite: boolean): KeychainFn => {
    const fn = actual[name] as KeychainFn;
    return async (...args: unknown[]) => {
      const event = begin('keychain', name, '');
      await sleep(isWrite ? latency.keychainWriteMs : latency.keychainReadMs);
      const result = await fn(...args);
      end(event, result === false ? 'absent' : 'ok');
      return result;
    };
  };
  return {
    ...actual,
    getGenericPassword: wrap('getGenericPassword', false),
    setGenericPassword: wrap('setGenericPassword', true),
    resetGenericPassword: wrap('resetGenericPassword', true),
  };
}

// ─── Network seam ────────────────────────────────────────────────────────────

export const API_BASE_URL = 'https://api.example.test';

export type RouteBehaviour =
  | { mode: 'respond'; latencyMs: number; status: number; body: unknown }
  | { mode: 'network-error'; latencyMs: number }
  | { mode: 'hang' };

let routes: Record<string, RouteBehaviour> = {};
export function setRoutes(next: Record<string, RouteBehaviour>): void {
  routes = next;
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

export function installFetch(): jest.Mock {
  const fetchMock = jest.fn((url: string, init?: RequestInit) => {
    const pathName = url.replace(API_BASE_URL, '');
    const behaviour: RouteBehaviour = routes[pathName] ?? {
      mode: 'network-error',
      latencyMs: 0,
    };
    const method = init?.method ?? 'GET';
    const event = begin('fetch', `${method} ${pathName}`, behaviour.mode);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const onAbort = () => {
        if (timer) clearTimeout(timer);
        end(event, 'aborted');
        reject(abortError());
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      if (behaviour.mode === 'hang') return;
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        if (behaviour.mode === 'network-error') {
          end(event, 'network-error');
          reject(new TypeError('Network request failed'));
          return;
        }
        end(event, `HTTP ${behaviour.status}`);
        resolve({
          ok: behaviour.status >= 200 && behaviour.status < 300,
          status: behaviour.status,
          json: async () => behaviour.body,
        } as unknown as Response);
      }, behaviour.latencyMs);
    });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

export const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const OWNER = canonicalDataOwner(CANONICAL_ID);
export const FAR_FUTURE_SECONDS = Math.floor(T0 / 1000) + 3600;

export const refreshBody = () => ({
  session: {
    accessToken: 'access-2',
    refreshToken: 'refresh-2',
    expiresAt: FAR_FUTURE_SECONDS,
  },
});

/** Local Profile shape (appStore) and the server wire shape (/v1/me). */
export const PROFILE = {
  skillLevel: '3.5',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'pop-ups',
  focusCheckpoint: 'contact_position',
};
export const SERVER_PROFILE = {
  skill_level: '3.5',
  handedness: 'right',
  primary_goal: 'consistency',
  biggest_problem: 'pop-ups',
};
export const meBody = () => ({
  user: { id: CANONICAL_ID, email: 'pat@example.com' },
  onboardingState: 'complete',
  profile: SERVER_PROFILE,
});
export const meBodyNoProfile = () => ({
  user: { id: CANONICAL_ID, email: 'pat@example.com' },
  onboardingState: 'pending',
  profile: null,
});
export const onboardingPutBody = () => ({
  onboardingState: 'complete',
  profile: SERVER_PROFILE,
  recommendedCheckpoint: 'contact_position',
});

export interface KeychainItem {
  username: string;
  password: string;
}

export function seedVault(
  store: Map<string, KeychainItem>,
  provider: 'apple' | 'google' = 'apple',
  refreshToken = 'refresh-1',
): void {
  store.set(SESSION_VAULT_SERVICE, {
    username: 'session',
    password: JSON.stringify({
      version: 1,
      provider,
      canonicalAppUserId: CANONICAL_ID,
      refreshToken,
      email: 'pat@example.com',
      displayName: 'Pat Player',
    }),
  });
}

export function seedLocalProfile(owner: string): void {
  mockKv.set(`profile:${owner}`, JSON.stringify(PROFILE));
}
export function seedPendingPreAuthProfile(): void {
  mockKv.set(
    'onboarding.pending-profile',
    JSON.stringify({ version: 1, profile: PROFILE }),
  );
}
export function seedGuestMarker(): void {
  mockKv.set('auth.local-mode', JSON.stringify({ version: 1, mode: 'guest' }));
}
export function seedLegacySessionKey(): void {
  mockKv.set('auth.session', '{"legacy":true}');
}
export function seedLastProviderGoogle(): void {
  mockKv.set(
    'auth.last-provider',
    JSON.stringify({ version: 1, provider: 'google' }),
  );
}

// ─── Fake-timer driver ───────────────────────────────────────────────────────

/**
 * Advances the fake clock timer-by-timer until `promise` settles or the fake
 * clock passes `maxMs`. Timestamps are exact (no step quantisation) because
 * we only ever jump to the next scheduled timer.
 */
export async function driveUntilSettled<T>(
  promise: Promise<T>,
  maxMs = 120_000,
): Promise<{ settled: boolean; elapsedMs: number }> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  const start = nowMs();
  await flushMicrotasks(20);
  while (!settled && nowMs() - start < maxMs) {
    if (jest.getTimerCount() === 0) {
      await flushMicrotasks(50);
      if (!settled) break; // nothing scheduled and still pending: deadlock
      continue;
    }
    await jest.advanceTimersToNextTimerAsync();
    await flushMicrotasks(20);
  }
  return { settled, elapsedMs: nowMs() - start };
}

export async function flushMicrotasks(rounds: number): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
}

// ─── Critical-path analysis ─────────────────────────────────────────────────

export interface Analysis {
  wallMs: number;
  ioCount: number;
  /** Union of I/O intervals. */
  ioBusyMs: number;
  /** Sum of I/O durations — what a fully serial path costs. */
  serialChainMs: number;
  maxConcurrency: number;
  /** Wall time with no I/O in flight (pure waiting / JS). */
  idleMs: number;
}

export function analyse(events: IoEvent[], wallMs: number): Analysis {
  const io = events.filter(e => e.kind !== 'mark');
  const intervals = io.map(e => [e.startMs, e.endMs ?? wallMs] as const);
  intervals.sort((a, b) => a[0] - b[0]);
  let busy = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const [s, e] of intervals) {
    if (s > curEnd) {
      if (curEnd >= 0) busy += curEnd - curStart;
      curStart = s;
      curEnd = e;
    } else curEnd = Math.max(curEnd, e);
  }
  if (curEnd >= 0) busy += curEnd - curStart;
  let maxConcurrency = 0;
  for (const [s] of intervals) {
    const n = intervals.filter(([a, b]) => a <= s && s < b).length;
    maxConcurrency = Math.max(maxConcurrency, n);
  }
  return {
    wallMs,
    ioCount: io.length,
    ioBusyMs: busy,
    serialChainMs: intervals.reduce((acc, [s, e]) => acc + (e - s), 0),
    maxConcurrency,
    idleMs: wallMs - busy,
  };
}

export function formatOp(e: IoEvent): string {
  return `${e.startMs}-${e.endMs ?? '∞'} ${e.kind}:${e.op} ${e.detail} ${e.result ?? ''}`.trim();
}

// ─── Deterministic PRNG (mulberry32) ─────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0
  );
}

// ─── Node access (the mobile tsconfig has no @types/node; same typed-require
// convention as __tests__/wf/be-mobile-security-secrets.test.ts) ────────────

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
};

export const nodeEnv: Record<string, string | undefined> = process.env;
export const nodeFs = require('fs') as {
  mkdirSync(dir: string, opts: { recursive: boolean }): void;
  writeFileSync(file: string, data: string): void;
  rmSync(path: string, opts: { recursive?: boolean; force?: boolean }): void;
};
export const nodePath = require('path') as {
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
};
export const nodePerf = require('perf_hooks') as {
  performance: { now(): number };
};
export const nodeOs = require('os') as {
  platform(): string;
  arch(): string;
  cpus(): Array<{ model: string }>;
};

// ─── Artifacts ───────────────────────────────────────────────────────────────

export const OUT_DIR =
  nodeEnv.XC_PERF_OUT_DIR ??
  nodePath.resolve(__dirname, '../../../artifacts/xc-perf-startup-hydrate');

export function writeArtifact(name: string, data: unknown): string {
  nodeFs.mkdirSync(OUT_DIR, { recursive: true });
  const file = nodePath.join(OUT_DIR, name);
  nodeFs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function heapSnapshot(): { heapUsedMb: number; rssMb: number } {
  const m = process.memoryUsage();
  return {
    heapUsedMb: Math.round((m.heapUsed / 1024 / 1024) * 10) / 10,
    rssMb: Math.round((m.rss / 1024 / 1024) * 10) / 10,
  };
}

/** Constants pinned in production source (asserted by the harnesses, never edited). */
export const LAUNCH_REFRESH_WAIT_MS = 8_000; // src/auth/authStore.ts
export const REQUEST_TIMEOUT_MS = 15_000; // src/account/sessionLifecycle.ts, src/account/onboarding.ts
export const SPLASH_WATCHDOG_MS = 8_000; // src/screens/SplashScreen.tsx WATCHDOG_MS
