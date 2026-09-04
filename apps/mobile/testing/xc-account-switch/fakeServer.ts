/**
 * xc-journey-account-switch — an in-memory stand-in for the edge function
 * that knows TWO accounts and answers strictly by bearer.
 *
 * Every response is keyed off the Authorization header, never off client
 * state, so the harness can prove which identity a request was made AS: a
 * request bearing A's access token gets A's data (or a 401 once A logged
 * out), a request bearing B's gets B's, anything else is refused. Every
 * request is logged (path + identity resolved from the bearer, never the
 * token itself) so the journey can assert "B's device never talked to the
 * server as A after the switch" from raw evidence.
 *
 * Any route can be `hold()`-ed: the fetch promise stays pending until the
 * test releases it, which is how late callbacks from the previous account
 * are injected after the switch.
 */
import { IDENTITY_A, IDENTITY_B, type Identity } from './fixtures';

export type IdentityLabel = 'A' | 'B';

export interface ServerRequestLog {
  seq: number;
  method: string;
  path: string;
  /** Identity the bearer resolved to, 'provider:A'/'provider:B' for the
   *  one-shot bootstrap tokens, 'none' when unauthenticated, 'unknown' when
   *  the bearer belongs to nobody (revoked/rotated/fabricated). */
  as: string;
  status: number;
  /** Shot ids carried by /v1/shots:sync bodies (owner attribution matrix). */
  shotIds?: string[];
}

interface AccountRow {
  identity: Identity;
  accessTokens: Set<string>;
  refreshToken: string | null;
  refreshRotations: number;
  /** Profile the server holds for /v1/me; null = onboarding incomplete. */
  serverProfile: Record<string, unknown> | null;
  access: Record<string, unknown>;
  receivedShotIds: string[];
  receivedSessionIds: string[];
  logoutCalls: number;
}

export interface Hold {
  release(): void;
  fail(status: number): void;
}

const FAR_FUTURE_SECONDS = () => Math.floor(Date.now() / 1000) + 3600;

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : `status-${status}`,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const PROVIDER_TOKEN: Record<string, IdentityLabel> = {
  'apple-identity-token': 'A',
  'google-id-token': 'B',
};

export function accessPayloadFor(
  label: IdentityLabel,
): Record<string, unknown> {
  // A is a paying member; B is on the free ledger with one rating used. The
  // two payloads are deliberately non-overlapping so any bleed is visible.
  return label === 'A'
    ? {
        premium: true,
        entitlements: ['premium'],
        freeRatings: {
          limit: 2,
          used: 2,
          reserved: 0,
          remaining: 0,
          availableToReserve: 0,
        },
        canStartRating: true,
        paywallRequired: false,
      }
    : {
        premium: false,
        entitlements: [],
        freeRatings: {
          limit: 2,
          used: 1,
          reserved: 0,
          remaining: 1,
          availableToReserve: 1,
        },
        canStartRating: true,
        paywallRequired: false,
      };
}

export function serverProfileFor(
  label: IdentityLabel,
): Record<string, unknown> {
  return label === 'A'
    ? {
        first_name: 'Ada',
        gender: 'female',
        skill_level: 'advanced',
        handedness: 'left',
        primary_goal: 'drives',
        biggest_problem: 'late-contact',
      }
    : {
        first_name: 'Bo',
        gender: 'male',
        skill_level: 'beginner',
        handedness: 'right',
        primary_goal: 'dinks',
        biggest_problem: 'popups',
      };
}

export class FakeAccountServer {
  readonly log: ServerRequestLog[] = [];
  private seq = 0;
  private readonly accounts: Record<IdentityLabel, AccountRow>;
  private readonly holds = new Map<string, Array<() => void>>();
  /** pathSuffix → how many more requests to park (later ones pass through). */
  private readonly heldRoutes = new Map<string, number>();
  private readonly failOverrides = new Map<string, number>();
  private tokenCounter = 0;

  constructor() {
    this.accounts = {
      A: this.row(IDENTITY_A, 'A'),
      B: this.row(IDENTITY_B, 'B'),
    };
  }

  private row(identity: Identity, label: IdentityLabel): AccountRow {
    return {
      identity,
      accessTokens: new Set(),
      refreshToken: null,
      refreshRotations: 0,
      serverProfile: serverProfileFor(label),
      access: accessPayloadFor(label),
      receivedShotIds: [],
      receivedSessionIds: [],
      logoutCalls: 0,
    };
  }

  account(label: IdentityLabel): Readonly<{
    refreshToken: string | null;
    refreshRotations: number;
    receivedShotIds: string[];
    receivedSessionIds: string[];
    logoutCalls: number;
    liveAccessTokens: number;
  }> {
    const row = this.accounts[label];
    return {
      refreshToken: row.refreshToken,
      refreshRotations: row.refreshRotations,
      receivedShotIds: [...row.receivedShotIds],
      receivedSessionIds: [...row.receivedSessionIds],
      logoutCalls: row.logoutCalls,
      liveAccessTokens: row.accessTokens.size,
    };
  }

  setServerProfile(
    label: IdentityLabel,
    profile: Record<string, unknown> | null,
  ): void {
    this.accounts[label].serverProfile = profile;
  }

  /** Simulates "revoked elsewhere": the refresh token is no longer honoured. */
  revokeRefresh(label: IdentityLabel): void {
    this.accounts[label].refreshToken = null;
    this.accounts[label].accessTokens.clear();
  }

  /**
   * Parks the reply of the next `count` request(s) to `pathSuffix` until
   * released; requests beyond `count` (e.g. the NEXT account hitting the
   * same route) are answered normally.
   */
  hold(pathSuffix: string, count = 1): Hold {
    this.heldRoutes.set(pathSuffix, count);
    const release = () => {
      this.heldRoutes.delete(pathSuffix);
      const waiters = this.holds.get(pathSuffix) ?? [];
      this.holds.delete(pathSuffix);
      for (const wake of waiters) wake();
    };
    return {
      release,
      fail: (status: number) => {
        this.failOverrides.set(pathSuffix, status);
        release();
      },
    };
  }

  /** Number of requests currently parked behind a hold on `pathSuffix`. */
  heldCount(pathSuffix: string): number {
    return this.holds.get(pathSuffix)?.length ?? 0;
  }

  private resolveBearer(init?: RequestInit): {
    label: IdentityLabel | null;
    as: string;
    token: string | null;
  } {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const raw =
      headers['Authorization'] ?? headers['authorization'] ?? undefined;
    if (!raw) return { label: null, as: 'none', token: null };
    const token = raw.replace(/^Bearer\s+/i, '');
    const provider = PROVIDER_TOKEN[token];
    if (provider) return { label: provider, as: `provider:${provider}`, token };
    for (const label of ['A', 'B'] as const) {
      if (this.accounts[label].accessTokens.has(token)) {
        return { label, as: label, token };
      }
    }
    return { label: null, as: 'unknown', token };
  }

  private mint(label: IdentityLabel): {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  } {
    const row = this.accounts[label];
    this.tokenCounter += 1;
    const accessToken = `access-${label}-${this.tokenCounter}`;
    const refreshToken = `refresh-${label}-${this.tokenCounter}`;
    row.accessTokens.add(accessToken);
    row.refreshToken = refreshToken;
    return { accessToken, refreshToken, expiresAt: FAR_FUTURE_SECONDS() };
  }

  /** Installs `globalThis.fetch`; returns the previous one for restore. */
  install(): typeof fetch {
    const previous = globalThis.fetch;
    globalThis.fetch = ((url: string, init?: RequestInit) =>
      this.handle(String(url), init)) as unknown as typeof fetch;
    return previous;
  }

  /**
   * The server PROCESSES every request immediately (state changes, token
   * minting, log entry) — a hold only delays the RESPONSE reaching the
   * client. That is the adversarial ordering: the server has already acted
   * on account A's request when the device switches to B, and the reply
   * then lands on a device that no longer belongs to A.
   */
  async handle(url: string, init?: RequestInit): Promise<Response> {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const processed = this.process(path, method, init);
    for (const [suffix, remaining] of this.heldRoutes) {
      if (path.endsWith(suffix) && remaining > 0) {
        this.heldRoutes.set(suffix, remaining - 1);
        await new Promise<void>(resolve => {
          const list = this.holds.get(suffix) ?? [];
          list.push(resolve);
          this.holds.set(suffix, list);
        });
        const forced = this.failOverrides.get(suffix);
        if (forced !== undefined) {
          this.failOverrides.delete(suffix);
          return this.finish(method, path, 'forced', forced, {
            error: { code: 'forced', message: 'forced failure' },
          });
        }
      }
    }
    return processed;
  }

  private process(path: string, method: string, init?: RequestInit): Response {
    const auth = this.resolveBearer(init);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;

    if (path === '/v1/account/bootstrap' && method === 'POST') {
      if (!auth.label || !auth.as.startsWith('provider:')) {
        return this.finish(method, path, auth.as, 401, {
          error: { code: 'auth.invalid', message: 'bad provider token' },
        });
      }
      const row = this.accounts[auth.label];
      return this.finish(method, path, auth.as, 200, {
        user: {
          id: row.identity.canonicalAppUserId,
          email: row.identity.email,
        },
        onboardingState: row.serverProfile ? 'complete' : 'pending',
        session: this.mint(auth.label),
      });
    }

    if (path === '/v1/auth/refresh' && method === 'POST') {
      const refreshToken =
        body && typeof body === 'object'
          ? (body as Record<string, unknown>)['refreshToken']
          : null;
      for (const label of ['A', 'B'] as const) {
        const row = this.accounts[label];
        if (row.refreshToken && row.refreshToken === refreshToken) {
          row.refreshRotations += 1;
          return this.finish(method, path, `refresh:${label}`, 200, {
            session: this.mint(label),
          });
        }
      }
      return this.finish(method, path, 'unknown', 401, {
        error: { code: 'auth.refresh_rejected', message: 'refused' },
      });
    }

    if (path === '/v1/auth/logout' && method === 'POST') {
      if (auth.label && auth.as === auth.label) {
        const row = this.accounts[auth.label];
        row.logoutCalls += 1;
        row.refreshToken = null;
        row.accessTokens.clear();
        return this.finish(method, path, auth.as, 200, { ok: true });
      }
      return this.finish(method, path, auth.as, 401, {
        error: { code: 'auth.required', message: 'no session' },
      });
    }

    // Everything below needs a live access token.
    if (!auth.label || auth.as !== auth.label) {
      return this.finish(method, path, auth.as, 401, {
        error: { code: 'auth.required', message: 'sign in' },
      });
    }
    const row = this.accounts[auth.label];

    if (path === '/v1/me/access' && method === 'GET') {
      return this.finish(method, path, auth.as, 200, row.access);
    }
    if (path === '/v1/me' && method === 'GET') {
      return this.finish(method, path, auth.as, 200, {
        user: { id: row.identity.canonicalAppUserId },
        onboardingState: row.serverProfile ? 'complete' : 'pending',
        profile: row.serverProfile,
      });
    }
    if (path === '/v1/me/onboarding' && method === 'PUT') {
      const input = (body ?? {}) as Record<string, unknown>;
      row.serverProfile = {
        first_name: input['firstName'] ?? null,
        gender: input['gender'] ?? null,
        skill_level: input['skillLevel'],
        handedness: input['handedness'],
        primary_goal: input['goal'],
        biggest_problem: input['biggestProblem'],
      };
      return this.finish(method, path, auth.as, 200, {
        onboardingState: 'complete',
        // Server-chosen focus: A and B get different ones so a bleed shows.
        recommendedCheckpoint:
          auth.label === 'A' ? 'follow_through' : 'preparation',
        profile: row.serverProfile,
      });
    }
    if (path === '/v1/shots:sync' && method === 'POST') {
      const shots = ((body as Record<string, unknown>)['shots'] ?? []) as Array<
        Record<string, unknown>
      >;
      const ids = shots.map(s => String(s['id']));
      row.receivedShotIds.push(...ids);
      return this.finish(
        method,
        path,
        auth.as,
        200,
        { acceptedIds: ids, rejected: [] },
        ids,
      );
    }
    if (path === '/v1/sessions' && method === 'POST') {
      row.receivedSessionIds.push(
        String((body as Record<string, unknown>)['id']),
      );
      return this.finish(method, path, auth.as, 200, { ok: true });
    }
    if (/^\/v1\/sessions\/[^/]+\/finalize$/.test(path) && method === 'POST') {
      return this.finish(method, path, auth.as, 200, { ok: true });
    }
    if (path === '/v1/me/saved-drills' && method === 'GET') {
      // One saved drill per account, disjoint slugs; detail lookups 404 (the
      // store tolerates that) so no catalog fixture is needed.
      const tag = auth.label.toLowerCase();
      const digit = auth.label === 'A' ? '1' : '2';
      return this.finish(method, path, auth.as, 200, {
        items: [
          {
            id: `${digit.repeat(8)}-0000-4000-8000-${digit.repeat(12)}`,
            slug: `drill-${tag}`,
            title: `Drill for ${auth.label}`,
            description: `Only account ${auth.label} saved this drill.`,
            coach_name: 'Coach',
            equipment: [],
            difficulty_min: null,
            difficulty_max: null,
            saved_at: '2026-08-20T12:00:00.000Z',
          },
        ],
      });
    }
    return this.finish(method, path, auth.as, 404, {
      error: { code: 'not_found', message: path },
    });
  }

  private finish(
    method: string,
    path: string,
    as: string,
    status: number,
    body: unknown,
    shotIds?: string[],
  ): Response {
    this.seq += 1;
    this.log.push({
      seq: this.seq,
      method,
      path,
      as,
      status,
      ...(shotIds ? { shotIds } : {}),
    });
    return response(body, status);
  }
}
