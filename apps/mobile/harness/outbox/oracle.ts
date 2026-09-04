import type { Rng } from './prng';

/**
 * Randomized network + server oracle behind the REAL `createTransport` fetch
 * client. It stands in for `fetch` and keeps authoritative server-side state
 * (sessions created, shots stored per bearer) so the harness can tell a
 * client-side receipt that was earned from one that was fabricated, and can
 * count how often the client re-submits a shot the server already holds.
 *
 * Server semantics mirror supabase/functions/api + apply_synced_shot:
 *   - shot with unknown sessionId  → rejected `shot.session_not_found`
 *   - shot already stored          → accepted again (idempotent upsert)
 *   - missing analysisPermitId     → rejected `shot.invalid` (contract verdict)
 *   - finalize of unknown session  → 404 `session.not_found`
 */

export type RequestOutcome =
  | 'ok'
  | 'offline'
  | 'timeout'
  | 'http_500'
  | 'http_502'
  | 'http_503'
  | 'http_401'
  | 'http_408'
  | 'http_429'
  | 'http_400'
  | 'http_403'
  | 'http_404'
  | 'http_409'
  | 'http_422'
  | 'response_lost'
  | 'malformed_body'
  | 'wrong_shape';

export type OutcomeWeights = ReadonlyArray<readonly [RequestOutcome, number]>;

export interface NetworkProfile {
  name: string;
  weights: OutcomeWeights;
}

export const NETWORK_PROFILES: readonly NetworkProfile[] = [
  { name: 'healthy', weights: [['ok', 1]] },
  {
    name: 'flaky',
    weights: [
      ['ok', 55],
      ['offline', 15],
      ['timeout', 5],
      ['http_500', 6],
      ['http_502', 3],
      ['http_503', 6],
      ['http_429', 5],
      ['http_401', 3],
      ['response_lost', 2],
    ],
  },
  {
    name: 'hostile',
    weights: [
      ['ok', 25],
      ['offline', 10],
      ['timeout', 5],
      ['http_500', 8],
      ['http_503', 7],
      ['http_408', 3],
      ['http_429', 6],
      ['http_401', 5],
      ['http_400', 5],
      ['http_403', 4],
      ['http_404', 4],
      ['http_409', 4],
      ['http_422', 4],
      ['response_lost', 4],
      ['malformed_body', 3],
      ['wrong_shape', 3],
    ],
  },
  {
    name: 'offline',
    weights: [
      ['offline', 9],
      ['timeout', 1],
    ],
  },
  {
    name: 'permanent-4xx',
    weights: [
      ['http_400', 3],
      ['http_403', 2],
      ['http_409', 2],
      ['http_422', 3],
      ['ok', 2],
    ],
  },
];

export function healthyProfile(): NetworkProfile {
  const profile = NETWORK_PROFILES[0];
  if (!profile) throw new Error('missing healthy profile');
  return profile;
}

/** Whether the outcome is classified as permanent by the client's contract
 * (ApiError 4xx other than 401/408/429). Everything else keeps the budget. */
export function isPermanentOutcome(outcome: RequestOutcome): boolean {
  return (
    outcome === 'http_400' ||
    outcome === 'http_403' ||
    outcome === 'http_404' ||
    outcome === 'http_409' ||
    outcome === 'http_422'
  );
}

/** Per-shot server fate chosen when the shot is created. */
export type ShotFate =
  | { kind: 'accept' }
  | { kind: 'reject_permanent'; code: string }
  | { kind: 'reject_transient_then_accept'; code: string; times: number }
  | { kind: 'unacknowledged_then_accept'; times: number };

export interface ShotWire {
  id: string;
  analysisPermitId?: unknown;
  sessionId?: unknown;
}

export interface RequestLogEntry {
  n: number;
  path: string;
  bearer: string | null;
  outcome: RequestOutcome;
  shotIds: string[];
  trialIds: string[];
  sessionId: string | null;
  acceptedIds: string[];
  rejected: Array<{ id: string; code: string }>;
  status: number;
}

interface UserState {
  sessions: Set<string>;
  shots: Map<string, { sessionId: string | null; acceptCount: number }>;
  trials: Set<string>;
}

export interface OracleHooks {
  /** Invoked for every /v1/shots:sync request before the server acts. */
  onShotsRequest?(bearer: string | null, shotIds: string[]): void;
  /** Invoked while a request is "in flight" — lets the model interleave. */
  midFlight?(): Promise<void>;
}

export class NetworkOracle {
  private readonly users = new Map<string, UserState>();
  readonly log: RequestLogEntry[] = [];
  private readonly fates = new Map<string, ShotFate>();
  private readonly transientSeen = new Map<string, number>();
  private readonly unackSeen = new Map<string, number>();
  private readonly trialFates = new Map<
    string,
    'accept' | 'permanent' | 'transient'
  >();
  profile: NetworkProfile;
  /** Set for the next request only; consumed on use. */
  forcedOutcome: RequestOutcome | null = null;
  hooks: OracleHooks = {};
  private nextRequest = 1;
  /** How many times a shot id was received while already stored. */
  idempotentReplays = 0;
  /** Requests answered with each outcome. */
  readonly outcomeMatrix = new Map<RequestOutcome, number>();

  constructor(
    private readonly rng: Rng,
    profile: NetworkProfile,
  ) {
    this.profile = profile;
  }

  setShotFate(shotId: string, fate: ShotFate): void {
    this.fates.set(shotId, fate);
  }

  setTrialFate(
    trialId: string,
    fate: 'accept' | 'permanent' | 'transient',
  ): void {
    this.trialFates.set(trialId, fate);
  }

  private user(bearer: string): UserState {
    let state = this.users.get(bearer);
    if (!state) {
      state = { sessions: new Set(), shots: new Map(), trials: new Set() };
      this.users.set(bearer, state);
    }
    return state;
  }

  hasSession(bearer: string, sessionId: string): boolean {
    return this.users.get(bearer)?.sessions.has(sessionId) ?? false;
  }

  /**
   * The server forgets a session it had accepted (rolled back / deleted
   * server-side). Stored shots keep their sessionId; only NEW shots naming
   * the session are rejected `shot.session_not_found` until it is recreated.
   */
  dropSession(bearer: string, sessionId: string): boolean {
    return this.users.get(bearer)?.sessions.delete(sessionId) ?? false;
  }

  hasStoredShot(bearer: string, shotId: string): boolean {
    return this.users.get(bearer)?.shots.has(shotId) ?? false;
  }

  storedShotCount(bearer: string): number {
    return this.users.get(bearer)?.shots.size ?? 0;
  }

  /** Every stored shot: [bearer, shotId, times the server stored/accepted it]. */
  storedShots(): Array<[string, string, number]> {
    const out: Array<[string, string, number]> = [];
    for (const [bearer, state] of this.users) {
      for (const [id, shot] of state.shots)
        out.push([bearer, id, shot.acceptCount]);
    }
    return out;
  }

  drawOutcome(): RequestOutcome {
    if (this.forcedOutcome) {
      const forced = this.forcedOutcome;
      this.forcedOutcome = null;
      return forced;
    }
    return this.rng.weighted(this.profile.weights);
  }

  /** The `fetch` replacement installed on globalThis while a drain runs. */
  fetch = async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['authorization'] ?? headers['Authorization'];
    const bearer = auth ? auth.replace(/^Bearer /, '') : null;
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    const outcome = this.drawOutcome();
    this.outcomeMatrix.set(outcome, (this.outcomeMatrix.get(outcome) ?? 0) + 1);

    const entry: RequestLogEntry = {
      n: this.nextRequest++,
      path,
      bearer,
      outcome,
      shotIds: [],
      trialIds: [],
      sessionId: null,
      acceptedIds: [],
      rejected: [],
      status: 0,
    };
    this.log.push(entry);

    if (path === '/v1/shots:sync') {
      const shots = ((body as { shots?: unknown[] } | null)?.shots ??
        []) as ShotWire[];
      entry.shotIds = shots.map(s => (typeof s.id === 'string' ? s.id : ''));
      this.hooks.onShotsRequest?.(bearer, entry.shotIds);
    }

    if (this.hooks.midFlight) await this.hooks.midFlight();

    if (outcome === 'timeout') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new Error('The operation was aborted')),
        );
      });
    }
    if (outcome === 'offline') {
      throw new TypeError('Network request failed');
    }

    const httpError = /^http_(\d+)$/.exec(outcome);
    if (httpError && httpError[1]) {
      const status = Number(httpError[1]);
      entry.status = status;
      const code =
        status === 401
          ? 'auth.required'
          : status === 429
            ? 'rate.limited'
            : status === 408
              ? 'network.timeout'
              : status >= 500
                ? 'internal'
                : `contract.${status}`;
      return jsonResponse(status, {
        error: { code, message: `HTTP ${status}` },
      });
    }

    // The server processes the request (ok / response_lost / malformed_body /
    // wrong_shape all commit state; only what the client SEES differs).
    const reply = (status: number, payload: unknown): Response => {
      if (outcome === 'response_lost') {
        entry.status = 0;
        throw new TypeError('Network request failed');
      }
      entry.status = status;
      if (outcome === 'malformed_body')
        return textResponse(status, '<html>gateway</html>');
      if (outcome === 'wrong_shape') {
        return jsonResponse(
          status,
          this.rng.pick([
            {},
            { acceptedIds: 'nope' },
            { rejected: null, acceptedIds: [] },
            [],
            { data: payload },
            null,
          ]),
        );
      }
      return jsonResponse(status, payload);
    };
    if (bearer === null) {
      return reply(401, {
        error: { code: 'auth.required', message: 'Sign in required.' },
      });
    }
    const user = this.user(bearer);
    let payload: unknown;
    if (path === '/v1/shots:sync') {
      const shots = ((body as { shots?: unknown[] } | null)?.shots ??
        []) as ShotWire[];
      const acceptedIds: string[] = [];
      const rejected: Array<{ id: string; code: string; message: string }> = [];
      for (const shot of shots) {
        const id = typeof shot.id === 'string' ? shot.id : '';
        if (id === '') {
          rejected.push({ id, code: 'shot.invalid', message: 'id required' });
          continue;
        }
        if (
          typeof shot.analysisPermitId !== 'string' ||
          !shot.analysisPermitId
        ) {
          rejected.push({
            id,
            code: 'shot.invalid',
            message: 'permit required',
          });
          continue;
        }
        const sessionId =
          typeof shot.sessionId === 'string' ? shot.sessionId : null;
        if (sessionId !== null && !user.sessions.has(sessionId)) {
          rejected.push({
            id,
            code: 'shot.session_not_found',
            message: 'Session not found or not yours.',
          });
          continue;
        }
        const existing = user.shots.get(id);
        if (existing) {
          existing.acceptCount += 1;
          this.idempotentReplays += 1;
          acceptedIds.push(id);
          continue;
        }
        const fate = this.fates.get(id) ?? { kind: 'accept' };
        if (fate.kind === 'reject_permanent') {
          rejected.push({ id, code: fate.code, message: 'contract verdict' });
          continue;
        }
        if (fate.kind === 'reject_transient_then_accept') {
          const seen = this.transientSeen.get(id) ?? 0;
          if (seen < fate.times) {
            this.transientSeen.set(id, seen + 1);
            rejected.push({ id, code: fate.code, message: 'retry later' });
            continue;
          }
        }
        if (fate.kind === 'unacknowledged_then_accept') {
          const seen = this.unackSeen.get(id) ?? 0;
          if (seen < fate.times) {
            this.unackSeen.set(id, seen + 1);
            continue;
          }
        }
        user.shots.set(id, { sessionId, acceptCount: 1 });
        acceptedIds.push(id);
      }
      entry.acceptedIds = acceptedIds;
      entry.rejected = rejected.map(r => ({ id: r.id, code: r.code }));
      payload = { acceptedIds, rejected };
    } else if (path === '/v1/sessions') {
      const session = body as { id?: unknown } | null;
      if (!session || typeof session.id !== 'string') {
        return reply(400, {
          error: { code: 'session.invalid', message: 'id required' },
        });
      }
      user.sessions.add(session.id);
      entry.sessionId = session.id;
      payload = { session: { id: session.id } };
    } else if (/^\/v1\/sessions\/[^/]+\/finalize$/.test(path)) {
      const id = decodeURIComponent(path.split('/')[3] ?? '');
      entry.sessionId = id;
      if (!user.sessions.has(id)) {
        return reply(404, {
          error: { code: 'session.not_found', message: 'Session not found.' },
        });
      }
      payload = { session: { id, finalized: true } };
    } else if (path === '/v1/me/evaluation/trials') {
      const trials = ((body as { trials?: unknown[] } | null)?.trials ??
        []) as Array<{ trialId: string }>;
      const acceptedTrialIds: string[] = [];
      const rejected: Array<{
        trialId: string;
        code: string;
        message: string;
      }> = [];
      for (const trial of trials) {
        entry.trialIds.push(trial.trialId);
        const fate = this.trialFates.get(trial.trialId) ?? 'accept';
        if (fate === 'permanent' && !user.trials.has(trial.trialId)) {
          rejected.push({
            trialId: trial.trialId,
            code: 'evaluation.trial_invalid',
            message: 'schema',
          });
          continue;
        }
        if (fate === 'transient' && !user.trials.has(trial.trialId)) {
          this.trialFates.set(trial.trialId, 'accept');
          rejected.push({
            trialId: trial.trialId,
            code: 'evaluation.trial_write_failed',
            message: 'retry',
          });
          continue;
        }
        user.trials.add(trial.trialId);
        acceptedTrialIds.push(trial.trialId);
      }
      entry.acceptedIds = acceptedTrialIds;
      entry.rejected = rejected.map(r => ({ id: r.trialId, code: r.code }));
      payload = { acceptedTrialIds, rejected };
    } else {
      return reply(404, {
        error: { code: 'route.unknown', message: path },
      });
    }

    return reply(200, payload);
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => body,
  } as unknown as Response;
}

function textResponse(status: number, text: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    json: async () => {
      throw new SyntaxError(`Unexpected token in ${text}`);
    },
  } as unknown as Response;
}
