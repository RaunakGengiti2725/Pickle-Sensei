/**
 * XC journey-offline-first harness: an in-process model of the shipping sync
 * endpoints (`supabase/functions/api/index.ts` → `syncShots`,
 * `createSession`, `finalizeSession`) plus the `apply_synced_shot` permit
 * rules (`supabase/migrations/20260902150000_free_rating_identity_ledger.sql`).
 *
 * It is installed as `globalThis.fetch`, so the REAL mobile transport
 * (`createTransport` → `request()` in `src/data/api.ts`) runs unmodified:
 * bearer resolution, `ApiError` mapping, the bounded request timeout and the
 * retryable/permanent classification in `src/data/sync.ts` are all exercised
 * by production code — only the network and the database are simulated.
 *
 * Fidelity note (INFERRED): the model mirrors the Edge Function's response
 * shapes and status codes as read from source; the Deno + Postgres planes
 * verify the real implementations separately (`supabase/functions/api/__wf__`
 * and `supabase/tests/`).
 */

export type ServerMode =
  /** Healthy: requests are processed and answered. */
  | 'online'
  /** Radio off: `fetch` rejects with the RN network TypeError. */
  | 'offline'
  /** Gateway failure before the handler runs. */
  | 'http500'
  /** Rate limited before the handler runs. */
  | 'http429'
  /** Session token rejected before the handler runs. */
  | 'http401'
  /** The request never completes; only the client timeout ends it. */
  | 'hang'
  /**
   * The handler COMMITS state, then the response is lost on the wire
   * (client sees a network error). The next flush must replay idempotently.
   */
  | 'commit_then_drop';

export type ShotFault =
  /** `apply_synced_shot` raised: stable `shot.write_failed`, N times. */
  | { kind: 'write_failed'; remaining: number }
  /** A permanent domain rejection with the given contract code. */
  | { kind: 'permanent'; code: PermanentRejectionCode }
  /** Permit older than 24h at sync time (offline overnight). */
  | { kind: 'permit_expired' };

export type PermanentRejectionCode =
  | 'access.permit_not_found'
  | 'access.permit_not_reserved'
  | 'access.paywall_required'
  | 'shot.id_conflict'
  | 'shot.invalid_payload'
  | 'shot.non_real_source';

const SYNC_STATUS_MESSAGES: Record<string, string> = {
  'auth.required': 'Sign in again to sync analyses.',
  'access.permit_not_found': 'Analysis permit not found.',
  'access.permit_not_reserved': 'Analysis permit is no longer reserved.',
  'access.permit_expired': 'Analysis permit expired.',
  'access.paywall_required':
    'Both lifetime free ratings have been used. Membership is required for another rating.',
  'shot.session_not_found': 'Session not found or not yours.',
  'shot.id_conflict': 'Shot id is already bound to a different user.',
  'shot.invalid_payload': 'Shot payload must be an object.',
  'shot.non_real_source':
    'Only analyses produced by a real provider may be synced.',
};

const WRITE_FAILED_MESSAGE =
  'The analysis could not be saved right now. It stays on this device and will retry.';

export interface RequestLogEntry {
  n: number;
  method: string;
  path: string;
  mode: ServerMode;
  /** Shot ids in a shots:sync body; session id for session routes. */
  entityIds: string[];
  status: number | 'network_error' | 'timeout';
  acceptedIds?: string[];
  rejected?: Array<{ id: string; code: string }>;
}

export interface ServerShotRow {
  id: string;
  permitId: string;
  sessionId: string | null;
  resultKind: string;
  userId: string;
}

export interface FakeSyncServerOptions {
  /** The authenticated user every request is attributed to. */
  userId?: string;
  /** Premium accounts skip the two-lifetime-free-ratings backstop. */
  premium?: boolean;
  /** Mode for request number `n` (1-based). Defaults to `'online'`. */
  modeFor?: (n: number) => ServerMode;
  /** Fixed clock for permit expiry evaluation. */
  nowMs?: () => number;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class FakeSyncServer {
  readonly userId: string;
  readonly premium: boolean;
  readonly requests: RequestLogEntry[] = [];
  readonly permits = new Map<
    string,
    {
      status: 'reserved' | 'finalized' | 'released';
      outcome: string | null;
      createdAtMs: number;
    }
  >();
  readonly sessions = new Map<
    string,
    { userId: string; endedAt: string | null }
  >();
  readonly shots = new Map<string, ServerShotRow>();
  readonly faults = new Map<string, ShotFault>();
  scoredCount = 0;
  private modeFor: (n: number) => ServerMode;
  private nowMs: () => number;
  private requestCount = 0;
  private installed: typeof globalThis.fetch | undefined;
  private wasInstalled = false;

  constructor(options: FakeSyncServerOptions = {}) {
    this.userId = options.userId ?? 'user-a';
    this.premium = options.premium ?? true;
    this.modeFor = options.modeFor ?? (() => 'online');
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  setModeFor(modeFor: (n: number) => ServerMode): void {
    this.modeFor = modeFor;
  }

  /** Simulates the online permit reservation that precedes every rating. */
  reservePermit(id: string, createdAtMs?: number): string {
    this.permits.set(id, {
      status: 'reserved',
      outcome: null,
      createdAtMs: createdAtMs ?? this.nowMs(),
    });
    return id;
  }

  /** Registers a session owned by a DIFFERENT user (id conflict source). */
  seedForeignSession(id: string): void {
    this.sessions.set(id, { userId: 'someone-else', endedAt: null });
  }

  requestsFor(entityId: string): RequestLogEntry[] {
    return this.requests.filter(entry => entry.entityIds.includes(entityId));
  }

  /**
   * Installs the model as `globalThis.fetch`. Returns a restore function.
   * The returned response object exposes exactly what `request()` reads:
   * `ok`, `status`, `statusText`, `json()`.
   */
  install(): () => void {
    const previous = globalThis.fetch;
    const hadFetch = Object.prototype.hasOwnProperty.call(globalThis, 'fetch');
    const impl = (input: string | URL | Request, init?: RequestInit) =>
      this.fetchImpl(input, init);
    (globalThis as { fetch: unknown }).fetch = impl;
    this.installed = previous;
    this.wasInstalled = hadFetch;
    return () => {
      if (this.wasInstalled) {
        (globalThis as { fetch: unknown }).fetch = this.installed;
      } else {
        delete (globalThis as { fetch?: unknown }).fetch;
      }
    };
  }

  private async fetchImpl(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    json(): Promise<unknown>;
  }> {
    const n = ++this.requestCount;
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : null;
    const mode = this.modeFor(n);
    const entry: RequestLogEntry = {
      n,
      method,
      path,
      mode,
      entityIds: entityIdsOf(path, body),
      status: 'network_error',
    };
    this.requests.push(entry);

    const respond = (status: number, payload: unknown) => {
      entry.status = status;
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        json: async () => payload,
      };
    };
    const error = (status: number, code: string, message: string) =>
      respond(status, { error: { code, message } });

    switch (mode) {
      case 'offline':
        throw new TypeError('Network request failed');
      case 'http500':
        return error(500, 'internal', 'Upstream unavailable.');
      case 'http429':
        return error(429, 'rate_limited', 'Too many requests.');
      case 'http401':
        return error(401, 'auth.invalid_token', 'Session expired.');
      case 'hang': {
        const signal = init?.signal;
        await new Promise<never>((_, reject) => {
          const abort = () => {
            entry.status = 'timeout';
            reject(new Error('aborted'));
          };
          if (!signal) return;
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener('abort', abort, { once: true });
        });
        throw new Error('unreachable');
      }
      case 'commit_then_drop': {
        this.route(method, path, body, entry);
        entry.status = 'network_error';
        throw new TypeError('Network request failed');
      }
      case 'online': {
        const result = this.route(method, path, body, entry);
        return respond(result.status, result.body);
      }
    }
  }

  private route(
    method: string,
    path: string,
    body: unknown,
    entry: RequestLogEntry,
  ): { status: number; body: unknown } {
    const error = (status: number, code: string, message: string) => ({
      status,
      body: { error: { code, message } },
    });
    if (method === 'POST' && path === '/v1/shots:sync') {
      return this.syncShots(body, entry);
    }
    if (method === 'POST' && path === '/v1/sessions') {
      if (!isRecord(body) || !isUuid(body.id)) {
        return error(400, 'validation.session_id', 'id must be a UUID.');
      }
      const startedAt =
        typeof body.startedAt === 'string' ? Date.parse(body.startedAt) : NaN;
      if (!Number.isFinite(startedAt)) {
        return error(400, 'validation.started_at', 'startedAt must be ISO.');
      }
      const existing = this.sessions.get(body.id);
      if (existing && existing.userId !== this.userId) {
        return error(
          409,
          'session.id_conflict',
          'Session id is already bound to a different user.',
        );
      }
      if (!existing) {
        this.sessions.set(body.id, { userId: this.userId, endedAt: null });
      }
      return { status: 200, body: { ok: true } };
    }
    const finalize = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(path);
    if (method === 'POST' && finalize) {
      const id = finalize[1] ?? '';
      if (!isUuid(id)) {
        return error(400, 'validation.session_id', 'id must be a UUID.');
      }
      const session = this.sessions.get(id);
      if (!session || session.userId !== this.userId) {
        return error(404, 'session.not_found', 'Session not found.');
      }
      if (session.endedAt === null) {
        session.endedAt = new Date(this.nowMs()).toISOString();
      }
      return { status: 200, body: { ok: true } };
    }
    return error(404, 'not_found', `No route ${method} ${path}`);
  }

  private syncShots(
    body: unknown,
    entry: RequestLogEntry,
  ): { status: number; body: unknown } {
    const shotsRaw = isRecord(body) ? body.shots : undefined;
    if (
      !Array.isArray(shotsRaw) ||
      shotsRaw.length < 1 ||
      shotsRaw.length > 200
    ) {
      return {
        status: 400,
        body: {
          error: {
            code: 'validation.shots_sync',
            message: 'Body must be { shots: [1..200 entries] }.',
          },
        },
      };
    }
    const acceptedIds: string[] = [];
    const rejected: Array<{ id: string; code: string; message: string }> = [];
    const reject = (id: string, code: string) =>
      rejected.push({ id, code, message: SYNC_STATUS_MESSAGES[code] ?? code });

    for (const raw of shotsRaw) {
      const id =
        isRecord(raw) && typeof raw.id === 'string' ? raw.id : 'unknown';
      if (!isRecord(raw) || !isUuid(raw.id)) {
        reject(id, 'shot.invalid_payload');
        continue;
      }
      if (raw.source !== 'real') {
        reject(id, 'shot.non_real_source');
        continue;
      }
      if (!isUuid(raw.analysisPermitId)) {
        reject(id, 'shot.invalid_payload');
        continue;
      }
      const existing = this.shots.get(raw.id);
      if (existing) {
        if (existing.userId === this.userId) {
          acceptedIds.push(raw.id);
        } else {
          reject(raw.id, 'shot.id_conflict');
        }
        continue;
      }
      const fault = this.faults.get(raw.id);
      if (fault?.kind === 'write_failed' && fault.remaining > 0) {
        fault.remaining -= 1;
        rejected.push({
          id: raw.id,
          code: 'shot.write_failed',
          message: WRITE_FAILED_MESSAGE,
        });
        continue;
      }
      if (fault?.kind === 'permanent') {
        reject(raw.id, fault.code);
        continue;
      }
      const permit = this.permits.get(raw.analysisPermitId);
      if (!permit) {
        reject(raw.id, 'access.permit_not_found');
        continue;
      }
      if (permit.status !== 'reserved') {
        reject(raw.id, 'access.permit_not_reserved');
        continue;
      }
      const expired =
        fault?.kind === 'permit_expired' ||
        permit.createdAtMs <= this.nowMs() - 24 * 60 * 60 * 1000;
      if (expired) {
        permit.status = 'released';
        permit.outcome = 'expired';
        reject(raw.id, 'access.permit_expired');
        continue;
      }
      const scored = raw.resultKind === 'scored';
      if (scored && !this.premium && this.scoredCount >= 2) {
        permit.status = 'released';
        permit.outcome = 'free_limit_reached';
        reject(raw.id, 'access.paywall_required');
        continue;
      }
      const sessionId =
        typeof raw.sessionId === 'string' ? raw.sessionId : null;
      if (sessionId !== null) {
        const session = this.sessions.get(sessionId);
        if (!session || session.userId !== this.userId) {
          reject(raw.id, 'shot.session_not_found');
          continue;
        }
      }
      this.shots.set(raw.id, {
        id: raw.id,
        permitId: raw.analysisPermitId,
        sessionId,
        resultKind: String(raw.resultKind),
        userId: this.userId,
      });
      if (scored) {
        permit.status = 'finalized';
        permit.outcome = 'scored';
        this.scoredCount += 1;
      } else {
        permit.status = 'released';
        permit.outcome = 'low_confidence';
      }
      acceptedIds.push(raw.id);
    }
    entry.acceptedIds = acceptedIds;
    entry.rejected = rejected.map(({ id, code }) => ({ id, code }));
    return { status: 200, body: { acceptedIds, rejected } };
  }
}

function entityIdsOf(path: string, body: unknown): string[] {
  if (
    path === '/v1/shots:sync' &&
    isRecord(body) &&
    Array.isArray(body.shots)
  ) {
    return body.shots.map(shot =>
      isRecord(shot) && typeof shot.id === 'string' ? shot.id : 'unknown',
    );
  }
  if (
    path === '/v1/sessions' &&
    isRecord(body) &&
    typeof body.id === 'string'
  ) {
    return [body.id];
  }
  const finalize = /^\/v1\/sessions\/([^/]+)\/finalize$/.exec(path);
  if (finalize) return [finalize[1] ?? ''];
  return [];
}
