import { focusForGoal } from '../../src/state/profile';

/**
 * Scripted account API for the onboarding lifecycle stress suite.
 *
 * Implements exactly the routes the real stores hit while a player is
 * onboarded — `/v1/account/bootstrap`, `/v1/auth/refresh`, `/v1/auth/logout`,
 * `GET /v1/me`, `PUT /v1/me/onboarding` — over the fake jest clock, with
 * per-request latency and fault modes chosen by the scenario. Every request
 * is recorded so the oracle can prove which account each write landed on.
 */

export interface ServerAccount {
  id: string;
  email: string;
  identityToken: string;
}

export interface StoredProfile {
  firstName?: string;
  gender?: string;
  skillLevel: string;
  handedness: string;
  goal: string;
  biggestProblem: string;
}

export interface RecordedRequest {
  /** ms since scenario start (fake clock) */
  at: number;
  /** process generation that issued it (bumped on kill/relaunch) */
  proc: number;
  method: string;
  path: string;
  /** account the bearer / identity token resolved to, null when unknown */
  account: string | null;
  body: unknown;
  outcome: string;
  /** ms since scenario start when the response was delivered */
  resolvedAt: number | null;
}

/** How `PUT /v1/me/onboarding` behaves for the NEXT request(s). */
export type PutMode =
  'ok' | 'fail-500-once' | 'fail-network-once' | 'hang-then-ok' | 'slow';

/** Whether a rotated-away bearer keeps working until its expiry (Supabase
 * semantics) or dies with the rotation (strict gateway). */
export type BearerPolicy = 'until-expiry' | 'invalidate-on-rotate';

function jsonResponse(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status });
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface Bearer {
  account: string;
  expiresAtMs: number;
  valid: boolean;
}

export class ScriptedAccountServer {
  readonly accounts = new Map<string, ServerAccount>();
  readonly profiles = new Map<string, StoredProfile>();
  readonly requests: RecordedRequest[] = [];
  readonly unexpected: string[] = [];
  private readonly bearers = new Map<string, Bearer>();
  private readonly refreshTokens = new Map<string, string>();
  private readonly revokedRefresh = new Set<string>();
  private issued = 0;

  /** current process generation */
  proc = 1;
  latencyMs = 0;
  putLatencyMs = 0;
  putMode: PutMode = 'ok';
  bearerPolicy: BearerPolicy = 'until-expiry';
  bearerTtlSec = 3600;
  /** every refresh is refused (the account was signed out elsewhere) */
  refuseRefresh = false;
  /** hung PUT requests waiting for `releaseHung()` */
  private hung: (() => void)[] = [];
  private putFailuresLeft = 0;
  now: () => number = () => 0;
  inflight = 0;
  maxInflight = 0;

  constructor() {
    this.fetch = this.fetch.bind(this);
  }

  addAccount(account: ServerAccount): void {
    this.accounts.set(account.id, account);
  }

  /** Mints a refresh token for a persisted-session install. */
  seedRefreshToken(accountId: string, token: string): void {
    this.refreshTokens.set(token, accountId);
  }

  /** The bearer currently held by the client for `accountId` — used by the
   * oracle to detect a stale-bearer write, never by production code. */
  bearerAccount(token: string): string | null {
    return this.bearers.get(token)?.account ?? null;
  }

  /** "Signed out everywhere": every refresh token and bearer the account
   * holds dies; the next refresh answers 401 and in-flight bearers fail. */
  revokeAccountSessions(accountId: string): void {
    for (const [token, account] of this.refreshTokens) {
      if (account === accountId) {
        this.refreshTokens.delete(token);
        this.revokedRefresh.add(token);
      }
    }
    for (const bearer of this.bearers.values()) {
      if (bearer.account === accountId) bearer.valid = false;
    }
  }

  releaseHung(): number {
    const count = this.hung.length;
    for (const release of this.hung) release();
    this.hung = [];
    return count;
  }

  hungCount(): number {
    return this.hung.length;
  }

  private mintSession(accountId: string): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } {
    this.issued += 1;
    const accessToken = `access-${accountId.slice(0, 8)}-${this.issued}`;
    const refreshToken = `refresh-${accountId.slice(0, 8)}-${this.issued}`;
    const expiresAtMs = Date.now() + this.bearerTtlSec * 1000;
    this.bearers.set(accessToken, {
      account: accountId,
      expiresAtMs,
      valid: true,
    });
    this.refreshTokens.set(refreshToken, accountId);
    return {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(expiresAtMs / 1000),
    };
  }

  private authenticate(init: RequestInit | undefined): Bearer | null {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? headers['authorization'] ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const bearer = this.bearers.get(token);
    if (!bearer || !bearer.valid || bearer.expiresAtMs <= Date.now()) {
      return null;
    }
    return bearer;
  }

  /**
   * A request issued by process `proc` settles only while that process is
   * still alive; when the OS killed it (`this.proc` moved on) the pending
   * fetch is never observed again — exactly like a socket dying with its
   * process. `died` records the fact; the timer itself is consumed so it
   * cannot show up as a leak.
   */
  private delay(ms: number, proc: number, died: () => void): Promise<void> {
    return new Promise(resolve =>
      setTimeout(
        () => {
          if (this.proc === proc) resolve();
          else died();
        },
        Math.max(0, ms),
      ),
    );
  }

  private hangUntilReleased(proc: number, died: () => void): Promise<void> {
    return new Promise(resolve => {
      this.hung.push(() => {
        if (this.proc === proc) resolve();
        else died();
      });
    });
  }

  private onboardingPayload(accountId: string): Record<string, unknown> {
    const profile = this.profiles.get(accountId);
    return profile
      ? {
          onboardingState: 'complete',
          profile: {
            first_name: profile.firstName ?? null,
            gender: profile.gender ?? null,
            skill_level: profile.skillLevel,
            handedness: profile.handedness,
            primary_goal: profile.goal,
            biggest_problem: profile.biggestProblem,
          },
        }
      : { onboardingState: 'pending', profile: null };
  }

  async fetch(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    const bodyText = typeof init?.body === 'string' ? init.body : null;
    let body: unknown = null;
    if (bodyText) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = bodyText;
      }
    }
    const record: RecordedRequest = {
      at: this.now(),
      proc: this.proc,
      method,
      path,
      account: null,
      body,
      outcome: 'pending',
      resolvedAt: null,
    };
    this.requests.push(record);
    this.inflight += 1;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    const proc = this.proc;
    const died = () => {
      if (record.outcome !== 'pending') return;
      record.outcome = 'died-with-process';
      record.resolvedAt = this.now();
      this.inflight -= 1;
    };
    const finish = (outcome: string, response: Response): Response => {
      record.outcome = outcome;
      record.resolvedAt = this.now();
      this.inflight -= 1;
      return response;
    };
    const fail = (outcome: string, error: Error): never => {
      record.outcome = outcome;
      record.resolvedAt = this.now();
      this.inflight -= 1;
      throw error;
    };
    // A route handler that throws is a harness bug, never a scripted outcome:
    // surface it in the record so the oracle refuses the row.
    const guarded = async (): Promise<Response> => {
      try {
        return await route();
      } catch (error) {
        if (record.outcome === 'pending') {
          record.outcome = `harness-error:${
            error instanceof Error ? error.message : String(error)
          }`;
          record.resolvedAt = this.now();
          this.inflight -= 1;
        }
        throw error;
      }
    };
    const route = async (): Promise<Response> => {
      const signal = init?.signal;
      const abortable = <T>(promise: Promise<T>): Promise<T> =>
        new Promise<T>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new Error('aborted'));
            return;
          }
          const onAbort = () => {
            // An abort raised by a process the OS already killed is unobservable.
            if (this.proc !== proc) {
              died();
              return;
            }
            reject(new Error('aborted'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          promise.then(
            value => {
              signal?.removeEventListener('abort', onAbort);
              resolve(value);
            },
            error => {
              signal?.removeEventListener('abort', onAbort);
              reject(error);
            },
          );
        });

      try {
        await abortable(this.delay(this.latencyMs, proc, died));
      } catch {
        return fail('aborted', new TypeError('Network request aborted'));
      }

      if (method === 'POST' && path === '/v1/account/bootstrap') {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const token = (headers['Authorization'] ?? '').replace(
          /^Bearer\s+/i,
          '',
        );
        const account = [...this.accounts.values()].find(
          a => a.identityToken === token,
        );
        if (!account) {
          return finish(
            '401',
            jsonResponse(401, {
              error: { message: 'Unknown identity token (simulated)' },
            }),
          );
        }
        record.account = account.id;
        const session = this.mintSession(account.id);
        return finish(
          `ok:${account.id.slice(0, 8)}`,
          jsonResponse(200, {
            user: { id: account.id, email: account.email },
            onboardingState: this.profiles.has(account.id)
              ? 'complete'
              : 'pending',
            session,
          }),
        );
      }

      if (method === 'POST' && path === '/v1/auth/refresh') {
        const token =
          body && typeof body === 'object'
            ? String((body as { refreshToken?: unknown }).refreshToken ?? '')
            : '';
        const accountId = this.refreshTokens.get(token);
        record.account = accountId ?? null;
        if (
          this.refuseRefresh ||
          !accountId ||
          this.revokedRefresh.has(token)
        ) {
          return finish(
            '401',
            jsonResponse(401, { error: { message: 'Refresh token refused' } }),
          );
        }
        // Strict single-use rotation: the presented token dies now, and the
        // bearer it produced follows the configured policy.
        this.refreshTokens.delete(token);
        this.revokedRefresh.add(token);
        if (this.bearerPolicy === 'invalidate-on-rotate') {
          for (const bearer of this.bearers.values()) {
            if (bearer.account === accountId) bearer.valid = false;
          }
        }
        const session = this.mintSession(accountId);
        return finish(
          `rotated:${session.refreshToken}`,
          jsonResponse(200, { session }),
        );
      }

      if (method === 'POST' && path === '/v1/auth/logout') {
        const bearer = this.authenticate(init);
        record.account = bearer?.account ?? null;
        if (bearer) {
          for (const [token, account] of this.refreshTokens) {
            if (account === bearer.account) this.refreshTokens.delete(token);
          }
          bearer.valid = false;
        }
        return finish(
          bearer ? 'ok' : '401',
          jsonResponse(bearer ? 204 : 401, {}),
        );
      }

      if (method === 'GET' && path === '/v1/me') {
        const bearer = this.authenticate(init);
        if (!bearer) {
          return finish(
            '401',
            jsonResponse(401, { error: { message: 'Bearer rejected' } }),
          );
        }
        record.account = bearer.account;
        return finish(
          'ok',
          jsonResponse(200, {
            user: { id: bearer.account },
            ...this.onboardingPayload(bearer.account),
          }),
        );
      }

      if (method === 'PUT' && path === '/v1/me/onboarding') {
        const bearer = this.authenticate(init);
        record.account = bearer?.account ?? null;
        try {
          if (this.putMode === 'hang-then-ok') {
            await abortable(this.hangUntilReleased(proc, died));
          } else if (this.putMode === 'slow') {
            await abortable(this.delay(this.putLatencyMs * 3, proc, died));
          } else {
            await abortable(this.delay(this.putLatencyMs, proc, died));
          }
        } catch {
          return fail('aborted', new TypeError('Network request aborted'));
        }
        if (!bearer) {
          return finish(
            '401',
            jsonResponse(401, { error: { message: 'Bearer rejected' } }),
          );
        }
        if (this.putMode === 'fail-500-once' && this.putFailuresLeft === 0) {
          this.putFailuresLeft = -1;
          return finish(
            '500',
            jsonResponse(500, {
              error: { message: 'Profile store unavailable' },
            }),
          );
        }
        if (
          this.putMode === 'fail-network-once' &&
          this.putFailuresLeft === 0
        ) {
          this.putFailuresLeft = -1;
          return fail('network', new TypeError('Network request failed'));
        }
        const input = body as Record<string, unknown> | null;
        if (
          !input ||
          typeof input['skillLevel'] !== 'string' ||
          typeof input['handedness'] !== 'string' ||
          typeof input['goal'] !== 'string' ||
          typeof input['biggestProblem'] !== 'string'
        ) {
          return finish(
            '400',
            jsonResponse(400, {
              error: { message: 'Invalid onboarding body' },
            }),
          );
        }
        const profile: StoredProfile = {
          skillLevel: input['skillLevel'],
          handedness: input['handedness'],
          goal: input['goal'],
          biggestProblem: input['biggestProblem'],
          ...(typeof input['firstName'] === 'string'
            ? { firstName: input['firstName'] }
            : {}),
          ...(typeof input['gender'] === 'string'
            ? { gender: input['gender'] }
            : {}),
        };
        this.profiles.set(bearer.account, profile);
        return finish(
          `saved:${bearer.account.slice(0, 8)}`,
          jsonResponse(200, {
            onboardingState: 'complete',
            recommendedCheckpoint: focusForGoal(profile.goal),
          }),
        );
      }

      this.unexpected.push(`${method} ${path}`);
      return finish(
        '404',
        jsonResponse(404, { error: { message: 'no route' } }),
      );
    };
    return guarded();
  }

  putsFor(accountId: string): RecordedRequest[] {
    return this.requests.filter(
      r =>
        r.method === 'PUT' &&
        r.path === '/v1/me/onboarding' &&
        r.account === accountId,
    );
  }
}
