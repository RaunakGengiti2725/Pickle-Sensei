/**
 * Scriptable permit server for the stress harness — a `fetch` replacement
 * that answers `POST /v1/analysis-permits` and `POST
 * /v1/analysis-permits/:id/finalize` exactly the way the harness scripted
 * for the run that issued the call, records every reserve/release verbatim,
 * and can park a response behind a gate so the harness can interleave
 * concurrent runs (permit race) or abandon a run mid-flight (the caller
 * unmounts while the network call is pending).
 */
import { deferred, type Deferred } from '../xcBehavioral/deferred';

export type ReserveMode =
  | 'ok'
  | 'ok_last_free'
  | 'ok_premium'
  | 'ok_malformed_access'
  | 'paywall_402'
  | 'server_500'
  | 'network_throw'
  | 'not_reserved_status'
  | 'invalid_permit'
  | 'blank_permit_id'
  | 'malformed_json';

export type ReleaseMode = 'ok' | 'server_500' | 'network_throw';

export interface ScriptedResponse {
  reserve: ReserveMode;
  release: ReleaseMode;
  /** Park the reserve response until `gate.resolve()` is called. */
  holdReserve: Deferred<void> | null;
  /** Park the finalize response until `gate.resolve()` is called. */
  holdRelease: Deferred<void> | null;
}

export interface ReserveEvent {
  seq: number;
  permitId: string | null;
  mode: ReserveMode;
  idempotencyKey: string | null;
}

export interface ReleaseEvent {
  permitId: string;
  outcome: string;
  mode: ReleaseMode;
}

export interface StressPermitServer {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  reserves: ReserveEvent[];
  releases: ReleaseEvent[];
  /** Ids the server actually issued with status 'reserved'. */
  issued: Set<string>;
  inFlightReserves: number;
  maxInFlightReserves: number;
  /** Scripts consumed in call order; a run that reserves takes the next one. */
  enqueue(script: ScriptedResponse): void;
  pendingScripts(): number;
  /** Drops scripts nobody consumed (a run that gated out before reserving). */
  clearScripts(): void;
  unexpectedUrls: string[];
}

function json(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  } as unknown as Response;
}

export function defaultScript(
  overrides: Partial<ScriptedResponse> = {},
): ScriptedResponse {
  return {
    reserve: 'ok',
    release: 'ok',
    holdReserve: null,
    holdRelease: null,
    ...overrides,
  };
}

export function createStressPermitServer(): StressPermitServer {
  const scripts: ScriptedResponse[] = [];
  const releaseScripts = new Map<string, ScriptedResponse>();
  let seq = 0;
  const server: StressPermitServer = {
    reserves: [],
    releases: [],
    issued: new Set(),
    inFlightReserves: 0,
    maxInFlightReserves: 0,
    unexpectedUrls: [],
    enqueue(script) {
      scripts.push(script);
    },
    pendingScripts: () => scripts.length,
    clearScripts() {
      scripts.length = 0;
    },
    fetch: async (url, init) => {
      if (url.endsWith('/v1/analysis-permits')) {
        const script = scripts.shift() ?? defaultScript();
        seq += 1;
        const mySeq = seq;
        let idempotencyKey: string | null = null;
        try {
          idempotencyKey =
            (JSON.parse(String(init?.body)) as { idempotencyKey?: string })
              .idempotencyKey ?? null;
        } catch {
          idempotencyKey = null;
        }
        server.inFlightReserves += 1;
        server.maxInFlightReserves = Math.max(
          server.maxInFlightReserves,
          server.inFlightReserves,
        );
        try {
          if (script.holdReserve) await script.holdReserve.promise;
        } finally {
          server.inFlightReserves -= 1;
        }
        const permitId = `permit-${mySeq}`;
        const record = (issuedId: string | null): void => {
          server.reserves.push({
            seq: mySeq,
            permitId: issuedId,
            mode: script.reserve,
            idempotencyKey,
          });
        };
        switch (script.reserve) {
          case 'paywall_402':
            record(null);
            return json(402, {
              error: {
                code: 'access.paywall_required',
                message: 'Upgrade to keep rating strokes.',
              },
            });
          case 'server_500':
            record(null);
            return json(500, { error: { code: 'internal', message: 'boom' } });
          case 'network_throw':
            record(null);
            throw new TypeError('Network request failed');
          case 'malformed_json':
            record(null);
            return {
              ok: true,
              status: 200,
              statusText: '200',
              json: async () => {
                throw new SyntaxError('Unexpected token < in JSON');
              },
            } as unknown as Response;
          case 'invalid_permit':
            record(null);
            return json(200, { permit: { nonsense: true } });
          case 'blank_permit_id':
            record(null);
            return json(200, {
              permit: {
                id: '   ',
                accessSource: 'free',
                status: 'reserved',
                expiresAt: '2026-09-05T20:00:00.000Z',
              },
            });
          case 'not_reserved_status':
            record(null);
            return json(200, {
              permit: {
                id: permitId,
                accessSource: 'free',
                status: 'released',
                expiresAt: '2026-09-05T20:00:00.000Z',
              },
            });
          case 'ok_premium':
            record(permitId);
            server.issued.add(permitId);
            releaseScripts.set(permitId, script);
            return json(200, {
              permit: {
                id: permitId,
                accessSource: 'premium',
                status: 'reserved',
                expiresAt: '2026-09-05T20:00:00.000Z',
              },
              access: { premium: true, freeRatings: { availableToReserve: 0 } },
            });
          case 'ok_malformed_access':
            record(permitId);
            server.issued.add(permitId);
            releaseScripts.set(permitId, script);
            return json(200, {
              permit: {
                id: permitId,
                accessSource: 'free',
                status: 'reserved',
                expiresAt: '2026-09-05T20:00:00.000Z',
              },
              // Truncated snapshot: the client must degrade it to null (no
              // last-free prompt) rather than fail the reservation.
              access: {
                premium: false,
                freeRatings: { availableToReserve: 0 },
              },
            });
          case 'ok_last_free':
          case 'ok':
          default: {
            record(permitId);
            server.issued.add(permitId);
            releaseScripts.set(permitId, script);
            const lastFree = script.reserve === 'ok_last_free';
            return json(200, {
              permit: {
                id: permitId,
                accessSource: 'free',
                status: 'reserved',
                expiresAt: '2026-09-05T20:00:00.000Z',
              },
              access: {
                premium: false,
                freeRatings: {
                  limit: 2,
                  used: lastFree ? 1 : 0,
                  reserved: 1,
                  remaining: lastFree ? 1 : 2,
                  availableToReserve: lastFree ? 0 : 1,
                },
              },
            });
          }
        }
      }
      const finalize = /\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(url);
      if (finalize) {
        const permitId = decodeURIComponent(finalize[1]!);
        const body = JSON.parse(String(init?.body)) as { outcome: string };
        const script = releaseScripts.get(permitId) ?? defaultScript();
        server.releases.push({
          permitId,
          outcome: body.outcome,
          mode: script.release,
        });
        if (script.holdRelease) await script.holdRelease.promise;
        if (script.release === 'server_500') {
          return json(500, { error: { code: 'internal', message: 'boom' } });
        }
        if (script.release === 'network_throw') {
          throw new TypeError('Network request failed');
        }
        return json(200, { ok: true });
      }
      server.unexpectedUrls.push(url);
      throw new Error(`Unexpected fetch: ${url}`);
    },
  };
  return server;
}

export { deferred };
export type { Deferred };
