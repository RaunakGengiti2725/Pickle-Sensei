/**
 * XC journey harness — a scripted in-process stand-in for the edge function.
 * Installed as `global.fetch`, so the REAL clients (`createAnalysisPermitClient`,
 * `createTransport`, `createCanonicalAccessClient`, `createTrainingApi`) run
 * unmodified against it. Every request is journaled with its body so a
 * scenario can assert what left the device, and each route has a fault
 * switch so a failure branch is driven by the server contract (HTTP status,
 * error code, network error, or a hang that never resolves) rather than by
 * stubbing app code.
 *
 * The free-rating ledger mirrors `access_state()` / `reserve_analysis_permit()`
 * arithmetic (limit 2, used from scored syncs, reserved from live permits) so
 * `/v1/me/access` and reserve responses stay internally consistent and pass
 * `parseAccess`'s strict cross-checks.
 */

export type RouteFault =
  | { kind: 'ok' }
  | { kind: 'http'; status: number; code: string; message: string }
  | { kind: 'network'; message: string }
  | { kind: 'hang' }
  | { kind: 'malformed' };

export type SyncFault =
  RouteFault | { kind: 'reject_all'; code: string; message: string };

export interface JourneyServerScript {
  premium: boolean;
  /** Scored shots already counted against the free ledger. */
  used: number;
  reserve: RouteFault;
  finalize: RouteFault;
  access: RouteFault;
  sync: SyncFault;
  training: RouteFault;
}

export interface JourneyRequestLog {
  seq: number;
  method: string;
  path: string;
  body: unknown;
  status: number | 'network_error' | 'hang';
}

export interface JourneyServer {
  fetch: (input: unknown, init?: RequestInit) => Promise<Response>;
  script: JourneyServerScript;
  requests: JourneyRequestLog[];
  permits: Map<string, { status: string; outcome: string | null }>;
  syncedShotIds: string[];
  ledger: () => { used: number; reserved: number };
  requestsFor: (pathPrefix: string) => JourneyRequestLog[];
}

export const FREE_RATING_LIMIT = 2;

export function defaultScript(): JourneyServerScript {
  return {
    premium: false,
    used: 0,
    reserve: { kind: 'ok' },
    finalize: { kind: 'ok' },
    access: { kind: 'ok' },
    sync: { kind: 'ok' },
    training: { kind: 'ok' },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function errorBody(code: string, message: string) {
  return { error: { code, message } };
}

/** A stalled connection: never resolves unless the caller aborts (the real
 * fetch rejects with AbortError when its signal fires — a hang MUST honour
 * that or every client timeout in the app would be invisible here). */
function hangUntilAbort(
  signal: AbortSignal | null | undefined,
): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    if (!signal) return;
    const abort = () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

export function createJourneyServer(
  overrides: Partial<JourneyServerScript> = {},
): JourneyServer {
  const script: JourneyServerScript = { ...defaultScript(), ...overrides };
  const requests: JourneyRequestLog[] = [];
  const permits = new Map<string, { status: string; outcome: string | null }>();
  const syncedShotIds: string[] = [];
  let seq = 0;

  const ledger = () => {
    let reserved = 0;
    for (const permit of permits.values()) {
      if (permit.status === 'reserved') reserved += 1;
    }
    return { used: script.used, reserved };
  };

  const accessSnapshot = () => {
    const { used, reserved } = ledger();
    const remaining = Math.max(0, FREE_RATING_LIMIT - used);
    const availableToReserve = Math.max(0, remaining - reserved);
    const canStartRating = script.premium || availableToReserve > 0;
    return {
      premium: script.premium,
      entitlements: script.premium ? ['premium'] : [],
      freeRatings: {
        limit: FREE_RATING_LIMIT,
        used,
        reserved,
        remaining,
        availableToReserve,
      },
      canStartRating,
      paywallRequired: !canStartRating,
    };
  };

  const applyFault = (
    fault: RouteFault,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> | null => {
    switch (fault.kind) {
      case 'ok':
        return null;
      case 'http':
        return Promise.resolve(
          json(fault.status, errorBody(fault.code, fault.message)),
        );
      case 'network':
        return Promise.reject(new TypeError(fault.message));
      case 'hang':
        return hangUntilAbort(signal);
      case 'malformed':
        return Promise.resolve(
          new Response('<html>not json</html>', {
            status: 200,
            headers: { 'content-type': 'text/html' },
          }),
        );
    }
  };

  const route = (
    method: string,
    path: string,
    body: unknown,
    signal: AbortSignal | null | undefined,
  ): Promise<Response> => {
    if (method === 'POST' && path === '/v1/analysis-permits') {
      const faulted = applyFault(script.reserve, signal);
      if (faulted) return faulted;
      const snapshot = accessSnapshot();
      if (!snapshot.canStartRating) {
        return Promise.resolve(
          json(
            402,
            errorBody(
              'access.paywall_required',
              'Your free analyses are used up. Upgrade to keep rating.',
            ),
          ),
        );
      }
      const id = `permit-${String(permits.size + 1).padStart(3, '0')}`;
      permits.set(id, { status: 'reserved', outcome: null });
      return Promise.resolve(
        json(200, {
          permit: {
            id,
            accessSource: script.premium ? 'premium' : 'free',
            status: 'reserved',
            expiresAt: '2026-09-04T07:00:00.000Z',
          },
          access: (() => {
            const { freeRatings, premium } = accessSnapshot();
            return { premium, freeRatings };
          })(),
        }),
      );
    }
    const finalize = path.match(/^\/v1\/analysis-permits\/([^/]+)\/finalize$/);
    if (method === 'POST' && finalize) {
      const faulted = applyFault(script.finalize, signal);
      if (faulted) return faulted;
      const id = decodeURIComponent(finalize[1] ?? '');
      const permit = permits.get(id);
      if (!permit) {
        return Promise.resolve(
          json(404, errorBody('access.permit_not_found', 'Unknown permit.')),
        );
      }
      const outcome =
        body && typeof body === 'object' && 'outcome' in body
          ? String((body as { outcome: unknown }).outcome)
          : 'released';
      permit.status = 'released';
      permit.outcome = outcome;
      return Promise.resolve(json(200, { ok: true }));
    }
    if (method === 'GET' && path === '/v1/me/access') {
      const faulted = applyFault(script.access, signal);
      if (faulted) return faulted;
      return Promise.resolve(json(200, accessSnapshot()));
    }
    if (method === 'POST' && path === '/v1/shots:sync') {
      const shots =
        body &&
        typeof body === 'object' &&
        Array.isArray((body as { shots?: unknown }).shots)
          ? ((body as { shots: unknown[] }).shots as Array<
              Record<string, unknown>
            >)
          : [];
      const syncFault = script.sync;
      if (syncFault.kind === 'reject_all') {
        return Promise.resolve(
          json(200, {
            acceptedIds: [],
            rejected: shots.map(shot => ({
              id: String(shot['id']),
              code: syncFault.code,
              message: syncFault.message,
            })),
          }),
        );
      }
      const faulted = applyFault(syncFault, signal);
      if (faulted) return faulted;
      const acceptedIds: string[] = [];
      for (const shot of shots) {
        const id = String(shot['id']);
        acceptedIds.push(id);
        syncedShotIds.push(id);
        const permitId =
          typeof shot['analysisPermitId'] === 'string'
            ? shot['analysisPermitId']
            : null;
        const permit = permitId ? permits.get(permitId) : undefined;
        if (permit && permit.status === 'reserved') {
          permit.status = 'consumed';
          permit.outcome = 'scored';
          if (!script.premium) script.used += 1;
        }
      }
      return Promise.resolve(json(200, { acceptedIds, rejected: [] }));
    }
    const sessionFault: RouteFault =
      script.sync.kind === 'reject_all' ? { kind: 'ok' } : script.sync;
    if (method === 'POST' && path === '/v1/sessions') {
      const faulted = applyFault(sessionFault, signal);
      if (faulted) return faulted;
      return Promise.resolve(json(200, { ok: true }));
    }
    if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/finalize$/.test(path)) {
      const faulted = applyFault(sessionFault, signal);
      if (faulted) return faulted;
      return Promise.resolve(json(200, { ok: true }));
    }
    if (method === 'POST' && path === '/v1/me/evaluation/trials') {
      const faulted = applyFault(sessionFault, signal);
      if (faulted) return faulted;
      const trials =
        body &&
        typeof body === 'object' &&
        Array.isArray((body as { trials?: unknown }).trials)
          ? ((body as { trials: unknown[] }).trials as Array<
              Record<string, unknown>
            >)
          : [];
      return Promise.resolve(
        json(200, {
          acceptedTrialIds: trials.map(trial => String(trial['trialId'])),
          rejected: [],
        }),
      );
    }
    if (
      method === 'GET' &&
      (path.startsWith('/v1/training-plans') ||
        path.startsWith('/v1/me/saved-drills') ||
        path.startsWith('/v1/catalog/drills'))
    ) {
      const faulted = applyFault(script.training, signal);
      if (faulted) return faulted;
      if (path.startsWith('/v1/training-plans')) {
        return Promise.resolve(json(200, { plan: null }));
      }
      return Promise.resolve(json(200, { items: [] }));
    }
    return Promise.resolve(
      json(404, errorBody('not_found', `No route for ${method} ${path}`)),
    );
  };

  const fetchImpl = async (
    input: unknown,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    seq += 1;
    const entry: JourneyRequestLog = {
      seq,
      method,
      path,
      body,
      status: 'hang',
    };
    requests.push(entry);
    try {
      const response = await route(method, path, body, init?.signal);
      entry.status = response.status;
      return response;
    } catch (error) {
      entry.status = 'network_error';
      throw error;
    }
  };

  return {
    fetch: fetchImpl,
    script,
    requests,
    permits,
    syncedShotIds,
    ledger,
    requestsFor: prefix => requests.filter(r => r.path.startsWith(prefix)),
  };
}
