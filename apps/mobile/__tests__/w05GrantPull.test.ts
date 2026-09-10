/**
 * W05-06 — the signed-in app pulls an offline grant when it has signal.
 *
 * Before this package nothing in the shipping app called registerDevice() or
 * requestOfflineGrant(): the wallet stayed empty forever. The sync runtime
 * now ends every CLEAN pass (signed-in owner, nothing left pending, a
 * trusted-time reading) that has POSITIVE online evidence by asking the
 * server for a grant when the wallet holds no executable one — none, expired
 * by trusted time, or a free grant with zero unconsumed tickets and no
 * pending receipt.
 *
 * "Signal" is never inferred from the absence of failures: a pass with an
 * empty outbox does no network work, and an anchored trusted-time reading
 * stays anchored after the radio is gone. Only a server answer counts — a
 * round trip this pass made itself (a drained row, a presented receipt) or
 * the access snapshot the billing lifecycle just received from the server,
 * which starts a pass of its own.
 *
 * The installation is identified by a stable key id generated once and kept
 * ONLY in the device Keychain (its own service, same accessibility as the
 * session vault); never in SQLite kv or anywhere else. Refusals are recorded
 * once per owner — across runtime re-configuration — and not retried until
 * access changes; transport failures follow the sync backoff; an offline app
 * never requests; and the pull never spends, releases or reclaims a ticket
 * (allocation ≠ consumption).
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
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import type { CanonicalAccessState } from '../src/billing/types';
import {
  SIGNED_OUT_DATA_OWNER,
  setActiveDataOwner,
} from '../src/data/accountScope';
import { parseIssuedOfflineGrant } from '../src/data/api';
import type { LocalDb } from '../src/data/db';
import {
  INSTALLATION_KEY_ID_PATTERN,
  INSTALLATION_KEY_KEYCHAIN_ACCOUNT,
  INSTALLATION_KEY_KEYCHAIN_SERVICE,
  createInstallationKey,
  installationKey,
} from '../src/data/installationKey';
import {
  consumeOfflineAllocation,
  holdOfflineGrant,
  offlineGrantPullNeeded,
  pendingOfflineReceipts,
  readOfflineAllocation,
} from '../src/data/offlineCapabilities';
import {
  SYNC_RETRY_BASE_MS,
  SYNC_RETRY_JITTER_RATIO,
  clearSyncRuntime,
  configureSyncRuntime,
  resetOfflineGrantRefusals,
  triggerOutboxSync,
} from '../src/data/syncRuntime';
import type {
  TrustedTimeLeaseVerdict,
  TrustedTimeReading,
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
const RESULT_SHA = 'c'.repeat(64);
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
const AFTER_EXPIRY = reading((EXPIRES_AT + 60) * 1000);
const NO_TRUSTED_TIME = reading((ISSUED_AT + 60) * 1000, {
  authority: 'none',
  continuity: 'unmeasured',
  storage: 'empty',
});
const ROLLED_BACK = reading((ISSUED_AT + 60) * 1000, {
  rollbackDetected: true,
});
const FLOOR_ONLY = reading((ISSUED_AT + 60) * 1000, {
  authority: 'floor',
  continuity: 'persisted',
});

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

async function holdFixture(
  db: LocalDb,
  fixture: Omit<GrantFixture, 'installationKeyId'>,
) {
  const installationKeyId = await installationKey.read();
  if (!installationKeyId) throw new Error('fixture needs an installation key');
  const issued = parseIssuedOfflineGrant(
    grantResponse({ ...fixture, installationKeyId }),
  );
  if (!issued) throw new Error('fixture grant response must parse');
  return holdOfflineGrant(db, issued, { issuer: ISSUER, installationKeyId });
}

interface ApiCall {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;
}

type RouteAnswer = Record<string, unknown> | Response;

interface ServerOptions {
  /** Answer for POST /v1/offline/grants; defaults to a fresh free grant. */
  grants?: (body: Record<string, unknown>) => RouteAnswer;
  /** Receipt statuses by receipt id; defaults to `result_recorded`. */
  receiptStatus?: (receiptId: string) => string;
}

function json(answer: RouteAnswer, status = 200): Response {
  if (answer instanceof Response) return answer;
  return new Response(JSON.stringify(answer), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function refusal(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

/** Serves the register, grants, receipts and session-finalize routes like
 * the Edge function; every other route answers the Edge `default:` 404
 * envelope. */
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
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (url === REGISTER_ROUTE) {
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
        if (options.grants) return json(options.grants(body));
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
        const status = options.receiptStatus ?? (() => 'result_recorded');
        return json({
          receipts: receipts.map(receipt => ({
            receiptId: receipt['receiptId'],
            status: status(String(receipt['receiptId'])),
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
  };
}

/** The radio is gone: every request fails before reaching any server. */
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

function queueOutboxRow(handle: ReturnType<typeof createSqliteTestDb>) {
  handle.native
    .prepare(
      "INSERT INTO outbox (owner_key, kind, payload) VALUES (?, 'session.finalize', ?)",
    )
    .run(OWNER, JSON.stringify({ id: 'session-1' }));
}

function storedInstallationKey(): string | undefined {
  return __keychainStore.get(INSTALLATION_KEY_KEYCHAIN_SERVICE)?.password;
}

/** Every SQLite statement (with its parameters) the app executed. */
function sqliteText(handle: ReturnType<typeof createSqliteTestDb>): string[] {
  return handle.calls.map(call => `${call.sql} ${JSON.stringify(call.params)}`);
}

/** The billing lifecycle just received a server answer to the access check
 * and published it — the runtime's online evidence from outside its own
 * round trips. Resolves once the pass that answer starts has finished. */
async function accessAnswered(access: CanonicalAccessState): Promise<void> {
  useAccessStore.setState({ canonicalAccess: { ...access } });
  await triggerOutboxSync();
}

/** The sync timer delays the runtime scheduled (request/Keychain timeouts
 * are far shorter than the healthy cadence and are filtered out). */
function scheduledDelays(spy: jest.SpyInstance): number[] {
  return spy.mock.calls
    .map(call => call[1])
    .filter(
      (delay): delay is number =>
        typeof delay === 'number' &&
        delay >= SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
    );
}

describe('W05-06 installation key: generated once, Keychain only', () => {
  beforeEach(() => {
    __keychainStore.clear();
  });

  it('generates a valid key id once and reads the same id after a relaunch', async () => {
    const firstLaunch = createInstallationKey({ keychain: Keychain });
    const [a, b] = await Promise.all([firstLaunch.read(), firstLaunch.read()]);
    expect(a).toEqual(expect.any(String));
    expect(a).toMatch(INSTALLATION_KEY_ID_PATTERN);
    expect(b).toBe(a);

    const item = __keychainStore.get(INSTALLATION_KEY_KEYCHAIN_SERVICE);
    expect(item).toEqual({
      username: INSTALLATION_KEY_KEYCHAIN_ACCOUNT,
      password: a,
      accessible: Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    expect(INSTALLATION_KEY_KEYCHAIN_SERVICE).not.toBe(SESSION_VAULT_SERVICE);
    expect([...__keychainStore.keys()]).toEqual([
      INSTALLATION_KEY_KEYCHAIN_SERVICE,
    ]);

    const relaunch = createInstallationKey({ keychain: Keychain });
    expect(await relaunch.read()).toBe(a);
    expect(__keychainStore.size).toBe(1);
  });

  it('never hands out an id the Keychain did not keep', async () => {
    const unreadable = createInstallationKey({
      keychain: {
        ...Keychain,
        getGenericPassword: async () => {
          throw new Error('keychain unavailable');
        },
      },
    });
    expect(await unreadable.read()).toBeNull();
    expect(__keychainStore.size).toBe(0);

    const unwritable = createInstallationKey({
      keychain: {
        ...Keychain,
        setGenericPassword: async () => {
          throw new Error('keychain write failed');
        },
      },
    });
    expect(await unwritable.read()).toBeNull();
    expect(__keychainStore.size).toBe(0);

    __keychainStore.set(INSTALLATION_KEY_KEYCHAIN_SERVICE, {
      username: INSTALLATION_KEY_KEYCHAIN_ACCOUNT,
      password: 'not a key id!',
    });
    const corrupt = createInstallationKey({ keychain: Keychain });
    expect(await corrupt.read()).toBeNull();
    expect(storedInstallationKey()).toBe('not a key id!');
  });
});

describe('W05-06 offline grant pull needs', () => {
  const view = (
    execution: TrustedTimeLeaseVerdict,
    remaining: number,
    pro = false,
  ) => ({
    grantId: 'g',
    generation: 1,
    entitlementSource: pro
      ? ('verified_store' as const)
      : ('identity_lifetime_free' as const),
    installationKeyId: 'k',
    keyId: KEY_ID,
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: null,
    grantJwsSha256: 'e'.repeat(64),
    allocated: pro ? 0 : 2,
    remaining,
    consumed: pro ? 0 : 2 - remaining,
    lifecycleSequence: 0,
    execution,
  });
  const snapshot = (
    grants: ReturnType<typeof view>[],
    pendingReceipts = 0,
  ) => ({
    grants,
    spendableTickets: grants.reduce((sum, grant) => sum + grant.remaining, 0),
    consumedTickets: grants.reduce((sum, grant) => sum + grant.consumed, 0),
    pendingReceipts,
  });
  const active: TrustedTimeLeaseVerdict = { kind: 'active', remainingMs: 1000 };
  const expired: TrustedTimeLeaseVerdict = { kind: 'expired' };
  const unproven: TrustedTimeLeaseVerdict = {
    kind: 'reconcile_required',
    reason: 'floor_only',
  };

  it('pulls for an empty wallet, an expired grant or an exhausted free grant', () => {
    expect(offlineGrantPullNeeded(snapshot([]))).toBe(true);
    expect(offlineGrantPullNeeded(snapshot([view(expired, 2)]))).toBe(true);
    expect(offlineGrantPullNeeded(snapshot([view(active, 0)]))).toBe(true);
  });

  it('never pulls over a live grant, a pending receipt or unproven time', () => {
    expect(offlineGrantPullNeeded(snapshot([view(active, 1)]))).toBe(false);
    expect(offlineGrantPullNeeded(snapshot([view(active, 0, true)]))).toBe(
      false,
    );
    expect(offlineGrantPullNeeded(snapshot([view(active, 0)], 1))).toBe(false);
    expect(offlineGrantPullNeeded(snapshot([], 1))).toBe(false);
    expect(offlineGrantPullNeeded(snapshot([view(unproven, 2)]))).toBe(false);
    expect(
      offlineGrantPullNeeded(snapshot([view(expired, 2), view(unproven, 2)])),
    ).toBe(false);
  });
});

describe('W05-06 the sync runtime pulls an offline grant when it has signal', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;
  let server: ReturnType<typeof serveApi> | null = null;
  let network: ReturnType<typeof offline> | null = null;

  beforeEach(() => {
    __keychainStore.clear();
    resetOfflineGrantRefusals();
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
    (getDb as jest.Mock).mockReturnValue(db);
    establishApiSession(SESSION);
    mockReading = ACTIVE;
    // The access snapshot of an earlier launch: known, but no evidence that
    // the server is reachable right now.
    useAccessStore.setState({ canonicalAccess: FREE_ACCESS });
  });

  afterEach(() => {
    clearSyncRuntime();
    clearApiSession();
    server?.spy.mockRestore();
    network?.spy.mockRestore();
    server = null;
    network = null;
    useAccessStore.setState({ canonicalAccess: null });
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    (getDb as jest.Mock).mockReset();
    handle.close();
    mockReading = null;
    jest.restoreAllMocks();
  });

  it('signed in, online, empty wallet: registers the installation, requests two free tickets and holds the grant', async () => {
    server = serveApi();
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);

    const key = storedInstallationKey();
    expect(key).toEqual(expect.any(String));
    expect(key).toMatch(INSTALLATION_KEY_ID_PATTERN);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    const [register, issue] = server.calls.filter(
      call => call.url === REGISTER_ROUTE || call.url === GRANTS_ROUTE,
    );
    expect(register!.headers['authorization']).toBe('Bearer access-token');
    expect(register!.body).toEqual({
      installationKeyId: key,
      attestationEnvironment: __DEV__ ? 'development' : 'production',
    });
    expect(issue!.body).toEqual({
      installationKeyId: key,
      requestedTickets: 2,
    });

    expect(handle.count('offline_grant', OWNER)).toBe(1);
    const wallet = await readOfflineAllocation(db, ACTIVE);
    expect(wallet.grants).toHaveLength(1);
    expect(wallet.grants[0]).toMatchObject({
      installationKeyId: key,
      allocated: 2,
      remaining: 2,
      consumed: 0,
      execution: { kind: 'active' },
    });
    expect(wallet.spendableTickets).toBe(2);
    expect(wallet.consumedTickets).toBe(0);
    expect(await pendingOfflineReceipts(db)).toEqual([]);

    // The identity lives in the Keychain alone: the session vault service
    // is untouched and no SQLite kv row (or any other table besides the
    // server-signed grant binding) carries the key id.
    expect([...__keychainStore.keys()]).toEqual([
      INSTALLATION_KEY_KEYCHAIN_SERVICE,
    ]);
    const statementsNamingKey = sqliteText(handle).filter(text =>
      text.includes(key!),
    );
    expect(statementsNamingKey.length).toBeGreaterThan(0);
    for (const text of statementsNamingKey) {
      expect(text).toMatch(/INSERT INTO offline_grant\b/);
      expect(text).not.toMatch(/\bkv\b/);
    }

    // A live grant in the wallet: the next passes request nothing more,
    // with or without fresh signal.
    await triggerOutboxSync();
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('a clean pass that did no network work is not signal: nothing is requested until the server answers', async () => {
    server = serveApi();
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();
    await triggerOutboxSync();
    await triggerOutboxSync();
    expect(server.calls).toEqual([]);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect(storedInstallationKey()).toBeUndefined();

    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('a row the pass drained through the server is signal: the same pass pulls the grant', async () => {
    server = serveApi();
    queueOutboxRow(handle);
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();
    expect(server.calls.map(call => call.url)).toEqual([
      FINALIZE_ROUTE,
      REGISTER_ROUTE,
      GRANTS_ROUTE,
    ]);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('a Pro member requests a zero-ticket lease and the server-issued lease is held as-is', async () => {
    useAccessStore.setState({ canonicalAccess: PRO_ACCESS });
    server = serveApi();
    configureSyncRuntime(SESSION);
    await accessAnswered(PRO_ACCESS);

    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(server.calls.find(call => call.url === GRANTS_ROUTE)!.body).toEqual({
      installationKeyId: storedInstallationKey(),
      requestedTickets: 0,
    });
    const wallet = await readOfflineAllocation(db, ACTIVE);
    expect(wallet.grants[0]).toMatchObject({
      entitlementSource: 'verified_store',
      allocated: 0,
      remaining: 0,
      execution: { kind: 'active' },
    });
    await accessAnswered(PRO_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
  });

  it('the app displays only what the server issued: a clamped grant is held with its own ticket count', async () => {
    server = serveApi({
      grants: body =>
        grantResponse({
          installationKeyId: String(body['installationKeyId']),
          ticketIds: ['aaaaaaaa-0000-4000-8000-00000000ffff'],
        }),
    });
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    const wallet = await readOfflineAllocation(db, ACTIVE);
    expect(wallet.spendableTickets).toBe(1);
    expect(wallet.grants[0]).toMatchObject({ allocated: 1, remaining: 1 });
  });

  it('a wallet holding a live grant requests nothing', async () => {
    server = serveApi();
    await holdFixture(db, {});
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    await triggerOutboxSync();
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([]);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('a grant expired by trusted time triggers a new request and keeps the old allocation', async () => {
    server = serveApi({
      grants: body =>
        grantResponse({
          installationKeyId: String(body['installationKeyId']),
          issuedAt: EXPIRES_AT,
          expiresAt: EXPIRES_AT + 6 * 24 * 60 * 60,
        }),
    });
    const expiredGrant = await holdFixture(db, {
      grantId: 'bbbbbbbb-0000-4000-8000-0000000000ee',
    });
    mockReading = AFTER_EXPIRY;
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);

    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(server.calls.find(call => call.url === GRANTS_ROUTE)!.body).toEqual({
      installationKeyId: expiredGrant.installationKeyId,
      requestedTickets: 2,
    });
    // Held, not spent, released or reclaimed: the expired grant stays in the
    // ledger with its unspent tickets, and nothing was consumed.
    expect(handle.count('offline_grant', OWNER)).toBe(2);
    const wallet = await readOfflineAllocation(db, AFTER_EXPIRY);
    expect(wallet.consumedTickets).toBe(0);
    expect(
      wallet.grants.find(grant => grant.grantId === expiredGrant.grantId),
    ).toMatchObject({ remaining: 2, execution: { kind: 'expired' } });
    expect(
      wallet.grants.find(grant => grant.grantId !== expiredGrant.grantId),
    ).toMatchObject({ remaining: 2, execution: { kind: 'active' } });
    expect(await pendingOfflineReceipts(db)).toEqual([]);

    // The fresh grant is live: no further request.
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
  });

  it('signal does not outlive the pass it reached: a grant that expires later waits for the next answer', async () => {
    server = serveApi({
      grants: body =>
        grantResponse({
          installationKeyId: String(body['installationKeyId']),
          issuedAt: EXPIRES_AT,
          expiresAt: EXPIRES_AT + 6 * 24 * 60 * 60,
        }),
    });
    await holdFixture(db, {});
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([]);

    // Time passes, the grant expires, the app comes to the foreground: this
    // pass does no network work and the earlier answer is no evidence that
    // the device is still connected.
    mockReading = AFTER_EXPIRY;
    await triggerOutboxSync();
    await triggerOutboxSync();
    expect(server.calls).toEqual([]);
    expect(handle.count('offline_grant', OWNER)).toBe(1);

    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(handle.count('offline_grant', OWNER)).toBe(2);
  });

  it('a free grant with every ticket spent and every receipt settled triggers a new request', async () => {
    server = serveApi();
    await holdFixture(db, {
      ticketIds: ['aaaaaaaa-0000-4000-8000-0000000000aa'],
    });
    const consumed = await consumeOfflineAllocation(
      db,
      {
        operationId: 'op-1',
        resultId: 'result-op-1',
        fullOutputSha256: RESULT_SHA,
      },
      ACTIVE,
    );
    configureSyncRuntime(SESSION);
    // The presented receipt is the round trip: no access answer needed.
    await triggerOutboxSync();

    const receiptCalls = server.calls.filter(
      call => call.url === RECEIPTS_ROUTE,
    );
    expect(receiptCalls).toHaveLength(1);
    expect(await pendingOfflineReceipts(db)).toEqual([]);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(handle.count('offline_grant', OWNER)).toBe(2);
    const wallet = await readOfflineAllocation(db, ACTIVE);
    expect(wallet.consumedTickets).toBe(1);
    expect(wallet.spendableTickets).toBe(2);
    expect(consumed.receipt.receiptId).toEqual(expect.any(String));
  });

  it('a free grant with every ticket spent but a receipt the server withholds requests nothing', async () => {
    server = serveApi({ receiptStatus: () => 'pending' });
    await holdFixture(db, {
      ticketIds: ['aaaaaaaa-0000-4000-8000-0000000000ab'],
    });
    await consumeOfflineAllocation(
      db,
      {
        operationId: 'op-2',
        resultId: 'result-op-2',
        fullOutputSha256: RESULT_SHA,
      },
      ACTIVE,
    );
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();
    await accessAnswered(FREE_ACCESS);
    expect(
      server.calls.filter(call => call.url === RECEIPTS_ROUTE).length,
    ).toBeGreaterThanOrEqual(1);
    expect(server.urls()).toEqual([]);
    expect(await pendingOfflineReceipts(db)).toHaveLength(1);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
  });

  it('offline with an EMPTY outbox: no pass ever touches the network, registers or requests', async () => {
    network = offline();
    configureSyncRuntime(SESSION);
    await triggerOutboxSync();
    await triggerOutboxSync();
    await triggerOutboxSync();
    expect(network.calls).toEqual([]);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect(storedInstallationKey()).toBeUndefined();
  });

  it('offline with a queued row: the failed round trip withdraws the signal an access answer gave', async () => {
    network = offline();
    queueOutboxRow(handle);
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    await triggerOutboxSync();
    expect(network.calls).toContain(FINALIZE_ROUTE);
    expect(network.calls).not.toContain(REGISTER_ROUTE);
    expect(network.calls).not.toContain(GRANTS_ROUTE);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect(storedInstallationKey()).toBeUndefined();
  });

  it('without a trusted-time reading, or with a rolled-back or floor-only clock, nothing is requested', async () => {
    server = serveApi();
    for (const unusable of [NO_TRUSTED_TIME, ROLLED_BACK, FLOOR_ONLY]) {
      mockReading = unusable;
      configureSyncRuntime(SESSION);
      await accessAnswered(FREE_ACCESS);
      clearSyncRuntime();
    }
    expect(server.urls()).toEqual([]);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect(storedInstallationKey()).toBeUndefined();
  });

  it('a signed-out or different active owner never requests for the configured owner', async () => {
    server = serveApi();
    setActiveDataOwner(OTHER_OWNER);
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([]);
    setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([]);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
  });

  it('a refusal is recorded once and not retried until access changes', async () => {
    server = serveApi({
      grants: () =>
        refusal(402, 'access.paywall_required', 'The free ratings are spent.'),
    });
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(handle.count('offline_grant', OWNER)).toBe(0);

    // Timer passes, and fresh access answers that say the same thing.
    for (let pass = 0; pass < 5; pass += 1) await triggerOutboxSync();
    await accessAnswered(FREE_ACCESS);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);

    // Access changed (the member upgraded): one more request, as Pro.
    await accessAnswered(PRO_ACCESS);
    expect(server.urls()).toEqual([
      REGISTER_ROUTE,
      GRANTS_ROUTE,
      REGISTER_ROUTE,
      GRANTS_ROUTE,
    ]);
    expect(
      server.calls.filter(call => call.url === GRANTS_ROUTE)[1]!.body,
    ).toEqual({
      installationKeyId: storedInstallationKey(),
      requestedTickets: 0,
    });
    await accessAnswered(PRO_ACCESS);
    expect(server.urls()).toHaveLength(4);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
  });

  it('a refusal survives runtime re-configuration (relaunch, re-sign-in) while access is unchanged', async () => {
    server = serveApi({
      grants: () =>
        refusal(402, 'access.paywall_required', 'The free ratings are spent.'),
    });
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);

    for (let relaunch = 0; relaunch < 3; relaunch += 1) {
      clearSyncRuntime();
      configureSyncRuntime(SESSION);
      await accessAnswered(FREE_ACCESS);
    }
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    expect(handle.count('offline_grant', OWNER)).toBe(0);

    // Another account on the same installation is not bound by it.
    clearSyncRuntime();
    clearApiSession();
    const otherSession = { ...SESSION, canonicalAppUserId: OTHER_OWNER };
    setActiveDataOwner(OTHER_OWNER);
    establishApiSession(otherSession);
    configureSyncRuntime(otherSession);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toHaveLength(4);
    expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);
    expect(__keychainStore.size).toBe(1);
  });

  it('a refusal is not a failed pass (healthy cadence); a server outage is retried under the sync backoff', async () => {
    const timers = jest.spyOn(globalThis, 'setTimeout');
    let outage = false;
    let refuse = true;
    server = serveApi({
      grants: body => {
        if (refuse) {
          return refusal(402, 'access.paywall_required', 'Spent.');
        }
        return outage
          ? json({ error: 'unavailable' }, 503)
          : grantResponse({
              installationKeyId: String(body['installationKeyId']),
            });
      },
    });
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    expect(server.urls()).toEqual([REGISTER_ROUTE, GRANTS_ROUTE]);
    for (const delay of scheduledDelays(timers)) {
      expect(delay).toBeLessThanOrEqual(
        SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO),
      );
    }

    refuse = false;
    outage = true;
    await accessAnswered(PRO_ACCESS);
    expect(server.urls()).toHaveLength(4);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    // A 503 is a failed pass: the timer has backed off, and the backed-off
    // pass retries the transport failure (the request left the device and
    // something answered) — once per pass, backing off further while the
    // outage lasts.
    const delays = scheduledDelays(timers);
    expect(delays[delays.length - 1]).toBeGreaterThanOrEqual(
      2 * SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
    );
    await triggerOutboxSync();
    expect(server.urls()).toHaveLength(6);
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    const backedOff = scheduledDelays(timers);
    expect(backedOff[backedOff.length - 1]).toBeGreaterThanOrEqual(
      4 * SYNC_RETRY_BASE_MS * (1 - SYNC_RETRY_JITTER_RATIO),
    );

    // The radio goes while the retry is pending: the retry leaves the device
    // and fails without an answer, and that is the last request — nothing is
    // signal any more until the server answers again.
    server.spy.mockRestore();
    const radioGone = offline();
    await triggerOutboxSync();
    expect(radioGone.calls).toEqual([REGISTER_ROUTE]);
    await triggerOutboxSync();
    await triggerOutboxSync();
    expect(radioGone.calls).toEqual([REGISTER_ROUTE]);
    radioGone.spy.mockRestore();

    server = serveApi({
      grants: body =>
        grantResponse({ installationKeyId: String(body['installationKeyId']) }),
    });
    await triggerOutboxSync();
    expect(server.urls()).toHaveLength(0);
    await accessAnswered(PRO_ACCESS);
    expect(server.urls()).toHaveLength(2);
    expect(handle.count('offline_grant', OWNER)).toBe(1);
    // Held, the cadence is healthy again, and nothing more is requested.
    const healthy = scheduledDelays(timers);
    expect(healthy[healthy.length - 1]).toBeLessThanOrEqual(
      SYNC_RETRY_BASE_MS * (1 + SYNC_RETRY_JITTER_RATIO),
    );
    await triggerOutboxSync();
    expect(server.urls()).toHaveLength(2);
  });

  it('a relaunch registers with the same installation key it used before', async () => {
    server = serveApi();
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);
    const key = storedInstallationKey();
    expect(key).toEqual(expect.any(String));

    // The process died: a new runtime, a new local database (the wallet is
    // gone with the old one) — only the Keychain survives.
    clearSyncRuntime();
    handle.close();
    handle = createSqliteTestDb();
    db = handle.db;
    (getDb as jest.Mock).mockReturnValue(db);
    configureSyncRuntime(SESSION);
    await accessAnswered(FREE_ACCESS);

    const registers = server.calls.filter(call => call.url === REGISTER_ROUTE);
    expect(registers).toHaveLength(2);
    expect(registers[1]!.body['installationKeyId']).toBe(key);
    expect(storedInstallationKey()).toBe(key);
    expect(__keychainStore.size).toBe(1);
  });
});
