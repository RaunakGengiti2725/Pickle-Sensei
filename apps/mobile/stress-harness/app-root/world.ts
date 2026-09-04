import type { LocalDb } from '../../src/data/db';
import type {
  PermissionState,
  SchedulerPort,
} from '../../src/notifications/service';
import type { PlannedNotification } from '../../src/notifications/types';

/**
 * Fault-injectable stand-ins for every dependency the app root (App.tsx Gate
 * + index.js) touches during a cold or warm launch. One `FaultWorld` is the
 * single source of truth for the active faults; the jest module mocks in the
 * stress suites read it lazily on every call, so a scenario can flip a
 * dependency from broken to healthy mid-run (the "recovery" phase) without
 * re-mocking anything.
 *
 * Every fake counts how often a fault actually FIRED (`hits`) so the row
 * table can distinguish "the fault was configured" from "the fault was
 * exercised by the launch path".
 */

export const DEPENDENCIES = [
  'keychain',
  'sqlite',
  'api-refresh',
  'api-me',
  'api-bootstrap',
  'google-sdk',
  'notifications',
  'permissions',
  'clock',
  'navigation',
  'billing',
  'config',
] as const;
export type Dependency = (typeof DEPENDENCIES)[number];

/** Generic fault verbs shared by the I/O dependencies. */
export const IO_MODES = [
  'throw',
  'reject',
  'hang',
  'slow',
  'timeout',
  'malformed',
  'partial',
] as const;
export type IoMode = (typeof IO_MODES)[number];

/** HTTP-only verbs. */
export const HTTP_MODES = [
  'refuse-401',
  'refuse-403',
  'status-500',
  'status-429',
] as const;
export type HttpMode = (typeof HTTP_MODES)[number];

export const CLOCK_MODES = [
  'device-behind-1y',
  'device-ahead-1y',
  'expires-past',
  'expires-zero',
  'expires-string',
  'expires-missing',
  'expires-huge',
] as const;
export type ClockMode = (typeof CLOCK_MODES)[number];

export const NAVIGATION_MODES = [
  'throw',
  'throw-once',
  'effect-throw-once',
  'reject',
] as const;
export type NavigationMode = (typeof NAVIGATION_MODES)[number];

export const BILLING_MODES = ['throw', 'malformed'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const CONFIG_MODES = ['throw', 'malformed', 'partial'] as const;
export type ConfigMode = (typeof CONFIG_MODES)[number];

export const PERMISSION_MODES = [
  ...IO_MODES,
  'denied',
  'undetermined',
] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type SqliteScope = 'open' | 'all' | 'kv-read' | 'kv-write' | 'shots';
export const SQLITE_SCOPES: readonly SqliteScope[] = [
  'open',
  'all',
  'kv-read',
  'kv-write',
  'shots',
];

export type FaultMode =
  | IoMode
  | HttpMode
  | ClockMode
  | NavigationMode
  | BillingMode
  | ConfigMode
  | PermissionMode;

export interface Fault {
  dep: Dependency;
  mode: FaultMode;
  /** Dependency-specific refinement (sqlite scope, malformed flavour…). */
  detail?: string;
}

export const MODES_FOR: Record<Dependency, readonly FaultMode[]> = {
  keychain: IO_MODES,
  sqlite: IO_MODES,
  'api-refresh': [...IO_MODES, ...HTTP_MODES],
  'api-me': [...IO_MODES, ...HTTP_MODES],
  'api-bootstrap': [...IO_MODES, ...HTTP_MODES],
  'google-sdk': IO_MODES,
  notifications: IO_MODES,
  permissions: PERMISSION_MODES,
  clock: CLOCK_MODES,
  navigation: NAVIGATION_MODES,
  billing: BILLING_MODES,
  config: CONFIG_MODES,
};

export const SLOW_MS = 3_000;
/** Longer than every client deadline (8s launch wait, 15s fetch abort). */
export const TIMEOUT_MS = 20_000;

export const CANONICAL_ID = '7fc2c743-028f-4ec6-942c-a84508f3be38';
export const VALID_PROFILE = {
  skillLevel: 'intermediate',
  handedness: 'right',
  goal: 'consistency',
  biggestProblem: 'pop_ups',
  focusCheckpoint: 'contact',
};

export class FaultWorld {
  private faults = new Map<Dependency, Fault>();
  readonly hits: Record<string, number> = {};
  private hung: (() => void)[] = [];
  /** Wall-clock (fake-timer) delay helper; injected by the suite. */
  slowMs = SLOW_MS;
  timeoutMs = TIMEOUT_MS;

  set(fault: Fault): void {
    this.faults.set(fault.dep, fault);
  }

  get(dep: Dependency): Fault | undefined {
    return this.faults.get(dep);
  }

  active(): Fault[] {
    return [...this.faults.values()];
  }

  /** Clears every fault and lets every hung call finally answer. */
  heal(): void {
    this.faults.clear();
    const hung = this.hung;
    this.hung = [];
    for (const release of hung) release();
  }

  hit(dep: Dependency, what: string): void {
    const key = `${dep}:${what}`;
    this.hits[key] = (this.hits[key] ?? 0) + 1;
  }

  /** Resolves only when the world is healed (a dependency that answers late). */
  hang(signal?: AbortSignal | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.hung.push(resolve);
      if (signal) {
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' })),
        );
      }
    });
  }

  delay(ms: number, signal?: AbortSignal | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
        });
      }
    });
  }

  /**
   * Applies the generic I/O verbs for `dep` around a healthy operation.
   * Returns `undefined` for verbs the caller must implement itself
   * (`malformed`, `partial`) so each fake decides what "malformed" means.
   */
  async ioGate(
    dep: Dependency,
    what: string,
    signal?: AbortSignal | null,
  ): Promise<'healthy' | 'malformed' | 'partial'> {
    const fault = this.faults.get(dep);
    if (!fault) return 'healthy';
    switch (fault.mode) {
      case 'throw':
        this.hit(dep, `${what}:throw`);
        throw new Error(`${dep} ${what} threw (injected)`);
      case 'reject':
        this.hit(dep, `${what}:reject`);
        return Promise.reject(new Error(`${dep} ${what} rejected (injected)`));
      case 'hang':
        this.hit(dep, `${what}:hang`);
        await this.hang(signal);
        return 'healthy';
      case 'slow':
        this.hit(dep, `${what}:slow`);
        await this.delay(this.slowMs, signal);
        return 'healthy';
      case 'timeout':
        this.hit(dep, `${what}:timeout`);
        await this.delay(this.timeoutMs, signal);
        return 'healthy';
      case 'malformed':
        this.hit(dep, `${what}:malformed`);
        return 'malformed';
      case 'partial':
        this.hit(dep, `${what}:partial`);
        return 'partial';
      default:
        return 'healthy';
    }
  }

  /** Synchronous variant for dependencies that are called without await. */
  syncGate(dep: Dependency, what: string): Fault | undefined {
    const fault = this.faults.get(dep);
    if (fault) this.hit(dep, `${what}:${fault.mode}`);
    return fault;
  }
}

// ─── Keychain ────────────────────────────────────────────────────────────────

export interface VaultRecord {
  version: 1;
  provider: 'apple' | 'google';
  canonicalAppUserId: string;
  refreshToken: string;
  providerEmail: string | null;
  displayName: string | null;
}

export function validVault(refreshToken = 'refresh-seeded'): VaultRecord {
  return {
    version: 1,
    provider: 'apple',
    canonicalAppUserId: CANONICAL_ID,
    refreshToken,
    providerEmail: 'player@example.com',
    displayName: 'Pat',
  };
}

export class FakeKeychain {
  stored: string | null = null;
  readonly log: string[] = [];
  constructor(private readonly world: FaultWorld) {}

  module() {
    return {
      ACCESSIBLE: { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afu-tdo' },
      getGenericPassword: (_options?: unknown) => {
        this.log.push('get');
        const fault = this.world.get('keychain');
        if (fault?.mode === 'throw') {
          this.world.hit('keychain', 'get:throw');
          throw new Error('Keychain getGenericPassword threw (injected)');
        }
        return this.read();
      },
      setGenericPassword: (_u: string, password: string, _o?: unknown) => {
        this.log.push('set');
        const fault = this.world.get('keychain');
        if (fault?.mode === 'throw') {
          this.world.hit('keychain', 'set:throw');
          throw new Error('Keychain setGenericPassword threw (injected)');
        }
        return this.write(password);
      },
      resetGenericPassword: (_o?: unknown) => {
        this.log.push('reset');
        const fault = this.world.get('keychain');
        if (fault?.mode === 'throw') {
          this.world.hit('keychain', 'reset:throw');
          throw new Error('Keychain resetGenericPassword threw (injected)');
        }
        return this.reset();
      },
    };
  }

  private async read(): Promise<
    false | { username: string; password: string }
  > {
    const outcome = await this.world.ioGate('keychain', 'get');
    if (outcome === 'malformed') {
      return { username: 'session', password: '\u0000{not json' };
    }
    if (outcome === 'partial') {
      const partial = this.stored
        ? this.stored.slice(0, Math.floor(this.stored.length / 2))
        : '{"version":1';
      return { username: 'session', password: partial };
    }
    if (this.stored === null) return false;
    return { username: 'session', password: this.stored };
  }

  private async write(password: string): Promise<boolean> {
    const outcome = await this.world.ioGate('keychain', 'set');
    if (outcome === 'partial') {
      this.stored = password.slice(0, Math.floor(password.length / 2));
      return true;
    }
    if (outcome === 'malformed') return false;
    this.stored = password;
    return true;
  }

  private async reset(): Promise<boolean> {
    await this.world.ioGate('keychain', 'reset');
    this.stored = null;
    return true;
  }
}

// ─── SQLite ──────────────────────────────────────────────────────────────────

export class StressDb {
  readonly kv = new Map<string, string>();
  readonly shots: { ownerKey: string; id: string; payload: string }[] = [];
  readonly statements: { sql: string; params: unknown[] }[] = [];
  private readonly faultedWriteKeys: string[] = [];
  private readonly faultedReadKeys: string[] = [];
  private partialWriteToggle = false;
  constructor(private readonly world: FaultWorld) {}

  /** kv keys whose write went through an armed sqlite fault. */
  kvWriteFailures(): string[] {
    return [...this.faultedWriteKeys];
  }

  /** kv keys whose read went through an armed sqlite fault. */
  kvReadFailures(): string[] {
    return [...this.faultedReadKeys];
  }

  seedShots(ownerKey: string, count: number): void {
    for (let i = 0; i < count; i += 1) {
      const id = `shot-${ownerKey}-${i}`;
      this.shots.push({ ownerKey, id, payload: JSON.stringify({ id }) });
    }
  }

  shotFingerprint(): string {
    return JSON.stringify(
      [...this.shots]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(shot => [shot.ownerKey, shot.id, shot.payload]),
    );
  }

  destructiveStatements(): string[] {
    return this.statements
      .map(entry => entry.sql)
      .filter(
        sql =>
          /^(DELETE|DROP|UPDATE|ALTER|TRUNCATE)\b/i.test(sql) ||
          /INTO\s+local_shot\b/i.test(sql),
      );
  }

  kvWrites(): { key: string; value: string }[] {
    return this.statements
      .filter(entry => entry.sql.startsWith('INSERT OR REPLACE INTO kv'))
      .map(entry => ({
        key: String(entry.params[0]),
        value: String(entry.params[1]),
      }));
  }

  private scope(): SqliteScope | null {
    const fault = this.world.get('sqlite');
    if (!fault) return null;
    return (fault.detail as SqliteScope | undefined) ?? 'all';
  }

  /** getDb() — throws when the open/migration scope is faulted. */
  open(): LocalDb {
    const fault = this.world.get('sqlite');
    if (fault && this.scope() === 'open') {
      this.world.hit('sqlite', `open:${fault.mode}`);
      throw new Error(`SQLite open failed: ${fault.mode} (injected)`);
    }
    return {
      execute: (sql, params) => this.execute(sql, params ?? []),
      close: () => undefined,
    };
  }

  private async execute(
    sql: string,
    params: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }> {
    const statement = sql.trim().replace(/\s+/g, ' ');
    this.statements.push({ sql: statement, params });
    const isKvRead = statement.startsWith('SELECT value FROM kv');
    const isKvWrite = statement.startsWith('INSERT OR REPLACE INTO kv');
    const isShots =
      /local_shot|training|shot/i.test(statement) && !isKvRead && !isKvWrite;
    const scope = this.scope();
    const applies =
      scope === 'all' ||
      (scope === 'kv-read' && isKvRead) ||
      (scope === 'kv-write' && isKvWrite) ||
      (scope === 'shots' && isShots);
    let outcome: 'healthy' | 'malformed' | 'partial' = 'healthy';
    if (applies && isKvWrite) this.faultedWriteKeys.push(String(params[0]));
    if (applies && isKvRead) this.faultedReadKeys.push(String(params[0]));
    if (applies)
      outcome = await this.world.ioGate(
        'sqlite',
        isKvRead ? 'kv-read' : isKvWrite ? 'kv-write' : 'sql',
      );

    if (isKvRead) {
      const key = String(params[0]);
      const value = this.kv.get(key);
      if (outcome === 'malformed') {
        return {
          rows: [
            {
              value:
                value === undefined
                  ? '\u0000<html>'
                  : '\u0000' + value.slice(1),
            },
          ],
        };
      }
      if (outcome === 'partial') {
        // Driver returns an incomplete row: half of the value, or a row
        // without a value column. Persisted bytes are untouched.
        return {
          rows:
            value === undefined
              ? [{ other: 1 }]
              : [
                  {
                    value: value.slice(
                      0,
                      Math.max(1, Math.floor(value.length / 2)),
                    ),
                  },
                ],
        };
      }
      return { rows: value === undefined ? [] : [{ value }] };
    }
    if (isKvWrite) {
      const key = String(params[0]);
      const value = String(params[1]);
      if (outcome === 'partial') {
        // A multi-key write sequence that only half lands (crash between
        // statements): every other acknowledged write is dropped. Statements
        // themselves stay atomic — SQLite never tears a single value.
        this.partialWriteToggle = !this.partialWriteToggle;
        if (this.partialWriteToggle) this.kv.set(key, value);
        return { rows: [] };
      }
      if (outcome === 'malformed') return { rows: [] }; // write silently dropped
      this.kv.set(key, value);
      return { rows: [] };
    }
    if (/^DELETE FROM kv WHERE key/.test(statement)) {
      for (const param of params) this.kv.delete(String(param));
      return { rows: [] };
    }
    if (/FROM local_shot WHERE owner_key = \?/.test(statement)) {
      if (outcome === 'malformed') return { rows: [{ id: null, payload: 12 }] };
      if (outcome === 'partial') return { rows: [{}] };
      const owner = String(params[0]);
      return {
        rows: this.shots
          .filter(shot => shot.ownerKey === owner)
          .map(shot => ({
            id: shot.id,
            session_id: null,
            shot_type: 'forehand_drive',
            captured_at: '2026-01-01T00:00:00.000Z',
            overall_score: 7,
            confidence: 0.9,
            result_kind: 'scored',
            source: 'real',
            favorite: 0,
            payload: shot.payload,
          })),
      };
    }
    if (/^DELETE FROM (\w+) WHERE owner_key = \?/.test(statement)) {
      const table = /^DELETE FROM (\w+)/.exec(statement)?.[1];
      if (table === 'local_shot') {
        const owner = String(params[0]);
        for (let i = this.shots.length - 1; i >= 0; i -= 1) {
          if (this.shots[i]?.ownerKey === owner) this.shots.splice(i, 1);
        }
      }
      return { rows: [] };
    }
    return { rows: [] };
  }
}

// ─── Notification scheduler + permissions ────────────────────────────────────

export class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  applied: (readonly PlannedNotification[])[] = [];
  cancels = 0;
  constructor(private readonly world: FaultWorld) {}

  private async permissionGate(what: string): Promise<PermissionState> {
    const fault = this.world.get('permissions');
    if (fault?.mode === 'denied') {
      this.world.hit('permissions', `${what}:denied`);
      return 'denied';
    }
    if (fault?.mode === 'undetermined') {
      this.world.hit('permissions', `${what}:undetermined`);
      return 'undetermined';
    }
    const outcome = await this.world.ioGate('permissions', what);
    if (outcome === 'malformed')
      return 'authorized-ish' as unknown as PermissionState;
    if (outcome === 'partial') return undefined as unknown as PermissionState;
    return this.permission;
  }

  permissionState(): Promise<PermissionState> {
    return this.permissionGate('permissionState');
  }

  requestPermission(): Promise<PermissionState> {
    return this.permissionGate('requestPermission');
  }

  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    const outcome = await this.world.ioGate('notifications', 'applyPlan');
    if (outcome === 'partial') {
      this.applied = [
        ...this.applied,
        plan.slice(0, Math.floor(plan.length / 2)),
      ];
      throw new Error('applyPlan partially applied (injected)');
    }
    if (outcome === 'malformed') return; // reports success, schedules nothing
    this.applied = [...this.applied, plan];
  }

  async cancelAllPlanned(): Promise<void> {
    const outcome = await this.world.ioGate(
      'notifications',
      'cancelAllPlanned',
    );
    if (outcome === 'malformed') return; // reports success, cancels nothing
    this.cancels += 1;
    if (outcome === 'partial') {
      throw new Error(
        'cancelAllPlanned failed after cancelling some (injected)',
      );
    }
  }

  async openSystemSettings(): Promise<void> {
    await this.world.ioGate('notifications', 'openSystemSettings');
  }
}

// ─── Scripted API server ─────────────────────────────────────────────────────

export interface ServerCall {
  atMs: number;
  route: string;
  mode: string;
  refreshToken?: string;
}

interface ResponseInit {
  status: number;
  body: unknown;
  rawBody?: string;
}

export class ScriptedServer {
  readonly calls: ServerCall[] = [];
  readonly issuedRefreshTokens = new Set<string>(['refresh-seeded']);
  readonly issuedAccessTokens = new Set<string>();
  private counter = 0;
  /** Whether the seeded refresh token was refused by a 401/403. */
  refused = false;
  /**
   * Harness safety valve: a client that re-arms its refresh every millisecond
   * would otherwise run ~60k round trips per advanced minute (tens of seconds
   * of wall time per scenario). Past this many refresh calls the server stops
   * answering; the row records `stormAborted` and the `noRefreshStorm`
   * invariant has failed long before the cap.
   */
  static readonly REFRESH_STORM_CAP = 200;
  stormAborted = false;
  private refreshCalls = 0;
  bearerTtlSec = 3600;
  hasServerProfile = true;
  constructor(private readonly world: FaultWorld) {}

  private expiresAtSeconds(): unknown {
    const clock = this.world.get('clock');
    const nowSec = Math.floor(Date.now() / 1000);
    switch (clock?.mode) {
      case 'expires-past':
        this.world.hit('clock', 'expires-past');
        return nowSec - 600;
      case 'expires-zero':
        this.world.hit('clock', 'expires-zero');
        return 0;
      case 'expires-string':
        this.world.hit('clock', 'expires-string');
        return 'soon';
      case 'expires-missing':
        this.world.hit('clock', 'expires-missing');
        return undefined;
      case 'expires-huge':
        this.world.hit('clock', 'expires-huge');
        return 1e15;
      case 'device-behind-1y':
        this.world.hit('clock', 'device-behind-1y');
        return nowSec + 365 * 86_400 + this.bearerTtlSec;
      case 'device-ahead-1y':
        this.world.hit('clock', 'device-ahead-1y');
        return nowSec - 365 * 86_400 + this.bearerTtlSec;
      default:
        return nowSec + this.bearerTtlSec;
    }
  }

  private issueSession(): Record<string, unknown> {
    this.counter += 1;
    const accessToken = `access-${this.counter}`;
    const refreshToken = `refresh-${this.counter}`;
    this.issuedAccessTokens.add(accessToken);
    this.issuedRefreshTokens.add(refreshToken);
    const expiresAt = this.expiresAtSeconds();
    return {
      accessToken,
      refreshToken,
      ...(expiresAt === undefined ? {} : { expiresAt }),
    };
  }

  private meBody(): unknown {
    return {
      user: { id: CANONICAL_ID, email: 'player@example.com' },
      onboardingState: this.hasServerProfile ? 'complete' : 'pending',
      profile: this.hasServerProfile
        ? {
            skill_level: VALID_PROFILE.skillLevel,
            handedness: VALID_PROFILE.handedness,
            primary_goal: VALID_PROFILE.goal,
            biggest_problem: VALID_PROFILE.biggestProblem,
          }
        : null,
    };
  }

  fetch = async (
    input: string,
    init?: { body?: string; signal?: AbortSignal },
  ): Promise<Response> => {
    const url = String(input);
    const route = url.includes('/v1/auth/refresh')
      ? 'refresh'
      : url.includes('/v1/account/bootstrap')
        ? 'bootstrap'
        : url.includes('/v1/me')
          ? 'me'
          : 'other';
    const dep: Dependency =
      route === 'refresh'
        ? 'api-refresh'
        : route === 'bootstrap'
          ? 'api-bootstrap'
          : 'api-me';
    const fault = this.world.get(dep);
    let refreshToken: string | undefined;
    if (route === 'refresh') {
      try {
        refreshToken = (
          JSON.parse(init?.body ?? '{}') as { refreshToken?: string }
        ).refreshToken;
      } catch {
        refreshToken = undefined;
      }
    }
    this.calls.push({
      atMs: Date.now(),
      route,
      mode: fault?.mode ?? 'ok',
      refreshToken,
    });
    if (route === 'refresh') {
      this.refreshCalls += 1;
      if (this.refreshCalls > ScriptedServer.REFRESH_STORM_CAP) {
        this.stormAborted = true;
        return new Promise<Response>(() => undefined);
      }
    }
    if (
      route === 'refresh' &&
      refreshToken !== undefined &&
      !this.issuedRefreshTokens.has(refreshToken)
    ) {
      // A token this server never issued is always refused, fault or not.
      this.refused = true;
      return respond({
        status: 401,
        body: { error: { code: 'auth.invalid' } },
      });
    }
    if (fault) {
      switch (fault.mode) {
        case 'refuse-401':
        case 'refuse-403': {
          this.world.hit(dep, fault.mode);
          if (route === 'refresh') this.refused = true;
          return respond({
            status: fault.mode === 'refuse-401' ? 401 : 403,
            body: { error: { code: 'auth.refused' } },
          });
        }
        case 'status-500':
          this.world.hit(dep, fault.mode);
          return respond({
            status: 500,
            body: { error: { code: 'internal' } },
          });
        case 'status-429':
          this.world.hit(dep, fault.mode);
          return respond({
            status: 429,
            body: { error: { code: 'rate_limited' } },
          });
        default:
          break;
      }
    }
    if (fault?.mode === 'throw') {
      this.world.hit(dep, 'fetch:throw');
      throw new TypeError('fetch threw synchronously (injected)');
    }
    const outcome = await this.world.ioGate(dep, 'fetch', init?.signal);
    if (route === 'refresh') {
      if (outcome === 'malformed')
        return respond({
          status: 200,
          body: null,
          rawBody: '<html>upstream error</html>',
        });
      const session = this.issueSession();
      if (outcome === 'partial') delete session['refreshToken'];
      return respond({ status: 200, body: { session } });
    }
    if (route === 'bootstrap') {
      if (outcome === 'malformed')
        return respond({ status: 200, body: { user: { id: 'nope' } } });
      const body = this.meBody() as Record<string, unknown>;
      if (outcome === 'partial')
        return respond({
          status: 200,
          body: { user: body['user'], onboardingState: 'complete' },
        });
      return respond({
        status: 200,
        body: { ...body, session: this.issueSession() },
      });
    }
    if (route === 'me') {
      if (outcome === 'malformed')
        return respond({
          status: 200,
          body: null,
          rawBody: '<html>cdn</html>',
        });
      const body = this.meBody() as Record<string, unknown>;
      if (outcome === 'partial') {
        return respond({
          status: 200,
          body: { ...body, profile: { skill_level: 'intermediate' } },
        });
      }
      return respond({ status: 200, body });
    }
    return respond({ status: 404, body: { error: { code: 'not_found' } } });
  };
}

function respond(init: ResponseInit): Response {
  const raw = init.rawBody ?? JSON.stringify(init.body);
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    headers: { get: () => null },
    json: async () => JSON.parse(raw) as unknown,
    text: async () => raw,
  } as unknown as Response;
}
