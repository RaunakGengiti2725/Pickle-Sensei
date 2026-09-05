/**
 * Deterministic fake of the Supabase edge API the Home surface and the auth
 * runtime talk to: account bootstrap, refresh rotation, logout, /v1/me,
 * /v1/progress and /v1/rank. Every request is recorded with the bearer it
 * carried, which account that bearer belonged to, the active data owner at
 * request time and the outcome, so the harness can prove that no response
 * for one account is ever rendered for another and that a rotated bearer is
 * picked up by the next request.
 */

export interface StressAccount {
  /** canonical app user id (UUID) */
  id: string;
  email: string;
  /** the provider ID token the mocked Google SDK hands back for this account */
  idToken: string;
  /** rank the server reports; null = honestly unranked */
  rank: { rating: number; tier: string } | null;
  /** streak the canonical progress endpoint reports */
  progressStreakDays: number;
}

export type RouteMode =
  'ok' | 'error-500' | 'network' | 'hang' | 'malformed-200' | 'slow';

export interface RequestRecord {
  seq: number;
  at: number;
  method: string;
  path: string;
  bearer: string | null;
  /** account the bearer was minted for (null = unknown/foreign bearer) */
  bearerAccount: string | null;
  /** was the bearer the live one for that account at request time */
  bearerCurrent: boolean;
  ownerAtRequest: string;
  outcome: string;
  proc: number;
}

interface IssuedTokens {
  access: string;
  refresh: string;
  /** unix seconds */
  exp: number;
  accountId: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class ScriptedApi {
  readonly base: string;
  readonly accounts = new Map<string, StressAccount>();
  readonly requests: RequestRecord[] = [];
  readonly unexpected: string[] = [];
  /** live tokens: refresh token → issued pair */
  private readonly byRefresh = new Map<string, IssuedTokens>();
  /** every access token ever minted → its pair (for attribution) */
  private readonly byAccess = new Map<string, IssuedTokens>();
  /** account id → the currently live access token */
  private readonly liveAccess = new Map<string, string>();
  progressMode: RouteMode = 'ok';
  rankMode: RouteMode = 'ok';
  /** latency for progress/rank when mode is 'slow' (ms) */
  slowMs = 3_000;
  /** base latency for every route (ms) */
  latencyMs = 20;
  bearerTtlSec = 3_600;
  proc = 0;
  /** tokens the client is told about; the harness verifies they were adopted */
  readonly rotations: { at: number; accountId: string; access: string }[] = [];
  /** latency for /v1/auth/refresh (ms); defaults to latencyMs */
  refreshLatencyMs: number | null = null;
  private seq = 0;
  private mint = 0;
  /** in-flight response timers, dropped on kill() */
  private readonly inflight = new Map<
    number,
    { timer: ReturnType<typeof setTimeout>; record: RequestRecord }
  >();
  private timerSeq = 0;
  private readonly superseded = new Map<string, number>();

  constructor(
    base: string,
    private readonly ownerAt: () => string,
  ) {
    this.base = base;
  }

  /**
   * The OS killed the process: responses still in flight are never
   * delivered (their promises never settle). Server-side state is untouched.
   */
  kill(): number {
    let dropped = 0;
    for (const entry of this.inflight.values()) {
      clearTimeout(entry.timer);
      if (entry.record.outcome === 'pending') entry.record.outcome = 'killed';
      dropped += 1;
    }
    this.inflight.clear();
    this.proc += 1;
    return dropped;
  }

  /** Server-side revocation: every live refresh token of the account dies. */
  revokeAccount(accountId: string): number {
    let revoked = 0;
    for (const [refresh, issued] of [...this.byRefresh.entries()]) {
      if (issued.accountId === accountId) {
        this.byRefresh.delete(refresh);
        revoked += 1;
      }
    }
    this.liveAccess.delete(accountId);
    return revoked;
  }

  pendingCount(): number {
    return this.inflight.size;
  }

  /** When a newer access token replaced this one for its account (ms), or
   * null while it is still the live bearer / never was one. */
  supersededAt(access: string): number | null {
    return this.superseded.get(access) ?? null;
  }

  addAccount(account: StressAccount): void {
    this.accounts.set(account.id, account);
  }

  accountForIdToken(idToken: string): StressAccount | null {
    for (const account of this.accounts.values()) {
      if (account.idToken === idToken) return account;
    }
    return null;
  }

  /** Seed a persisted (Keychain) refresh token for an account. */
  seedRefreshToken(accountId: string, refresh: string): IssuedTokens {
    const issued: IssuedTokens = {
      access: `access-seed-${accountId.slice(0, 8)}`,
      refresh,
      exp: Math.floor(Date.now() / 1000) + this.bearerTtlSec,
      accountId,
    };
    this.byRefresh.set(refresh, issued);
    this.byAccess.set(issued.access, issued);
    this.liveAccess.set(accountId, issued.access);
    return issued;
  }

  issue(accountId: string): IssuedTokens {
    this.mint += 1;
    const issued: IssuedTokens = {
      access: `access-${accountId.slice(0, 8)}-${this.mint}`,
      refresh: `refresh-${accountId.slice(0, 8)}-${this.mint}`,
      exp: Math.floor(Date.now() / 1000) + this.bearerTtlSec,
      accountId,
    };
    this.byRefresh.set(issued.refresh, issued);
    this.byAccess.set(issued.access, issued);
    const previous = this.liveAccess.get(accountId);
    if (previous) this.superseded.set(previous, Date.now());
    this.liveAccess.set(accountId, issued.access);
    this.rotations.push({ at: Date.now(), accountId, access: issued.access });
    return issued;
  }

  /** Server-side rotation the client learns about on its next refresh. */
  isLiveAccess(accountId: string, access: string): boolean {
    return this.liveAccess.get(accountId) === access;
  }

  private delay(
    ms: number,
    signal: AbortSignal | null | undefined,
    record: RequestRecord,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      this.timerSeq += 1;
      const id = this.timerSeq;
      const timer = setTimeout(() => {
        this.inflight.delete(id);
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      this.inflight.set(id, { timer, record });
      const onAbort = () => {
        clearTimeout(timer);
        this.inflight.delete(id);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort);
    });
  }

  private async modeResponse(
    mode: RouteMode,
    record: RequestRecord,
    signal: AbortSignal | null | undefined,
    ok: () => Response,
  ): Promise<Response> {
    switch (mode) {
      case 'hang':
        await this.delay(10 * 60_000, signal, record);
        record.outcome = 'hang-elapsed';
        return new Response(null, { status: 599 });
      case 'slow':
        await this.delay(this.slowMs, signal, record);
        record.outcome = '200-slow';
        return ok();
      case 'error-500':
        await this.delay(this.latencyMs, signal, record);
        record.outcome = '500';
        return jsonResponse(500, { error: { message: 'boom' } });
      case 'network':
        await this.delay(this.latencyMs, signal, record);
        record.outcome = 'network-error';
        throw new TypeError('Network request failed');
      case 'malformed-200':
        await this.delay(this.latencyMs, signal, record);
        record.outcome = '200-malformed';
        return new Response('<html>not json</html>', { status: 200 });
      case 'ok':
      default:
        await this.delay(this.latencyMs, signal, record);
        record.outcome = '200';
        return ok();
    }
  }

  readonly fetch = async (
    url: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const path = url.startsWith(this.base) ? url.slice(this.base.length) : url;
    const headers = (init.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? headers['authorization'] ?? null;
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const issued = bearer ? this.byAccess.get(bearer) : undefined;
    this.seq += 1;
    const record: RequestRecord = {
      seq: this.seq,
      at: Date.now(),
      method: init.method ?? 'GET',
      path,
      bearer,
      bearerAccount: issued?.accountId ?? null,
      bearerCurrent: issued
        ? this.isLiveAccess(issued.accountId, issued.access)
        : false,
      ownerAtRequest: this.ownerAt(),
      outcome: 'pending',
      proc: this.proc,
    };
    this.requests.push(record);
    const signal = init.signal;
    try {
      if (path === '/v1/account/bootstrap') {
        await this.delay(this.latencyMs, signal, record);
        const account = bearer ? this.accountForIdToken(bearer) : null;
        if (!account) {
          record.outcome = '401-unknown-id-token';
          return jsonResponse(401, { error: { message: 'bad id token' } });
        }
        const tokens = this.issue(account.id);
        record.outcome = `200-bootstrap:${account.id.slice(0, 8)}`;
        return jsonResponse(200, {
          user: { id: account.id, email: account.email },
          onboardingState: 'complete',
          session: {
            accessToken: tokens.access,
            refreshToken: tokens.refresh,
            expiresAt: tokens.exp,
          },
        });
      }
      if (path === '/v1/auth/refresh') {
        await this.delay(
          this.refreshLatencyMs ?? this.latencyMs,
          signal,
          record,
        );
        const body = JSON.parse(String(init.body ?? '{}')) as {
          refreshToken?: string;
        };
        const prior = this.byRefresh.get(String(body.refreshToken ?? ''));
        if (!prior) {
          record.outcome = '401-unknown-refresh';
          return jsonResponse(401, { error: { message: 'revoked' } });
        }
        this.byRefresh.delete(prior.refresh);
        const next = this.issue(prior.accountId);
        record.outcome = `200-rotated:${next.access}`;
        return jsonResponse(200, {
          session: {
            accessToken: next.access,
            refreshToken: next.refresh,
            expiresAt: next.exp,
          },
        });
      }
      if (path === '/v1/auth/logout') {
        await this.delay(this.latencyMs, signal, record);
        if (issued) {
          this.byRefresh.delete(issued.refresh);
          if (this.liveAccess.get(issued.accountId) === issued.access) {
            this.liveAccess.delete(issued.accountId);
          }
        }
        record.outcome = '204';
        return new Response(null, { status: 204 });
      }
      if (!issued) {
        record.outcome = '401-unknown-bearer';
        await this.delay(this.latencyMs, signal, record);
        return jsonResponse(401, { error: { message: 'unauthorized' } });
      }
      if (issued.exp * 1000 <= Date.now()) {
        record.outcome = '401-expired-bearer';
        await this.delay(this.latencyMs, signal, record);
        return jsonResponse(401, { error: { message: 'expired' } });
      }
      const account = this.accounts.get(issued.accountId);
      if (!account) {
        record.outcome = '401-deleted-account';
        await this.delay(this.latencyMs, signal, record);
        return jsonResponse(401, { error: { message: 'gone' } });
      }
      if (path === '/v1/me') {
        await this.delay(this.latencyMs, signal, record);
        record.outcome = '200';
        return jsonResponse(200, {
          onboardingState: 'complete',
          profile: {
            skill_level: 'intermediate',
            handedness: 'right',
            primary_goal: 'consistency',
            biggest_problem: 'popups',
            first_name: `Server-${account.id.slice(0, 4)}`,
          },
        });
      }
      if (path === '/v1/progress') {
        return await this.modeResponse(this.progressMode, record, signal, () =>
          jsonResponse(200, {
            series: [
              {
                day: '2026-03-01',
                shot_type: 'forehand_drive',
                scoring_model_version: 'v1',
                shot_count: 3,
                avg_score: 61,
                best_score: 72,
              },
            ],
            improving: [{ checkpoint: 'contact_point', delta: 0.4 }],
            needsAttention: [{ checkpoint: 'follow_through', avg: 4.1 }],
            streak: {
              currentDays: account.progressStreakDays,
              longestDays: Math.max(account.progressStreakDays, 4),
              practicedToday: false,
              lastPracticeDate: '2026-02-28',
            },
          }),
        );
      }
      if (path === '/v1/rank') {
        return await this.modeResponse(this.rankMode, record, signal, () =>
          jsonResponse(200, {
            rank: account.rank
              ? {
                  rating: account.rank.rating,
                  tier: account.rank.tier,
                  techniqueCount: 1,
                  scoredShotCount: 12,
                  updatedAt: '2026-02-28T10:00:00.000Z',
                  techniques: [
                    {
                      shot_type: 'forehand_drive',
                      score: account.rank.rating,
                      captured_at: '2026-02-28T10:00:00.000Z',
                      sampled_count: 12,
                    },
                  ],
                }
              : null,
          }),
        );
      }
      this.unexpected.push(path);
      record.outcome = '404-unexpected';
      return jsonResponse(404, { error: { message: 'unexpected route' } });
    } catch (error) {
      if (record.outcome === 'pending') {
        record.outcome =
          error instanceof DOMException && error.name === 'AbortError'
            ? 'aborted-by-client'
            : 'threw';
      }
      throw error;
    }
  };
}
