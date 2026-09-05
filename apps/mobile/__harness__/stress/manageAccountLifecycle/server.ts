/**
 * Scripted account server for the ManageAccountScreen lifecycle stress
 * harness. Stands in for `globalThis.fetch` only — everything above it
 * (deletion client, auth store, session keeper, navigator, screen) is the
 * real production code.
 *
 * Models the contract in AGENTS.md "Auth sessions" closely enough for
 * lifecycle invariants to be checked server-side:
 *   - bootstrap spends an identity token and mints an access/refresh pair;
 *   - refresh rotates (strict reuse → 401); an access token stays valid
 *     until its expiry like a JWT, so a rotation does NOT retire the
 *     previous bearer — only logout / revocation / deletion does;
 *   - delete-request mints a challenge bound to the bearer's account;
 *   - delete-confirm deletes the account named by the challenge when (and
 *     only when) the bearer belongs to that same account.
 *
 * Every request is logged with the bearer's state at the time it arrived,
 * so the suite can assert "no request ever bore a previous user's token",
 * "no confirm ever arrived before the arm delay", and so on.
 *
 * Process death is modelled with `proc`: a response destined for a client
 * generation that has since been killed is withheld (the request already
 * reached the server, so its side effect still happens), and the pending
 * promise only ever settles through the caller's AbortSignal.
 */
import type { FaultMode, RouteScript } from './scenario';

export interface ServerAccount {
  id: string;
  email: string;
  displayName: string;
  identityToken: string;
}

export type BearerState =
  'none' | 'unknown' | 'valid' | 'expired' | 'revoked' | 'deleted-account';

export interface RequestRecord {
  seq: number;
  /** Fake-clock time the request arrived. */
  at: number;
  /** Fake-clock time the server produced its answer (side effects apply
   * here, so a request that arrived earlier can still be served later). */
  servedAt: number | null;
  proc: number;
  path: string;
  bearer: string | null;
  bearerState: BearerState;
  /** Account the bearer belonged to (whatever its state). */
  bearerAccount: string | null;
  body: unknown;
  outcome: number | 'network' | 'hang' | 'withheld' | 'aborted';
  /** For delete-confirm: which account the challenge named. */
  challengeAccount?: string | null;
  /** For delete-confirm: ms since that challenge was minted. */
  challengeAgeMs?: number | null;
  /** Whether this call performed a server-side state change. */
  sideEffect: string | null;
}

interface AccessTokenRecord {
  accountId: string;
  expiresAtMs: number;
  revoked: boolean;
}

interface RefreshTokenRecord {
  accountId: string;
  /** false once rotated away or revoked. */
  live: boolean;
}

interface ChallengeRecord {
  accountId: string;
  issuedAtMs: number;
}

export interface ServerOptions {
  bearerTtlSec: number;
  refreshLatencyMs: number;
  request: RouteScript;
  confirm: RouteScript;
  appleRevocation: 'revoked' | 'not_applicable' | 'manual_action_required';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Resolves after `ms` on the (fake) clock; rejects on abort. */
function delay(
  ms: number,
  signal: AbortSignal | null | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Never resolves; rejects only when the caller gives up. */
function withhold(signal: AbortSignal | null | undefined): Promise<never> {
  return new Promise<never>((_, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    signal?.addEventListener('abort', () => reject(abortError()), {
      once: true,
    });
  });
}

export class ScriptedServer {
  /** Client process generation; bump on kill-relaunch. */
  proc = 0;
  readonly log: RequestRecord[] = [];
  readonly accounts = new Map<string, ServerAccount>();
  readonly deleted = new Set<string>();
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly challenges = new Map<string, ChallengeRecord>();
  private readonly consumedFaults = new Set<'request' | 'confirm'>();
  private seq = 0;
  private tokenSeq = 0;
  readonly options: ServerOptions;

  constructor(options: ServerOptions) {
    this.options = options;
  }

  addAccount(account: ServerAccount): void {
    this.accounts.set(account.id, account);
  }

  /** Mints a session for an account (what bootstrap and refresh return). */
  issueSession(accountId: string): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } {
    this.tokenSeq += 1;
    const accessToken = `at-${accountId.slice(0, 8)}-${this.tokenSeq}`;
    const refreshToken = `rt-${accountId.slice(0, 8)}-${this.tokenSeq}`;
    const expiresAtMs = Date.now() + this.options.bearerTtlSec * 1000;
    this.accessTokens.set(accessToken, {
      accountId,
      expiresAtMs,
      revoked: false,
    });
    this.refreshTokens.set(refreshToken, { accountId, live: true });
    return {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(expiresAtMs / 1000),
    };
  }

  /** Server-side revocation of every token the account holds. */
  revokeAccount(accountId: string): void {
    for (const record of this.accessTokens.values()) {
      if (record.accountId === accountId) record.revoked = true;
    }
    for (const record of this.refreshTokens.values()) {
      if (record.accountId === accountId) record.live = false;
    }
  }

  isRefreshTokenLive(token: string): boolean {
    const record = this.refreshTokens.get(token);
    return Boolean(record?.live) && !this.deleted.has(record!.accountId);
  }

  accountOfRefreshToken(token: string): string | null {
    return this.refreshTokens.get(token)?.accountId ?? null;
  }

  bearerState(bearer: string | null): {
    state: BearerState;
    accountId: string | null;
  } {
    if (!bearer) return { state: 'none', accountId: null };
    const record = this.accessTokens.get(bearer);
    if (!record) return { state: 'unknown', accountId: null };
    if (this.deleted.has(record.accountId)) {
      return { state: 'deleted-account', accountId: record.accountId };
    }
    if (record.revoked)
      return { state: 'revoked', accountId: record.accountId };
    if (record.expiresAtMs <= Date.now()) {
      return { state: 'expired', accountId: record.accountId };
    }
    return { state: 'valid', accountId: record.accountId };
  }

  requests(path: string): RequestRecord[] {
    return this.log.filter(record => record.path === path);
  }

  private takeFault(route: 'request' | 'confirm'): FaultMode {
    const script = this.options[route];
    if (script.mode === 'ok') return 'ok';
    if (this.consumedFaults.has(route)) return 'ok';
    if (script.recover) this.consumedFaults.add(route);
    return script.mode;
  }

  /** The `fetch` handed to the app. */
  readonly fetch = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const path = new URL(url).pathname.replace(/^\/functions\/v1\/api/, '');
    const headers = new Headers(init?.headers);
    const authorization = headers.get('Authorization');
    const bearer = authorization?.replace(/^Bearer\s+/i, '') ?? null;
    const signal = init?.signal;
    const proc = this.proc;
    let body: unknown = null;
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const { state, accountId } = this.bearerState(bearer);
    this.seq += 1;
    const record: RequestRecord = {
      seq: this.seq,
      at: Date.now(),
      servedAt: null,
      proc,
      path,
      bearer,
      bearerState: state,
      bearerAccount: accountId,
      body,
      outcome: 'hang',
      sideEffect: null,
    };
    this.log.push(record);

    const deliver = async (
      latencyMs: number,
      produce: () => Response | 'network' | 'hang',
    ): Promise<Response> => {
      try {
        await delay(latencyMs, signal);
      } catch (error) {
        record.outcome = 'aborted';
        throw error;
      }
      const result = produce();
      record.servedAt = Date.now();
      if (proc !== this.proc) {
        record.outcome = 'withheld';
        return withhold(signal);
      }
      if (result === 'network') {
        record.outcome = 'network';
        throw new TypeError('Network request failed');
      }
      if (result === 'hang') {
        record.outcome = 'hang';
        return withhold(signal);
      }
      record.outcome = result.status;
      return result;
    };

    switch (path) {
      case '/v1/account/bootstrap':
        return deliver(this.options.refreshLatencyMs, () => {
          const account = [...this.accounts.values()].find(
            candidate => candidate.identityToken === bearer,
          );
          if (!account || this.deleted.has(account.id)) {
            return jsonResponse(401, {
              error: { message: 'identity token rejected' },
            });
          }
          record.sideEffect = `bootstrap:${account.id}`;
          return jsonResponse(200, {
            user: { id: account.id, email: account.email },
            onboardingState: 'complete',
            session: this.issueSession(account.id),
          });
        });

      case '/v1/auth/refresh':
        return deliver(this.options.refreshLatencyMs, () => {
          const token =
            body && typeof body === 'object'
              ? (body as { refreshToken?: unknown }).refreshToken
              : null;
          const refresh =
            typeof token === 'string' ? this.refreshTokens.get(token) : null;
          record.bearerAccount = refresh?.accountId ?? null;
          if (
            !refresh ||
            !refresh.live ||
            this.deleted.has(refresh.accountId)
          ) {
            record.bearerState = refresh
              ? this.deleted.has(refresh.accountId)
                ? 'deleted-account'
                : 'revoked'
              : 'unknown';
            return jsonResponse(401, { error: { message: 'refresh refused' } });
          }
          record.bearerState = 'valid';
          refresh.live = false;
          const issued = this.issueSession(refresh.accountId);
          record.sideEffect = `rotate:${refresh.accountId}→${issued.refreshToken}`;
          return jsonResponse(200, { session: issued });
        });

      case '/v1/auth/logout':
        return deliver(this.options.refreshLatencyMs, () => {
          if (state === 'valid' && accountId) {
            this.revokeAccount(accountId);
            record.sideEffect = `logout:${accountId}`;
          }
          return jsonResponse(200, { ok: true });
        });

      case '/v1/me/delete-request': {
        const fault = this.takeFault('request');
        return deliver(this.options.request.latencyMs, () => {
          if (state !== 'valid' || !accountId) {
            return jsonResponse(401, { error: { message: 'unauthorized' } });
          }
          switch (fault) {
            case '401':
              return jsonResponse(401, { error: { message: 'unauthorized' } });
            case '429':
              return jsonResponse(429, { error: { message: 'slow down' } });
            case '500':
              return jsonResponse(500, {
                error: { message: 'internal error' },
              });
            case 'network':
              return 'network';
            case 'hang':
              return 'hang';
            case 'malformed':
              return new Response('<html>gateway</html>', { status: 200 });
            default: {
              const challenge = `challenge-${accountId.slice(0, 8)}-${this.seq}`;
              this.challenges.set(challenge, {
                accountId,
                issuedAtMs: Date.now(),
              });
              record.sideEffect = `challenge:${accountId}`;
              return jsonResponse(200, {
                challenge,
                expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
              });
            }
          }
        });
      }

      case '/v1/me/delete-confirm': {
        const fault = this.takeFault('confirm');
        return deliver(this.options.confirm.latencyMs, () => {
          const challengeValue =
            body && typeof body === 'object'
              ? (body as { challenge?: unknown }).challenge
              : null;
          const challenge =
            typeof challengeValue === 'string'
              ? this.challenges.get(challengeValue)
              : undefined;
          record.challengeAccount = challenge?.accountId ?? null;
          record.challengeAgeMs = challenge
            ? Date.now() - challenge.issuedAtMs
            : null;
          if (state !== 'valid' || !accountId) {
            return jsonResponse(401, { error: { message: 'unauthorized' } });
          }
          if (!challenge || challenge.accountId !== accountId) {
            return jsonResponse(400, {
              error: { message: 'unknown deletion challenge' },
            });
          }
          switch (fault) {
            case '401':
              return jsonResponse(401, { error: { message: 'unauthorized' } });
            case '429':
              return jsonResponse(429, { error: { message: 'slow down' } });
            case '500':
              return jsonResponse(500, {
                error: { message: 'internal error' },
              });
            case 'network':
              return 'network';
            case 'hang':
              return 'hang';
            case 'malformed':
              return new Response('<html>gateway</html>', { status: 200 });
            case 'not-deleted':
              return jsonResponse(200, { deleted: false });
            default: {
              this.deleted.add(accountId);
              this.revokeAccount(accountId);
              this.challenges.delete(String(challengeValue));
              record.sideEffect = `delete:${accountId}`;
              return jsonResponse(200, {
                deleted: true,
                appleAuthorizationRevocation: this.options.appleRevocation,
              });
            }
          }
        });
      }

      default:
        return deliver(0, () =>
          jsonResponse(404, { error: { message: `no route ${path}` } }),
        );
    }
  };
}
