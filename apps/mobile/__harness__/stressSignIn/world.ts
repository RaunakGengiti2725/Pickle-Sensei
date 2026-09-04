/**
 * Fault-injectable stand-ins for every native / network seam the SignIn
 * flow reaches when it runs inside the real App (Gate → Welcome → SignIn →
 * authStore → bootstrap → Keychain/SQLite → appStore/notifications).
 *
 * Nothing here is random: every fake is a pure function of the `Faults`
 * object it is configured with, so a scenario row (seed + faults) replays
 * exactly. "hang" faults return a promise that never settles — the suite
 * detects that with jest fake timers advanced 60s, never with wall-clock.
 */
import type { LocalDb } from '../../src/data/db';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';
import { FakeLocalDb } from '../../xc-harness/lifecycle-persistence/fakeLocalDb';

export const API_BASE = 'https://api.example.test';
export const CANONICAL_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';
export const APPLE_IDENTITY_TOKEN = 'apple-identity-token-DO-NOT-PERSIST';
export const GOOGLE_ID_TOKEN = 'google-id-token-DO-NOT-PERSIST';

/** A promise that never settles (the dependency "hangs"). */
export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

export type DbFault =
  | 'ok'
  | 'open-throws'
  | 'all-throw'
  | 'kv-get-throws'
  | 'kv-set-throws-last-provider'
  | 'kv-set-throws-local-mode'
  | 'kv-set-hangs'
  | 'all-hang'
  | 'slow-3s'
  | 'malformed-rows'
  | 'kv-garbage-values'
  | 'dies-after-first-write';

export const DB_FAULTS: readonly DbFault[] = [
  'ok',
  'open-throws',
  'all-throw',
  'kv-get-throws',
  'kv-set-throws-last-provider',
  'kv-set-throws-local-mode',
  'kv-set-hangs',
  'all-hang',
  'slow-3s',
  'malformed-rows',
  'kv-garbage-values',
  'dies-after-first-write',
];

export class FaultyDb {
  readonly inner = new FakeLocalDb();
  fault: DbFault = 'ok';
  private writesSeen = 0;

  reset(): void {
    this.inner.kv.clear();
    this.inner.shots.length = 0;
    this.inner.statements.length = 0;
    this.inner.faults = {};
    this.fault = 'ok';
    this.writesSeen = 0;
  }

  handle(): LocalDb {
    if (this.fault === 'open-throws') {
      throw new Error('SQLITE_CANTOPEN (simulated): unable to open database');
    }
    const base = this.inner.handle({ ignoreOpenFault: true });
    return {
      execute: async (sql: string, params: unknown[] = []) => {
        const statement = sql.trim().replace(/\s+/g, ' ');
        const isKvSet = statement.startsWith('INSERT OR REPLACE INTO kv');
        const isKvGet = statement.startsWith('SELECT value FROM kv');
        const key = isKvSet || isKvGet ? String(params[0]) : null;
        switch (this.fault) {
          case 'all-throw':
            this.inner.statements.push({ sql: statement, params });
            throw new Error('SQLITE_IOERR (simulated) disk I/O error');
          case 'kv-get-throws':
            if (isKvGet) {
              this.inner.statements.push({ sql: statement, params });
              throw new Error(`SQLITE_IOERR (simulated) reading kv ${key}`);
            }
            break;
          case 'kv-set-throws-last-provider':
            if (isKvSet && key === 'auth.last-provider') {
              this.inner.statements.push({ sql: statement, params });
              throw new Error(
                'SQLITE_FULL (simulated) writing auth.last-provider',
              );
            }
            break;
          case 'kv-set-throws-local-mode':
            if (isKvSet && key === 'auth.local-mode') {
              this.inner.statements.push({ sql: statement, params });
              throw new Error(
                'SQLITE_FULL (simulated) writing auth.local-mode',
              );
            }
            break;
          case 'kv-set-hangs':
            if (isKvSet) {
              this.inner.statements.push({ sql: statement, params });
              return never();
            }
            break;
          case 'all-hang':
            this.inner.statements.push({ sql: statement, params });
            return never();
          case 'slow-3s':
            await delay(3_000);
            break;
          case 'malformed-rows':
            this.inner.statements.push({ sql: statement, params });
            return { rows: null } as unknown as {
              rows: Record<string, unknown>[];
            };
          case 'kv-garbage-values':
            if (isKvGet) {
              this.inner.statements.push({ sql: statement, params });
              return { rows: [{ value: '\u0000{garbage' }] };
            }
            break;
          case 'dies-after-first-write':
            if (isKvSet) this.writesSeen += 1;
            if (this.writesSeen > 1) {
              this.inner.statements.push({ sql: statement, params });
              throw new Error('SQLITE_IOERR (simulated) database gone mid-run');
            }
            break;
          default:
            break;
        }
        return base.execute(sql, params);
      },
      close: () => base.close(),
    };
  }
}

// ─── Keychain ────────────────────────────────────────────────────────────────

export type KeychainOpFault =
  | 'ok'
  | 'throw-sync'
  | 'reject'
  | 'hang'
  | 'slow-5s'
  | 'malformed'
  | 'returns-false'
  | 'silent-drop';

export const KEYCHAIN_OP_FAULTS: readonly KeychainOpFault[] = [
  'ok',
  'throw-sync',
  'reject',
  'hang',
  'slow-5s',
  'malformed',
  'returns-false',
  'silent-drop',
];

export interface KeychainFaults {
  moduleMissing: boolean;
  get: KeychainOpFault;
  set: KeychainOpFault;
  reset: KeychainOpFault;
}

export const KEYCHAIN_OK: KeychainFaults = {
  moduleMissing: false,
  get: 'ok',
  set: 'ok',
  reset: 'ok',
};

export class FaultyKeychain {
  readonly store = new Map<string, { username: string; password: string }>();
  readonly log: { op: 'get' | 'set' | 'reset'; at: number }[] = [];
  faults: KeychainFaults = { ...KEYCHAIN_OK };

  reset(): void {
    this.store.clear();
    this.log.length = 0;
    this.faults = { ...KEYCHAIN_OK };
  }

  private fail(op: 'get' | 'set' | 'reset'): Promise<never> | null {
    const fault = this.faults[op];
    if (fault === 'throw-sync') {
      throw new Error(`Keychain ${op} threw synchronously (simulated)`);
    }
    if (fault === 'reject') {
      return Promise.reject(
        new Error(`errSecInteractionNotAllowed (simulated) during ${op}`),
      );
    }
    if (fault === 'hang') return never();
    return null;
  }

  readonly module = {
    ACCESSIBLE: {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
        'AccessibleAfterFirstUnlockThisDeviceOnly',
    },
    setGenericPassword: (
      username: string,
      password: string,
      options: { service?: string } = {},
    ): Promise<unknown> => {
      this.log.push({ op: 'set', at: Date.now() });
      const failure = this.fail('set');
      if (failure) return failure;
      const service = options.service ?? '__default__';
      const run = async () => {
        if (this.faults.set === 'slow-5s') await delay(5_000);
        if (this.faults.set === 'returns-false') return false;
        if (this.faults.set === 'silent-drop') return { service };
        if (this.faults.set === 'malformed') {
          this.store.set(service, { username, password: '{"version":1,' });
          return { service, storage: 'mock' };
        }
        this.store.set(service, { username, password });
        return { service, storage: 'mock' };
      };
      return run();
    },
    getGenericPassword: (
      options: { service?: string } = {},
    ): Promise<unknown> => {
      this.log.push({ op: 'get', at: Date.now() });
      const failure = this.fail('get');
      if (failure) return failure;
      const service = options.service ?? '__default__';
      const run = async () => {
        if (this.faults.get === 'slow-5s') await delay(5_000);
        if (this.faults.get === 'malformed') {
          return { service, storage: 'mock', username: 'session' };
        }
        if (this.faults.get === 'returns-false') return false;
        const item = this.store.get(service);
        if (!item) return false;
        return { service, storage: 'mock', ...item };
      };
      return run();
    },
    resetGenericPassword: (
      options: { service?: string } = {},
    ): Promise<unknown> => {
      this.log.push({ op: 'reset', at: Date.now() });
      const failure = this.fail('reset');
      if (failure) return failure;
      const service = options.service ?? '__default__';
      const run = async () => {
        if (this.faults.reset === 'slow-5s') await delay(5_000);
        if (this.faults.reset === 'silent-drop') return true;
        return this.store.delete(service);
      };
      return run();
    },
  };
}

// ─── Apple native module (NativeModules.PickleAuth) ──────────────────────────

export type AppleFault =
  | 'ok'
  | 'module-missing'
  | 'method-missing'
  | 'throw-sync'
  | 'reject-error'
  | 'reject-cancel'
  | 'reject-string'
  | 'reject-undefined'
  | 'hang'
  | 'slow-5s'
  | 'resolve-null'
  | 'resolve-string'
  | 'resolve-no-token'
  | 'resolve-empty-token'
  | 'resolve-whitespace-token'
  | 'resolve-partial'
  | 'return-non-promise';

export const APPLE_FAULTS: readonly AppleFault[] = [
  'ok',
  'module-missing',
  'method-missing',
  'throw-sync',
  'reject-error',
  'reject-cancel',
  'reject-string',
  'reject-undefined',
  'hang',
  'slow-5s',
  'resolve-null',
  'resolve-string',
  'resolve-no-token',
  'resolve-empty-token',
  'resolve-whitespace-token',
  'resolve-partial',
  'return-non-promise',
];

export interface AppleResult {
  user: string;
  identityToken?: string;
  authorizationCode?: string;
  email?: string;
  givenName?: string;
  familyName?: string;
}

export class FaultyApple {
  fault: AppleFault = 'ok';
  calls = 0;

  /** What to install at NativeModules.PickleAuth (undefined = absent). */
  nativeModule(): { signInWithApple?: () => unknown } | undefined {
    if (this.fault === 'module-missing') return undefined;
    if (this.fault === 'method-missing') return {};
    return { signInWithApple: () => this.signInWithApple() };
  }

  private full(): AppleResult {
    return {
      user: 'apple-subject-001',
      identityToken: APPLE_IDENTITY_TOKEN,
      authorizationCode: 'apple-auth-code',
      email: 'pat@example.test',
      givenName: 'Pat',
      familyName: 'Player',
    };
  }

  signInWithApple(): unknown {
    this.calls += 1;
    switch (this.fault) {
      case 'throw-sync':
        throw new Error('ASAuthorizationError (simulated) sync throw');
      case 'reject-error':
        return Promise.reject(
          new Error('ASAuthorizationError.failed (simulated)'),
        );
      case 'reject-cancel':
        return Promise.reject({
          code: 'auth.canceled',
          message: 'Sign-in canceled.',
        });
      case 'reject-string':
        return Promise.reject('native rejected with a bare string');
      case 'reject-undefined':
        return Promise.reject(undefined);
      case 'hang':
        return never();
      case 'slow-5s':
        return delay(5_000).then(() => this.full());
      case 'resolve-null':
        return Promise.resolve(null);
      case 'resolve-string':
        return Promise.resolve('not-an-object');
      case 'resolve-no-token':
        return Promise.resolve({ user: 'apple-subject-001' });
      case 'resolve-empty-token':
        return Promise.resolve({
          user: 'apple-subject-001',
          identityToken: '',
        });
      case 'resolve-whitespace-token':
        return Promise.resolve({
          user: 'apple-subject-001',
          identityToken: '   ',
        });
      case 'resolve-partial':
        return Promise.resolve({
          user: 'apple-subject-001',
          identityToken: APPLE_IDENTITY_TOKEN,
        });
      case 'return-non-promise':
        return this.full();
      default:
        return Promise.resolve(this.full());
    }
  }
}

// ─── Google Sign-In SDK ──────────────────────────────────────────────────────

export type GoogleFault =
  | 'ok'
  | 'module-missing'
  | 'configure-throws'
  | 'play-services-rejects'
  | 'play-services-hangs'
  | 'play-services-slow-5s'
  | 'signin-rejects'
  | 'signin-rejects-string'
  | 'signin-throws-sync'
  | 'signin-cancelled'
  | 'signin-type-garbage'
  | 'signin-hangs'
  | 'signin-slow-5s'
  | 'signin-resolve-null'
  | 'signin-success-no-data'
  | 'signin-success-no-idtoken'
  | 'signin-success-no-user';

export const GOOGLE_FAULTS: readonly GoogleFault[] = [
  'ok',
  'module-missing',
  'configure-throws',
  'play-services-rejects',
  'play-services-hangs',
  'play-services-slow-5s',
  'signin-rejects',
  'signin-rejects-string',
  'signin-throws-sync',
  'signin-cancelled',
  'signin-type-garbage',
  'signin-hangs',
  'signin-slow-5s',
  'signin-resolve-null',
  'signin-success-no-data',
  'signin-success-no-idtoken',
  'signin-success-no-user',
];

export class FaultyGoogle {
  fault: GoogleFault = 'ok';
  configureCalls = 0;
  signInCalls = 0;

  private success() {
    return {
      type: 'success',
      data: {
        idToken: GOOGLE_ID_TOKEN,
        user: { id: 'g-1', name: 'Pat Player', email: 'pat@example.test' },
      },
    };
  }

  readonly sdk = {
    configure: (): void => {
      this.configureCalls += 1;
      if (this.fault === 'configure-throws') {
        throw new Error('GoogleSignin.configure threw (simulated)');
      }
    },
    hasPlayServices: (): Promise<boolean> => {
      switch (this.fault) {
        case 'play-services-rejects':
          return Promise.reject(new Error('PLAY_SERVICES_NOT_AVAILABLE'));
        case 'play-services-hangs':
          return never();
        case 'play-services-slow-5s':
          return delay(5_000).then(() => true);
        default:
          return Promise.resolve(true);
      }
    },
    signIn: (): unknown => {
      this.signInCalls += 1;
      switch (this.fault) {
        case 'signin-rejects':
          return Promise.reject(new Error('SIGN_IN_REQUIRED (simulated)'));
        case 'signin-rejects-string':
          return Promise.reject('bare string rejection');
        case 'signin-throws-sync':
          throw new Error('GoogleSignin.signIn threw synchronously');
        case 'signin-cancelled':
          return Promise.resolve({ type: 'cancelled', data: null });
        case 'signin-type-garbage':
          return Promise.resolve({ type: 42, data: undefined });
        case 'signin-hangs':
          return never();
        case 'signin-slow-5s':
          return delay(5_000).then(() => this.success());
        case 'signin-resolve-null':
          return Promise.resolve(null);
        case 'signin-success-no-data':
          return Promise.resolve({ type: 'success' });
        case 'signin-success-no-idtoken':
          return Promise.resolve({
            type: 'success',
            data: { idToken: null, user: { id: 'g-1', name: 'Pat' } },
          });
        case 'signin-success-no-user':
          return Promise.resolve({
            type: 'success',
            data: { idToken: GOOGLE_ID_TOKEN },
          });
        default:
          return Promise.resolve(this.success());
      }
    },
    signInSilently: (): Promise<unknown> =>
      Promise.reject(new Error('no silent session (simulated)')),
    hasPreviousSignIn: (): boolean => false,
    signOut: (): Promise<void> => Promise.resolve(),
    revokeAccess: (): Promise<void> => Promise.resolve(),
  };

  /** The module object handed to `require('@react-native-google-signin/…')`.
   * Access to `GoogleSignin` throws when the SDK is "missing" — the same
   * guarded path a failing native require takes. */
  readonly module = {
    get GoogleSignin() {
      return undefined as unknown;
    },
  };

  constructor() {
    Object.defineProperty(this.module, 'GoogleSignin', {
      get: () => {
        if (this.fault === 'module-missing') {
          throw new Error(
            "Cannot find module '@react-native-google-signin/google-signin' (simulated)",
          );
        }
        return this.sdk;
      },
    });
  }
}

// ─── Scripted API server (globalThis.fetch) ──────────────────────────────────

export type BootstrapFault =
  | 'ok'
  | 'ok-no-session'
  | 'ok-session-partial-no-refresh'
  | 'ok-session-expires-string'
  | 'ok-session-expires-past'
  | 'ok-session-expires-negative'
  | 'ok-huge-body'
  | 'ok-error-envelope'
  | 'ok-onboarding-pending'
  | 'throw-sync'
  | 'reject-network'
  | 'reject-string'
  | 'hang-honours-abort'
  | 'hang-ignores-abort'
  | 'body-hangs'
  | 'slow-5s'
  | 'slow-14s'
  | 'slow-16s'
  | 'html-200'
  | 'json-null-200'
  | 'empty-body-200'
  | 'truncated-json-200'
  | 'user-missing-id'
  | 'user-id-not-uuid'
  | 'onboarding-state-bogus'
  | 'status-401'
  | 'status-403'
  | 'status-429'
  | 'status-404'
  | 'status-500'
  | 'status-503-html'
  | 'json-rejects';

export const BOOTSTRAP_FAULTS: readonly BootstrapFault[] = [
  'ok',
  'ok-no-session',
  'ok-session-partial-no-refresh',
  'ok-session-expires-string',
  'ok-session-expires-past',
  'ok-session-expires-negative',
  'ok-huge-body',
  'ok-error-envelope',
  'ok-onboarding-pending',
  'throw-sync',
  'reject-network',
  'reject-string',
  'hang-honours-abort',
  'hang-ignores-abort',
  'body-hangs',
  'slow-5s',
  'slow-14s',
  'slow-16s',
  'html-200',
  'json-null-200',
  'empty-body-200',
  'truncated-json-200',
  'user-missing-id',
  'user-id-not-uuid',
  'onboarding-state-bogus',
  'status-401',
  'status-403',
  'status-429',
  'status-404',
  'status-500',
  'status-503-html',
  'json-rejects',
];

/** Bootstrap outcomes where the server DID mint an account+session. */
export const BOOTSTRAP_SERVER_ACCEPTED = new Set<BootstrapFault>([
  'ok',
  'ok-no-session',
  'ok-session-partial-no-refresh',
  'ok-session-expires-string',
  'ok-session-expires-past',
  'ok-session-expires-negative',
  'ok-huge-body',
  'ok-error-envelope',
  'ok-onboarding-pending',
  'slow-5s',
  'slow-14s',
]);

/** Accepted outcomes where a durable refresh token was minted. */
export const BOOTSTRAP_MINTS_REFRESH = new Set<BootstrapFault>([
  'ok',
  'ok-session-expires-past',
  'ok-session-expires-negative',
  'ok-huge-body',
  'ok-error-envelope',
  'ok-onboarding-pending',
  'slow-5s',
  'slow-14s',
]);

export type MeFault = 'ok' | 'pending' | 'status-500' | 'hang' | 'malformed';
export const ME_FAULTS: readonly MeFault[] = [
  'ok',
  'pending',
  'status-500',
  'hang',
  'malformed',
];

export type RefreshFault = 'ok' | 'status-401' | 'status-500' | 'hang';
export const REFRESH_FAULTS: readonly RefreshFault[] = [
  'ok',
  'status-401',
  'status-500',
  'hang',
];

export interface ServerCall {
  route: string;
  at: number;
  bearer: string | null;
  outcome: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function rawResponse(
  status: number,
  body: string | null,
  contentType = 'text/html',
): Response {
  return new Response(body, {
    status,
    headers: { 'Content-Type': contentType },
  });
}

export class ScriptedServer {
  bootstrap: BootstrapFault = 'ok';
  me: MeFault = 'ok';
  refresh: RefreshFault = 'ok';
  /** Server clock offset relative to the device (seconds). */
  clockSkewSec = 0;
  readonly calls: ServerCall[] = [];
  readonly issuedAccess: string[] = [];
  readonly issuedRefresh: string[] = [];
  readonly unexpected: string[] = [];
  private counter = 0;

  reset(): void {
    this.bootstrap = 'ok';
    this.me = 'ok';
    this.refresh = 'ok';
    this.clockSkewSec = 0;
    this.calls.length = 0;
    this.issuedAccess.length = 0;
    this.issuedRefresh.length = 0;
    this.unexpected.length = 0;
    this.counter = 0;
  }

  private abortable(
    ms: number,
    signal: AbortSignal | null | undefined,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('AbortError (simulated)'));
        return;
      }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  private mint(expiresInSec: number): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } {
    this.counter += 1;
    const accessToken = `access-${this.counter}`;
    const refreshToken = `refresh-${this.counter}`;
    this.issuedAccess.push(accessToken);
    this.issuedRefresh.push(refreshToken);
    return {
      accessToken,
      refreshToken,
      expiresAt:
        Math.floor(Date.now() / 1000) + this.clockSkewSec + expiresInSec,
    };
  }

  private account(onboardingState: 'pending' | 'complete' = 'complete') {
    return {
      user: { id: CANONICAL_ID, email: 'pat@example.test' },
      onboardingState,
    };
  }

  private bearerOf(init: RequestInit): string | null {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? null;
    return auth ? auth.replace(/^Bearer\s+/, '') : null;
  }

  readonly fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    const call: ServerCall = {
      route: url.replace(API_BASE, ''),
      at: Date.now(),
      bearer: this.bearerOf(init),
      outcome: 'pending',
    };
    this.calls.push(call);
    if (url === `${API_BASE}/v1/account/bootstrap`) {
      if (this.bootstrap === 'throw-sync') {
        call.outcome = 'threw';
        throw new TypeError('fetch threw synchronously (simulated)');
      }
      return this.handleBootstrap(call, init.signal);
    }
    if (url === `${API_BASE}/v1/me`) return this.handleMe(call, init.signal);
    if (url === `${API_BASE}/v1/me/access`) {
      call.outcome = '200';
      return Promise.resolve(
        jsonResponse(200, {
          premium: false,
          entitlements: [],
          canStartRating: true,
          paywallRequired: false,
          freeRatings: {
            limit: 2,
            used: 0,
            reserved: 0,
            remaining: 2,
            availableToReserve: 2,
          },
        }),
      );
    }
    if (url === `${API_BASE}/v1/auth/refresh`) {
      return this.handleRefresh(call, init.signal);
    }
    if (url === `${API_BASE}/v1/auth/logout`) {
      call.outcome = '204';
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    this.unexpected.push(call.route);
    call.outcome = '404-unexpected';
    return Promise.resolve(
      jsonResponse(404, { error: { message: 'unexpected route' } }),
    );
  };

  private async handleBootstrap(
    call: ServerCall,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    const finish = (outcome: string, response: Response) => {
      call.outcome = outcome;
      return response;
    };
    switch (this.bootstrap) {
      case 'reject-network':
        call.outcome = 'network-error';
        throw new TypeError('Network request failed');
      case 'reject-string':
        call.outcome = 'rejected-string';
        throw 'the network layer rejected with a string';
      case 'hang-honours-abort':
        await this.abortable(10 * 60_000, signal);
        return finish('hang-elapsed', rawResponse(599, null));
      case 'hang-ignores-abort':
        call.outcome = 'hang-forever';
        return never();
      case 'body-hangs': {
        call.outcome = 'headers-then-stall';
        const response = jsonResponse(200, this.account());
        Object.defineProperty(response, 'json', { value: () => never() });
        return response;
      }
      case 'slow-5s':
        await this.abortable(5_000, signal);
        break;
      case 'slow-14s':
        await this.abortable(14_000, signal);
        break;
      case 'slow-16s':
        await this.abortable(16_000, signal);
        break;
      default:
        break;
    }
    switch (this.bootstrap) {
      case 'ok-no-session':
        return finish('200-no-session', jsonResponse(200, this.account()));
      case 'ok-session-partial-no-refresh': {
        const tokens = this.mint(3600);
        this.issuedRefresh.pop();
        return finish(
          '200-partial-session',
          jsonResponse(200, {
            ...this.account(),
            session: {
              accessToken: tokens.accessToken,
              expiresAt: tokens.expiresAt,
            },
          }),
        );
      }
      case 'ok-session-expires-string': {
        const tokens = this.mint(3600);
        this.issuedRefresh.pop();
        return finish(
          '200-expires-string',
          jsonResponse(200, {
            ...this.account(),
            session: { ...tokens, expiresAt: String(tokens.expiresAt) },
          }),
        );
      }
      case 'ok-session-expires-past':
        return finish(
          '200-expires-past',
          jsonResponse(200, { ...this.account(), session: this.mint(-3600) }),
        );
      case 'ok-session-expires-negative':
        return finish(
          '200-expires-negative',
          jsonResponse(200, {
            ...this.account(),
            session: { ...this.mint(0), expiresAt: -1 },
          }),
        );
      case 'ok-huge-body': {
        const padding: Record<string, string> = {};
        for (let i = 0; i < 20_000; i += 1) padding[`k${i}`] = 'x'.repeat(40);
        return finish(
          '200-huge',
          jsonResponse(200, {
            ...this.account(),
            session: this.mint(3600),
            padding,
          }),
        );
      }
      case 'ok-error-envelope':
        return finish(
          '200-with-error-envelope',
          jsonResponse(200, {
            ...this.account(),
            session: this.mint(3600),
            error: { message: 'ignore me' },
          }),
        );
      case 'ok-onboarding-pending':
        return finish(
          '200-pending',
          jsonResponse(200, {
            ...this.account('pending'),
            session: this.mint(3600),
          }),
        );
      case 'html-200':
        return finish(
          '200-html',
          rawResponse(200, '<html><body>captive portal</body></html>'),
        );
      case 'json-null-200':
        return finish('200-null', jsonResponse(200, null));
      case 'empty-body-200':
        return finish('200-empty', rawResponse(200, '', 'application/json'));
      case 'truncated-json-200':
        return finish(
          '200-truncated',
          rawResponse(200, '{"user":{"id":"3f25', 'application/json'),
        );
      case 'user-missing-id':
        return finish(
          '200-user-missing-id',
          jsonResponse(200, {
            user: { email: 'pat@example.test' },
            onboardingState: 'complete',
            session: this.mint(3600),
          }),
        );
      case 'user-id-not-uuid':
        return finish(
          '200-user-id-not-uuid',
          jsonResponse(200, {
            user: { id: 'not-a-uuid', email: null },
            onboardingState: 'complete',
            session: this.mint(3600),
          }),
        );
      case 'onboarding-state-bogus':
        return finish(
          '200-onboarding-bogus',
          jsonResponse(200, {
            user: { id: CANONICAL_ID, email: null },
            onboardingState: 'maybe',
            session: this.mint(3600),
          }),
        );
      case 'status-401':
        return finish(
          '401',
          jsonResponse(401, { error: { message: 'token rejected' } }),
        );
      case 'status-403':
        return finish(
          '403',
          jsonResponse(403, { error: { message: 'forbidden' } }),
        );
      case 'status-429':
        return finish(
          '429',
          jsonResponse(429, { error: { message: 'slow down' } }),
        );
      case 'status-404':
        return finish(
          '404',
          jsonResponse(404, { error: { message: 'not found' } }),
        );
      case 'status-500':
        return finish('500', jsonResponse(500, { error: { message: 'boom' } }));
      case 'status-503-html':
        return finish('503-html', rawResponse(503, '<h1>503</h1>'));
      case 'json-rejects': {
        const response = jsonResponse(200, this.account());
        Object.defineProperty(response, 'json', {
          value: () =>
            Promise.reject(new Error('body decode failed (simulated)')),
        });
        return finish('200-json-rejects', response);
      }
      default:
        return finish(
          '200',
          jsonResponse(200, { ...this.account(), session: this.mint(3600) }),
        );
    }
  }

  private async handleMe(
    call: ServerCall,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    switch (this.me) {
      case 'hang':
        // Real RN fetch honours AbortSignal: the stall ends when the caller
        // aborts (onboarding.ts request() aborts at 15s).
        await this.abortable(10 * 60_000, signal);
        call.outcome = 'hang-elapsed';
        return rawResponse(599, null);
      case 'status-500':
        call.outcome = '500';
        return jsonResponse(500, { error: { message: 'profile store down' } });
      case 'malformed':
        call.outcome = '200-malformed';
        return rawResponse(200, '<html>', 'text/html');
      case 'pending':
        call.outcome = '200-pending';
        return jsonResponse(200, { onboardingState: 'pending', profile: null });
      default:
        call.outcome = '200';
        return jsonResponse(200, {
          onboardingState: 'complete',
          profile: {
            skill_level: 'intermediate',
            handedness: 'right',
            primary_goal: 'consistency',
            biggest_problem: 'popups',
          },
        });
    }
  }

  private async handleRefresh(
    call: ServerCall,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> {
    switch (this.refresh) {
      case 'hang':
        await this.abortable(10 * 60_000, signal);
        call.outcome = 'hang-elapsed';
        return rawResponse(599, null);
      case 'status-401':
        call.outcome = '401';
        return jsonResponse(401, { error: { message: 'revoked' } });
      case 'status-500':
        call.outcome = '500';
        return jsonResponse(500, { error: { message: 'boom' } });
      default: {
        const tokens = this.mint(3600);
        call.outcome = '200-rotated';
        return jsonResponse(200, { session: tokens });
      }
    }
  }
}

// ─── Notification permissions (SchedulerPort) ────────────────────────────────

export type PermissionFault =
  | 'ok'
  | 'denied'
  | 'reject'
  | 'throw-sync'
  | 'hang'
  | 'malformed'
  | 'cancel-all-rejects'
  | 'apply-plan-rejects';

export const PERMISSION_FAULTS: readonly PermissionFault[] = [
  'ok',
  'denied',
  'reject',
  'throw-sync',
  'hang',
  'malformed',
  'cancel-all-rejects',
  'apply-plan-rejects',
];

export class FaultyScheduler implements SchedulerPort {
  fault: PermissionFault = 'ok';
  permissionCalls = 0;
  cancelAllCalls = 0;
  applied: PlannedNotification[][] = [];

  permissionState(): Promise<PermissionState> {
    this.permissionCalls += 1;
    switch (this.fault) {
      case 'denied':
        return Promise.resolve('denied');
      case 'reject':
        return Promise.reject(new Error('UNNotificationCenter unavailable'));
      case 'throw-sync':
        throw new Error('permission query threw synchronously');
      case 'hang':
        return never();
      case 'malformed':
        return Promise.resolve('bogus' as unknown as PermissionState);
      default:
        return Promise.resolve('granted');
    }
  }
  requestPermission(): Promise<PermissionState> {
    return this.permissionState();
  }
  applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    if (this.fault === 'apply-plan-rejects') {
      return Promise.reject(new Error('scheduling failed'));
    }
    this.applied.push([...plan]);
    return Promise.resolve();
  }
  cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
    if (this.fault === 'cancel-all-rejects') {
      return Promise.reject(new Error('cancel failed'));
    }
    return Promise.resolve();
  }
  openSystemSettings(): Promise<void> {
    return Promise.resolve();
  }
}

// ─── RevenueCat ──────────────────────────────────────────────────────────────

export type RevenueCatFault =
  'ok' | 'client-construct-throws' | 'sdk-import-throws';
export const REVENUECAT_FAULTS: readonly RevenueCatFault[] = [
  'ok',
  'client-construct-throws',
  'sdk-import-throws',
];

// ─── Runtime config ──────────────────────────────────────────────────────────

export type ConfigFault =
  | 'ok'
  | 'api-null'
  | 'api-http-remote'
  | 'api-garbage'
  | 'google-web-client-null';
export const CONFIG_FAULTS: readonly ConfigFault[] = [
  'ok',
  'api-null',
  'api-http-remote',
  'api-garbage',
  'google-web-client-null',
];

export function apiBaseUrlFor(fault: ConfigFault): string | null {
  switch (fault) {
    case 'api-null':
      return null;
    case 'api-http-remote':
      return 'http://api.example.test';
    case 'api-garbage':
      return 'not a url at all';
    default:
      return API_BASE;
  }
}

// ─── Clock ───────────────────────────────────────────────────────────────────

export type ClockFault =
  | 'now'
  | 'device-1999'
  | 'device-2099'
  | 'server-skew-plus-1d'
  | 'server-skew-minus-1d'
  | 'jump-forward-1h-mid-flight'
  | 'jump-back-1h-mid-flight';
export const CLOCK_FAULTS: readonly ClockFault[] = [
  'now',
  'device-1999',
  'device-2099',
  'server-skew-plus-1d',
  'server-skew-minus-1d',
  'jump-forward-1h-mid-flight',
  'jump-back-1h-mid-flight',
];

// ─── Navigation perturbations ────────────────────────────────────────────────

export type NavFault =
  | 'none'
  | 'back-during-busy'
  | 'back-reenter-during-busy'
  | 'double-tap'
  | 'tap-other-provider-during-busy'
  | 'remount-storm-before-tap'
  | 'unmount-app-during-busy';
export const NAV_FAULTS: readonly NavFault[] = [
  'none',
  'back-during-busy',
  'back-reenter-during-busy',
  'double-tap',
  'tap-other-provider-during-busy',
  'remount-storm-before-tap',
  'unmount-app-during-busy',
];
