/**
 * Seeded randomized state-transition harness (model-checker style) over the
 * four launch/account stores — launchGate, authStore, appStore, accessStore —
 * plus the modules they drive (apiSession, sessionKeeper, sessionVault,
 * syncRuntime, accountScope, the analysis-permit client and the account
 * deletion client).
 *
 * The SYSTEM UNDER TEST is the real production code; only the device/world
 * edges are simulated deterministically: SQLite kv (in-memory), the Keychain
 * (the repo's react-native-keychain auto-mock), the native Apple / Google
 * sign-in SDKs, AppState, the network (a fault-injecting fake fetch) and the
 * backend (an in-memory model of the edge function's auth, profile, access,
 * permit and deletion routes with Supabase-style refresh-token rotation).
 *
 * Every scenario is generated from `(seed, index)` by a hand-rolled PRNG, is
 * fully replayable from its JSON (all randomness is drawn at generation
 * time, execution is deterministic under jest fake timers), and every failing
 * scenario is minimized by step deletion before being written to the
 * artifact directory:
 *
 *   artifacts/randomized-state-machine/<run>/summary.json   (campaign table)
 *   artifacts/randomized-state-machine/<run>/failures.json  (seed, original,
 *                                        minimized scenario, first violation)
 *   artifacts/randomized-state-machine/<run>/matrix.json    (op × invariant
 *                                        counts, op coverage, state coverage)
 *   artifacts/randomized-state-machine/<run>/heap.json      (heap per seed)
 *   artifacts/randomized-state-machine/<run>/run.log
 *
 * Configuration (env):
 *   RSM_SEED_START / RSM_SEED_END        seed range (default 1000..1099)
 *   RSM_SEQUENCES_PER_SEED               scenarios per seed (default 20 →
 *                                        2000 scenarios over 100 seeds)
 *   RSM_STEPS_MIN / RSM_STEPS_MAX        steps per scenario (default 8..28)
 *   RSM_REPLAY=<path.json>               replay ONE recorded scenario (the
 *                                        `scenario` or `minimized` object of
 *                                        a failures.json entry) instead of
 *                                        running the campaign
 *   RSM_ARTIFACT_DIR                     where to write artifacts
 *
 * Invariants are split into HARD (a violation fails the jest test — these are
 * contracts pinned elsewhere in the suite or in AGENTS.md) and ADVISORY
 * (recorded in the artifacts and reported, never failing CI — product
 * expectations that are not pinned anywhere yet). See `INVARIANTS`.
 */
import { AppState, NativeModules } from 'react-native';
import * as Keychain from 'react-native-keychain';
import type { LocalDb } from '../../src/data/db';
import { useAuthStore } from '../../src/auth/authStore';
import { useAppStore, focusForGoal } from '../../src/state/appStore';
import type { Profile } from '../../src/state/profile';
import {
  clearAccessStoreConfiguration,
  useAccessStore,
} from '../../src/state/accessStore';
import {
  stageAfterGetStarted,
  stageAfterOnboarding,
  stageWhenLeavingOnboarding,
  type PreAuthStage,
} from '../../src/flow/launchGate';
import {
  bearerTokenFor,
  clearApiSession,
  getApiSession,
  setApiUnauthorizedListener,
} from '../../src/account/apiSession';
import { SESSION_VAULT_SERVICE } from '../../src/account/sessionVault';
import { stopSessionKeeper } from '../../src/account/sessionKeeper';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  canonicalDataOwner,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import { clearSyncRuntime } from '../../src/data/syncRuntime';
import { clearTrainingStoreConfiguration } from '../../src/training/store';
import { ApiError, createAnalysisPermitClient } from '../../src/data/api';
import {
  AccountDeletionError,
  confirmAccountDeletion,
  requestAccountDeletion,
} from '../../src/account/deletion';
import { PENDING_ONBOARDING_PROFILE_KV_KEY } from '../../src/state/appStore';

// Node globals the React Native tsconfig does not declare (same pattern as
// the other filesystem-reading suites under __tests__/wf).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
  hrtime: { bigint(): bigint };
};
const fs = require('fs') as {
  mkdirSync: (p: string, options: { recursive: true }) => void;
  writeFileSync: (p: string, data: string) => void;
  readFileSync: (p: string, encoding: 'utf8') => string;
};
const path = require('path') as {
  join: (...parts: string[]) => string;
  resolve: (...parts: string[]) => string;
};

// ─── Module seams ────────────────────────────────────────────────────────────

const mockKv = new Map<string, string>();
const mockDbControl = { failNextWrites: 0 };

function mockFakeDb(): LocalDb {
  return {
    async execute(sql: string, params: unknown[] = []) {
      const statement = sql.trim().replace(/\s+/g, ' ');
      if (statement.startsWith('SELECT value FROM kv')) {
        const value = mockKv.get(String(params[0]));
        return { rows: value === undefined ? [] : [{ value }] };
      }
      if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
        if (mockDbControl.failNextWrites > 0) {
          mockDbControl.failNextWrites -= 1;
          throw new Error('sqlite: disk I/O error (injected)');
        }
        mockKv.set(String(params[0]), String(params[1]));
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM kv WHERE key = ?')) {
        mockKv.delete(String(params[0]));
        return { rows: [] };
      }
      // Owner-scoped tables, transactions and the (always empty) outbox.
      return { rows: [] };
    },
    close() {},
  };
}
jest.mock('../../src/data/db', () => ({ getDb: () => mockFakeDb() }));

const mockGoogleSignin = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(async () => true),
  signIn: jest.fn(),
  signInSilently: jest.fn(async () => ({
    type: 'noSavedCredentialFound',
    data: null,
  })),
  hasPreviousSignIn: jest.fn(() => false),
  signOut: jest.fn(async () => null),
  revokeAccess: jest.fn(async () => null),
};
jest.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: mockGoogleSignin,
}));

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: 'test-web-client.apps.googleusercontent.com',
  GOOGLE_IOS_CLIENT_ID: 'test-ios-client.apps.googleusercontent.com',
}));

const API_BASE_URL = 'https://api.rsm.test';
jest.mock('../../src/config/runtimeConfig', () => ({
  getRuntimePublicConfig: () => ({
    apiBaseUrl: 'https://api.rsm.test',
    revenueCatPublicSdkKey: null,
    googleIosClientId: 'test-ios-client.apps.googleusercontent.com',
    googleWebClientId: 'test-web-client.apps.googleusercontent.com',
    appVersion: '1.0',
  }),
}));

jest.mock('../../src/account/deviceContext', () => ({
  getAccountBootstrapEnvironment: () => ({
    locale: 'en-US',
    timezone: 'America/Los_Angeles',
    device: {
      platform: 'ios',
      osVersion: '18.5',
      appVersion: '1.0',
      model: 'iOS phone',
    },
  }),
}));

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<string, { username: string; password: string }>;
};

// ─── PRNG ────────────────────────────────────────────────────────────────────

/** mulberry32 — small, fast, good enough for scenario generation. */
class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  weighted<T extends string>(weights: Record<T, number>): T {
    const entries = Object.entries(weights) as Array<[T, number]>;
    const total = entries.reduce((sum, [, w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [key, weight] of entries) {
      roll -= weight;
      if (roll < 0) return key;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error('weighted from empty record');
    return last[0];
  }
}

function scenarioSeed(seed: number, index: number): number {
  // splitmix-ish combine so (seed, index) pairs never collide trivially.
  let h = (seed * 0x9e3779b1) ^ (index + 0x7f4a7c15);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

type IdentityKey = 'apple:alice' | 'google:bob' | 'apple:carol';
interface Identity {
  key: IdentityKey;
  provider: 'apple' | 'google';
  name: string;
  email: string;
  idToken: string;
  premium: boolean;
}
const IDENTITIES: Record<IdentityKey, Identity> = {
  'apple:alice': {
    key: 'apple:alice',
    provider: 'apple',
    name: 'Alice Park',
    email: 'alice@privaterelay.example',
    idToken: 'idtoken:apple:alice',
    premium: false,
  },
  'google:bob': {
    key: 'google:bob',
    provider: 'google',
    name: 'Bob Reyes',
    email: 'bob@example.com',
    idToken: 'idtoken:google:bob',
    premium: true,
  },
  'apple:carol': {
    key: 'apple:carol',
    provider: 'apple',
    name: 'Carol Nkemelu',
    email: 'carol@privaterelay.example',
    idToken: 'idtoken:apple:carol',
    premium: false,
  },
};
const IDENTITY_KEYS = Object.keys(IDENTITIES) as IdentityKey[];

type ProfileChoice = 'dinks' | 'drops' | 'serve' | 'volleys';
const PROFILES: Record<ProfileChoice, Profile> = {
  dinks: {
    firstName: 'Dana',
    gender: 'female',
    skillLevel: '3.5',
    handedness: 'right',
    goal: 'dinks',
    biggestProblem: 'consistency',
    focusCheckpoint: focusForGoal('dinks'),
  },
  drops: {
    skillLevel: '4.0',
    handedness: 'left',
    goal: 'drops',
    biggestProblem: 'control',
    focusCheckpoint: focusForGoal('drops'),
  },
  serve: {
    firstName: 'Sam',
    skillLevel: '3.0',
    handedness: 'right',
    goal: 'serve',
    biggestProblem: 'power',
    focusCheckpoint: focusForGoal('serve'),
  },
  volleys: {
    gender: 'male',
    skillLevel: '4.5',
    handedness: 'ambidextrous',
    goal: 'volleys',
    biggestProblem: 'reaction',
    focusCheckpoint: focusForGoal('volleys'),
  },
};

// ─── Scenario language ───────────────────────────────────────────────────────

type NetworkMode = 'ok' | 'offline' | 'error' | 'slow';

type Step =
  | { op: 'launch' }
  | { op: 'kill' }
  | { op: 'getStarted' }
  | { op: 'leaveOnboarding' }
  | { op: 'finishOnboarding'; profile: ProfileChoice }
  | { op: 'signIn'; identity: IdentityKey; userCancels: boolean }
  | { op: 'guest' }
  | { op: 'completeAccountOnboarding'; profile: ProfileChoice }
  | { op: 'retryGate' }
  | { op: 'analyze' }
  | { op: 'cancel' }
  | { op: 'score' }
  | { op: 'retry' }
  | { op: 'history' }
  | { op: 'purchase' }
  | { op: 'logout' }
  | { op: 'background' }
  | { op: 'resume' }
  | { op: 'advance'; ms: number }
  | { op: 'network'; mode: NetworkMode; delayMs: number }
  | { op: 'serverRevoke' }
  | { op: 'expireBearer' }
  | { op: 'delete' }
  | { op: 'wipeLocalDb' }
  | { op: 'dbWriteFault'; count: number };

type Op = Step['op'];
const ALL_OPS: readonly Op[] = [
  'launch',
  'kill',
  'getStarted',
  'leaveOnboarding',
  'finishOnboarding',
  'signIn',
  'guest',
  'completeAccountOnboarding',
  'retryGate',
  'analyze',
  'cancel',
  'score',
  'retry',
  'history',
  'purchase',
  'logout',
  'background',
  'resume',
  'advance',
  'network',
  'serverRevoke',
  'expireBearer',
  'delete',
  'wipeLocalDb',
  'dbWriteFault',
];

interface Scenario {
  seed: number;
  index: number;
  /** Server-issued access-token lifetime. */
  bearerTtlSec: number;
  /** Supabase-style refresh-token reuse window (a rotated-away token is
   * still honored for this long and answers with its successor pair). */
  refreshReuseGraceMs: number;
  steps: Step[];
}

// ─── Fake backend ────────────────────────────────────────────────────────────

interface ServerProfile {
  skill_level: string;
  handedness: string;
  primary_goal: string;
  biggest_problem: string;
  first_name?: string;
  gender?: string;
}
interface ServerAccount {
  id: string;
  identity: IdentityKey;
  email: string;
  profile: ServerProfile | null;
  deleted: boolean;
}
interface ServerSession {
  refreshToken: string;
  accessToken: string;
  accountId: string;
  accessExpiresAtMs: number;
  revoked: boolean;
  rotatedAtMs: number | null;
  successor: ServerSession | null;
}
interface ServerPermit {
  id: string;
  accountId: string;
  status: 'reserved' | 'released' | 'consumed';
}
interface RequestLogEntry {
  n: number;
  atMs: number;
  epoch: number;
  method: string;
  path: string;
  bearer: string | null;
  bearerAccount: string | null;
  status: number | 'network' | 'dropped';
  /** Whether the client ever saw the answer: 'delivered' (resolved),
   * 'aborted' (client timeout), 'dropped' (process died), 'network' (threw). */
  outcome: 'pending' | 'delivered' | 'aborted' | 'dropped' | 'network';
  /** Refresh only: the token the client presented. */
  refreshToken?: string;
}

interface ReuseRevocation {
  accountId: string;
  staleToken: string;
  rotatedAtMs: number;
  atMs: number;
  requestN: number;
}

interface AccessView {
  premium: boolean;
  entitlements: string[];
  freeRatings: {
    limit: 2;
    used: number;
    reserved: number;
    remaining: number;
    availableToReserve: number;
  };
  canStartRating: boolean;
  paywallRequired: boolean;
}

class FakeServer {
  accounts = new Map<string, ServerAccount>();
  identityLedger = new Map<IdentityKey, number>();
  sessionsByRefresh = new Map<string, ServerSession>();
  sessionsByAccess = new Map<string, ServerSession>();
  permits = new Map<string, ServerPermit>();
  challenges = new Map<string, string>();
  requests: RequestLogEntry[] = [];
  /** Refresh-token reuse outside the grace window: the family was revoked
   * (GoTrue reuse detection) although the account itself was in good
   * standing. Each one is an implicit sign-out the user did nothing for. */
  reuseRevocations: ReuseRevocation[] = [];
  private counter = 0;

  constructor(
    private readonly bearerTtlMs: number,
    private readonly reuseGraceMs: number,
  ) {}

  private nextId(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private uuidFor(): string {
    this.counter += 1;
    const n = this.counter.toString(16).padStart(12, '0');
    return `a0000000-0000-4000-8000-${n}`;
  }

  accountForIdentity(identity: IdentityKey): ServerAccount | null {
    for (const account of this.accounts.values()) {
      if (account.identity === identity && !account.deleted) return account;
    }
    return null;
  }

  accessView(account: ServerAccount): AccessView {
    const identity = IDENTITIES[account.identity];
    const used = Math.min(2, this.identityLedger.get(account.identity) ?? 0);
    const reserved = [...this.permits.values()].filter(
      p => p.accountId === account.id && p.status === 'reserved',
    ).length;
    const remaining = 2 - used;
    const availableToReserve = Math.max(0, remaining - reserved);
    const canStartRating = identity.premium || availableToReserve > 0;
    return {
      premium: identity.premium,
      entitlements: identity.premium ? ['premium'] : [],
      freeRatings: {
        limit: 2,
        used,
        reserved: Math.min(reserved, remaining),
        remaining,
        availableToReserve,
      },
      canStartRating,
      paywallRequired: !canStartRating,
    };
  }

  private issueSession(accountId: string, nowMs: number): ServerSession {
    const session: ServerSession = {
      refreshToken: this.nextId('rt'),
      accessToken: this.nextId('at'),
      accountId,
      accessExpiresAtMs: nowMs + this.bearerTtlMs,
      revoked: false,
      rotatedAtMs: null,
      successor: null,
    };
    this.sessionsByRefresh.set(session.refreshToken, session);
    this.sessionsByAccess.set(session.accessToken, session);
    return session;
  }

  private sessionView(session: ServerSession) {
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: Math.floor(session.accessExpiresAtMs / 1000),
    };
  }

  authenticate(bearer: string | null, nowMs: number): ServerAccount | null {
    if (!bearer) return null;
    const session = this.sessionsByAccess.get(bearer);
    if (!session || session.revoked || session.accessExpiresAtMs <= nowMs) {
      return null;
    }
    const account = this.accounts.get(session.accountId);
    if (!account || account.deleted) return null;
    return account;
  }

  /** Revokes every session of the account (signed out elsewhere / deleted). */
  revokeAccount(accountId: string): void {
    for (const session of this.sessionsByRefresh.values()) {
      if (session.accountId === accountId) session.revoked = true;
    }
  }

  /** True while the account is live and at least one of its sessions is not
   * revoked (a refresh with a current token would still succeed). */
  accountHonored(accountId: string): boolean {
    const account = this.accounts.get(accountId);
    if (!account || account.deleted) return false;
    for (const session of this.sessionsByRefresh.values()) {
      if (session.accountId === accountId && !session.revoked) return true;
    }
    return false;
  }

  /** Invalidates one bearer without touching its refresh token. */
  expireAccess(accessToken: string): void {
    const session = this.sessionsByAccess.get(accessToken);
    if (session) session.accessExpiresAtMs = 0;
  }

  consumePermit(permitId: string): void {
    const permit = this.permits.get(permitId);
    if (!permit || permit.status !== 'reserved') return;
    permit.status = 'consumed';
    const account = this.accounts.get(permit.accountId);
    if (!account) return;
    this.identityLedger.set(
      account.identity,
      (this.identityLedger.get(account.identity) ?? 0) + 1,
    );
  }

  handle(
    method: string,
    pathname: string,
    bearer: string | null,
    body: unknown,
    nowMs: number,
  ): { status: number; body: unknown } {
    const json = (status: number, payload: unknown) => ({
      status,
      body: payload,
    });
    const error = (status: number, code: string, message: string) =>
      json(status, { error: { code, message } });

    if (method === 'POST' && pathname === '/v1/account/bootstrap') {
      const identity = IDENTITY_KEYS.map(k => IDENTITIES[k]).find(
        i => i.idToken === bearer,
      );
      if (!identity) {
        return error(401, 'auth.invalid_token', 'Identity token rejected.');
      }
      let account = this.accountForIdentity(identity.key);
      if (!account) {
        account = {
          id: this.uuidFor(),
          identity: identity.key,
          email: identity.email,
          profile: null,
          deleted: false,
        };
        this.accounts.set(account.id, account);
      }
      const session = this.issueSession(account.id, nowMs);
      return json(200, {
        user: { id: account.id, email: account.email },
        onboardingState: account.profile ? 'complete' : 'pending',
        session: this.sessionView(session),
      });
    }

    if (method === 'POST' && pathname === '/v1/auth/refresh') {
      const token =
        body && typeof body === 'object'
          ? (body as { refreshToken?: unknown }).refreshToken
          : undefined;
      const session =
        typeof token === 'string' ? this.sessionsByRefresh.get(token) : null;
      if (!session) return error(401, 'auth.refresh', 'Sign in again.');
      const account = this.accounts.get(session.accountId);
      if (!account || account.deleted || session.revoked) {
        return error(401, 'auth.refresh', 'Sign in again.');
      }
      if (session.rotatedAtMs !== null) {
        if (
          session.successor &&
          !session.successor.revoked &&
          nowMs - session.rotatedAtMs <= this.reuseGraceMs
        ) {
          return json(200, { session: this.sessionView(session.successor) });
        }
        // Reuse outside the window: the whole family is revoked (Supabase
        // refresh-token-rotation semantics).
        this.reuseRevocations.push({
          accountId: session.accountId,
          staleToken: token as string,
          rotatedAtMs: session.rotatedAtMs,
          atMs: nowMs,
          requestN: this.requests.length,
        });
        this.revokeAccount(session.accountId);
        return error(401, 'auth.refresh', 'Refresh token already used.');
      }
      const next = this.issueSession(session.accountId, nowMs);
      session.rotatedAtMs = nowMs;
      session.successor = next;
      return json(200, { session: this.sessionView(next) });
    }

    if (method === 'POST' && pathname === '/v1/auth/logout') {
      const session = bearer ? this.sessionsByAccess.get(bearer) : null;
      if (session) {
        // scope=local: this device's refresh token dies; follow the rotation
        // chain forward so a just-rotated successor dies too.
        let cursor: ServerSession | null = session;
        while (cursor) {
          cursor.revoked = true;
          cursor = cursor.successor;
        }
      }
      return json(204, null);
    }

    const account = this.authenticate(bearer, nowMs);
    if (!account) {
      return error(401, 'auth.required', 'Sign in again.');
    }

    if (method === 'GET' && pathname === '/v1/me') {
      return json(200, {
        onboardingState: account.profile ? 'complete' : 'pending',
        profile: account.profile,
      });
    }
    if (method === 'PUT' && pathname === '/v1/me/onboarding') {
      const b = (body ?? {}) as Record<string, unknown>;
      const goal = typeof b.goal === 'string' ? b.goal : '';
      account.profile = {
        skill_level: String(b.skillLevel ?? ''),
        handedness: String(b.handedness ?? ''),
        primary_goal: goal,
        biggest_problem: String(b.biggestProblem ?? ''),
        ...(typeof b.firstName === 'string' ? { first_name: b.firstName } : {}),
        ...(typeof b.gender === 'string' ? { gender: b.gender } : {}),
      };
      return json(200, { recommendedCheckpoint: focusForGoal(goal) });
    }
    if (method === 'GET' && pathname === '/v1/me/access') {
      return json(200, this.accessView(account));
    }
    if (method === 'POST' && pathname === '/v1/billing/sync') {
      const access = this.accessView(account);
      return json(200, {
        billing: {
          premium: access.premium,
          productKey: access.premium ? 'pickle_sensei_pro_annual' : null,
          expiresAt: null,
          verifiedAt: new Date(nowMs).toISOString(),
        },
        access,
      });
    }
    if (method === 'POST' && pathname === '/v1/analysis-permits') {
      const access = this.accessView(account);
      if (!access.canStartRating) {
        return error(
          402,
          'access.paywall_required',
          'Your free ratings are used up.',
        );
      }
      const permit: ServerPermit = {
        id: this.nextId('permit'),
        accountId: account.id,
        status: 'reserved',
      };
      this.permits.set(permit.id, permit);
      return json(200, {
        permit: {
          id: permit.id,
          status: 'reserved',
          accessSource: access.premium ? 'premium' : 'free',
        },
        access: this.accessView(account),
      });
    }
    const finalize = /^\/v1\/analysis-permits\/([^/]+)\/finalize$/.exec(
      pathname,
    );
    if (method === 'POST' && finalize) {
      const permit = this.permits.get(decodeURIComponent(finalize[1] ?? ''));
      if (!permit || permit.accountId !== account.id) {
        return error(404, 'permit.not_found', 'Unknown permit.');
      }
      if (permit.status === 'reserved') permit.status = 'released';
      return json(200, { permit: { id: permit.id, status: permit.status } });
    }
    if (method === 'POST' && pathname === '/v1/me/delete-request') {
      const challenge = this.nextId('challenge');
      this.challenges.set(challenge, account.id);
      return json(200, {
        challenge,
        expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
      });
    }
    if (method === 'POST' && pathname === '/v1/me/delete-confirm') {
      const challenge = (body as { challenge?: unknown } | null)?.challenge;
      if (
        typeof challenge !== 'string' ||
        this.challenges.get(challenge) !== account.id
      ) {
        return error(400, 'deletion.challenge', 'Invalid challenge.');
      }
      account.deleted = true;
      account.profile = null;
      this.revokeAccount(account.id);
      for (const permit of this.permits.values()) {
        if (permit.accountId === account.id && permit.status === 'reserved') {
          permit.status = 'released';
        }
      }
      return json(200, {
        deleted: true,
        appleAuthorizationRevocation:
          IDENTITIES[account.identity].provider === 'apple'
            ? 'revoked'
            : 'not_applicable',
      });
    }
    if (method === 'POST' && pathname === '/v1/shots:sync') {
      return json(200, { accepted: [], rejected: [] });
    }
    if (method === 'POST' && pathname.startsWith('/v1/sessions')) {
      return json(200, {});
    }
    if (method === 'POST' && pathname === '/v1/me/evaluation/trials') {
      return json(200, { accepted: [], rejected: [] });
    }
    return error(404, 'route.unknown', `No route ${method} ${pathname}`);
  }
}

// ─── Fake network ────────────────────────────────────────────────────────────

interface NetworkState {
  mode: NetworkMode;
  delayMs: number;
  /** Bumped by `kill`: responses addressed to an earlier process never land. */
  epoch: number;
  pending: number;
}

function makeResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => {
      if (body === null) throw new Error('no body');
      return body;
    },
  } as unknown as Response;
}

function installFakeFetch(server: FakeServer, network: NetworkState): void {
  let requestCounter = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const authHeader = headers.Authorization ?? headers.authorization ?? null;
    const bearer = authHeader?.replace(/^Bearer\s+/i, '') ?? null;
    const body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as unknown)
        : null;
    const nowMs = Date.now();
    const epoch = network.epoch;
    requestCounter += 1;
    const entry: RequestLogEntry = {
      n: requestCounter,
      atMs: nowMs,
      epoch,
      method,
      path: url.pathname,
      bearer,
      bearerAccount: bearer
        ? (server.sessionsByAccess.get(bearer)?.accountId ?? null)
        : null,
      status: 'network',
      outcome: 'pending',
    };
    if (
      url.pathname === '/v1/auth/refresh' &&
      body &&
      typeof body === 'object' &&
      typeof (body as { refreshToken?: unknown }).refreshToken === 'string'
    ) {
      entry.refreshToken = (body as { refreshToken: string }).refreshToken;
    }
    server.requests.push(entry);

    if (network.mode === 'offline') {
      entry.outcome = 'network';
      throw new TypeError('Network request failed');
    }
    if (network.mode === 'error') {
      entry.status = 503;
      entry.outcome = 'delivered';
      return makeResponse(503, {
        error: { code: 'server.unavailable', message: 'Try again later.' },
      });
    }
    // The server performs its side effects when the request ARRIVES; a slow
    // network only delays the answer (which the client may have given up on).
    const result = server.handle(method, url.pathname, bearer, body, nowMs);
    entry.status = result.status;
    if (network.mode === 'ok') {
      entry.outcome = 'delivered';
      return makeResponse(result.status, result.body);
    }

    network.pending += 1;
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        network.pending -= 1;
        fn();
      };
      const timer = setTimeout(() => {
        if (network.epoch !== epoch) {
          // The process that asked is gone: nobody ever sees this answer.
          entry.status = 'dropped';
          entry.outcome = 'dropped';
          finish(() => {});
          return;
        }
        entry.outcome = 'delivered';
        finish(() => resolve(makeResponse(result.status, result.body)));
      }, network.delayMs);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          if (entry.outcome === 'pending') entry.outcome = 'aborted';
          finish(() => {
            const abortError = new Error('The operation was aborted.');
            abortError.name = 'AbortError';
            reject(abortError);
          });
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }) as unknown as typeof fetch;
}

// ─── AppState harness ────────────────────────────────────────────────────────

type AppStateListener = (state: string) => void;
const appStateListeners = new Set<AppStateListener>();
let appStateSpy: jest.SpyInstance | null = null;

function installAppStateSpy(): void {
  appStateSpy = jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    type: string,
    listener: AppStateListener,
  ) => {
    if (type !== 'change') return { remove: () => {} };
    appStateListeners.add(listener);
    return { remove: () => appStateListeners.delete(listener) };
  }) as unknown as typeof AppState.addEventListener);
}

function emitAppState(state: 'active' | 'background' | 'inactive'): void {
  for (const listener of [...appStateListeners]) listener(state);
}

// ─── Model ───────────────────────────────────────────────────────────────────

type ModelAuth =
  | { kind: 'signedOut' }
  | { kind: 'guest' }
  | { kind: 'synced'; identity: IdentityKey; accountId: string };

interface Model {
  process: 'running' | 'dead';
  auth: ModelAuth;
  stage: PreAuthStage;
  appState: 'active' | 'background';
  inflightPermit: string | null;
  /** Whether the user explicitly signed out / deleted since the last launch
   * (used to decide what a relaunch must restore). */
  lastLaunchRestored: boolean;
}

interface Snapshot {
  auth: {
    hydrated: boolean;
    busy: boolean;
    session: {
      provider: string;
      canonicalAppUserId: string | null;
      localOnly: boolean;
    } | null;
    error: string | null;
    deletionCleanup: string | null;
  };
  owner: string;
  apiSession: {
    canonicalAppUserId: string;
    bearer: string;
    hasRefresh: boolean;
    expiresAtMs: number | null;
  } | null;
  vault: { canonicalAppUserId: string; refreshToken: string } | null;
  guestMarker: boolean;
  lastProvider: string | null;
  pendingStash: boolean;
  app: {
    hydrated: boolean;
    ownerKey: string | null;
    hasProfile: boolean;
    hydrateError: string | null;
    onboardingBusy: boolean;
  };
  access: {
    status: string;
    operation: string;
    canonicalAccess: AccessView | null;
    error: string | null;
  };
  network: NetworkMode;
  model: {
    auth: string;
    stage: PreAuthStage;
    appState: string;
    inflightPermit: string | null;
  };
  serverAccountLive: boolean | null;
}

interface Violation {
  invariant: InvariantId;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  hard: boolean;
  message: string;
  stepIndex: number;
  step: Step;
  snapshot: Snapshot;
}

type InvariantId =
  | 'owner-matches-session'
  | 'api-session-bound-to-account'
  | 'vault-matches-session'
  | 'vault-refresh-token-server-valid'
  | 'no-bearer-after-sign-out'
  | 'no-cross-account-bearer'
  | 'no-busy-after-settle'
  | 'access-store-reset-on-account-change'
  | 'access-snapshot-matches-server'
  | 'bearer-fresh-after-resume'
  | 'sign-out-revokes-server-session'
  | 'relaunch-restores-persisted-state'
  | 'revoked-session-signs-out'
  | 'deletion-purges-local-owner-data'
  | 'deletion-ledger-survives-identity'
  | 'pre-auth-stage-order'
  | 'stash-adopted-by-first-owner'
  | 'profile-matches-owner'
  | 'profile-truth-after-reconnect'
  | 'no-orphaned-local-data-after-lost-deletion'
  | 'rating-gate-matches-server'
  | 'no-unhandled-exception'
  | 'no-unexpected-sign-out'
  | 'expired-bearer-recovers'
  | 'gate-recovers-after-bearer-rotation'
  | 'gate-recovers-after-access-error'
  | 'gate-before-bearer-restored'
  | 'persisted-layers-agree'
  | 'no-secret-in-sqlite'
  | 'no-refresh-reuse-revocation';

const INVARIANTS: Record<
  InvariantId,
  { severity: Violation['severity']; hard: boolean; doc: string }
> = {
  'owner-matches-session': {
    severity: 'P0',
    hard: true,
    doc: 'active data owner == signed-out / device-guest / canonical(session) at every settled point',
  },
  'api-session-bound-to-account': {
    severity: 'P0',
    hard: true,
    doc: 'in-memory ApiSession is null or belongs to the signed-in synced account',
  },
  'vault-matches-session': {
    severity: 'P1',
    hard: true,
    doc: 'Keychain record is null or names the signed-in synced account; after a settled sign-out it is null',
  },
  'vault-refresh-token-server-valid': {
    severity: 'P1',
    hard: false,
    doc: 'after a settled online step the persisted refresh token is one the server still honors',
  },
  'no-bearer-after-sign-out': {
    severity: 'P0',
    hard: true,
    doc: 'no request other than /v1/auth/logout carries a bearer of an account after the user signed out of it (until it signs in again)',
  },
  'no-cross-account-bearer': {
    severity: 'P0',
    hard: true,
    doc: 'no request carries a bearer minted for account A while account B is the signed-in account',
  },
  'no-busy-after-settle': {
    severity: 'P1',
    hard: true,
    doc: 'authStore.busy, appStore.onboardingBusy, accessStore.operation/loading all idle once every request has been answered or timed out',
  },
  'access-store-reset-on-account-change': {
    severity: 'P0',
    hard: true,
    doc: 'accessStore holds no canonicalAccess/plans when signed out or as guest, and never one fetched for another account',
  },
  'access-snapshot-matches-server': {
    severity: 'P1',
    hard: true,
    doc: 'after an online refresh, accessStore.canonicalAccess equals the server access view',
  },
  'bearer-fresh-after-resume': {
    severity: 'P1',
    hard: true,
    doc: 'after an online resume (or time advance) past the bearer expiry the client knows about, the live bearer is one the server accepts',
  },
  'no-unexpected-sign-out': {
    severity: 'P0',
    hard: true,
    doc: 'the synced session never disappears while the server still honors a session of that account (the ONE implicit sign-out is a refused refresh / deleted account)',
  },
  'expired-bearer-recovers': {
    severity: 'P3',
    hard: false,
    doc: 'a 401 on a bearer the server no longer accepts (session NOT revoked) ends with a rotated, server-accepted bearer and no sign-out (advisory: routes that do not reportApiUnauthorized leave the stale bearer until the next 401)',
  },
  'gate-recovers-after-bearer-rotation': {
    severity: 'P2',
    hard: false,
    doc: 'when the first access load is refused with 401 and the refresh then rotates the bearer, the Analyze gate should not strand a can-rate user on the Paywall (advisory: accessStore.status stays error)',
  },
  'gate-before-bearer-restored': {
    severity: 'P3',
    hard: false,
    doc: 'after a launch whose refresh was deferred (offline / 5xx), the signed-in-from-record user who taps Analyze before the keeper retry lands is routed to the Paywall (accessStore is configured only once an ApiSession exists; useRatingRouteGate treats unconfigured as paywall) although the server would allow the rating (advisory: fail-closed by design, but the Paywall is a misleading destination for a transient state)',
  },
  'gate-recovers-after-access-error': {
    severity: 'P2',
    hard: false,
    doc: 'with the network back, a can-rate user whose last access refresh failed (status error, snapshot null) should not be routed to the Paywall by useRatingRouteGate without one re-fetch (advisory)',
  },
  'persisted-layers-agree': {
    severity: 'P2',
    hard: false,
    doc: 'SQLite guest marker and Keychain session never contradict each other after a settled step; when they do, the relaunch must prefer the durable sign-in (advisory: the marker wins and the Keychain record is left behind)',
  },
  'sign-out-revokes-server-session': {
    severity: 'P1',
    hard: true,
    doc: 'an online sign-out leaves the server session revoked',
  },
  'relaunch-restores-persisted-state': {
    severity: 'P0',
    hard: true,
    doc: 'a relaunch restores exactly what the persisted layers say: guest marker → guest, valid vault → synced, otherwise signed out',
  },
  'revoked-session-signs-out': {
    severity: 'P1',
    hard: true,
    doc: 'a session the server revoked ends (signed out, vault cleared) as soon as the device receives the refused refresh',
  },
  'no-refresh-reuse-revocation': {
    severity: 'P2',
    hard: false,
    doc: 'the device never presents a refresh token the server already rotated once the reuse grace has passed (GoTrue then revokes the whole family = forced sign-out of an account in good standing); happens when the rotation answer was lost (client timeout / process death) and the retry comes later than the grace window (advisory: reproduced product behaviour, reported through failures.json rather than failing the suite)',
  },
  'deletion-purges-local-owner-data': {
    severity: 'P0',
    hard: true,
    doc: 'a completed deletion clears the vault, the owner profile row and lands signed out with localPurge=complete',
  },
  'deletion-ledger-survives-identity': {
    severity: 'P1',
    hard: true,
    doc: 'after delete + re-sign-in the free-rating allowance shown follows the identity ledger (used ratings stay used)',
  },
  'pre-auth-stage-order': {
    severity: 'P1',
    hard: true,
    doc: 'welcome → onboarding → signin; leaving step one returns to welcome; sign-in is reachable only after finishing',
  },
  'stash-adopted-by-first-owner': {
    severity: 'P1',
    hard: true,
    doc: 'a pre-auth stash is adopted (and cleared) by the first writable owner that hydrates online, replacing its profile',
  },
  'profile-matches-owner': {
    severity: 'P0',
    hard: true,
    doc: 'appStore.ownerKey == active owner once hydrated, and the profile shown is that owner’s local row',
  },
  'profile-truth-after-reconnect': {
    severity: 'P2',
    hard: false,
    doc: 'once the network is back and the bearer live, a signed-in account whose server profile exists is not shown the in-account questionnaire',
  },
  'no-orphaned-local-data-after-lost-deletion': {
    severity: 'P2',
    hard: false,
    doc: 'when the server deleted the account (confirmation lost), the next online launch/refresh leaves no local rows for that owner',
  },
  'rating-gate-matches-server': {
    severity: 'P1',
    hard: true,
    doc: 'online, the Analyze route gate proceeds iff the server says canStartRating (or a fresh reservation reports paywall)',
  },
  'no-unhandled-exception': {
    severity: 'P0',
    hard: true,
    doc: 'no store action rejects/throws for a user-reachable transition',
  },
  'no-secret-in-sqlite': {
    severity: 'P0',
    hard: true,
    doc: 'no access token, refresh token or provider id token ever lands in SQLite kv',
  },
};

// ─── Harness ─────────────────────────────────────────────────────────────────

interface StepRecord {
  index: number;
  step: Step;
  applied: boolean;
  note: string;
  snapshot: Snapshot;
  /** Fake-network traffic issued while this step ran (in order). */
  requests: string[];
}

interface ScenarioResult {
  scenario: Scenario;
  ok: boolean;
  steps: StepRecord[];
  violations: Violation[];
  opsExecuted: Record<string, number>;
  statesSeen: Set<string>;
  requestCount: number;
}

const SETTLE_CAP_MS = 60_000;

async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

class Harness {
  readonly server: FakeServer;
  readonly network: NetworkState = {
    mode: 'ok',
    delayMs: 0,
    epoch: 0,
    pending: 0,
  };
  readonly model: Model = {
    process: 'dead',
    auth: { kind: 'signedOut' },
    stage: 'welcome',
    appState: 'active',
    inflightPermit: null,
    lastLaunchRestored: false,
  };
  violations: Violation[] = [];
  /** Accounts the user signed out of / deleted (or that the server ended)
   * → request-log length at that moment. A bearer for them must never go out
   * again (from that request on) until they sign back in. */
  private signedOutAccounts = new Map<string, number>();
  private requestCursor = 0;
  private faultsArmedBeforeStep = 0;
  /** Owners whose in-memory profile may legitimately differ from the local
   * row because an injected write failure hit; cleared by the next hydrate. */
  private durabilityDivergedOwners = new Set<string>();
  /** Keychain account that a relaunch knowingly ignored because a stale
   * guest marker (left by an injected kv write fault) took precedence. */
  private toleratedStaleVault: string | null = null;
  private lastDesiredOwner: string | null = null;
  private gateHydration: Promise<void> | null = null;
  private lastGateProfileNull = false;

  constructor(private readonly scenario: Scenario) {
    this.server = new FakeServer(
      scenario.bearerTtlSec * 1000,
      scenario.refreshReuseGraceMs,
    );
  }

  // ── process lifecycle ─────────────────────────────────────────────────────

  private resetProcessMemory(): void {
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    clearAccessStoreConfiguration();
    clearTrainingStoreConfiguration();
    setApiUnauthorizedListener(null);
    appStateListeners.clear();
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    useAuthStore.setState({
      hydrated: false,
      session: null,
      busy: false,
      error: null,
      deletionCleanup: null,
    });
    useAppStore.setState({
      hydrated: false,
      ownerKey: null,
      profile: null,
      hydrateError: null,
      onboardingBusy: false,
      onboardingError: null,
    });
    this.lastDesiredOwner = null;
    this.gateHydration = null;
    this.durabilityDivergedOwners.clear();
    this.toleratedStaleVault = null;
    this.model.stage = 'welcome';
    this.model.appState = 'active';
    this.model.inflightPermit = null;
  }

  /** Mirrors App.tsx Gate: derive the desired owner from auth and hydrate the
   * app store whenever it changes (INFERRED from App.tsx, not rendered). */
  private gateSync(): void {
    const auth = useAuthStore.getState();
    const desiredOwner = !auth.hydrated
      ? null
      : auth.session?.provider === 'guest'
        ? GUEST_DATA_OWNER
        : auth.session?.canonicalAppUserId
          ? canonicalDataOwner(auth.session.canonicalAppUserId)
          : SIGNED_OUT_DATA_OWNER;
    if (desiredOwner && desiredOwner !== this.lastDesiredOwner) {
      this.lastDesiredOwner = desiredOwner;
      this.durabilityDivergedOwners.delete(desiredOwner);
      this.gateHydration = useAppStore.getState().hydrate();
    }
  }

  private async awaitWithTimers<T>(
    promise: Promise<T>,
    capMs = SETTLE_CAP_MS,
  ): Promise<T | undefined> {
    let done = false;
    let value: T | undefined;
    let failure: unknown = null;
    let failed = false;
    promise.then(
      v => {
        done = true;
        value = v;
      },
      e => {
        done = true;
        failed = true;
        failure = e;
      },
    );
    await flushMicrotasks();
    let elapsed = 0;
    while (!done && elapsed < capMs) {
      await jest.advanceTimersByTimeAsync(50);
      elapsed += 50;
    }
    if (failed) throw failure;
    return value;
  }

  /** Lets every pending request answer/time out and every immediately-due
   * timer fire, without advancing far into the future. */
  private async settle(): Promise<void> {
    // Quiescence: a request's answer can trigger further requests (401 →
    // refresh → re-fetch), so keep going until a whole round issues nothing
    // new and nothing is pending.
    let elapsed = 0;
    let seenRequests = -1;
    for (
      let round = 0;
      round < 12 &&
      (seenRequests !== this.server.requests.length ||
        this.network.pending > 0);
      round += 1
    ) {
      seenRequests = this.server.requests.length;
      await flushMicrotasks(64);
      while (this.network.pending > 0 && elapsed < SETTLE_CAP_MS) {
        await jest.advanceTimersByTimeAsync(250);
        elapsed += 250;
      }
      await jest.advanceTimersByTimeAsync(1);
      await flushMicrotasks(64);
      if (this.gateHydration) await this.awaitWithTimers(this.gateHydration);
      this.gateSync();
      if (this.gateHydration) await this.awaitWithTimers(this.gateHydration);
      await flushMicrotasks(64);
    }
  }

  // ── observation ───────────────────────────────────────────────────────────

  private vault(): { canonicalAppUserId: string; refreshToken: string } | null {
    const item = __keychainStore.get(SESSION_VAULT_SERVICE);
    if (!item) return null;
    try {
      const parsed = JSON.parse(item.password) as {
        canonicalAppUserId?: unknown;
        refreshToken?: unknown;
      };
      return {
        canonicalAppUserId: String(parsed.canonicalAppUserId),
        refreshToken: String(parsed.refreshToken),
      };
    } catch {
      return { canonicalAppUserId: '<malformed>', refreshToken: '<malformed>' };
    }
  }

  snapshot(): Snapshot {
    const auth = useAuthStore.getState();
    const app = useAppStore.getState();
    const access = useAccessStore.getState();
    const api = getApiSession();
    const modelAccount =
      this.model.auth.kind === 'synced'
        ? this.server.accounts.get(this.model.auth.accountId)
        : null;
    return {
      auth: {
        hydrated: auth.hydrated,
        busy: auth.busy,
        session: auth.session
          ? {
              provider: auth.session.provider,
              canonicalAppUserId: auth.session.canonicalAppUserId,
              localOnly: auth.session.localOnly,
            }
          : null,
        error: auth.error?.code ?? null,
        deletionCleanup: auth.deletionCleanup?.localPurge ?? null,
      },
      owner: getActiveDataOwner(),
      apiSession: api
        ? {
            canonicalAppUserId: api.canonicalAppUserId,
            bearer: api.bearerToken,
            hasRefresh: Boolean(api.refreshToken),
            expiresAtMs: api.bearerExpiresAtMs ?? null,
          }
        : null,
      vault: this.vault(),
      guestMarker:
        mockKv.get('auth.local-mode') === '{"version":1,"mode":"guest"}',
      lastProvider: mockKv.get('auth.last-provider') || null,
      pendingStash: Boolean(mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)),
      app: {
        hydrated: app.hydrated,
        ownerKey: app.ownerKey,
        hasProfile: app.profile !== null,
        hydrateError: app.hydrateError,
        onboardingBusy: app.onboardingBusy,
      },
      access: {
        status: access.status,
        operation: access.operation,
        canonicalAccess: access.canonicalAccess as AccessView | null,
        error: access.error?.code ?? null,
      },
      network: this.network.mode,
      model: {
        auth:
          this.model.auth.kind === 'synced'
            ? `synced:${this.model.auth.identity}:${this.model.auth.accountId}`
            : this.model.auth.kind,
        stage: this.model.stage,
        appState: this.model.appState,
        inflightPermit: this.model.inflightPermit,
      },
      serverAccountLive: modelAccount ? !modelAccount.deleted : null,
    };
  }

  stateKey(): string {
    const s = this.snapshot();
    return [
      this.model.process,
      s.auth.session ? s.auth.session.provider : 'none',
      s.owner === SIGNED_OUT_DATA_OWNER
        ? 'signed-out'
        : s.owner === GUEST_DATA_OWNER
          ? 'guest'
          : 'canonical',
      s.apiSession ? 'api' : 'noapi',
      s.vault ? 'vault' : 'novault',
      s.app.hasProfile
        ? 'profile'
        : s.app.hydrateError
          ? 'apperr'
          : 'noprofile',
      s.access.status,
      s.network,
      this.model.appState,
    ].join('|');
  }

  private fail(
    invariant: InvariantId,
    message: string,
    stepIndex: number,
    step: Step,
  ): void {
    const meta = INVARIANTS[invariant];
    this.violations.push({
      invariant,
      severity: meta.severity,
      hard: meta.hard,
      message,
      stepIndex,
      step,
      snapshot: this.snapshot(),
    });
  }

  // ── invariants ────────────────────────────────────────────────────────────

  private checkInvariants(
    stepIndex: number,
    step: Step,
    context: { before: Snapshot; applied: boolean },
  ): void {
    if (this.model.process === 'dead') return;
    this.checkReuseRevocations(stepIndex, step);
    this.reconcileImplicitSignOut(stepIndex, step);
    const s = this.snapshot();
    const auth = useAuthStore.getState();
    const online = this.network.mode === 'ok';
    // Injected SQLite write failures during this step make local durability
    // expectations (row == memory, stash cleared) inapplicable for the step;
    // the stash/relaunch path is what recovers them and is checked later.
    const faultsConsumed =
      this.faultsArmedBeforeStep > mockDbControl.failNextWrites;
    if (faultsConsumed) this.durabilityDivergedOwners.add(s.owner);

    // owner-matches-session
    if (auth.hydrated) {
      const expectedOwner = !auth.session
        ? SIGNED_OUT_DATA_OWNER
        : auth.session.provider === 'guest'
          ? GUEST_DATA_OWNER
          : auth.session.canonicalAppUserId
            ? canonicalDataOwner(auth.session.canonicalAppUserId)
            : SIGNED_OUT_DATA_OWNER;
      if (s.owner !== expectedOwner) {
        this.fail(
          'owner-matches-session',
          `active owner ${s.owner} but session implies ${expectedOwner}`,
          stepIndex,
          step,
        );
      }
    }

    // api-session-bound-to-account
    if (s.apiSession) {
      const sessionAccount = auth.session?.canonicalAppUserId ?? null;
      if (!auth.session || auth.session.localOnly || !sessionAccount) {
        this.fail(
          'api-session-bound-to-account',
          `ApiSession for ${s.apiSession.canonicalAppUserId} while auth session is ${JSON.stringify(s.auth.session)}`,
          stepIndex,
          step,
        );
      } else if (sessionAccount !== s.apiSession.canonicalAppUserId) {
        this.fail(
          'api-session-bound-to-account',
          `ApiSession for ${s.apiSession.canonicalAppUserId} but signed in as ${sessionAccount}`,
          stepIndex,
          step,
        );
      }
    }

    // vault-matches-session
    if (s.vault && this.toleratedStaleVault !== s.vault.canonicalAppUserId) {
      if (auth.hydrated && (!auth.session || auth.session.localOnly)) {
        this.fail(
          'vault-matches-session',
          `Keychain still holds ${s.vault.canonicalAppUserId} while ${
            auth.session ? 'guest' : 'signed out'
          }`,
          stepIndex,
          step,
        );
      } else if (
        auth.session?.canonicalAppUserId &&
        auth.session.canonicalAppUserId !== s.vault.canonicalAppUserId
      ) {
        this.fail(
          'vault-matches-session',
          `Keychain holds ${s.vault.canonicalAppUserId} but signed in as ${auth.session.canonicalAppUserId}`,
          stepIndex,
          step,
        );
      }
    }

    // vault-refresh-token-server-valid (advisory). An out-of-band server
    // revocation is legitimately invisible to the client until its next
    // refresh, so only a token the CLIENT rotated away from (and failed to
    // persist) or one the server never issued counts.
    if (
      s.vault &&
      online &&
      auth.hydrated &&
      this.model.auth.kind === 'synced' &&
      s.apiSession
    ) {
      const serverSession = this.server.sessionsByRefresh.get(
        s.vault.refreshToken,
      );
      const honored =
        !serverSession ||
        serverSession.revoked ||
        serverSession.rotatedAtMs === null ||
        Date.now() - serverSession.rotatedAtMs <=
          this.scenario.refreshReuseGraceMs;
      if (!honored || !serverSession) {
        this.fail(
          'vault-refresh-token-server-valid',
          `persisted refresh token ${s.vault.refreshToken} is no longer honored by the server (${
            serverSession ? 'rotated away' : 'unknown'
          }) — a relaunch would sign the user out`,
          stepIndex,
          step,
        );
      }
    }

    // no-secret-in-sqlite
    for (const [key, value] of mockKv) {
      if (!value) continue;
      const leaks = /\b(at|rt)-\d+\b/.test(value) || value.includes('idtoken:');
      if (leaks) {
        this.fail(
          'no-secret-in-sqlite',
          `kv[${key}] contains session/provider material: ${value.slice(0, 80)}`,
          stepIndex,
          step,
        );
      }
    }

    // no-busy-after-settle
    if (this.network.pending === 0) {
      const access = useAccessStore.getState();
      const app = useAppStore.getState();
      const busy: string[] = [];
      if (auth.busy) busy.push('authStore.busy');
      if (app.onboardingBusy) busy.push('appStore.onboardingBusy');
      if (access.operation !== 'idle')
        busy.push(`accessStore.operation=${access.operation}`);
      if (access.status === 'loading') busy.push('accessStore.status=loading');
      if (busy.length) {
        this.fail(
          'no-busy-after-settle',
          `still busy after settle: ${busy.join(', ')}`,
          stepIndex,
          step,
        );
      }
    }

    // access-store-reset-on-account-change
    {
      const access = useAccessStore.getState();
      const synced = Boolean(auth.session && !auth.session.localOnly);
      if (!synced && (access.canonicalAccess || access.plans)) {
        this.fail(
          'access-store-reset-on-account-change',
          `accessStore holds ${access.canonicalAccess ? 'canonicalAccess' : 'plans'} while ${auth.session ? 'guest' : 'signed out'}`,
          stepIndex,
          step,
        );
      }
      if (
        synced &&
        access.canonicalAccess &&
        this.model.auth.kind === 'synced' &&
        this.accessFetchedFor !== null &&
        this.accessFetchedFor !== auth.session?.canonicalAppUserId
      ) {
        this.fail(
          'access-store-reset-on-account-change',
          `canonicalAccess fetched for ${this.accessFetchedFor} shown while signed in as ${auth.session?.canonicalAppUserId}`,
          stepIndex,
          step,
        );
      }
    }

    // profile-matches-owner
    {
      const app = useAppStore.getState();
      if (auth.hydrated && app.hydrated && this.network.pending === 0) {
        if (app.ownerKey !== s.owner) {
          this.fail(
            'profile-matches-owner',
            `appStore.ownerKey=${app.ownerKey} but active owner=${s.owner}`,
            stepIndex,
            step,
          );
        } else if (
          s.owner !== SIGNED_OUT_DATA_OWNER &&
          app.profile !== null &&
          !this.durabilityDivergedOwners.has(s.owner)
        ) {
          const local = mockKv.get(profileKeyForOwner(s.owner));
          if (!local || JSON.stringify(app.profile) !== local) {
            this.fail(
              'profile-matches-owner',
              `appStore.profile is not owner ${s.owner}'s local row`,
              stepIndex,
              step,
            );
          }
        }
      }
    }

    // profile-truth-after-reconnect (advisory)
    if (
      online &&
      this.network.pending === 0 &&
      this.model.auth.kind === 'synced' &&
      s.apiSession &&
      auth.hydrated
    ) {
      const app = useAppStore.getState();
      const account = this.server.accounts.get(this.model.auth.accountId);
      if (
        account &&
        !account.deleted &&
        account.profile &&
        app.hydrated &&
        app.profile === null &&
        app.hydrateError === null &&
        // A failed local write right after the server save shows the
        // questionnaire WITH an error and a retry (which re-PUTs); only the
        // silent variant is a finding.
        app.onboardingError === null
      ) {
        this.fail(
          'profile-truth-after-reconnect',
          `signed-in account has a server profile and a live bearer, yet the Gate would show the in-account questionnaire (profile null, no hydrateError, no onboardingError, nothing re-fetches; appStore.hydrate ran for owner ${app.ownerKey} before the ApiSession existed and App.tsx only re-hydrates on an owner change)`,
          stepIndex,
          step,
        );
      }
    }

    // bearer-fresh-after-resume: the keeper's contract is about the expiry
    // the CLIENT knows (refresh 60s ahead; on foreground when <5 min remain).
    if (
      online &&
      context.applied &&
      this.network.pending === 0 &&
      s.apiSession &&
      s.apiSession.expiresAtMs !== null &&
      s.apiSession.expiresAtMs <= Date.now() &&
      this.model.auth.kind === 'synced' &&
      (step.op === 'resume' || step.op === 'advance') &&
      this.model.appState === 'active' &&
      this.server.authenticate(s.apiSession.bearer, Date.now()) === null &&
      !this.signedOutAccounts.has(s.apiSession.canonicalAppUserId)
    ) {
      const serverSession = this.server.sessionsByAccess.get(
        s.apiSession.bearer,
      );
      const account = this.server.accounts.get(s.apiSession.canonicalAppUserId);
      if (
        account &&
        !account.deleted &&
        serverSession &&
        !serverSession.revoked
      ) {
        this.fail(
          'bearer-fresh-after-resume',
          `live bearer ${s.apiSession.bearer} expired server-side (exp ${serverSession.accessExpiresAtMs}, now ${Date.now()}) and was not rotated after ${step.op}`,
          stepIndex,
          step,
        );
      }
    }

    // expired-bearer-recovers: a 401 answered to the live account's bearer
    // while the server still honors the account must end in a rotated bearer
    // (reportApiUnauthorized → refreshSessionNow), never a sign-out.
    if (
      online &&
      this.network.pending === 0 &&
      this.model.auth.kind === 'synced' &&
      s.apiSession
    ) {
      const accountId = this.model.auth.accountId;
      const saw401 = this.server.requests
        .slice(this.requestCursor)
        .some(
          e =>
            e.status === 401 &&
            e.bearerAccount === accountId &&
            e.path !== '/v1/auth/refresh' &&
            e.path !== '/v1/auth/logout',
        );
      if (
        saw401 &&
        this.server.accountHonored(accountId) &&
        this.server.authenticate(s.apiSession.bearer, Date.now()) === null
      ) {
        this.fail(
          'expired-bearer-recovers',
          `a request got 401 for ${accountId}, the server still honors the account, yet the live bearer ${s.apiSession.bearer} is still rejected after settle`,
          stepIndex,
          step,
        );
      }
    }

    // no-bearer-after-sign-out / no-cross-account-bearer (request log scan)
    for (
      ;
      this.requestCursor < this.server.requests.length;
      this.requestCursor += 1
    ) {
      const entry = this.server.requests[this.requestCursor];
      if (!entry) continue;
      if (!entry.bearerAccount) continue;
      if (entry.path === '/v1/auth/logout') continue;
      const cutoff = this.signedOutAccounts.get(entry.bearerAccount);
      if (cutoff !== undefined && this.requestCursor >= cutoff) {
        this.fail(
          'no-bearer-after-sign-out',
          `request #${entry.n} ${entry.method} ${entry.path} carried bearer of signed-out account ${entry.bearerAccount}`,
          stepIndex,
          step,
        );
      }
      const current = this.model.auth;
      if (
        current.kind === 'synced' &&
        entry.bearerAccount !== current.accountId &&
        !this.signedOutAccounts.has(entry.bearerAccount)
      ) {
        this.fail(
          'no-cross-account-bearer',
          `request #${entry.n} ${entry.method} ${entry.path} used bearer of ${entry.bearerAccount} while ${current.accountId} is signed in`,
          stepIndex,
          step,
        );
      }
    }
  }

  private seenReuseRevocations = 0;

  private checkReuseRevocations(stepIndex: number, step: Step): void {
    for (
      ;
      this.seenReuseRevocations < this.server.reuseRevocations.length;
      this.seenReuseRevocations += 1
    ) {
      const r = this.server.reuseRevocations[this.seenReuseRevocations];
      if (!r) continue;
      const rotation = this.server.requests.find(
        e =>
          e.path === '/v1/auth/refresh' &&
          e.refreshToken === r.staleToken &&
          e.status === 200,
      );
      const lost = rotation ? rotation.outcome : 'unknown';
      this.fail(
        'no-refresh-reuse-revocation',
        `request #${r.requestN} presented refresh token ${r.staleToken} ${r.atMs - r.rotatedAtMs}ms after the server rotated it (grace ${this.scenario.refreshReuseGraceMs}ms); the rotation answer (request #${rotation?.n ?? '?'}) was ${lost}; the server revoked every session of ${r.accountId} → forced sign-out of an account in good standing`,
        stepIndex,
        step,
      );
    }
  }

  /** The model lags the implementation by design on the ONE legitimate
   * implicit sign-out: the server refused this account's refresh (revoked or
   * deleted) and the client observed it. Fold that into the model here; any
   * other disappearance of the session is a contract violation. */
  private reconcileImplicitSignOut(stepIndex: number, step: Step): void {
    const m = this.model;
    if (m.auth.kind !== 'synced') return;
    const real = useAuthStore.getState().session;
    if (real && real.canonicalAppUserId === m.auth.accountId) return;
    if (!useAuthStore.getState().hydrated) return;
    const accountId = m.auth.accountId;
    const account = this.server.accounts.get(accountId);
    const honored =
      Boolean(account && !account.deleted) &&
      this.server.accountHonored(accountId);
    if (honored) {
      this.fail(
        'no-unexpected-sign-out',
        `session for ${accountId} vanished (now ${JSON.stringify(real)}) although the server still honors that account's session`,
        stepIndex,
        step,
      );
    }
    this.signedOutAccounts.set(accountId, this.server.requests.length);
    m.auth = { kind: 'signedOut' };
    m.stage = 'welcome';
    m.inflightPermit = null;
  }

  /** Account whose access snapshot the store currently holds (tracked from
   * the request log: the last successful /v1/me/access or billing/sync). */
  private get accessFetchedFor(): string | null {
    for (let i = this.server.requests.length - 1; i >= 0; i -= 1) {
      const entry = this.server.requests[i];
      if (!entry) continue;
      if (
        (entry.path === '/v1/me/access' || entry.path === '/v1/billing/sync') &&
        entry.status === 200
      ) {
        return entry.bearerAccount;
      }
    }
    return null;
  }

  // ── step execution ────────────────────────────────────────────────────────

  private async guarded<T>(
    label: string,
    stepIndex: number,
    step: Step,
    fn: () => Promise<T>,
  ): Promise<T | undefined> {
    try {
      return await this.awaitWithTimers(fn());
    } catch (error) {
      this.fail(
        'no-unhandled-exception',
        `${label} rejected: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        stepIndex,
        step,
      );
      return undefined;
    }
  }

  private currentAccount(): ServerAccount | null {
    return this.model.auth.kind === 'synced'
      ? (this.server.accounts.get(this.model.auth.accountId) ?? null)
      : null;
  }

  async runStep(stepIndex: number, step: Step): Promise<StepRecord> {
    const before = this.snapshot();
    let applied = true;
    let note = '';
    const m = this.model;
    this.faultsArmedBeforeStep = mockDbControl.failNextWrites;

    if (
      m.process === 'dead' &&
      step.op !== 'launch' &&
      step.op !== 'wipeLocalDb' &&
      step.op !== 'dbWriteFault'
    ) {
      return {
        index: stepIndex,
        step,
        applied: false,
        note: 'process dead',
        snapshot: before,
        requests: [],
      };
    }
    const requestStart = this.server.requests.length;

    switch (step.op) {
      case 'launch': {
        const wasRunning = m.process === 'running';
        const vaultBefore = this.vault();
        const guestBefore =
          mockKv.get('auth.local-mode') === '{"version":1,"mode":"guest"}';
        if (wasRunning) this.network.epoch += 1;
        // Server truth about the persisted record is judged BEFORE the relaunch
        // issues its own refresh (which rotates the very token being judged).
        const serverSession = vaultBefore
          ? this.server.sessionsByRefresh.get(vaultBefore.refreshToken)
          : null;
        const vaultAccount = vaultBefore
          ? this.server.accounts.get(vaultBefore.canonicalAppUserId)
          : null;
        const vaultHonored = Boolean(
          serverSession &&
          !serverSession.revoked &&
          vaultAccount &&
          !vaultAccount.deleted &&
          (serverSession.rotatedAtMs === null ||
            Date.now() - serverSession.rotatedAtMs <=
              this.scenario.refreshReuseGraceMs),
        );
        this.resetProcessMemory();
        m.process = 'running';
        await this.guarded('authStore.hydrate', stepIndex, step, () =>
          useAuthStore.getState().hydrate(),
        );
        this.gateSync();
        await this.settle();
        // Postcondition: relaunch-restores-persisted-state.
        const auth = useAuthStore.getState();
        if (guestBefore) {
          m.auth = { kind: 'guest' };
          if (auth.session?.provider !== 'guest') {
            this.fail(
              'relaunch-restores-persisted-state',
              `guest marker present but relaunch produced ${JSON.stringify(auth.session)}`,
              stepIndex,
              step,
            );
          }
          if (vaultBefore && vaultAccount && !vaultAccount.deleted) {
            this.toleratedStaleVault = vaultBefore.canonicalAppUserId;
            this.fail(
              'persisted-layers-agree',
              `SQLite guest marker and a Keychain session for ${vaultBefore.canonicalAppUserId} coexist (a kv write failed at sign-in/sign-out); hydrate() reads the guest marker first, so the durable sign-in is silently dropped and the stale Keychain record is kept`,
              stepIndex,
              step,
            );
          }
        } else if (vaultBefore && vaultAccount) {
          // Only a refusal the DEVICE actually received ends the session; a
          // refresh that never answered (offline, 5xx, client timeout) keeps
          // the durable sign-in from the record alone.
          const delivered = this.server.requests
            .slice(requestStart)
            .filter(
              e => e.path === '/v1/auth/refresh' && e.outcome === 'delivered',
            );
          const refused = delivered.some(e => e.status === 401);
          const rotated = delivered.some(e => e.status === 200);
          if (refused) {
            m.auth = { kind: 'signedOut' };
            this.signedOutAccounts.set(
              vaultAccount.id,
              this.server.requests.length,
            );
            const why = vaultAccount.deleted
              ? 'account deleted server-side'
              : vaultHonored
                ? 'server refused a token it should have honored'
                : 'server no longer honors the persisted refresh token';
            if (auth.session !== null) {
              this.fail(
                'revoked-session-signs-out',
                `${why} and the relaunch received the 401, yet it is signed in as ${JSON.stringify(auth.session)}`,
                stepIndex,
                step,
              );
            }
            if (this.vault()) {
              this.fail(
                'revoked-session-signs-out',
                `${why}; the relaunch received the 401 but the Keychain record survived`,
                stepIndex,
                step,
              );
            }
            if (vaultAccount.deleted) {
              const ownerKey = canonicalDataOwner(vaultAccount.id);
              if (mockKv.has(profileKeyForOwner(ownerKey))) {
                this.fail(
                  'no-orphaned-local-data-after-lost-deletion',
                  `owner ${ownerKey} was deleted server-side; relaunch signed out but its local profile row survives on the device`,
                  stepIndex,
                  step,
                );
              }
            }
            note = `relaunch refresh refused (${why})`;
          } else {
            m.auth = {
              kind: 'synced',
              identity: vaultAccount.identity,
              accountId: vaultAccount.id,
            };
            const verdict = rotated
              ? 'the refresh rotated'
              : `no refresh verdict reached the device (net=${this.network.mode}${vaultHonored ? '' : '; the server WOULD refuse this token'})`;
            if (auth.session?.canonicalAppUserId !== vaultAccount.id) {
              this.fail(
                'relaunch-restores-persisted-state',
                `Keychain session for ${vaultAccount.id}; ${verdict}; relaunch must stay signed in but produced ${JSON.stringify(auth.session)}`,
                stepIndex,
                step,
              );
            }
            note = verdict;
          }
        } else {
          m.auth = { kind: 'signedOut' };
          if (auth.session !== null) {
            this.fail(
              'relaunch-restores-persisted-state',
              `nothing persisted yet relaunch produced ${JSON.stringify(auth.session)}`,
              stepIndex,
              step,
            );
          }
        }
        if (!auth.hydrated) {
          this.fail(
            'relaunch-restores-persisted-state',
            'authStore.hydrated is still false after launch settled',
            stepIndex,
            step,
          );
        }
        m.lastLaunchRestored = true;
        break;
      }

      case 'kill': {
        this.network.epoch += 1;
        m.process = 'dead';
        // In-flight continuations of the dead process must never run again;
        // the fake network drops their answers. Clear timers of the process.
        this.resetProcessMemory();
        m.appState = 'active';
        note = 'process killed; persisted layers untouched';
        break;
      }

      case 'getStarted': {
        if (m.auth.kind !== 'signedOut') {
          applied = false;
          note = 'not on welcome';
          break;
        }
        if (m.stage !== 'welcome') {
          applied = false;
          note = `stage=${m.stage}`;
          break;
        }
        const next = stageAfterGetStarted();
        if (next !== 'onboarding')
          this.fail(
            'pre-auth-stage-order',
            `getStarted → ${next}`,
            stepIndex,
            step,
          );
        m.stage = next;
        break;
      }

      case 'leaveOnboarding': {
        if (m.stage !== 'onboarding') {
          applied = false;
          note = `stage=${m.stage}`;
          break;
        }
        const next = stageWhenLeavingOnboarding();
        if (next !== 'welcome')
          this.fail(
            'pre-auth-stage-order',
            `leaveOnboarding → ${next}`,
            stepIndex,
            step,
          );
        m.stage = next;
        break;
      }

      case 'finishOnboarding': {
        if (m.auth.kind !== 'signedOut' || m.stage !== 'onboarding') {
          applied = false;
          note = `stage=${m.stage}`;
          break;
        }
        const ok = await this.guarded(
          'completePreAuthOnboarding',
          stepIndex,
          step,
          () =>
            useAppStore
              .getState()
              .completePreAuthOnboarding(PROFILES[step.profile]),
        );
        await this.settle();
        if (ok) {
          const next = stageAfterOnboarding();
          if (next !== 'signin')
            this.fail(
              'pre-auth-stage-order',
              `finishOnboarding → ${next}`,
              stepIndex,
              step,
            );
          m.stage = next;
          if (!mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)) {
            this.fail(
              'stash-adopted-by-first-owner',
              'completePreAuthOnboarding returned true but no stash was written',
              stepIndex,
              step,
            );
          }
        } else {
          note = 'stash write failed; stays on onboarding';
        }
        break;
      }

      case 'signIn': {
        if (m.auth.kind !== 'signedOut') {
          applied = false;
          note = 'sign-in only reachable signed out';
          break;
        }
        const identity = IDENTITIES[step.identity];
        const stashBefore = mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY);
        const nativeModules = NativeModules as { PickleAuth?: unknown };
        if (identity.provider === 'apple') {
          nativeModules.PickleAuth = {
            signInWithApple: step.userCancels
              ? async () => {
                  throw { code: 'auth.canceled', message: 'Sign-in canceled.' };
                }
              : async () => ({
                  user: `apple-opaque-${identity.key}`,
                  identityToken: identity.idToken,
                  authorizationCode: `code-${identity.key}`,
                  email: identity.email,
                  givenName: identity.name.split(' ')[0],
                  familyName: identity.name.split(' ')[1],
                }),
          };
        } else {
          mockGoogleSignin.signIn.mockImplementation(async () =>
            step.userCancels
              ? { type: 'cancelled', data: null }
              : {
                  type: 'success',
                  data: {
                    idToken: identity.idToken,
                    user: { name: identity.name, email: identity.email },
                  },
                },
          );
        }
        const accountBefore = this.server.accountForIdentity(identity.key);
        const signedOutCutoff = accountBefore
          ? this.signedOutAccounts.get(accountBefore.id)
          : undefined;
        if (accountBefore) this.signedOutAccounts.delete(accountBefore.id);
        await this.guarded(
          `signInWith${identity.provider}`,
          stepIndex,
          step,
          () =>
            identity.provider === 'apple'
              ? useAuthStore.getState().signInWithApple()
              : useAuthStore.getState().signInWithGoogle(),
        );
        this.gateSync();
        await this.settle();
        const auth = useAuthStore.getState();
        const accountAfter = this.server.accountForIdentity(identity.key);
        if (
          auth.session &&
          !auth.session.localOnly &&
          auth.session.canonicalAppUserId
        ) {
          const id = auth.session.canonicalAppUserId;
          this.signedOutAccounts.delete(id);
          this.toleratedStaleVault = null;
          m.auth = { kind: 'synced', identity: identity.key, accountId: id };
          m.stage = 'welcome';
          if (!accountAfter || accountAfter.id !== id) {
            this.fail(
              'api-session-bound-to-account',
              `signed in as ${id} but the server account for ${identity.key} is ${accountAfter?.id ?? 'none'}`,
              stepIndex,
              step,
            );
          }
          if (step.userCancels) {
            this.fail(
              'no-unhandled-exception',
              'user canceled sign-in yet a session was established',
              stepIndex,
              step,
            );
          }
          // Stash adoption (online): the first writable owner takes it.
          if (
            stashBefore &&
            this.network.mode === 'ok' &&
            this.faultsArmedBeforeStep === mockDbControl.failNextWrites
          ) {
            const app = useAppStore.getState();
            const adopted = JSON.parse(stashBefore) as { profile: Profile };
            if (mockKv.get(PENDING_ONBOARDING_PROFILE_KV_KEY)) {
              this.fail(
                'stash-adopted-by-first-owner',
                'pre-auth stash still pending after an online sign-in + hydrate',
                stepIndex,
                step,
              );
            } else if (
              !app.profile ||
              app.profile.goal !== adopted.profile.goal
            ) {
              this.fail(
                'stash-adopted-by-first-owner',
                `adopted profile goal ${app.profile?.goal ?? 'none'} != stash goal ${adopted.profile.goal}`,
                stepIndex,
                step,
              );
            } else if (
              accountAfter &&
              accountAfter.profile?.primary_goal !== adopted.profile.goal
            ) {
              this.fail(
                'stash-adopted-by-first-owner',
                'stash adopted locally but the canonical profile was not saved server-side',
                stepIndex,
                step,
              );
            }
          }
        } else {
          if (this.network.mode === 'ok' && !step.userCancels) {
            this.fail(
              'no-unhandled-exception',
              `online sign-in for ${identity.key} failed: ${auth.error?.code ?? 'no error'} ${auth.error?.message ?? ''}`,
              stepIndex,
              step,
            );
          }
          if (step.userCancels && auth.error?.code !== 'auth.canceled') {
            this.fail(
              'no-unhandled-exception',
              `canceled sign-in reported ${auth.error?.code ?? 'no error'}`,
              stepIndex,
              step,
            );
          }
          m.auth = { kind: 'signedOut' };
          if (accountBefore && signedOutCutoff !== undefined) {
            this.signedOutAccounts.set(accountBefore.id, signedOutCutoff);
          }
          note = `sign-in did not complete (${auth.error?.code ?? 'no error'})`;
          if (
            accountBefore === null &&
            accountAfter !== null &&
            this.network.mode !== 'ok'
          ) {
            note += '; server minted an account the device never learned about';
          }
        }
        break;
      }

      case 'guest': {
        if (m.auth.kind !== 'signedOut') {
          applied = false;
          note = 'only from signed out';
          break;
        }
        await this.guarded('continueAsGuest', stepIndex, step, () =>
          useAuthStore.getState().continueAsGuest(),
        );
        this.gateSync();
        await this.settle();
        m.auth = { kind: 'guest' };
        m.stage = 'welcome';
        break;
      }

      case 'completeAccountOnboarding': {
        const app = useAppStore.getState();
        if (
          m.auth.kind === 'signedOut' ||
          !app.hydrated ||
          app.profile !== null ||
          app.hydrateError
        ) {
          applied = false;
          note = 'in-account questionnaire not shown';
          break;
        }
        await this.guarded('completeOnboarding', stepIndex, step, () =>
          useAppStore.getState().completeOnboarding(PROFILES[step.profile]),
        );
        await this.settle();
        break;
      }

      case 'retryGate': {
        if (!useAppStore.getState().hydrateError) {
          applied = false;
          note = 'no hydrate error';
          break;
        }
        this.durabilityDivergedOwners.delete(getActiveDataOwner());
        this.gateHydration = useAppStore.getState().hydrate();
        await this.settle();
        break;
      }

      case 'analyze':
      case 'retry': {
        if (m.auth.kind === 'signedOut') {
          applied = false;
          note = 'Analyze tab unreachable signed out';
          break;
        }
        if (m.auth.kind === 'guest') {
          // useRatingRouteGate: localOnly → ConnectAccount. Nothing reserved.
          note = 'localOnly → ConnectAccount';
          break;
        }
        const access = useAccessStore.getState();
        const account = this.currentAccount();
        const serverView =
          account && !account.deleted ? this.server.accessView(account) : null;
        let decision: 'proceed' | 'paywall' | 'checking' = 'checking';
        if (access.canonicalAccess?.canStartRating) decision = 'proceed';
        else if (access.status === 'idle') {
          await this.guarded('accessStore.initialize', stepIndex, step, () =>
            useAccessStore.getState().initialize(),
          );
          await this.settle();
          const after = useAccessStore.getState();
          if (after.canonicalAccess?.canStartRating) decision = 'proceed';
          else if (
            after.canonicalAccess !== null ||
            after.status === 'ready' ||
            after.status === 'unconfigured' ||
            after.status === 'error'
          )
            decision = 'paywall';
        } else if (
          access.canonicalAccess !== null ||
          access.status === 'ready' ||
          access.status === 'unconfigured' ||
          access.status === 'error'
        ) {
          decision = 'paywall';
        }
        const sessionLive =
          useAuthStore.getState().session?.canonicalAppUserId === account?.id;
        if (this.network.mode === 'ok' && serverView && sessionLive) {
          if (
            decision === 'proceed' &&
            !serverView.canStartRating &&
            !access.canonicalAccess
          ) {
            this.fail(
              'rating-gate-matches-server',
              'gate proceeded with no snapshot while the server says paywall',
              stepIndex,
              step,
            );
          }
          if (decision === 'paywall' && serverView.canStartRating) {
            const after = useAccessStore.getState();
            const rejected401 = this.server.requests
              .slice(this.requestCursor)
              .some(
                e =>
                  e.path === '/v1/me/access' &&
                  e.status === 401 &&
                  e.bearerAccount === account?.id,
              );
            const detail = `server access is ${JSON.stringify(serverView)} (store: ${JSON.stringify(after.canonicalAccess)}, status ${after.status}, error ${after.error?.code ?? 'none'})`;
            if (after.status === 'error' && rejected401) {
              this.fail(
                'gate-recovers-after-bearer-rotation',
                `first access load got 401 on a bearer the server no longer accepts; the gate routed to Paywall (status stays 'error' after the refresh rotated the bearer) although ${detail}`,
                stepIndex,
                step,
              );
            } else if (
              after.status === 'error' &&
              after.canonicalAccess === null
            ) {
              this.fail(
                'gate-recovers-after-access-error',
                `an earlier access refresh failed and left status 'error' / snapshot null; with the network healthy again the gate routed straight to Paywall although ${detail}`,
                stepIndex,
                step,
              );
            } else if (
              after.status === 'unconfigured' &&
              getApiSession() === null
            ) {
              this.fail(
                'gate-before-bearer-restored',
                `signed in from the Keychain record but the launch refresh had not yet produced a bearer (accessStore never configured); Analyze routed straight to Paywall (status 'unconfigured', ${after.error?.code ?? 'no error'}) although ${detail}`,
                stepIndex,
                step,
              );
            } else {
              this.fail(
                'rating-gate-matches-server',
                `gate sent to paywall but ${detail}`,
                stepIndex,
                step,
              );
            }
          }
        }
        if (decision !== 'proceed' || !sessionLive) {
          note = `gate → ${decision}${sessionLive ? '' : ' (session ended mid-gate)'}`;
          break;
        }
        // Reserve before inference, exactly as runCaptureAnalysis does.
        const api = getApiSession();
        const permits = createAnalysisPermitClient({
          baseUrl: API_BASE_URL,
          get token() {
            return api ? bearerTokenFor(api.canonicalAppUserId) : null;
          },
        });
        const idempotencyKey = `rsm-${this.scenario.seed}-${this.scenario.index}-${stepIndex}`;
        try {
          const reserved = await this.awaitWithTimers(
            permits.reserve(idempotencyKey),
          );
          if (reserved) {
            m.inflightPermit = reserved.permit.id;
            note = `reserved ${reserved.permit.id} (${reserved.permit.accessSource})`;
            if (
              serverView &&
              !serverView.canStartRating &&
              this.network.mode === 'ok'
            ) {
              this.fail(
                'rating-gate-matches-server',
                'server reserved a permit although its own access view said paywall',
                stepIndex,
                step,
              );
            }
          }
        } catch (error) {
          if (error instanceof ApiError) {
            note = `reserve failed ${error.status} ${error.code}`;
            if (
              error.status === 402 &&
              serverView?.canStartRating &&
              this.network.mode === 'ok'
            ) {
              this.fail(
                'rating-gate-matches-server',
                'server answered paywall_required while its access view allows a rating',
                stepIndex,
                step,
              );
            }
          } else {
            note = `reserve threw ${error instanceof Error ? error.name : String(error)}`;
          }
        }
        // AnalyzeScreen unmount: re-read the ledger once a run touched it.
        if (useAccessStore.getState().status !== 'idle') {
          await this.guarded('accessStore.refreshAccess', stepIndex, step, () =>
            useAccessStore.getState().refreshAccess(),
          );
        }
        await this.settle();
        this.checkAccessSnapshot(stepIndex, step);
        break;
      }

      case 'cancel': {
        if (!m.inflightPermit || m.auth.kind !== 'synced') {
          applied = false;
          note = 'nothing in flight';
          break;
        }
        const api = getApiSession();
        const permits = createAnalysisPermitClient({
          baseUrl: API_BASE_URL,
          get token() {
            return api ? bearerTokenFor(api.canonicalAppUserId) : null;
          },
        });
        try {
          await this.awaitWithTimers(
            permits.release(m.inflightPermit, 'failed'),
          );
          note = `released ${m.inflightPermit}`;
        } catch (error) {
          note = `release failed: ${error instanceof Error ? error.message : String(error)}`;
        }
        m.inflightPermit = null;
        if (useAccessStore.getState().status !== 'idle') {
          await this.guarded('accessStore.refreshAccess', stepIndex, step, () =>
            useAccessStore.getState().refreshAccess(),
          );
        }
        await this.settle();
        this.checkAccessSnapshot(stepIndex, step);
        break;
      }

      case 'score': {
        if (!m.inflightPermit || m.auth.kind !== 'synced') {
          applied = false;
          note = 'nothing in flight';
          break;
        }
        // The shot-sync transaction consumes the permit server-side.
        this.server.consumePermit(m.inflightPermit);
        note = `server consumed ${m.inflightPermit}`;
        m.inflightPermit = null;
        if (useAccessStore.getState().status !== 'idle') {
          await this.guarded('accessStore.refreshAccess', stepIndex, step, () =>
            useAccessStore.getState().refreshAccess(),
          );
        }
        await this.settle();
        this.checkAccessSnapshot(stepIndex, step);
        break;
      }

      case 'history': {
        // Settings focus: refresh the ledger for synced sessions unless a
        // load is in flight (SettingsScreen useFocusEffect).
        const auth = useAuthStore.getState();
        if (
          auth.session &&
          !auth.session.localOnly &&
          useAccessStore.getState().status !== 'loading'
        ) {
          await this.guarded('accessStore.refreshAccess', stepIndex, step, () =>
            useAccessStore.getState().refreshAccess(),
          );
        } else {
          note = 'no synced session; local history only';
        }
        await this.settle();
        this.checkAccessSnapshot(stepIndex, step);
        // Identity ledger: used ratings follow the sign-in identity.
        if (m.auth.kind === 'synced' && this.network.mode === 'ok') {
          const shown = useAccessStore.getState().canonicalAccess;
          const expectedUsed = Math.min(
            2,
            this.server.identityLedger.get(m.auth.identity) ?? 0,
          );
          if (shown && shown.freeRatings.used !== expectedUsed) {
            this.fail(
              'deletion-ledger-survives-identity',
              `shown used=${shown.freeRatings.used} but identity ledger says ${expectedUsed}`,
              stepIndex,
              step,
            );
          }
        }
        break;
      }

      case 'purchase': {
        if (m.auth.kind !== 'synced') {
          applied = false;
          note = 'paywall unreachable';
          break;
        }
        if (useAccessStore.getState().status === 'idle') {
          await this.guarded('accessStore.initialize', stepIndex, step, () =>
            useAccessStore.getState().initialize(),
          );
          await this.settle();
        }
        await this.guarded(
          'accessStore.purchaseSelected',
          stepIndex,
          step,
          () => useAccessStore.getState().purchaseSelected(),
        );
        await this.settle();
        break;
      }

      case 'logout': {
        if (m.auth.kind === 'signedOut') {
          applied = false;
          note = 'already signed out';
          break;
        }
        const account = this.currentAccount();
        const bearer = getApiSession()?.bearerToken ?? null;
        const cutoff = this.server.requests.length;
        this.toleratedStaleVault = null;
        await this.guarded('signOut', stepIndex, step, () =>
          useAuthStore.getState().signOut(),
        );
        this.gateSync();
        await this.settle();
        if (account) this.signedOutAccounts.set(account.id, cutoff);
        m.auth = { kind: 'signedOut' };
        m.stage = 'welcome';
        m.inflightPermit = null;
        const auth = useAuthStore.getState();
        if (auth.session !== null)
          this.fail(
            'owner-matches-session',
            'signOut left a session',
            stepIndex,
            step,
          );
        if (this.vault())
          this.fail(
            'vault-matches-session',
            'signOut left the Keychain record',
            stepIndex,
            step,
          );
        if (getApiSession())
          this.fail(
            'api-session-bound-to-account',
            'signOut left an ApiSession',
            stepIndex,
            step,
          );
        if (account && bearer && this.network.mode === 'ok') {
          const serverSession = this.server.sessionsByAccess.get(bearer);
          if (serverSession && !serverSession.revoked) {
            this.fail(
              'sign-out-revokes-server-session',
              `server session ${serverSession.refreshToken} still valid after an online sign-out`,
              stepIndex,
              step,
            );
          }
        }
        break;
      }

      case 'background': {
        if (m.appState === 'background') {
          applied = false;
          note = 'already background';
          break;
        }
        emitAppState('inactive');
        emitAppState('background');
        m.appState = 'background';
        await this.settle();
        break;
      }

      case 'resume': {
        if (m.appState !== 'background') {
          applied = false;
          note = 'already active';
          break;
        }
        emitAppState('active');
        m.appState = 'active';
        await this.settle();
        // A resume with a live account online must end with a fresh bearer.
        break;
      }

      case 'advance': {
        if (m.appState === 'background') {
          // iOS suspends the process: the clock moves, timers do not fire.
          jest.setSystemTime(Date.now() + step.ms);
          note = `clock +${step.ms}ms (suspended)`;
        } else {
          await jest.advanceTimersByTimeAsync(step.ms);
          note = `timers +${step.ms}ms`;
        }
        await this.settle();
        break;
      }

      case 'network': {
        this.network.mode = step.mode;
        this.network.delayMs = step.mode === 'slow' ? step.delayMs : 0;
        break;
      }

      case 'serverRevoke': {
        const account = this.currentAccount();
        if (!account) {
          applied = false;
          note = 'no synced account';
          break;
        }
        this.server.revokeAccount(account.id);
        note = `server revoked every session of ${account.id}`;
        break;
      }

      case 'expireBearer': {
        const api = getApiSession();
        if (!api) {
          applied = false;
          note = 'no bearer';
          break;
        }
        this.server.expireAccess(api.bearerToken);
        note = `server expired bearer ${api.bearerToken}`;
        break;
      }

      case 'delete': {
        if (m.auth.kind !== 'synced') {
          applied = false;
          note = 'Manage account unreachable';
          break;
        }
        const account = this.currentAccount();
        const ownerKey = canonicalDataOwner(m.auth.accountId);
        let challenge: string | null = null;
        try {
          const result = await this.awaitWithTimers(
            requestAccountDeletion(getApiSession(), null),
          );
          challenge = result?.challenge ?? null;
        } catch (error) {
          note = `delete-request failed: ${error instanceof AccountDeletionError ? error.code : String(error)}`;
        }
        if (!challenge) {
          await this.settle();
          break;
        }
        let confirmed = false;
        try {
          const result = await this.awaitWithTimers(
            confirmAccountDeletion(getApiSession(), challenge),
          );
          confirmed = Boolean(result);
        } catch (error) {
          note = `delete-confirm failed: ${error instanceof AccountDeletionError ? error.code : String(error)}`;
        }
        if (!confirmed) {
          await this.settle();
          if (account?.deleted)
            note +=
              '; SERVER DELETED the account but the device never learned (response lost)';
          break;
        }
        const cutoff = this.server.requests.length;
        await this.guarded('completeAccountDeletion', stepIndex, step, () =>
          useAuthStore.getState().completeAccountDeletion(),
        );
        this.gateSync();
        await this.settle();
        if (account) this.signedOutAccounts.set(account.id, cutoff);
        m.auth = { kind: 'signedOut' };
        m.stage = 'welcome';
        m.inflightPermit = null;
        const auth = useAuthStore.getState();
        if (auth.session !== null)
          this.fail(
            'deletion-purges-local-owner-data',
            'session survived completeAccountDeletion',
            stepIndex,
            step,
          );
        if (this.vault())
          this.fail(
            'deletion-purges-local-owner-data',
            'Keychain record survived completeAccountDeletion',
            stepIndex,
            step,
          );
        if (mockKv.has(profileKeyForOwner(ownerKey)))
          this.fail(
            'deletion-purges-local-owner-data',
            `profile row for ${ownerKey} survived completeAccountDeletion`,
            stepIndex,
            step,
          );
        if (auth.deletionCleanup?.localPurge !== 'complete')
          this.fail(
            'deletion-purges-local-owner-data',
            `deletionCleanup=${auth.deletionCleanup?.localPurge ?? 'null'}`,
            stepIndex,
            step,
          );
        if (account && !account.deleted)
          this.fail(
            'deletion-purges-local-owner-data',
            'client completed deletion but the server account is still live',
            stepIndex,
            step,
          );
        note = `deleted ${ownerKey}`;
        break;
      }

      case 'wipeLocalDb': {
        // App deleted and reinstalled: SQLite is gone, the Keychain survives.
        if (m.process === 'running') {
          applied = false;
          note = 'only while killed';
          break;
        }
        mockKv.clear();
        note = 'SQLite wiped (reinstall); Keychain kept';
        break;
      }

      case 'dbWriteFault': {
        mockDbControl.failNextWrites = step.count;
        note = `next ${step.count} kv writes fail`;
        break;
      }
    }

    this.checkInvariants(stepIndex, step, { before, applied });
    return {
      index: stepIndex,
      step,
      applied,
      note,
      snapshot: this.snapshot(),
      requests: this.server.requests
        .slice(requestStart)
        .map(
          r =>
            `#${r.n} t=${r.atMs} ${r.method} ${r.path}${r.bearer ? ` [${r.bearer}]` : ''}${r.refreshToken ? ` {${r.refreshToken}}` : ''} → ${r.status} (${r.outcome})`,
        ),
    };
  }

  private checkAccessSnapshot(stepIndex: number, step: Step): void {
    if (this.network.mode !== 'ok' || this.network.pending > 0) return;
    const account = this.currentAccount();
    if (!account || account.deleted) return;
    const shown = useAccessStore.getState().canonicalAccess;
    if (!shown) return;
    const expected = this.server.accessView(account);
    if (JSON.stringify(shown) !== JSON.stringify(expected)) {
      this.fail(
        'access-snapshot-matches-server',
        `store ${JSON.stringify(shown)} != server ${JSON.stringify(expected)}`,
        stepIndex,
        step,
      );
    }
  }
}

// ─── Generator ───────────────────────────────────────────────────────────────

const SLOW_DELAYS = [1_500, 9_000, 16_000, 22_000] as const;
const FOREGROUND_ADVANCES = [5_000, 30_000, 70_000, 300_000, 601_000] as const;
const BACKGROUND_ADVANCES = [30_000, 300_000, 3_600_000, 90_000_000] as const;
const BEARER_TTLS = [120, 600, 3_600] as const;

/** A light abstract model used only to bias generation toward reachable,
 * interesting transitions; the executor re-validates applicability. */
interface GenState {
  process: 'running' | 'dead';
  auth: 'signedOut' | 'guest' | 'synced';
  stage: PreAuthStage;
  appState: 'active' | 'background';
  inflight: boolean;
  network: NetworkMode;
  /** A kv write fault is armed: hydrate/onboarding may error → retryGate. */
  faultArmed: boolean;
}

function generateScenario(
  seed: number,
  index: number,
  stepsMin: number,
  stepsMax: number,
): Scenario {
  const rng = new Rng(scenarioSeed(seed, index));
  const stepCount = stepsMin + rng.int(stepsMax - stepsMin + 1);
  const steps: Step[] = [{ op: 'launch' }];
  const g: GenState = {
    process: 'running',
    auth: 'signedOut',
    stage: 'welcome',
    appState: 'active',
    inflight: false,
    network: 'ok',
    faultArmed: false,
  };
  // One scenario in ten opens with a directed "reinstall while a kv write
  // fault is armed" preamble: it is the only realistic way into the Gate's
  // hydrateError → retry path (a wiped SQLite + a Keychain session + the
  // canonical profile fetch succeeding but its local write failing), which
  // undirected sampling almost never reaches.
  if (rng.chance(0.1)) {
    const identity = rng.pick(IDENTITY_KEYS);
    steps.push(
      { op: 'signIn', identity, userCancels: false },
      materialize('completeAccountOnboarding', rng),
      { op: 'kill' },
      { op: 'wipeLocalDb' },
      { op: 'dbWriteFault', count: 3 },
      { op: 'launch' },
      { op: 'retryGate' },
    );
    g.auth = 'synced';
  } else if (rng.chance(0.08)) {
    // Reinstall (Keychain survives, SQLite does not) followed by an
    // offline / degraded launch, then connectivity returns.
    const identity = rng.pick(IDENTITY_KEYS);
    steps.push(
      { op: 'signIn', identity, userCancels: false },
      materialize('completeAccountOnboarding', rng),
      {
        op: 'network',
        mode: rng.pick(['offline', 'error', 'slow'] as const),
        delayMs: rng.pick(SLOW_DELAYS),
      },
      { op: 'kill' },
      { op: 'wipeLocalDb' },
      { op: 'launch' },
      { op: 'network', mode: 'ok', delayMs: 0 },
      { op: 'advance', ms: rng.pick(FOREGROUND_ADVANCES) },
    );
    g.auth = 'synced';
  }
  while (steps.length < stepCount) {
    let step: Step;
    if (g.process === 'dead') {
      step =
        rng.weighted({ launch: 6, wipeLocalDb: 2, dbWriteFault: 1 }) ===
        'launch'
          ? { op: 'launch' }
          : rng.chance(0.7)
            ? { op: 'wipeLocalDb' }
            : materialize('dbWriteFault', rng);
    } else if (g.appState === 'background') {
      const op = rng.weighted({
        resume: 6,
        advance: 4,
        kill: 1,
        serverRevoke: 1,
        network: 1,
        expireBearer: 1,
      });
      step =
        op === 'advance'
          ? { op, ms: rng.pick(BACKGROUND_ADVANCES) }
          : op === 'network'
            ? {
                op,
                mode: rng.pick([
                  'ok',
                  'ok',
                  'offline',
                  'error',
                  'slow',
                ] as const),
                delayMs: rng.pick(SLOW_DELAYS),
              }
            : { op };
    } else if (g.auth === 'signedOut') {
      const weights: Record<string, number> = {
        getStarted: g.stage === 'welcome' ? 5 : 0,
        leaveOnboarding: g.stage === 'onboarding' ? 1 : 0,
        finishOnboarding: g.stage === 'onboarding' ? 5 : 0,
        signIn: g.stage === 'signin' ? 10 : 3,
        guest: 1,
        launch: 1,
        kill: 1,
        network: 2,
        advance: 1,
        background: 1,
        analyze: 0.5,
        history: 0.5,
        dbWriteFault: 1,
        retryGate: g.faultArmed ? 2 : 0.2,
      };
      step = materialize(rng.weighted(weights), rng);
    } else if (g.auth === 'guest') {
      step = materialize(
        rng.weighted({
          analyze: 3,
          history: 2,
          logout: 4,
          launch: 2,
          kill: 1.5,
          background: 2,
          network: 1,
          advance: 1,
          completeAccountOnboarding: 2,
          dbWriteFault: 0.5,
          retryGate: g.faultArmed ? 2 : 0.2,
        }),
        rng,
      );
    } else {
      step = materialize(
        rng.weighted({
          analyze: 8,
          cancel: g.inflight ? 4 : 0,
          score: g.inflight ? 4 : 0,
          retry: 2,
          history: 4,
          purchase: 1,
          logout: 3,
          background: 4,
          advance: 4,
          network: 3,
          serverRevoke: 1.5,
          expireBearer: 2,
          delete: 2,
          launch: 2,
          kill: 2.5,
          completeAccountOnboarding: 1,
          retryGate: g.faultArmed ? 4 : 0.5,
          dbWriteFault: 1,
          signIn: 0.5,
        }),
        rng,
      );
    }
    steps.push(step);
    // Advance the light model.
    switch (step.op) {
      case 'launch':
        g.process = 'running';
        g.appState = 'active';
        g.inflight = false;
        break;
      case 'kill':
        g.process = 'dead';
        g.inflight = false;
        break;
      case 'getStarted':
        g.stage = 'onboarding';
        break;
      case 'leaveOnboarding':
        g.stage = 'welcome';
        break;
      case 'finishOnboarding':
        g.stage = 'signin';
        break;
      case 'signIn':
        if (!step.userCancels && g.network === 'ok') {
          g.auth = 'synced';
          g.stage = 'welcome';
        }
        break;
      case 'guest':
        g.auth = 'guest';
        break;
      case 'analyze':
      case 'retry':
        if (g.auth === 'synced' && g.network === 'ok') g.inflight = true;
        break;
      case 'cancel':
      case 'score':
        g.inflight = false;
        break;
      case 'logout':
        g.auth = 'signedOut';
        g.inflight = false;
        g.stage = 'welcome';
        break;
      case 'delete':
        if (g.network === 'ok') {
          g.auth = 'signedOut';
          g.inflight = false;
        }
        break;
      case 'background':
        g.appState = 'background';
        break;
      case 'resume':
        g.appState = 'active';
        break;
      case 'network':
        g.network = step.mode;
        break;
      case 'serverRevoke':
        if (g.network === 'ok')
          g.auth = g.auth === 'synced' && rng.chance(0.5) ? 'synced' : g.auth;
        break;
      case 'dbWriteFault':
        g.faultArmed = true;
        break;
      case 'retryGate':
        g.faultArmed = false;
        break;
      default:
        break;
    }
  }
  // Always end with a relaunch so persisted state is exercised at least once
  // more after whatever the sequence did.
  if (g.appState === 'background') steps.push({ op: 'resume' });
  steps.push({ op: 'launch' });
  return {
    seed,
    index,
    bearerTtlSec: rng.pick(BEARER_TTLS),
    refreshReuseGraceMs: 10_000,
    steps,
  };
}

function materialize(op: string, rng: Rng): Step {
  switch (op) {
    case 'finishOnboarding':
    case 'completeAccountOnboarding':
      return {
        op,
        profile: rng.pick(['dinks', 'drops', 'serve', 'volleys'] as const),
      };
    case 'signIn':
      return {
        op: 'signIn',
        identity: rng.pick(IDENTITY_KEYS),
        userCancels: rng.chance(0.12),
      };
    case 'advance':
      return { op: 'advance', ms: rng.pick(FOREGROUND_ADVANCES) };
    case 'network':
      return {
        op: 'network',
        mode: rng.pick([
          'ok',
          'ok',
          'ok',
          'offline',
          'error',
          'slow',
          'slow',
        ] as const),
        delayMs: rng.pick(SLOW_DELAYS),
      };
    case 'dbWriteFault':
      return { op: 'dbWriteFault', count: 1 + rng.int(3) };
    default:
      return {
        op: op as Exclude<
          Op,
          | 'finishOnboarding'
          | 'completeAccountOnboarding'
          | 'signIn'
          | 'advance'
          | 'network'
          | 'dbWriteFault'
        >,
      };
  }
}

// ─── Runner / shrinker ───────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

function resetWorld(): void {
  mockKv.clear();
  mockDbControl.failNextWrites = 0;
  __keychainStore.clear();
  appStateListeners.clear();
  stopSessionKeeper();
  clearSyncRuntime();
  clearApiSession();
  clearAccessStoreConfiguration();
  clearTrainingStoreConfiguration();
  setApiUnauthorizedListener(null);
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAuthStore.setState({
    hydrated: false,
    session: null,
    busy: false,
    error: null,
    deletionCleanup: null,
  });
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  mockGoogleSignin.signIn.mockReset();
  jest.clearAllTimers();
  jest.setSystemTime(new Date('2026-09-04T12:00:00Z'));
}

async function runScenario(scenario: Scenario): Promise<ScenarioResult> {
  resetWorld();
  const harness = new Harness(scenario);
  installFakeFetch(harness.server, harness.network);
  // syncRuntime jitter is the only Math.random on these paths; pin it so a
  // replay schedules identically.
  const jitter = new Rng(
    scenarioSeed(scenario.seed, scenario.index) ^ 0x5bd1e995,
  );
  const randomSpy = jest
    .spyOn(Math, 'random')
    .mockImplementation(() => jitter.next());
  const steps: StepRecord[] = [];
  const opsExecuted: Record<string, number> = {};
  const statesSeen = new Set<string>();
  try {
    for (let i = 0; i < scenario.steps.length; i += 1) {
      const step = scenario.steps[i];
      if (!step) continue;
      const record = await harness.runStep(i, step);
      steps.push(record);
      if (record.applied)
        opsExecuted[step.op] = (opsExecuted[step.op] ?? 0) + 1;
      statesSeen.add(harness.stateKey());
    }
  } finally {
    randomSpy.mockRestore();
    // Leave nothing running between scenarios.
    harness.network.epoch += 1;
    stopSessionKeeper();
    clearSyncRuntime();
    clearApiSession();
    clearAccessStoreConfiguration();
    clearTrainingStoreConfiguration();
    setApiUnauthorizedListener(null);
    appStateListeners.clear();
    jest.clearAllTimers();
  }
  return {
    scenario,
    ok: harness.violations.length === 0,
    steps,
    violations: harness.violations,
    opsExecuted,
    statesSeen,
    requestCount: harness.server.requests.length,
  };
}

/** Delta-debugging by step deletion: keep removing chunks while the SAME
 * invariant still fails. Bounded so a pathological case cannot stall CI. */
async function minimizeScenario(
  scenario: Scenario,
  target: InvariantId,
  budget = 160,
): Promise<{ minimized: Scenario; runs: number }> {
  let current = scenario;
  let runs = 0;
  const reproduces = async (candidate: Scenario) => {
    runs += 1;
    const result = await runScenario(candidate);
    return result.violations.some(v => v.invariant === target);
  };
  let chunk = Math.max(1, Math.floor(current.steps.length / 2));
  while (chunk >= 1 && runs < budget) {
    let removedAny = false;
    for (let start = 0; start < current.steps.length && runs < budget;) {
      const candidateSteps = [
        ...current.steps.slice(0, start),
        ...current.steps.slice(start + chunk),
      ];
      if (candidateSteps.length === 0) {
        start += chunk;
        continue;
      }
      const candidate: Scenario = { ...current, steps: candidateSteps };
      if (await reproduces(candidate)) {
        current = candidate;
        removedAny = true;
      } else {
        start += chunk;
      }
    }
    if (!removedAny) chunk = Math.floor(chunk / 2);
  }
  return { minimized: current, runs };
}

// ─── Campaign wiring ─────────────────────────────────────────────────────────

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const value = raw ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : fallback;
};
const SEED_START = envInt('RSM_SEED_START', 1000);
const SEED_END = envInt('RSM_SEED_END', 1099);
const SEQUENCES_PER_SEED = envInt('RSM_SEQUENCES_PER_SEED', 20);
const TOTAL_SCENARIOS = (SEED_END - SEED_START + 1) * SEQUENCES_PER_SEED;
const STEPS_MIN = envInt('RSM_STEPS_MIN', 8);
const STEPS_MAX = envInt('RSM_STEPS_MAX', 28);
const REPLAY_PATH = process.env.RSM_REPLAY ?? null;
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const ARTIFACT_DIR =
  process.env.RSM_ARTIFACT_DIR ??
  path.resolve(
    __dirname,
    '../../../../artifacts/randomized-state-machine',
    RUN_ID,
  );

interface FailureRecord {
  seed: number;
  index: number;
  invariant: InvariantId;
  severity: Violation['severity'];
  hard: boolean;
  message: string;
  stepIndex: number;
  step: Step;
  scenario: Scenario;
  minimized: Scenario;
  minimizeRuns: number;
  minimizedTrace: Array<{
    index: number;
    op: string;
    applied: boolean;
    note: string;
    state: string;
  }>;
  snapshot: Snapshot;
  replay: string;
}

interface SeedRow {
  seed: number;
  scenarios: number;
  steps: number;
  requests: number;
  failures: number;
  hardFailures: number;
  invariants: Partial<Record<InvariantId, number>>;
  durationMs: number;
  heapUsedMb: number;
  rssMb: number;
}

const campaign = {
  rows: [] as SeedRow[],
  failures: [] as FailureRecord[],
  opCoverage: {} as Record<string, number>,
  opViolationMatrix: {} as Record<string, Partial<Record<InvariantId, number>>>,
  statesSeen: new Set<string>(),
  log: [] as string[],
};

function log(line: string): void {
  campaign.log.push(`${new Date().toISOString()} ${line}`);
}

function writeArtifacts(): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const totalScenarios = campaign.rows.reduce((n, r) => n + r.scenarios, 0);
  const summary = {
    runId: RUN_ID,
    commit: process.env.GITHUB_SHA ?? process.env.RSM_COMMIT ?? null,
    seeds: { start: SEED_START, end: SEED_END },
    sequencesPerSeed: SEQUENCES_PER_SEED,
    steps: { min: STEPS_MIN, max: STEPS_MAX },
    totalScenarios,
    totalSteps: campaign.rows.reduce((n, r) => n + r.steps, 0),
    totalRequests: campaign.rows.reduce((n, r) => n + r.requests, 0),
    totalFailures: campaign.failures.length,
    hardFailures: campaign.failures.filter(f => f.hard).length,
    advisoryFailures: campaign.failures.filter(f => !f.hard).length,
    failuresByInvariant: campaign.failures.reduce<
      Partial<Record<InvariantId, number>>
    >((acc, f) => {
      acc[f.invariant] = (acc[f.invariant] ?? 0) + 1;
      return acc;
    }, {}),
    distinctStatesSeen: campaign.statesSeen.size,
    invariants: INVARIANTS,
    rows: campaign.rows,
  };
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'summary.json'),
    JSON.stringify(summary, null, 2),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'failures.json'),
    JSON.stringify(campaign.failures, null, 2),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'matrix.json'),
    JSON.stringify(
      {
        opCoverage: campaign.opCoverage,
        opsNeverExecuted: ALL_OPS.filter(op => !campaign.opCoverage[op]),
        opViolationMatrix: campaign.opViolationMatrix,
        statesSeen: [...campaign.statesSeen].sort(),
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'heap.json'),
    JSON.stringify(
      campaign.rows.map(r => ({
        seed: r.seed,
        heapUsedMb: r.heapUsedMb,
        rssMb: r.rssMb,
        durationMs: r.durationMs,
      })),
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(ARTIFACT_DIR, 'run.log'),
    campaign.log.join('\n') + '\n',
  );
}

function traceOf(result: ScenarioResult) {
  return result.steps.map(s => ({
    index: s.index,
    op: s.step.op,
    applied: s.applied,
    note: s.note,
    requests: s.requests,
    state: `${s.snapshot.model.auth} owner=${s.snapshot.owner} api=${s.snapshot.apiSession ? 'yes' : 'no'} vault=${s.snapshot.vault ? 'yes' : 'no'} profile=${s.snapshot.app.hasProfile} access=${s.snapshot.access.status} net=${s.snapshot.network}`,
  }));
}

// Captured before jest.useFakeTimers() installs its own process.hrtime.
const realHrtimeBigint = process.hrtime.bigint.bind(process.hrtime);
const wallClockMs = (): number => Number(realHrtimeBigint() / 1_000_000n);

async function runSeed(
  seed: number,
): Promise<{ row: SeedRow; hardMessages: string[] }> {
  const row: SeedRow = {
    seed,
    scenarios: 0,
    steps: 0,
    requests: 0,
    failures: 0,
    hardFailures: 0,
    invariants: {},
    durationMs: 0,
    heapUsedMb: 0,
    rssMb: 0,
  };
  const hardMessages: string[] = [];
  const realNowStart = wallClockMs();
  for (let index = 0; index < SEQUENCES_PER_SEED; index += 1) {
    const scenario = generateScenario(seed, index, STEPS_MIN, STEPS_MAX);
    const result = await runScenario(scenario);
    row.scenarios += 1;
    row.steps += scenario.steps.length;
    row.requests += result.requestCount;
    for (const [op, n] of Object.entries(result.opsExecuted)) {
      campaign.opCoverage[op] = (campaign.opCoverage[op] ?? 0) + n;
    }
    for (const state of result.statesSeen) campaign.statesSeen.add(state);
    if (result.violations.length === 0) continue;
    // One record per distinct invariant per scenario, minimized separately.
    const seen = new Set<InvariantId>();
    for (const violation of result.violations) {
      if (seen.has(violation.invariant)) continue;
      seen.add(violation.invariant);
      row.failures += 1;
      if (violation.hard) row.hardFailures += 1;
      row.invariants[violation.invariant] =
        (row.invariants[violation.invariant] ?? 0) + 1;
      const opKey = violation.step.op;
      const cell = (campaign.opViolationMatrix[opKey] ??= {});
      cell[violation.invariant] = (cell[violation.invariant] ?? 0) + 1;
      log(
        `seed ${seed} idx ${index} ${violation.hard ? 'HARD' : 'advisory'} ${violation.invariant}: ${violation.message}`,
      );
      const { minimized, runs } = await minimizeScenario(
        scenario,
        violation.invariant,
      );
      const minimizedResult = await runScenario(minimized);
      const minimizedViolation =
        minimizedResult.violations.find(
          v => v.invariant === violation.invariant,
        ) ?? violation;
      const record: FailureRecord = {
        seed,
        index,
        invariant: violation.invariant,
        severity: violation.severity,
        hard: violation.hard,
        message: minimizedViolation.message,
        stepIndex: minimizedViolation.stepIndex,
        step: minimizedViolation.step,
        scenario,
        minimized,
        minimizeRuns: runs,
        minimizedTrace: traceOf(minimizedResult),
        snapshot: minimizedViolation.snapshot,
        replay: `RSM_REPLAY=<path to a JSON file holding this record's "minimized" object> npx jest --ci __tests__/randomized/stateMachine.test.ts`,
      };
      campaign.failures.push(record);
      if (violation.hard) {
        hardMessages.push(
          `[seed ${seed} idx ${index}] ${violation.invariant} at step ${minimizedViolation.stepIndex} (${JSON.stringify(minimizedViolation.step)}): ${minimizedViolation.message}\n  minimized (${minimized.steps.length} steps): ${minimized.steps.map(s => s.op).join(' → ')}`,
        );
      }
    }
  }
  row.durationMs = wallClockMs() - realNowStart;
  const memory = process.memoryUsage();
  row.heapUsedMb = Math.round((memory.heapUsed / 1048576) * 10) / 10;
  row.rssMb = Math.round((memory.rss / 1048576) * 10) / 10;
  campaign.rows.push(row);
  return { row, hardMessages };
}

// ─── Jest wiring ─────────────────────────────────────────────────────────────

const nativeModules = NativeModules as { PickleAuth?: unknown };

beforeAll(() => {
  jest.useFakeTimers();
  installAppStateSpy();
});

afterAll(() => {
  appStateSpy?.mockRestore();
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  delete nativeModules.PickleAuth;
  if (!REPLAY_PATH) writeArtifacts();
});

if (REPLAY_PATH) {
  describe('randomized state machine — replay', () => {
    it(`replays ${REPLAY_PATH} and reports every violation`, async () => {
      const raw = JSON.parse(fs.readFileSync(REPLAY_PATH, 'utf8')) as
        Scenario | { minimized: Scenario };
      const scenario = 'minimized' in raw ? raw.minimized : raw;
      const result = await runScenario(scenario);
      const trace = traceOf(result);
      console.log(
        JSON.stringify({ trace, violations: result.violations }, null, 2),
      );
      expect(result.violations.filter(v => v.hard)).toEqual([]);
    }, 600_000);
  });
} else {
  describe(`randomized state machine — seeds ${SEED_START}..${SEED_END} × ${SEQUENCES_PER_SEED}`, () => {
    for (let seed = SEED_START; seed <= SEED_END; seed += 1) {
      it(`seed ${seed}: launch→auth→analyze→cancel→retry→history→logout→login→background→resume→delete holds every HARD invariant`, async () => {
        const { row, hardMessages } = await runSeed(seed);
        expect(row.scenarios).toBe(SEQUENCES_PER_SEED);
        if (hardMessages.length) {
          throw new Error(
            `${hardMessages.length} hard invariant violation(s) in seed ${seed} (artifacts: ${ARTIFACT_DIR}):\n${hardMessages.join('\n')}`,
          );
        }
      }, 600_000);
    }

    // Coverage of every operation is a property of the full campaign; a
    // reduced RSM_* smoke run cannot promise it and skips (not passes) it.
    const coverageIt = TOTAL_SCENARIOS >= 1000 ? it : it.skip;
    coverageIt(
      'exercised every operation of the scenario language at least once',
      () => {
        const never = ALL_OPS.filter(op => !campaign.opCoverage[op]);
        expect(never).toEqual([]);
      },
    );
  });
}
