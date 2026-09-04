/**
 * In-process double of the Supabase Edge Function routes the deletion journey
 * touches (`supabase/functions/api/index.ts`). It is stateful — accounts,
 * sessions, deletion challenges, consent, the exit-survey table and the
 * identity-keyed free-rating ledger — so the client can be driven through
 * sign-in → delete-request → delete-confirm → relaunch and the harness can
 * assert what the server would still hold afterwards.
 *
 * Status codes and error codes mirror the real handlers:
 *   delete-request  → 200 {challenge, expiresAt}
 *   delete-confirm  → 400 validation.account_deletion (non-UUID)
 *                     403 account.deletion_challenge_invalid | _expired
 *                     429 account.deletion_too_fast (< 3 s after request)
 *                     200 {deleted: true, appleAuthorizationRevocation}
 *   any authed route with a dead bearer → 401 auth.unauthorized
 *
 * Fault injection (`faults`) lets a scenario lose a response after the side
 * effect was applied, force a status, or return non-JSON.
 */
import { createHash } from 'node:crypto';

export type Provider = 'apple' | 'google';

/** Mirrors DELETION_SURVEY_DETAILS_MAX in supabase/functions/api/index.ts. */
const DELETION_SURVEY_DETAILS_MAX = 500;

export interface FakeUser {
  id: string;
  provider: Provider;
  /** Stable provider subject (Apple `user`, Google `sub`). */
  providerSubject: string;
  email: string;
  profile: Record<string, unknown> | null;
  consent: { modelTraining: boolean; lastActionAt: string | null };
  scoredShots: number;
}

export interface DeletionRequestRow {
  userId: string;
  challenge: string;
  createdAtMs: number;
  expiresAtMs: number;
}

export interface FeedbackRow {
  id: number;
  userId: string | null;
  reason: string;
  wanted: string | null;
  details: string | null;
}

export interface LedgerRow {
  identityHash: string;
  scoredCount: number;
}

export interface RequestLogEntry {
  seq: number;
  method: string;
  path: string;
  /** SHA-256 prefix of the bearer — never the token itself. */
  bearer: string | null;
  body: unknown;
  status: number | 'network_error';
  effectApplied: boolean;
}

export type FaultKind =
  | { kind: 'lost_response' }
  | { kind: 'status'; status: number; code?: string; message?: string }
  | { kind: 'invalid_json' }
  | { kind: 'network_error' }
  /** Side effect applies immediately; the response is withheld until
   * `until` resolves (models a slow network racing a local state change). */
  | { kind: 'hold'; until: Promise<void> };

export interface FakeEdgeOptions {
  seed: string;
  now: () => number;
  minConfirmAgeMs?: number;
  challengeTtlMs?: number;
  appleRevocation?: 'revoked' | 'manual_action_required' | 'not_applicable';
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Deterministic UUID v4-shaped values from a seed + counter. */
function seededUuid(seed: string, counter: number): string {
  const digest = hash(`${seed}:${counter}`);
  return (
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-` +
    `a${digest.slice(17, 20)}-${digest.slice(20, 32)}`
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function codedError(status: number, code: string, message: string): Response {
  return jsonResponse(status, { error: { code, message } });
}

export class FakeEdge {
  readonly users = new Map<string, FakeUser>();
  readonly accessTokens = new Map<string, string>();
  readonly refreshTokens = new Map<string, string>();
  readonly deletionRequests = new Map<string, DeletionRequestRow>();
  readonly feedback: FeedbackRow[] = [];
  readonly ledger = new Map<string, LedgerRow>();
  readonly log: RequestLogEntry[] = [];
  readonly faults = new Map<string, FaultKind[]>();
  readonly deletedUserIds: string[] = [];
  private counter = 0;
  private readonly minConfirmAgeMs: number;
  private readonly challengeTtlMs: number;
  private readonly appleRevocation: FakeEdgeOptions['appleRevocation'];

  constructor(private readonly options: FakeEdgeOptions) {
    this.minConfirmAgeMs = options.minConfirmAgeMs ?? 3_000;
    this.challengeTtlMs = options.challengeTtlMs ?? 15 * 60_000;
    this.appleRevocation = options.appleRevocation ?? 'revoked';
  }

  private nextId(): string {
    this.counter += 1;
    return seededUuid(this.options.seed, this.counter);
  }

  /** Queues a one-shot fault for the next call to `path`. */
  injectFault(path: string, fault: FaultKind): void {
    const queue = this.faults.get(path) ?? [];
    queue.push(fault);
    this.faults.set(path, queue);
  }

  /** The identity ledger key — sha256('provider:subject') as in migration
   * 20260902150000_free_rating_identity_ledger.sql. */
  static identityHash(provider: Provider, subject: string): string {
    return hash(`${provider}:${subject}`);
  }

  seedScoredShots(userId: string, count: number): void {
    const user = this.users.get(userId);
    if (!user) throw new Error(`no user ${userId}`);
    user.scoredShots = count;
    const key = FakeEdge.identityHash(user.provider, user.providerSubject);
    const existing = this.ledger.get(key);
    this.ledger.set(key, {
      identityHash: key,
      scoredCount: Math.max(existing?.scoredCount ?? 0, count),
    });
  }

  private lifetimeScored(user: FakeUser): number {
    const key = FakeEdge.identityHash(user.provider, user.providerSubject);
    return Math.max(user.scoredShots, this.ledger.get(key)?.scoredCount ?? 0);
  }

  private authenticate(init?: RequestInit): FakeUser | null {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return null;
    const token = auth.slice('Bearer '.length);
    const userId = this.accessTokens.get(token);
    if (!userId) return null;
    return this.users.get(userId) ?? null;
  }

  private bearerDigest(init?: RequestInit): string | null {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers['Authorization'] ?? headers['authorization'];
    return auth ? hash(auth).slice(0, 12) : null;
  }

  private mintSession(user: FakeUser) {
    const accessToken = `access-${this.nextId()}`;
    const refreshToken = `refresh-${this.nextId()}`;
    this.accessTokens.set(accessToken, user.id);
    this.refreshTokens.set(refreshToken, user.id);
    return {
      accessToken,
      refreshToken,
      expiresAt: Math.floor(this.options.now() / 1000) + 3600,
    };
  }

  private deleteUser(user: FakeUser): void {
    this.users.delete(user.id);
    this.deletedUserIds.push(user.id);
    for (const [token, id] of this.accessTokens) {
      if (id === user.id) this.accessTokens.delete(token);
    }
    for (const [token, id] of this.refreshTokens) {
      if (id === user.id) this.refreshTokens.delete(token);
    }
    // account_deletion_requests FK ON DELETE CASCADE.
    this.deletionRequests.delete(user.id);
    // account_deletion_feedback FK ON DELETE SET NULL (anonymized).
    for (const row of this.feedback) {
      if (row.userId === user.id) row.userId = null;
    }
    // free_rating_ledger has NO FK — it survives by design (legal.ts §7/§8).
  }

  /** The `fetch` the app under test is given. */
  readonly fetch = async (
    url: string,
    init?: RequestInit,
  ): Promise<Response> => {
    const path = new URL(url).pathname;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body =
      typeof init?.body === 'string' && init.body.length > 0
        ? (JSON.parse(init.body) as unknown)
        : null;
    const entry: RequestLogEntry = {
      seq: this.log.length + 1,
      method,
      path,
      bearer: this.bearerDigest(init),
      body,
      status: 0,
      effectApplied: false,
    };
    this.log.push(entry);

    const fault = this.faults.get(path)?.shift();
    if (fault?.kind === 'network_error') {
      entry.status = 'network_error';
      throw new TypeError('Network request failed');
    }
    if (fault?.kind === 'status') {
      entry.status = fault.status;
      return codedError(
        fault.status,
        fault.code ?? 'injected.fault',
        fault.message ?? 'injected fault',
      );
    }

    const response = this.route(method, path, body, init, entry);
    entry.status = response.status;
    if (fault?.kind === 'hold') {
      await fault.until;
    }
    if (fault?.kind === 'lost_response') {
      entry.status = 'network_error';
      throw new TypeError('Network request failed (response lost)');
    }
    if (fault?.kind === 'invalid_json') {
      return {
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON');
        },
        text: async () => '<html>gateway</html>',
      } as unknown as Response;
    }
    return response;
  };

  private route(
    method: string,
    path: string,
    body: unknown,
    init: RequestInit | undefined,
    entry: RequestLogEntry,
  ): Response {
    const record = (body ?? {}) as Record<string, unknown>;

    if (method === 'POST' && path === '/v1/account/bootstrap') {
      // The real route reads the provider ID token from the bearer and tells
      // Apple from Google by the authorization-code exchange. Here the ID
      // token is `token-for:<provider subject>`.
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const identityToken = (headers['Authorization'] ?? '').slice(
        'Bearer '.length,
      );
      const provider: Provider =
        typeof record['appleAuthorizationCode'] === 'string'
          ? 'apple'
          : 'google';
      const subject = identityToken.replace(/^token-for:/, '');
      let user = [...this.users.values()].find(
        u => u.provider === provider && u.providerSubject === subject,
      );
      if (!user) {
        user = {
          id: this.nextId(),
          provider,
          providerSubject: subject,
          email: `${subject}@example.test`,
          profile: null,
          consent: { modelTraining: false, lastActionAt: null },
          scoredShots: 0,
        };
        this.users.set(user.id, user);
      }
      entry.effectApplied = true;
      return jsonResponse(200, {
        user: { id: user.id, email: user.email },
        onboardingState: user.profile ? 'complete' : 'pending',
        profile: user.profile,
        session: this.mintSession(user),
      });
    }

    if (method === 'POST' && path === '/v1/auth/refresh') {
      const token = String(record['refreshToken'] ?? '');
      const userId = this.refreshTokens.get(token);
      const user = userId ? this.users.get(userId) : null;
      if (!user) {
        return codedError(401, 'auth.unauthorized', 'Session expired.');
      }
      this.refreshTokens.delete(token);
      entry.effectApplied = true;
      return jsonResponse(200, { session: this.mintSession(user) });
    }

    const user = this.authenticate(init);
    if (!user) {
      return codedError(401, 'auth.unauthorized', 'Sign in required.');
    }

    if (method === 'POST' && path === '/v1/auth/logout') {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const token = (headers['Authorization'] ?? '').slice('Bearer '.length);
      this.accessTokens.delete(token);
      entry.effectApplied = true;
      return jsonResponse(200, { ok: true });
    }

    if (method === 'GET' && path === '/v1/me') {
      return jsonResponse(200, {
        onboardingState: user.profile ? 'complete' : 'pending',
        profile: user.profile,
      });
    }

    if (method === 'PUT' && path === '/v1/me/onboarding') {
      user.profile = {
        skill_level: record['skillLevel'],
        handedness: record['handedness'],
        primary_goal: record['goal'],
        biggest_problem: record['biggestProblem'],
        first_name: record['firstName'] ?? null,
        gender: record['gender'] ?? null,
      };
      entry.effectApplied = true;
      return jsonResponse(200, {
        plan: { focusCheckpoint: 'contact_position' },
        recommendedCheckpoint: 'contact_position',
      });
    }

    if (method === 'GET' && path === '/v1/me/access') {
      const used = Math.min(2, this.lifetimeScored(user));
      const remaining = 2 - used;
      return jsonResponse(200, {
        premium: false,
        entitlements: [],
        canStartRating: remaining > 0,
        paywallRequired: remaining <= 0,
        freeRatings: {
          limit: 2,
          used,
          reserved: 0,
          remaining,
          availableToReserve: remaining,
        },
      });
    }

    if (path.startsWith('/v1/me/consent/')) {
      if (method === 'POST' && path.endsWith('/grant')) {
        user.consent = {
          modelTraining: true,
          lastActionAt: new Date(this.options.now()).toISOString(),
        };
        entry.effectApplied = true;
      } else if (method === 'POST' && path.endsWith('/withdraw')) {
        user.consent = {
          modelTraining: false,
          lastActionAt: new Date(this.options.now()).toISOString(),
        };
        entry.effectApplied = true;
      }
      return jsonResponse(200, {
        subjectPseudonym: `pseud-${user.id.slice(0, 8)}`,
        scopes: [
          {
            scope: 'video_analysis',
            active: true,
            consentVersion: 'video-analysis-v1',
            lastAction: 'granted',
            lastActionAt: null,
          },
          {
            scope: 'model_training',
            active: user.consent.modelTraining,
            consentVersion: user.consent.modelTraining
              ? 'model-training-v1'
              : null,
            lastAction: user.consent.lastActionAt
              ? user.consent.modelTraining
                ? 'granted'
                : 'withdrawn'
              : null,
            lastActionAt: user.consent.lastActionAt,
          },
        ],
      });
    }

    if (method === 'POST' && path === '/v1/sessions') {
      entry.effectApplied = true;
      return jsonResponse(200, { ok: true });
    }
    if (method === 'POST' && /^\/v1\/sessions\/[^/]+\/finalize$/.test(path)) {
      entry.effectApplied = true;
      return jsonResponse(200, { ok: true });
    }
    if (method === 'POST' && path === '/v1/shots:sync') {
      const shots = Array.isArray(record['shots'])
        ? (record['shots'] as Array<Record<string, unknown>>)
        : [];
      const acceptedIds = shots
        .map(shot => shot['id'])
        .filter((id): id is string => typeof id === 'string');
      this.seedScoredShots(user.id, user.scoredShots + acceptedIds.length);
      entry.effectApplied = true;
      return jsonResponse(200, { acceptedIds, rejected: [] });
    }

    if (method === 'POST' && path === '/v1/me/delete-request') {
      const challenge = this.nextId();
      const createdAtMs = this.options.now();
      this.deletionRequests.set(user.id, {
        userId: user.id,
        challenge,
        createdAtMs,
        expiresAtMs: createdAtMs + this.challengeTtlMs,
      });
      const survey = record['survey'] as Record<string, unknown> | undefined;
      if (survey && typeof survey['reason'] === 'string') {
        this.feedback.push({
          id: this.feedback.length + 1,
          userId: user.id,
          reason: survey['reason'],
          wanted:
            typeof survey['wanted'] === 'string' ? survey['wanted'] : null,
          details:
            typeof survey['details'] === 'string' &&
            survey['details'].trim().length > 0
              ? Array.from(survey['details'].trim())
                  .slice(0, DELETION_SURVEY_DETAILS_MAX)
                  .join('')
              : null,
        });
      }
      entry.effectApplied = true;
      return jsonResponse(200, {
        challenge,
        expiresAt: new Date(createdAtMs + this.challengeTtlMs).toISOString(),
      });
    }

    if (method === 'POST' && path === '/v1/me/delete-confirm') {
      const challenge = record['challenge'];
      if (!isUuid(challenge)) {
        return codedError(
          400,
          'validation.account_deletion',
          'challenge must be the UUID returned by delete-request.',
        );
      }
      const row = this.deletionRequests.get(user.id);
      if (!row || row.challenge !== challenge) {
        return codedError(
          403,
          'account.deletion_challenge_invalid',
          'This deletion was not requested, or the confirmation does not match. Start again from Settings.',
        );
      }
      const now = this.options.now();
      if (row.expiresAtMs <= now) {
        return codedError(
          403,
          'account.deletion_challenge_expired',
          'The deletion request expired. Start again from Settings.',
        );
      }
      if (now - row.createdAtMs < this.minConfirmAgeMs) {
        return codedError(
          429,
          'account.deletion_too_fast',
          'Please review the confirmation before deleting.',
        );
      }
      this.deleteUser(user);
      entry.effectApplied = true;
      return jsonResponse(200, {
        deleted: true,
        appleAuthorizationRevocation:
          user.provider === 'apple' ? this.appleRevocation : 'not_applicable',
      });
    }

    return codedError(404, 'not_found', `no route ${method} ${path}`);
  }

  /** Server-side survival snapshot for the artifacts. */
  snapshot() {
    return {
      users: [...this.users.values()].map(u => ({
        id: u.id,
        provider: u.provider,
        hasProfile: u.profile !== null,
        modelTrainingConsent: u.consent.modelTraining,
        scoredShots: u.scoredShots,
      })),
      deletedUserIds: [...this.deletedUserIds],
      liveAccessTokens: this.accessTokens.size,
      liveRefreshTokens: this.refreshTokens.size,
      deletionRequests: [...this.deletionRequests.values()],
      feedback: this.feedback.map(row => ({ ...row })),
      ledger: [...this.ledger.values()],
    };
  }
}
