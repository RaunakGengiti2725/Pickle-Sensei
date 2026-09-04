/**
 * LIFECYCLE INTERRUPTION stress harness for DrillLibraryScreen.
 *
 * The real screen is mounted inside the real `NavigationContainer` +
 * native-stack navigator, backed by the real Zustand api-session store, the
 * real account-scope owner, the real SQLite repository (op-sqlite replaced by
 * an in-memory `node:sqlite` database) and the real training API client.
 * Only native modules (safe-area, WebView, op-sqlite, AppState/Linking) and
 * `fetch` are replaced; `fetch` is routed to an in-process fake server whose
 * responses are released one at a time by the seeded schedule so every
 * interleaving is replayable from its seed.
 *
 * Interruptions modelled per iteration: background/foreground, unmount while a
 * catalog/detail/save request is in flight, kill+relaunch (re-hydrate from
 * SQLite + server), navigate-away/back, token rotation (with and without the
 * old token being invalidated), server-side revocation (401 -> unauthorized
 * listener -> sign-out), permission revoke-later (403 on save/unsave), and an
 * account switch performed both the way the app does it (sign out, unmount,
 * sign in, mount) and adversarially in place (session swapped under a
 * mounted screen).
 *
 * Invariants asserted after every iteration reaches quiescence:
 *  - no React/RN console.error (state updates on unmounted trees, act, ...)
 *  - every request carried the bearer token of the account signed in when it
 *    was sent; no request was sent after the screen was unmounted
 *  - unauthorized sign-out fires only for the *current* bearer, never for a
 *    rotated/stale one
 *  - saved badges == server truth for the signed-in account, no button stuck
 *    pending, no detail stuck loading
 *  - after an account switch no marker text / focus card of the previous
 *    account is rendered (violations caused solely by the adversarial
 *    in-place swap are reported as ADVERSARIAL_ONLY, not BROKEN — the
 *    App.tsx owner gate makes that path unreachable in the product)
 *  - two consecutive relaunches against unchanged persisted state render the
 *    same durable projection (idempotent re-hydrate)
 *  - after the final unmount: zero pending fake timers, every AppState/Linking
 *    subscription removed
 *
 * Campaign seeds are 1..STRESS_ITER; a seed whose violations are reachable in
 * the product fails its test (BROKEN) — that is the point of the campaign.
 * The "probe" tests record a specific race's outcome into the summary
 * artifact (`observations`) and assert only what must hold either way.
 *
 * Env:  STRESS_ITER=<n>    iterations of the seeded campaign (default 12;
 *                          the release campaign runs >= 100)
 *       STRESS_SEED=<n>    replay a single seed
 *       STRESS_OUT=<dir>   JSON artifacts (default apps/mobile/artifacts/stress)
 *
 * Run:  cd apps/mobile && STRESS_ITER=120 npx jest --ci --detectOpenHandles \
 *         __tests__/stress/drillLibraryScreenLifecycle.stress.test.tsx
 */
import React, { useEffect } from 'react';
import { AppState, Linking, Pressable, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  NavigationContainer,
  useNavigation,
  type NavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

jest.mock(
  'react-native-safe-area-context',
  () => jest.requireActual('react-native-safe-area-context/jest/mock').default,
);

jest.mock('react-native-webview', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const MockWebView = (props: Record<string, unknown>) =>
    ReactModule.createElement(RN.View, props);
  return { __esModule: true, default: MockWebView, WebView: MockWebView };
});

jest.mock('@op-engineering/op-sqlite', () => {
  const { DatabaseSync } = jest.requireActual<{
    DatabaseSync: new (location: string) => {
      prepare(sql: string): {
        all(...p: unknown[]): Record<string, unknown>[];
      };
      close(): void;
    };
  }>('node:sqlite');
  const real = new DatabaseSync(':memory:');
  const handle = {
    executeSync: (sql: string) => ({ rows: real.prepare(sql).all() }),
    execute: async (sql: string, params: unknown[] = []) => ({
      rows: real.prepare(sql).all(...params),
    }),
    close: () => {},
  };
  return { open: () => handle, __handle: handle };
});

import { DrillLibraryScreen } from '../../src/screens/DrillLibraryScreen';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { getDb } from '../../src/data/db';

declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: { env: Record<string, string | undefined> };
const { mkdirSync, writeFileSync } = require('fs') as {
  mkdirSync: (path: string, options: { recursive: boolean }) => void;
  writeFileSync: (path: string, data: string) => void;
};
const { join } = require('path') as { join: (...parts: string[]) => string };

const ITERATIONS = Number(process.env.STRESS_ITER ?? 12);
const ONLY_SEED =
  process.env.STRESS_SEED !== undefined
    ? Number(process.env.STRESS_SEED)
    : null;
const OUT_DIR =
  process.env.STRESS_OUT ?? join(__dirname, '..', '..', 'artifacts', 'stress');
const STEPS_PER_ITERATION = 28;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every iteration is replayable from its seed.
// ---------------------------------------------------------------------------
class Rng {
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
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

// ---------------------------------------------------------------------------
// Accounts, fixtures
// ---------------------------------------------------------------------------
type AccountId = 'A' | 'B';
const ACCOUNTS: Record<AccountId, { userId: string; tokenPrefix: string }> = {
  A: {
    userId: '11111111-1111-4111-8111-111111111111',
    tokenPrefix: 'tok-A',
  },
  B: {
    userId: '22222222-2222-4222-8222-222222222222',
    tokenPrefix: 'tok-B',
  },
};
const API_BASE = 'https://stress.invalid';

/** Wire format of `GET /v1/catalog/drills` items (parsed by the real client). */
interface WireDrill {
  id: string;
  slug: string;
  title: string;
  description: string;
  coach_name: string;
  equipment: string[];
  difficulty_min: string | null;
  difficulty_max: string | null;
  families: string[];
  validation_state: string;
  saved: boolean;
}

function drill(
  index: number,
  slug: string,
  title: string,
  families: string[],
  description = `${title} description`,
): WireDrill {
  return {
    id: `0000000${index}-0000-4000-8000-00000000000${index}`,
    slug,
    title,
    description,
    coach_name: 'Stress Coach',
    equipment: ['paddle'],
    difficulty_min: 'beginner',
    difficulty_max: 'intermediate',
    families,
    validation_state: 'UNVALIDATED',
    saved: false,
  };
}

const BASE_CATALOG: readonly WireDrill[] = [
  drill(1, 'wall-dinks', 'Wall Dinks', ['dink']),
  drill(2, 'crosscourt-dink', 'Crosscourt Dink Rally', ['dink', 'drop_reset']),
  drill(3, 'volley-blocks', 'Volley Blocks', ['volley']),
  drill(4, 'third-shot-drop', 'Third Shot Drop', ['drive', 'drop_reset']),
  drill(5, 'serve-targets', 'Serve Targets', ['serve']),
  drill(6, 'footwork-ladder', 'Footwork Ladder', ['global']),
];
const MARKER_SLUG: Record<AccountId, string> = {
  A: 'marker-account-a',
  B: 'marker-account-b',
};
const MARKER_TITLE: Record<AccountId, string> = {
  A: 'Marker Alpha Only',
  B: 'Marker Bravo Only',
};
const MARKER_INDEX: Record<AccountId, number> = { A: 7, B: 8 };

function detailFor(base: WireDrill, saved: boolean): unknown {
  return {
    drill: { ...base, saved },
    mappings: [
      {
        checkpoint: 'paddle_set',
        shot_type: 'dink',
        plan_role: 'targeted',
        fault_directions: ['low'],
        cue_text: `${base.title} cue`,
        target_sets: 2,
        target_repetitions_per_set: 10,
        target_duration_seconds: null,
        rest_seconds: 30,
      },
    ],
    instructionalMedia: [
      {
        id: '99999999-9999-4999-8999-999999999999',
        kind: 'embed',
        provider: 'youtube',
        videoId: 'stress123',
        embedUrl: 'https://www.youtube-nocookie.com/embed/stress123',
        sourceUrl: 'https://www.youtube.com/watch?v=stress123',
        creatorName: 'Stress Channel',
        licenseName: 'Standard YouTube License',
        licenseUrl: null,
        attribution: 'Stress Channel on YouTube',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fake server: pending requests are released by the schedule, responses are
// computed against server state *at release time*.
// ---------------------------------------------------------------------------
type ResponseMode =
  | 'ok'
  | 'unauthorized'
  | 'forbidden'
  | 'server_error'
  | 'network'
  | 'malformed';

interface FakeResponse {
  status: number;
  ok: boolean;
  json(): Promise<unknown>;
}

interface PendingRequest {
  id: number;
  method: string;
  path: string;
  query: Record<string, string>;
  token: string | null;
  sentAtStep: number;
  mountedWhenSent: boolean;
  accountWhenSent: AccountId | null;
  tokenOwner: AccountId | null;
  tokenWasCurrent: boolean;
  /** Saved-set as it stood when the request arrived: a read the server
   *  processed immediately whose response is merely late on the wire. */
  savedAtSend: Record<AccountId, Set<string>>;
  resolve(response: FakeResponse): void;
  reject(error: Error): void;
}

interface RequestLogEntry {
  id: number;
  method: string;
  path: string;
  sentAtStep: number;
  tokenOwner: AccountId | null;
  tokenWasCurrent: boolean;
  accountWhenSent: AccountId | null;
  mountedWhenSent: boolean;
  releasedAtStep: number | null;
  mode: ResponseMode | null;
  status: number | null;
}

class FakeServer {
  pending: PendingRequest[] = [];
  log: RequestLogEntry[] = [];
  private nextId = 1;
  private tokens = new Map<string, AccountId>();
  private revoked = new Set<string>();
  saved: Record<AccountId, Set<string>> = { A: new Set(), B: new Set() };
  savesForbidden: Record<AccountId, boolean> = { A: false, B: false };
  /** Bumped whenever a mutation is applied; used for re-hydrate checks. */
  version = 0;
  currentStep = 0;
  isMounted: () => boolean = () => false;
  currentAccount: () => AccountId | null = () => null;
  currentToken: () => string | null = () => null;

  issueToken(account: AccountId, generation: number): string {
    const token = `${ACCOUNTS[account].tokenPrefix}-g${generation}`;
    this.tokens.set(token, account);
    return token;
  }
  invalidate(token: string): void {
    this.revoked.add(token);
  }
  tokenOwner(token: string | null): AccountId | null {
    if (!token || this.revoked.has(token)) return null;
    return this.tokens.get(token) ?? null;
  }

  fetch = (input: string, init?: { method?: string; headers?: unknown }) =>
    new Promise<FakeResponse>((resolve, reject) => {
      const url = new URL(input);
      const headers = init?.headers as
        | Record<string, string>
        | { get(name: string): string | null }
        | undefined;
      let auth: string | null = null;
      if (headers && typeof (headers as { get?: unknown }).get === 'function') {
        auth = (headers as { get(name: string): string | null }).get(
          'Authorization',
        );
      } else if (headers) {
        auth = (headers as Record<string, string>).Authorization ?? null;
      }
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
      const query: Record<string, string> = {};
      url.searchParams.forEach((value, key) => {
        query[key] = value;
      });
      const req: PendingRequest = {
        id: this.nextId++,
        method: (init?.method ?? 'GET').toUpperCase(),
        path: url.pathname,
        query,
        token,
        sentAtStep: this.currentStep,
        mountedWhenSent: this.isMounted(),
        accountWhenSent: this.currentAccount(),
        tokenOwner: token ? (this.tokens.get(token) ?? null) : null,
        tokenWasCurrent: token !== null && token === this.currentToken(),
        savedAtSend: { A: new Set(this.saved.A), B: new Set(this.saved.B) },
        resolve,
        reject,
      };
      this.pending.push(req);
      this.log.push({
        id: req.id,
        method: req.method,
        path: req.path,
        sentAtStep: req.sentAtStep,
        tokenOwner: req.tokenOwner,
        tokenWasCurrent: req.tokenWasCurrent,
        accountWhenSent: req.accountWhenSent,
        mountedWhenSent: req.mountedWhenSent,
        releasedAtStep: null,
        mode: null,
        status: null,
      });
    });

  /** `processedAtSend`: reads answer from the state at arrival time (the
   *  server handled them in order; only delivery is reordered). Default:
   *  reads answer from current state (the server handled them late). */
  release(
    req: PendingRequest,
    mode: ResponseMode,
    processedAtSend = false,
  ): void {
    this.pending = this.pending.filter(p => p !== req);
    const entry = this.log.find(e => e.id === req.id);
    const finish = (status: number | null) => {
      if (entry) {
        entry.releasedAtStep = this.currentStep;
        entry.mode = mode;
        entry.status = status;
      }
    };
    const json = (status: number, body: unknown): FakeResponse => ({
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    });
    if (mode === 'network') {
      finish(null);
      req.reject(new TypeError('Network request failed'));
      return;
    }
    if (mode === 'unauthorized') {
      finish(401);
      req.resolve(json(401, { error: 'unauthorized' }));
      return;
    }
    if (mode === 'server_error') {
      finish(500);
      req.resolve(json(500, { error: 'boom' }));
      return;
    }
    if (mode === 'malformed') {
      finish(200);
      req.resolve({
        status: 200,
        ok: true,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
      });
      return;
    }
    const owner = this.tokenOwner(req.token);
    if (!owner) {
      finish(401);
      req.resolve(json(401, { error: 'unauthorized' }));
      return;
    }
    if (mode === 'forbidden') {
      finish(403);
      req.resolve(json(403, { error: 'forbidden' }));
      return;
    }
    const savedSet = processedAtSend
      ? req.savedAtSend[owner]
      : this.saved[owner];
    const catalog = [
      ...BASE_CATALOG,
      drill(MARKER_INDEX[owner], MARKER_SLUG[owner], MARKER_TITLE[owner], [
        'dink',
      ]),
    ].map(d => ({ ...d, saved: savedSet.has(d.slug) }));

    if (req.method === 'GET' && req.path === '/v1/catalog/drills') {
      const q = (req.query.q ?? '').toLowerCase();
      const family = req.query.family;
      const items = catalog.filter(
        d =>
          (!q || d.title.toLowerCase().includes(q)) &&
          (!family || d.families.includes(family)),
      );
      finish(200);
      req.resolve(json(200, { items }));
      return;
    }
    const detailMatch = /^\/v1\/catalog\/drills\/([^/]+)$/.exec(req.path);
    if (req.method === 'GET' && detailMatch) {
      const slug = decodeURIComponent(detailMatch[1] ?? '');
      const base = catalog.find(d => d.slug === slug);
      if (!base) {
        finish(404);
        req.resolve(json(404, { error: 'not_found' }));
        return;
      }
      finish(200);
      req.resolve(json(200, detailFor(base, savedSet.has(slug))));
      return;
    }
    const saveMatch = /^\/v1\/me\/saved-drills\/([^/]+)$/.exec(req.path);
    if (saveMatch) {
      const slug = decodeURIComponent(saveMatch[1] ?? '');
      if (this.savesForbidden[owner]) {
        finish(403);
        req.resolve(json(403, { error: 'forbidden' }));
        return;
      }
      if (req.method === 'PUT') {
        this.saved[owner].add(slug);
        this.version++;
        finish(200);
        req.resolve(json(200, { slug, saved: true }));
        return;
      }
      if (req.method === 'DELETE') {
        this.saved[owner].delete(slug);
        this.version++;
        finish(204);
        req.resolve(json(204, null));
        return;
      }
    }
    finish(404);
    req.resolve(json(404, { error: 'not_found' }));
  }
}

// ---------------------------------------------------------------------------
// Native listener registries (AppState / Linking are jest mocks in the RN
// preset; we make them record subscriptions so leaks are observable).
// ---------------------------------------------------------------------------
interface Subscription {
  source: 'AppState' | 'Linking';
  event: string;
  handler: (...args: unknown[]) => void;
  removed: boolean;
}
const subscriptions: Subscription[] = [];

function installListenerRegistries() {
  const register =
    (source: Subscription['source']) =>
    (event: string, handler: (...args: unknown[]) => void) => {
      const sub: Subscription = { source, event, handler, removed: false };
      subscriptions.push(sub);
      return {
        remove: () => {
          sub.removed = true;
        },
      };
    };
  (AppState.addEventListener as unknown as jest.Mock).mockImplementation(
    register('AppState'),
  );
  (Linking.addEventListener as unknown as jest.Mock).mockImplementation(
    register('Linking'),
  );
  (Linking.getInitialURL as unknown as jest.Mock).mockImplementation(
    async () => null,
  );
  (Linking.openURL as unknown as jest.Mock).mockImplementation(
    async () => undefined,
  );
}

interface PendingTimer {
  type: string;
  delay: number | string;
  source: string;
}

/** Sinon fake-timers expose the clock on the faked function; read only to
 *  name pending timers in evidence, never for control flow. */
function pendingTimers(): PendingTimer[] {
  const clock = (setTimeout as unknown as { clock?: { timers?: unknown } })
    .clock;
  const timers = clock?.timers;
  if (!timers || typeof timers !== 'object') return [];
  return Object.values(timers as Record<string, unknown>).map(t => {
    const timer = t as { type?: string; delay?: number; func?: unknown };
    return {
      type: timer.type ?? '?',
      delay: timer.delay ?? '?',
      source: String(timer.func).replace(/\s+/g, ' ').slice(0, 160),
    };
  });
}

/** `@react-native/jest-preset`'s NativeAnimatedModule mock completes every
 *  native-driver animation with `setTimeout(() => endCallback(...), 16)`.
 *  That handle belongs to the Jest mock, not to the screen (on device the
 *  native animation is torn down with the view), so it is reported but not
 *  counted as a leak. Everything else pending after unmount is. */
const ANIMATED_MOCK_SOURCE = 'endCallback({ finished: true })';

function leakedTimers(): { leaked: PendingTimer[]; animatedMock: number } {
  const all = pendingTimers();
  const animated = all.filter(t => t.source.includes(ANIMATED_MOCK_SOURCE));
  const leaked = all.filter(t => !t.source.includes(ANIMATED_MOCK_SOURCE));
  if (all.length !== jest.getTimerCount()) {
    leaked.push({
      type: 'unknown',
      delay: '?',
      source: `clock reports ${jest.getTimerCount()} timers, introspection saw ${all.length}`,
    });
  }
  return { leaked, animatedMock: animated.length };
}

function emitAppState(state: 'background' | 'active' | 'inactive') {
  for (const sub of subscriptions) {
    if (sub.source === 'AppState' && sub.event === 'change' && !sub.removed) {
      sub.handler(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Navigator under test: the real DrillLibrary screen plus a stub destination
// so "navigate away / come back" keeps the screen mounted in the stack.
// ---------------------------------------------------------------------------
type StressStackParams = {
  DrillLibrary: undefined;
  Elsewhere: undefined;
  ConnectAccount: undefined;
};
const Stack = createNativeStackNavigator<StressStackParams>();

function Elsewhere() {
  const navigation = useNavigation();
  return (
    <View testID="elsewhere">
      <Pressable
        accessibilityLabel="Return to library"
        onPress={() => navigation.goBack()}
      >
        <Text>Elsewhere</Text>
      </Pressable>
    </View>
  );
}

function ConnectAccountStub() {
  return (
    <View testID="connect-account-stub">
      <Text>Connect account stub</Text>
    </View>
  );
}

let mountCount = 0;
let unmountCount = 0;
function MountProbe() {
  useEffect(() => {
    mountCount++;
    return () => {
      unmountCount++;
    };
  }, []);
  return null;
}

function LibraryWithProbe() {
  return (
    <>
      <MountProbe />
      <DrillLibraryScreen />
    </>
  );
}

// ---------------------------------------------------------------------------
// SQLite seeding: the real repository reads `local_shot` for the focus card.
// ---------------------------------------------------------------------------
const sqlite = (
  jest.requireMock('@op-engineering/op-sqlite') as {
    __handle: {
      execute(
        sql: string,
        params?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }>;
    };
  }
).__handle;

async function resetLocalShots(): Promise<void> {
  getDb();
  await sqlite.execute('DELETE FROM local_shot');
}

async function seedScoredShots(account: AccountId, count: number) {
  getDb();
  const owner = ACCOUNTS[account].userId;
  for (let i = 0; i < count; i++) {
    const id = `shot-${account}-${i}`;
    const capturedAt = `2026-01-0${(i % 9) + 1}T10:00:00.000Z`;
    const payload = {
      id,
      shotType: 'dink',
      capturedAtIso: capturedAt,
      source: 'real',
      resultKind: 'scored',
      checkpoints: [
        { key: 'paddle_set', score: 35 + i, applicable: true },
        { key: 'ready_position', score: 70, applicable: true },
      ],
    };
    await sqlite.execute(
      `INSERT OR REPLACE INTO local_shot
        (owner_key, id, session_id, shot_type, captured_at, overall_score, confidence, result_kind, source, favorite, payload)
       VALUES (?, ?, NULL, 'dink', ?, 5, 0.9, 'scored', 'real', 0, ?)`,
      [owner, id, capturedAt, JSON.stringify(payload)],
    );
  }
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
type Renderer = TestRenderer.ReactTestRenderer;

interface Violation {
  invariant: string;
  detail: string;
}

interface IterationResult {
  seed: number;
  steps: string[];
  requests: number;
  releasedBySchedule: number;
  violations: Violation[];
  consoleErrors: string[];
  outcome: 'HELD' | 'BROKEN' | 'ADVERSARIAL_ONLY';
  animatedMockTimersIgnored: number;
  durationMs: number;
}

interface DurableProjection {
  account: AccountId | null;
  cards: [string, boolean][];
  focus: string | null;
  focusHint: boolean;
}

class Harness {
  server = new FakeServer();
  renderer: Renderer | null = null;
  navRef = React.createRef<NavigationContainerRef<StressStackParams>>();
  account: AccountId | null = null;
  tokenGeneration = 0;
  steps: string[] = [];
  violations: Violation[] = [];
  consoleErrors: string[] = [];
  unauthorizedCalls: { bearerToken: string; account: string }[] = [];
  pendingSignOut = false;
  releasedBySchedule = 0;
  animatedMockTimersSeen = 0;
  private originalConsoleError = console.error;

  constructor(readonly rng: Rng) {
    this.server.isMounted = () => this.renderer !== null;
    this.server.currentAccount = () => this.account;
    this.server.currentToken = () => getApiSession()?.bearerToken ?? null;
  }

  async setup(): Promise<void> {
    subscriptions.length = 0;
    mountCount = 0;
    unmountCount = 0;
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await resetLocalShots();
    await seedScoredShots('A', 3);
    (globalThis as { fetch: unknown }).fetch = this.server.fetch;
    console.error = (...args: unknown[]) => {
      this.consoleErrors.push(
        args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 400) + (process.env.STRESS_DEBUG ? new Error().stack : ''),
      );
    };
    setApiUnauthorizedListener(expired => {
      this.unauthorizedCalls.push({
        bearerToken: expired.bearerToken,
        account: expired.canonicalAppUserId,
      });
      // Mirrors authStore: the synced runtime is torn down immediately and
      // the auth gate unmounts the signed-in tree on its next render.
      clearApiSession();
      setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
      this.account = null;
      this.pendingSignOut = true;
    });
  }

  teardown(): void {
    console.error = this.originalConsoleError;
    setApiUnauthorizedListener(null);
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  }

  record(step: string): void {
    this.steps.push(step);
    this.server.currentStep = this.steps.length;
  }

  fail(invariant: string, detail: string): void {
    this.violations.push({ invariant, detail });
  }

  // ---- session --------------------------------------------------------
  signIn(account: AccountId): void {
    this.tokenGeneration++;
    const token = this.server.issueToken(account, this.tokenGeneration);
    setActiveDataOwner(ACCOUNTS[account].userId);
    const session: ApiSession = {
      apiBaseUrl: API_BASE,
      bearerToken: token,
      canonicalAppUserId: ACCOUNTS[account].userId,
      provider: 'apple',
    };
    establishApiSession(session);
    this.account = account;
  }

  signOut(): void {
    clearApiSession();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    this.account = null;
  }

  rotateToken(invalidateOld: boolean): void {
    const current = getApiSession();
    if (!current || !this.account) return;
    this.tokenGeneration++;
    const token = this.server.issueToken(this.account, this.tokenGeneration);
    if (invalidateOld) this.server.invalidate(current.bearerToken);
    establishApiSession({ ...current, bearerToken: token });
  }

  // ---- mount / unmount ------------------------------------------------
  async mount(): Promise<void> {
    if (this.renderer) return;
    await act(async () => {
      this.renderer = TestRenderer.create(
        <NavigationContainer ref={this.navRef}>
          <Stack.Navigator>
            <Stack.Screen name="DrillLibrary" component={LibraryWithProbe} />
            <Stack.Screen name="Elsewhere" component={Elsewhere} />
            <Stack.Screen
              name="ConnectAccount"
              component={ConnectAccountStub}
            />
          </Stack.Navigator>
        </NavigationContainer>,
      );
    });
  }

  async unmount(): Promise<void> {
    const r = this.renderer;
    if (!r) return;
    this.renderer = null;
    await act(async () => {
      r.unmount();
    });
  }

  async settle(): Promise<void> {
    await act(async () => {});
    if (this.pendingSignOut) {
      this.pendingSignOut = false;
      await this.unmount();
    }
  }

  async advance(ms: number): Promise<void> {
    await act(async () => {
      jest.advanceTimersByTime(ms);
    });
  }

  // ---- queries ---------------------------------------------------------
  text(): string {
    if (!this.renderer) return '';
    return this.renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat()
      .filter((c): c is string => typeof c === 'string')
      .join(' ');
  }

  findAll(predicate: (n: TestRenderer.ReactTestInstance) => boolean) {
    return this.renderer ? this.renderer.root.findAll(predicate) : [];
  }

  /** Host nodes only (`type` is a string): composite wrappers such as
   *  `View` forward the same testID one level down, so counting by testID
   *  must not see both. */
  hostsByTestId(testID: string) {
    return this.findAll(
      n => typeof n.type === 'string' && n.props.testID === testID,
    );
  }

  cardSlugs(): string[] {
    return this.findAll(
      n =>
        typeof n.type === 'string' &&
        typeof n.props.testID === 'string' &&
        n.props.testID.startsWith('drill-card-'),
    ).map(n => (n.props.testID as string).slice('drill-card-'.length));
  }

  saveToggle(slug: string) {
    const [node] = this.findAll(
      n =>
        n.props.testID === `save-toggle-${slug}` &&
        typeof n.props.onPress === 'function',
    );
    return node ?? null;
  }

  pressable(label: string | RegExp) {
    const [node] = this.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        typeof n.props.accessibilityLabel === 'string' &&
        (typeof label === 'string'
          ? n.props.accessibilityLabel === label
          : label.test(n.props.accessibilityLabel)),
    );
    return node ?? null;
  }

  async press(node: TestRenderer.ReactTestInstance | null): Promise<boolean> {
    if (!node) return false;
    await act(async () => {
      node.props.onPress();
    });
    return true;
  }

  projection(): DurableProjection {
    const cards = this.cardSlugs().map(slug => {
      const toggle = this.saveToggle(slug);
      return [slug, toggle?.props.accessibilityState?.selected === true] as [
        string,
        boolean,
      ];
    });
    const focusNodes = this.hostsByTestId('library-focus');
    const focusText = focusNodes[0]
      ? focusNodes[0]
          .findAllByType(Text)
          .map(n => n.props.children)
          .flat()
          .filter((c): c is string => typeof c === 'string')
          .join(' ')
      : null;
    return {
      account: this.account,
      cards,
      focus: focusText,
      focusHint: this.hostsByTestId('library-focus-hint').length > 0,
    };
  }

  // ---- schedule ops ------------------------------------------------------
  async releaseOne(mode?: ResponseMode): Promise<void> {
    const pending = this.server.pending;
    if (pending.length === 0) return;
    const req = this.rng.pick(pending);
    const chosen =
      mode ??
      this.rng.pick<ResponseMode>([
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'ok',
        'server_error',
        'network',
        'malformed',
        'unauthorized',
      ]);
    const processedAtSend = chosen === 'ok' && this.rng.chance(0.5);
    this.releasedBySchedule++;
    this.record(
      `release#${req.id}:${req.method}${req.path}:${chosen}${processedAtSend ? ':processed_at_send' : ''}`,
    );
    await act(async () => {
      this.server.release(req, chosen, processedAtSend);
    });
    await this.settle();
  }

  async releaseAllOk(): Promise<void> {
    let guard = 0;
    while (this.server.pending.length > 0 && guard++ < 50) {
      const req = this.server.pending[0];
      if (!req) break;
      await act(async () => {
        this.server.release(req, 'ok');
      });
      await this.settle();
    }
  }

  async quiesce(): Promise<void> {
    // Debounce 300ms + toast 2.5s + fade; let every timer the screen owns run.
    for (let round = 0; round < 6; round++) {
      await this.releaseAllOk();
      await this.advance(1000);
      await this.settle();
    }
    await this.releaseAllOk();
    await this.advance(4000);
    await this.settle();
  }

  async step(): Promise<void> {
    const rng = this.rng;
    const mounted = this.renderer !== null;
    const signedIn = this.account !== null;

    type Op = () => Promise<void>;
    const ops: [number, string, Op][] = [];
    const add = (weight: number, name: string, op: Op) =>
      ops.push([weight, name, op]);

    add(8, 'release', () => this.releaseOne());
    add(3, 'release_all', async () => {
      this.record('release_all');
      await this.releaseAllOk();
    });
    add(4, 'advance', async () => {
      const ms = rng.pick([50, 250, 300, 1000, 2600, 5000]);
      this.record(`advance:${ms}`);
      await this.advance(ms);
      await this.settle();
    });
    add(3, 'background_foreground', async () => {
      this.record('background_foreground');
      await act(async () => {
        emitAppState('inactive');
        emitAppState('background');
      });
      const ms = rng.pick([0, 400, 3000]);
      await this.advance(ms);
      await act(async () => {
        emitAppState('active');
      });
      await this.settle();
    });

    if (!mounted && signedIn) {
      add(10, 'mount', async () => {
        this.record('mount');
        await this.mount();
        await this.settle();
      });
    }
    if (!signedIn && !mounted) {
      add(10, 'sign_in', async () => {
        const account = rng.pick<AccountId>(['A', 'A', 'B']);
        this.record(`sign_in:${account}`);
        this.signIn(account);
        await this.mount();
        await this.settle();
      });
    }
    if (
      mounted &&
      this.cardSlugs().length === 0 &&
      this.server.pending.some(p => p.path === '/v1/catalog/drills')
    ) {
      // Bias towards a loaded catalog so save/detail/search paths get their
      // share of the schedule instead of starving behind unreleased loads.
      add(8, 'release_catalog_ok', async () => {
        const req = this.server.pending.find(
          p => p.path === '/v1/catalog/drills',
        );
        if (!req) return;
        this.releasedBySchedule++;
        this.record(`release#${req.id}:${req.method}${req.path}:ok`);
        await act(async () => {
          this.server.release(req, 'ok');
        });
        await this.settle();
      });
    }
    if (mounted) {
      add(3, 'unmount_mid_flight', async () => {
        this.record(`unmount:pending=${this.server.pending.length}`);
        await this.unmount();
      });
      add(3, 'relaunch', async () => {
        this.record(`relaunch:pending=${this.server.pending.length}`);
        await this.unmount();
        await this.advance(rng.pick([0, 100, 2000]));
        await this.mount();
        await this.settle();
      });
      add(2, 'rehydrate_twice', async () => {
        this.record('rehydrate_twice');
        await this.unmount();
        await this.mount();
        await this.quiesce();
        const first = this.projection();
        const version = this.server.version;
        await this.unmount();
        await this.mount();
        await this.quiesce();
        const second = this.projection();
        if (
          this.renderer &&
          version === this.server.version &&
          JSON.stringify(first) !== JSON.stringify(second)
        ) {
          this.fail(
            'idempotent_rehydrate',
            `relaunch projections differ: ${JSON.stringify(first)} vs ${JSON.stringify(second)}`,
          );
        }
      });
      add(2, 'navigate_away_back', async () => {
        this.record(`navigate_away_back:pending=${this.server.pending.length}`);
        const nav = this.navRef.current;
        if (!nav) return;
        await act(async () => {
          nav.navigate('Elsewhere');
        });
        await this.releaseOne();
        await this.advance(rng.pick([0, 300]));
        await act(async () => {
          if (nav.canGoBack()) nav.goBack();
        });
        await this.settle();
      });
      add(5, 'press_save', async () => {
        const slugs = this.cardSlugs();
        if (slugs.length === 0) return;
        const slug = rng.pick(slugs);
        this.record(`press_save:${slug}`);
        await this.press(this.saveToggle(slug));
      });
      add(2, 'press_save_twice', async () => {
        const slugs = this.cardSlugs();
        if (slugs.length === 0) return;
        const slug = rng.pick(slugs);
        this.record(`press_save_twice:${slug}`);
        const toggle = this.saveToggle(slug);
        if (!toggle) return;
        await act(async () => {
          toggle.props.onPress();
          toggle.props.onPress();
        });
      });
      add(4, 'toggle_detail', async () => {
        const slugs = this.cardSlugs();
        if (slugs.length === 0) return;
        const slug = rng.pick(slugs);
        this.record(`toggle_detail:${slug}`);
        await this.press(
          this.pressable(new RegExp(`^(Show|Hide) detail for `)),
        );
      });
      add(2, 'retry_detail', async () => {
        this.record('retry_detail');
        await this.press(this.pressable(/^Retry detail for /));
      });
      add(3, 'search', async () => {
        const q = rng.pick(['dink', 'wall', 'marker', 'zzz', 'Serve', '']);
        this.record(`search:${q}`);
        const [input] = this.findAll(
          n =>
            n.props.testID === 'drill-search-input' &&
            typeof n.props.onChangeText === 'function',
        );
        if (!input) return;
        await act(async () => {
          input.props.onChangeText(q);
        });
        if (rng.chance(0.6)) await this.advance(300);
        await this.settle();
      });
      add(2, 'family', async () => {
        const label = rng.pick([
          'Show all drill families',
          'Filter dink drills',
          'Filter volley drills',
          'Filter drop reset drills',
        ]);
        this.record(`family:${label}`);
        await this.press(this.pressable(label));
      });
      add(2, 'save_then_refresh', async () => {
        const slugs = this.cardSlugs();
        if (slugs.length === 0) return;
        const slug = rng.pick(slugs);
        this.record(`save_then_refresh:${slug}`);
        await this.press(this.saveToggle(slug));
        const [control] = this.findAll(
          n => typeof n.props.onRefresh === 'function',
        );
        if (!control) return;
        await act(async () => {
          control.props.onRefresh();
        });
      });
      add(2, 'pull_refresh', async () => {
        this.record('pull_refresh');
        const [control] = this.findAll(
          n => typeof n.props.onRefresh === 'function',
        );
        if (!control) return;
        await act(async () => {
          control.props.onRefresh();
        });
      });
      add(2, 'dismiss_error', async () => {
        this.record('dismiss_error');
        await this.press(this.pressable('Dismiss error'));
      });
      add(2, 'retry_load', async () => {
        this.record('retry_load');
        await this.press(this.pressable('Try again'));
      });
    }
    if (signedIn) {
      add(3, 'rotate_token_keep_old', async () => {
        this.record(
          `rotate_token:keep_old:pending=${this.server.pending.length}`,
        );
        await act(async () => {
          this.rotateToken(false);
        });
        await this.settle();
      });
      add(3, 'rotate_token_invalidate_old', async () => {
        this.record(
          `rotate_token:invalidate_old:pending=${this.server.pending.length}`,
        );
        await act(async () => {
          this.rotateToken(true);
        });
        await this.settle();
      });
      add(2, 'server_revokes_current', async () => {
        const token = getApiSession()?.bearerToken;
        this.record(`server_revokes_current:${token ?? 'none'}`);
        if (token) this.server.invalidate(token);
      });
      add(2, 'forbid_saves_later', async () => {
        const account = this.account;
        if (!account) return;
        this.record(`forbid_saves:${account}`);
        this.server.savesForbidden[account] = true;
      });
      add(1, 'allow_saves_again', async () => {
        const account = this.account;
        if (!account) return;
        this.record(`allow_saves:${account}`);
        this.server.savesForbidden[account] = false;
      });
      add(3, 'account_switch_realistic', async () => {
        const next: AccountId = this.account === 'A' ? 'B' : 'A';
        this.record(
          `account_switch_realistic:${this.account}->${next}:pending=${this.server.pending.length}`,
        );
        await act(async () => {
          this.signOut();
        });
        await this.unmount();
        await this.advance(rng.pick([0, 500]));
        this.signIn(next);
        await this.mount();
        await this.settle();
      });
      if (mounted) {
        add(2, 'account_switch_in_place', async () => {
          const next: AccountId = this.account === 'A' ? 'B' : 'A';
          this.record(
            `account_switch_in_place:${this.account}->${next}:pending=${this.server.pending.length}`,
          );
          await act(async () => {
            this.signIn(next);
          });
          await this.settle();
        });
      }
      add(2, 'sign_out', async () => {
        this.record(`sign_out:pending=${this.server.pending.length}`);
        await act(async () => {
          this.signOut();
        });
        await this.unmount();
      });
    }

    const total = ops.reduce((sum, [w]) => sum + w, 0);
    let roll = rng.next() * total;
    for (const [weight, , op] of ops) {
      roll -= weight;
      if (roll <= 0) {
        await op();
        return;
      }
    }
    const last = ops[ops.length - 1];
    if (last) await last[2]();
  }

  // ---- invariants --------------------------------------------------------
  checkRequestHygiene(switchSteps: number[]): void {
    for (const entry of this.server.log) {
      if (!entry.mountedWhenSent) {
        this.fail(
          'no_request_after_unmount',
          `request #${entry.id} ${entry.method} ${entry.path} sent at step ${entry.sentAtStep} while unmounted`,
        );
      }
      if (entry.tokenOwner === null) {
        this.fail(
          'request_carries_known_token',
          `request #${entry.id} ${entry.method} ${entry.path} carried no/unknown bearer`,
        );
      } else if (entry.tokenOwner !== entry.accountWhenSent) {
        this.fail(
          'request_token_matches_signed_in_account',
          `request #${entry.id} ${entry.method} ${entry.path} at step ${entry.sentAtStep} carried ${entry.tokenOwner}'s token while ${entry.accountWhenSent ?? 'nobody'} was signed in (switches at steps ${switchSteps.join(',')})`,
        );
      }
    }
  }

  checkUnauthorizedHygiene(): void {
    const staleUnauthorized = this.server.log.filter(
      e => e.status === 401 && !e.tokenWasCurrent,
    );
    for (const call of this.unauthorizedCalls) {
      const matched = this.server.log.find(
        e => e.status === 401 && e.tokenWasCurrent,
      );
      if (!matched) {
        this.fail(
          'unauthorized_only_for_current_bearer',
          `unauthorized listener fired for ${call.bearerToken} but no 401 was ever returned to a current bearer (stale 401s: ${staleUnauthorized.length})`,
        );
      }
    }
  }

  checkRenderedTruth(): void {
    if (!this.renderer || !this.account) return;
    const account = this.account;
    const other: AccountId = account === 'A' ? 'B' : 'A';
    const text = this.text();
    if (text.includes(MARKER_TITLE[other])) {
      this.fail(
        'no_previous_account_state',
        `${other}'s marker drill rendered while ${account} is signed in`,
      );
    }
    if (this.cardSlugs().includes(MARKER_SLUG[other])) {
      this.fail(
        'no_previous_account_state',
        `${other}'s marker card present while ${account} is signed in`,
      );
    }
    const focusPresent = this.hostsByTestId('library-focus').length > 0;
    if (account === 'B' && focusPresent) {
      this.fail(
        'no_previous_account_state',
        'focus card computed from account A shots rendered for account B',
      );
    }
    if (text.includes('Loading drill detail')) {
      this.fail(
        'no_detail_stuck_loading',
        'detail still loading at quiescence',
      );
    }
    if (text.includes('Loading the drill catalog')) {
      this.fail(
        'no_catalog_stuck_loading',
        'catalog still loading at quiescence',
      );
    }
    for (const slug of this.cardSlugs()) {
      const toggle = this.saveToggle(slug);
      if (!toggle) continue;
      if (toggle.props.disabled === true) {
        this.fail(
          'no_save_stuck_pending',
          `${slug} save toggle still disabled`,
        );
      }
      const shownSaved = toggle.props.accessibilityState?.selected === true;
      const serverSaved = this.server.saved[account].has(slug);
      if (shownSaved !== serverSaved) {
        this.fail(
          'saved_badge_matches_server',
          `${slug}: UI saved=${shownSaved} server saved=${serverSaved}`,
        );
      }
    }
  }

  checkLeaks(): void {
    const { leaked, animatedMock } = leakedTimers();
    this.animatedMockTimersSeen += animatedMock;
    if (leaked.length !== 0) {
      this.fail(
        'no_leaked_timers',
        `${leaked.length} timer(s) pending after unmount: ${leaked
          .map(t => `${t.type}(${t.delay}) ${t.source}`)
          .join(' || ')}`,
      );
    }
    const live = subscriptions.filter(s => !s.removed);
    if (live.length > 0) {
      this.fail(
        'no_leaked_listeners',
        live.map(s => `${s.source}:${s.event}`).join(','),
      );
    }
    if (mountCount !== unmountCount) {
      this.fail(
        'screen_unmount_balanced',
        `mounts=${mountCount} unmounts=${unmountCount}`,
      );
    }
  }
}

/** `account_switch_in_place` swaps the session under a MOUNTED screen. The
 *  shipped App.tsx gate never does this (`ready` requires
 *  `appOwnerKey === desiredOwner`, so the signed-in tree unmounts during a
 *  switch), so stale-account violations produced ONLY by that adversarial
 *  step are reported separately from failures reachable in the product. */
const ADVERSARIAL_ONLY_INVARIANTS = new Set([
  'no_previous_account_state',
  'saved_badge_matches_server',
]);

function classify(h: Harness): IterationResult['outcome'] {
  if (h.violations.length === 0) return 'HELD';
  const inPlace = h.steps.some(s => s.startsWith('account_switch_in_place'));
  if (
    inPlace &&
    h.violations.every(v => ADVERSARIAL_ONLY_INVARIANTS.has(v.invariant))
  ) {
    return 'ADVERSARIAL_ONLY';
  }
  return 'BROKEN';
}

async function runIteration(seed: number): Promise<IterationResult> {
  const started = Date.now();
  const rng = new Rng(seed);
  const h = new Harness(rng);
  await h.setup();
  const switchSteps: number[] = [];
  try {
    h.record('sign_in:A');
    h.signIn('A');
    await h.mount();
    await h.settle();
    for (let i = 0; i < STEPS_PER_ITERATION; i++) {
      const before = h.steps.length;
      await h.step();
      const last = h.steps[h.steps.length - 1];
      if (
        h.steps.length > before &&
        last &&
        (last.startsWith('account_switch') || last.startsWith('sign_in'))
      ) {
        switchSteps.push(h.steps.length);
      }
    }
    h.record('quiesce');
    if (!h.renderer && h.account) await h.mount();
    if (!h.renderer && !h.account) {
      h.signIn('A');
      await h.mount();
    }
    await h.quiesce();
    h.checkRenderedTruth();
    h.checkRequestHygiene(switchSteps);
    h.checkUnauthorizedHygiene();
    h.record('final_unmount');
    await h.unmount();
    await h.settle();
    h.checkLeaks();
    await h.advance(10000);
    await h.settle();
  } catch (error) {
    h.fail(
      'no_exception',
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error),
    );
    await h.unmount();
  } finally {
    h.teardown();
  }
  for (const message of h.consoleErrors) {
    h.fail('no_console_error', message);
  }
  return {
    seed,
    steps: h.steps,
    requests: h.server.log.length,
    releasedBySchedule: h.releasedBySchedule,
    violations: h.violations,
    consoleErrors: h.consoleErrors,
    outcome: classify(h),
    animatedMockTimersIgnored: h.animatedMockTimersSeen,
    durationMs: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------
const campaign: IterationResult[] = [];
const observations: Record<string, unknown> = {};

beforeAll(() => {
  installListenerRegistries();
});

beforeEach(() => {
  // Microtasks stay real so `jest.getTimerCount()` counts only genuine
  // setTimeout/setInterval handles (React's scheduler and Animated detach
  // through queueMicrotask; faking those would report them as leaks).
  jest.useFakeTimers({ doNotFake: ['queueMicrotask', 'nextTick'] });
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

afterAll(() => {
  mkdirSync(OUT_DIR, { recursive: true });
  const held = campaign.filter(r => r.outcome === 'HELD').length;
  const broken = campaign.filter(r => r.outcome === 'BROKEN').length;
  const adversarialOnly = campaign.filter(
    r => r.outcome === 'ADVERSARIAL_ONLY',
  ).length;
  const summary = {
    unit: 'scr-drilllibraryscreen',
    lens: 'lifecycle',
    stepsPerIteration: STEPS_PER_ITERATION,
    iterations: campaign.length,
    held,
    broken,
    adversarialOnly,
    adversarialOnlySeeds: campaign
      .filter(r => r.outcome === 'ADVERSARIAL_ONLY')
      .map(r => r.seed),
    animatedMockTimersIgnored: campaign.reduce(
      (s, r) => s + r.animatedMockTimersIgnored,
      0,
    ),
    totalRequests: campaign.reduce((s, r) => s + r.requests, 0),
    totalSteps: campaign.reduce((s, r) => s + r.steps.length, 0),
    invariantsViolated: Array.from(
      new Set(campaign.flatMap(r => r.violations.map(v => v.invariant))),
    ),
    seedsFailed: campaign.filter(r => r.outcome === 'BROKEN').map(r => r.seed),
    observations,
  };
  writeFileSync(
    join(OUT_DIR, 'drillLibraryScreen-lifecycle-summary.json'),
    JSON.stringify(summary, null, 2),
  );
  writeFileSync(
    join(OUT_DIR, 'drillLibraryScreen-lifecycle-seeds.json'),
    JSON.stringify(
      campaign.map(r => ({
        seed: r.seed,
        outcome: r.outcome,
        steps: r.steps.length,
        requests: r.requests,
        violations: r.violations,
        consoleErrors: r.consoleErrors,
        durationMs: r.durationMs,
      })),
      null,
      2,
    ),
  );
  writeFileSync(
    join(OUT_DIR, 'drillLibraryScreen-lifecycle-schedules.json'),
    JSON.stringify(campaign, null, 2),
  );
});

describe('DrillLibraryScreen lifecycle interruption campaign (seeded)', () => {
  const seeds =
    ONLY_SEED !== null
      ? [ONLY_SEED]
      : Array.from({ length: ITERATIONS }, (_, i) => i + 1);

  it.each(seeds)('seed %i holds every lifecycle invariant', async seed => {
    const result = await runIteration(seed);
    campaign.push(result);
    expect(result.outcome === 'BROKEN' ? result.violations : []).toEqual([]);
  });
});

describe('DrillLibraryScreen lifecycle interruption (targeted)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = new Harness(new Rng(7));
    await h.setup();
  });

  afterEach(async () => {
    await h.unmount();
    h.teardown();
  });

  async function mountSignedIn(account: AccountId) {
    h.record(`sign_in:${account}`);
    h.signIn(account);
    await h.mount();
    await h.settle();
  }

  it('unmounting while the catalog request is in flight leaves no timers, listeners or errors', async () => {
    await mountSignedIn('A');
    expect(h.server.pending.map(p => p.path)).toEqual(['/v1/catalog/drills']);
    expect(h.text()).toContain('Loading the drill catalog');
    await h.unmount();
    h.checkLeaks();
    const [req] = h.server.pending;
    expect(req).toBeDefined();
    await act(async () => {
      h.server.release(req!, 'ok');
    });
    await h.advance(10000);
    expect(h.consoleErrors).toEqual([]);
    expect(h.violations).toEqual([]);
    expect(h.server.log).toHaveLength(1);
  });

  it('unmounting while detail and save requests are in flight is silent and sends nothing afterwards', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    await h.press(h.pressable('Show detail for Wall Dinks'));
    await h.press(h.saveToggle('volley-blocks'));
    expect(h.server.pending.map(p => `${p.method} ${p.path}`)).toEqual([
      'GET /v1/catalog/drills/wall-dinks',
      'PUT /v1/me/saved-drills/volley-blocks',
    ]);
    await h.unmount();
    for (const req of [...h.server.pending]) {
      await act(async () => {
        h.server.release(req, 'ok');
      });
    }
    await h.advance(10000);
    h.checkLeaks();
    expect(h.consoleErrors).toEqual([]);
    expect(h.violations).toEqual([]);
    expect(h.server.saved.A.has('volley-blocks')).toBe(true);
    expect(h.server.log).toHaveLength(3);
  });

  it('kill + relaunch re-hydrates idempotently from SQLite + server (focus card, saved badges)', async () => {
    h.server.saved.A.add('third-shot-drop');
    await mountSignedIn('A');
    await h.quiesce();
    const first = h.projection();
    expect(first.focus?.toLowerCase()).toContain('paddle set');
    expect(first.cards).toContainEqual(['third-shot-drop', true]);
    expect(first.cards.map(([slug]) => slug)).toContain(MARKER_SLUG.A);
    await h.unmount();
    h.checkLeaks();
    await h.mount();
    await h.quiesce();
    expect(h.projection()).toEqual(first);
    await h.unmount();
    await h.mount();
    await h.quiesce();
    expect(h.projection()).toEqual(first);
    expect(h.violations).toEqual([]);
    expect(h.consoleErrors).toEqual([]);
  });

  it('token rotation mid-request: a stale 401 never signs the user out, a current 401 does exactly once', async () => {
    await mountSignedIn('A');
    const [catalogReq] = h.server.pending;
    expect(catalogReq?.token).toBe('tok-A-g1');
    await act(async () => {
      h.rotateToken(true);
    });
    await h.settle();
    // The old request resolves 401 after rotation: must be ignored.
    await act(async () => {
      h.server.release(catalogReq!, 'unauthorized');
    });
    await h.settle();
    expect(h.unauthorizedCalls).toEqual([]);
    expect(getApiSession()?.bearerToken).toBe('tok-A-g2');
    expect(h.renderer).not.toBeNull();
    // Retry must go out with the rotated bearer.
    await h.press(h.pressable('Try again'));
    const [retry] = h.server.pending;
    expect(retry?.token).toBe('tok-A-g2');
    await act(async () => {
      h.server.release(retry!, 'ok');
    });
    await h.settle();
    expect(h.cardSlugs()).toContain('wall-dinks');
    // Now the server revokes the *current* bearer: the next request gets a
    // real 401 and the listener must fire once, tearing the session down.
    h.server.invalidate('tok-A-g2');
    await h.press(h.saveToggle('wall-dinks'));
    await h.press(h.pressable('Show detail for Volley Blocks'));
    await h.releaseAllOk();
    expect(h.unauthorizedCalls).toHaveLength(1);
    expect(h.unauthorizedCalls[0]?.bearerToken).toBe('tok-A-g2');
    expect(getApiSession()).toBeNull();
    expect(h.renderer).toBeNull();
    h.checkLeaks();
    await h.advance(10000);
    expect(h.consoleErrors).toEqual([]);
    expect(h.violations).toEqual([]);
  });

  it('account switch the way the app does it: nothing from account A reaches account B', async () => {
    h.server.saved.A.add('wall-dinks');
    await mountSignedIn('A');
    await h.quiesce();
    expect(h.text()).toContain(MARKER_TITLE.A);
    expect(h.projection().focus).not.toBeNull();
    await h.press(h.pressable('Show detail for Wall Dinks'));
    await h.press(h.saveToggle('volley-blocks'));
    const pendingBeforeSwitch = [...h.server.pending];
    expect(pendingBeforeSwitch).toHaveLength(2);
    h.record('account_switch_realistic:A->B');
    await act(async () => {
      h.signOut();
    });
    await h.unmount();
    h.signIn('B');
    await h.mount();
    for (const req of pendingBeforeSwitch) {
      await act(async () => {
        h.server.release(req, 'ok');
      });
    }
    await h.quiesce();
    const text = h.text();
    expect(text).toContain(MARKER_TITLE.B);
    expect(text).not.toContain(MARKER_TITLE.A);
    expect(h.projection().focus).toBeNull();
    expect(h.projection().cards).toContainEqual(['wall-dinks', false]);
    expect(h.projection().cards).toContainEqual(['volley-blocks', false]);
    expect(h.server.saved.A.has('volley-blocks')).toBe(true);
    h.checkRenderedTruth();
    h.checkRequestHygiene([]);
    expect(h.violations).toEqual([]);
    for (const entry of h.server.log) {
      expect(entry.tokenOwner).toBe(entry.accountWhenSent);
    }
    expect(h.consoleErrors).toEqual([]);
  });

  it('adversarial in-place account switch (session swapped under a mounted screen)', async () => {
    await mountSignedIn('A');
    await h.quiesce();
    expect(h.projection().focus).not.toBeNull();
    await h.press(h.saveToggle('wall-dinks'));
    const [saveReq] = h.server.pending;
    expect(saveReq?.token).toBe('tok-A-g1');
    h.record('account_switch_in_place:A->B');
    await act(async () => {
      h.signIn('B');
    });
    await h.settle();
    await act(async () => {
      h.server.release(saveReq!, 'ok');
    });
    await h.quiesce();
    // Catalog re-fetched with B's token, A's marker gone, save applied to A.
    expect(h.text()).toContain(MARKER_TITLE.B);
    expect(h.text()).not.toContain(MARKER_TITLE.A);
    expect(h.server.saved.A.has('wall-dinks')).toBe(true);
    expect(h.server.saved.B.has('wall-dinks')).toBe(false);
    h.checkRenderedTruth();
    h.checkRequestHygiene([]);
    // Documented outcome: violations here describe state that survives an
    // in-place swap; the campaign records them per seed.
    expect(h.consoleErrors).toEqual([]);
    expect(
      h.violations.filter(v => v.invariant !== 'no_previous_account_state'),
    ).toEqual([]);
  });

  it('navigating away and back while requests are pending keeps the screen consistent', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    await h.press(h.saveToggle('wall-dinks'));
    await act(async () => {
      h.navRef.current?.navigate('Elsewhere');
    });
    expect(h.hostsByTestId('elsewhere').length).toBe(1);
    await h.releaseAllOk();
    await act(async () => {
      h.navRef.current?.goBack();
    });
    await h.quiesce();
    expect(h.projection().cards).toContainEqual(['wall-dinks', true]);
    h.checkRenderedTruth();
    expect(h.violations).toEqual([]);
    expect(h.consoleErrors).toEqual([]);
  });

  it('background/foreground cycles with a request in flight change nothing and leak nothing', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    await h.press(h.saveToggle('crosscourt-dink'));
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        emitAppState('inactive');
        emitAppState('background');
      });
      await h.advance(1500);
      await act(async () => {
        emitAppState('active');
      });
    }
    await h.quiesce();
    expect(h.projection().cards).toContainEqual(['crosscourt-dink', true]);
    expect(h.server.log).toHaveLength(2);
    await h.unmount();
    h.checkLeaks();
    expect(h.violations).toEqual([]);
    expect(h.consoleErrors).toEqual([]);
  });

  // Probes record what the screen does under a specific race; the summary
  // artifact carries the observation so a reviewer can classify it. They
  // assert only the invariants that must hold either way.
  it('probe: token rotation with nothing else changing — does the screen re-fetch the catalog?', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    const before = h.server.log.length;
    h.record('rotate_token:keep_old');
    await act(async () => {
      h.rotateToken(false);
    });
    await h.settle();
    const after = h.server.log.slice(before);
    observations.catalogRefetchOnTokenRotation = {
      requestsAfterRotation: after.map(e => `${e.method} ${e.path}`),
      tokenOnRefetch: h.server.pending.map(p => p.token),
    };
    for (const p of h.server.pending) expect(p.token).toBe('tok-A-g2');
    await h.quiesce();
    h.checkRenderedTruth();
    expect(h.violations).toEqual([]);
    expect(h.consoleErrors).toEqual([]);
  });

  it('probe: pull-to-refresh while a save is in flight, refresh read served before the write lands', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    await h.press(h.saveToggle('wall-dinks'));
    const [put] = h.server.pending;
    expect(put?.method).toBe('PUT');
    h.record('pull_refresh');
    const [control] = h.findAll(n => typeof n.props.onRefresh === 'function');
    await act(async () => {
      control?.props.onRefresh();
    });
    const get = h.server.pending.find(p => p.method === 'GET');
    expect(get).toBeDefined();
    // Server handles the read first (saved=false), the write second; the
    // client receives them in the same order.
    await act(async () => {
      h.server.release(get!, 'ok', true);
    });
    await h.settle();
    await act(async () => {
      h.server.release(put!, 'ok');
    });
    await h.quiesce();
    const shown =
      h.saveToggle('wall-dinks')?.props.accessibilityState?.selected === true;
    observations.refreshDuringSaveReadBeforeWrite = {
      serverSaved: h.server.saved.A.has('wall-dinks'),
      badgeShownSaved: shown,
      toastShown: h.text().includes('Saved to your library'),
      requestOrder: h.server.log.map(
        e => `#${e.id} ${e.method} ${e.path} -> ${e.status}`,
      ),
    };
    expect(h.server.saved.A.has('wall-dinks')).toBe(true);
    expect(h.saveToggle('wall-dinks')?.props.disabled).not.toBe(true);
    expect(h.consoleErrors).toEqual([]);
  });

  it('probe (minimized seed 75): save while a search catalog request is in flight, responses in send order', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    h.record('search:wall');
    const [input] = h.findAll(
      n =>
        n.props.testID === 'drill-search-input' &&
        typeof n.props.onChangeText === 'function',
    );
    await act(async () => {
      input?.props.onChangeText('wall');
    });
    await h.advance(300);
    await h.settle();
    expect(h.server.pending.map(p => p.method)).toEqual(['GET']);
    h.record('press_save:wall-dinks');
    await h.press(h.saveToggle('wall-dinks'));
    expect(h.server.pending.map(p => p.method)).toEqual(['GET', 'PUT']);
    // FIFO: the search read is answered (saved=false, the PUT has not been
    // applied yet), then the save write succeeds. No reordering involved.
    await h.quiesce();
    const shown =
      h.saveToggle('wall-dinks')?.props.accessibilityState?.selected === true;
    observations.saveDuringSearchRequestFifo = {
      serverSaved: h.server.saved.A.has('wall-dinks'),
      badgeShownSaved: shown,
      requestOrder: h.server.log.map(
        e => `#${e.id} ${e.method} ${e.path} -> ${e.status}`,
      ),
    };
    expect(h.server.saved.A.has('wall-dinks')).toBe(true);
    expect(h.saveToggle('wall-dinks')?.props.disabled).not.toBe(true);
    expect(h.consoleErrors).toEqual([]);
  });

  it('permission revoked later: a 403 on save rolls the badge back and reports inline', async () => {
    await mountSignedIn('A');
    await h.releaseAllOk();
    h.server.savesForbidden.A = true;
    await h.press(h.saveToggle('wall-dinks'));
    expect(h.saveToggle('wall-dinks')?.props.accessibilityState?.selected).toBe(
      true,
    );
    await h.quiesce();
    expect(h.saveToggle('wall-dinks')?.props.accessibilityState?.selected).toBe(
      false,
    );
    expect(h.hostsByTestId('drill-library-inline-error').length).toBe(1);
    h.checkRenderedTruth();
    expect(h.violations).toEqual([]);
    expect(h.consoleErrors).toEqual([]);
  });
});
