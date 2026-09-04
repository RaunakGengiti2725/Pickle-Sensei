/**
 * Scripted API for the ProgressScreen lifecycle stress campaign.
 *
 * Replaces `globalThis.fetch` only. Two canonical accounts exist (A and B);
 * every access token names the account it was minted for, and every
 * account-scoped response carries an OWNER MARKER (the `/v1/progress`
 * improving-checkpoint `signal_owner_a` / `signal_owner_b`) so a response
 * that lands on the wrong user's screen is visible in the rendered tree.
 *
 * Latency is realised with `setTimeout` under Jest's fake clock; the harness
 * decides per call how long a request stays in flight and whether it fails.
 */

export interface StressAccount {
  key: 'a' | 'b';
  id: string;
  email: string;
  /** Apple identity token the mocked native module hands back */
  identityToken: string;
}

export const ACCOUNT_A: StressAccount = {
  key: 'a',
  id: 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa',
  email: 'owner-a@example.test',
  identityToken: 'apple-identity-a',
};

export const ACCOUNT_B: StressAccount = {
  key: 'b',
  id: 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb',
  email: 'owner-b@example.test',
  identityToken: 'apple-identity-b',
};

export const API_BASE = 'https://api.stress.test';

export function ownerMarker(account: StressAccount): string {
  return `signal_owner_${account.key}`;
}

export interface FetchRecord {
  seq: number;
  route: string;
  method: string;
  /** account the bearer was minted for (null when unauthenticated) */
  bearerOwner: 'a' | 'b' | null;
  bearer: string | null;
  issuedAt: number;
  settledAt: number | null;
  outcome: 'pending' | 'ok' | 'error' | 'network' | 'aborted' | 'revoked';
}

export interface FetchPolicy {
  latencyMs: (record: FetchRecord) => number;
  /** 'ok' | 'network' (throws TypeError) | '500' */
  outcome: (record: FetchRecord) => 'ok' | 'network' | '500';
}

const DEFAULT_POLICY: FetchPolicy = {
  latencyMs: () => 0,
  outcome: () => 'ok',
};

interface TokenPair {
  access: string;
  refresh: string;
  owner: 'a' | 'b';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class ScriptedBackend {
  readonly calls: FetchRecord[] = [];
  policy: FetchPolicy = DEFAULT_POLICY;
  /** access-token lifetime handed out on bootstrap/refresh (seconds) */
  accessLifetimeSec = 4 * 60;
  private seq = 0;
  private mint = 0;
  private readonly liveRefresh = new Map<string, TokenPair>();
  private readonly liveAccess = new Map<string, TokenPair>();
  /** refresh tokens the server revoked (permission revoked later) */
  private readonly revoked = new Set<string>();
  /** Rotated refresh token → its successor and the rotation instant. GoTrue
   * (`refresh_token_reuse_interval`, default 10s) answers a reuse inside
   * that window with the SAME successor session instead of refusing, so a
   * client whose rotation response was lost can recover if it comes back
   * quickly enough. */
  private readonly rotated = new Map<
    string,
    { successor: TokenPair; atMs: number }
  >();
  reuseIntervalMs = 10_000;

  /** Number of token pairs minted so far (monotonic; encoded in every
   * access token as its trailing `-N`). */
  get mintCount(): number {
    return this.mint;
  }

  /** Mint number of an access token this backend issued, or null. */
  static mintOf(bearer: string | null): number | null {
    if (!bearer) return null;
    const match = /^access-[ab]-(\d+)$/.exec(bearer);
    return match ? Number(match[1]) : null;
  }

  private issue(owner: 'a' | 'b'): TokenPair {
    this.mint += 1;
    const pair: TokenPair = {
      owner,
      access: `access-${owner}-${this.mint}`,
      refresh: `refresh-${owner}-${this.mint}`,
    };
    this.liveRefresh.set(pair.refresh, pair);
    this.liveAccess.set(pair.access, pair);
    return pair;
  }

  /** Server-side revocation of every session of `owner` (sign-out elsewhere,
   * password reset, account disabled). */
  revokeAll(owner: 'a' | 'b'): void {
    for (const [refresh, pair] of this.liveRefresh) {
      if (pair.owner === owner) {
        this.liveRefresh.delete(refresh);
        this.revoked.add(refresh);
      }
    }
    for (const [access, pair] of this.liveAccess) {
      if (pair.owner === owner) this.liveAccess.delete(access);
    }
  }

  pending(): FetchRecord[] {
    return this.calls.filter(call => call.outcome === 'pending');
  }

  callsTo(route: string): FetchRecord[] {
    return this.calls.filter(call => call.route === route);
  }

  private bearerOf(init: RequestInit | undefined): string | null {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const value = headers['Authorization'] ?? headers['authorization'];
    if (!value) return null;
    return value.replace(/^Bearer\s+/i, '');
  }

  private async wait(ms: number, signal: AbortSignal | null | undefined) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (ms <= 0) {
      await Promise.resolve();
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort);
    });
  }

  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const route = url.startsWith(API_BASE) ? url.slice(API_BASE.length) : url;
    const bearer = this.bearerOf(init);
    const bearerPair = bearer ? this.liveAccess.get(bearer) : undefined;
    const record: FetchRecord = {
      seq: (this.seq += 1),
      route,
      method: init?.method ?? 'GET',
      bearerOwner:
        bearerPair?.owner ??
        (bearer?.startsWith('access-a')
          ? 'a'
          : bearer?.startsWith('access-b')
            ? 'b'
            : null),
      bearer,
      issuedAt: Date.now(),
      settledAt: null,
      outcome: 'pending',
    };
    this.calls.push(record);
    try {
      await this.wait(this.policy.latencyMs(record), init?.signal);
      record.settledAt = Date.now();
      const outcome = this.policy.outcome(record);
      if (outcome === 'network') {
        record.outcome = 'network';
        throw new TypeError('Network request failed');
      }
      if (outcome === '500') {
        record.outcome = 'error';
        return jsonResponse(500, { error: { message: 'server error' } });
      }
      return this.respond(route, record, init);
    } catch (error) {
      if (record.outcome === 'pending') {
        record.settledAt = Date.now();
        record.outcome =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'aborted'
            : 'network';
      }
      throw error;
    }
  };

  private respond(
    route: string,
    record: FetchRecord,
    init: RequestInit | undefined,
  ): Response {
    const ok = (body: unknown) => {
      record.outcome = 'ok';
      return jsonResponse(200, body);
    };

    if (route === '/v1/account/bootstrap') {
      const identity = record.bearer;
      const account =
        identity === ACCOUNT_A.identityToken
          ? ACCOUNT_A
          : identity === ACCOUNT_B.identityToken
            ? ACCOUNT_B
            : null;
      if (!account) {
        record.outcome = 'error';
        return jsonResponse(401, { error: { message: 'bad identity token' } });
      }
      const pair = this.issue(account.key);
      record.bearerOwner = account.key;
      return ok({
        user: { id: account.id, email: account.email },
        onboardingState: 'complete',
        session: {
          accessToken: pair.access,
          refreshToken: pair.refresh,
          expiresAt: Math.floor(Date.now() / 1000) + this.accessLifetimeSec,
        },
      });
    }

    if (route === '/v1/auth/refresh') {
      let refreshToken: string | null = null;
      try {
        const body = JSON.parse(String(init?.body ?? '{}')) as {
          refreshToken?: unknown;
        };
        refreshToken =
          typeof body.refreshToken === 'string' ? body.refreshToken : null;
      } catch {
        refreshToken = null;
      }
      const pair = refreshToken ? this.liveRefresh.get(refreshToken) : null;
      const reuse = refreshToken ? this.rotated.get(refreshToken) : undefined;
      if (
        !pair &&
        reuse &&
        Date.now() - reuse.atMs <= this.reuseIntervalMs &&
        this.liveRefresh.has(reuse.successor.refresh)
      ) {
        record.bearerOwner = reuse.successor.owner;
        return ok({
          session: {
            accessToken: reuse.successor.access,
            refreshToken: reuse.successor.refresh,
            expiresAt: Math.floor(Date.now() / 1000) + this.accessLifetimeSec,
          },
        });
      }
      if (!pair) {
        record.outcome = 'revoked';
        return jsonResponse(401, {
          error: { message: 'The session could not be refreshed.' },
        });
      }
      // Strict single-use refresh rotation. The previous ACCESS token stays
      // valid until its own expiry, as a JWT does — a request that left with
      // it just before the rotation is still served.
      this.liveRefresh.delete(pair.refresh);
      const next = this.issue(pair.owner);
      this.rotated.set(pair.refresh, { successor: next, atMs: Date.now() });
      record.bearerOwner = pair.owner;
      return ok({
        session: {
          accessToken: next.access,
          refreshToken: next.refresh,
          expiresAt: Math.floor(Date.now() / 1000) + this.accessLifetimeSec,
        },
      });
    }

    if (route === '/v1/auth/logout') {
      record.outcome = 'ok';
      return new Response(null, { status: 204 });
    }

    // Everything below needs a live bearer.
    const pair = record.bearer ? this.liveAccess.get(record.bearer) : null;
    if (!pair) {
      record.outcome = 'revoked';
      return jsonResponse(401, { error: { message: 'Unauthorized' } });
    }
    const account = pair.owner === 'a' ? ACCOUNT_A : ACCOUNT_B;

    if (route === '/v1/me') {
      return ok({
        onboardingState: 'complete',
        profile: {
          skill_level: 'intermediate',
          handedness: 'right',
          primary_goal: 'consistency',
          biggest_problem: 'popups',
          first_name: `Owner${account.key.toUpperCase()}`,
        },
      });
    }

    if (route === '/v1/progress') {
      const today = new Date(Date.now()).toISOString().slice(0, 10);
      return ok({
        series: [
          {
            day: today,
            shot_type: 'dink',
            scoring_model_version: 'stress-v1',
            shot_count: account.key === 'a' ? 9 : 2,
            avg_score: account.key === 'a' ? 71 : 43,
            best_score: account.key === 'a' ? 82 : 51,
          },
        ],
        improving: [{ checkpoint: ownerMarker(account), delta: 0.4 }],
        needsAttention: [],
        streak: {
          currentDays: account.key === 'a' ? 6 : 1,
          longestDays: account.key === 'a' ? 12 : 1,
          practicedToday: true,
          lastPracticeDate: today,
        },
      });
    }

    if (route === '/v1/rank') {
      return ok({ rank: null });
    }

    if (route === '/v1/me/access') {
      return ok({
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
        scoredCount: 0,
      });
    }

    record.outcome = 'error';
    return jsonResponse(404, { error: { message: `unscripted ${route}` } });
  }
}
