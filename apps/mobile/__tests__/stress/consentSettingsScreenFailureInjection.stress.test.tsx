/**
 * Failure-injection stress harness for ConsentSettingsScreen.
 *
 * The screen is rendered inside the REAL react-navigation container and a
 * real native-stack navigator (pushed from a Settings stub exactly like the
 * app does), with the REAL consent store, consent API client, api-session
 * store and auth store. Only two things are replaced: the transport
 * (`globalThis.fetch`, which the consent client reads per call) and the
 * safe-area native module (the library's own jest mock).
 *
 * Every dependency the screen has is faulted from the outside:
 *   transport  — sync throw, reject, abort, hang (honouring / ignoring the
 *                AbortSignal), slow just under / just over the 15 s client
 *                timeout, every HTTP status the edge fn can return, a body
 *                whose json() rejects or throws, a non-Response value.
 *   payload    — null / array / string / missing scopes / malformed rows /
 *                unknown scopes / wrong primitive types / duplicate rows /
 *                huge / prototype keys / inconsistent flags.
 *   server     — 200 without applying the change, change applied but the
 *                response lost (hang or reject), reordered (deferred) reads.
 *   session    — signed out at mount, sign-out or account switch while a
 *                read or write is in flight, session flapping, token rotation.
 *   navigation — back with and without a route underneath, Connect account
 *                with and without the route registered, double back.
 *   clock      — fake timers advanced to 60 s after every scenario.
 *
 * Two campaigns share one oracle:
 *   1. a deterministic catalog (every fault once, plus hand-written session /
 *      navigation / ordering scenarios), and
 *   2. a seeded random campaign (`STRESS_ITER`, default 25) whose every
 *      iteration is replayable from its seed and whose per-seed outcome is
 *      written to `STRESS_OUT` when set.
 *
 * Oracle (checked after every step and after settling at 60 s):
 *   O1 no thrown error, no unexpected console.error
 *   O2 while mounted the Back control is always present
 *   O3 `loading` only while a request is genuinely in flight; never after 60 s
 *   O4 `busy` only while a write is in flight
 *   O5 `unavailable` ⇒ visible error text + "Try again"
 *   O6 `signed_out` ⇒ "Connect account", toggle OFF and disabled
 *   O7 `ready` ⇒ toggle mirrors the server ledger for the CURRENT account
 *   O8 the AbortSignal is handed to fetch and fires at the documented timeout
 *   O9 no timers leak once the screen is gone and every request settled
 *
 * Violations are mapped to finding ids so the random campaign can tell a
 * known, pinned failure mode from a new one:
 *   CS-1 a stale status read (from an earlier mount) lands after a newer
 *        grant/withdraw and overwrites the toggle
 *   CS-2 a write the server applied but whose response was lost is reported
 *        as "Nothing was changed" and never reconciled
 *   CS-3 a 401 from the consent routes never reaches the unauthorized
 *        listener the other API clients report to
 */
import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import * as fs from 'node:fs';
import * as path from 'node:path';

jest.mock('../../src/data/db', () => ({ getDb: jest.fn() }));

jest.mock('react-native-safe-area-context', () => {
  const mock = jest.requireActual<{ default: Record<string, unknown> }>(
    'react-native-safe-area-context/jest/mock',
  );
  return { __esModule: true, ...mock.default };
});

import {
  NavigationContainer,
  createNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ConsentSettingsScreen } from '../../src/screens/ConsentSettingsScreen';
import { useConsentStore } from '../../src/state/consentStore';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  setApiUnauthorizedListener,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  CONSENT_REQUEST_TIMEOUT_MS,
  MODEL_TRAINING_CONSENT_VERSION,
} from '../../src/account/consentApi';

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

type Account = 'A' | 'B';

const ACCOUNT_IDS: Record<Account, string> = {
  A: 'a0000000-0000-4000-8000-00000000000a',
  B: 'b0000000-0000-4000-8000-00000000000b',
};

function authSession(account: Account): AuthSession {
  return {
    provider: account === 'A' ? 'apple' : 'google',
    subject: ACCOUNT_IDS[account],
    canonicalAppUserId: ACCOUNT_IDS[account],
    localOnly: false,
    displayName: account === 'A' ? 'Alex' : 'Blair',
    email: `${account.toLowerCase()}@example.test`,
  };
}

function apiSession(account: Account, tokenSuffix = ''): ApiSession {
  return {
    apiBaseUrl: 'https://api.example.test',
    bearerToken: `bearer-${account}${tokenSuffix}`,
    canonicalAppUserId: ACCOUNT_IDS[account],
    provider: account === 'A' ? 'apple' : 'google',
    refreshToken: `refresh-${account}`,
    bearerExpiresAtMs: null,
  };
}

// ---------------------------------------------------------------------------
// Fault catalog
// ---------------------------------------------------------------------------

type Fault =
  | { kind: 'ok'; delayMs?: number }
  | { kind: 'ok_noapply' }
  | { kind: 'applied_then_fail'; fail: 'hang' | 'reject' }
  | { kind: 'deferred' }
  | { kind: 'throw' }
  | { kind: 'reject'; error: unknown; delayMs?: number }
  | { kind: 'hang'; honorAbort: boolean }
  | {
      kind: 'http';
      status: number;
      body: unknown;
      jsonRejects?: boolean;
      okOverride?: boolean;
    }
  | { kind: 'body'; payload: unknown }
  | { kind: 'json_reject' }
  | { kind: 'json_throw' }
  | { kind: 'undefined_response' }
  | { kind: 'no_json_method' };

function scopeRow(
  scope: string,
  active: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    scope,
    active,
    consentVersion: active === true ? MODEL_TRAINING_CONSENT_VERSION : null,
    lastAction: active === true ? 'granted' : 'withdrawn',
    lastActionAt: '2026-09-01T00:00:00.000Z',
    ...extra,
  };
}

function statusBody(active: boolean): Record<string, unknown> {
  return {
    subjectPseudonym: 'c0000000-0000-4000-8000-00000000000c',
    scopes: [
      scopeRow('video_analysis', true),
      scopeRow('model_training', active),
      scopeRow('evaluation_telemetry', false),
    ],
  };
}

const HTTP_STATUSES = [400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504];

const FAULTS: Record<string, Fault> = {
  ok: { kind: 'ok' },
  ok_slow_1000: { kind: 'ok', delayMs: 1_000 },
  ok_slow_5000: { kind: 'ok', delayMs: 5_000 },
  ok_slow_under_timeout: {
    kind: 'ok',
    delayMs: CONSENT_REQUEST_TIMEOUT_MS - 1,
  },
  ok_slow_over_timeout: { kind: 'ok', delayMs: CONSENT_REQUEST_TIMEOUT_MS + 1 },
  ok_noapply: { kind: 'ok_noapply' },
  applied_then_hang: { kind: 'applied_then_fail', fail: 'hang' },
  applied_then_reject: { kind: 'applied_then_fail', fail: 'reject' },
  deferred: { kind: 'deferred' },
  throw_sync: { kind: 'throw' },
  reject_network: {
    kind: 'reject',
    error: new TypeError('Network request failed'),
  },
  reject_abort: {
    kind: 'reject',
    error: Object.assign(new Error('Aborted'), { name: 'AbortError' }),
  },
  reject_non_error: { kind: 'reject', error: 'offline' },
  reject_slow: {
    kind: 'reject',
    error: new TypeError('Network request failed'),
    delayMs: 5_000,
  },
  reject_slow_over_timeout: {
    kind: 'reject',
    error: new TypeError('Network request failed'),
    delayMs: CONSENT_REQUEST_TIMEOUT_MS + 1,
  },
  hang_honor_abort: { kind: 'hang', honorAbort: true },
  hang_ignore_abort: { kind: 'hang', honorAbort: false },
  ...Object.fromEntries(
    HTTP_STATUSES.map(status => [
      `http_${status}`,
      { kind: 'http', status, body: { error: `status ${status}` } } as Fault,
    ]),
  ),
  http_500_json_reject: {
    kind: 'http',
    status: 500,
    body: null,
    jsonRejects: true,
  },
  http_204_no_body: {
    kind: 'http',
    status: 204,
    body: null,
    jsonRejects: true,
  },
  http_302_redirect: {
    kind: 'http',
    status: 302,
    body: { error: 'moved' },
  },
  http_200_ok_false: {
    kind: 'http',
    status: 200,
    body: statusBody(true),
    okOverride: false,
  },
  json_reject: { kind: 'json_reject' },
  json_throw: { kind: 'json_throw' },
  undefined_response: { kind: 'undefined_response' },
  no_json_method: { kind: 'no_json_method' },
  body_null: { kind: 'body', payload: null },
  body_array: { kind: 'body', payload: [statusBody(true)] },
  body_string: { kind: 'body', payload: 'ok' },
  body_number: { kind: 'body', payload: 1 },
  body_empty_object: { kind: 'body', payload: {} },
  body_scopes_not_array: {
    kind: 'body',
    payload: { subjectPseudonym: null, scopes: { model_training: true } },
  },
  body_scopes_empty: {
    kind: 'body',
    payload: { subjectPseudonym: null, scopes: [] },
  },
  body_row_null: {
    kind: 'body',
    payload: { subjectPseudonym: null, scopes: [null] },
  },
  body_row_string: {
    kind: 'body',
    payload: { subjectPseudonym: null, scopes: ['model_training'] },
  },
  body_row_nested_array: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [[scopeRow('model_training', true)]],
    },
  },
  body_scope_wrong_case: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('Model_Training', true)],
    },
  },
  body_active_null: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('model_training', null)],
    },
  },
  body_scope_unknown: {
    kind: 'body',
    payload: { subjectPseudonym: null, scopes: [scopeRow('biometrics', true)] },
  },
  body_active_string: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('model_training', 'true')],
    },
  },
  body_active_missing: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [{ scope: 'model_training' }],
    },
  },
  body_last_action_bad: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('model_training', true, { lastAction: 'revoked' })],
    },
  },
  body_last_action_at_number: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('model_training', true, { lastActionAt: 1_700_000 })],
    },
  },
  body_consent_version_number: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('model_training', true, { consentVersion: 5 })],
    },
  },
  body_pseudonym_number: {
    kind: 'body',
    payload: {
      subjectPseudonym: 42,
      scopes: [scopeRow('model_training', true)],
    },
  },
  body_pseudonym_missing: {
    kind: 'body',
    payload: { scopes: [scopeRow('model_training', false)] },
  },
  body_duplicate_rows: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [
        scopeRow('model_training', true),
        scopeRow('model_training', false),
      ],
    },
  },
  body_huge: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: Array.from({ length: 10_000 }, (_, i) =>
        scopeRow(i === 0 ? 'model_training' : 'video_analysis', i === 0),
      ),
    },
  },
  body_proto_keys: {
    kind: 'body',
    payload: JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"prototype":{}},"subjectPseudonym":null,"scopes":[{"scope":"model_training","active":true,"consentVersion":null,"lastAction":null,"lastActionAt":null,"__proto__":{"x":1}}]}',
    ) as unknown,
  },
  body_inconsistent_flags: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [
        scopeRow('model_training', true, {
          lastAction: 'withdrawn',
          consentVersion: null,
        }),
      ],
    },
  },
  body_telemetry_only: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [scopeRow('evaluation_telemetry', true)],
    },
  },
  body_nullish_optionals: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [
        {
          scope: 'model_training',
          active: true,
          consentVersion: null,
          lastAction: null,
          lastActionAt: null,
        },
      ],
    },
  },
  body_extra_fields: {
    kind: 'body',
    payload: {
      subjectPseudonym: null,
      scopes: [
        scopeRow('model_training', false, { region: 'us', ttl: 1 }),
        scopeRow('video_analysis', true),
      ],
      serverTime: '2026-09-04T00:00:00.000Z',
      warnings: ['deprecated field'],
    },
  },
};

type FaultId = keyof typeof FAULTS & string;
const FAULT_IDS = Object.keys(FAULTS) as FaultId[];

/** Faults where the injected transport itself violates the fetch contract
 * (it ignores the AbortSignal); a screen stuck in `loading` under one of
 * these is a limitation of the model, not of the screen. */
function isContractBreakingFault(id: FaultId): boolean {
  return id === 'hang_ignore_abort';
}

/** Whether a body-style fault carries a payload the client MUST accept. */
function bodyIsValid(id: FaultId): boolean {
  return (
    id === 'body_scopes_empty' ||
    id === 'body_duplicate_rows' ||
    id === 'body_huge' ||
    id === 'body_proto_keys' ||
    id === 'body_inconsistent_flags' ||
    id === 'body_telemetry_only' ||
    id === 'body_nullish_optionals' ||
    id === 'body_extra_fields'
  );
}

/** The model_training value a valid body-style fault reports. */
function bodyActive(id: FaultId): boolean {
  switch (id) {
    case 'body_duplicate_rows':
    case 'body_huge':
    case 'body_proto_keys':
    case 'body_inconsistent_flags':
    case 'body_nullish_optionals':
      return true;
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// World: server ledger + injected transport
// ---------------------------------------------------------------------------

interface RequestRecord {
  id: number;
  method: string;
  path: string;
  body: unknown;
  hadSignal: boolean;
  aborted: boolean;
  faultId: FaultId;
  account: Account | null;
  /** Fake-clock ms when the request was issued (timeout arithmetic). */
  startedAt: number;
  /** Strictly increasing logical ticks (ordering arithmetic). */
  startedTick: number;
  settled: boolean;
  settledTick: number | null;
  release: (() => void) | null;
}

class World {
  ledger: Record<Account, boolean> = { A: false, B: false };
  /** The truth as far as the client could ever know it: a body-style fault
   * carrying a valid payload is what the "server" said. */
  requests: RequestRecord[] = [];
  faultQueue: FaultId[] = [];
  consoleErrors: string[] = [];
  unauthorizedReports = 0;
  now = 0;
  tick = 0;
  private nextId = 1;

  queue(id: FaultId) {
    this.faultQueue.push(id);
  }

  pending(): RequestRecord[] {
    return this.requests.filter(r => !r.settled);
  }

  pendingDeferred(): RequestRecord[] {
    return this.pending().filter(r => r.release !== null);
  }

  accountFor(bearer: string | undefined): Account | null {
    if (!bearer) return null;
    if (bearer.startsWith('Bearer bearer-A')) return 'A';
    if (bearer.startsWith('Bearer bearer-B')) return 'B';
    return null;
  }

  fetch: typeof globalThis.fetch = (input, init) => {
    const method = init?.method ?? 'GET';
    const url = String(input);
    const pathName = url.replace('https://api.example.test', '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const account = this.accountFor(headers['Authorization']);
    const faultId = this.faultQueue.shift() ?? 'ok';
    const fault = FAULTS[faultId];
    if (!fault) throw new Error(`unknown fault ${faultId}`);
    const signal = init?.signal ?? null;
    let body: unknown = undefined;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const record: RequestRecord = {
      id: this.nextId++,
      method,
      path: pathName,
      body,
      hadSignal: signal !== null,
      aborted: false,
      faultId,
      account,
      startedAt: this.now,
      startedTick: ++this.tick,
      settled: false,
      settledTick: null,
      release: null,
    };
    this.requests.push(record);
    const settle = () => {
      if (record.settled) return;
      record.settled = true;
      record.settledTick = ++this.tick;
    };
    const abortError = () =>
      Object.assign(new Error('Aborted'), { name: 'AbortError' });
    signal?.addEventListener('abort', () => {
      record.aborted = true;
    });

    const apply = () => {
      if (account === null) return;
      if (pathName === '/v1/me/consent/grant') this.ledger[account] = true;
      if (pathName === '/v1/me/consent/withdraw') this.ledger[account] = false;
    };
    const ledgerBody = () =>
      statusBody(account === null ? false : this.ledger[account]);
    const okResponse = (payload: unknown, status = 200): Response =>
      ({
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(payload),
      }) as unknown as Response;
    // A delayed delivery behaves like a real fetch: if the caller aborts
    // before the response arrives, the promise rejects with AbortError.
    const later = <T,>(ms: number, make: () => T): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          settle();
          resolve(make());
        }, ms);
        signal?.addEventListener('abort', () => {
          if (record.settled) return;
          clearTimeout(timer);
          settle();
          reject(abortError());
        });
      });
    const laterReject = (ms: number, error: unknown): Promise<Response> =>
      new Promise<Response>((_, reject) => {
        const timer = setTimeout(() => {
          settle();
          reject(error);
        }, ms);
        signal?.addEventListener('abort', () => {
          if (record.settled) return;
          clearTimeout(timer);
          settle();
          reject(abortError());
        });
      });
    const hang = (honorAbort: boolean): Promise<Response> =>
      new Promise<Response>((_, reject) => {
        if (honorAbort && signal) {
          signal.addEventListener('abort', () => {
            settle();
            reject(abortError());
          });
        }
      });

    switch (fault.kind) {
      case 'ok': {
        apply();
        const snapshot = ledgerBody();
        return later(fault.delayMs ?? 0, () => okResponse(snapshot));
      }
      case 'ok_noapply':
        return later(0, () => okResponse(ledgerBody()));
      case 'applied_then_fail': {
        apply();
        if (fault.fail === 'reject') {
          return laterReject(0, new TypeError('Network request failed'));
        }
        return hang(true);
      }
      case 'deferred': {
        apply();
        const snapshot = ledgerBody();
        return new Promise<Response>((resolve, reject) => {
          record.release = () => {
            record.release = null;
            settle();
            resolve(okResponse(snapshot));
          };
          signal?.addEventListener('abort', () => {
            if (record.settled) return;
            record.release = null;
            settle();
            reject(abortError());
          });
        });
      }
      case 'throw':
        settle();
        throw new TypeError('injected synchronous throw');
      case 'reject':
        return laterReject(fault.delayMs ?? 0, fault.error);
      case 'hang':
        return hang(fault.honorAbort);
      case 'http':
        return later(
          0,
          () =>
            ({
              ok:
                fault.okOverride ?? (fault.status >= 200 && fault.status < 300),
              status: fault.status,
              json: () =>
                fault.jsonRejects
                  ? Promise.reject(new SyntaxError('bad json'))
                  : Promise.resolve(fault.body),
            }) as unknown as Response,
        );
      case 'body':
        // A well-formed body IS the server's word about the ledger.
        if (account !== null && bodyIsValid(faultId)) {
          this.ledger[account] = bodyActive(faultId);
        }
        return later(0, () => okResponse(fault.payload));
      case 'json_reject':
        return later(
          0,
          () =>
            ({
              ok: true,
              status: 200,
              json: () => Promise.reject(new SyntaxError('Unexpected token <')),
            }) as unknown as Response,
        );
      case 'json_throw':
        return later(
          0,
          () =>
            ({
              ok: true,
              status: 200,
              json: () => {
                throw new TypeError('body stream already read');
              },
            }) as unknown as Response,
        );
      case 'undefined_response':
        return later(0, () => undefined as unknown as Response);
      case 'no_json_method':
        return later(
          0,
          () => ({ ok: true, status: 200 }) as unknown as Response,
        );
    }
  };
}

// ---------------------------------------------------------------------------
// Rendering inside the real navigator
// ---------------------------------------------------------------------------

type StackParams = {
  Tabs: undefined;
  ConsentSettings: undefined;
  ConnectAccount: undefined;
};

const Stack = createNativeStackNavigator<StackParams>();

/** Stand-in for the Settings tab that sits under ConsentSettings in the
 * real stack. It keeps the one behaviour that matters to this store: the
 * tab re-hydrates consent whenever the signed-in session changes
 * (SettingsScreen.tsx), which is what resets the store on sign-out while
 * the consent screen itself is not mounted. */
function SettingsStub() {
  const session = useAuthStore(s => s.session);
  const hydrate = useConsentStore(s => s.hydrate);
  React.useEffect(() => {
    void hydrate();
  }, [hydrate, session]);
  return <Text>settings-stub</Text>;
}

function ConnectAccountStub() {
  return <Text>connect-account-stub</Text>;
}

interface Harness {
  renderer: TestRenderer.ReactTestRenderer;
  navigationRef: ReturnType<typeof createNavigationContainerRef<StackParams>>;
  unmount: () => void;
}

function renderApp(options: {
  initialRoute?: keyof StackParams;
  registerConnectAccount?: boolean;
}): Harness {
  const navigationRef = createNavigationContainerRef<StackParams>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator
            initialRouteName={options.initialRoute ?? 'Tabs'}
            screenOptions={{ headerShown: false }}
          >
            <Stack.Screen name="Tabs" component={SettingsStub} />
            <Stack.Screen
              name="ConsentSettings"
              component={ConsentSettingsScreen}
            />
            {options.registerConnectAccount === false ? null : (
              <Stack.Screen
                name="ConnectAccount"
                component={ConnectAccountStub}
              />
            )}
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>,
    );
  });
  return {
    renderer,
    navigationRef,
    unmount: () => act(() => renderer.unmount()),
  };
}

/**
 * The navigator/safe-area stack leaves a timer of its own behind after
 * unmount (measured once with every screen replaced by a stub). O9 compares
 * against that floor so only the consent screen's own leaks are reported.
 */
let timerFloor: number | null = null;
async function navigatorTimerFloor(): Promise<number> {
  if (timerFloor !== null) return timerFloor;
  const before = jest.getTimerCount();
  const navigationRef = createNavigationContainerRef<StackParams>();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SafeAreaProvider>
        <NavigationContainer ref={navigationRef}>
          <Stack.Navigator screenOptions={{ headerShown: false }}>
            <Stack.Screen name="Tabs" component={SettingsStub} />
            <Stack.Screen name="ConsentSettings" component={SettingsStub} />
            <Stack.Screen
              name="ConnectAccount"
              component={ConnectAccountStub}
            />
          </Stack.Navigator>
        </NavigationContainer>
      </SafeAreaProvider>,
    );
  });
  await act(async () => {});
  act(() => {
    navigationRef.navigate('ConsentSettings');
  });
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  act(() => renderer.unmount());
  await act(async () => {
    jest.advanceTimersByTime(60_000);
  });
  timerFloor = Math.max(0, jest.getTimerCount() - before);
  return timerFloor;
}

function allText(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' | ');
}

function pressables(renderer: TestRenderer.ReactTestRenderer, label: string) {
  // Pressable is a memo component, so findAllByType(Pressable) never matches;
  // select composite nodes carrying the label and an onPress instead.
  return renderer.root.findAll(
    node =>
      typeof node.type === 'function' &&
      node.props.accessibilityLabel === label &&
      typeof node.props.onPress === 'function',
  );
}

const LABELS = {
  back: 'Back',
  toggle: 'Use my feedback to improve scoring',
  tryAgain: 'Try again',
  connect: 'Connect account',
} as const;

interface Snapshot {
  mounted: boolean;
  routeName: string | undefined;
  availability: string;
  busy: boolean;
  error: string | null;
  active: boolean;
  toggle: { present: boolean; disabled: boolean; value: boolean | null };
  back: boolean;
  tryAgain: boolean;
  connect: boolean;
  loadingCopy: boolean;
  errorCopy: boolean;
}

function snapshot(h: Harness): Snapshot {
  const state = useConsentStore.getState();
  const text = allText(h.renderer);
  const toggles = pressables(h.renderer, LABELS.toggle);
  const toggle = toggles[toggles.length - 1];
  const route = h.navigationRef.isReady()
    ? h.navigationRef.getCurrentRoute()?.name
    : undefined;
  return {
    mounted: text.includes('Data & consent'),
    routeName: route,
    availability: state.availability,
    busy: state.busy,
    error: state.error,
    active: state.modelTrainingActive,
    toggle: {
      present: toggle !== undefined,
      disabled: toggle?.props.disabled === true,
      value: toggle
        ? ((toggle.props.accessibilityState?.checked as boolean) ?? null)
        : null,
    },
    back: pressables(h.renderer, LABELS.back).length > 0,
    tryAgain: pressables(h.renderer, LABELS.tryAgain).length > 0,
    connect: pressables(h.renderer, LABELS.connect).length > 0,
    loadingCopy: text.includes('Checking your current choice…'),
    errorCopy: state.error !== null && text.includes(state.error),
  };
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Step =
  | { op: 'signIn'; account: Account; get?: FaultId }
  | { op: 'rotateToken' }
  | { op: 'signOut' }
  | { op: 'clearApiOnly' }
  | { op: 'mount'; get: FaultId }
  | { op: 'back' }
  | { op: 'toggle'; post: FaultId }
  | { op: 'tryAgain'; get: FaultId }
  | { op: 'connect' }
  | { op: 'advance'; ms: number }
  | { op: 'release'; which: 'oldest' | 'newest' }
  | { op: 'flush' };

interface Violation {
  oracle: string;
  detail: string;
  finding: 'CS-1' | 'CS-2' | 'CS-3' | 'CONDITIONAL' | null;
}

interface Session {
  world: World;
  harness: Harness;
  currentAccount: Account | null;
  steps: Step[];
  log: Array<{ step: Step; result: string; after: Snapshot }>;
  violations: Violation[];
  expectedConsoleErrors: RegExp[];
  usedContractBreakingFault: boolean;
  postsApplied: number;
  lastLandedPostAt: number | null;
}

async function flush(session: Session, ms = 0) {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      if (ms > 0 && i === 0) {
        session.world.now += ms;
        jest.advanceTimersByTime(ms);
      } else {
        jest.advanceTimersByTime(0);
      }
    });
  }
}

async function press(
  session: Session,
  label: string,
): Promise<'pressed' | 'blocked' | 'absent'> {
  const nodes = pressables(session.harness.renderer, label);
  const node = nodes[nodes.length - 1];
  if (!node) return 'absent';
  if (node.props.disabled === true) return 'blocked';
  await act(async () => {
    node.props.onPress();
  });
  await flush(session);
  return 'pressed';
}

function signIn(session: Session, account: Account, tokenSuffix = '') {
  session.currentAccount = account;
  establishApiSession(apiSession(account, tokenSuffix));
  act(() => {
    useAuthStore.setState({ session: authSession(account) });
  });
}

function signOut(session: Session) {
  session.currentAccount = null;
  clearApiSession();
  act(() => {
    useAuthStore.setState({ session: null });
  });
}

async function runStep(session: Session, step: Step): Promise<string> {
  const { world, harness } = session;
  const mountedBefore = snapshot(harness).mounted;
  switch (step.op) {
    case 'signIn': {
      // The Settings tab always re-hydrates on a session change; the consent
      // screen adds a second GET while mounted. Both see the same fault.
      if (step.get) {
        world.queue(step.get);
        if (mountedBefore) world.queue(step.get);
        if (isContractBreakingFault(step.get)) {
          session.usedContractBreakingFault = true;
        }
      }
      signIn(session, step.account);
      await flush(session);
      return `signed in as ${step.account}`;
    }
    case 'rotateToken': {
      if (!session.currentAccount) return 'noop: signed out';
      establishApiSession(apiSession(session.currentAccount, '-rotated'));
      await flush(session);
      return 'bearer rotated';
    }
    case 'signOut':
      signOut(session);
      await flush(session);
      return 'signed out';
    case 'clearApiOnly':
      // The api session is gone but the auth store still says signed in:
      // the order signOut() runs its two writes in. The screen can only see
      // the auth store, so `currentAccount` (what it may show) is unchanged.
      clearApiSession();
      await flush(session);
      return 'api session cleared';
    case 'mount': {
      if (mountedBefore) return 'noop: already mounted';
      if (session.currentAccount) world.queue(step.get);
      if (isContractBreakingFault(step.get)) {
        session.usedContractBreakingFault = true;
      }
      await act(async () => {
        harness.navigationRef.navigate('ConsentSettings');
      });
      await flush(session);
      return 'pushed ConsentSettings';
    }
    case 'back': {
      const result = await press(session, LABELS.back);
      return `back: ${result}`;
    }
    case 'toggle': {
      if (!mountedBefore) return 'noop: not mounted';
      const s = snapshot(harness);
      if (s.toggle.present && !s.toggle.disabled) {
        world.queue(step.post);
        if (isContractBreakingFault(step.post)) {
          session.usedContractBreakingFault = true;
        }
      }
      const result = await press(session, LABELS.toggle);
      if (result !== 'pressed') {
        // The queued fault was never consumed; drop it again.
        if (s.toggle.present && !s.toggle.disabled) world.faultQueue.pop();
      }
      return `toggle: ${result}`;
    }
    case 'tryAgain': {
      if (!mountedBefore) return 'noop: not mounted';
      const present = pressables(harness.renderer, LABELS.tryAgain).length > 0;
      if (present) {
        world.queue(step.get);
        if (isContractBreakingFault(step.get)) {
          session.usedContractBreakingFault = true;
        }
      }
      const result = await press(session, LABELS.tryAgain);
      if (present && result !== 'pressed') world.faultQueue.pop();
      return `tryAgain: ${result}`;
    }
    case 'connect': {
      const result = await press(session, LABELS.connect);
      return `connect: ${result}`;
    }
    case 'advance':
      await flush(session, step.ms);
      return `advanced ${step.ms}ms`;
    case 'release': {
      const deferred = world.pendingDeferred();
      const target =
        step.which === 'oldest' ? deferred[0] : deferred[deferred.length - 1];
      if (!target || !target.release) return 'noop: nothing deferred';
      await act(async () => {
        target.release?.();
      });
      await flush(session);
      return `released #${target.id} ${target.method} ${target.path}`;
    }
    case 'flush':
      await flush(session);
      return 'flushed';
  }
}

// ---------------------------------------------------------------------------
// Oracle
// ---------------------------------------------------------------------------

function checkInvariants(session: Session, final: boolean): void {
  const { world, harness } = session;
  const s = snapshot(harness);
  const v = session.violations;
  const add = (oracle: string, detail: string, finding: Violation['finding']) =>
    v.push({ oracle, detail, finding });

  // O1 console noise
  for (const message of world.consoleErrors.splice(0)) {
    if (!session.expectedConsoleErrors.some(re => re.test(message))) {
      add('O1', `console.error: ${message.slice(0, 200)}`, null);
    }
  }

  if (s.mounted) {
    // O2
    if (!s.back) add('O2', 'Back control missing while mounted', null);
    // O5
    if (s.availability === 'unavailable') {
      if (!s.tryAgain) add('O5', 'unavailable without Try again', null);
      if (!s.errorCopy && !allText(harness.renderer).includes('unavailable')) {
        add('O5', 'unavailable without visible error copy', null);
      }
      if (!s.toggle.disabled)
        add('O5', 'toggle enabled while unavailable', null);
    }
    // O6
    if (s.availability === 'signed_out') {
      if (!s.connect) add('O6', 'signed_out without Connect account', null);
      if (!s.toggle.disabled || s.toggle.value !== false) {
        add('O6', `signed_out toggle ${JSON.stringify(s.toggle)}`, null);
      }
    }
    if (s.availability === 'loading' && !s.loadingCopy) {
      add('O3', 'loading without the checking copy', null);
    }
    if (s.availability === 'ready') {
      if (s.toggle.disabled !== s.busy) {
        add(
          'O4',
          `ready: toggle.disabled=${s.toggle.disabled} busy=${s.busy}`,
          null,
        );
      }
      if (s.error && !s.errorCopy) add('O8', 'ready error not rendered', null);
    }
  }

  // Account binding: a signed-out api session must never show `ready`.
  if (s.availability === 'ready' && session.currentAccount === null) {
    add('O6', 'ready while signed out', null);
  }

  // O8 every request carried an AbortSignal
  for (const r of world.requests) {
    if (!r.hadSignal) add('O8', `request #${r.id} had no AbortSignal`, null);
  }

  if (!final) return;

  const inflight = world.pending().filter(r => r.release === null);
  const onlyContractBreaking =
    inflight.length > 0 &&
    inflight.every(r => isContractBreakingFault(r.faultId));

  // O3 / O4 after settling (60 s: every honest request has timed out)
  if (s.availability === 'loading') {
    if (session.usedContractBreakingFault && onlyContractBreaking) {
      add(
        'O3',
        'loading persists only because the injected fetch ignored the AbortSignal (client relies on fetch honouring abort)',
        'CONDITIONAL',
      );
    } else {
      add('O3', 'loading after 60s', null);
    }
  }
  if (s.busy) {
    if (session.usedContractBreakingFault && onlyContractBreaking) {
      add(
        'O4',
        'busy persists only under the abort-ignoring fetch',
        'CONDITIONAL',
      );
    } else {
      add('O4', 'busy after 60s', null);
    }
  }

  // O8 abort fired for every hung-honouring request
  for (const r of world.requests) {
    if (
      (r.faultId === 'hang_honor_abort' || r.faultId === 'hang_ignore_abort') &&
      !r.aborted &&
      world.now - r.startedAt >= CONSENT_REQUEST_TIMEOUT_MS
    ) {
      add(
        'O8',
        `request #${r.id} never aborted at ${CONSENT_REQUEST_TIMEOUT_MS}ms`,
        null,
      );
    }
  }

  // O7 server-truth mirror
  if (
    s.mounted &&
    s.availability === 'ready' &&
    session.currentAccount &&
    world.pendingDeferred().length === 0 &&
    inflight.length === 0
  ) {
    const truth = world.ledger[session.currentAccount];
    if (s.toggle.value !== truth || s.active !== truth) {
      const lostWrite = world.requests.some(
        r =>
          r.method === 'POST' &&
          r.account === session.currentAccount &&
          (r.faultId === 'applied_then_hang' ||
            r.faultId === 'applied_then_reject' ||
            r.faultId === 'ok_slow_over_timeout' ||
            (r.faultId === 'deferred' && r.aborted)),
      );
      const staleRead = world.requests.some(
        r =>
          r.method === 'GET' &&
          r.settledTick !== null &&
          session.lastLandedPostAt !== null &&
          r.startedTick < session.lastLandedPostAt &&
          r.settledTick > session.lastLandedPostAt,
      );
      add(
        'O7',
        `ready shows ${s.toggle.value} but ledger[${session.currentAccount}]=${truth}`,
        staleRead ? 'CS-1' : lostWrite ? 'CS-2' : null,
      );
    }
  }

  // CS-3 401 never reported
  const saw401 = world.requests.some(
    r => r.faultId === 'http_401' && r.account === session.currentAccount,
  );
  if (saw401 && world.unauthorizedReports === 0) {
    add(
      'CS-3',
      '401 from the consent route was not reported to the unauthorized listener',
      'CS-3',
    );
  }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

function noteLandedPosts(session: Session) {
  for (const r of session.world.requests) {
    if (r.method === 'POST' && r.settled && r.settledTick !== null) {
      session.lastLandedPostAt = Math.max(
        session.lastLandedPostAt ?? -1,
        r.settledTick,
      );
    }
  }
}

interface ScenarioResult {
  id: string;
  seed: number | null;
  steps: Step[];
  outcome: 'HELD' | 'BROKEN' | 'HELD_CONDITIONAL';
  findings: string[];
  violations: Violation[];
  requests: number;
  log: Array<{ step: Step; result: string; after: Snapshot }>;
}

async function runScenario(
  id: string,
  steps: Step[],
  options: {
    seed?: number;
    registerConnectAccount?: boolean;
    initialRoute?: keyof StackParams;
    expectedConsoleErrors?: RegExp[];
  } = {},
): Promise<ScenarioResult> {
  useConsentStore.setState({
    availability: 'loading',
    modelTrainingActive: false,
    lastActionAt: null,
    busy: false,
    error: null,
  });
  clearApiSession();
  act(() => {
    useAuthStore.setState({ session: null });
  });
  const floor = await navigatorTimerFloor();
  const timersAtStart = jest.getTimerCount();
  const world = new World();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = world.fetch;
  setApiUnauthorizedListener(() => {
    world.unauthorizedReports += 1;
  });
  const errorSpy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      world.consoleErrors.push(args.map(String).join(' '));
    });
  const harness = renderApp({
    registerConnectAccount: options.registerConnectAccount,
    initialRoute: options.initialRoute,
  });
  const session: Session = {
    world,
    harness,
    currentAccount: null,
    steps,
    log: [],
    violations: [],
    expectedConsoleErrors: options.expectedConsoleErrors ?? [],
    usedContractBreakingFault: false,
    postsApplied: 0,
    lastLandedPostAt: null,
  };
  try {
    await flush(session);
    for (const step of steps) {
      let result: string;
      try {
        result = await runStep(session, step);
      } catch (error) {
        result = `THREW ${String(error)}`;
        session.violations.push({
          oracle: 'O1',
          detail: `step ${JSON.stringify(step)} threw ${String(error)}`,
          finding: null,
        });
      }
      noteLandedPosts(session);
      session.log.push({ step, result, after: snapshot(harness) });
      checkInvariants(session, false);
    }
    // Settle: 60 s in four chunks so the 15 s client timeout fires in-between.
    for (let i = 0; i < 4; i += 1) {
      await flush(session, 15_000);
      noteLandedPosts(session);
    }
    session.log.push({
      step: { op: 'advance', ms: 60_000 },
      result: 'settled',
      after: snapshot(harness),
    });
    checkInvariants(session, true);
  } finally {
    // Leave the screen and drain so O9 can be evaluated on a clean tree.
    try {
      harness.unmount();
    } catch (error) {
      session.violations.push({
        oracle: 'O1',
        detail: `unmount threw ${String(error)}`,
        finding: null,
      });
    }
    await act(async () => {
      jest.advanceTimersByTime(60_000);
    });
    // O9: with the screen gone and every honest request timed out, nothing
    // beyond what the bare navigator itself leaves may still be scheduled.
    const leaked = jest.getTimerCount() - timersAtStart;
    if (leaked > floor) {
      session.violations.push({
        oracle: 'O9',
        detail: `${leaked} timers still scheduled after unmount (bare navigator leaves ${floor})`,
        finding: null,
      });
    }
    globalThis.fetch = originalFetch;
    for (const message of world.consoleErrors.splice(0)) {
      if (!session.expectedConsoleErrors.some(re => re.test(message))) {
        session.violations.push({
          oracle: 'O1',
          detail: `console.error after unmount: ${message.slice(0, 200)}`,
          finding: null,
        });
      }
    }
    errorSpy.mockRestore();
    setApiUnauthorizedListener(null);
  }
  const findings = Array.from(
    new Set(
      session.violations
        .map(x => x.finding)
        .filter(
          (f): f is 'CS-1' | 'CS-2' | 'CS-3' =>
            f !== null && f !== 'CONDITIONAL',
        ),
    ),
  );
  const hard = session.violations.filter(x => x.finding !== 'CONDITIONAL');
  const outcome: ScenarioResult['outcome'] =
    hard.length > 0
      ? 'BROKEN'
      : session.violations.length > 0
        ? 'HELD_CONDITIONAL'
        : 'HELD';
  return {
    id,
    seed: options.seed ?? null,
    steps,
    outcome,
    findings,
    violations: session.violations,
    requests: world.requests.length,
    log: session.log,
  };
}

// ---------------------------------------------------------------------------
// Seeded RNG + random step generator
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new Error('empty pick');
  return item;
}

const ADVANCES = [0, 50, 1_000, 14_999, 15_001, 30_000, 60_000] as const;

function randomSteps(seed: number): Step[] {
  const rng = mulberry32(seed);
  const steps: Step[] = [];
  const startSignedOut = rng() < 0.15;
  if (!startSignedOut) steps.push({ op: 'signIn', account: 'A' });
  steps.push({ op: 'mount', get: pick(rng, FAULT_IDS) });
  const count = 3 + Math.floor(rng() * 7);
  for (let i = 0; i < count; i += 1) {
    const r = rng();
    if (r < 0.3) steps.push({ op: 'toggle', post: pick(rng, FAULT_IDS) });
    else if (r < 0.48) steps.push({ op: 'advance', ms: pick(rng, ADVANCES) });
    else if (r < 0.58)
      steps.push({ op: 'release', which: rng() < 0.5 ? 'oldest' : 'newest' });
    else if (r < 0.66)
      steps.push({ op: 'tryAgain', get: pick(rng, FAULT_IDS) });
    else if (r < 0.72) steps.push({ op: 'back' });
    else if (r < 0.78) steps.push({ op: 'mount', get: pick(rng, FAULT_IDS) });
    else if (r < 0.84) steps.push({ op: 'signOut' });
    else if (r < 0.9)
      steps.push({
        op: 'signIn',
        account: rng() < 0.5 ? 'A' : 'B',
        get: pick(rng, FAULT_IDS),
      });
    else if (r < 0.93) steps.push({ op: 'rotateToken' });
    else if (r < 0.96) steps.push({ op: 'connect' });
    else steps.push({ op: 'flush' });
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Result sink
// ---------------------------------------------------------------------------

const results: ScenarioResult[] = [];

function record(result: ScenarioResult): ScenarioResult {
  results.push(result);
  return result;
}

afterAll(() => {
  const out = process.env.STRESS_OUT;
  if (!out) return;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const table = results.map(r => ({
    id: r.id,
    seed: r.seed,
    outcome: r.outcome,
    findings: r.findings,
    requests: r.requests,
    violations: r.violations.map(v => `${v.oracle}: ${v.detail}`),
    steps: r.steps,
  }));
  fs.writeFileSync(
    out,
    JSON.stringify(
      {
        unit: 'scr-consentsettingsscreen',
        lens: 'failure-injection',
        faultCatalog: FAULT_IDS,
        scenarios: table.length,
        held: table.filter(r => r.outcome === 'HELD').length,
        heldConditional: table.filter(r => r.outcome === 'HELD_CONDITIONAL')
          .length,
        broken: table.filter(r => r.outcome === 'BROKEN').length,
        results: table,
      },
      null,
      2,
    ),
  );
  const logPath = out.replace(/\.json$/, '.log.json');
  fs.writeFileSync(
    logPath,
    JSON.stringify(
      results.map(r => ({ id: r.id, seed: r.seed, log: r.log })),
      null,
      1,
    ),
  );
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const KNOWN_FINDINGS = new Set(['CS-1', 'CS-2', 'CS-3']);

function expectHeld(result: ScenarioResult) {
  const unexpected = result.violations.filter(
    v =>
      v.finding !== 'CONDITIONAL' &&
      !(v.finding && KNOWN_FINDINGS.has(v.finding)),
  );
  expect(unexpected).toEqual([]);
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('ConsentSettingsScreen failure injection (real navigator + stores)', () => {
  describe('status read (GET) faults at mount', () => {
    it.each(FAULT_IDS)('mount with GET fault %s', async fault => {
      const result = record(
        await runScenario(`get:${fault}`, [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: fault },
        ]),
      );
      expectHeld(result);
      const last = result.log[result.log.length - 1];
      expect(last).toBeDefined();
      const after = last!.after;
      if (
        fault === 'ok' ||
        fault === 'ok_slow_1000' ||
        fault === 'ok_slow_5000' ||
        fault === 'ok_slow_under_timeout' ||
        fault === 'ok_noapply'
      ) {
        expect(after.availability).toBe('ready');
        expect(after.toggle.value).toBe(false);
        expect(after.toggle.disabled).toBe(false);
      } else if (fault === 'hang_ignore_abort') {
        expect(result.outcome).toBe('HELD_CONDITIONAL');
      } else if (fault.startsWith('body_') && bodyIsValid(fault)) {
        expect(after.availability).toBe('ready');
        expect(after.toggle.value).toBe(bodyActive(fault));
      } else {
        expect(after.availability).toBe('unavailable');
        expect(after.tryAgain).toBe(true);
        expect(after.toggle.disabled).toBe(true);
      }
    });
  });

  describe('write (POST grant) faults after a healthy mount', () => {
    it.each(FAULT_IDS)('grant with POST fault %s', async fault => {
      const result = record(
        await runScenario(`grant:${fault}`, [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: fault },
        ]),
      );
      expectHeld(result);
      const last = result.log[result.log.length - 1];
      const after = last!.after;
      if (fault === 'hang_ignore_abort') {
        expect(result.outcome).toBe('HELD_CONDITIONAL');
        return;
      }
      expect(after.busy).toBe(false);
      expect(after.availability).toBe('ready');
      const applied =
        fault === 'ok' ||
        fault === 'ok_slow_1000' ||
        fault === 'ok_slow_5000' ||
        fault === 'ok_slow_under_timeout';
      if (applied) {
        expect(after.toggle.value).toBe(true);
        expect(after.error).toBeNull();
      } else if (fault.startsWith('body_') && bodyIsValid(fault)) {
        // The client trusts the server's echo, never its own optimism.
        expect(after.toggle.value).toBe(bodyActive(fault));
      } else if (fault === 'ok_noapply') {
        expect(after.toggle.value).toBe(false);
        expect(after.error).toBeNull();
      } else if (
        fault === 'applied_then_hang' ||
        fault === 'applied_then_reject' ||
        fault === 'ok_slow_over_timeout' ||
        fault === 'deferred'
      ) {
        // Pinned as CS-2: the write reached the server, its response did not
        // come back, and the screen reports "nothing changed".
        expect(result.findings).toContain('CS-2');
        expect(after.toggle.value).toBe(false);
        expect(after.error).not.toBeNull();
      } else {
        expect(after.toggle.value).toBe(false);
        expect(after.error).not.toBeNull();
        expect(after.errorCopy).toBe(true);
      }
    });
  });

  describe('write (POST withdraw) faults from an active grant', () => {
    const WITHDRAW_FAULTS: FaultId[] = [
      'ok',
      'ok_noapply',
      'reject_network',
      'http_500',
      'http_401',
      'json_reject',
      'body_null',
      'body_inconsistent_flags',
      'hang_honor_abort',
      'applied_then_reject',
      'throw_sync',
      'undefined_response',
    ];
    it.each(WITHDRAW_FAULTS)('withdraw with POST fault %s', async fault => {
      const result = record(
        await runScenario(`withdraw:${fault}`, [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'ok' },
          { op: 'toggle', post: fault },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.busy).toBe(false);
      if (fault === 'ok') {
        expect(after.toggle.value).toBe(false);
      } else if (fault === 'body_inconsistent_flags') {
        expect(after.toggle.value).toBe(true);
      } else if (fault === 'applied_then_reject') {
        expect(result.findings).toContain('CS-2');
      } else {
        // Failure keeps the grant visible and says so. A 200 whose body
        // still says "active" is the server's word: the toggle stays on and
        // nothing is claimed.
        expect(after.toggle.value).toBe(true);
        if (fault !== 'ok_noapply') expect(after.error).not.toBeNull();
      }
    });
  });

  describe('session faults', () => {
    it('signed out at mount: Connect account, toggle off and disabled, no request', async () => {
      const result = record(
        await runScenario('session:signed-out-mount', [
          { op: 'mount', get: 'ok' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('signed_out');
      expect(after.connect).toBe(true);
      expect(result.requests).toBe(0);
    });

    it('auth session present but api session missing behaves as signed out', async () => {
      const result = record(
        await runScenario('session:auth-without-api', [
          { op: 'signIn', account: 'A' },
          { op: 'signOut' },
          { op: 'mount', get: 'ok' },
        ]),
      );
      expectHeld(result);
      expect(result.log[result.log.length - 1]!.after.availability).toBe(
        'signed_out',
      );
    });

    it('sign-out while the status read is in flight lands signed out, not ready', async () => {
      const result = record(
        await runScenario('session:signout-during-get', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'signOut' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      expect(result.log[result.log.length - 1]!.after.availability).toBe(
        'signed_out',
      );
    });

    it('account switch while the status read is in flight discards the old account', async () => {
      const result = record(
        await runScenario('session:switch-during-get', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'signIn', account: 'B', get: 'ok' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('ready');
      expect(after.toggle.value).toBe(false);
    });

    it('sign-out while a grant is in flight never shows a fake success', async () => {
      const result = record(
        await runScenario('session:signout-during-post', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'deferred' },
          { op: 'signOut' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('signed_out');
      expect(after.toggle.value).toBe(false);
    });

    it('account switch while a grant is in flight shows the new account, not the old grant', async () => {
      const result = record(
        await runScenario('session:switch-during-post', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'deferred' },
          { op: 'signIn', account: 'B', get: 'ok' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('ready');
      expect(after.toggle.value).toBe(false);
      expect(after.busy).toBe(false);
    });

    it('bearer rotation mid-flight (same account) still applies the response', async () => {
      const result = record(
        await runScenario('session:rotate-during-get', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'rotateToken' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      expect(result.log[result.log.length - 1]!.after.availability).toBe(
        'ready',
      );
    });

    it('session flapping A→out→A→B→A settles on the last account', async () => {
      const result = record(
        await runScenario('session:flap', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'signOut' },
          { op: 'signIn', account: 'A', get: 'deferred' },
          { op: 'signIn', account: 'B', get: 'deferred' },
          { op: 'signIn', account: 'A', get: 'ok' },
          // Settings tab + consent screen each hydrate per sign-in: five
          // deferred GETs are pending, release them out of order.
          { op: 'release', which: 'newest' },
          { op: 'release', which: 'oldest' },
          { op: 'release', which: 'oldest' },
          { op: 'release', which: 'newest' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('ready');
      expect(after.toggle.value).toBe(false);
    });

    it('toggle pressed after the api session vanished lands signed out with no request', async () => {
      // The screen is ready for A, then the api session vanishes before the
      // auth store re-renders the screen (the order signOut() writes in).
      const result = record(
        await runScenario('session:toggle-after-api-clear', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'clearApiOnly' },
          { op: 'toggle', post: 'ok' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(result.log[3]!.result).toBe('toggle: pressed');
      expect(after.availability).toBe('signed_out');
      expect(after.toggle.value).toBe(false);
      expect(after.connect).toBe(true);
      // Settings-tab GET on sign-in + the screen's GET; the press sent nothing.
      expect(result.requests).toBe(2);
    });
  });

  describe('navigation faults', () => {
    it('back pops to the route underneath while a read is still pending; the late response is harmless', async () => {
      const result = record(
        await runScenario('nav:back-with-pending', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'back' },
          { op: 'release', which: 'oldest' },
          { op: 'mount', get: 'ok' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.mounted).toBe(true);
      expect(after.availability).toBe('ready');
    });

    it('double back press pops exactly once and does not crash', async () => {
      const result = record(
        await runScenario('nav:double-back', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'back' },
          { op: 'back' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.mounted).toBe(false);
      expect(after.routeName).toBe('Tabs');
    });

    it('back on a root-only stack is reported by the navigator, not a crash', async () => {
      const result = record(
        await runScenario(
          'nav:back-on-root',
          [{ op: 'signIn', account: 'A' }, { op: 'back' }],
          {
            initialRoute: 'ConsentSettings',
            expectedConsoleErrors: [/GO_BACK/],
          },
        ),
      );
      expectHeld(result);
      expect(result.log[result.log.length - 1]!.after.mounted).toBe(true);
    });

    it('Connect account navigates to the ConnectAccount route', async () => {
      const result = record(
        await runScenario('nav:connect', [
          { op: 'mount', get: 'ok' },
          { op: 'connect' },
        ]),
      );
      expectHeld(result);
      expect(result.log[result.log.length - 1]!.after.routeName).toBe(
        'ConnectAccount',
      );
    });

    it('Connect account with the route unregistered is reported by the navigator, not a crash', async () => {
      const result = record(
        await runScenario(
          'nav:connect-missing-route',
          [{ op: 'mount', get: 'ok' }, { op: 'connect' }],
          {
            registerConnectAccount: false,
            expectedConsoleErrors: [/NAVIGATE|ConnectAccount/],
          },
        ),
      );
      expectHeld(result);
      expect(result.log[result.log.length - 1]!.after.mounted).toBe(true);
    });

    it('unmount mid-write: the store settles without the screen', async () => {
      const result = record(
        await runScenario('nav:unmount-mid-post', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'deferred' },
          { op: 'back' },
          { op: 'release', which: 'oldest' },
          { op: 'mount', get: 'ok' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.toggle.value).toBe(true);
      expect(after.busy).toBe(false);
    });
  });

  describe('interaction faults', () => {
    it('double-tap while busy sends exactly one write', async () => {
      const result = record(
        await runScenario('ux:double-tap', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'deferred' },
          { op: 'toggle', post: 'ok' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      expect(result.requests).toBe(3); // sign-in GET + mount GET + one POST
      expect(result.log[3]!.result).toBe('toggle: blocked');
    });

    it('toggle while loading is blocked at the control', async () => {
      const result = record(
        await runScenario('ux:toggle-while-loading', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'toggle', post: 'ok' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      expectHeld(result);
      expect(result.log[2]!.result).toBe('toggle: blocked');
      expect(result.requests).toBe(2); // sign-in GET + mount GET, no POST
    });

    it('Try again hammered five times under failure keeps a recoverable state', async () => {
      const result = record(
        await runScenario('ux:try-again-spam', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'reject_network' },
          { op: 'tryAgain', get: 'http_503' },
          { op: 'tryAgain', get: 'json_reject' },
          { op: 'tryAgain', get: 'body_null' },
          { op: 'tryAgain', get: 'throw_sync' },
          { op: 'tryAgain', get: 'http_429' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('unavailable');
      expect(after.tryAgain).toBe(true);
      expect(result.requests).toBe(7); // sign-in GET + mount GET + 5 retries
    });

    it('Try again after failure recovers to ready', async () => {
      const result = record(
        await runScenario('ux:try-again-recovers', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'hang_honor_abort' },
          { op: 'advance', ms: CONSENT_REQUEST_TIMEOUT_MS + 1 },
          { op: 'tryAgain', get: 'ok' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('ready');
      expect(after.error).toBeNull();
    });

    it('grant fails, then withdraw path is still reachable and honest', async () => {
      const result = record(
        await runScenario('ux:fail-then-succeed', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'http_500' },
          { op: 'toggle', post: 'ok' },
          { op: 'toggle', post: 'reject_network' },
          { op: 'toggle', post: 'ok' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.toggle.value).toBe(false);
      expect(after.error).toBeNull();
    });

    it('a successful grant followed by a failing re-read shows unavailable, never a stale ON', async () => {
      const result = record(
        await runScenario('ux:grant-then-reread-fails', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'ok' },
          { op: 'back' },
          { op: 'mount', get: 'http_503' },
        ]),
      );
      expectHeld(result);
      const after = result.log[result.log.length - 1]!.after;
      expect(after.availability).toBe('unavailable');
      expect(after.toggle.disabled).toBe(true);
      expect(after.toggle.value).toBe(false);
    });
  });

  describe('ordering faults (pinned findings)', () => {
    // CS-1: leave the screen while its first status read is slow, come back
    // (fast read → ready), grant, then the slow read from the FIRST visit
    // lands and flips the toggle back OFF although the ledger says ON.
    it('CS-1 stale status read from an earlier visit overwrites a newer grant', async () => {
      const result = record(
        await runScenario('order:stale-get-after-grant', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'back' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'ok' },
          { op: 'release', which: 'oldest' },
        ]),
      );
      const after = result.log[result.log.length - 1]!.after;
      expect(result.outcome).toBe('BROKEN');
      expect(result.findings).toEqual(['CS-1']);
      expect(after.toggle.value).toBe(false);
      expect(after.error).toBeNull();
    });

    it('CS-1 does not fire when the stale read lands before the grant', async () => {
      const result = record(
        await runScenario('order:stale-get-before-grant', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'deferred' },
          { op: 'back' },
          { op: 'mount', get: 'ok' },
          { op: 'release', which: 'oldest' },
          { op: 'toggle', post: 'ok' },
        ]),
      );
      expect(result.outcome).toBe('HELD');
      expect(result.log[result.log.length - 1]!.after.toggle.value).toBe(true);
    });

    // CS-2: the server applied the grant, the response was lost; the store
    // says "Nothing was changed" and shows OFF although the ledger is ON.
    it('CS-2 applied-but-lost grant is reported as unchanged and never reconciled', async () => {
      const result = record(
        await runScenario('order:lost-grant-response', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'ok' },
          { op: 'toggle', post: 'applied_then_hang' },
        ]),
      );
      const after = result.log[result.log.length - 1]!.after;
      expect(result.outcome).toBe('BROKEN');
      expect(result.findings).toEqual(['CS-2']);
      expect(after.toggle.value).toBe(false);
      expect(after.error).toBe('Consent settings are temporarily unavailable.');
    });

    // CS-3: other API clients report a 401 so the auth store can refresh or
    // end the session; the consent client swallows it as "unavailable".
    it('CS-3 a 401 on the consent route is not reported to the unauthorized listener', async () => {
      const result = record(
        await runScenario('auth:401-not-reported', [
          { op: 'signIn', account: 'A' },
          { op: 'mount', get: 'http_401' },
          { op: 'tryAgain', get: 'http_401' },
        ]),
      );
      expect(result.findings).toEqual(['CS-3']);
      expect(result.log[result.log.length - 1]!.after.availability).toBe(
        'unavailable',
      );
    });
  });

  describe('seeded random campaign', () => {
    const iterations = Number(process.env.STRESS_ITER ?? 25);
    const baseSeed = Number(process.env.STRESS_SEED ?? 1_000);
    const seeds = Array.from({ length: iterations }, (_, i) => baseSeed + i);

    it.each(seeds)(
      'seed %d holds every invariant or hits only a pinned finding',
      async seed => {
        const result = record(
          await runScenario(`random:${seed}`, randomSteps(seed), { seed }),
        );
        expectHeld(result);
      },
    );
  });

  it('replays a single seed from STRESS_REPLAY_SEED when set', async () => {
    const replay = process.env.STRESS_REPLAY_SEED;
    if (!replay) return;
    const seed = Number(replay);
    const result = record(
      await runScenario(`replay:${seed}`, randomSteps(seed), { seed }),
    );
    expectHeld(result);
  });
});
