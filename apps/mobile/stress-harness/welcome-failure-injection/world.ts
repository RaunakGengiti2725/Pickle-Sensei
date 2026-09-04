import type { LocalDb } from '../../src/data/db';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';

/**
 * Fault-injectable process edges for the WelcomeScreen launch matrix.
 *
 * Every dependency the real App reaches while it renders WelcomeScreen inside
 * the real Gate/providers/stores is modelled here as a fake that can be told,
 * per call, to throw synchronously, reject, never settle, settle slowly, or
 * answer with a malformed value. The production code under test is untouched;
 * only the native/process boundary is replaced:
 *
 *   - react-native-keychain           → FaultyKeychain
 *   - @op-engineering/op-sqlite       → FaultyDb (wraps the shared FakeLocalDb)
 *   - globalThis.fetch                → FaultyServer
 *   - @react-native-google-signin     → FaultyGoogle
 *   - react-native-notify-kit         → FaultyNotifee (drives the __mocks__ fns)
 *   - NativeModules.PickleAuth        → present / missing switch
 *
 * Every fake counts its calls so a row can prove the injected fault was
 * actually exercised (an injected fault nothing ever called is recorded as
 * `exercised: false`, never as a pass).
 */

export type CallFaultKind =
  'ok' | 'throw' | 'reject' | 'never' | 'slow' | 'return';

export interface CallFault {
  kind: CallFaultKind;
  message?: string;
  delayMs?: number;
  value?: unknown;
}

export const OK: CallFault = { kind: 'ok' };

function faultError(fault: CallFault, fallback: string): Error {
  return new Error(fault.message ?? fallback);
}

/**
 * Applies a CallFault around a real implementation. Synchronous throws happen
 * before any promise exists (the way a broken native binding fails), rejects
 * are settled promises, `never` is a promise that has no settle path at all,
 * `slow` waits on the (fake) clock and then runs the real implementation,
 * `return` short-circuits with an arbitrary value (malformed / partial).
 */
export function applyCallFault<T>(
  fault: CallFault | undefined,
  real: () => Promise<T>,
  label: string,
): Promise<T> {
  const kind = fault?.kind ?? 'ok';
  switch (kind) {
    case 'throw':
      throw faultError(fault!, `${label} threw (simulated)`);
    case 'reject':
      return Promise.reject(
        faultError(fault!, `${label} rejected (simulated)`),
      );
    case 'never':
      return new Promise<T>(() => {});
    case 'slow':
      return new Promise<void>(resolve =>
        setTimeout(resolve, fault?.delayMs ?? 1000),
      ).then(real);
    case 'return':
      return Promise.resolve(fault!.value as T);
    case 'ok':
    default:
      return real();
  }
}

// ─── Keychain ────────────────────────────────────────────────────────────────

export interface KeychainFaults {
  get?: CallFault;
  set?: CallFault;
  reset?: CallFault;
  /** Every property access on the module throws (binding missing). */
  moduleBroken?: boolean;
}

export class FaultyKeychain {
  readonly store = new Map<string, { username: string; password: string }>();
  readonly log: { op: 'get' | 'set' | 'reset'; at: number }[] = [];
  faults: KeychainFaults = {};
  calls = { get: 0, set: 0, reset: 0 };

  reset(): void {
    this.store.clear();
    this.log.length = 0;
    this.faults = {};
    this.calls = { get: 0, set: 0, reset: 0 };
  }

  /** The object jest hands to production code as the module. */
  module(): Record<string, unknown> {
    const guard = <T>(value: T): T => {
      if (this.faults.moduleBroken) {
        throw new Error('react-native-keychain native binding missing');
      }
      return value;
    };
    // Accessors (not values) so `moduleBroken` throws on every property
    // access, the way a missing native binding does. Arrow getters keep the
    // class instance as `this`.
    return Object.defineProperties(
      {},
      {
        ACCESSIBLE: {
          enumerable: true,
          get: () =>
            guard({
              AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
                'AccessibleAfterFirstUnlockThisDeviceOnly',
            }),
        },
        setGenericPassword: {
          enumerable: true,
          get: () =>
            guard(
              (
                username: string,
                password: string,
                options: { service?: string } = {},
              ) => {
                this.calls.set += 1;
                this.log.push({ op: 'set', at: Date.now() });
                return applyCallFault(
                  this.faults.set,
                  async () => {
                    this.store.set(options.service ?? '__default__', {
                      username,
                      password,
                    });
                    return { service: options.service, storage: 'mock' };
                  },
                  'Keychain.setGenericPassword',
                );
              },
            ),
        },
        getGenericPassword: {
          enumerable: true,
          get: () =>
            guard((options: { service?: string } = {}) => {
              this.calls.get += 1;
              this.log.push({ op: 'get', at: Date.now() });
              return applyCallFault(
                this.faults.get,
                async () => {
                  const item = this.store.get(options.service ?? '__default__');
                  if (!item) return false;
                  return { service: options.service, storage: 'mock', ...item };
                },
                'Keychain.getGenericPassword',
              );
            }),
        },
        resetGenericPassword: {
          enumerable: true,
          get: () =>
            guard((options: { service?: string } = {}) => {
              this.calls.reset += 1;
              this.log.push({ op: 'reset', at: Date.now() });
              return applyCallFault(
                this.faults.reset,
                async () => this.store.delete(options.service ?? '__default__'),
                'Keychain.resetGenericPassword',
              );
            }),
        },
      },
    );
  }
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

export interface DbExtraFaults {
  /** Applied to every statement (or only those matching `executeFor`). */
  execute?: CallFault;
  executeFor?: RegExp | null;
  /** Statements matching this pattern resolve with `malformedValue` as-is. */
  malformedFor?: RegExp | null;
  malformedValue?: unknown;
  closeThrows?: boolean;
}

export class FaultyDb {
  inner = new FakeLocalDb();
  extra: DbExtraFaults = {};
  executeCalls = 0;
  closeCalls = 0;

  reset(): void {
    this.inner = new FakeLocalDb();
    this.extra = {};
    this.executeCalls = 0;
    this.closeCalls = 0;
  }

  /** What `getDb()` returns to production code. */
  handle(): LocalDb {
    const real = this.inner.handle();
    return {
      execute: (sql: string, params: unknown[] = []) => {
        this.executeCalls += 1;
        const statement = sql.trim().replace(/\s+/g, ' ');
        const run = () => real.execute(statement, params);
        if (
          this.extra.malformedFor &&
          this.extra.malformedFor.test(statement)
        ) {
          return Promise.resolve(
            this.extra.malformedValue as { rows: Record<string, unknown>[] },
          );
        }
        const applies =
          this.extra.execute &&
          (!this.extra.executeFor || this.extra.executeFor.test(statement));
        return applyCallFault(
          applies ? this.extra.execute : undefined,
          run,
          `db.execute(${statement.slice(0, 32)})`,
        );
      },
      close: () => {
        this.closeCalls += 1;
        if (this.extra.closeThrows) {
          throw new Error('SQLITE_BUSY on close (simulated)');
        }
        real.close();
      },
    };
  }
}

// ─── fetch ───────────────────────────────────────────────────────────────────

export type RefreshMode =
  | 'rotate'
  | 'refuse-401'
  | 'refuse-403'
  | 'error-500'
  | 'error-429'
  | 'network'
  | 'hang'
  | 'malformed-200'
  | 'partial-200'
  | 'empty-body-200'
  | 'status-0';

export const REFRESH_MODES: readonly RefreshMode[] = [
  'rotate',
  'refuse-401',
  'refuse-403',
  'error-500',
  'error-429',
  'network',
  'hang',
  'malformed-200',
  'partial-200',
  'empty-body-200',
  'status-0',
];

/** Faults on the fetch function itself, before any route is looked at. */
export type FetchFault =
  | 'none'
  | 'undefined'
  | 'throw-sync'
  | 'non-response'
  | 'json-throws'
  | 'text-throws'
  | 'never';

export interface ServerCall {
  at: number;
  route: string;
  outcome: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class FaultyServer {
  apiBase = 'https://ucqnaiwqwjtgvlduiuib.supabase.co/functions/v1/api';
  refreshMode: RefreshMode = 'rotate';
  fetchFault: FetchFault = 'none';
  latencyMs = 0;
  bearerTtlSec = 3600;
  readonly valid = new Set<string>();
  readonly issued: string[] = [];
  readonly calls: ServerCall[] = [];
  readonly unexpected: string[] = [];
  inflight = 0;
  maxInflight = 0;
  /** The server's clock is independent of the device's: bound at construction
   * so a faulted `Date.now` (NaN, jumps) on the device side never changes
   * what the server issues. Jest's fake timers still drive it. */
  now: () => number = Date.now;
  private counter = 0;

  reset(): void {
    this.refreshMode = 'rotate';
    this.fetchFault = 'none';
    this.latencyMs = 0;
    this.bearerTtlSec = 3600;
    this.valid.clear();
    this.issued.length = 0;
    this.calls.length = 0;
    this.unexpected.length = 0;
    this.inflight = 0;
    this.maxInflight = 0;
    this.counter = 0;
  }

  seed(token: string): void {
    this.valid.add(token);
    this.issued.push(token);
  }

  private delay(
    ms: number,
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  private rotate(token: string): {
    access: string;
    refresh: string;
    exp: number;
  } {
    this.counter += 1;
    const successor = {
      access: `access-${this.counter}`,
      refresh: `refresh-${this.counter}`,
      exp: Math.floor(this.now() / 1000) + this.bearerTtlSec,
    };
    this.valid.delete(token);
    this.valid.add(successor.refresh);
    this.issued.push(successor.refresh);
    return successor;
  }

  /** Installed as globalThis.fetch (or removed, for the `undefined` fault). */
  install(): void {
    const g = globalThis as { fetch: unknown };
    if (this.fetchFault === 'undefined') {
      g.fetch = undefined;
      return;
    }
    g.fetch = this.fetch;
  }

  readonly fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    const route = url.startsWith(this.apiBase)
      ? url.slice(this.apiBase.length)
      : url;
    const call: ServerCall = { at: this.now(), route, outcome: 'pending' };
    this.calls.push(call);
    switch (this.fetchFault) {
      case 'throw-sync':
        call.outcome = 'fetch-threw-sync';
        throw new TypeError('fetch is not a function (simulated)');
      case 'never':
        call.outcome = 'fetch-never-settled';
        return new Promise<Response>(() => {});
      case 'non-response':
        call.outcome = 'fetch-returned-non-response';
        return Promise.resolve({} as unknown as Response);
      case 'json-throws':
        call.outcome = 'response-json-throws';
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.reject(new SyntaxError('bad json (simulated)')),
          text: () => Promise.resolve('{'),
        } as unknown as Response);
      case 'text-throws':
        call.outcome = 'response-text-throws';
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.reject(new SyntaxError('bad json (simulated)')),
          text: () => Promise.reject(new Error('body stream failed')),
        } as unknown as Response);
      case 'none':
      case 'undefined':
      default:
        break;
    }
    return this.route(route, init, call);
  };

  private async route(
    route: string,
    init: RequestInit,
    call: ServerCall,
  ): Promise<Response> {
    const signal = init.signal;
    if (route === '/v1/auth/refresh') {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      const token = String(body.refreshToken ?? '');
      this.inflight += 1;
      this.maxInflight = Math.max(this.maxInflight, this.inflight);
      try {
        if (this.refreshMode === 'hang') {
          await this.delay(10 * 60_000, signal);
          call.outcome = 'hang-elapsed';
          return new Response(null, { status: 599 });
        }
        await this.delay(this.latencyMs, signal);
        switch (this.refreshMode) {
          case 'refuse-401':
            call.outcome = '401';
            return jsonResponse(401, { error: { message: 'revoked' } });
          case 'refuse-403':
            call.outcome = '403';
            return jsonResponse(403, { error: { message: 'forbidden' } });
          case 'error-500':
            call.outcome = '500';
            return jsonResponse(500, { error: { message: 'boom' } });
          case 'error-429':
            call.outcome = '429';
            return jsonResponse(429, { error: { message: 'slow down' } });
          case 'network':
            call.outcome = 'network-error';
            throw new TypeError('Network request failed');
          case 'malformed-200':
            call.outcome = '200-malformed';
            return new Response('<html>not json</html>', { status: 200 });
          case 'partial-200':
            call.outcome = '200-partial';
            return jsonResponse(200, {
              session: { accessToken: 'access-partial' },
            });
          case 'empty-body-200':
            call.outcome = '200-empty';
            return new Response('', { status: 200 });
          case 'status-0':
            call.outcome = 'status-0';
            return {
              ok: false,
              status: 0,
              headers: new Headers(),
              json: () => Promise.resolve(null),
              text: () => Promise.resolve(''),
            } as unknown as Response;
          case 'rotate':
          default: {
            if (this.valid.has(token)) {
              const next = this.rotate(token);
              call.outcome = `rotated→${next.refresh}`;
              return jsonResponse(200, {
                session: {
                  accessToken: next.access,
                  refreshToken: next.refresh,
                  expiresAt: next.exp,
                },
              });
            }
            call.outcome = '401-unknown-token';
            return jsonResponse(401, {
              error: {
                message: 'The session could not be refreshed. Sign in again.',
              },
            });
          }
        }
      } catch (error) {
        if (call.outcome === 'pending') call.outcome = 'aborted-by-client';
        throw error;
      } finally {
        this.inflight -= 1;
      }
    }
    if (route === '/v1/me') {
      await this.delay(Math.min(this.latencyMs, 200), signal);
      call.outcome = '200';
      return jsonResponse(200, {
        onboardingState: 'complete',
        profile: {
          skill_level: 'intermediate',
          handedness: 'right',
          primary_goal: 'consistency',
          biggest_problem: 'popups',
          first_name: 'Server',
        },
      });
    }
    if (route === '/v1/me/onboarding') {
      // A pending (offline-captured) onboarding profile is uploaded once the
      // session is verified; the server answers with a training focus.
      await this.delay(Math.min(this.latencyMs, 200), signal);
      call.outcome = '200';
      return jsonResponse(200, { recommendedCheckpoint: 'contact_position' });
    }
    if (route === '/v1/auth/logout') {
      await this.delay(Math.min(this.latencyMs, 200), signal);
      call.outcome = '204';
      return new Response(null, { status: 204 });
    }
    if (route === '/v1/account/bootstrap') {
      // The legacy Google silent-restore path ends here. The harness never
      // grants a new account from it: a 503 is the honest offline answer and
      // keeps the last-provider flag for the next launch.
      await this.delay(Math.min(this.latencyMs, 200), signal);
      call.outcome = '503';
      return jsonResponse(503, { error: { message: 'bootstrap unavailable' } });
    }
    this.unexpected.push(route);
    call.outcome = '404-unexpected';
    return jsonResponse(404, {
      error: { message: 'unexpected route in harness' },
    });
  }
}

// ─── Google Sign-In ──────────────────────────────────────────────────────────

export interface GoogleFaults {
  configure?: 'ok' | 'throw';
  hasPreviousSignIn?: 'true' | 'false' | 'throw' | 'return-garbage';
  signInSilently?: CallFault;
  moduleBroken?: boolean;
}

export class FaultyGoogle {
  faults: GoogleFaults = {};
  calls = { configure: 0, hasPreviousSignIn: 0, signInSilently: 0 };

  reset(): void {
    this.faults = {};
    this.calls = { configure: 0, hasPreviousSignIn: 0, signInSilently: 0 };
  }

  module(): Record<string, unknown> {
    const guard = <T>(value: T): T => {
      if (this.faults.moduleBroken) {
        throw new Error('GoogleSignin native module missing');
      }
      return value;
    };
    return Object.defineProperties(
      {},
      {
        GoogleSignin: {
          enumerable: true,
          get: () =>
            guard({
              configure: () => {
                this.calls.configure += 1;
                if (this.faults.configure === 'throw') {
                  throw new Error('GoogleSignin.configure failed (simulated)');
                }
              },
              hasPreviousSignIn: () => {
                this.calls.hasPreviousSignIn += 1;
                switch (this.faults.hasPreviousSignIn) {
                  case 'true':
                    return true;
                  case 'throw':
                    throw new Error('hasPreviousSignIn threw (simulated)');
                  case 'return-garbage':
                    return { weird: true };
                  case 'false':
                  default:
                    return false;
                }
              },
              signInSilently: () => {
                this.calls.signInSilently += 1;
                return applyCallFault(
                  this.faults.signInSilently ?? {
                    kind: 'reject',
                    message: 'no silent google session (simulated)',
                  },
                  async () => ({ type: 'noSavedCredentialFound' }),
                  'GoogleSignin.signInSilently',
                );
              },
              hasPlayServices: async () => true,
              signIn: async () => ({ type: 'cancelled' }),
              signOut: async () => {},
              revokeAccess: async () => {},
            }),
        },
      },
    );
  }
}

// ─── Notifications (react-native-notify-kit) ─────────────────────────────────

export interface NotifeeFaults {
  getNotificationSettings?: CallFault;
  requestPermission?: CallFault;
  getTriggerNotificationIds?: CallFault;
  cancelTriggerNotification?: CallFault;
  createTriggerNotification?: CallFault;
}

/** Drives the jest.fn()s of the package's __mocks__ module. */
export class FaultyNotifee {
  faults: NotifeeFaults = {};
  calls = {
    getNotificationSettings: 0,
    requestPermission: 0,
    getTriggerNotificationIds: 0,
    cancelTriggerNotification: 0,
    createTriggerNotification: 0,
  };

  reset(): void {
    this.faults = {};
    this.calls = {
      getNotificationSettings: 0,
      requestPermission: 0,
      getTriggerNotificationIds: 0,
      cancelTriggerNotification: 0,
      createTriggerNotification: 0,
    };
  }

  bind(mock: {
    getNotificationSettings: jest.Mock;
    requestPermission: jest.Mock;
    getTriggerNotificationIds: jest.Mock;
    cancelTriggerNotification: jest.Mock;
    createTriggerNotification: jest.Mock;
  }): void {
    mock.getNotificationSettings.mockImplementation(() => {
      this.calls.getNotificationSettings += 1;
      return applyCallFault(
        this.faults.getNotificationSettings,
        async () => ({ authorizationStatus: 1 }),
        'notifee.getNotificationSettings',
      );
    });
    mock.requestPermission.mockImplementation(() => {
      this.calls.requestPermission += 1;
      return applyCallFault(
        this.faults.requestPermission,
        async () => ({ authorizationStatus: 1 }),
        'notifee.requestPermission',
      );
    });
    mock.getTriggerNotificationIds.mockImplementation(() => {
      this.calls.getTriggerNotificationIds += 1;
      return applyCallFault(
        this.faults.getTriggerNotificationIds,
        async () => ['pickle-sensei.reminder-1', 'other-app-id'],
        'notifee.getTriggerNotificationIds',
      );
    });
    mock.cancelTriggerNotification.mockImplementation(() => {
      this.calls.cancelTriggerNotification += 1;
      return applyCallFault(
        this.faults.cancelTriggerNotification,
        async () => {},
        'notifee.cancelTriggerNotification',
      );
    });
    mock.createTriggerNotification.mockImplementation(() => {
      this.calls.createTriggerNotification += 1;
      return applyCallFault(
        this.faults.createTriggerNotification,
        async () => 'mock-id',
        'notifee.createTriggerNotification',
      );
    });
  }
}

// ─── AppState / AccessibilityInfo / clock ────────────────────────────────────

export interface RuntimeFaults {
  /** AppState.addEventListener throws synchronously. */
  appStateAddListenerThrows?: boolean;
  /** AppState.addEventListener returns undefined (no subscription object). */
  appStateAddListenerReturnsUndefined?: boolean;
  /** NativeModules.PickleAuth is absent from the build. */
  pickleAuthMissing?: boolean;
  /** Date.now() answers NaN for the whole scenario. */
  clockNaN?: boolean;
}

export class World {
  readonly keychain = new FaultyKeychain();
  readonly db = new FaultyDb();
  readonly server = new FaultyServer();
  readonly google = new FaultyGoogle();
  readonly notifee = new FaultyNotifee();
  runtime: RuntimeFaults = {};
  /** Every fake's call counters, snapshot at the end of a scenario. */
  callCounts(): Record<string, number> {
    return {
      keychainGet: this.keychain.calls.get,
      keychainSet: this.keychain.calls.set,
      keychainReset: this.keychain.calls.reset,
      dbExecute: this.db.executeCalls,
      dbClose: this.db.closeCalls,
      fetch: this.server.calls.length,
      googleConfigure: this.google.calls.configure,
      googleHasPreviousSignIn: this.google.calls.hasPreviousSignIn,
      googleSignInSilently: this.google.calls.signInSilently,
      notifeeGetSettings: this.notifee.calls.getNotificationSettings,
      notifeeGetTriggerIds: this.notifee.calls.getTriggerNotificationIds,
      notifeeCancel: this.notifee.calls.cancelTriggerNotification,
    };
  }

  reset(): void {
    this.keychain.reset();
    this.db.reset();
    this.server.reset();
    this.google.reset();
    this.notifee.reset();
    this.runtime = {};
  }
}
