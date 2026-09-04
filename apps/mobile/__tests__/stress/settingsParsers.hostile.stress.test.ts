/**
 * Companion to settingsScreen.boundary-i18n-a11y.stress.test.tsx.
 *
 * The screen campaign injects hostile numerics (NaN, negative, > 2^53, minutes
 * past a day) straight into the Zustand stores and documents the garbage the
 * screen would render ("NaN free ratings left", "Daily · NaN:NaN AM"). Those
 * rows are classified parser-protected — this suite is the VERIFIED evidence
 * for that claim: every such payload is rejected by the wire/storage parsers
 * the real app goes through, so the garbage is unreachable in production.
 *
 * Replay: STRESS_SEED=<seed> npx jest __tests__/stress/settingsParsers.hostile.stress.test.ts
 */
import { createCanonicalAccessClient } from '../../src/billing/accessApi';
import { BillingError } from '../../src/billing/types';
import {
  DEFAULT_NOTIFICATION_PREFS,
  formatReminderMinutes,
  parseNotificationPrefs,
} from '../../src/notifications/types';
import {
  SeededRng,
  iterationSeed,
} from '../../__harness__/stress/settingsScreen/seededRng';

const STRESS_ITER = Number(process.env.STRESS_ITER ?? 40);
const STRESS_SEED = process.env.STRESS_SEED;
const CAMPAIGN_SEED = Number(process.env.STRESS_CAMPAIGN_SEED ?? 20260904);

const HOSTILE_NUMBERS: readonly unknown[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -1,
  -0.5,
  0.5,
  3,
  2 ** 53,
  Number.MAX_SAFE_INTEGER,
  Number.MAX_VALUE,
  '1',
  null,
  undefined,
  true,
  {},
  [],
];

function validAccess(): Record<string, unknown> {
  return {
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

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

const seeds = STRESS_SEED
  ? [Number(STRESS_SEED)]
  : Array.from({ length: STRESS_ITER }, (_, i) =>
      iterationSeed(CAMPAIGN_SEED, i),
    );

describe('hostile numerics never reach SettingsScreen (parser evidence)', () => {
  it('parseAccess: baseline valid ledger is accepted', async () => {
    const client = createCanonicalAccessClient({
      baseUrl: 'https://api.test',
      token: 't',
      fetchFn: async () => jsonResponse(validAccess()),
    });
    await expect(client.getAccess()).resolves.toMatchObject({
      freeRatings: { availableToReserve: 1 },
    });
  });

  it.each(seeds)(
    'seed %d: a mutated free-rating ledger is rejected as billing.backend_invalid_response',
    async seed => {
      const rng = new SeededRng(seed);
      const body = validAccess();
      const ledger = body.freeRatings as Record<string, unknown>;
      const field = rng.pick([
        'used',
        'reserved',
        'remaining',
        'availableToReserve',
        'limit',
      ] as const);
      const hostile = rng.pick(HOSTILE_NUMBERS);
      // `limit: 3` etc. is hostile for limit; for the others 3 breaks the
      // remaining === 2 - used / availableToReserve === remaining - reserved identities.
      ledger[field] = hostile;
      if (rng.chance(0.3)) {
        body.canStartRating = rng.pick([true, false, 'yes', 1, null]);
      }
      const client = createCanonicalAccessClient({
        baseUrl: 'https://api.test',
        token: 't',
        fetchFn: async () => jsonResponse(body),
      });
      let error: unknown = null;
      try {
        await client.getAccess();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(BillingError);
      expect((error as BillingError).code).toBe(
        'billing.backend_invalid_response',
      );
    },
  );

  it.each(seeds)(
    'seed %d: hostile practiceReminderMinutes falls back to the default',
    seed => {
      const rng = new SeededRng(seed);
      const inRangeMinute = (v: unknown): boolean =>
        typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1440;
      const hostile = rng.pick([
        ...HOSTILE_NUMBERS.filter(v => !inRangeMinute(v)),
        1440,
        1441,
        24 * 60 * 365,
        -1440,
        rng.int(1440, 2 ** 31),
        -rng.int(1, 2 ** 31),
        rng.next() * 1440,
      ]);
      const prefs = parseNotificationPrefs(
        JSON.stringify(
          { ...DEFAULT_NOTIFICATION_PREFS, practiceReminderMinutes: hostile },
          (_k, v) =>
            typeof v === 'number' && !Number.isFinite(v) ? String(v) : v,
        ),
      );
      expect(prefs.practiceReminderMinutes).toBe(
        DEFAULT_NOTIFICATION_PREFS.practiceReminderMinutes,
      );
      expect(formatReminderMinutes(prefs.practiceReminderMinutes)).toBe(
        '5:30 PM',
      );
    },
  );

  it.each(seeds)(
    'seed %d: formatReminderMinutes wraps any finite integer into a valid 12h clock',
    seed => {
      const rng = new SeededRng(seed);
      const minutes = rng.pick([
        0,
        1439,
        1440,
        -1,
        rng.int(-1e9, 1e9),
        2 ** 40,
      ]);
      expect(formatReminderMinutes(minutes)).toMatch(
        /^(1[0-2]|[1-9]):[0-5]\d (AM|PM)$/,
      );
    },
  );
});
