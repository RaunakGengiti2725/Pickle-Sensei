/**
 * W05-06 adversarial tests — the offline grant pull at its failure
 * boundaries (candidate 560450b6).
 *
 * Each `describe` block is one attack. A test that FAILS against the
 * candidate is a confirmed break; a test that passes documents a boundary
 * the candidate holds. Nothing here modifies production code or the
 * candidate's own suite.
 *
 *   A1  no signal: an offline device with an EMPTY outbox still requests
 *   A2  far-future trusted clock: a grant issued under a forward-set wall
 *       clock is "expired" on arrival; the pull must not repeat once the
 *       server's own responses re-anchor the clock
 *   A3  refusal memo is per configured runtime: a relaunch / re-configure
 *       under unchanged access requests again
 *   A4  interleaved account switch while the grant request is in flight
 *   A5  clock rollback / floor authority never requests
 *   A6  transport failures at each step (429 + Retry-After, 408, 5xx,
 *       redirect, unreadable 4xx) are not recorded as refusals and back off
 *   A7  corrupt persisted wallet state never requests and never crashes
 *   A8  re-configure while the grant request is in flight: the server
 *       re-issues the outstanding tickets and the wallet conserves them
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
import type { LocalDb } from '../src/data/db';
import { INSTALLATION_KEY_KEYCHAIN_SERVICE } from '../src/data/installationKey';
import { readOfflineAllocation } from '../src/data/offlineCapabilities';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  clearSyncRuntime,
  configureSyncRuntime,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import {
  createTrustedTime,
  type TrustedTimeLifecycle,
  type TrustedTimeReading,
} from '../src/data/trustedTime';
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
const SESSION = {
  apiBaseUrl: ISSUER,
  bearerToken: 'access-token',
  canonicalAppUserId: OWNER,
  provider: 'apple' as const,
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
/** The device's trusted clock is ten days past every grant the server will
 * issue (a wall clock set forward while the app was anchored — see A2). */
const FAR_FUTURE = reading((ISSUED_AT + 60) * 1000 + 10 * DAY_MS);

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
    sub: OWNER,
    jti: grantId,
    installationKeyId: fixture.installationKeyId,
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

function serveApi(options: ServerOptions = {}) {
  const calls: ApiCall[] = [];
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (input, init) => {
      const url = String(input);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ url, body });
      if (url === REGISTER_ROUTE) {
        if (options.register) return json(await options.register(body));
        return json({
          device: {
            deviceId: 'dddddddd-0000-4000-8000-000000000001',
            installationKeyId: body['installationKeyId'],
            attestationEnvironment: body['attestationEnvironment'],
            attestationState: 'unattested',
          },
        });
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
      return json({ error: 'not_found' }, 404);
    });
  return {
    calls,
    spy,
    urls: () =>
      calls
        .map(call => call.url)
        .filter(url => url === REGISTER_ROUTE || url === GRANTS_ROUTE),
  };
}

function offline() {
  const calls: string[] = [];
  const spy = jest
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async input => {
      calls.push(String(input));
      throw new TypeError('Network request failed');
    });
  return { calls, spy };
}

/** The delay the runtime scheduled for its next timer-driven pass: the last
 * `setTimeout` in the sync back-off range issued after the pass began. */
function scheduledDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => call[1])
    .filter(
      (delay): delay is number =>
        typeof delay === 'number' &&
        delay >= SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
    );
}

function storedInstallationKey(): string | undefined {
  return __keychainStore.get(INSTALLATION_KEY_KEYCHAIN_SERVICE)?.password;
}

describe('W05-06 attacks on the offline grant pull', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;
  let server: ReturnType<typeof serveApi> | null = null;
  let network: ReturnType<typeof offline> | null = null;
  let timers: jest.SpyInstance | null = null;

  beforeEach(() => {
    __keychainStore.clear();
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
    server = null;
    network = null;
    timers = null;
    useAccessStore.setState({ canonicalAccess: null });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (getDb as jest.Mock).mockReset();
    handle.close();
    mockReading = null;
  });

  describe('A1 — no request without signal', () => {
    it('an offline device whose outbox is EMPTY never requests registration or a grant', async () => {
      // The candidate's own offline test queues an outbox row first, which
      // makes the drain fail and the pass unclean. With nothing queued the
      // drain "succeeds" without touching the network, so the pass is clean
      // and the only remaining online evidence is the anchored reading —
      // which stays anchored while the app is foregrounded, long after the
      // radio is gone.
      network = offline();
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      await triggerOutboxSync();
      await triggerOutboxSync();
      expect(network.calls).not.toContain(REGISTER_ROUTE);
      expect(network.calls).not.toContain(GRANTS_ROUTE);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
    });
  });

  describe('A2 — far-future trusted clock', () => {
    it('the real trusted clock reports a forward-set wall clock as anchored until a measured authenticated response re-anchors it', async () => {
      // Evidence for the reading the runtime receives (existing behaviour of
      // trustedTime, not the candidate): a wall clock wound ten days forward
      // while anchored is reported as trusted "now" without rollback, so the
      // pass that observes it holds an already-expired grant. The register /
      // issue responses themselves are measured authenticated observations
      // that re-anchor the clock, which bounds the damage to that one pass.
      const lifecycle: TrustedTimeLifecycle = {
        currentState: 'active',
        addEventListener: () => ({ remove: () => {} }),
      };
      const clocks = { monotonicMs: 0, wallMs: ACTIVE.nowMs };
      const time = createTrustedTime({
        keychain: Keychain,
        monotonicNowMs: () => clocks.monotonicMs,
        wallClockNowMs: () => clocks.wallMs,
        lifecycle,
      });
      await time.observeServerTime({
        dateHeader: new Date(ACTIVE.nowMs).toUTCString(),
        authenticated: true,
        request: time.beginRequest(),
      });
      clocks.monotonicMs += 1_000;
      clocks.wallMs = ACTIVE.nowMs + 10 * DAY_MS;
      const forward = await time.read();
      expect(forward.authority).toBe('anchored');
      expect(forward.rollbackDetected).toBe(false);
      expect(forward.nowMs).toBeGreaterThanOrEqual(ACTIVE.nowMs + 10 * DAY_MS);
      // A register / issue response carrying honest server time arrives.
      clocks.monotonicMs += 1_000;
      await time.observeServerTime({
        dateHeader: new Date(ACTIVE.nowMs + 2_000).toUTCString(),
        authenticated: true,
        request: time.beginRequest(),
      });
      const afterServer = await time.read();
      expect(afterServer.authority).toBe('anchored');
      expect(afterServer.rollbackDetected).toBe(false);
      expect(afterServer.nowMs).toBeLessThan(ACTIVE.nowMs + DAY_MS);
    });

    it('a grant held as already-expired under a forward-set clock is executable once the clock re-anchors, and no second grant is requested', async () => {
      // The pass that saw the far-future reading holds a grant that is
      // expired under that reading (a 7-day lease from server "now"). The
      // register / issue round trips re-anchor the clock, so the next pass
      // reads honest time, finds the grant executable and requests nothing.
      mockReading = FAR_FUTURE;
      server = serveApi();
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      const staleWallet = await readOfflineAllocation(db, FAR_FUTURE);
      expect(staleWallet.grants[0]).toMatchObject({
        execution: { kind: 'expired' },
      });

      mockReading = ACTIVE;
      for (let pass = 0; pass < 3; pass += 1) await triggerOutboxSync();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      const wallet = await readOfflineAllocation(db, ACTIVE);
      expect(wallet.grants[0]).toMatchObject({
        execution: { kind: 'active' },
        remaining: 2,
      });
      expect(wallet.spendableTickets).toBe(2);
    });
  });

  describe('A3 — refusal memo across a relaunch / re-configure', () => {
    it('a paywall refusal is not requested again by a re-configured runtime while access is unchanged', async () => {
      server = serveApi({
        grants: async () =>
          refusal(
            402,
            'access.paywall_required',
            'The free ratings are spent.',
          ),
      });
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);

      // Same process, same owner, same access snapshot: the runtime is
      // configured again (sign-out/sign-in of the same account, a second
      // installApiSession, or the equivalent of a relaunch that kept the
      // Keychain identity).
      for (let relaunch = 0; relaunch < 3; relaunch += 1) {
        clearSyncRuntime();
        configureSyncRuntime(SESSION);
        await triggerOutboxSync();
      }
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
    });
  });

  describe('A4 — interleaved account switch while the request is in flight', () => {
    it('switching accounts during the grant request holds nothing for either owner and throws nothing', async () => {
      server = serveApi({
        grants: async body => {
          setActiveDataOwner(OTHER_OWNER);
          return grantResponse({
            installationKeyId: String(body['installationKeyId']),
          });
        },
      });
      configureSyncRuntime(SESSION);
      await expect(triggerOutboxSync()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);
      expect(handle.count('offline_ticket', OWNER)).toBe(0);
      expect(handle.count('offline_ticket', OTHER_OWNER)).toBe(0);
      // The other owner is active now: this runtime requests nothing more.
      await triggerOutboxSync();
      expect(server.urls()).toHaveLength(2);
    });

    it('switching accounts during registration never reaches the grant request', async () => {
      server = serveApi({
        register: async body => {
          setActiveDataOwner(OTHER_OWNER);
          return {
            device: {
              deviceId: 'dddddddd-0000-4000-8000-000000000001',
              installationKeyId: body['installationKeyId'],
              attestationEnvironment: body['attestationEnvironment'],
              attestationState: 'unattested',
            },
          };
        },
      });
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(server.urls()).toEqual([REGISTER_ROUTE]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);
    });
  });

  describe('A5 — clock rollback and floor authority', () => {
    it('an anchored reading with a detected rollback requests nothing', async () => {
      server = serveApi();
      mockReading = reading(ACTIVE.nowMs, { rollbackDetected: true });
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      await triggerOutboxSync();
      expect(server.urls()).toEqual([]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
      expect(storedInstallationKey()).toBeUndefined();
    });

    it('a floor-only reading after a relaunch requests nothing', async () => {
      server = serveApi();
      mockReading = reading(ACTIVE.nowMs, {
        authority: 'floor',
        continuity: 'persisted',
      });
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(server.urls()).toEqual([]);
      expect(handle.count('offline_grant', OWNER)).toBe(0);
    });
  });

  describe('A6 — transport failures at each step', () => {
    const transportAnswers: Array<[string, () => Response]> = [
      [
        '429 with Retry-After',
        () =>
          refusal(429, 'rate_limited', 'Slow down.', { 'retry-after': '120' }),
      ],
      ['408 timeout', () => refusal(408, 'network.timeout', 'Timed out.')],
      ['503 outage', () => json({ error: 'unavailable' }, 503)],
      ['302 redirect', () => new Response(null, { status: 302 })],
      [
        'unreadable 403 (captive portal)',
        () =>
          new Response('<html>portal</html>', {
            status: 403,
            headers: { 'content-type': 'text/html' },
          }),
      ],
    ];

    for (const [label, answer] of transportAnswers) {
      it(`${label} on the grant request is retried on the next pass, holds nothing and backs the timer off`, async () => {
        timers = jest.spyOn(globalThis, 'setTimeout');
        let failing = true;
        server = serveApi({
          grants: async body =>
            failing
              ? answer()
              : grantResponse({
                  installationKeyId: String(body['installationKeyId']),
                }),
        });
        configureSyncRuntime(SESSION);
        await triggerOutboxSync();
        expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
        expect(handle.count('offline_grant', OWNER)).toBe(0);
        const delays = scheduledDelays(timers);
        expect(delays[delays.length - 1]).toBeGreaterThan(
          SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO),
        );

        failing = false;
        await triggerOutboxSync();
        expect(server.urls()).toHaveLength(4);
        expect(handle.count('offline_grant', OWNER)).toBe(1);
      });

      it(`${label} on registration never reaches the grant request and is retried on the next pass`, async () => {
        let failing = true;
        server = serveApi({
          register: async body =>
            failing
              ? answer()
              : {
                  device: {
                    deviceId: 'dddddddd-0000-4000-8000-000000000001',
                    installationKeyId: body['installationKeyId'],
                    attestationEnvironment: body['attestationEnvironment'],
                    attestationState: 'unattested',
                  },
                },
        });
        configureSyncRuntime(SESSION);
        await triggerOutboxSync();
        expect(server.urls()).toEqual([REGISTER_ROUTE]);
        expect(handle.count('offline_grant', OWNER)).toBe(0);
        failing = false;
        await triggerOutboxSync();
        expect(server.urls()).toEqual([
          REGISTER_ROUTE,
          REGISTER_ROUTE,
          GRANTS_ROUTE,
        ]);
        expect(handle.count('offline_grant', OWNER)).toBe(1);
      });
    }

    it('a definitive refusal does not back the timer off (no retry storm, no penalty)', async () => {
      timers = jest.spyOn(globalThis, 'setTimeout');
      server = serveApi({
        grants: async () =>
          refusal(
            402,
            'access.paywall_required',
            'The free ratings are spent.',
          ),
      });
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      const delays = scheduledDelays(timers);
      expect(delays[delays.length - 1]).toBeLessThanOrEqual(
        SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO),
      );
      for (let pass = 0; pass < 3; pass += 1) await triggerOutboxSync();
      expect(server.urls()).toHaveLength(2);
    });
  });

  describe('A7 — corrupt persisted wallet state', () => {
    it('an unreadable grant row requests nothing, holds nothing and does not crash the pass', async () => {
      server = serveApi();
      handle.native
        .prepare(
          `INSERT INTO offline_grant (
             owner_key, grant_id, generation, installation_key_id,
             entitlement_source, key_id, issued_at, expires_at,
             entitlement_expires_at, allocation_id, compact_jws,
             grant_jws_sha256, allocated_ticket_ids, lifecycle_sequence, held_at
           ) VALUES (?, 'g-corrupt', 1, 'k', 'identity_lifetime_free', ?, ?, ?,
             NULL, 'g-corrupt', 'not.a.jws', 'zz', 'not json', 0, 'now')`,
        )
        .run(OWNER, KEY_ID, ISSUED_AT, EXPIRES_AT);
      configureSyncRuntime(SESSION);
      await expect(triggerOutboxSync()).resolves.toBeUndefined();
      await expect(triggerOutboxSync()).resolves.toBeUndefined();
      expect(server.urls()).toEqual([]);
      expect(handle.count('offline_grant', OWNER)).toBe(1);
      expect(storedInstallationKey()).toBeUndefined();
    });
  });

  describe('A8 — re-configure while the grant request is in flight', () => {
    it('two runtimes racing for the same owner conserve the tickets the server re-issued', async () => {
      // The Edge function issues a NEW grant generation on every accepted
      // request and re-issues the installation's outstanding ticket ids
      // (issue_offline_grant: `ticket_ids := v_outstanding || v_new`). A
      // second runtime configured while the first one's request is in
      // flight therefore receives the same two tickets under generation 2.
      const outstanding = [
        'aaaaaaaa-0000-4000-8000-0000000000f1',
        'aaaaaaaa-0000-4000-8000-0000000000f2',
      ];
      let issued = 0;
      let releaseFirst: (() => void) | null = null;
      const firstBlocked = new Promise<void>(resolve => {
        releaseFirst = resolve;
      });
      server = serveApi({
        grants: async body => {
          issued += 1;
          const generation = issued;
          if (generation === 1) await firstBlocked;
          return grantResponse({
            installationKeyId: String(body['installationKeyId']),
            generation,
            ticketIds: outstanding,
          });
        },
      });
      configureSyncRuntime(SESSION);
      const first = triggerOutboxSync();
      // Wait until the first runtime's grant request is in flight.
      while (issued === 0) await new Promise(resolve => setTimeout(resolve, 5));
      configureSyncRuntime(SESSION);
      await triggerOutboxSync();
      expect(issued).toBe(2);
      releaseFirst!();
      await first;

      const wallet = await readOfflineAllocation(db, ACTIVE);
      expect(wallet.spendableTickets).toBe(2);
      expect(wallet.consumedTickets).toBe(0);
      expect(handle.count('offline_ticket', OWNER)).toBe(2);
      const live = wallet.grants.filter(
        grant => grant.execution.kind === 'active' && grant.remaining > 0,
      );
      expect(live).toHaveLength(1);
      expect(live[0]!.generation).toBe(2);
    });
  });
});
