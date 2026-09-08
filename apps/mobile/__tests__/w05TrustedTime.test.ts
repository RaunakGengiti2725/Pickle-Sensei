/**
 * W05-02 — trusted time for offline lease expiry.
 *
 * Pins the behaviour of `src/data/trustedTime.ts`:
 *  - server time is taken ONLY from authenticated API responses and anchored
 *    to the monotonic clock; a backwards wall-clock jump never extends a
 *    lease (the monotonic path keeps counting and the jump is reported so the
 *    caller requires online reconciliation);
 *  - the anchor / high-water mark persists in a distinct THIS_DEVICE_ONLY
 *    Keychain service (never the session vault) so a relaunch with no
 *    monotonic continuity still has a floor below which "now" cannot fall;
 *  - corrupt, missing or unavailable storage never becomes authorization —
 *    lease evaluation reports that reconciliation is required;
 *  - Pro leases are capped at OFFLINE_PRO_LEASE_MAX_SECONDS;
 *  - `src/data/api.ts` feeds every authenticated `Date` header into the module.
 */

import * as Keychain from 'react-native-keychain';
import { OFFLINE_PRO_LEASE_MAX_SECONDS } from '@pickle/shared-types';
import { SESSION_VAULT_SERVICE } from '../src/account/sessionVault';
import { api, createAnalysisPermitClient } from '../src/data/api';
import {
  TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
  TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
  TRUSTED_TIME_KEYCHAIN_ACCOUNT,
  TRUSTED_TIME_KEYCHAIN_SERVICE,
  TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
  createTrustedTime,
  evaluateLease,
  responseDateHeader,
  trustedTime,
  type TrustedTimeKeychain,
} from '../src/data/trustedTime';

const { __keychainStore } = Keychain as unknown as {
  __keychainStore: Map<
    string,
    { username: string; password: string; accessible?: string }
  >;
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const LEASE_MAX_MS = OFFLINE_PRO_LEASE_MAX_SECONDS * 1000;
/** Server time on the authenticated response that issued the lease. */
const SERVER_MS = Date.UTC(2026, 8, 8, 12, 0, 0);

function serverHeader(ms: number): string {
  return new Date(ms).toUTCString();
}

interface Clocks {
  monotonicMs: number;
  wallMs: number;
}

function harness(clocks: Clocks, keychain: TrustedTimeKeychain = Keychain) {
  return createTrustedTime({
    keychain,
    monotonicNowMs: () => clocks.monotonicMs,
    wallClockNowMs: () => clocks.wallMs,
  });
}

function storedRecord(): Record<string, unknown> {
  const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
  if (!item) throw new Error('no trusted-time record persisted');
  return JSON.parse(item.password) as Record<string, unknown>;
}

const lease = { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + LEASE_MAX_MS };

beforeEach(() => {
  __keychainStore.clear();
});

describe('W05-02 trusted time — anchored on an authenticated server response', () => {
  it('counts lease time on the monotonic clock and persists the anchor', async () => {
    const clocks: Clocks = { monotonicMs: 1_000, wallMs: SERVER_MS + 2_000 };
    const time = harness(clocks);

    const observation = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(observation).toEqual({ accepted: true, serverEpochMs: SERVER_MS });

    clocks.monotonicMs += 3 * DAY;
    clocks.wallMs += 3 * DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(reading.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 3 * DAY,
    });

    const item = __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE);
    expect(item?.username).toBe(TRUSTED_TIME_KEYCHAIN_ACCOUNT);
    expect(item?.accessible).toBe(
      Keychain.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    );
    expect(TRUSTED_TIME_KEYCHAIN_SERVICE).not.toBe(SESSION_VAULT_SERVICE);
    expect(__keychainStore.has(SESSION_VAULT_SERVICE)).toBe(false);
    const record = storedRecord();
    expect(record.schemaVersion).toBe(TRUSTED_TIME_ANCHOR_SCHEMA_VERSION);
    expect(record.serverEpochMs).toBe(SERVER_MS);
    expect(Object.keys(record).sort()).toEqual([
      'highWaterMs',
      'schemaVersion',
      'serverEpochMs',
      'wallOffsetMs',
    ]);
  });

  it('a backwards wall-clock jump cannot extend the lease', async () => {
    const clocks: Clocks = { monotonicMs: 50_000, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    clocks.monotonicMs += 3 * DAY;
    clocks.wallMs = SERVER_MS - 10 * DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(reading.wallClockMs).toBe(SERVER_MS - 10 * DAY);
    expect(reading.rollbackDetected).toBe(true);

    const verdict = evaluateLease(lease, reading);
    expect(verdict).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });
    // Whatever the caller does with the verdict, no remaining time beyond the
    // monotonic truth is ever reported.
    expect(verdict.kind).not.toBe('active');
  });

  it('a forward wall-clock jump only shortens the lease', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });

    clocks.monotonicMs += 1 * DAY;
    clocks.wallMs = SERVER_MS + 10 * DAY;
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + 10 * DAY);
    expect(reading.rollbackDetected).toBe(false);
    expect(evaluateLease(lease, reading)).toEqual({ kind: 'expired' });
  });

  it('an authenticated server time is the authority over local extrapolation', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += 2 * HOUR;
    clocks.wallMs += 2 * HOUR;
    expect((await time.read()).nowMs).toBe(SERVER_MS + 2 * HOUR);

    // Leases are issued in server time; when the server says less has passed
    // than the device extrapolated, the device re-anchors to the server.
    const behind = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + HOUR),
      authenticated: true,
    });
    expect(behind).toEqual({ accepted: true, serverEpochMs: SERVER_MS + HOUR });
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBe(SERVER_MS + HOUR);
    expect(reading.rollbackDetected).toBe(false);
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + HOUR);
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + HOUR);

    // The device wall clock, by contrast, is never an authority: winding it
    // back after the re-anchor changes nothing but the rollback flag.
    clocks.monotonicMs += HOUR;
    clocks.wallMs = SERVER_MS - DAY;
    const later = await time.read();
    expect(later.nowMs).toBe(SERVER_MS + 2 * HOUR);
    expect(later.rollbackDetected).toBe(true);
  });

  it('checkpoints the high-water mark while the process lives', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(storedRecord().highWaterMs).toBe(SERVER_MS);

    clocks.monotonicMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS - 1;
    clocks.wallMs += TRUSTED_TIME_CHECKPOINT_INTERVAL_MS - 1;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(SERVER_MS);

    clocks.monotonicMs += 1;
    clocks.wallMs += 1;
    await time.read();
    expect(storedRecord().highWaterMs).toBe(
      SERVER_MS + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS,
    );

    clocks.monotonicMs += 2 * DAY;
    clocks.wallMs += 2 * DAY;
    await time.checkpoint();
    expect(storedRecord().highWaterMs).toBe(
      SERVER_MS + TRUSTED_TIME_CHECKPOINT_INTERVAL_MS + 2 * DAY,
    );
  });
});

describe('W05-02 trusted time — relaunch without monotonic continuity', () => {
  async function persistedAfterThreeDays(): Promise<void> {
    const clocks: Clocks = { monotonicMs: 10_000, wallMs: SERVER_MS + 500 };
    const first = harness(clocks);
    await first.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += 3 * DAY;
    clocks.wallMs += 3 * DAY;
    await first.checkpoint();
    expect(storedRecord().highWaterMs).toBe(SERVER_MS + 3 * DAY);
  }

  it('uses the persisted floor and a consistent wall clock', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + 500 + 4 * DAY,
    };
    const time = harness(relaunch);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.storage).toBe('loaded');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBe(SERVER_MS + 4 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 4 * DAY,
    });
  });

  it('a wall clock rolled back below the floor cannot extend the lease', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs:
        SERVER_MS + 500 + 3 * DAY - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS - 1,
    };
    const time = harness(relaunch);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.rollbackDetected).toBe(true);
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'clock_rollback',
    });

    relaunch.wallMs = SERVER_MS - 30 * DAY;
    const deep = await time.read();
    expect(deep.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(deep.rollbackDetected).toBe(true);
    expect(evaluateLease(lease, deep).kind).toBe('reconcile_required');
  });

  it('a wall clock slightly behind the floor is tolerated but never trusted below it', async () => {
    await persistedAfterThreeDays();

    const relaunch: Clocks = {
      monotonicMs: 5,
      wallMs: SERVER_MS + 500 + 3 * DAY - TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
    };
    const time = harness(relaunch);
    const reading = await time.read();
    expect(reading.authority).toBe('floor');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBe(SERVER_MS + 3 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 3 * DAY,
    });
  });

  it('a fresh authenticated response re-anchors after a relaunch', async () => {
    await persistedAfterThreeDays();
    const relaunch: Clocks = { monotonicMs: 5, wallMs: SERVER_MS - 30 * DAY };
    const time = harness(relaunch);
    expect((await time.read()).rollbackDetected).toBe(true);

    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + 5 * DAY),
      authenticated: true,
    });
    const reading = await time.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.rollbackDetected).toBe(false);
    expect(reading.nowMs).toBe(SERVER_MS + 5 * DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'active',
      remainingMs: LEASE_MAX_MS - 5 * DAY,
    });
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + 5 * DAY);
  });
});

describe('W05-02 trusted time — storage and input faults', () => {
  it('without any anchor the lease requires reconciliation', async () => {
    const time = harness({ monotonicMs: 0, wallMs: SERVER_MS + DAY });
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(reading.storage).toBe('empty');
    expect(reading.nowMs).toBe(SERVER_MS + DAY);
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'no_trusted_time',
    });
  });

  it('a corrupt record is neither trusted nor destroyed, and is replaced by the next anchor', async () => {
    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
      password:
        '{"schemaVersion":"trusted-time-anchor-v1","serverEpochMs":"soon"',
    });
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS + DAY };
    const time = harness(clocks);
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(reading.storage).toBe('invalid');
    expect(evaluateLease(lease, reading)).toEqual({
      kind: 'reconcile_required',
      reason: 'storage_invalid',
    });
    expect(
      __keychainStore.get(TRUSTED_TIME_KEYCHAIN_SERVICE)?.password,
    ).toContain('"soon"');

    for (const password of [
      JSON.stringify({
        schemaVersion: 'trusted-time-anchor-v0',
        serverEpochMs: SERVER_MS,
        highWaterMs: SERVER_MS,
        wallOffsetMs: 0,
      }),
      JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: SERVER_MS,
        highWaterMs: SERVER_MS - 1,
        wallOffsetMs: 0,
      }),
      JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: 12.5,
        highWaterMs: SERVER_MS,
        wallOffsetMs: 0,
      }),
      JSON.stringify([SERVER_MS]),
    ]) {
      __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
        username: TRUSTED_TIME_KEYCHAIN_ACCOUNT,
        password,
      });
      const fresh = await harness(clocks).read();
      expect(fresh.authority).toBe('none');
      expect(fresh.storage).toBe('invalid');
    }

    __keychainStore.set(TRUSTED_TIME_KEYCHAIN_SERVICE, {
      username: 'someone-else',
      password: JSON.stringify({
        schemaVersion: TRUSTED_TIME_ANCHOR_SCHEMA_VERSION,
        serverEpochMs: SERVER_MS,
        highWaterMs: SERVER_MS,
        wallOffsetMs: 0,
      }),
    });
    expect((await harness(clocks).read()).storage).toBe('invalid');

    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS + DAY),
      authenticated: true,
    });
    const anchored = await time.read();
    expect(anchored.authority).toBe('anchored');
    expect(anchored.nowMs).toBe(SERVER_MS + DAY);
    expect(storedRecord().serverEpochMs).toBe(SERVER_MS + DAY);
  });

  it('an unavailable Keychain is reported, and an in-process anchor still works', async () => {
    const broken: TrustedTimeKeychain = {
      ACCESSIBLE: Keychain.ACCESSIBLE,
      getGenericPassword: async () => {
        throw new Error('errSecInteractionNotAllowed');
      },
      setGenericPassword: async () => {
        throw new Error('errSecInteractionNotAllowed');
      },
    };
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks, broken);
    const before = await time.read();
    expect(before.authority).toBe('none');
    expect(before.storage).toBe('unavailable');
    expect(evaluateLease(lease, before)).toEqual({
      kind: 'reconcile_required',
      reason: 'no_trusted_time',
    });

    const observation = await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    expect(observation.accepted).toBe(true);
    clocks.monotonicMs += DAY;
    clocks.wallMs -= DAY;
    const after = await time.read();
    expect(after.authority).toBe('anchored');
    expect(after.nowMs).toBe(SERVER_MS + DAY);
    expect(after.rollbackDetected).toBe(true);
    expect(__keychainStore.size).toBe(0);
  });

  it('ignores unauthenticated, missing, malformed and implausible server dates', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    const cases: {
      dateHeader: string | null;
      authenticated: boolean;
      reason: string;
    }[] = [
      {
        dateHeader: serverHeader(SERVER_MS),
        authenticated: false,
        reason: 'unauthenticated',
      },
      { dateHeader: null, authenticated: true, reason: 'missing' },
      { dateHeader: 'yesterday', authenticated: true, reason: 'malformed' },
      { dateHeader: '', authenticated: true, reason: 'missing' },
      {
        dateHeader: serverHeader(Date.UTC(2015, 0, 1)),
        authenticated: true,
        reason: 'implausible',
      },
      {
        dateHeader: serverHeader(Date.UTC(2200, 0, 1)),
        authenticated: true,
        reason: 'implausible',
      },
    ];
    for (const input of cases) {
      expect(await time.observeServerTime(input)).toEqual({
        accepted: false,
        reason: input.reason,
      });
    }
    const reading = await time.read();
    expect(reading.authority).toBe('none');
    expect(__keychainStore.size).toBe(0);
  });

  it('rejects malformed leases and leases issued ahead of the trusted clock', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    const reading = await time.read();
    for (const bad of [
      { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS },
      { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS - 1 },
      { issuedAtMs: SERVER_MS + 0.5, expiresAtMs: SERVER_MS + DAY },
      { issuedAtMs: Number.NaN, expiresAtMs: SERVER_MS + DAY },
      { issuedAtMs: SERVER_MS, expiresAtMs: Number.POSITIVE_INFINITY },
    ]) {
      expect(evaluateLease(bad, reading)).toEqual({
        kind: 'reconcile_required',
        reason: 'invalid_lease',
      });
    }
    expect(
      evaluateLease(
        {
          issuedAtMs: SERVER_MS + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS + 1,
          expiresAtMs: SERVER_MS + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'reconcile_required', reason: 'lease_ahead_of_clock' });
    expect(
      evaluateLease(
        {
          issuedAtMs: SERVER_MS + TRUSTED_TIME_ROLLBACK_TOLERANCE_MS,
          expiresAtMs: SERVER_MS + DAY,
        },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: DAY });
  });

  it('caps a Pro lease at OFFLINE_PRO_LEASE_MAX_SECONDS from issue', async () => {
    const clocks: Clocks = { monotonicMs: 0, wallMs: SERVER_MS };
    const time = harness(clocks);
    await time.observeServerTime({
      dateHeader: serverHeader(SERVER_MS),
      authenticated: true,
    });
    clocks.monotonicMs += DAY;
    clocks.wallMs += DAY;
    const reading = await time.read();
    expect(
      evaluateLease(
        { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + 30 * DAY },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: LEASE_MAX_MS - DAY });
    expect(
      evaluateLease(
        { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + 2 * DAY },
        reading,
      ),
    ).toEqual({ kind: 'active', remainingMs: DAY });
    clocks.monotonicMs += LEASE_MAX_MS;
    clocks.wallMs += LEASE_MAX_MS;
    expect(
      evaluateLease(
        { issuedAtMs: SERVER_MS, expiresAtMs: SERVER_MS + 30 * DAY },
        await time.read(),
      ),
    ).toEqual({ kind: 'expired' });
  });
});

describe('W05-02 trusted time — wired into the API client', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = originalFetch;
  });

  function response(body: unknown, headers?: Record<string, string>): Response {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
      ...(headers ? { headers: new Headers(headers) } : {}),
    } as unknown as Response;
  }

  it('reads the Date header defensively', () => {
    expect(responseDateHeader(response({}))).toBeNull();
    expect(
      responseDateHeader(response({}, { date: serverHeader(SERVER_MS) })),
    ).toBe(serverHeader(SERVER_MS));
    expect(
      responseDateHeader({
        headers: {
          get() {
            throw new Error('no headers on this transport');
          },
        },
      } as unknown as Response),
    ).toBeNull();
  });

  it('anchors the shared trusted clock from an authenticated permit reservation', async () => {
    const permitServerMs = Date.UTC(2026, 8, 9, 8, 30, 0);
    const permit = {
      id: '22222222-2222-4222-8222-222222222222',
      accessSource: 'premium',
      status: 'reserved',
      expiresAt: new Date(permitServerMs + 10 * 60_000).toISOString(),
    };
    const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      if (url.endsWith('/v1/analysis-permits') && headers.authorization)
        return response({ permit }, { date: serverHeader(permitServerMs) });
      if (url.endsWith('/v1/anonymous'))
        return response({ ok: true }, { date: serverHeader(permitServerMs) });
      throw new Error(`Unexpected fetch: ${url}`);
    });
    (globalThis as { fetch?: unknown }).fetch = fetchMock;

    const before = await trustedTime.read();
    expect(before.authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);

    await api.request(
      { baseUrl: 'https://api.test', token: null },
      'GET',
      '/v1/anonymous',
    );
    expect((await trustedTime.read()).authority).toBe('none');
    expect(__keychainStore.has(TRUSTED_TIME_KEYCHAIN_SERVICE)).toBe(false);

    const client = createAnalysisPermitClient({
      baseUrl: 'https://api.test',
      token: 'access-token',
    });
    const reserved = await client.reserve('idem-1');
    expect(reserved.permit.id).toBe(permit.id);

    const reading = await trustedTime.read();
    expect(reading.authority).toBe('anchored');
    expect(reading.nowMs).toBeGreaterThanOrEqual(permitServerMs);
    expect(reading.nowMs).toBeLessThan(permitServerMs + HOUR);
    expect(storedRecord().serverEpochMs).toBe(permitServerMs);
    expect(
      evaluateLease(
        { issuedAtMs: permitServerMs, expiresAtMs: permitServerMs + DAY },
        reading,
      ).kind,
    ).toBe('active');
  });

  it('a response without headers (legacy transport) leaves the request path untouched', async () => {
    const fetchMock = jest.fn(async () => response({ ok: true }));
    (globalThis as { fetch?: unknown }).fetch = fetchMock;
    await expect(
      api.request(
        { baseUrl: 'https://api.test', token: 'access-token' },
        'POST',
        '/v1/sessions',
        {},
      ),
    ).resolves.toEqual({ ok: true });
  });
});
