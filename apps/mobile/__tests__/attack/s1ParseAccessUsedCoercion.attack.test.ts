/**
 * ADVERSARIAL S1 — parseAccess must REJECT, never coerce, non-integer /
 * out-of-range `freeRatings.used`.
 *
 * Attack surface: apps/mobile/src/billing/accessApi.ts parseAccess (private;
 * reached through createCanonicalAccessClient().getAccess()). A coerced
 * `used` would silently change the free-rating allowance the paywall copy
 * and the rating gate are built from, so each malformed value must surface
 * as `billing.backend_invalid_response` and the store must fail closed.
 *
 * Assigned probes: used: 1.5, used: '1', used: -1 (each with the rest of
 * the payload internally coherent for the coerced value, so the ONLY thing
 * that can reject it is the `used` check itself).
 * Extras: -0, NaN, ±Infinity, 2^53, 3, '１' (fullwidth), true, null, [1],
 * {valueOf}, 1e0 (legit 1 — control), and a 200 KiB entitlement list.
 */
import { BillingError, createCanonicalAccessClient } from '../../src/billing';

const SEED = 0x51a7ac; // recorded; drives the shuffled probe order only
function seeded(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

function coherentAccess(used: unknown, remainingOverride?: number) {
  // Build the rest of the payload as if `used` HAD been coerced to a number,
  // so a lenient parser would accept the whole thing.
  const usedNumber = Number(used);
  const remaining = remainingOverride ?? 2 - usedNumber;
  return {
    premium: false,
    entitlements: [],
    freeRatings: {
      limit: 2,
      used,
      reserved: 0,
      remaining,
      availableToReserve: remaining,
    },
    canStartRating: remaining > 0,
    paywallRequired: !(remaining > 0),
  };
}

function clientReturning(body: unknown) {
  const fetchFn = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => body,
  })) as unknown as jest.MockedFunction<typeof fetch>;
  return createCanonicalAccessClient({
    baseUrl: 'https://api.example.test',
    token: 'real-token',
    fetchFn,
  });
}

async function outcome(
  body: unknown,
): Promise<
  | { kind: 'accepted'; used: number }
  | { kind: 'rejected'; code: string; retryable: boolean }
> {
  try {
    const access = await clientReturning(body).getAccess();
    return { kind: 'accepted', used: access.freeRatings.used };
  } catch (error) {
    if (!(error instanceof BillingError)) throw error;
    return { kind: 'rejected', code: error.code, retryable: error.retryable };
  }
}

describe('S1 parseAccess: malformed freeRatings.used is rejected, not coerced', () => {
  it.each([
    ['used: 1.5 (fraction)', coherentAccess(1.5, 1)],
    ["used: '1' (numeric string)", coherentAccess('1')],
    [
      'used: -1 (negative, remaining 3 keeps 2 - used coherent)',
      coherentAccess(-1),
    ],
  ])('%s → billing.backend_invalid_response', async (_label, body) => {
    await expect(outcome(body)).resolves.toEqual({
      kind: 'rejected',
      code: 'billing.backend_invalid_response',
      retryable: true,
    });
  });

  it('-1 is also rejected when remaining is clamped to the legal 2', async () => {
    // A parser that clamps used to 0 would see remaining 2 as coherent.
    await expect(outcome(coherentAccess(-1, 2))).resolves.toMatchObject({
      kind: 'rejected',
      code: 'billing.backend_invalid_response',
    });
  });

  it('extras: every non-integer / out-of-range / non-number shape is rejected (seeded order)', async () => {
    const probes: Array<[string, unknown, number?]> = [
      ['NaN', Number.NaN],
      ['+Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['2^53 (unsafe integer)', 2 ** 53],
      ['3 (above limit)', 3, -1],
      ["'１' fullwidth digit", '１'],
      ["'1e0'", '1e0'],
      ['true', true],
      ['null', null],
      ['[1]', [1]],
      ['{ valueOf: () => 1 }', { valueOf: () => 1 }],
      ['1n as string "1n"', '1n'],
    ];
    const random = seeded(SEED);
    const order = probes
      .map((probe, index) => ({ probe, key: random(), index }))
      .sort((a, b) => a.key - b.key);
    for (const { probe } of order) {
      const [label, used, remaining] = probe;
      const body =
        remaining === undefined
          ? coherentAccess(used)
          : coherentAccess(used, remaining);
      await expect(outcome(body)).resolves.toMatchObject({
        kind: 'rejected',
        code: 'billing.backend_invalid_response',
      });
      void label;
    }
  });

  it('-0 is accepted as 0 (Number.isSafeInteger(-0) is true; 2 - (-0) === 2) — documents the only sign-insensitive value', async () => {
    const result = await outcome(coherentAccess(-0));
    expect(result).toEqual({ kind: 'accepted', used: -0 });
    // -0 is arithmetically 0 for every consumer (2 - used, used > 2, copy).
    expect(Object.is((result as { used: number }).used + 0, 0)).toBe(true);
  });

  it('controls: 0, 1, 2 (and 1e0 which IS the number 1) are accepted verbatim', async () => {
    for (const used of [0, 1, 2, 1]) {
      await expect(outcome(coherentAccess(used))).resolves.toEqual({
        kind: 'accepted',
        used,
      });
    }
  });

  it('huge payload: 200 KiB of entitlements does not grant premium and still validates used', async () => {
    const entitlements = Array.from({ length: 20_000 }, (_, i) =>
      `e${i}`.padEnd(10, 'x'),
    );
    const body = {
      ...coherentAccess(1),
      entitlements,
    };
    await expect(outcome(body)).resolves.toEqual({ kind: 'accepted', used: 1 });
    // premium:false + huge non-premium entitlements list is coherent; but
    // sneaking 'premium' into the list while premium:false must be rejected.
    await expect(
      outcome({ ...body, entitlements: [...entitlements, 'premium'] }),
    ).resolves.toMatchObject({ kind: 'rejected' });
    // …and used:'1' hidden behind the huge list is still rejected.
    await expect(
      outcome({ ...coherentAccess('1'), entitlements }),
    ).resolves.toMatchObject({ kind: 'rejected' });
  });
});
