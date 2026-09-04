/**
 * Seeded fake of the analysis-permit endpoints, installed as `global.fetch`.
 *
 * Models the server-side accounting the client must never break:
 *  - a free allowance: `reserve` succeeds while `available > 0` and decrements
 *    it; `finalize` with a non-scored outcome hands the unit back; a permit
 *    "consumed" by a synced scored shot never comes back;
 *  - per-token auth: a token that has been revoked ("logout") is refused with
 *    401 on every later call;
 *  - per-call behaviour chosen from the seeded scheduler: ok / 500 / network
 *    throw / (reserve only) duplicate permit id;
 *  - every response parks on the scheduler before it lands, so reserve and
 *    finalize responses interleave with SQL and other actors.
 */
import type { StressScheduler } from './scheduler';

export type ReserveBehaviour =
  | 'ok'
  | 'server_500'
  | 'network_throw'
  | 'not_reserved'
  | 'duplicate_permit_id';
export type FinalizeBehaviour = 'ok' | 'server_500' | 'network_throw';

export interface PermitLedgerEntry {
  id: string;
  token: string;
  accessSource: 'free' | 'premium';
  status: 'reserved' | 'released';
  releaseOutcome: string | null;
  releaseCount: number;
}

export interface PermitServer {
  ledger: Map<string, PermitLedgerEntry>;
  reserves: number;
  reserveFailures: number;
  finalizeCalls: number;
  finalizeUnauthorized: number;
  finalizeUnknownPermit: number;
  /** Units of the free allowance the server currently holds as available. */
  available: number;
  readonly initialAvailable: number;
  premium: boolean;
  inFlightReserves: number;
  maxInFlightReserves: number;
  revokeToken(token: string): void;
  reserveBehaviour: () => ReserveBehaviour;
  finalizeBehaviour: () => FinalizeBehaviour;
  requests: Array<{ path: string; token: string | null; status: number }>;
  install(): void;
  uninstall(): void;
}

export interface PermitServerOptions {
  freeRatings: number;
  premium?: boolean;
  reserveBehaviour?: () => ReserveBehaviour;
  finalizeBehaviour?: () => FinalizeBehaviour;
}

const json = (status: number, body: unknown): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  }) as unknown as Response;

export function createPermitServer(
  scheduler: StressScheduler,
  options: PermitServerOptions,
): PermitServer {
  const revoked = new Set<string>();
  let permitSeq = 0;
  let lastPermitId: string | null = null;
  const previousFetch = globalThis.fetch;

  const server: PermitServer = {
    ledger: new Map(),
    reserves: 0,
    reserveFailures: 0,
    finalizeCalls: 0,
    finalizeUnauthorized: 0,
    finalizeUnknownPermit: 0,
    available: options.freeRatings,
    initialAvailable: options.freeRatings,
    premium: options.premium ?? false,
    inFlightReserves: 0,
    maxInFlightReserves: 0,
    revokeToken(token) {
      revoked.add(token);
    },
    reserveBehaviour: options.reserveBehaviour ?? (() => 'ok'),
    finalizeBehaviour: options.finalizeBehaviour ?? (() => 'ok'),
    requests: [],
    install() {
      globalThis.fetch = fetchImpl as typeof fetch;
    },
    uninstall() {
      globalThis.fetch = previousFetch;
    },
  };

  async function fetchImpl(
    input: string,
    init?: { headers?: Record<string, string>; body?: string },
  ): Promise<Response> {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const auth = init?.headers?.['authorization'] ?? null;
    const token = auth ? auth.replace(/^Bearer\s+/, '') : null;
    const record = (status: number): void => {
      server.requests.push({ path, token, status });
    };
    const accessSnapshot = () => ({
      premium: server.premium,
      freeRatings: {
        limit: server.initialAvailable,
        used: 0,
        remaining: server.available,
        reserved: server.initialAvailable - server.available,
        availableToReserve: server.available,
      },
    });

    if (path === '/v1/analysis-permits') {
      server.inFlightReserves += 1;
      server.maxInFlightReserves = Math.max(
        server.maxInFlightReserves,
        server.inFlightReserves,
      );
      const behaviour = server.reserveBehaviour();
      await scheduler.yieldAt(`http:reserve(${behaviour})`);
      server.inFlightReserves -= 1;
      if (!token || revoked.has(token)) {
        server.reserveFailures += 1;
        record(401);
        return json(401, {
          error: { code: 'auth.invalid_token', message: 'Sign in again.' },
        });
      }
      if (behaviour === 'network_throw') {
        server.reserveFailures += 1;
        record(0);
        throw new TypeError('Network request failed');
      }
      if (behaviour === 'server_500') {
        server.reserveFailures += 1;
        record(500);
        return json(500, {
          error: { code: 'internal', message: 'Something went wrong.' },
        });
      }
      if (!server.premium && server.available <= 0) {
        server.reserveFailures += 1;
        record(402);
        return json(402, {
          error: {
            code: 'access.paywall_required',
            message: 'Upgrade to keep rating strokes.',
          },
        });
      }
      if (behaviour === 'not_reserved') {
        // A permit the server reports as already settled (e.g. a replayed
        // idempotency key): no allowance unit is held for it.
        server.reserveFailures += 1;
        record(200);
        return json(200, {
          permit: {
            id: `stale-permit-${++permitSeq}`,
            accessSource: server.premium ? 'premium' : 'free',
            status: 'consumed',
            expiresAt: '2099-01-01T00:00:00.000Z',
          },
          access: accessSnapshot(),
        });
      }
      const reuse = behaviour === 'duplicate_permit_id' && lastPermitId;
      const id = reuse ? lastPermitId! : `permit-${++permitSeq}`;
      lastPermitId = id;
      const accessSource = server.premium ? 'premium' : 'free';
      if (!server.premium) server.available -= 1;
      if (!reuse) {
        server.ledger.set(id, {
          id,
          token,
          accessSource,
          status: 'reserved',
          releaseOutcome: null,
          releaseCount: 0,
        });
      }
      server.reserves += 1;
      record(200);
      return json(200, {
        permit: {
          id,
          accessSource,
          status: 'reserved',
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
        access: accessSnapshot(),
      });
    }

    const finalize = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(path);
    if (finalize) {
      const behaviour = server.finalizeBehaviour();
      server.finalizeCalls += 1;
      await scheduler.yieldAt(`http:finalize(${behaviour})`);
      if (!token || revoked.has(token)) {
        server.finalizeUnauthorized += 1;
        record(401);
        return json(401, {
          error: { code: 'auth.invalid_token', message: 'Sign in again.' },
        });
      }
      if (behaviour === 'network_throw') {
        record(0);
        throw new TypeError('Network request failed');
      }
      if (behaviour === 'server_500') {
        record(500);
        return json(500, {
          error: { code: 'internal', message: 'Something went wrong.' },
        });
      }
      const permitId = decodeURIComponent(finalize[1]!);
      const entry = server.ledger.get(permitId);
      if (!entry) {
        server.finalizeUnknownPermit += 1;
        record(404);
        return json(404, {
          error: {
            code: 'access.permit_not_found',
            message: 'Unknown permit.',
          },
        });
      }
      const body = init?.body
        ? (JSON.parse(init.body) as { outcome?: string })
        : {};
      entry.releaseCount += 1;
      if (entry.status === 'reserved') {
        entry.status = 'released';
        entry.releaseOutcome = body.outcome ?? null;
        if (entry.accessSource === 'free') server.available += 1;
      }
      record(200);
      return json(200, { permit: { id: permitId, status: 'released' } });
    }

    record(404);
    return json(404, { error: { code: 'not_found', message: path } });
  }

  return server;
}
