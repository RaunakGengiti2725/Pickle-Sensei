/**
 * Shared, pure helpers for the `journey-signin-restore` adversarial harness
 * (no jest.mock here — every suite declares its own module seams so hoisting
 * stays local to the test file).
 *
 *  - `Prng`: seeded, replayable randomness (mulberry32) — every scenario
 *    records its seed so a failure can be re-run bit-for-bit.
 *  - `FakeAuthServer`: a stateful stand-in for the Edge Function's session
 *    routes (`/v1/account/bootstrap`, `/v1/auth/refresh`, `/v1/auth/logout`)
 *    with real rotation + `scope=local` revocation semantics and per-route
 *    fault injection (status codes, dead network, hangs, malformed bodies,
 *    delays) — installed as `globalThis.fetch`.
 *  - Secret material is minted with `SECRET_<KIND>_` prefixes so a single
 *    substring scan proves "no access / provider token anywhere durable" and
 *    "exactly the current refresh token in the vault".
 *  - `writeArtifact`: raw JSON evidence under `artifacts/xc-journey-signin-
 *    restore/` (or `$XC_ARTIFACT_DIR`).
 */
// The mobile tsconfig has no node types; reach node the way the other
// __tests__ do (typed `require`, ambient declarations).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage: () => {
    heapUsed: number;
    heapTotal: number;
    rss: number;
    external: number;
  };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Seeded randomness ───────────────────────────────────────────────────────

export class Prng {
  private state: number;

  constructor(readonly seed: number) {
    this.state = seed >>> 0;
  }

  /** [0, 1) */
  next(): number {
    let t = (this.state += 0x6d2b79f5) >>> 0;
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

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  hex(bytes: number): string {
    let out = '';
    for (let i = 0; i < bytes; i += 1) {
      out += this.int(256).toString(16).padStart(2, '0');
    }
    return out;
  }
}

// ─── Secret material ─────────────────────────────────────────────────────────

export const SECRET_PREFIX = 'SECRET_';
export const ACCESS_PREFIX = 'SECRET_ACCESS_';
export const REFRESH_PREFIX = 'SECRET_REFRESH_';
export const ID_TOKEN_PREFIX = 'SECRET_IDTOKEN_';
export const APPLE_CODE_PREFIX = 'SECRET_APPLECODE_';

/** Every SECRET_* token (any kind) found in a serialized blob. */
export function findSecrets(blob: string): string[] {
  const found = blob.match(/SECRET_[A-Z]+_[A-Za-z0-9-]+/g) ?? [];
  return [...new Set(found)].sort();
}

export function secretsOfKind(blob: string, prefix: string): string[] {
  return findSecrets(blob).filter(token => token.startsWith(prefix));
}

// ─── Fake session server ─────────────────────────────────────────────────────

export type Fault =
  | { kind: 'status'; status: number; body?: unknown }
  | { kind: 'network' }
  | { kind: 'hang' }
  | { kind: 'malformed'; status?: number }
  | { kind: 'delay'; ms: number };

export type Route = 'bootstrap' | 'refresh' | 'logout';

export interface ServerSession {
  sessionId: string;
  userId: string;
  device: string;
  accessToken: string;
  refreshToken: string;
  /** seconds since epoch, like Supabase `expires_at` */
  expiresAt: number;
  /** Refresh tokens this session already rotated away from. */
  spentRefreshTokens: string[];
  revokedAt: number | null;
}

export interface ServerCall {
  n: number;
  route: Route | 'unknown';
  url: string;
  method: string;
  authorization: string | null;
  body: unknown;
  outcome: string;
  atMs: number;
}

export interface FakeAuthServerOptions {
  prng: Prng;
  baseUrl: string;
  /** Access-token lifetime in seconds (Supabase default is 3600). */
  accessLifetimeSeconds?: number;
  now?: () => number;
}

/**
 * Behaves like the Edge Function + GoTrue for the session routes:
 *  - bootstrap verifies the provider bearer (must be an ID token this server
 *    issued to the "provider"), mints ONE new session per call;
 *  - refresh rotates: the presented refresh token must be the session's
 *    CURRENT one; a spent, unknown or revoked token → 401;
 *  - logout revokes only the session whose access token is the bearer
 *    (scope=local); an unknown/expired bearer → 401 (as `authenticate()` does).
 */
export class FakeAuthServer {
  readonly calls: ServerCall[] = [];
  readonly sessions = new Map<string, ServerSession>();
  private readonly faults: Record<Route, Fault[]> = {
    bootstrap: [],
    refresh: [],
    logout: [],
  };
  private readonly validIdTokens = new Set<string>();
  private readonly validAppleCodes = new Set<string>();
  readonly accounts = new Map<string, { userId: string; email: string }>();
  private counter = 0;
  readonly baseUrl: string;
  readonly prng: Prng;
  readonly accessLifetimeSeconds: number;
  readonly now: () => number;
  /** Refresh attempts with a token that had already been rotated away. */
  reusedRefreshTokens: string[] = [];
  /** Requests parked by a 'delay' fault that have not dispatched yet. */
  private pendingDelays = new Set<Promise<void>>();
  /** Lets a test hold a hung request and finish it later. */
  pendingHangs: Array<{
    route: Route;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }> = [];

  constructor(options: FakeAuthServerOptions) {
    this.prng = options.prng;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.accessLifetimeSeconds = options.accessLifetimeSeconds ?? 3600;
    // Resolved per call so jest fake timers / setSystemTime installed after
    // construction are honoured.
    this.now = options.now ?? (() => Date.now());
  }

  queueFault(route: Route, ...faults: Fault[]): void {
    this.faults[route].push(...faults);
  }

  clearFaults(): void {
    for (const route of Object.keys(this.faults) as Route[]) {
      this.faults[route].length = 0;
    }
  }

  /** A provider ID token the "provider SDK" would hand the app. */
  issueIdToken(provider: 'apple' | 'google', subject: string): string {
    const token = `${ID_TOKEN_PREFIX}${provider}-${subject}-${this.prng.hex(8)}`;
    this.validIdTokens.add(token);
    return token;
  }

  issueAppleAuthorizationCode(): string {
    const code = `${APPLE_CODE_PREFIX}${this.prng.hex(8)}`;
    this.validAppleCodes.add(code);
    return code;
  }

  registerAccount(subject: string, userId: string, email: string): void {
    this.accounts.set(subject, { userId, email });
  }

  private mintSession(userId: string, device: string): ServerSession {
    this.counter += 1;
    const session: ServerSession = {
      sessionId: `sess-${this.counter}-${this.prng.hex(4)}`,
      userId,
      device,
      accessToken: `${ACCESS_PREFIX}${this.counter}-${this.prng.hex(8)}`,
      refreshToken: `${REFRESH_PREFIX}${this.counter}-${this.prng.hex(8)}`,
      expiresAt: Math.floor(this.now() / 1000) + this.accessLifetimeSeconds,
      spentRefreshTokens: [],
      revokedAt: null,
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  private rotate(session: ServerSession): void {
    this.counter += 1;
    session.spentRefreshTokens.push(session.refreshToken);
    session.accessToken = `${ACCESS_PREFIX}${this.counter}-${this.prng.hex(8)}`;
    session.refreshToken = `${REFRESH_PREFIX}${this.counter}-${this.prng.hex(8)}`;
    session.expiresAt =
      Math.floor(this.now() / 1000) + this.accessLifetimeSeconds;
  }

  sessionByRefreshToken(token: string): ServerSession | null {
    for (const session of this.sessions.values()) {
      if (session.refreshToken === token && !session.revokedAt) return session;
    }
    return null;
  }

  sessionByAccessToken(token: string): ServerSession | null {
    for (const session of this.sessions.values()) {
      if (session.accessToken === token && !session.revokedAt) return session;
    }
    return null;
  }

  liveSessions(): ServerSession[] {
    return [...this.sessions.values()].filter(s => !s.revokedAt);
  }

  liveSessionsFor(userId: string): ServerSession[] {
    return this.liveSessions().filter(s => s.userId === userId);
  }

  /** The single live session of a user — throws when there are 0 or 2+. */
  onlyLiveSession(userId: string): ServerSession {
    const live = this.liveSessionsFor(userId);
    if (live.length !== 1) {
      throw new Error(
        `expected exactly one live session for ${userId}, found ${live.length}`,
      );
    }
    return live[0] as ServerSession;
  }

  private sessionView(session: ServerSession) {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
    };
  }

  /** Bootstraps are attributed to a device label so multi-device
   * scenarios can tell sessions apart; the app never sees the label. */
  device = 'device-A';

  private routeOf(url: string): Route | 'unknown' {
    if (url === `${this.baseUrl}/v1/account/bootstrap`) return 'bootstrap';
    if (url === `${this.baseUrl}/v1/auth/refresh`) return 'refresh';
    if (url === `${this.baseUrl}/v1/auth/logout`) return 'logout';
    return 'unknown';
  }

  /** Installs itself as globalThis.fetch and returns the restore function. */
  install(): () => void {
    const previous = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      this.handle(String(url), init)) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = previous;
    };
  }

  async handle(url: string, init?: RequestInit): Promise<Response> {
    const route = this.routeOf(url);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authorization = headers['Authorization'] ?? null;
    let body: unknown = null;
    if (typeof init?.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call: ServerCall = {
      n: this.calls.length + 1,
      route,
      url,
      method: init?.method ?? 'GET',
      authorization,
      body,
      outcome: 'pending',
      atMs: this.now(),
    };
    this.calls.push(call);
    if (route === 'unknown') {
      call.outcome = 'network-error(unknown route)';
      throw new TypeError(`Network request failed (${url})`);
    }
    const fault = this.faults[route].shift();
    if (fault) {
      const label = `fault:${fault.kind}${fault.kind === 'status' ? `:${fault.status}` : ''}`;
      let outcome: Response | null;
      try {
        outcome = await this.applyFault(route, fault, init?.signal);
      } catch (error) {
        call.outcome = `${label}:${error instanceof Error ? error.name : 'thrown'}`;
        throw error;
      }
      if (outcome) {
        call.outcome = label;
        return outcome;
      }
      // A 'delay' fault falls through to the real handler after waiting.
    }
    const response = this.dispatch(route, authorization, headers, body);
    call.outcome = `status:${response.status}`;
    return response;
  }

  private applyFault(
    route: Route,
    fault: Fault,
    signal?: AbortSignal | null,
  ): Promise<Response | null> {
    switch (fault.kind) {
      case 'network':
        return Promise.reject(new TypeError('Network request failed'));
      case 'status':
        return Promise.resolve(
          jsonResponse(
            fault.status,
            fault.body ?? { error: { message: `injected ${fault.status}` } },
          ),
        );
      case 'malformed':
        return Promise.resolve(
          new Response('<html>not json</html>', {
            status: fault.status ?? 200,
            headers: { 'Content-Type': 'text/html' },
          }),
        );
      case 'delay': {
        const wait = new Promise<void>(resolve => {
          setTimeout(resolve, fault.ms);
        });
        this.pendingDelays.add(wait);
        return wait.then(() => {
          this.pendingDelays.delete(wait);
          return null;
        });
      }
      case 'hang':
        return new Promise((resolve, reject) => {
          const entry = { route, resolve, reject };
          this.pendingHangs.push(entry);
          signal?.addEventListener('abort', () => {
            this.pendingHangs = this.pendingHangs.filter(e => e !== entry);
            reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
          });
        });
      default:
        return Promise.resolve(null);
    }
  }

  /** Resolves once every 'delay'-parked request has reached the handler and
   * the response has had a few macrotasks to propagate to the client. */
  async settleDelays(): Promise<void> {
    while (this.pendingDelays.size) {
      await Promise.all([...this.pendingDelays]);
    }
    for (let i = 0; i < 4; i += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }

  /** Completes the oldest hung request of a route with the real handler. */
  releaseHang(route: Route, override?: Response): boolean {
    const index = this.pendingHangs.findIndex(e => e.route === route);
    if (index < 0) return false;
    const [entry] = this.pendingHangs.splice(index, 1);
    if (!entry) return false;
    if (override) {
      entry.resolve(override);
      return true;
    }
    const call = [...this.calls]
      .reverse()
      .find(c => c.route === route && c.outcome === 'pending');
    const headers: Record<string, string> = call?.authorization
      ? { Authorization: call.authorization }
      : {};
    const response = this.dispatch(
      route,
      call?.authorization ?? null,
      headers,
      call?.body ?? null,
    );
    if (call) call.outcome = `released:${response.status}`;
    entry.resolve(response);
    return true;
  }

  private dispatch(
    route: Route,
    authorization: string | null,
    headers: Record<string, string>,
    body: unknown,
  ): Response {
    switch (route) {
      case 'bootstrap':
        return this.bootstrap(authorization, headers, body);
      case 'refresh':
        return this.refresh(body);
      case 'logout':
        return this.logout(authorization);
      default:
        return jsonResponse(404, { error: { message: 'unknown' } });
    }
  }

  private bootstrap(
    authorization: string | null,
    headers: Record<string, string>,
    body: unknown,
  ): Response {
    const bearer = authorization?.replace(/^Bearer /, '') ?? '';
    if (!this.validIdTokens.has(bearer)) {
      return jsonResponse(401, {
        error: { message: 'The identity token could not be verified.' },
      });
    }
    const [, provider, subject] =
      /^SECRET_IDTOKEN_(apple|google)-([^-]+)-/.exec(bearer) ?? [];
    const account = subject ? this.accounts.get(subject) : undefined;
    if (!provider || !account) {
      return jsonResponse(401, {
        error: { message: 'The identity token could not be verified.' },
      });
    }
    if (provider === 'apple') {
      const record = (body ?? {}) as Record<string, unknown>;
      const code = record['appleAuthorizationCode'];
      if (headers['X-Apple-Revocation-Protocol'] === '1') {
        if (typeof code !== 'string' || !this.validAppleCodes.has(code)) {
          return jsonResponse(400, {
            error: {
              code: 'auth.apple_authorization_code_required',
              message: 'Apple did not provide the authorization needed.',
            },
          });
        }
        this.validAppleCodes.delete(code);
      }
    }
    const session = this.mintSession(account.userId, this.device);
    return jsonResponse(200, {
      user: { id: account.userId, email: account.email },
      onboardingState: 'complete',
      session: this.sessionView(session),
    });
  }

  private refresh(body: unknown): Response {
    const record = (body ?? {}) as Record<string, unknown>;
    const token = record['refreshToken'];
    if (typeof token !== 'string' || !token.trim()) {
      return jsonResponse(400, {
        error: {
          code: 'validation.refresh',
          message: 'refreshToken is required.',
        },
      });
    }
    const session = this.sessionByRefreshToken(token);
    if (!session) {
      for (const candidate of this.sessions.values()) {
        if (candidate.spentRefreshTokens.includes(token)) {
          this.reusedRefreshTokens.push(token);
        }
      }
      return jsonResponse(401, {
        error: {
          message: 'The session could not be refreshed. Sign in again.',
        },
      });
    }
    this.rotate(session);
    return jsonResponse(200, { session: this.sessionView(session) });
  }

  private logout(authorization: string | null): Response {
    const bearer = authorization?.replace(/^Bearer /, '') ?? '';
    const session = this.sessionByAccessToken(bearer);
    if (!session) {
      return jsonResponse(401, {
        error: { message: 'The session is no longer valid. Sign in again.' },
      });
    }
    session.revokedAt = this.now();
    return new Response(null, { status: 204 });
  }

  snapshot() {
    return {
      calls: this.calls.map(redactCall),
      sessions: [...this.sessions.values()].map(s => ({
        sessionId: s.sessionId,
        userId: s.userId,
        device: s.device,
        live: !s.revokedAt,
        rotations: s.spentRefreshTokens.length,
        expiresAt: s.expiresAt,
      })),
      reusedRefreshTokens: this.reusedRefreshTokens.length,
    };
  }
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Evidence never carries token VALUES — only their kind + a short tag. */
export function redact(value: string): string {
  return value.replace(
    /SECRET_([A-Z]+)_([A-Za-z0-9-]+)/g,
    (_m, kind: string, tail: string) =>
      `<${kind.toLowerCase()}:${tail.slice(-6)}>`,
  );
}

export function redactCall(call: ServerCall) {
  return {
    n: call.n,
    route: call.route,
    method: call.method,
    outcome: call.outcome,
    atMs: call.atMs,
    authorization: call.authorization ? redact(call.authorization) : null,
    body: call.body === null ? null : redact(JSON.stringify(call.body)),
  };
}

// ─── Console capture (log-leak scan) ─────────────────────────────────────────

export interface ConsoleCapture {
  lines: string[];
  restore: () => void;
}

export function captureConsole(): ConsoleCapture {
  const lines: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  // Alias so the leak scan can hook every level (no-console allows only
  // warn/error on the `console` identifier itself).
  const sink: Console = console;
  const originals = methods.map(m => [m, sink[m]] as const);
  for (const method of methods) {
    sink[method] = (...args: unknown[]) => {
      lines.push(
        `${method}: ${args
          .map(a => (typeof a === 'string' ? a : safeStringify(a)))
          .join(' ')}`,
      );
    };
  }
  return {
    lines,
    restore: () => {
      for (const [method, fn] of originals) sink[method] = fn;
    },
  };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) =>
      v instanceof Error ? { name: v.name, message: v.message } : v,
    );
  } catch {
    return String(value);
  }
}

// ─── Artifacts ───────────────────────────────────────────────────────────────

export function artifactDir(): string {
  const configured = process.env['XC_ARTIFACT_DIR'];
  const dir =
    configured && configured.trim()
      ? configured
      : path.resolve(
          __dirname,
          '../../../../artifacts/xc-journey-signin-restore',
        );
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeArtifact(name: string, data: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

export function heapNumbers() {
  const usage = process.memoryUsage();
  return {
    heapUsedMB: Math.round((usage.heapUsed / 1048576) * 100) / 100,
    heapTotalMB: Math.round((usage.heapTotal / 1048576) * 100) / 100,
    rssMB: Math.round((usage.rss / 1048576) * 100) / 100,
    externalMB: Math.round((usage.external / 1048576) * 100) / 100,
  };
}
