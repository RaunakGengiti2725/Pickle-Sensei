/**
 * W04-05 adversarial suite, transport half (attack branch
 * devin/pp/w04-05/attack-5e07095a): every way the network can fail during
 * device registration or grant issuance must end in a typed ApiError and an
 * unchanged wallet — never a held grant, never a fabricated allocation.
 */
import {
  API_REQUEST_TIMEOUT_MS,
  ApiError,
  createOfflineGrantClient,
  parseIssuedOfflineGrant,
} from '../src/data/api';
import { setActiveDataOwner } from '../src/data/accountScope';
import type { LocalDb } from '../src/data/db';
import {
  OfflineGrantError,
  readOfflineAllocation,
  requestOfflineGrant,
} from '../src/data/offlineCapabilities';
import {
  OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
  OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
  OFFLINE_FREE_ALLOCATION_POLICY,
  OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
  OFFLINE_GRANT_AUDIENCE,
  OFFLINE_GRANT_JWS_TYPE,
  OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
} from '@pickle/shared-types';
import { createSqliteTestDb } from '../testSupport/sqlite';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER_OWNER = '22222222-2222-4222-8222-222222222222';
const INSTALLATION_KEY = 'ios-install-key-1';
const ISSUER = 'https://api.example.test/functions/v1/api';
const KEY_ID = 'offline-grant-key-1';
const GRANT_ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const ISSUED_AT = 1_800_000_000;
const EXPIRES_AT = ISSUED_AT + 6 * 24 * 60 * 60;
const TICKETS = [
  'aaaaaaaa-0000-4000-8000-000000000001',
  'aaaaaaaa-0000-4000-8000-000000000002',
];
const ARTIFACT = { version: 'v1', sha256: 'a'.repeat(64) };

function base64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function grantBody(
  overrides: { ownerId?: string; ticketIds?: string[] } = {},
): Record<string, unknown> {
  const ticketIds = overrides.ticketIds ?? TICKETS;
  const claims = {
    schemaVersion: OFFLINE_EXECUTION_GRANT_SCHEMA_VERSION,
    protocolVersion: OFFLINE_AUTHORIZATION_PROTOCOL_VERSION,
    iss: ISSUER,
    aud: OFFLINE_GRANT_AUDIENCE,
    sub: overrides.ownerId ?? OWNER,
    jti: GRANT_ID,
    installationKeyId: INSTALLATION_KEY,
    iat: ISSUED_AT,
    exp: EXPIRES_AT,
    capabilities: ['analyze_joint_output'],
    release: {
      policy: ARTIFACT,
      mechanicsModel: ARTIFACT,
      benchmarkModel: ARTIFACT,
    },
    entitlementSource: 'identity_lifetime_free',
    allocation: {
      schemaVersion: OFFLINE_FREE_ALLOCATION_SCHEMA_VERSION,
      allocationId: GRANT_ID,
      generation: 1,
      ticketIds,
      budgetPolicy: OFFLINE_FREE_ALLOCATION_POLICY.id,
      financialExpiry: 'reconciliation_only',
    },
  };
  const header = { alg: 'ES256', typ: OFFLINE_GRANT_JWS_TYPE, kid: KEY_ID };
  return {
    grantId: GRANT_ID,
    generation: 1,
    entitlementSource: 'identity_lifetime_free',
    issuedAt: ISSUED_AT,
    expiresAt: EXPIRES_AT,
    entitlementExpiresAt: null,
    ticketIds,
    keyId: KEY_ID,
    grant: {
      schemaVersion: OFFLINE_SIGNED_GRANT_SCHEMA_VERSION,
      compactJws: `${base64Url(JSON.stringify(header))}.${base64Url(
        JSON.stringify(claims),
      )}.${'A'.repeat(86)}`,
    },
  };
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

async function apiFailure(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the request to fail');
}

describe('W04-05 attack: network failure at every step', () => {
  let handle: ReturnType<typeof createSqliteTestDb>;
  let db: LocalDb;
  let fetchSpy: jest.SpyInstance;
  const client = () =>
    createOfflineGrantClient({ baseUrl: ISSUER, token: 'access-token' });
  const issue = () =>
    requestOfflineGrant(db, client(), {
      installationKeyId: INSTALLATION_KEY,
      requestedTickets: 2,
    });

  beforeEach(() => {
    setActiveDataOwner(OWNER);
    handle = createSqliteTestDb();
    db = handle.db;
    fetchSpy = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    jest.useRealTimers();
    handle.close();
    setActiveDataOwner(OWNER);
  });

  async function expectEmptyWallet(): Promise<void> {
    expect(handle.count('offline_grant', OWNER)).toBe(0);
    expect(handle.count('offline_receipt', OWNER)).toBe(0);
    const snapshot = await readOfflineAllocation(db, {
      authority: 'anchored',
      continuity: 'measured',
      nowMs: (ISSUED_AT + 60) * 1000,
      wallClockMs: (ISSUED_AT + 60) * 1000,
      rollbackDetected: false,
      storage: 'loaded',
    });
    expect(snapshot.grants).toEqual([]);
  }

  it('N1 a stalled issuance times out after the bounded deadline and holds nothing', async () => {
    jest.useFakeTimers();
    let aborted = false;
    fetchSpy.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('aborted'));
          });
        }),
    );
    const pending = apiFailure(issue());
    await jest.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_MS - 1);
    expect(aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(2);
    const error = await pending;
    expect(error).toMatchObject({ status: 408, code: 'network.timeout' });
    expect(aborted).toBe(true);
    jest.useRealTimers();
    await expectEmptyWallet();
  });

  it('N2 a 429 with Retry-After surfaces the server code and status, never a grant', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(
        429,
        {
          error: {
            code: 'rate_limited',
            message: 'Too many requests. Try again shortly.',
          },
        },
        { 'retry-after': '30' },
      ),
    );
    const error = await apiFailure(issue());
    expect(error).toMatchObject({ status: 429, code: 'rate_limited' });
    await expectEmptyWallet();
  });

  it('N3 a 429 without a structured envelope is still a retryable 429, not an unreadable answer', async () => {
    fetchSpy.mockResolvedValue(
      new Response('Too Many Requests', {
        status: 429,
        headers: { 'retry-after': '5', 'content-type': 'text/plain' },
      }),
    );
    const error = await apiFailure(issue());
    expect(error.status).toBe(429);
    expect(error.code).not.toBe('network.invalid_response');
    await expectEmptyWallet();
  });

  it('N4 5xx answers (generic and structured) are typed failures with no held grant', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('<html>Bad Gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      }),
    );
    const generic = await apiFailure(issue());
    expect(generic.status).toBe(502);
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(503, {
        error: { code: 'service_unavailable', message: 'Maintenance.' },
      }),
    );
    const structured = await apiFailure(issue());
    expect(structured).toMatchObject({
      status: 503,
      code: 'service_unavailable',
    });
    await expectEmptyWallet();
  });

  it('N5 a redirect is refused without following it and without a grant', async () => {
    fetchSpy.mockResolvedValue(
      Response.redirect('https://evil.example.test/v1/offline/grants', 302),
    );
    const error = await apiFailure(issue());
    expect(error).toMatchObject({ status: 502, code: 'network.redirected' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe('manual');
    await expectEmptyWallet();
  });

  it('N6 a 200 that carries a grant for another account is refused and held for nobody', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(200, grantBody({ ownerId: OTHER_OWNER })),
    );
    const error = await issue().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(OfflineGrantError);
    expect((error as OfflineGrantError).code).toBe('offline.grant_invalid');
    expect(handle.count('offline_grant', OTHER_OWNER)).toBe(0);
    await expectEmptyWallet();
  });

  it('N7 a 200 whose signed allocation exceeds the two-ticket policy is refused even though response and claims agree', async () => {
    const body = grantBody({
      ticketIds: [...TICKETS, 'aaaaaaaa-0000-4000-8000-000000000003'],
    });
    expect(parseIssuedOfflineGrant(body)).not.toBeNull();
    fetchSpy.mockResolvedValue(jsonResponse(200, body));
    const error = await issue().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(OfflineGrantError);
    expect((error as OfflineGrantError).code).toBe('offline.grant_invalid');
    await expectEmptyWallet();
  });

  it('N8 a 200 with an empty body, an array body, or an error envelope is an unreadable answer', async () => {
    const answers = [
      new Response(null, { status: 200 }),
      jsonResponse(200, []),
      jsonResponse(200, { error: { code: 'access.paywall_required' } }),
      jsonResponse(204, undefined),
    ];
    for (const answer of answers) {
      fetchSpy.mockResolvedValueOnce(answer);
      const error = await apiFailure(issue());
      expect(error).toMatchObject({
        status: 502,
        code: 'network.invalid_response',
      });
    }
    await expectEmptyWallet();
  });

  it('N9 a 401 surfaces as an auth failure and a missing bearer never reaches the network', async () => {
    fetchSpy.mockResolvedValue(
      jsonResponse(401, { error: { code: 'auth.invalid_token' } }),
    );
    const unauthorized = await apiFailure(issue());
    expect(unauthorized).toMatchObject({ status: 401 });
    fetchSpy.mockClear();
    const signedOut = createOfflineGrantClient({
      baseUrl: ISSUER,
      token: '  ',
    });
    const noToken = await apiFailure(
      signedOut.issueGrant({
        installationKeyId: INSTALLATION_KEY,
        requestedTickets: 2,
      }),
    );
    expect(noToken).toMatchObject({ status: 401, code: 'auth.required' });
    const noDevice = await apiFailure(
      signedOut.registerDevice({
        installationKeyId: INSTALLATION_KEY,
        attestationEnvironment: 'production',
      }),
    );
    expect(noDevice).toMatchObject({ status: 401, code: 'auth.required' });
    expect(fetchSpy).not.toHaveBeenCalled();
    await expectEmptyWallet();
  });

  it('N10 device registration: 409 environment conflict and malformed answers are typed, never a device', async () => {
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(409, {
        error: {
          code: 'offline.attestation_environment_mismatch',
          message: 'This installation is registered for another environment.',
        },
      }),
    );
    const conflict = await apiFailure(
      client().registerDevice({
        installationKeyId: INSTALLATION_KEY,
        attestationEnvironment: 'production',
      }),
    );
    expect(conflict).toMatchObject({
      status: 409,
      code: 'offline.attestation_environment_mismatch',
    });
    fetchSpy.mockResolvedValueOnce(
      jsonResponse(200, {
        device: {
          deviceId: 'dddddddd-0000-4000-8000-000000000001',
          installationKeyId: 'someone-elses-key',
          attestationEnvironment: 'production',
          attestationState: 'attested',
        },
      }),
    );
    const device = await client().registerDevice({
      installationKeyId: INSTALLATION_KEY,
      attestationEnvironment: 'production',
    });
    // The device answer is shape-checked only; the wallet binds the
    // installation key when it holds a grant, so a mismatched registration
    // answer must not be able to hold anything on its own.
    expect(device.installationKeyId).toBe('someone-elses-key');
    await expectEmptyWallet();
  });

  it('N11 a transport exception (DNS failure, connection reset) is rethrown untyped-but-unspent', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Network request failed'));
    const error = await issue().then(
      () => null,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(TypeError);
    await expectEmptyWallet();
  });
});
