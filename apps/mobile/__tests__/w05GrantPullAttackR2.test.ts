/**
 * W05-06 adversarial tests, round 2 — the offline grant pull at boundaries
 * the round-1 suite (A1–A8, `w05GrantPullAttackR1.test.ts`) and the
 * candidate's own `w05GrantPull.test.ts` do not exercise (candidate
 * d3dacfd9).
 *
 * Each `describe` block is one attack. A test that FAILS against the
 * candidate is a confirmed break; a test that passes documents a boundary
 * the candidate holds. Nothing here modifies production code or the
 * candidate's own suite.
 *
 *   B1  crash between issue and hold: the local grant write fails after the
 *       server issued; nothing partial is left, the retry conserves tickets
 *   B2  double submission: server answers arriving while the pull is in
 *       flight (access snapshots + local triggers) request exactly once
 *   B3  dead-air network: requests that never complete (API timeout) must
 *       not become a self-sustaining retry chain on an empty-outbox device
 *   B4  401 on the grant request: not a refusal, not memoised, nothing held
 *   B5  boundary — unknown access (canonicalAccess null) with drain signal
 *   B6  cross-account isolation of the refusal memo under identical access
 *   B7  far-past anchored clock: a grant issued "in the future" is held but
 *       not executable and does not cause a request storm
 *   B8  replay / foreign identities: a grant bound to another owner or
 *       another installation is never held and never memoised as a refusal
 *   B9  sign-out while the grant request is in flight holds nothing
 *   B10 installation key id boundaries (128 / 129 chars, empty, whitespace,
 *       control characters): malformed items are neither used nor replaced
 *   B11 hung Keychain: no identity ⇒ no request, no back-off penalty, and
 *       the next pass recovers once the Keychain answers
 *   B12 entitlement flip: a live Pro lease keeps a now-free account from
 *       requesting; the free request follows once the lease expires
 *   B13 a concurrent Keychain writer wins first-launch generation: only the
 *       confirmed item is registered/bound; a malformed read-back is no id
 *   B14 the Keychain item rotates between register and issue: the pass keeps
 *       the id it registered
 */
import * as Keychain from 'react-native-keychain';
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_PRO_LEASE_SCHEMA_VERSION,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import {
  clearApiSession,
  establishApiSession,
} from '../src/account/apiSession';
import type { CanonicalAccessState } from '../src/billing/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { API_REQUEST_TIMEOUT_MS } from '../src/data/api';
import type { LocalDb } from '../src/data/db';
import {
  INSTALLATION_KEY_KEYCHAIN_SERVICE,
  INSTALLATION_KEY_KEYCHAIN_TIMEOUT_MS,
} from '../src/data/installationKey';
import { readOfflineAllocation } from '../src/data/offlineCapabilities';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  SYNC_RETRY_MAX_MS,
  clearSyncRuntime,
  configureSyncRuntime,
  resetOfflineGrantRefusals,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import type { TrustedTimeReading } from '../src/data/trustedTime';
import { useAccessStore } from '../src/state/accessStore';
import { createSqliteTestDb } from '../testSupport/sqlite';

jest.mock('../src/data/db', () => ({ getDb: jest.fn() }));

let mockReading: TrustedTimeReading | null = null;
jest.mock('../src/data/trustedTime', () => {
  const actual = jest.requireActual<typeof import('../src/data/trustedTime')>(
    '../src/data/trustedTime',
  );
  return {
    ...actual,
    trustedTime: {
      ...actual.trustedTime,
      read: async () => {
        if (!mockReading) throw new Error('trusted time not configured');
        return mockReading;
      },
    },
  };
});

import { getDb } from '../src/data/db';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const ISSUER = 'https://api.example.test/functions/v1/api';
const KEY_ID = 'offline-grant-key-1';
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;
const REGISTER_ROUTE = `${ISSUER}/v1/devices/register`;
const GRANTS_ROUTE = `${ISSUER}/v1/offline/grants`;
const RECEIPTS_ROUTE = `${ISSUER}/v1/offline/receipts`;
const FINALIZE_ROUTE = `${ISSUER}/v1/sessions/session-1/finalize`;
const SESSION = {
  apiBaseUrl: ISSUER,
  bearerToken: 'access-token',
  canonicalAppUserId: OWNER,
  provider: 'apple' as const,
};
const OTHER_SESSION = {
  ...SESSION,
  bearerToken: 'other-access-token',
  canonicalAppUserId: OTHER_OWNER,
};

const FREE_ACCESS: CanonicalAccessState = {
  premium: false,
  entitlements: [],
  freeRatings: {
    limit: 2,
    used: 0,
    reserved: 0,
    remaining: 2,
    availableToReserve: 2,
  },
  canStartRating: true,
  paywallRequired: false,
};

const PRO_ACCESS: CanonicalAccessState = {
  premium: true,
  entitlements: ['pickle_sensei_pro'],
  freeRatings: {
    limit: 2,
    used: 2,
    reserved: 0,
    remaining: 0,
    availableToReserve: 0,
  },
  canStartRating: true,
  paywallRequired: false,
};

function reading(
  nowMs: number,
  overrides: Partial<TrustedTimeReading> = {},
): TrustedTimeReading {
  return {
    authority: 'anchored',
    continuity: 'measured',
    nowMs,
    wallClockMs: nowMs,
    rollbackDetected: false,
    storage: 'loaded',
    ...overrides,
  };
}

const ACTIVE = reading((ISSUED_AT + 60) * 1000);
/** The device's anchored clock reads a year BEFORE the server issues. */
const FAR_PAST = reading((ISSUED_AT + 60) * 1000 - 365 * DAY_MS);
/** Past every lease the fixture server issues. */
const AFTER_EXPIRY = reading((EXPIRES_AT + 60) * 1000);

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

interface GrantFixture {
  installationKeyId: string;
  grantId?: string;
  generation?: number;
  ticketIds?: readonly string[];
  issuedAt?: number;
  expiresAt?: number;
  pro?: boolean;
  /** The owner the signed claims name (defaults to OWNER). */
  subject?: string;
  /** The installation the signed claims name (defaults to the requester). */
  claimedInstallationKeyId?: string;
}

let grantSerial = 0;

function grantResponse(fixture: GrantFixture): Record<string, unknown> {
  grantSerial += 1;
  const grantId =
    fixture.grantId ??
    `bbbbbbbb-0000-4000-8000-${String(grantSerial).padStart(12, '0')}`;
  const generation = fixture.generation ?? 1;
  const ticketIds = fixture.pro
    ? []
    : (fixture.ticketIds ?? [
        `aaaaaaaa-0000-4000-8000-${String(grantSerial * 2).padStart(12, '0')}`,
        `aaaaaaaa-0000-4000-8000-${String(grantSerial * 2 + 1).padStart(12, '0')}`,
      ]);
  const issuedAt = fixture.issuedAt ?? ISSUED_AT;
  const expiresAt = fixture.expiresAt ?? EXPIRES_AT;
  const entitlementExpiresAt = fixture.pro ? expiresAt + 3600 : null;
  const claims: Record<string, unknown> = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: fixture.subject ?? OWNER,
    jti: grantId,
    installationKeyId:
      fixture.claimedInstallationKeyId ?? fixture.installationKeyId,
    iat: issuedAt,
    exp: expiresAt,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    ...(fixture.pro
      ? {
          entitlementSource: 'verified_store',
          lease: {
            schemaVersion: OFFLINE_PRO_LEASE_SCHEMA_VERSION,
            kind: 'subscription',
            verifiedEntitlementExpiresAt: entitlementExpiresAt,
          },
        }
      : {
          entitlementSource: 'identity_lifetime_free',
          allocation: {
            schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
            allocationId: grantId,
            generation,
            ticketIds,
            budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
            financialExpiry: 'reconciliation_only',
          },
        }),
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  const compactJws = `${base64Url(JSON.stringify(header))}.${base64Url(
    JSON.stringify(claims),
  )}.${'A'.repeat(86)}`;
  return {
    grantId,
    generation,
    entitlementSource: fixture.pro
      ? 'verified_store'
      : 'identity_lifetime_free',
    issuedAt,
    expiresAt,
    entitlementExpiresAt,
    ticketIds,
    keyId: KEY_ID,
    grant: { schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION, compactJws },
  };
}

interface ApiCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly authorization: string | null;
}

type RouteAnswer = Record<string, unknown> | Response;

interface ServerOptions {
  register?: (body: Record<string, unknown>) => Promise<RouteAnswer>;
  grants?: (body: Record<string, unknown>) => Promise<RouteAnswer>;
}

function json(answer: RouteAnswer, status = 200): Response {
  if (answer instanceof Response) return answer;
  return new Response(JSON.stringify(answer), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function registration(body: Record<string, unknown>): Record<string, unknown> {
  return {
    device: {
      deviceId: 'dddddddd-0000-4000-8000-000000000001',
      installationKeyId: body['installationKeyId'],
      attestationEnvironment: body['attestationEnvironment'],
      attestationState: 'unattested',
    },
  };
}

function headerValue(init: RequestInit | undefined, name: string) {
  const headers = init?.headers;
  if (!headers || Array.isArray(headers) || headers instanceof Headers) {
    return null;
  }
  const record = headers as Record<string, string>;
  return record[name] ?? null;
}

function serveApi(options: ServerOptions = {}) {
  const calls: ApiCall[] = [];
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({
        url,
        body,
        authorization: headerValue(init, 'authorization'),
      });
      if (url === REGISTER_ROUTE) {
        if (options.register) return json(await options.register(body));
        return json(registration(body));
      }
      if (url === GRANTS_ROUTE) {
        if (options.grants) return json(await options.grants(body));
        return json(
          grantResponse({
            installationKeyId: String(body['installationKeyId']),
            pro: body['requestedTickets'] === 0,
          }),
        );
      }
      if (url === RECEIPTS_ROUTE) {
        const receipts = (body['receipts'] ?? []) as Array<
          Record<string, unknown>
        >;
        return json({
          receipts: receipts.map(receipt => ({
            receiptId: receipt['receiptId'],
            status: 'result_recorded',
          })),
          rejected: [],
        });
      }
      if (url === FINALIZE_ROUTE) return json({});
      return json({ error: 'not_found' }, 404);
    });
  return {
    calls,
    spy,
    urls: () =>
      calls
        .map(call => call.url)
        .filter(url => url === REGISTER_ROUTE || url === GRANTS_ROUTE),
    grantBodies: () =>
      calls.filter(call => call.url === GRANTS_ROUTE).map(call => call.body),
  };
}

/** A fixture server that behaves like `issue_offline_grant`: every accepted
 * request mints a NEW generation and re-issues the installation's
 * outstanding ticket ids instead of allocating more. */
function conservingServer() {
  const outstanding = new Map<string, readonly string[]>();
  let generation = 0;
  return serveApi({
    grants: async body => {
      const installationKeyId = String(body['installationKeyId']);
      generation += 1;
      const tickets = outstanding.get(installationKeyId) ?? [
        `aaaaaaaa-0000-4000-8000-0000000000${String(generation).padStart(2, '0')}`,
        `aaaaaaaa-0000-4000-8000-0000000001${String(generation).padStart(2, '0')}`,
      ];
      outstanding.set(installationKeyId, tickets);
      return grantResponse({
        installationKeyId,
        generation,
        ticketIds: tickets,
      });
    },
  });
}

/** The delays the runtime scheduled for its next timer-driven pass. */
function scheduledDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => call[1])
    .filter(
      (delay): delay is number =>
        typeof delay === 'number' &&
        delay >= SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
    );
}

function lastDelay(spy: jest.SpyInstance): number {
  const delays = scheduledDelays(spy);
  return delays[delays.length - 1] ?? Number.NaN;
}

const BACKED_OFF = SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO);

function storedInstallationKey(): string | undefined {
  return __keychainStore.get(INSTALLATION_KEY_KEYCHAIN_SERVICE)?.password;
}

function seedInstallationKey(value: string): void {
  __keychainStore.set(INSTALLATION_KEY_KEYCHAIN_SERVICE, {
    username: 'installation-key',
    password: value,
  });
}

function queueOutboxRow(
  handle: ReturnType<typeof createSqliteTestDb>,
  owner = OWNER,
): void {
  handle.native
    .prepare(
      "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.finalize', ?)",
    )
    .run(owner, JSON.stringify({ id: 'session-1' }));
}

/** A pass started by a fresh server answer to the access check (the round-2
 * rule: a pass with nothing to send has no online evidence of its own). */
async function signalled(
  access: CanonicalAccessState | null = null,
): Promise<void> {
  const next =
    access ?? useAccessStore.getState().canonicalAccess ?? FREE_ACCESS;
  useAccessStore.setState({ canonicalAccess: { ...next } });
  await triggerOutboxSync();
}

function ticketRows(
  handle: ReturnType<typeof createSqliteTestDb>,
  owner: string,
): number {
  return handle.count('offline_ticket', owner);
}

describe('W05-06 round-2 attacks on the offline grant pull', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;
  let server: ReturnType<typeof serveApi> | null = null;
  let network: { calls: string[]; spy: jest.SpyInstance } | null = null;
  let timers: jest.SpyInstance | null = null;
  let keychainRead: jest.SpyInstance | null = null;

  beforeEach(() => {
    __keychainStore.clear();
    resetOfflineGrantRefusals();
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
    (getDb as jest.Mock).mockReturnValue(db);
    establishApiSession(SESSION);
    mockReading = ACTIVE;
    useAccessStore.setState({ canonicalAccess: FREE_ACCESS });
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    server?.spy.mockRestore();
    network?.spy.mockRestore();
    timers?.mockRestore();
    keychainRead?.mockRestore();
    server = null;
    network = null;
    timers = null;
    keychainRead = null;
    jest.useRealTimers();
    useAccessStore.setState({ canonicalAccess: null });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (getDb as jest.Mock).mockReset();
    handle.close();
    mockReading = null;
  });

  describe('B1 — crash between issue and hold', () => {
    it('a failed grant write leaves no partial rows, backs off, and the retry conserves the re-issued tickets', async () => {
      timers = jest.spyOn(globalThis, 'setTimeout');
      server = conservingServer();
      handle.failStatementOnce('INSERT INTO offline_grant');
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(ticketRows(handle, OWNER)).toBe(0);
      // A local write failure after the server issued is a failed pass: the
      // timer backs off rather than hammering the issuer.
      expect(lastDelay(timers)).toBeGreaterThan(BACKED_OFF);

      // Without a fresh server answer the next pass has no signal of its
      // own (the failure was local, not transport).
      await triggerOutboxSync();
      expect(server.urls()).toHaveLength(2);

      await signalled();
      expect(server.urls()).toEqual([
        REGISTER_ROUTE,
        GRANTS_ROUTE,
        REGISTER_ROUTE,
        GRANTS_ROUTE,
      ]);
      const wallet = await readOfflineAllocation(db, ACTIVE);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      expect(ticketRows(handle, OWNER)).toBe(2);
      expect(wallet.spendableTickets).toBe(2);
      expect(wallet.consumedTickets).toBe(0);
      expect(wallet.grants[0]).toMatchObject({ generation: 2 });
    });

    it('a lost commit acknowledgement (row durable, app saw a failure) does not request a second grant', async () => {
      server = conservingServer();
      handle.failCommitOnce('after', 'INSERT INTO offline_grant');
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(1);

      for (let pass = 0; pass < 3; pass += 1) await signalled();
      expect(server.urls()).toHaveLength(2);
      const wallet = await readOfflineAllocation(db, ACTIVE);
      expect(wallet.spendableTickets).toBe(2);
      expect(ticketRows(handle, OWNER)).toBe(2);
    });
  });

  describe('B2 — double submission while the pull is in flight', () => {
    it('access snapshots and local triggers arriving mid-request produce exactly one register + one issue', async () => {
      let release: (() => void) | null = null;
      const blocked = new Promise<void>(resolve => {
        release = resolve;
      });
      let issued = 0;
      server = serveApi({
        grants: async body => {
          issued += 1;
          await blocked;
          return grantResponse({
            installationKeyId: String(body['installationKeyId']),
          });
        },
      });
      configureSyncRuntime(SESSION);
      const first = signalled();
      while (issued === 0) await new Promise(resolve => setTimeout(resolve, 5));
      // The billing lifecycle publishes twice more and two local results
      // enter the outbox while the grant request is still in flight.
      useAccessStore.setState({ canonicalAccess: { ...FREE_ACCESS } });
      useAccessStore.setState({ canonicalAccess: { ...FREE_ACCESS } });
      const second = triggerOutboxSync();
      const third = triggerOutboxSync();
      release!();
      await Promise.all([first, second, third]);
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      expect(ticketRows(handle, OWNER)).toBe(2);
      // The rerun the mid-flight answers earned finds the held grant.
      await signalled();
      expect(server.urls()).toHaveLength(2);
    });
  });

  describe('B3 — dead-air network (requests never complete)', () => {
    /** A connected-looking network that never answers: every request hangs
     * until the API's own deadline. */
    function deadAir() {
      const calls: string[] = [];
      const spy = jest.spyOn(globalThis, 'fetch').mockImplementation(
        (input, init) =>
          new Promise<Response>((_, reject) => {
            calls.push(String(input));
            init?.signal?.addEventListener('abort', () =>
              reject(new DOMException('Aborted', 'AbortError')),
            );
          }),
      );
      return { calls, spy };
    }

    it('a pass that started with signal and timed out does not feed an endless timer-driven request chain', async () => {
      jest.useFakeTimers();
      const air = deadAir();
      network = air;
      configureSyncRuntime(SESSION);
      // The one pass with legitimate signal: the billing lifecycle reached
      // the server a moment ago; then the network goes dead-air.
      const pass = signalled();
      await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS + 1);
      await pass;
      expect(air.calls).toEqual([REGISTER_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);

      // Nothing else happens on this device: no new local result, no server
      // answer. Only the runtime's own timer fires, again and again.
      for (let round = 0; round < 4; round += 1) {
        await jest.advanceTimersByTimeAsync(
          SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO) +
            API_REQUEST_TIMEOUT_MS +
            1,
        );
      }
      // The timed-out retry is allowed ONCE; after that the device has no
      // online evidence and must stop touching the network.
      expect(new Set(air.calls)).toEqual(new Set([REGISTER_ROUTE]));
      expect(air.calls.length).toBeLessThanOrEqual(2);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
    });

    it('control: a radio-off failure (TypeError) after a signalled pass is not retried by the timer', async () => {
      jest.useFakeTimers();
      const calls: string[] = [];
      network = {
        calls,
        spy: jest.spyOn(globalThis, 'fetch').mockImplementation(async input => {
          calls.push(String(input));
          throw new TypeError('Network request failed');
        }),
      };
      configureSyncRuntime(SESSION);
      await signalled();
      expect(calls).toEqual([REGISTER_ROUTE]);
      for (let round = 0; round < 4; round += 1) {
        await jest.advanceTimersByTimeAsync(
          SYNC_RETRY_MAX_MS * (1 + SYNC_RETRY_JITTER_RATIO) + 1,
        );
      }
      expect(calls).toEqual([REGISTER_ROUTE]);
    });
  });

  describe('B4 — 401 on the grant request', () => {
    it('is not memoised as a refusal, holds nothing, and the next pass with signal asks again', async () => {
      timers = jest.spyOn(globalThis, 'setTimeout');
      let unauthorized = true;
      server = serveApi({
        grants: async body =>
          unauthorized
            ? refusal(401, 'auth.unauthorized', 'Sign in again.')
            : grantResponse({
                installationKeyId: String(body['installationKeyId']),
              }),
      });
      configureSyncRuntime(SESSION);
      await signalled();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(lastDelay(timers)).toBeGreaterThan(BACKED_OFF);

      unauthorized = false;
      await signalled();
      expect(server.urls()).toHaveLength(4);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
    });
  });

  describe('B5 — unknown access (canonicalAccess null)', () => {
    it('requests the free quantity, holds what the server issued, and a later access snapshot does not re-request', async () => {
      useAccessStore.setState({ canonicalAccess: null });
      server = serveApi();
      queueOutboxRow(handle);
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(server.grantBodies()[0]).toMatchObject({ requestedTickets: 2 });
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      expect(handle.count('outbox', OWNER)).toBe(0);

      await signalled(FREE_ACCESS);
      await signalled(PRO_ACCESS);
      expect(server.urls()).toHaveLength(2);
    });

    it('a refusal under unknown access is retried once the access snapshot is known', async () => {
      useAccessStore.setState({ canonicalAccess: null });
      let paywalled = true;
      server = serveApi({
        grants: async body =>
          paywalled
            ? refusal(402, 'access.paywall_required', 'Spent.')
            : grantResponse({
                installationKeyId: String(body['installationKeyId']),
              }),
      });
      queueOutboxRow(handle);
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      queueOutboxRow(handle);
      await triggerOutboxSync();
      expect(server.urls()).toHaveLength(2);

      paywalled = false;
      await signalled(FREE_ACCESS);
      expect(server.urls()).toHaveLength(4);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
    });
  });

  describe('B6 — refusal memo isolation across accounts', () => {
    it('a refusal recorded for one owner never silences another owner with an identical access snapshot, and each owner keeps its own wallet', async () => {
      server = serveApi({
        grants: async body =>
          body['requestedTickets'] === 2 &&
          server?.calls.at(-1)?.authorization === 'Bearer access-token'
            ? refusal(402, 'access.paywall_required', 'Spent.')
            : grantResponse({
                installationKeyId: String(body['installationKeyId']),
                subject: OTHER_OWNER,
              }),
      });
      configureSyncRuntime(SESSION);
      await signalled();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);

      // Sign out, sign in as the other account with the same access values.
      clearSyncRuntime();
      clearApiSession();
      setActiveDataOwner(OTHER_OWNER);
      establishApiSession(OTHER_SESSION);
      configureSyncRuntime(OTHER_SESSION);
      await signalled({ ...FREE_ACCESS });
      expect(server.urls()).toHaveLength(4);
      expect(server.calls.at(-1)?.authorization).toBe(
        'Bearer other-access-token',
      );
      expect(handle.count('offline_grant', OTHER_OWNER)).toBe(1);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(ticketRows(handle, OTHER_OWNER)).toBe(2);
      expect(ticketRows(handle, OWNER)).toBe(0);

      // Back to the first account under unchanged access: still refused,
      // no new request, the other owner's grant is not visible to it.
      clearSyncRuntime();
      clearApiSession();
      setActiveDataOwner(OWNER);
      establishApiSession(SESSION);
      configureSyncRuntime(SESSION);
      await signalled({ ...FREE_ACCESS });
      expect(server.urls()).toHaveLength(4);
      const wallet = await readOfflineAllocation(db, ACTIVE);
      expect(wallet.grants).toHaveLength(0);
      expect(wallet.spendableTickets).toBe(0);
    });
  });

  describe('B7 — far-past anchored clock', () => {
    it('a grant issued "in the future" relative to the device clock is not executable and is not requested again', async () => {
      mockReading = FAR_PAST;
      server = serveApi();
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      // Held (allocation is a fact), but not executable under this clock.
      const wallet = await readOfflineAllocation(db, FAR_PAST);
      expect(wallet.grants).toHaveLength(1);
      expect(wallet.grants[0]).toMatchObject({
        execution: {
          kind: 'reconcile_required',
          reason: 'lease_ahead_of_clock',
        },
        remaining: 2,
      });
      expect(wallet.spendableTickets).toBe(2);
      for (let pass = 0; pass < 3; pass += 1) await signalled();
      expect(server.urls()).toHaveLength(2);
      expect(handle.count('offline_grant', OWNER)).toBe(1);

      // Once the clock is honest the held grant is the one in use.
      mockReading = ACTIVE;
      await signalled();
      expect(server.urls()).toHaveLength(2);
      const honest = await readOfflineAllocation(db, ACTIVE);
      expect(honest.grants[0]).toMatchObject({
        execution: { kind: 'active' },
        remaining: 2,
      });
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      expect(ticketRows(handle, OWNER)).toBe(2);
    });
  });

  describe('B8 — replay / foreign identities', () => {
    it("a grant whose claims name another owner is never held and never becomes this owner's refusal", async () => {
      timers = jest.spyOn(globalThis, 'setTimeout');
      server = serveApi({
        grants: async body =>
          grantResponse({
            installationKeyId: String(body['installationKeyId']),
            subject: OTHER_OWNER,
          }),
      });
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);
      expect(lastDelay(timers)).toBeGreaterThan(BACKED_OFF);
      // Not a verdict: the next pass with signal asks again.
      await signalled();
      expect(server.urls()).toHaveLength(4);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
    });

    it('a grant bound to another installation is never held', async () => {
      server = serveApi({
        grants: async body =>
          grantResponse({
            installationKeyId: String(body['installationKeyId']),
            claimedInstallationKeyId: 'ios-someone-elses-phone',
          }),
      });
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(ticketRows(handle, OWNER)).toBe(0);
    });

    it('a replayed grant id with different signed content is refused locally while the original stays intact', async () => {
      const grantId = 'bbbbbbbb-0000-4000-8000-00000000abcd';
      let issued = 0;
      server = serveApi({
        grants: async body => {
          issued += 1;
          return grantResponse({
            installationKeyId: String(body['installationKeyId']),
            grantId,
            generation: issued,
            ticketIds: [
              `aaaaaaaa-0000-4000-8000-00000000000${issued}`,
              `aaaaaaaa-0000-4000-8000-00000000001${issued}`,
            ],
          });
        },
      });
      configureSyncRuntime(SESSION);
      await signalled();
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      // The held grant expires by trusted time; the server "re-issues" the
      // same grant id with new content (a replaying intermediary).
      mockReading = AFTER_EXPIRY;
      await expect(signalled()).resolves.toBeUndefined();
      expect(issued).toBe(2);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      const stored = handle.native
        .prepare(
          'SELECT generation, allocated_ticket_ids FROM offline_grant WHERE owner_key = ?',
        )
        .get(OWNER);
      expect(stored).toMatchObject({ generation: 1 });
      expect(ticketRows(handle, OWNER)).toBe(2);
    });
  });

  describe('B9 — sign-out while the grant request is in flight', () => {
    it('holds nothing for the signed-out device or the previous owner and throws nothing', async () => {
      server = serveApi({
        grants: async body => {
          clearSyncRuntime();
          clearApiSession();
          setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
          return grantResponse({
            installationKeyId: String(body['installationKeyId']),
          });
        },
      });
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(handle.count('offline_grant', SIGNED_OUT_DATA_OWNER)).toBe(0);
      expect(ticketRows(handle, OWNER)).toBe(0);
      // The cleared runtime requests nothing more.
      await triggerOutboxSync();
      expect(server.urls()).toHaveLength(2);
    });
  });

  describe('B10 — installation key id boundaries', () => {
    it('a 128-character id is used verbatim', async () => {
      const id = `k${'x'.repeat(127)}`;
      seedInstallationKey(id);
      server = serveApi();
      configureSyncRuntime(SESSION);
      await signalled();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(server.calls[0]?.body).toMatchObject({ installationKeyId: id });
      expect(server.grantBodies()[0]).toMatchObject({
        installationKeyId: id,
        requestedTickets: 2,
      });
      expect(storedInstallationKey()).toBe(id);
    });

    const malformed: Array<[string, string]> = [
      ['129 characters', `k${'x'.repeat(128)}`],
      ['empty string', ''],
      ['leading whitespace', ' ios-1'],
      ['trailing newline', 'ios-1\n'],
      ['leading punctuation', '-ios-1'],
      ['unicode', 'ios-ü'],
      ['embedded null', 'ios-1\u0000'],
    ];

    for (const [label, value] of malformed) {
      it(`a malformed Keychain item (${label}) is neither sent nor replaced`, async () => {
        timers = jest.spyOn(globalThis, 'setTimeout');
        seedInstallationKey(value);
        server = serveApi();
        configureSyncRuntime(SESSION);
        await expect(signalled()).resolves.toBeUndefined();
        expect(server.urls()).toEqual([]);
        expect(storedInstallationKey()).toBe(value);
        expect(handle.count('offline_grant', OWNER)).toBe(0);
        // "No identity" is not a transport failure: no back-off penalty.
        expect(lastDelay(timers)).toBeLessThanOrEqual(BACKED_OFF);
      });
    }
  });

  describe('B13 — concurrent Keychain writer wins first-launch generation', () => {
    it('the id the Keychain confirms is the one registered and bound, never the losing generated one', async () => {
      const winner = 'ios-winner-0000-4000-8000-000000000001';
      const actualWrite = Keychain.setGenericPassword;
      const write = jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, _password, options) => {
          // Another writer landed first; this write is a no-op overwrite of
          // the same item by the same value from the app's perspective.
          return actualWrite(username, winner, options);
        });
      try {
        server = serveApi();
        configureSyncRuntime(SESSION);
        await signalled();
        expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
        expect(server.calls[0]?.body).toMatchObject({
          installationKeyId: winner,
        });
        expect(server.grantBodies()[0]).toMatchObject({
          installationKeyId: winner,
        });
        expect(storedInstallationKey()).toBe(winner);
        const wallet = await readOfflineAllocation(db, ACTIVE);
        expect(wallet.grants[0]).toMatchObject({ installationKeyId: winner });
      } finally {
        write.mockRestore();
      }
    });

    it('a confirmed read-back that is malformed yields no identity, no request and nothing replaced', async () => {
      timers = jest.spyOn(globalThis, 'setTimeout');
      const actualWrite = Keychain.setGenericPassword;
      const write = jest
        .spyOn(Keychain, 'setGenericPassword')
        .mockImplementation(async (username, _password, options) =>
          actualWrite(username, 'ios-1\n', options),
        );
      try {
        server = serveApi();
        configureSyncRuntime(SESSION);
        await expect(signalled()).resolves.toBeUndefined();
        expect(server.urls()).toEqual([]);
        expect(storedInstallationKey()).toBe('ios-1\n');
        expect(lastDelay(timers)).toBeLessThanOrEqual(BACKED_OFF);
      } finally {
        write.mockRestore();
      }
    });
  });

  describe('B14 — identity rotates between register and issue', () => {
    it('the grant request carries the id that was registered in this pass, and a grant bound to a different id is never held', async () => {
      const first = 'ios-first-0000-4000-8000-000000000001';
      seedInstallationKey(first);
      server = serveApi({
        register: async body => {
          // The Keychain item changes under the app between the two calls
          // (restore from a device migration, a second process, tampering).
          seedInstallationKey('ios-second-0000-4000-8000-000000000002');
          return registration(body);
        },
      });
      configureSyncRuntime(SESSION);
      await expect(signalled()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(server.grantBodies()[0]).toMatchObject({
        installationKeyId: first,
      });
      const wallet = await readOfflineAllocation(db, ACTIVE);
      expect(wallet.grants).toHaveLength(1);
      expect(wallet.grants[0]).toMatchObject({ installationKeyId: first });
      expect(handle.count('offline_grant', OWNER)).toBe(1);
    });
  });

  describe('B11 — hung Keychain', () => {
    it('no identity within the bound ⇒ no request and no penalty; the next signalled pass recovers once the Keychain answers', async () => {
      jest.useFakeTimers();
      timers = jest.spyOn(globalThis, 'setTimeout');
      let hung = true;
      const actualRead = Keychain.getGenericPassword;
      keychainRead = jest
        .spyOn(Keychain, 'getGenericPassword')
        .mockImplementation(options =>
          hung ? new Promise(() => {}) : actualRead(options),
        );
      server = serveApi();
      configureSyncRuntime(SESSION);
      const pass = signalled();
      await jest.advanceTimersByTimeAsync(
        INSTALLATION_KEY_KEYCHAIN_TIMEOUT_MS + 1,
      );
      await pass;
      expect(server.urls()).toEqual([]);
      expect(storedInstallationKey()).toBeUndefined();
      expect(lastDelay(timers)).toBeLessThanOrEqual(BACKED_OFF);

      hung = false;
      const recovered = signalled();
      await jest.advanceTimersByTimeAsync(1);
      await recovered;
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      const stored = storedInstallationKey();
      expect(stored).toMatch(/^ios-[0-9a-f-]{36}$/);
      expect(server.calls[0]?.body).toMatchObject({
        installationKeyId: stored,
      });
      expect(handle.count('offline_grant', OWNER)).toBe(1);
    });
  });

  describe('B12 — entitlement flip under a live Pro lease', () => {
    it('a live Pro lease keeps a now-free account from requesting; the free request follows expiry', async () => {
      useAccessStore.setState({ canonicalAccess: PRO_ACCESS });
      // The fixture issues from the device's current trusted "now", as the
      // real issuer does from its own clock.
      server = serveApi({
        grants: async body => {
          const issuedAt = Math.floor((mockReading?.nowMs ?? 0) / 1000) - 60;
          return grantResponse({
            installationKeyId: String(body['installationKeyId']),
            pro: body['requestedTickets'] === 0,
            issuedAt,
            expiresAt: issuedAt + 6 * 24 * 60 * 60,
          });
        },
      });
      configureSyncRuntime(SESSION);
      await signalled();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(server.grantBodies()[0]).toMatchObject({ requestedTickets: 0 });
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      expect(ticketRows(handle, OWNER)).toBe(0);

      // The subscription lapses: the server now reports a free account.
      await signalled(FREE_ACCESS);
      await signalled(FREE_ACCESS);
      expect(server.urls()).toHaveLength(2);

      mockReading = AFTER_EXPIRY;
      await signalled(FREE_ACCESS);
      expect(server.urls()).toHaveLength(4);
      expect(server.grantBodies()[1]).toMatchObject({ requestedTickets: 2 });
      const wallet = await readOfflineAllocation(db, AFTER_EXPIRY);
      expect(handle.count('offline_grant', OWNER)).toBe(2);
      expect(ticketRows(handle, OWNER)).toBe(2);
      expect(wallet.spendableTickets).toBe(2);
      const live = wallet.grants.filter(
        grant => grant.execution.kind === 'active',
      );
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({
        entitlementSource: 'identity_lifetime_free',
        remaining: 2,
      });
      // Nothing further is requested while the free grant is live.
      await signalled(FREE_ACCESS);
      expect(server.urls()).toHaveLength(4);
    });
  });
});
