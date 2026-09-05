/**
 * Stateful in-process double for the slice of the edge API the Analyze flow
 * touches (`supabase/functions/api` is BLOCKED_EXTERNAL here). It is the
 * `fetch` the production clients call — `createAnalysisPermitClient`,
 * `createTransport` (outbox sync), `createCanonicalAccessClient` — and keeps
 * the SAME ledger semantics the server documents in AGENTS.md:
 *
 *   - `GET /v1/me/access` derives `used` from consumed (synced scored) free
 *     permits and `reserved` from live free permits; limit is 2.
 *   - `POST /v1/analysis-permits` refuses with 402 when a free account has
 *     nothing left to reserve; otherwise mints a `reserved` permit and returns
 *     the post-reservation access snapshot.
 *   - `POST /v1/analysis-permits/:id/finalize` releases a reserved permit.
 *   - `POST /v1/shots:sync` consumes each shot's permit (accepting the shot)
 *     or rejects the shot when its permit is unknown / not reserved.
 *
 * Fault injection the stress driver uses: `holdNext(matcher)` parks matching
 * requests until `releaseHeld()` (honouring the caller's AbortSignal so the
 * production 20 s timeout still fires), and `offline` makes every request
 * fail the way React Native's fetch does without a network.
 */
export type PermitStatus = 'reserved' | 'released' | 'consumed';

export interface PermitRecord {
  id: string;
  accessSource: 'free' | 'premium';
  status: PermitStatus;
  outcome: string | null;
  idempotencyKey: string;
}

export interface ServerRequestRecord {
  method: string;
  path: string;
  /** Number of the request within the server's lifetime (1-based). */
  ordinal: number;
}

export interface ServerCounters {
  accessGet: number;
  reserve: number;
  reserveRefused: number;
  finalize: number;
  shotSync: number;
  shotsAccepted: number;
  shotsRejected: number;
  sessions: number;
  trials: number;
  unknown: number;
  aborted: number;
  offlineFailures: number;
}

export interface AccessSnapshot {
  premium: boolean;
  entitlements: string[];
  freeRatings: {
    limit: 2;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
  canStartRating: boolean;
  paywallRequired: boolean;
}

interface HeldRequest {
  path: string;
  release(): void;
  abort(): void;
}

export class FakeRatingServer {
  premium = false;
  offline = false;
  readonly permits = new Map<string, PermitRecord>();
  readonly requests: ServerRequestRecord[] = [];
  readonly counters: ServerCounters = emptyCounters();
  /** Observer invoked synchronously when a request ARRIVES (before any hold). */
  onRequest: ((record: ServerRequestRecord) => void) | null = null;
  private holdMatcher: ((path: string) => boolean) | null = null;
  private held: HeldRequest[] = [];
  private permitSeq = 0;
  private ordinal = 0;

  constructor(readonly baseUrl: string) {}

  reset(options: { premium: boolean }): void {
    this.premium = options.premium;
    this.offline = false;
    this.permits.clear();
    this.requests.length = 0;
    Object.assign(this.counters, emptyCounters());
    this.holdMatcher = null;
    for (const held of this.held) held.abort();
    this.held = [];
    this.permitSeq = 0;
    this.ordinal = 0;
    this.onRequest = null;
  }

  /** Park every request whose path matches until `releaseHeld()`. */
  hold(matcher: (path: string) => boolean): void {
    this.holdMatcher = matcher;
  }

  get heldCount(): number {
    return this.held.length;
  }

  heldPaths(): string[] {
    return this.held.map(h => h.path);
  }

  /** Lets parked requests proceed and stops holding new ones. */
  releaseHeld(): number {
    this.holdMatcher = null;
    const releasing = this.held;
    this.held = [];
    for (const held of releasing) held.release();
    return releasing.length;
  }

  freePermits(status?: PermitStatus): PermitRecord[] {
    return [...this.permits.values()].filter(
      p =>
        p.accessSource === 'free' &&
        (status === undefined || p.status === status),
    );
  }

  snapshot(): AccessSnapshot {
    const used = Math.min(2, this.freePermits('consumed').length);
    const remaining = 2 - used;
    const reserved = Math.min(remaining, this.freePermits('reserved').length);
    const availableToReserve = remaining - reserved;
    const canStartRating = this.premium || availableToReserve > 0;
    return {
      premium: this.premium,
      entitlements: this.premium ? ['premium'] : [],
      freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
      canStartRating,
      paywallRequired: !canStartRating,
    };
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = this.relativePath(url);
    this.ordinal += 1;
    const record: ServerRequestRecord = { method, path, ordinal: this.ordinal };
    this.requests.push(record);
    this.onRequest?.(record);
    const signal = init?.signal ?? null;
    if (this.holdMatcher?.(path)) {
      await this.park(path, signal);
    }
    if (signal?.aborted) {
      this.counters.aborted += 1;
      throw abortError();
    }
    if (this.offline) {
      this.counters.offlineFailures += 1;
      throw new TypeError('Network request failed');
    }
    const body = parseBody(init?.body);
    return this.route(method, path, body);
  };

  private relativePath(url: string): string {
    const base = new URL(this.baseUrl);
    const target = new URL(url);
    const basePath = base.pathname.replace(/\/+$/, '');
    return target.pathname.startsWith(basePath)
      ? target.pathname.slice(basePath.length) || '/'
      : target.pathname;
  }

  private park(path: string, signal: AbortSignal | null): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const entry: HeldRequest = {
        path,
        release: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        abort: () => {
          signal?.removeEventListener('abort', onAbort);
          this.held = this.held.filter(h => h !== entry);
          reject(abortError());
        },
      };
      const onAbort = () => {
        this.counters.aborted += 1;
        entry.abort();
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort);
      this.held.push(entry);
    });
  }

  private route(method: string, path: string, body: unknown): Response {
    if (method === 'GET' && path === '/v1/me/access') {
      this.counters.accessGet += 1;
      return json(200, this.snapshot());
    }
    if (method === 'POST' && path === '/v1/analysis-permits') {
      return this.reserve(body);
    }
    const finalize = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(path);
    if (method === 'POST' && finalize) {
      return this.finalize(decodeURIComponent(finalize[1]!), body);
    }
    if (method === 'POST' && path === '/v1/shots:sync') {
      return this.syncShots(body);
    }
    if (
      method === 'POST' &&
      /^\/v1\/sessions(\/[^/]+\/finalize)?$/.test(path)
    ) {
      this.counters.sessions += 1;
      return json(200, { ok: true });
    }
    if (method === 'POST' && path === '/v1/me/evaluation/trials') {
      this.counters.trials += 1;
      const trials =
        isRecord(body) && Array.isArray(body.trials) ? body.trials : [];
      return json(200, {
        acceptedTrialIds: trials
          .map(t =>
            isRecord(t) && typeof t.trialId === 'string' ? t.trialId : null,
          )
          .filter((id): id is string => id !== null),
        rejected: [],
      });
    }
    this.counters.unknown += 1;
    return json(404, {
      error: {
        code: 'route.not_found',
        message: `No stress route for ${method} ${path}`,
      },
    });
  }

  private reserve(body: unknown): Response {
    const idempotencyKey =
      isRecord(body) && typeof body.idempotencyKey === 'string'
        ? body.idempotencyKey
        : '';
    const snapshot = this.snapshot();
    if (!snapshot.canStartRating) {
      this.counters.reserveRefused += 1;
      return json(402, {
        error: {
          code: 'access.paywall_required',
          message:
            'Both free analyses are used. Upgrade to Pro to keep rating your strokes.',
        },
      });
    }
    this.counters.reserve += 1;
    this.permitSeq += 1;
    const permit: PermitRecord = {
      id: `permit-${this.permitSeq}`,
      accessSource: this.premium ? 'premium' : 'free',
      status: 'reserved',
      outcome: null,
      idempotencyKey,
    };
    this.permits.set(permit.id, permit);
    return json(200, {
      permit: {
        id: permit.id,
        accessSource: permit.accessSource,
        status: 'reserved',
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      },
      access: this.snapshot(),
    });
  }

  private finalize(permitId: string, body: unknown): Response {
    this.counters.finalize += 1;
    const permit = this.permits.get(permitId);
    if (!permit) {
      return json(404, {
        error: {
          code: 'access.permit_not_found',
          message: 'Unknown analysis permit.',
        },
      });
    }
    if (permit.status !== 'reserved') {
      return json(409, {
        error: {
          code: 'access.permit_not_reserved',
          message: 'The analysis permit is no longer reserved.',
        },
      });
    }
    permit.status = 'released';
    permit.outcome =
      isRecord(body) && typeof body.outcome === 'string' ? body.outcome : null;
    return json(200, { ok: true });
  }

  private syncShots(body: unknown): Response {
    this.counters.shotSync += 1;
    const shots = isRecord(body) && Array.isArray(body.shots) ? body.shots : [];
    const acceptedIds: string[] = [];
    const rejected: Array<{ id: string; code: string; message: string }> = [];
    for (const shot of shots) {
      const id = isRecord(shot) && typeof shot.id === 'string' ? shot.id : '';
      const permitId =
        isRecord(shot) && typeof shot.analysisPermitId === 'string'
          ? shot.analysisPermitId
          : '';
      const permit = this.permits.get(permitId);
      if (!permit) {
        rejected.push({
          id,
          code: 'shot.permit_not_found',
          message: 'Unknown permit.',
        });
        continue;
      }
      if (permit.status !== 'reserved') {
        rejected.push({
          id,
          code: 'shot.permit_not_reserved',
          message: `Permit is ${permit.status}.`,
        });
        continue;
      }
      permit.status = 'consumed';
      permit.outcome = 'scored';
      acceptedIds.push(id);
    }
    this.counters.shotsAccepted += acceptedIds.length;
    this.counters.shotsRejected += rejected.length;
    return json(200, { acceptedIds, rejected });
  }
}

function emptyCounters(): ServerCounters {
  return {
    accessGet: 0,
    reserve: 0,
    reserveRefused: 0,
    finalize: 0,
    shotSync: 0,
    shotsAccepted: 0,
    shotsRejected: 0,
    sessions: 0,
    trials: 0,
    unknown: 0,
    aborted: 0,
    offlineFailures: 0,
  };
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return undefined;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `HTTP ${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}
