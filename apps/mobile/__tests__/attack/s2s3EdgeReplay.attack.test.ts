/**
 * ADVERSARIAL S2 + S3 — mobile half. Replays GENUINE edge-function bytes
 * (recorded from the real handler by supabase/functions/api/__wf__/
 * attack_billing_pass3/record_fixture.ts, pinned against the live handler by
 * billing_sync_attack.test.ts) through the mobile billing client and store.
 *
 *   S2  The 11th /v1/billing/sync in a minute is a 429. The mobile client must
 *       map it to a RETRYABLE `billing.backend_unavailable`, the store must
 *       surface a retryable `billing.backend_verification_pending` card that
 *       points at Restore, keep operation 'idle', and the first ten recorded
 *       verdicts must parse to one identical CanonicalBillingSync.
 *   S3  expires_date === Date.now() exactly and 'not-a-date' both arrive as
 *       premium:false in `billing` AND `access`; the client's cross-check
 *       (billing.premium === access.premium) accepts them and the store ends
 *       non-premium. The +1 ms boundary control parses as premium.
 */
import {
  BillingError,
  createCanonicalAccessClient,
  type BillingStoreClient,
  type CanonicalBillingSync,
} from '../../src/billing';
import {
  clearAccessStoreConfiguration,
  configureAccessStore,
  useAccessStore,
} from '../../src/state/accessStore';

interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
interface Fixture {
  frozenNowMs: number;
  frozenNowIso: string;
  rateLimited: Recorded;
  firstTenVerdicts: unknown[];
  expiresExactlyNow: Recorded;
  expiresNotADate: Recorded;
  expiresNowPlusOneMs: Recorded;
}

// Genuine edge-handler bytes recorded by
// supabase/functions/api/__wf__/attack_billing_pass3/record_fixture.ts
import replay from '../../../../supabase/functions/api/__wf__/attack_billing_pass3/fixtures/billing_sync_replay.json';

const fixture = replay as unknown as Fixture;

function responseFrom(recorded: Recorded) {
  return {
    ok: recorded.status >= 200 && recorded.status < 300,
    status: recorded.status,
    headers: {
      get: (name: string) => recorded.headers[name.toLowerCase()] ?? null,
    },
    json: async () => recorded.body,
  };
}

function clientReplaying(sequence: Recorded[]) {
  let index = 0;
  const fetchFn = jest.fn(async () => {
    const next = sequence[Math.min(index, sequence.length - 1)];
    index += 1;
    return responseFrom(next as Recorded);
  }) as unknown as jest.MockedFunction<typeof fetch>;
  return {
    fetchFn,
    client: createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'real-token',
      fetchFn,
    }),
  };
}

const PLANS = {
  offeringId: 'default',
  annual: null,
  monthly: {
    id: '$rc_monthly',
    productId: 'pickle_sensei_pro_monthly',
    period: 'monthly' as const,
    price: 7.99,
    priceString: '$7.99',
    pricePerMonthString: '$7.99',
    freeTrial: null,
  },
  lifetime: null,
};

function store(): BillingStoreClient {
  return {
    configure: jest.fn(async () => undefined),
    loadPlans: jest.fn(async () => PLANS),
    purchase: jest.fn(async () => undefined),
    restore: jest.fn(async () => undefined),
  } as unknown as BillingStoreClient;
}

/** Ten verdicts were recorded with a fixed 2099 expiry, so they carry a
 * stable body the fixture pin re-verifies against the live handler. */
function tenVerdictResponses(): Recorded[] {
  return fixture.firstTenVerdicts.map(body => ({
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: {
      ...(body as Record<string, unknown>),
      billing: {
        ...(body as { billing: Record<string, unknown> }).billing,
        verifiedAt: '2026-09-04T12:00:00.000Z',
      },
    },
  }));
}

afterEach(() => {
  clearAccessStoreConfiguration();
});

describe('S2 mobile: the 11th sync (429 from the real handler) maps to retryable copy', () => {
  it('fixture sanity: recorded 11th response really is the edge 429', () => {
    expect(fixture.rateLimited.status).toBe(429);
    expect(fixture.rateLimited.body).toEqual({
      error: {
        code: 'rate_limited',
        message: 'Too many requests. Please slow down and try again shortly.',
      },
    });
    expect(Number(fixture.rateLimited.headers['retry-after'])).toBeGreaterThan(
      0,
    );
  });

  it('client: 429 → BillingError billing.backend_unavailable, retryable:true, user-safe copy', async () => {
    const { client } = clientReplaying([fixture.rateLimited]);
    let caught: unknown;
    try {
      await client.syncBilling();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BillingError);
    const error = caught as BillingError;
    expect(error.code).toBe('billing.backend_unavailable');
    expect(error.retryable).toBe(true);
    expect(error.message).toBe(
      'Membership verification is temporarily unavailable.',
    );
    expect(error.message).not.toMatch(/rate|429|slow down/i);
  });

  it('client: the first ten recorded verdicts parse to ONE identical CanonicalBillingSync', async () => {
    const { client } = clientReplaying(tenVerdictResponses());
    const parsed: CanonicalBillingSync[] = [];
    for (let i = 0; i < 10; i += 1) parsed.push(await client.syncBilling());
    expect(parsed).toHaveLength(10);
    for (const sync of parsed) expect(sync).toEqual(parsed[0]);
    expect(parsed[0]?.billing.premium).toBe(true);
    expect(parsed[0]?.access.premium).toBe(true);
    expect(parsed[0]?.access.canStartRating).toBe(true);
    expect(parsed[0]?.access.paywallRequired).toBe(false);
    expect(parsed[0]?.access.entitlements).toEqual(
      expect.arrayContaining(['pickle_sensei_pro']),
    );
  });

  it('store: 10 syncs stay premium, the 11th (429) yields a retryable pending card, no premium flip-flop', async () => {
    const sequence = [...tenVerdictResponses(), fixture.rateLimited];
    const { client } = clientReplaying(sequence);
    configureAccessStore({ store: store(), backend: client });
    const results: boolean[] = [];
    const premiumTrail: Array<boolean | null> = [];
    for (let i = 0; i < 11; i += 1) {
      results.push(await useAccessStore.getState().syncBilling());
      premiumTrail.push(
        useAccessStore.getState().canonicalAccess?.premium ?? null,
      );
    }
    expect(results.slice(0, 10)).toEqual(Array(10).fill(true));
    expect(premiumTrail.slice(0, 10)).toEqual(Array(10).fill(true));
    expect(results[10]).toBe(false);
    const state = useAccessStore.getState();
    expect(state.operation).toBe('idle');
    expect(state.status).toBe('error');
    expect(state.error).toEqual({
      code: 'billing.backend_verification_pending',
      message:
        'Your store status could not be verified yet. Try Restore purchases.',
      retryable: true,
      unconfiguredReason: undefined,
    });
    // Fails closed (no cached premium claim survives an unverifiable sync).
    expect(state.canonicalAccess).toBeNull();
  });

  it('store: rapid concurrent syncBilling() calls while one is in flight are dropped, not queued into the budget', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const fetchFn = jest.fn(async () => {
      await gate;
      return responseFrom(tenVerdictResponses()[0] as Recorded);
    }) as unknown as jest.MockedFunction<typeof fetch>;
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.example.test',
      token: 'real-token',
      fetchFn,
    });
    configureAccessStore({ store: store(), backend: client });
    const first = useAccessStore.getState().syncBilling();
    const burst = await Promise.all(
      Array.from({ length: 25 }, () => useAccessStore.getState().syncBilling()),
    );
    expect(burst).toEqual(Array(25).fill(false));
    release();
    expect(await first).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});

describe('S3 mobile: exact-now and not-a-date expiries arrive and stay premium:false', () => {
  it.each([
    ['expires_date === Date.now() exactly', fixture.expiresExactlyNow],
    ["expires_date 'not-a-date'", fixture.expiresNotADate],
  ])(
    '%s → client parses premium:false in billing AND access; store ends non-premium',
    async (_label, recorded) => {
      expect(recorded.status).toBe(200);
      const { client } = clientReplaying([recorded]);
      const sync = await client.syncBilling();
      expect(sync.billing.premium).toBe(false);
      expect(sync.billing.expiresAt).toBeNull();
      expect(sync.billing.productKey).toBeNull();
      expect(sync.access.premium).toBe(false);
      expect(sync.access.entitlements).toEqual([]);

      configureAccessStore({
        store: store(),
        backend: clientReplaying([recorded]).client,
      });
      expect(await useAccessStore.getState().syncBilling()).toBe(false);
      const state = useAccessStore.getState();
      expect(state.status).toBe('ready');
      expect(state.error).toBeNull();
      expect(state.canonicalAccess?.premium).toBe(false);
      expect(state.canonicalAccess?.canStartRating).toBe(true);
    },
  );

  it('boundary control: expires_date === Date.now() + 1 ms → premium:true (edge rule is strict >)', async () => {
    const { client } = clientReplaying([fixture.expiresNowPlusOneMs]);
    const sync = await client.syncBilling();
    expect(sync.billing.premium).toBe(true);
    expect(sync.billing.expiresAt).toBe(
      new Date(fixture.frozenNowMs + 1).toISOString(),
    );
    expect(sync.access.premium).toBe(true);
  });

  it('tamper control: a body with billing.premium:true but access.premium:false is rejected by the client cross-check', async () => {
    const good = fixture.expiresNowPlusOneMs;
    const body = good.body as {
      billing: Record<string, unknown>;
      access: Record<string, unknown>;
    };
    const tampered: Recorded = {
      ...good,
      body: {
        billing: body.billing,
        access: (fixture.expiresExactlyNow.body as { access: unknown }).access,
      },
    };
    const { client } = clientReplaying([tampered]);
    await expect(client.syncBilling()).rejects.toMatchObject({
      code: 'billing.backend_invalid_response',
    });
  });
});
