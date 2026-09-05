import React from 'react';
import * as fs from 'fs';
import * as path from 'path';
import { Linking, Modal, Pressable, Text, View } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import { NavigationContainer, useNavigation } from '@react-navigation/native';
import {
  createNativeStackNavigator,
  type NativeStackNavigationProp,
} from '@react-navigation/native-stack';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SafeAreaProvider } from 'react-native-safe-area-context';

/**
 * STRESS / failure-injection campaign for ManageAccountScreen.
 *
 * The REAL screen is mounted inside the REAL React Navigation container +
 * native-stack navigator (same libraries RootNavigator uses), the REAL
 * `useAuthStore` (including its real `completeAccountDeletion` cleanup:
 * Keychain vault → SQLite kv + owner purge → Google SDK disconnect), the REAL
 * `src/account/deletion` HTTP client, the REAL `BrandNoticeHost`, wrapped in
 * the same SafeAreaProvider / QueryClientProvider App.tsx uses. Only native
 * modules (Keychain, SQLite, Google Sign-In, Linking) and `fetch` are
 * replaced, each by a fault-programmable double.
 *
 * Every iteration is replayable from its seed (`STRESS_SEED`, default
 * 0x5eed; `STRESS_ONLY=<seed>` replays one). The catalog below is run once
 * per fault; `STRESS_ITER=<n>` (default 8) appends n seeded random
 * combinations (fetch fault × cleanup fault × survey path × provider ×
 * clock pattern). A JSON table (seed → outcome) is written to `STRESS_OUT`
 * when set.
 *
 * Invariants asserted after every fault (after advancing fake timers 60s):
 *   - no spinner left on screen, no control stuck disabled without a way out;
 *   - a visible error (production copy) plus an enabled retry/back/keep
 *     control while the account still exists — never a silent failure;
 *   - no fake success: session, ApiSession, Keychain record and SQLite rows
 *     are byte-identical to the pre-fault state unless the server confirmed
 *     `deleted: true`;
 *   - after a confirmed deletion: session gone, bearer gone, Keychain record
 *     gone or untouched (fail-soft), owner rows purged transactionally (a
 *     failed purge leaves the OTHER owner's rows intact and surfaces the
 *     "LOCAL CLEANUP NEEDED" notice), never a partially-deleted bucket;
 *   - a retry after the fault makes real progress (armed → deleted).
 */

// ─── Fault primitives ──────────────────────────────────────────────────────

type FaultMode =
  | { kind: 'ok' }
  | { kind: 'reject' }
  | { kind: 'throw' }
  | { kind: 'never' }
  | { kind: 'false' }
  | { kind: 'slow'; ms: number };

function runFault<T>(mode: FaultMode, okValue: T, label: string): Promise<T> {
  switch (mode.kind) {
    case 'ok':
      return Promise.resolve(okValue);
    case 'false':
      return Promise.resolve(false as unknown as T);
    case 'reject':
      return Promise.reject(new Error(`${label}: injected rejection`));
    case 'throw':
      throw new Error(`${label}: injected synchronous throw`);
    case 'never':
      return new Promise<T>(() => {});
    case 'slow':
      return new Promise<T>(resolve =>
        setTimeout(() => resolve(okValue), mode.ms),
      );
  }
}

// ─── Keychain double (react-native-keychain) ───────────────────────────────

const SESSION_VAULT_SERVICE = 'com.picklesensei.auth.session';

const mockKeychainState = {
  runFault,
  store: new Map<string, { username: string; password: string }>(),
  reset: { kind: 'ok' } as FaultMode,
  accessThrows: false,
  calls: [] as string[],
  seed() {
    this.store.clear();
    this.store.set(SESSION_VAULT_SERVICE, {
      username: 'session',
      password: JSON.stringify({
        version: 1,
        provider: 'google',
        canonicalAppUserId: OWNER,
        refreshToken: 'refresh-token-original',
        email: 'alex@example.com',
        displayName: 'Alex Chen',
      }),
    });
  },
  clearFaults() {
    this.reset = { kind: 'ok' };
    this.accessThrows = false;
    this.calls = [];
  },
};

jest.mock('react-native-keychain', () => {
  const api = {
    ACCESSIBLE: {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
        'AccessibleAfterFirstUnlockThisDeviceOnly',
    },
    setGenericPassword: async (
      username: string,
      password: string,
      options: { service?: string } = {},
    ) => {
      mockKeychainState.calls.push('set');
      mockKeychainState.store.set(options.service ?? '__default__', {
        username,
        password,
      });
      return { service: options.service ?? '__default__', storage: 'mock' };
    },
    getGenericPassword: async (options: { service?: string } = {}) => {
      mockKeychainState.calls.push('get');
      const item = mockKeychainState.store.get(
        options.service ?? '__default__',
      );
      return item
        ? { ...item, service: options.service, storage: 'mock' }
        : false;
    },
  };
  Object.defineProperty(api, 'resetGenericPassword', {
    enumerable: true,
    get() {
      if (mockKeychainState.accessThrows) {
        throw new Error('react-native-keychain: native module unavailable');
      }
      return (options: { service?: string } = {}) => {
        mockKeychainState.calls.push('reset');
        const service = options.service ?? '__default__';
        const mode = mockKeychainState.reset;
        if (mode.kind === 'ok' || mode.kind === 'slow') {
          return mockKeychainState
            .runFault(mode, true, 'keychain.reset')
            .then(value => {
              mockKeychainState.store.delete(service);
              return value;
            });
        }
        return mockKeychainState.runFault(mode, true, 'keychain.reset');
      };
    },
  });
  return api;
});

// ─── Google Sign-In double ─────────────────────────────────────────────────

const mockGoogleState = {
  runFault,
  revokeAccess: { kind: 'ok' } as FaultMode,
  signOut: { kind: 'ok' } as FaultMode,
  moduleAccessThrows: false,
  calls: [] as string[],
  clearFaults() {
    this.revokeAccess = { kind: 'ok' };
    this.signOut = { kind: 'ok' };
    this.moduleAccessThrows = false;
    this.calls = [];
  },
};

jest.mock('@react-native-google-signin/google-signin', () => {
  const GoogleSignin = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (mockGoogleState.moduleAccessThrows) {
          throw new Error('GoogleSignin native module unavailable');
        }
        if (prop === 'revokeAccess' || prop === 'signOut') {
          return () => {
            mockGoogleState.calls.push(prop);
            return mockGoogleState.runFault(
              mockGoogleState[prop],
              null,
              `google.${prop}`,
            );
          };
        }
        return () => Promise.resolve(null);
      },
    },
  );
  return { GoogleSignin };
});

// ─── SQLite double (src/data/db → LocalDb) ─────────────────────────────────

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const OWNER_TABLES = [
  'local_shot',
  'local_session',
  'local_capture',
  'local_analysis_record',
  'outbox',
  'sync_receipt',
];

interface DbFaultContext {
  sql: string;
  /** 1-based purge attempt (counted at each BEGIN); 0 outside a transaction. */
  attempt: number;
  /** Index of this statement within the current transaction (0 = BEGIN). */
  stmt: number;
  call: number;
}

type DbFaultPlan = (ctx: DbFaultContext) => FaultMode;

class FakeLocalDb {
  tables = new Map<string, Array<{ owner_key: string; id: string }>>();
  kv = new Map<string, string>();
  snapshot: {
    tables: Map<string, Array<{ owner_key: string; id: string }>>;
    kv: Map<string, string>;
  } | null = null;
  statements: string[] = [];
  attempt = 0;
  stmt = 0;
  call = 0;
  mutations = 0;
  rollbackFaulted = false;
  unsupported: string[] = [];
  plan: DbFaultPlan = () => ({ kind: 'ok' });

  seed() {
    this.tables.clear();
    this.kv.clear();
    for (const table of OWNER_TABLES) {
      this.tables.set(table, [
        { owner_key: OWNER, id: `${table}-a` },
        { owner_key: OWNER, id: `${table}-b` },
        { owner_key: OTHER_OWNER, id: `${table}-other` },
      ]);
    }
    this.kv.set(`profile:${OWNER}`, '{"goal":"x"}');
    this.kv.set(`profile:${OTHER_OWNER}`, '{"goal":"y"}');
    this.kv.set('auth.local-mode', '');
    this.kv.set('auth.last-provider', '{"version":1,"provider":"google"}');
    this.statements = [];
    this.attempt = 0;
    this.stmt = 0;
    this.call = 0;
    this.mutations = 0;
    this.snapshot = null;
  }

  ownerRows(owner: string): number {
    let n = 0;
    for (const rows of this.tables.values()) {
      n += rows.filter(r => r.owner_key === owner).length;
    }
    for (const key of this.kv.keys()) {
      if (key.endsWith(`:${owner}`)) n += 1;
    }
    return n;
  }

  fingerprint(): string {
    return JSON.stringify({
      tables: [...this.tables.entries()],
      kv: [...this.kv.entries()],
    });
  }

  private clone() {
    return {
      tables: new Map(
        [...this.tables.entries()].map(([k, v]) => [k, v.map(r => ({ ...r }))]),
      ),
      kv: new Map(this.kv),
    };
  }

  async execute(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    this.call += 1;
    if (sql.startsWith('BEGIN')) {
      this.attempt += 1;
      this.stmt = 0;
    } else {
      this.stmt += 1;
    }
    this.statements.push(sql);
    const mode = this.plan({
      sql,
      attempt: this.snapshot || sql.startsWith('BEGIN') ? this.attempt : 0,
      stmt: this.stmt,
      call: this.call,
    });
    if (sql === 'ROLLBACK' && mode.kind !== 'ok' && mode.kind !== 'slow') {
      this.rollbackFaulted = true;
    }
    if (sql.startsWith('BEGIN') && this.snapshot) {
      throw new Error('cannot start a transaction within a transaction');
    }
    await runFault(mode, null, `sqlite(${sql.slice(0, 24)})`);
    return this.apply(sql, params);
  }

  private apply(
    sql: string,
    params: unknown[],
  ): { rows: Record<string, unknown>[] } {
    if (sql.startsWith('BEGIN')) {
      this.snapshot = this.clone();
      return { rows: [] };
    }
    if (sql === 'COMMIT') {
      this.snapshot = null;
      return { rows: [] };
    }
    if (sql === 'ROLLBACK') {
      if (this.snapshot) {
        this.tables = this.snapshot.tables;
        this.kv = this.snapshot.kv;
        this.snapshot = null;
      }
      return { rows: [] };
    }
    let m = /^DELETE FROM (\w+) WHERE owner_key = \?$/.exec(sql);
    if (m) {
      const rows = this.tables.get(m[1]!) ?? [];
      const before = rows.length;
      const after = rows.filter(r => r.owner_key !== params[0]);
      this.tables.set(m[1]!, after);
      this.mutations += before - after.length;
      return { rows: [] };
    }
    if (sql === 'DELETE FROM kv WHERE key = ?') {
      if (this.kv.delete(String(params[0]))) this.mutations += 1;
      return { rows: [] };
    }
    if (
      /^INSERT OR REPLACE INTO kv \(key, value\) VALUES \(\?, \?\)$/.test(sql)
    ) {
      this.kv.set(String(params[0]), String(params[1]));
      this.mutations += 1;
      return { rows: [] };
    }
    m = /^SELECT value FROM kv WHERE key = \?$/.exec(sql);
    if (m) {
      const value = this.kv.get(String(params[0]));
      return { rows: value === undefined ? [] : [{ value }] };
    }
    this.unsupported.push(sql);
    throw new Error(`FakeLocalDb: unsupported SQL reached the store: ${sql}`);
  }

  close() {}
}

const mockDbState = {
  db: new FakeLocalDb(),
  getDbThrows: false,
  getDbCalls: 0,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    mockDbState.getDbCalls += 1;
    if (mockDbState.getDbThrows) {
      throw new Error('op-sqlite: native database unavailable');
    }
    return mockDbState.db;
  },
}));

jest.mock(
  'react-native-safe-area-context',
  () =>
    jest.requireActual<{ default: unknown }>(
      'react-native-safe-area-context/jest/mock',
    ).default,
);

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

// ─── Real app modules under test ───────────────────────────────────────────

import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { BrandSpinner, Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import type { RootStackParams } from '../../src/navigation/params';

// ─── Seeded RNG ────────────────────────────────────────────────────────────

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }
  next(): number {
    // mulberry32
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)]!;
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
}

function hashSeed(base: number, index: number): number {
  let h = (base ^ 0x811c9dc5) >>> 0;
  h = Math.imul(h ^ index, 0x01000193) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return h >>> 0;
}

const CAMPAIGN_SEED = Number(process.env['STRESS_SEED'] ?? 0x5eed) >>> 0;
const EXTRA_ITER = Math.max(0, Number(process.env['STRESS_ITER'] ?? 8));
const ONLY_SEED = process.env['STRESS_ONLY']
  ? Number(process.env['STRESS_ONLY']) >>> 0
  : null;
const OUT_PATH = process.env['STRESS_OUT'] ?? null;

// ─── fetch double ──────────────────────────────────────────────────────────

type FetchFault =
  | { kind: 'ok'; body: unknown }
  | { kind: 'throw' }
  | { kind: 'reject' }
  /** Never settles; rejects with AbortError when the caller aborts (what the
   * whatwg-fetch polyfill React Native ships does). */
  | { kind: 'never-honours-abort' }
  /** Never settles, even after abort (models a broken fetch polyfill). */
  | { kind: 'never-ignores-abort' }
  /** Headers arrive, `.json()` never settles (body stall outside the 15s
   * abort window; RN's XHR-backed fetch resolves only after the full body,
   * so this needs a non-RN fetch implementation). */
  | { kind: 'json-never'; status: number }
  | { kind: 'slow'; ms: number; then: FetchFault }
  | { kind: 'status'; status: number; body: unknown | typeof TEXT_BODY };

const TEXT_BODY = Symbol('text-body');

type FetchCall = { url: string; init: RequestInit | undefined };

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () =>
      body === TEXT_BODY
        ? Promise.reject(new SyntaxError('Unexpected token < in JSON'))
        : Promise.resolve(body),
  } as unknown as Response;
}

function abortError(): Error {
  const e = new Error('Aborted');
  e.name = 'AbortError';
  return e;
}

function respond(fault: FetchFault, call: FetchCall): Promise<Response> {
  switch (fault.kind) {
    case 'ok':
      return Promise.resolve(makeResponse(200, fault.body));
    case 'status':
      return Promise.resolve(makeResponse(fault.status, fault.body));
    case 'throw':
      throw new TypeError('Network request failed (sync)');
    case 'reject':
      return Promise.reject(new TypeError('Network request failed'));
    case 'never-honours-abort':
      return new Promise<Response>((_, reject) => {
        const signal = call.init?.signal;
        if (signal?.aborted) reject(abortError());
        signal?.addEventListener('abort', () => reject(abortError()));
      });
    case 'never-ignores-abort':
      return new Promise<Response>(() => {});
    case 'json-never':
      return Promise.resolve({
        ok: fault.status >= 200 && fault.status < 300,
        status: fault.status,
        json: () => new Promise<never>(() => {}),
      } as unknown as Response);
    case 'slow':
      return new Promise<Response>((resolve, reject) => {
        const signal = call.init?.signal;
        const timer = setTimeout(() => {
          try {
            respond(fault.then, call).then(resolve, reject);
          } catch (e) {
            reject(e);
          }
        }, fault.ms);
        signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(abortError());
        });
      });
  }
}

const VALID_CHALLENGE = '33333333-3333-4333-8333-333333333333';
const validRequest: FetchFault = {
  kind: 'ok',
  body: { challenge: VALID_CHALLENGE, expiresAt: '2099-01-01T00:00:00.000Z' },
};
const validConfirm: FetchFault = {
  kind: 'ok',
  body: { deleted: true, appleAuthorizationRevocation: 'not_applicable' },
};

class FetchScript {
  calls: FetchCall[] = [];
  request: FetchFault[] = [];
  confirm: FetchFault[] = [];
  unexpected: string[] = [];

  install() {
    globalThis.fetch = jest.fn((input: unknown, init?: RequestInit) => {
      const call = { url: String(input), init };
      this.calls.push(call);
      const queue = call.url.endsWith('/v1/me/delete-request')
        ? this.request
        : call.url.endsWith('/v1/me/delete-confirm')
          ? this.confirm
          : null;
      const fault = queue?.shift();
      if (!fault) {
        this.unexpected.push(call.url);
        return Promise.reject(new Error(`unexpected fetch ${call.url}`));
      }
      return respond(fault, call);
    }) as unknown as typeof fetch;
  }
}

// ─── Harness (real navigator + providers) ──────────────────────────────────

const API_BASE = 'https://api.example.test/functions/v1/api';

function syncedSession(provider: 'apple' | 'google'): AuthSession {
  return {
    provider,
    subject: OWNER,
    canonicalAppUserId: OWNER,
    localOnly: false,
    displayName: 'Alex Chen',
    email: 'alex@example.com',
  };
}

function apiSessionFor(provider: 'apple' | 'google'): ApiSession {
  return {
    apiBaseUrl: API_BASE,
    bearerToken: 'access-token-original',
    canonicalAppUserId: OWNER,
    provider,
    refreshToken: 'refresh-token-original',
    bearerExpiresAtMs: Date.now() + 3_600_000,
  };
}

const Stack = createNativeStackNavigator<RootStackParams>();

/** Stand-in for the Settings tab: the only thing it does is the real
 * `navigation.navigate('ManageAccount')` hop Settings performs. */
function SettingsHostRoute() {
  const navigation =
    useNavigation<NativeStackNavigationProp<RootStackParams>>();
  return (
    <View>
      <Text>Settings host</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Manage account"
        onPress={() => navigation.navigate('ManageAccount')}
      >
        <Text>Manage account</Text>
      </Pressable>
    </View>
  );
}

function HarnessApp(props: { initialRoute: 'Tabs' | 'ManageAccount' }) {
  const [queryClient] = React.useState(() => new QueryClient());
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={queryClient}>
        <NavigationContainer>
          <Stack.Navigator
            initialRouteName={props.initialRoute}
            screenOptions={{ headerShown: false }}
          >
            <Stack.Screen name="Tabs" component={SettingsHostRoute} />
            <Stack.Screen
              name="ManageAccount"
              component={ManageAccountScreen}
              options={{ title: 'Manage Account' }}
            />
          </Stack.Navigator>
        </NavigationContainer>
        <BrandNoticeHost />
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}

type Renderer = TestRenderer.ReactTestRenderer;

function allText(r: Renderer): string {
  return r.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function hostsByLabel(r: Renderer, label: string) {
  return r.root.findAll(
    n => typeof n.type === 'string' && n.props.accessibilityLabel === label,
  );
}

function control(r: Renderer, label: string) {
  const matches = r.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      n.props.accessibilityLabel === label &&
      'onPress' in n.props,
  );
  return matches.length ? matches[matches.length - 1]! : null;
}

function buttons(r: Renderer, labelPrefix: string) {
  return r.root
    .findAllByType(Button)
    .filter(n => String(n.props.label).startsWith(labelPrefix));
}

function button(r: Renderer, labelPrefix: string) {
  const found = buttons(r, labelPrefix);
  return found.length ? found[0]! : null;
}

function spinnerCount(r: Renderer): number {
  return r.root.findAllByType(BrandSpinner).length;
}

/** The deletion dialog (survey or confirmation page) is on screen. The
 * BrandNotice host is also a Modal, so match on the dialog's own copy. */
function dialogVisible(r: Renderer): boolean {
  if (!r.root.findAllByType(Modal).some(m => m.props.visible === true)) {
    return false;
  }
  const text = allText(r);
  return (
    text.includes("What's making you leave?") ||
    text.includes('What would have kept you?') ||
    text.includes('Delete your account?')
  );
}

function manageAccountMounted(r: Renderer): boolean {
  return (
    hostsByLabel(r, 'Back').length > 0 && allText(r).includes('Account details')
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
}

async function press(r: Renderer, label: string): Promise<boolean> {
  const c = control(r, label);
  if (!c || c.props.disabled) return false;
  await act(async () => {
    c.props.onPress();
  });
  return true;
}

async function pressButton(r: Renderer, labelPrefix: string): Promise<boolean> {
  const b = button(r, labelPrefix);
  if (!b || b.props.disabled) return false;
  await act(async () => {
    b.props.onPress();
  });
  return true;
}

// ─── Invariant ledger ──────────────────────────────────────────────────────

/**
 * Documented gaps (findings already reported from this campaign). A gap
 * scenario asserts that the CURRENT behaviour still reproduces — the
 * iteration is recorded as BROKEN in the JSON table, but the Jest case stays
 * green so the campaign can live in the suite. When the gap is fixed the case
 * fails with "no longer reproduces", telling the fixer to drop the marker.
 */
const KNOWN_GAPS = {
  'FI-1':
    'deletion.ts relies on fetch honouring AbortSignal: a fetch that never settles (or a body that never arrives after headers) leaves the Requesting…/Deleting… spinner up forever; there is no second-line timer in the screen.',
  'FI-2':
    'completeAccountDeletion has no bound on native cleanup calls: if Keychain reset / SQLite execute / GoogleSignin.revokeAccess never settle, deletionCleanup is never recorded and the LOCAL CLEANUP NEEDED notice never shows (session + bearer are already cleared).',
} as const;
type GapId = keyof typeof KNOWN_GAPS;

class Ledger {
  failures: string[] = [];
  gaps: string[] = [];
  notes: string[] = [];
  check(name: string, ok: boolean, detail?: string) {
    if (!ok) this.failures.push(detail ? `${name}: ${detail}` : name);
  }
  /** xfail: `reproduces` must be true while the gap is open. */
  gap(id: GapId, invariant: string, reproduces: boolean, detail?: string) {
    if (reproduces) {
      this.gaps.push(`${id}: ${invariant}${detail ? `: ${detail}` : ''}`);
    } else {
      this.failures.push(
        `${id} documented gap no longer reproduces (${invariant}) — remove the gap marker and close the finding`,
      );
    }
  }
  note(text: string) {
    this.notes.push(text);
  }
}

interface IterationResult {
  seed: number;
  id: string;
  category: string;
  params: Record<string, unknown>;
  outcome: 'HELD' | 'BROKEN';
  failures: string[];
  /** Reproduced documented gaps (see KNOWN_GAPS); outcome is BROKEN. */
  gaps: string[];
  notes: string[];
  fetchCalls: number;
  consoleErrors: string[];
  durationMs: number;
}

const results: IterationResult[] = [];

// ─── Scenario context ──────────────────────────────────────────────────────

interface Ctx {
  seed: number;
  rng: Rng;
  ledger: Ledger;
  fetch: FetchScript;
  provider: 'apple' | 'google';
  params: Record<string, unknown>;
  renderer: Renderer;
  keychainBefore: string;
  dbBefore: string;
  sessionBefore: AuthSession;
}

const realFetch = globalThis.fetch;

function setupWorld(provider: 'apple' | 'google') {
  mockKeychainState.seed();
  mockKeychainState.clearFaults();
  mockGoogleState.clearFaults();
  mockDbState.db = new FakeLocalDb();
  mockDbState.db.seed();
  mockDbState.getDbThrows = false;
  mockDbState.getDbCalls = 0;
  useAuthStore.setState({
    hydrated: true,
    session: syncedSession(provider),
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  establishApiSession(apiSessionFor(provider));
}

async function mountHarness(
  ctx: Omit<Ctx, 'renderer' | 'keychainBefore' | 'dbBefore' | 'sessionBefore'>,
  initialRoute: 'Tabs' | 'ManageAccount' = 'Tabs',
): Promise<Ctx> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = TestRenderer.create(<HarnessApp initialRoute={initialRoute} />);
  });
  if (initialRoute === 'Tabs') {
    ctx.ledger.check(
      'host route renders',
      allText(renderer).includes('Settings host'),
    );
    const ok = await press(renderer, 'Manage account');
    ctx.ledger.check('navigate to ManageAccount', ok);
  }
  await flush();
  ctx.ledger.check(
    'ManageAccountScreen mounted via real navigator',
    manageAccountMounted(renderer),
    allText(renderer).slice(0, 200),
  );
  return {
    ...ctx,
    renderer,
    keychainBefore: JSON.stringify([...mockKeychainState.store.entries()]),
    dbBefore: mockDbState.db.fingerprint(),
    sessionBefore: useAuthStore.getState().session!,
  };
}

async function pressRadio(r: Renderer, rng: Rng): Promise<void> {
  const radios = r.root.findAll(
    n =>
      typeof n.type !== 'string' &&
      n.props.accessibilityRole === 'radio' &&
      'onPress' in n.props,
  );
  const target = radios[rng.int(0, radios.length - 1)]!;
  await act(async () => {
    target.props.onPress();
  });
}

/** Delete link → survey (seeded path: skip / answer both / answer q1 then
 * skip q2) → confirmation page. */
async function openConfirmPage(ctx: Ctx): Promise<void> {
  const { renderer: r, rng, ledger } = ctx;
  ledger.check(
    'delete link present for synced session',
    hostsByLabel(r, 'Delete account').length === 1,
  );
  await press(r, 'Delete account');
  ledger.check(
    'survey opens',
    dialogVisible(r) && allText(r).includes("What's making you leave?"),
  );
  const surveyPath = rng.pick([
    'skip',
    'answer-both',
    'answer-then-skip',
  ] as const);
  ctx.params['surveyPath'] = surveyPath;
  if (surveyPath === 'skip') {
    await press(r, 'Skip the survey');
  } else {
    ledger.check(
      'Next disabled before a reason',
      button(r, 'Next')?.props.disabled === true,
    );
    await pressRadio(r, rng);
    ledger.check('Next enabled after a reason', await pressButton(r, 'Next'));
    ledger.check(
      'question 2 shown',
      allText(r).includes('What would have kept you?'),
    );
    if (surveyPath === 'answer-both') {
      await pressRadio(r, rng);
      ledger.check(
        'Continue enabled after answer',
        await pressButton(r, 'Continue'),
      );
    } else {
      await press(r, 'Skip this question');
    }
  }
  ledger.check(
    'confirmation page shown',
    allText(r).includes('Delete your account?'),
  );
}

/** Confirmation page → "Continue to delete" (request). */
async function pressContinueToDelete(ctx: Ctx): Promise<void> {
  ctx.ledger.check(
    'Continue to delete enabled',
    await pressButton(ctx.renderer, 'Continue to delete'),
  );
}

/** Review → request (valid) → armed → countdown elapses → enabled. */
async function armWithValidRequest(ctx: Ctx): Promise<void> {
  ctx.fetch.request.push(validRequest);
  await pressContinueToDelete(ctx);
  await flush();
  const b = button(ctx.renderer, 'Permanently delete');
  ctx.ledger.check(
    'armed after valid challenge',
    b !== null && String(b.props.label).includes('(5)'),
    b ? String(b.props.label) : 'no button',
  );
  await advanceClock(ctx, 5_000);
  const armed = button(ctx.renderer, 'Permanently delete');
  ctx.ledger.check(
    'countdown reaches zero and enables',
    armed !== null &&
      armed.props.disabled === false &&
      armed.props.label === 'Permanently delete',
    armed
      ? `${armed.props.label} disabled=${armed.props.disabled}`
      : 'no button',
  );
}

/** Advance the clock by `ms` in a seeded pattern (one jump, or jittered
 * steps) — the countdown must end up in the same place either way. */
async function advanceClock(ctx: Ctx, ms: number): Promise<void> {
  const pattern = (ctx.params['clock'] ??= ctx.rng.pick([
    'jump',
    'jitter',
    'ticks',
  ] as const));
  if (pattern === 'jump') {
    await advance(ms);
    return;
  }
  let left = ms;
  while (left > 0) {
    const step =
      pattern === 'ticks'
        ? Math.min(left, 1_000)
        : Math.min(left, ctx.rng.int(37, 1_700));
    await advance(step);
    left -= step;
  }
}

function assertIntact(ctx: Ctx, label: string) {
  const { ledger } = ctx;
  const state = useAuthStore.getState();
  ledger.check(
    `${label}: session unchanged`,
    state.session === ctx.sessionBefore,
  );
  ledger.check(`${label}: no cleanup ran`, state.deletionCleanup === null);
  ledger.check(
    `${label}: bearer session intact`,
    getApiSession()?.bearerToken === 'access-token-original' ||
      getApiSession()?.bearerToken === 'access-token-rotated',
  );
  ledger.check(
    `${label}: Keychain record untouched`,
    JSON.stringify([...mockKeychainState.store.entries()]) ===
      ctx.keychainBefore,
  );
  ledger.check(
    `${label}: SQLite untouched`,
    mockDbState.db.fingerprint() === ctx.dbBefore &&
      mockDbState.db.mutations === 0,
  );
}

/** Recoverable failure state: visible error, no spinner, an enabled way
 * out (Keep my account / close) and the expected retry control enabled. */
function assertRecoverable(
  ctx: Ctx,
  opts: {
    copy: string | RegExp | null;
    retry: 'Continue to delete' | 'Permanently delete';
  },
) {
  const { renderer: r, ledger } = ctx;
  const text = allText(r);
  ledger.check('dialog still open', dialogVisible(r));
  ledger.check('no spinner after fault', spinnerCount(r) === 0);
  if (opts.copy) {
    ledger.check(
      'production error copy visible',
      typeof opts.copy === 'string'
        ? text.includes(opts.copy)
        : opts.copy.test(text),
      text.slice(
        text.indexOf('Delete your account?'),
        text.indexOf('Delete your account?') + 700,
      ),
    );
  }
  const keep = button(r, 'Keep my account');
  ledger.check(
    'Keep my account enabled',
    keep !== null && !keep.props.disabled,
  );
  const close = control(r, 'Close account deletion confirmation');
  ledger.check(
    'Close control enabled',
    close !== null && !close.props.disabled,
  );
  const scrim = control(r, 'Cancel account deletion');
  ledger.check('scrim cancel enabled', scrim !== null && !scrim.props.disabled);
  const retry = button(r, opts.retry);
  ledger.check(
    `retry control "${opts.retry}" enabled`,
    retry !== null &&
      retry.props.disabled === false &&
      retry.props.label === opts.retry,
    retry ? `${retry.props.label} disabled=${retry.props.disabled}` : 'missing',
  );
  ledger.check(
    'no forbidden store copy',
    !/Android|Google Play|guest mode/i.test(text),
  );
}

function assertDeleted(
  ctx: Ctx,
  opts: { purge: 'complete' | 'failed'; notice: string | null },
) {
  const { renderer: r, ledger } = ctx;
  const state = useAuthStore.getState();
  ledger.check('session cleared', state.session === null);
  ledger.check('bearer cleared', getApiSession() === null);
  ledger.check('dialog closed', !dialogVisible(r));
  ledger.check('no spinner after deletion', spinnerCount(r) === 0);
  ledger.check(
    'delete link gone',
    hostsByLabel(r, 'Delete account').length === 0,
  );
  ledger.check(
    `localPurge reported ${opts.purge}`,
    state.deletionCleanup?.localPurge === opts.purge,
    JSON.stringify(state.deletionCleanup),
  );
  const kc = mockKeychainState.store.get(SESSION_VAULT_SERVICE);
  const kcBefore = new Map<string, unknown>(
    JSON.parse(ctx.keychainBefore) as [string, unknown][],
  );
  ledger.check(
    'Keychain record gone or byte-identical (never corrupted)',
    kc === undefined ||
      JSON.stringify(kc) ===
        JSON.stringify(kcBefore.get(SESSION_VAULT_SERVICE)),
  );
  if (
    !mockKeychainState.accessThrows &&
    (mockKeychainState.reset.kind === 'ok' ||
      mockKeychainState.reset.kind === 'slow')
  ) {
    ledger.check('Keychain record removed', kc === undefined);
  }
  const db = mockDbState.db;
  ledger.check(
    'other owner rows intact',
    db.ownerRows(OTHER_OWNER) === 7,
    String(db.ownerRows(OTHER_OWNER)),
  );
  if (opts.purge === 'complete') {
    ledger.check(
      'deleted owner rows purged',
      db.ownerRows(OWNER) === 0,
      String(db.ownerRows(OWNER)),
    );
  } else {
    ledger.check(
      'failed purge left owner bucket whole (transactional)',
      db.ownerRows(OWNER) === 0 || db.ownerRows(OWNER) === 13,
      String(db.ownerRows(OWNER)),
    );
  }
  ledger.check(
    'no transaction left open',
    db.snapshot === null || db.rollbackFaulted,
    'a healthy ROLLBACK did not close the transaction',
  );
  const text = allText(r);
  if (opts.notice) {
    ledger.check(
      `notice "${opts.notice}" visible`,
      text.includes(opts.notice),
      text.slice(-400),
    );
  } else {
    ledger.check('no cleanup notice', !text.includes('LOCAL CLEANUP NEEDED'));
  }
}

// ─── Fault catalog ─────────────────────────────────────────────────────────

interface Scenario {
  id: string;
  category: string;
  run: (ctx: Ctx) => Promise<void>;
  /** Mount at the root with no route beneath (goBack-at-root). */
  initialRoute?: 'ManageAccount';
  /** Force the signed-in provider (otherwise seeded). */
  provider?: 'apple' | 'google';
}

const OFFLINE_COPY =
  'Account deletion is temporarily offline. Nothing was deleted — please try again.';
const GENERIC_REQUEST_COPY =
  'The deletion request could not be completed. Nothing was deleted.';
const EXPIRED_COPY =
  'Your sign-in has expired. Sign in again, then delete your account.';
const INVALID_CHALLENGE_COPY =
  'The server returned an invalid deletion challenge.';
const INVALID_RESPONSE_COPY =
  'The server returned an invalid deletion response.';
const NOT_CONFIRMED_COPY = 'The server did not confirm the deletion.';

interface RequestFaultExpect {
  copy: string | RegExp | null;
  /** ms the harness must advance before the fault surfaces (timeouts). */
  settleMs?: number;
  /** In-flight spinner expected while the fault is pending. */
  inFlight?: boolean;
  /** Lens invariant: never a spinner after 60s (json-never / ignores abort). */
  expectHang?: boolean;
  /** Fault resolves into a valid challenge (slow-then-valid): expect armed. */
  arms?: boolean;
}

function requestFaultScenario(
  id: string,
  fault: (rng: Rng) => FetchFault,
  expect: RequestFaultExpect,
): Scenario {
  return {
    id,
    category: 'fetch/api request',
    run: async ctx => {
      const f = fault(ctx.rng);
      ctx.params['fault'] = f;
      await openConfirmPage(ctx);
      ctx.fetch.request.push(f);
      await pressContinueToDelete(ctx);
      if (expect.inFlight) {
        ctx.ledger.check(
          'in-flight spinner visible',
          spinnerCount(ctx.renderer) === 1,
        );
        ctx.ledger.check(
          'in-flight button reads Requesting…',
          button(ctx.renderer, 'Requesting…') !== null,
        );
        ctx.ledger.check(
          'Keep my account disabled in flight',
          button(ctx.renderer, 'Keep my account')?.props.disabled === true,
        );
        ctx.ledger.check(
          'close disabled in flight',
          control(ctx.renderer, 'Close account deletion confirmation')?.props
            .disabled === true,
        );
        ctx.ledger.check(
          'hardware back ignored in flight',
          ctx.renderer.root
            .findAllByType(Modal)
            .some(m => m.props.visible && m.props.onRequestClose === undefined),
        );
        // A second press during flight must not fire a second request.
        await pressButton(ctx.renderer, 'Requesting…');
        await pressButton(ctx.renderer, 'Continue to delete');
      }
      await advanceClock(ctx, expect.settleMs ?? 0);
      await flush();
      ctx.ledger.check(
        'exactly one request sent',
        ctx.fetch.calls.length === 1,
        String(ctx.fetch.calls.length),
      );
      // Lens: advance 60s — nothing may still be spinning afterwards.
      await advance(60_000);
      if (expect.expectHang) {
        ctx.ledger.gap(
          'FI-1',
          'no infinite spinner after 60s',
          spinnerCount(ctx.renderer) === 1 &&
            button(ctx.renderer, 'Requesting…') !== null,
          `spinner=${spinnerCount(ctx.renderer)} label=${button(ctx.renderer, 'Requesting…')?.props.label}`,
        );
        ctx.ledger.check(
          'hung request: no way out is a gap, but nothing was deleted',
          useAuthStore.getState().session === ctx.sessionBefore,
        );
        assertIntact(ctx, 'hang');
        return;
      }
      if (expect.arms) {
        const armed = button(ctx.renderer, 'Permanently delete');
        ctx.ledger.check(
          'slow valid response arms',
          armed !== null &&
            armed.props.disabled === false &&
            armed.props.label === 'Permanently delete',
          armed ? String(armed.props.label) : 'no button',
        );
        ctx.ledger.check(
          'no spinner once armed',
          spinnerCount(ctx.renderer) === 0,
        );
        ctx.ledger.check(
          'Keep my account enabled once armed',
          button(ctx.renderer, 'Keep my account')?.props.disabled === false,
        );
        assertIntact(ctx, 'armed after slow response');
        return;
      }
      assertRecoverable(ctx, {
        copy: expect.copy,
        retry: 'Continue to delete',
      });
      assertIntact(ctx, 'after request fault');
      // Recovery: a healthy retry arms the confirmation.
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      ctx.ledger.check(
        'retry clears error',
        !allText(ctx.renderer).includes('Nothing was deleted') || !expect.copy,
      );
      const armed = button(ctx.renderer, 'Permanently delete');
      ctx.ledger.check(
        'retry arms confirmation',
        armed !== null && String(armed.props.label).includes('('),
        armed ? String(armed.props.label) : 'no button',
      );
      ctx.ledger.check(
        'exactly two requests after retry',
        ctx.fetch.calls.length === 2,
      );
      assertIntact(ctx, 'after retry armed');
    },
  };
}

interface ConfirmFaultExpect {
  copy: string | RegExp | null;
  /** Retryable → stays armed (secondsLeft 0); otherwise back to review. */
  retryable: boolean;
  settleMs?: number;
  inFlight?: boolean;
  expectHang?: boolean;
  /** Fault yields a *successful* deletion (e.g. junk revocation field). */
  deletes?: { notice: string | null };
}

function confirmFaultScenario(
  id: string,
  fault: (rng: Rng) => FetchFault,
  expect: ConfirmFaultExpect,
): Scenario {
  return {
    id,
    category: 'fetch/api confirm',
    run: async ctx => {
      const f = fault(ctx.rng);
      ctx.params['fault'] = f;
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      ctx.fetch.confirm.push(f);
      ctx.ledger.check(
        'Permanently delete pressed',
        await pressButton(ctx.renderer, 'Permanently delete'),
      );
      if (expect.inFlight) {
        ctx.ledger.check(
          'deleting spinner visible',
          spinnerCount(ctx.renderer) === 1,
        );
        ctx.ledger.check(
          'button reads Deleting…',
          button(ctx.renderer, 'Deleting…') !== null,
        );
        ctx.ledger.check(
          'Keep my account disabled while deleting',
          button(ctx.renderer, 'Keep my account')?.props.disabled === true,
        );
        await pressButton(ctx.renderer, 'Deleting…');
      }
      await advanceClock(ctx, expect.settleMs ?? 0);
      await flush();
      ctx.ledger.check(
        'exactly one confirm sent',
        ctx.fetch.calls.length === 2,
        String(ctx.fetch.calls.length),
      );
      await advance(60_000);
      if (expect.expectHang) {
        ctx.ledger.gap(
          'FI-1',
          'no infinite spinner after 60s',
          spinnerCount(ctx.renderer) === 1 &&
            button(ctx.renderer, 'Deleting…') !== null,
          `spinner=${spinnerCount(ctx.renderer)}`,
        );
        assertIntact(ctx, 'hang');
        return;
      }
      if (expect.deletes) {
        assertDeleted(ctx, {
          purge: 'complete',
          notice: expect.deletes.notice,
        });
        return;
      }
      assertRecoverable(ctx, {
        copy: expect.copy,
        retry: expect.retryable ? 'Permanently delete' : 'Continue to delete',
      });
      assertIntact(ctx, 'after confirm fault');
      // Recovery: retryable → same challenge again; else a fresh challenge.
      if (expect.retryable) {
        ctx.fetch.confirm.push(validConfirm);
        ctx.ledger.check(
          'retry Permanently delete',
          await pressButton(ctx.renderer, 'Permanently delete'),
        );
        await flush();
        await advance(1_000);
        ctx.ledger.check(
          'same challenge re-sent',
          String(ctx.fetch.calls[2]?.init?.body).includes(VALID_CHALLENGE),
        );
        assertDeleted(ctx, { purge: 'complete', notice: null });
      } else {
        ctx.fetch.request.push(validRequest);
        await pressContinueToDelete(ctx);
        await flush();
        const armed = button(ctx.renderer, 'Permanently delete');
        ctx.ledger.check(
          'fresh challenge re-arms',
          armed !== null && String(armed.props.label).includes('('),
          armed ? String(armed.props.label) : 'no button',
        );
        assertIntact(ctx, 'after re-arm');
      }
    },
  };
}

interface CleanupFaultSpec {
  keychain?: FaultMode | 'access-throws';
  google?:
    | Partial<Pick<typeof mockGoogleState, 'revokeAccess' | 'signOut'>>
    | 'module-throws';
  db?: DbFaultPlan | 'getDb-throws';
  revocation?: unknown;
  /** ms to advance so slow doubles finish. */
  settleMs?: number;
  purge: 'complete' | 'failed';
  notice: string | null;
  /** The cleanup promise is expected to hang (never-resolving native call). */
  hangs?: boolean;
  /** Documented gap this hang reproduces (see KNOWN_GAPS). */
  gap?: GapId;
}

function cleanupFaultScenario(
  id: string,
  category: string,
  spec: (rng: Rng) => CleanupFaultSpec,
  provider?: 'apple' | 'google',
): Scenario {
  return {
    id,
    category,
    provider,
    run: async ctx => {
      const s = spec(ctx.rng);
      ctx.params['cleanup'] = {
        ...s,
        db: typeof s.db === 'function' ? 'plan' : s.db,
      };
      if (s.keychain === 'access-throws') mockKeychainState.accessThrows = true;
      else if (s.keychain) mockKeychainState.reset = s.keychain;
      if (s.google === 'module-throws')
        mockGoogleState.moduleAccessThrows = true;
      else if (s.google) Object.assign(mockGoogleState, s.google);
      if (s.db === 'getDb-throws') mockDbState.getDbThrows = true;
      else if (s.db) mockDbState.db.plan = s.db;
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      ctx.fetch.confirm.push({
        kind: 'ok',
        body: {
          deleted: true,
          ...(s.revocation === undefined
            ? {}
            : { appleAuthorizationRevocation: s.revocation }),
        },
      });
      ctx.ledger.check(
        'Permanently delete pressed',
        await pressButton(ctx.renderer, 'Permanently delete'),
      );
      await flush();
      await advanceClock(ctx, s.settleMs ?? 0);
      await advance(60_000);
      const state = useAuthStore.getState();
      // Whatever the native layers do, the deleted account must be gone from
      // the UI and the bearer store immediately (set before any await).
      ctx.ledger.check('session cleared', state.session === null);
      ctx.ledger.check('bearer cleared', getApiSession() === null);
      ctx.ledger.check('dialog closed', !dialogVisible(ctx.renderer));
      ctx.ledger.check('no spinner', spinnerCount(ctx.renderer) === 0);
      ctx.ledger.check(
        'other owner rows intact',
        mockDbState.db.ownerRows(OTHER_OWNER) === 7,
      );
      if (s.hangs) {
        const recorded = state.deletionCleanup !== null;
        const noticeShown = s.notice
          ? allText(ctx.renderer).includes(s.notice)
          : true;
        if (s.gap) {
          ctx.ledger.gap(
            s.gap,
            'cleanup outcome recorded and notice surfaced within 60s',
            !(recorded && noticeShown),
            `deletionCleanup=${JSON.stringify(state.deletionCleanup)} noticeShown=${noticeShown}`,
          );
        } else {
          ctx.ledger.check(
            'cleanup outcome recorded (no silent hang)',
            recorded,
            'deletionCleanup still null after 60s',
          );
          ctx.ledger.check(
            'notice surfaced',
            noticeShown,
            'notice never shown',
          );
        }
        ctx.ledger.check(
          'owner bucket whole or purged (never partial)',
          mockDbState.db.ownerRows(OWNER) === 0 ||
            mockDbState.db.ownerRows(OWNER) === 13,
        );
        return;
      }
      assertDeleted(ctx, { purge: s.purge, notice: s.notice });
      if (s.notice) {
        ctx.ledger.check(
          'notice dismissible',
          await pressButton(ctx.renderer, 'Got it'),
        );
        ctx.ledger.check(
          'notice dismissed',
          !allText(ctx.renderer).includes(s.notice),
        );
      }
      ctx.ledger.check(
        'exactly two network calls',
        ctx.fetch.calls.length === 2,
      );
    },
  };
}

const failAllPurges: DbFaultPlan = ctx =>
  ctx.attempt > 0 && ctx.sql.startsWith('DELETE FROM local_')
    ? { kind: 'reject' }
    : { kind: 'ok' };
const failFirstAttempts =
  (n: number): DbFaultPlan =>
  ctx =>
    ctx.attempt > 0 &&
    ctx.attempt <= n &&
    ctx.sql.startsWith('DELETE FROM local_session')
      ? { kind: 'reject' }
      : { kind: 'ok' };

const catalog: Scenario[] = [
  // ── fetch/api: request (/v1/me/delete-request) ────────────────────────
  requestFaultScenario('req.throw-sync', () => ({ kind: 'throw' }), {
    copy: OFFLINE_COPY,
  }),
  requestFaultScenario('req.reject-network', () => ({ kind: 'reject' }), {
    copy: OFFLINE_COPY,
  }),
  requestFaultScenario(
    'req.timeout-15s-abort',
    () => ({ kind: 'never-honours-abort' }),
    { copy: OFFLINE_COPY, settleMs: 15_000, inFlight: true },
  ),
  requestFaultScenario(
    'req.never-resolves-ignores-abort',
    () => ({ kind: 'never-ignores-abort' }),
    { copy: null, inFlight: true, expectHang: true },
  ),
  requestFaultScenario(
    'req.body-json-never-resolves',
    () => ({ kind: 'json-never', status: 200 }),
    { copy: null, inFlight: true, expectHang: true },
  ),
  requestFaultScenario(
    'req.slow-then-valid',
    rng => ({ kind: 'slow', ms: rng.int(500, 14_000), then: validRequest }),
    { copy: null, inFlight: true, settleMs: 14_000, arms: true },
  ),
  requestFaultScenario(
    'req.slow-then-503',
    rng => ({
      kind: 'slow',
      ms: rng.int(500, 14_000),
      then: { kind: 'status', status: 503, body: TEXT_BODY },
    }),
    { copy: GENERIC_REQUEST_COPY, inFlight: true, settleMs: 14_000 },
  ),
  requestFaultScenario(
    'req.slow-past-timeout',
    rng => ({ kind: 'slow', ms: rng.int(15_001, 40_000), then: validRequest }),
    { copy: OFFLINE_COPY, inFlight: true, settleMs: 15_000 },
  ),
  requestFaultScenario(
    'req.http-400-message',
    () => ({
      kind: 'status',
      status: 400,
      body: { error: { code: 'bad', message: 'Survey rejected by server.' } },
    }),
    { copy: 'Survey rejected by server.' },
  ),
  requestFaultScenario(
    'req.http-401',
    () => ({
      kind: 'status',
      status: 401,
      body: { error: { message: 'nope' } },
    }),
    { copy: EXPIRED_COPY },
  ),
  requestFaultScenario(
    'req.http-401-text-body',
    () => ({ kind: 'status', status: 401, body: TEXT_BODY }),
    { copy: EXPIRED_COPY },
  ),
  requestFaultScenario(
    'req.http-403',
    () => ({ kind: 'status', status: 403, body: {} }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.http-404',
    () => ({ kind: 'status', status: 404, body: TEXT_BODY }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.http-409-message',
    () => ({
      kind: 'status',
      status: 409,
      body: { error: { message: 'A deletion is already pending.' } },
    }),
    { copy: 'A deletion is already pending.' },
  ),
  requestFaultScenario(
    'req.http-413',
    () => ({ kind: 'status', status: 413, body: null }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.http-429-message',
    () => ({
      kind: 'status',
      status: 429,
      body: { error: { message: 'Too many attempts. Try again in a minute.' } },
    }),
    { copy: 'Too many attempts. Try again in a minute.' },
  ),
  requestFaultScenario(
    'req.http-429-empty',
    () => ({ kind: 'status', status: 429, body: TEXT_BODY }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.http-5xx',
    rng => ({
      kind: 'status',
      status: rng.pick([500, 502, 504, 599]),
      body: { error: { message: 'internal' } },
    }),
    { copy: 'internal' },
  ),
  requestFaultScenario(
    'req.http-503-text',
    () => ({ kind: 'status', status: 503, body: TEXT_BODY }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.error-message-not-string',
    () => ({ kind: 'status', status: 500, body: { error: { message: 42 } } }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.error-shape-array',
    () => ({ kind: 'status', status: 500, body: { error: ['boom'] } }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.status-0',
    () => ({ kind: 'status', status: 0, body: TEXT_BODY }),
    { copy: GENERIC_REQUEST_COPY },
  ),
  requestFaultScenario(
    'req.200-text',
    () => ({ kind: 'status', status: 200, body: TEXT_BODY }),
    { copy: INVALID_RESPONSE_COPY },
  ),
  requestFaultScenario('req.200-null', () => ({ kind: 'ok', body: null }), {
    copy: INVALID_RESPONSE_COPY,
  }),
  requestFaultScenario(
    'req.200-array',
    () => ({ kind: 'ok', body: [VALID_CHALLENGE] }),
    { copy: INVALID_RESPONSE_COPY },
  ),
  requestFaultScenario(
    'req.200-string',
    () => ({ kind: 'ok', body: VALID_CHALLENGE }),
    { copy: INVALID_RESPONSE_COPY },
  ),
  requestFaultScenario(
    'req.200-empty-object',
    () => ({ kind: 'ok', body: {} }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.200-partial-missing-expiresAt',
    () => ({ kind: 'ok', body: { challenge: VALID_CHALLENGE } }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.200-partial-missing-challenge',
    () => ({ kind: 'ok', body: { expiresAt: '2099-01-01T00:00:00.000Z' } }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.200-challenge-number',
    () => ({
      kind: 'ok',
      body: { challenge: 42, expiresAt: '2099-01-01T00:00:00.000Z' },
    }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.200-challenge-null',
    () => ({
      kind: 'ok',
      body: { challenge: null, expiresAt: '2099-01-01T00:00:00.000Z' },
    }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.200-expiresAt-number',
    () => ({
      kind: 'ok',
      body: { challenge: VALID_CHALLENGE, expiresAt: 4102444800000 },
    }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.200-nested-wrong-level',
    () => ({
      kind: 'ok',
      body: {
        data: {
          challenge: VALID_CHALLENGE,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      },
    }),
    { copy: INVALID_CHALLENGE_COPY },
  ),
  requestFaultScenario(
    'req.204-no-body',
    () => ({ kind: 'status', status: 204, body: TEXT_BODY }),
    { copy: INVALID_RESPONSE_COPY },
  ),
  {
    id: 'api.session-missing-at-request',
    category: 'fetch/api session',
    run: async ctx => {
      await openConfirmPage(ctx);
      clearApiSession();
      await pressContinueToDelete(ctx);
      await flush();
      await advance(60_000);
      ctx.ledger.check(
        'no network call without a bearer',
        ctx.fetch.calls.length === 0,
      );
      ctx.ledger.check(
        'copy asks for a synced sign-in',
        allText(ctx.renderer).includes(
          'Sign in to a synced account before deleting it.',
        ),
      );
      ctx.ledger.check('no spinner', spinnerCount(ctx.renderer) === 0);
      ctx.ledger.check(
        'Keep my account enabled',
        button(ctx.renderer, 'Keep my account')?.props.disabled === false,
      );
      ctx.ledger.check(
        'session unchanged',
        useAuthStore.getState().session === ctx.sessionBefore,
      );
      ctx.ledger.check(
        'Keychain untouched',
        JSON.stringify([...mockKeychainState.store.entries()]) ===
          ctx.keychainBefore,
      );
      // Recovery: session re-established → request goes out.
      establishApiSession(apiSessionFor(ctx.provider));
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      ctx.ledger.check(
        'recovers once signed in',
        button(ctx.renderer, 'Permanently delete') !== null,
      );
    },
  },
  {
    id: 'api.session-lost-between-arm-and-confirm',
    category: 'fetch/api session',
    run: async ctx => {
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      clearApiSession();
      ctx.ledger.check(
        'Permanently delete pressed',
        await pressButton(ctx.renderer, 'Permanently delete'),
      );
      await flush();
      await advance(60_000);
      ctx.ledger.check(
        'no confirm call without bearer',
        ctx.fetch.calls.length === 1,
      );
      assertRecoverable(ctx, {
        copy: 'Sign in to a synced account before deleting it.',
        retry: 'Continue to delete',
      });
      ctx.ledger.check(
        'session unchanged',
        useAuthStore.getState().session === ctx.sessionBefore,
      );
      ctx.ledger.check(
        'no cleanup ran',
        useAuthStore.getState().deletionCleanup === null,
      );
    },
  },
  {
    id: 'api.bearer-rotated-mid-flight',
    category: 'fetch/api session',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push({ kind: 'slow', ms: 2_000, then: validRequest });
      await pressContinueToDelete(ctx);
      establishApiSession({
        ...apiSessionFor(ctx.provider),
        bearerToken: 'access-token-rotated',
      });
      await advanceClock(ctx, 2_000);
      await flush();
      await advanceClock(ctx, 5_000);
      ctx.fetch.confirm.push(validConfirm);
      ctx.ledger.check(
        'Permanently delete pressed',
        await pressButton(ctx.renderer, 'Permanently delete'),
      );
      await flush();
      await advance(1_000);
      const headers = ctx.fetch.calls[1]?.init?.headers as
        Record<string, string> | undefined;
      ctx.ledger.check(
        'confirm uses the rotated bearer',
        headers?.['Authorization'] === 'Bearer access-token-rotated',
        JSON.stringify(headers),
      );
      assertDeleted(ctx, { purge: 'complete', notice: null });
    },
  },

  // ── fetch/api: confirm (/v1/me/delete-confirm) ────────────────────────
  confirmFaultScenario('cfm.throw-sync', () => ({ kind: 'throw' }), {
    copy: OFFLINE_COPY,
    retryable: true,
  }),
  confirmFaultScenario('cfm.reject-network', () => ({ kind: 'reject' }), {
    copy: OFFLINE_COPY,
    retryable: true,
  }),
  confirmFaultScenario(
    'cfm.timeout-15s-abort',
    () => ({ kind: 'never-honours-abort' }),
    { copy: OFFLINE_COPY, retryable: true, settleMs: 15_000, inFlight: true },
  ),
  confirmFaultScenario(
    'cfm.never-resolves-ignores-abort',
    () => ({ kind: 'never-ignores-abort' }),
    { copy: null, retryable: true, inFlight: true, expectHang: true },
  ),
  confirmFaultScenario(
    'cfm.body-json-never-resolves',
    () => ({ kind: 'json-never', status: 200 }),
    { copy: null, retryable: true, inFlight: true, expectHang: true },
  ),
  confirmFaultScenario(
    'cfm.slow-then-deleted',
    rng => ({ kind: 'slow', ms: rng.int(500, 14_000), then: validConfirm }),
    {
      copy: null,
      retryable: true,
      inFlight: true,
      settleMs: 14_000,
      deletes: { notice: null },
    },
  ),
  confirmFaultScenario(
    'cfm.slow-then-500',
    rng => ({
      kind: 'slow',
      ms: rng.int(500, 14_000),
      then: { kind: 'status', status: 500, body: null },
    }),
    {
      copy: GENERIC_REQUEST_COPY,
      retryable: true,
      inFlight: true,
      settleMs: 14_000,
    },
  ),
  confirmFaultScenario(
    'cfm.slow-past-timeout',
    rng => ({ kind: 'slow', ms: rng.int(15_001, 30_000), then: validConfirm }),
    { copy: OFFLINE_COPY, retryable: true, inFlight: true, settleMs: 15_000 },
  ),
  confirmFaultScenario(
    'cfm.http-400',
    () => ({
      kind: 'status',
      status: 400,
      body: { error: { message: 'Challenge malformed.' } },
    }),
    { copy: 'Challenge malformed.', retryable: false },
  ),
  confirmFaultScenario(
    'cfm.http-401',
    () => ({ kind: 'status', status: 401, body: {} }),
    { copy: EXPIRED_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.http-403-expired-challenge',
    () => ({
      kind: 'status',
      status: 403,
      body: { error: { message: 'Deletion challenge expired.' } },
    }),
    { copy: 'Deletion challenge expired.', retryable: false },
  ),
  confirmFaultScenario(
    'cfm.http-404',
    () => ({ kind: 'status', status: 404, body: TEXT_BODY }),
    { copy: GENERIC_REQUEST_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.http-409',
    () => ({
      kind: 'status',
      status: 409,
      body: { error: { message: 'Already deleted.' } },
    }),
    { copy: 'Already deleted.', retryable: false },
  ),
  confirmFaultScenario(
    'cfm.http-410',
    () => ({ kind: 'status', status: 410, body: null }),
    { copy: GENERIC_REQUEST_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.http-429',
    () => ({
      kind: 'status',
      status: 429,
      body: { error: { message: 'Slow down.' } },
    }),
    { copy: 'Slow down.', retryable: true },
  ),
  confirmFaultScenario(
    'cfm.http-5xx',
    rng => ({
      kind: 'status',
      status: rng.pick([500, 502, 503, 504]),
      body: TEXT_BODY,
    }),
    { copy: GENERIC_REQUEST_COPY, retryable: true },
  ),
  confirmFaultScenario(
    'cfm.200-text',
    () => ({ kind: 'status', status: 200, body: TEXT_BODY }),
    { copy: INVALID_RESPONSE_COPY, retryable: false },
  ),
  confirmFaultScenario('cfm.200-null', () => ({ kind: 'ok', body: null }), {
    copy: INVALID_RESPONSE_COPY,
    retryable: false,
  }),
  confirmFaultScenario(
    'cfm.200-array',
    () => ({ kind: 'ok', body: [{ deleted: true }] }),
    { copy: INVALID_RESPONSE_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.200-empty-object',
    () => ({ kind: 'ok', body: {} }),
    { copy: NOT_CONFIRMED_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-false',
    () => ({ kind: 'ok', body: { deleted: false } }),
    { copy: NOT_CONFIRMED_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-string-true',
    () => ({ kind: 'ok', body: { deleted: 'true' } }),
    { copy: NOT_CONFIRMED_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-1',
    () => ({ kind: 'ok', body: { deleted: 1 } }),
    { copy: NOT_CONFIRMED_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-nested',
    () => ({ kind: 'ok', body: { result: { deleted: true } } }),
    { copy: NOT_CONFIRMED_COPY, retryable: false },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-true-revocation-garbage',
    rng => ({
      kind: 'ok',
      body: {
        deleted: true,
        appleAuthorizationRevocation: rng.pick([
          'REVOKED',
          42,
          null,
          { x: 1 },
          ['revoked'],
        ]),
      },
    }),
    { copy: null, retryable: true, deletes: { notice: null } },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-true-missing-revocation',
    () => ({ kind: 'ok', body: { deleted: true } }),
    { copy: null, retryable: true, deletes: { notice: null } },
  ),
  confirmFaultScenario(
    'cfm.200-deleted-true-manual-apple-step',
    () => ({
      kind: 'ok',
      body: {
        deleted: true,
        appleAuthorizationRevocation: 'manual_action_required',
      },
    }),
    { copy: null, retryable: true, deletes: { notice: 'ONE APPLE STEP' } },
  ),

  // ── Keychain (react-native-keychain via real sessionVault) ────────────
  cleanupFaultScenario('kc.reset-rejects', 'keychain', () => ({
    keychain: { kind: 'reject' },
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('kc.reset-throws-sync', 'keychain', () => ({
    keychain: { kind: 'throw' },
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('kc.reset-returns-false', 'keychain', () => ({
    keychain: { kind: 'false' },
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('kc.reset-slow', 'keychain', rng => ({
    keychain: { kind: 'slow', ms: rng.int(100, 4_000) },
    settleMs: 4_000,
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('kc.module-access-throws', 'keychain', () => ({
    keychain: 'access-throws',
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('kc.reset-never-resolves', 'keychain', () => ({
    keychain: { kind: 'never' },
    purge: 'complete',
    notice: null,
    hangs: true,
    gap: 'FI-2',
  })),
  cleanupFaultScenario('kc.reset-rejects+purge-fails', 'keychain', () => ({
    keychain: { kind: 'reject' },
    db: failAllPurges,
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),

  // ── SQLite (op-sqlite via real repository/authStore) ───────────────────
  cleanupFaultScenario('db.getDb-throws', 'sqlite', () => ({
    db: 'getDb-throws',
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.execute-rejects-all', 'sqlite', () => ({
    db: () => ({ kind: 'reject' }),
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.execute-throws-sync-all', 'sqlite', () => ({
    db: () => ({ kind: 'throw' }),
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.purge-fails-attempt-1', 'sqlite', () => ({
    db: failFirstAttempts(1),
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('db.purge-fails-attempts-1-2', 'sqlite', () => ({
    db: failFirstAttempts(2),
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('db.purge-fails-all-3-attempts', 'sqlite', () => ({
    db: failFirstAttempts(3),
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.purge-partial-table-fails', 'sqlite', rng => {
    const table = rng.pick(OWNER_TABLES);
    return {
      db: ctx =>
        ctx.attempt > 0 &&
        ctx.sql === `DELETE FROM ${table} WHERE owner_key = ?`
          ? { kind: 'reject' }
          : { kind: 'ok' },
      purge: 'failed',
      notice: 'LOCAL CLEANUP NEEDED',
    };
  }),
  cleanupFaultScenario('db.purge-kv-delete-fails', 'sqlite', () => ({
    db: ctx =>
      ctx.attempt > 0 && ctx.sql === 'DELETE FROM kv WHERE key = ?'
        ? { kind: 'reject' }
        : { kind: 'ok' },
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.begin-rejects', 'sqlite', () => ({
    db: ctx =>
      ctx.sql.startsWith('BEGIN') ? { kind: 'reject' } : { kind: 'ok' },
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.commit-rejects', 'sqlite', () => ({
    db: ctx => (ctx.sql === 'COMMIT' ? { kind: 'reject' } : { kind: 'ok' }),
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.commit-and-rollback-reject', 'sqlite', () => ({
    db: ctx =>
      ctx.sql === 'COMMIT' || ctx.sql === 'ROLLBACK'
        ? { kind: 'reject' }
        : { kind: 'ok' },
    purge: 'failed',
    notice: 'LOCAL CLEANUP NEEDED',
  })),
  cleanupFaultScenario('db.kv-writes-reject-only', 'sqlite', () => ({
    db: ctx =>
      ctx.sql.startsWith('INSERT OR REPLACE INTO kv')
        ? { kind: 'reject' }
        : { kind: 'ok' },
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('db.execute-slow', 'sqlite', rng => ({
    db: () => ({ kind: 'slow', ms: rng.int(20, 400) }),
    settleMs: 20_000,
    purge: 'complete',
    notice: null,
  })),
  cleanupFaultScenario('db.execute-never-resolves', 'sqlite', () => ({
    db: ctx =>
      ctx.sql.startsWith('DELETE FROM local_shot')
        ? { kind: 'never' }
        : { kind: 'ok' },
    purge: 'complete',
    notice: null,
    hangs: true,
    gap: 'FI-2',
  })),
  cleanupFaultScenario('db.kv-write-never-resolves', 'sqlite', () => ({
    db: ctx =>
      ctx.sql.startsWith('INSERT OR REPLACE INTO kv')
        ? { kind: 'never' }
        : { kind: 'ok' },
    purge: 'complete',
    notice: null,
    hangs: true,
    gap: 'FI-2',
  })),

  // ── Google Sign-In SDK (provider disconnect after deletion) ───────────
  cleanupFaultScenario(
    'gs.revokeAccess-rejects',
    'google-signin',
    () => ({
      google: { revokeAccess: { kind: 'reject' } },
      purge: 'complete',
      notice: null,
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.revokeAccess-throws-sync',
    'google-signin',
    () => ({
      google: { revokeAccess: { kind: 'throw' } },
      purge: 'complete',
      notice: null,
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.signOut-rejects',
    'google-signin',
    () => ({
      google: { signOut: { kind: 'reject' } },
      purge: 'complete',
      notice: null,
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.module-access-throws',
    'google-signin',
    () => ({ google: 'module-throws', purge: 'complete', notice: null }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.revokeAccess-slow',
    'google-signin',
    rng => ({
      google: { revokeAccess: { kind: 'slow', ms: rng.int(100, 5_000) } },
      settleMs: 5_000,
      purge: 'complete',
      notice: null,
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.revokeAccess-slow+purge-failed-notice-delayed',
    'google-signin',
    rng => ({
      google: { revokeAccess: { kind: 'slow', ms: rng.int(1_000, 5_000) } },
      db: failAllPurges,
      settleMs: 5_000,
      purge: 'failed',
      notice: 'LOCAL CLEANUP NEEDED',
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.revokeAccess-never-resolves',
    'google-signin',
    () => ({
      google: { revokeAccess: { kind: 'never' } },
      purge: 'complete',
      notice: null,
      hangs: true,
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.revokeAccess-never-resolves+purge-failed',
    'google-signin',
    () => ({
      google: { revokeAccess: { kind: 'never' } },
      db: failAllPurges,
      purge: 'failed',
      notice: 'LOCAL CLEANUP NEEDED',
      hangs: true,
      gap: 'FI-2',
    }),
    'google',
  ),
  cleanupFaultScenario(
    'gs.apple-provider-never-touches-google',
    'google-signin',
    () => ({ google: 'module-throws', purge: 'complete', notice: null }),
    'apple',
  ),

  // ── Navigation (real native-stack) ───────────────────────────────────
  {
    id: 'nav.back-during-requesting-then-late-response',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push({ kind: 'slow', ms: 3_000, then: validRequest });
      await pressContinueToDelete(ctx);
      ctx.ledger.check(
        'header Back pressed mid-request',
        await press(ctx.renderer, 'Back'),
      );
      await flush();
      ctx.ledger.check(
        'ManageAccount popped',
        !manageAccountMounted(ctx.renderer),
      );
      ctx.ledger.check(
        'host route visible',
        allText(ctx.renderer).includes('Settings host'),
      );
      await advance(60_000);
      ctx.ledger.check(
        'late response did not resurrect the dialog',
        !dialogVisible(ctx.renderer),
      );
      ctx.ledger.check('only one request sent', ctx.fetch.calls.length === 1);
      assertIntact(ctx, 'after pop');
      // Re-enter: the screen starts clean.
      await press(ctx.renderer, 'Manage account');
      await flush();
      ctx.ledger.check(
        're-entered screen mounted',
        manageAccountMounted(ctx.renderer),
      );
      ctx.ledger.check(
        'dialog closed on re-entry',
        !dialogVisible(ctx.renderer),
      );
      ctx.ledger.check(
        'no spinner on re-entry',
        spinnerCount(ctx.renderer) === 0,
      );
    },
  },
  {
    id: 'nav.back-during-armed-countdown',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      ctx.ledger.check(
        'header Back pressed while armed',
        await press(ctx.renderer, 'Back'),
      );
      await flush();
      ctx.ledger.check(
        'ManageAccount popped',
        !manageAccountMounted(ctx.renderer),
      );
      await advance(60_000);
      ctx.ledger.check(
        'countdown interval released (no timer ticking after pop)',
        jest.getTimerCount() === 0,
        String(jest.getTimerCount()),
      );
      assertIntact(ctx, 'after pop while armed');
      ctx.ledger.check(
        'no confirm was ever sent',
        ctx.fetch.calls.length === 1,
      );
    },
  },
  {
    id: 'nav.back-during-deleting-then-success',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      ctx.fetch.confirm.push({ kind: 'slow', ms: 2_000, then: validConfirm });
      ctx.ledger.check(
        'Permanently delete pressed',
        await pressButton(ctx.renderer, 'Permanently delete'),
      );
      ctx.ledger.check(
        'header Back pressed mid-confirm',
        await press(ctx.renderer, 'Back'),
      );
      await flush();
      ctx.ledger.check(
        'ManageAccount popped',
        !manageAccountMounted(ctx.renderer),
      );
      await advance(60_000);
      // The server deleted the account: local cleanup must still happen even
      // though the screen that started it is gone.
      const state = useAuthStore.getState();
      ctx.ledger.check(
        'session cleared after popped-screen success',
        state.session === null,
      );
      ctx.ledger.check('bearer cleared', getApiSession() === null);
      ctx.ledger.check(
        'Keychain record removed',
        mockKeychainState.store.get(SESSION_VAULT_SERVICE) === undefined,
      );
      ctx.ledger.check(
        'owner rows purged',
        mockDbState.db.ownerRows(OWNER) === 0,
      );
      ctx.ledger.check(
        'localPurge complete',
        state.deletionCleanup?.localPurge === 'complete',
      );
    },
  },
  {
    id: 'nav.back-during-deleting-then-failure',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      ctx.fetch.confirm.push({
        kind: 'slow',
        ms: 2_000,
        then: { kind: 'status', status: 503, body: null },
      });
      ctx.ledger.check(
        'Permanently delete pressed',
        await pressButton(ctx.renderer, 'Permanently delete'),
      );
      ctx.ledger.check(
        'header Back pressed mid-confirm',
        await press(ctx.renderer, 'Back'),
      );
      await flush();
      await advance(60_000);
      assertIntact(ctx, 'after pop then failed confirm');
      ctx.ledger.check('no dialog after pop', !dialogVisible(ctx.renderer));
    },
  },
  {
    id: 'nav.goBack-at-root-no-history',
    category: 'navigation',
    initialRoute: 'ManageAccount',
    run: async ctx => {
      ctx.ledger.check(
        'Back pressed with nothing beneath',
        await press(ctx.renderer, 'Back'),
      );
      await flush();
      ctx.ledger.check(
        'screen still mounted and usable',
        manageAccountMounted(ctx.renderer),
      );
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      ctx.fetch.confirm.push(validConfirm);
      await pressButton(ctx.renderer, 'Permanently delete');
      await flush();
      await advance(1_000);
      assertDeleted(ctx, { purge: 'complete', notice: null });
    },
  },
  {
    id: 'nav.rapid-double-back',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      const back = control(ctx.renderer, 'Back')!;
      await act(async () => {
        back.props.onPress();
        back.props.onPress();
      });
      await flush();
      ctx.ledger.check(
        'host route visible after double back',
        allText(ctx.renderer).includes('Settings host'),
      );
      ctx.ledger.check(
        'host still mounted (not popped past root)',
        hostsByLabel(ctx.renderer, 'Manage account').length === 1,
      );
      assertIntact(ctx, 'after double back');
    },
  },
  {
    id: 'nav.cancel-controls-locked-while-busy',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push({ kind: 'slow', ms: 4_000, then: validRequest });
      await pressContinueToDelete(ctx);
      ctx.ledger.check(
        'scrim cancel disabled while busy',
        !(await press(ctx.renderer, 'Cancel account deletion')),
      );
      ctx.ledger.check(
        'close disabled while busy',
        !(await press(ctx.renderer, 'Close account deletion confirmation')),
      );
      ctx.ledger.check(
        'Keep my account disabled while busy',
        !(await pressButton(ctx.renderer, 'Keep my account')),
      );
      ctx.ledger.check('dialog still open', dialogVisible(ctx.renderer));
      await advanceClock(ctx, 4_000);
      await flush();
      ctx.ledger.check(
        'armed after slow request',
        button(ctx.renderer, 'Permanently delete') !== null,
      );
      ctx.ledger.check(
        'scrim cancel enabled once armed',
        await press(ctx.renderer, 'Cancel account deletion'),
      );
      ctx.ledger.check('dialog closed by scrim', !dialogVisible(ctx.renderer));
      await advance(60_000);
      assertIntact(ctx, 'after cancel while armed');
      // Re-open: state is reset to the survey, no stale challenge.
      await press(ctx.renderer, 'Delete account');
      ctx.ledger.check(
        're-open starts at survey',
        allText(ctx.renderer).includes("What's making you leave?"),
      );
      ctx.ledger.check(
        'no stale armed button',
        button(ctx.renderer, 'Permanently delete') === null,
      );
    },
  },
  {
    id: 'nav.unmount-whole-tree-mid-request',
    category: 'navigation',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push({ kind: 'slow', ms: 2_000, then: validRequest });
      await pressContinueToDelete(ctx);
      await act(async () => {
        ctx.renderer.unmount();
      });
      await advance(60_000);
      ctx.ledger.check(
        'session unchanged after unmount',
        useAuthStore.getState().session === ctx.sessionBefore,
      );
      ctx.ledger.check('single request', ctx.fetch.calls.length === 1);
    },
  },

  // ── Clock ─────────────────────────────────────────────────────────────
  {
    id: 'clk.countdown-starved-no-ticks',
    category: 'clock',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      const armed = button(ctx.renderer, 'Permanently delete');
      ctx.ledger.check(
        'armed disabled with (5)',
        armed?.props.disabled === true &&
          armed.props.label === 'Permanently delete (5)',
      );
      ctx.ledger.check(
        'no spinner while armed',
        spinnerCount(ctx.renderer) === 0,
      );
      // Clock never advances: the destructive button stays locked but the
      // user always has a way out.
      ctx.ledger.check(
        'Keep my account enabled while locked',
        button(ctx.renderer, 'Keep my account')?.props.disabled === false,
      );
      ctx.ledger.check(
        'close enabled while locked',
        control(ctx.renderer, 'Close account deletion confirmation')?.props
          .disabled === false,
      );
      await pressButton(ctx.renderer, 'Permanently delete');
      ctx.ledger.check(
        'locked button sends nothing',
        ctx.fetch.calls.length === 1,
      );
      assertIntact(ctx, 'starved clock');
    },
  },
  {
    id: 'clk.countdown-jittered-steps',
    category: 'clock',
    run: async ctx => {
      ctx.params['clock'] = 'jitter';
      await openConfirmPage(ctx);
      await armWithValidRequest(ctx);
      const labels: string[] = [];
      await advanceClock(ctx, 3_000);
      labels.push(
        String(button(ctx.renderer, 'Permanently delete')?.props.label),
      );
      ctx.ledger.check(
        'never negative seconds',
        !labels.some(l => l.includes('(-')),
        labels.join(','),
      );
      ctx.ledger.check(
        'stays enabled at zero',
        button(ctx.renderer, 'Permanently delete')?.props.disabled === false,
      );
      ctx.fetch.confirm.push(validConfirm);
      await pressButton(ctx.renderer, 'Permanently delete');
      await flush();
      await advance(1_000);
      assertDeleted(ctx, { purge: 'complete', notice: null });
    },
  },
  {
    id: 'clk.countdown-huge-jump',
    category: 'clock',
    run: async ctx => {
      ctx.params['clock'] = 'jump';
      await openConfirmPage(ctx);
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      await advance(60_000 * 60);
      const b = button(ctx.renderer, 'Permanently delete');
      ctx.ledger.check(
        'label settles at Permanently delete',
        b?.props.label === 'Permanently delete',
        String(b?.props.label),
      );
      ctx.ledger.check('enabled after jump', b?.props.disabled === false);
      ctx.ledger.check(
        'interval stopped (no leaked ticking)',
        jest.getTimerCount() === 0,
        String(jest.getTimerCount()),
      );
      assertIntact(ctx, 'after jump');
    },
  },
  {
    id: 'clk.countdown-tick-by-tick',
    category: 'clock',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      const seen: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        seen.push(
          String(button(ctx.renderer, 'Permanently delete')?.props.label),
        );
        await advance(1_000);
      }
      seen.push(
        String(button(ctx.renderer, 'Permanently delete')?.props.label),
      );
      ctx.ledger.check(
        'countdown 5→0 monotonic',
        seen.join('|') ===
          'Permanently delete (5)|Permanently delete (4)|Permanently delete (3)|Permanently delete (2)|Permanently delete (1)|Permanently delete',
        seen.join('|'),
      );
      assertIntact(ctx, 'tick by tick');
    },
  },
  {
    id: 'clk.cancel-mid-countdown-reopen-fresh',
    category: 'clock',
    run: async ctx => {
      await openConfirmPage(ctx);
      ctx.fetch.request.push(validRequest);
      await pressContinueToDelete(ctx);
      await flush();
      await advance(ctx.rng.int(0, 4) * 1_000);
      ctx.ledger.check(
        'Keep my account mid-countdown',
        await pressButton(ctx.renderer, 'Keep my account'),
      );
      ctx.ledger.check('dialog closed', !dialogVisible(ctx.renderer));
      await advance(60_000);
      assertIntact(ctx, 'cancelled mid-countdown');
      await press(ctx.renderer, 'Delete account');
      await press(ctx.renderer, 'Skip the survey');
      ctx.ledger.check(
        'reopened at review, no armed state',
        button(ctx.renderer, 'Continue to delete') !== null &&
          button(ctx.renderer, 'Permanently delete') === null,
      );
      ctx.ledger.check(
        'no stale error',
        !allText(ctx.renderer).includes('Nothing was deleted.'),
      );
    },
  },

  // ── Linking (subscription-management link) ────────────────────────────
  {
    id: 'lnk.openURL-rejects',
    category: 'linking',
    run: async ctx => {
      const spy = jest
        .spyOn(Linking, 'openURL')
        .mockImplementation(() =>
          Promise.reject(new Error('No app can open this URL')),
        );
      try {
        await openConfirmPage(ctx);
        ctx.ledger.check(
          'Manage subscription pressed',
          await press(ctx.renderer, 'Manage subscription in the App Store'),
        );
        await flush();
        await advance(1_000);
        ctx.ledger.check(
          'link failure surfaces a notice',
          allText(ctx.renderer).includes('Could not open subscriptions'),
        );
        ctx.ledger.check(
          'notice copy names the App Store, never Google Play',
          allText(ctx.renderer).includes('App Store') &&
            !/Google Play/.test(allText(ctx.renderer)),
        );
        ctx.ledger.check(
          'notice dismissible',
          await pressButton(ctx.renderer, 'Got it'),
        );
        ctx.ledger.check(
          'dialog still open after notice',
          dialogVisible(ctx.renderer) &&
            allText(ctx.renderer).includes('Delete your account?'),
        );
        ctx.ledger.check(
          'Continue to delete still enabled',
          button(ctx.renderer, 'Continue to delete')?.props.disabled === false,
        );
        assertIntact(ctx, 'after link failure');
      } finally {
        spy.mockRestore();
      }
    },
  },
  {
    id: 'lnk.openURL-never-resolves',
    category: 'linking',
    run: async ctx => {
      const spy = jest
        .spyOn(Linking, 'openURL')
        .mockImplementation(() => new Promise<void>(() => {}));
      try {
        await openConfirmPage(ctx);
        await press(ctx.renderer, 'Manage subscription in the App Store');
        await advance(60_000);
        ctx.ledger.check(
          'no spinner for a hung link',
          spinnerCount(ctx.renderer) === 0,
        );
        ctx.ledger.check(
          'no notice for a hung link',
          !allText(ctx.renderer).includes('Could not open subscriptions'),
        );
        ctx.ledger.check(
          'Continue to delete still enabled',
          button(ctx.renderer, 'Continue to delete')?.props.disabled === false,
        );
        assertIntact(ctx, 'after hung link');
      } finally {
        spy.mockRestore();
      }
    },
  },
  {
    id: 'lnk.openURL-slow-resolves',
    category: 'linking',
    run: async ctx => {
      const spy = jest
        .spyOn(Linking, 'openURL')
        .mockImplementation(
          () =>
            new Promise<void>(resolve => setTimeout(() => resolve(), 2_000)),
        );
      try {
        await openConfirmPage(ctx);
        await press(ctx.renderer, 'Manage subscription in the App Store');
        await advance(60_000);
        ctx.ledger.check(
          'no notice on success',
          !allText(ctx.renderer).includes('Could not open subscriptions'),
        );
        ctx.ledger.check('opened exactly once', spy.mock.calls.length === 1);
        assertIntact(ctx, 'after slow link');
      } finally {
        spy.mockRestore();
      }
    },
  },
];

// ─── Random combination iterations (STRESS_ITER) ───────────────────────────

const requestFaults = catalog.filter(
  s =>
    s.category === 'fetch/api request' &&
    !s.id.includes('never') &&
    !s.id.includes('json-never'),
);
const confirmFaults = catalog.filter(
  s =>
    s.category === 'fetch/api confirm' &&
    !s.id.includes('never') &&
    !s.id.includes('json-never'),
);
const cleanupFaults = catalog.filter(
  s =>
    ['keychain', 'sqlite', 'google-signin'].includes(s.category) &&
    !s.id.includes('never'),
);

function comboScenario(index: number): Scenario {
  return {
    id: `combo.${index}`,
    category: 'combo',
    run: async ctx => {
      // Request fault → recovery, then confirm fault → recovery, then a
      // cleanup fault — three independent failures in one user journey.
      const req = ctx.rng.pick(requestFaults);
      const cfm = ctx.rng.pick(confirmFaults);
      const cln = ctx.rng.pick(cleanupFaults);
      ctx.params['combo'] = [req.id, cfm.id, cln.id];
      await req.run(ctx);
      // req.run leaves the dialog armed after its recovery step; cancel and
      // start over so cfm.run sees a fresh review page.
      if (dialogVisible(ctx.renderer)) {
        await advanceClock(ctx, 5_000);
        await pressButton(ctx.renderer, 'Keep my account');
      }
      ctx.fetch.calls = [];
      ctx.fetch.request = [];
      ctx.fetch.confirm = [];
      const stateAfterReq = useAuthStore.getState().session;
      if (stateAfterReq === null) return;
      if (cfm.id.includes('deleted')) {
        // Confirm fault that ends in a deletion: run it with the cleanup fault
        // armed so the cleanup layer is also exercised.
        await cln.run(ctx);
        return;
      }
      await cfm.run(ctx);
    },
  };
}

// ─── Campaign runner ───────────────────────────────────────────────────────

const plan: Array<{ seed: number; scenario: Scenario }> = [];
catalog.forEach((scenario, index) =>
  plan.push({ seed: hashSeed(CAMPAIGN_SEED, index), scenario }),
);
for (let i = 0; i < EXTRA_ITER; i += 1) {
  plan.push({
    seed: hashSeed(CAMPAIGN_SEED, 10_000 + i),
    scenario: comboScenario(i),
  });
}
const selected =
  ONLY_SEED === null ? plan : plan.filter(p => p.seed === ONLY_SEED);

beforeAll(() => {
  if (selected.length === 0) {
    throw new Error(`STRESS_ONLY=${ONLY_SEED} matches no planned seed`);
  }
});

let consoleErrors: string[] = [];
let consoleErrorSpy: jest.SpyInstance | null = null;

beforeEach(() => {
  jest.useFakeTimers({
    doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
  });
  consoleErrors = [];
  consoleErrorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 300),
      );
    });
});

afterEach(() => {
  consoleErrorSpy?.mockRestore();
  globalThis.fetch = realFetch;
  jest.useRealTimers();
  clearApiSession();
  useAuthStore.setState({ session: null, deletionCleanup: null });
});

afterAll(() => {
  const held = results.filter(r => r.outcome === 'HELD').length;
  const broken = results.filter(r => r.outcome === 'BROKEN');
  const summary = {
    campaignSeed: CAMPAIGN_SEED,
    extraIterations: EXTRA_ITER,
    executed: results.length,
    held,
    broken: broken.length,
    brokenSeeds: broken.map(r => ({
      seed: r.seed,
      id: r.id,
      failures: r.failures,
      gaps: r.gaps,
    })),
    knownGaps: KNOWN_GAPS,
    results,
  };
  if (OUT_PATH) {
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(summary, null, 2));
  }
  console.warn(
    `[stress:manageAccount:failure-injection] seed=${CAMPAIGN_SEED} executed=${results.length} held=${held} broken=${broken.length}${OUT_PATH ? ` → ${OUT_PATH}` : ''}`,
  );
});

describe('ManageAccountScreen — failure injection (seeded campaign)', () => {
  test.each(selected.map(p => [p.scenario.id, p.seed, p.scenario] as const))(
    '%s (seed %d)',
    async (_id, seed, scenario) => {
      const started = Date.now();
      const rng = new Rng(seed);
      const ledger = new Ledger();
      const params: Record<string, unknown> = {};
      const provider =
        scenario.provider ?? rng.pick(['apple', 'google'] as const);
      params['provider'] = provider;
      setupWorld(provider);
      const script = new FetchScript();
      script.install();
      let ctx: Ctx | null = null;
      try {
        ctx = await mountHarness(
          { seed, rng, ledger, fetch: script, provider, params },
          scenario.initialRoute ?? 'Tabs',
        );
        await scenario.run(ctx);
        ledger.check(
          'no unexpected network calls',
          script.unexpected.length === 0,
          script.unexpected.join(','),
        );
        ledger.check(
          'fake store saw only known SQL',
          mockDbState.db.unsupported.length === 0,
          mockDbState.db.unsupported.join(' | '),
        );
      } catch (e) {
        ledger.failures.push(
          `threw: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
        );
      } finally {
        try {
          await act(async () => {
            ctx?.renderer.unmount();
          });
        } catch {
          // Already unmounted by the scenario.
        }
      }
      results.push({
        seed,
        id: scenario.id,
        category: scenario.category,
        params,
        outcome:
          ledger.failures.length === 0 && ledger.gaps.length === 0
            ? 'HELD'
            : 'BROKEN',
        failures: ledger.failures,
        gaps: ledger.gaps,
        notes: ledger.notes,
        fetchCalls: script.calls.length,
        consoleErrors,
        durationMs: Date.now() - started,
      });
      expect(ledger.failures).toEqual([]);
    },
  );
});
