/**
 * Failure-injection harness for `src/state/accessStore.ts`.
 *
 * Faults are injected at the store's REAL external boundaries — the `fetch`
 * the canonical access client uses (`src/billing/accessApi.ts`) and the
 * RevenueCat SDK behind the store client (`src/billing/revenueCatClient.ts`)
 * — so the production parsers, error mapping and configuration checks sit
 * between the fault and the store exactly as they do on device. A second,
 * smaller "direct" seam wraps the resulting `BillingAccessDependencies` to
 * inject type-violating results the production clients could never produce
 * (defense-in-depth probes).
 *
 * Every fault has a stable id (`F..` fetch:getAccess, `S..` fetch:syncBilling,
 * `R..` RevenueCat SDK, `K..` client configuration, `D..` direct seam).
 * Behaviours: reject / throw synchronously / never settle / settle after a
 * delay (fake timers) / HTTP status / malformed or partial payload.
 *
 * Evidence: every scenario appends one NDJSON line to
 * `artifacts/stress/mod-access-store-failure-injection/<STRESS_RUN_ID>/` and
 * the suite writes a `<suite>.results.json` table (seed → outcome) so any
 * iteration can be replayed with `STRESS_SEED=<seed>`.
 */
import { createBillingAccessDependencies } from '../../src/billing';
import type {
  BillingAccessDependencies,
  BillingErrorCode,
  CanonicalAccessState,
  StorePlans,
} from '../../src/billing/types';
import type {
  RevenueCatCustomerInfoLike,
  RevenueCatPackageLike,
  RevenueCatSdk,
} from '../../src/billing/revenueCatClient';
import type { AccessStoreState } from '../../src/state/accessStore';
import {
  selectCanStartRating,
  selectHasPremium,
  selectPaywallRequired,
} from '../../src/state/accessStore';

// The mobile tsconfig excludes node typings; keep the sink shims local (same
// convention as testing/xcBehavioral/evidence.ts).
declare const require: (id: string) => unknown;
declare const __dirname: string;
declare const process: {
  env: Record<string, string | undefined>;
  memoryUsage(): { heapUsed: number; rss: number };
};
const fs = require('fs') as {
  mkdirSync: (dir: string, options: { recursive: boolean }) => void;
  appendFileSync: (file: string, data: string) => void;
  writeFileSync: (file: string, data: string) => void;
};
const path = require('path') as {
  resolve: (...parts: string[]) => string;
  join: (...parts: string[]) => string;
};

// ─── Seeded RNG ────────────────────────────────────────────────────────────

/** mulberry32 — deterministic, replayable from a 32-bit seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randomInt(random: () => number, min: number, max: number) {
  return min + Math.floor(random() * (max - min + 1));
}

export function pick<T>(random: () => number, items: readonly T[]): T {
  return items[Math.floor(random() * items.length)]!;
}

/** `STRESS_SEED` pins one seed (replay); otherwise `count` seeds derived
 * deterministically from the scenario name (so equal scale ⇒ equal seeds). */
export function scenarioSeeds(scenario: string, count: number): number[] {
  const pinned = process.env['STRESS_SEED'];
  if (pinned !== undefined && pinned !== '') return [Number(pinned)];
  let hash = 2166136261;
  for (const ch of scenario) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return Array.from({ length: count }, (_, i) => (hash + i * 7919) >>> 0);
}

export function stressIterations(defaultCount: number): number {
  const raw = process.env['STRESS_ITER'];
  const parsed = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : defaultCount;
}

// ─── Evidence sink ─────────────────────────────────────────────────────────

const RUN_ID = process.env['STRESS_RUN_ID'] ?? 'local';

export function evidenceDir(): string {
  // apps/mobile/testing/stress → repo root
  const root = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(
    root,
    'artifacts',
    'stress',
    'mod-access-store-failure-injection',
    RUN_ID,
  );
}

export interface ScenarioRecord {
  suite: string;
  scenario: string;
  seed: number;
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  violations: Violation[];
  knownBroken: string[];
  verdict: 'HELD' | 'BROKEN' | 'KNOWN_BROKEN';
  durationMs: number;
  heapUsedMb: number;
}

const tables = new Map<string, ScenarioRecord[]>();

export function appendRecord(record: ScenarioRecord): void {
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(
    path.join(dir, `${record.suite}.ndjson`),
    `${JSON.stringify(record)}\n`,
  );
  const rows = tables.get(record.suite) ?? [];
  rows.push(record);
  tables.set(record.suite, rows);
}

/** Writes the seed → outcome JSON table for a suite (call from afterAll). */
export function writeResultsTable(suite: string): string {
  const rows = tables.get(suite) ?? [];
  const dir = evidenceDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${suite}.results.json`);
  const byVerdict = { HELD: 0, BROKEN: 0, KNOWN_BROKEN: 0 };
  for (const row of rows) byVerdict[row.verdict] += 1;
  const faultsSeen = new Set<string>();
  for (const row of rows) {
    const faults = row.inputs['faults'];
    if (Array.isArray(faults))
      for (const f of faults) faultsSeen.add(String(f));
    const fault = row.inputs['fault'];
    if (typeof fault === 'string') faultsSeen.add(fault);
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        suite,
        runId: RUN_ID,
        scenariosExecuted: rows.length,
        byVerdict,
        distinctFaultsInjected: faultsSeen.size,
        rows,
      },
      null,
      2,
    ),
  );
  return file;
}

function mb(bytes: number): number {
  return Math.round((bytes / 1024 / 1024) * 100) / 100;
}

export async function recordScenario(
  suite: string,
  scenario: string,
  seed: number,
  inputs: Record<string, unknown>,
  body: () => Promise<{
    observed: Record<string, unknown>;
    violations: Violation[];
  }>,
): Promise<{ observed: Record<string, unknown>; violations: Violation[] }> {
  const started = Date.now();
  let observed: Record<string, unknown> = {};
  let violations: Violation[] = [];
  try {
    const result = await body();
    observed = result.observed;
    violations = result.violations;
    return result;
  } catch (error) {
    violations = [
      ...violations,
      {
        invariant: 'harness_threw',
        detail: error instanceof Error ? error.message : String(error),
      },
    ];
    throw error;
  } finally {
    const knownBroken = [
      ...new Set(
        violations.map(v => v.knownBrokenId).filter((v): v is string => !!v),
      ),
    ];
    const unexpected = violations.filter(v => !v.knownBrokenId);
    appendRecord({
      suite,
      scenario,
      seed,
      inputs,
      observed,
      violations,
      knownBroken,
      verdict:
        unexpected.length > 0
          ? 'BROKEN'
          : knownBroken.length > 0
            ? 'KNOWN_BROKEN'
            : 'HELD',
      durationMs: Date.now() - started,
      heapUsedMb: mb(process.memoryUsage().heapUsed),
    });
  }
}

// ─── Fault model ───────────────────────────────────────────────────────────

export type Seam =
  | 'fetch:getAccess'
  | 'fetch:syncBilling'
  | 'rc:isConfigured'
  | 'rc:configure'
  | 'rc:getAppUserID'
  | 'rc:logIn'
  | 'rc:getOfferings'
  | 'rc:purchasePackage'
  | 'rc:restorePurchases'
  | 'rc:checkTrial'
  | 'cfg:sdkKey'
  | 'cfg:canonicalId'
  | 'cfg:apiToken'
  | 'cfg:apiBaseUrl'
  | 'direct:getAccess'
  | 'direct:syncBilling'
  | 'direct:loadPlans'
  | 'direct:configure'
  | 'direct:purchase'
  | 'direct:restore';

export type Behaviour =
  | { kind: 'reject'; error: unknown }
  | { kind: 'throw'; error: unknown }
  | { kind: 'never' }
  | { kind: 'slow'; delayMs: number; then: Behaviour }
  | { kind: 'value'; value: unknown }
  /** The seam's healthy result (used as the tail of a `slow` behaviour). */
  | { kind: 'healthy' }
  /** Only for fetch seams: an HTTP response with this status and body. */
  | { kind: 'http'; status: number; body: unknown; nonJson?: boolean }
  /** Only for cfg seams: the configuration value to use. */
  | { kind: 'config'; value: string | null };

export interface Fault {
  id: string;
  seam: Seam;
  /** Which store operation exercises the seam in the deterministic sweep. */
  op: StoreOp;
  behaviour: Behaviour;
  /** True when the fault can never settle: the op is expected to hang. */
  hangs: boolean;
  describe: string;
}

export type StoreOp =
  | 'initialize'
  | 'refreshAccess'
  | 'syncBilling'
  | 'purchaseSelected'
  | 'restorePurchases';

export const STORE_OPS: readonly StoreOp[] = [
  'initialize',
  'refreshAccess',
  'syncBilling',
  'purchaseSelected',
  'restorePurchases',
];

export const KNOWN_CODES: readonly BillingErrorCode[] = [
  'billing.unconfigured',
  'billing.offerings_unavailable',
  'billing.purchase_cancelled',
  'billing.purchase_failed',
  'billing.restore_failed',
  'billing.backend_unconfigured',
  'billing.backend_unavailable',
  'billing.backend_invalid_response',
  'billing.backend_verification_pending',
];

export const CANONICAL_ID = '2f1c9a4e-7b3d-4c21-9e8f-0a1b2c3d4e5f';
export const BEARER = 'sb-access-token-SECRET-do-not-leak-7f3a9c';
export const SDK_KEY = 'appl_PUBLIC_test_key_0123456789';
export const BASE_URL = 'https://api.pickle.test';

export function serverAccess(
  premium: boolean,
  used: number,
  reserved = 0,
): CanonicalAccessState {
  const remaining = Math.max(0, 2 - used);
  const availableToReserve = remaining - reserved;
  const canStartRating = premium || availableToReserve > 0;
  return {
    premium,
    entitlements: premium ? ['premium', 'pickle_sensei_pro'] : [],
    freeRatings: { limit: 2, used, reserved, remaining, availableToReserve },
    canStartRating,
    paywallRequired: !canStartRating,
  };
}

export function serverBilling(premium: boolean) {
  return {
    premium,
    productKey: premium ? 'pickle_sensei_pro_yearly' : null,
    expiresAt: premium ? '2027-09-05T00:00:00.000Z' : null,
    verifiedAt: '2026-09-05T00:00:00.000Z',
  };
}

const NETWORK_ERROR = () => new TypeError('Network request failed');

function malformedAccess(
  mutate: (a: Record<string, unknown>) => void,
): Record<string, unknown> {
  const base = serverAccess(false, 1) as unknown as Record<string, unknown>;
  const copy: Record<string, unknown> = {
    ...base,
    freeRatings: { ...(base['freeRatings'] as Record<string, unknown>) },
  };
  mutate(copy);
  return copy;
}

function fr(a: Record<string, unknown>): Record<string, unknown> {
  return a['freeRatings'] as Record<string, unknown>;
}

const healthyPackage = (
  identifier: string,
  packageType: string,
  productId: string,
  price: number,
  intro = false,
): RevenueCatPackageLike => ({
  identifier,
  packageType,
  product: {
    identifier: productId,
    price,
    priceString: `$${price.toFixed(2)}`,
    pricePerMonthString: packageType === 'LIFETIME' ? null : '$5.00',
    introPrice: intro ? { price: 0, cycles: 1, period: 'P1W' } : null,
    defaultOption: null,
  },
});

export function healthyOffering(intro = false) {
  return {
    identifier: 'default',
    annual: healthyPackage(
      '$rc_annual',
      'ANNUAL',
      'pickle_sensei_pro_yearly',
      59.99,
      intro,
    ),
    monthly: healthyPackage(
      '$rc_monthly',
      'MONTHLY',
      'pickle_sensei_pro_monthly',
      7.99,
      intro,
    ),
    lifetime: healthyPackage(
      '$rc_lifetime',
      'LIFETIME',
      'pickle_sensei_pro_lifetime',
      159.99,
    ),
  };
}

export const premiumCustomerInfo: RevenueCatCustomerInfoLike = {
  entitlements: {
    active: {
      pickle_sensei_pro: {
        productIdentifier: 'pickle_sensei_pro_yearly',
        expirationDate: '2027-09-05T00:00:00.000Z',
      },
    },
  },
};

export const freeCustomerInfo: RevenueCatCustomerInfoLike = {
  entitlements: { active: {} },
};

const http = (status: number, body: unknown, nonJson = false): Behaviour => ({
  kind: 'http',
  status,
  body,
  nonJson,
});

/** The full catalogue. Ids are stable; never renumber. */
export const FAULT_CATALOG: readonly Fault[] = [
  // ── fetch: GET /v1/me/access ──────────────────────────────────────────
  f(
    'F01',
    'fetch:getAccess',
    'refreshAccess',
    { kind: 'reject', error: NETWORK_ERROR() },
    'fetch rejects (network)',
  ),
  f(
    'F02',
    'fetch:getAccess',
    'refreshAccess',
    { kind: 'throw', error: new Error('fetch threw synchronously') },
    'fetch throws synchronously',
  ),
  f(
    'F03',
    'fetch:getAccess',
    'refreshAccess',
    http(401, { error: 'unauthorized' }),
    'HTTP 401',
  ),
  f(
    'F04',
    'fetch:getAccess',
    'refreshAccess',
    http(403, { error: 'forbidden' }),
    'HTTP 403',
  ),
  f(
    'F05',
    'fetch:getAccess',
    'refreshAccess',
    http(404, { error: 'not found' }),
    'HTTP 404',
  ),
  f(
    'F06',
    'fetch:getAccess',
    'refreshAccess',
    http(429, { error: 'rate limited' }),
    'HTTP 429',
  ),
  f(
    'F07',
    'fetch:getAccess',
    'refreshAccess',
    http(500, { error: 'internal' }),
    'HTTP 500',
  ),
  f(
    'F08',
    'fetch:getAccess',
    'refreshAccess',
    http(503, { error: 'unavailable' }),
    'HTTP 503',
  ),
  f(
    'F09',
    'fetch:getAccess',
    'refreshAccess',
    http(200, '<html>gateway</html>', true),
    '200 non-JSON body',
  ),
  f(
    'F10',
    'fetch:getAccess',
    'refreshAccess',
    http(200, null),
    '200 JSON null',
  ),
  f(
    'F11',
    'fetch:getAccess',
    'refreshAccess',
    http(200, [1, 2, 3]),
    '200 JSON array',
  ),
  f(
    'F12',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => delete a['freeRatings']),
    ),
    '200 missing freeRatings',
  ),
  f(
    'F13',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (fr(a)['limit'] = 3)),
    ),
    '200 limit != 2',
  ),
  f(
    'F14',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => {
        fr(a)['used'] = 5;
        fr(a)['remaining'] = -3;
        fr(a)['availableToReserve'] = -3;
      }),
    ),
    '200 used > 2',
  ),
  f(
    'F15',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => {
        fr(a)['used'] = -1;
        fr(a)['remaining'] = 3;
        fr(a)['availableToReserve'] = 3;
      }),
    ),
    '200 used negative',
  ),
  f(
    'F16',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (fr(a)['remaining'] = 2)),
    ),
    '200 remaining != 2 - used',
  ),
  f(
    'F17',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (fr(a)['reserved'] = 2)),
    ),
    '200 reserved > remaining',
  ),
  f(
    'F18',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (fr(a)['availableToReserve'] = 2)),
    ),
    '200 availableToReserve inconsistent',
  ),
  f(
    'F19',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (a['premium'] = true)),
    ),
    '200 premium:true with no entitlement (fake premium)',
  ),
  f(
    'F20',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (a['canStartRating'] = false)),
    ),
    '200 canStartRating inconsistent',
  ),
  f(
    'F21',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (a['paywallRequired'] = true)),
    ),
    '200 paywallRequired inconsistent',
  ),
  f(
    'F22',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (fr(a)['used'] = '1')),
    ),
    '200 counts as strings',
  ),
  f(
    'F23',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => {
        fr(a)['used'] = 1.5;
        fr(a)['remaining'] = 0.5;
        fr(a)['availableToReserve'] = 0.5;
      }),
    ),
    '200 fractional counts',
  ),
  f(
    'F24',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (a['entitlements'] = [42])),
    ),
    '200 non-string entitlement',
  ),
  f(
    'F25',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => (a['premium'] = 'true')),
    ),
    '200 premium as string',
  ),
  f(
    'F26',
    'fetch:getAccess',
    'refreshAccess',
    http(
      200,
      malformedAccess(a => {
        a['premium'] = true;
        a['entitlements'] = ['pickle_sensei_pro'];
      }),
    ),
    '200 premium with only pickle_sensei_pro entitlement',
  ),
  f(
    'F27',
    'fetch:getAccess',
    'refreshAccess',
    { kind: 'never' },
    'fetch never settles',
    true,
  ),
  f(
    'F28',
    'fetch:getAccess',
    'refreshAccess',
    { kind: 'slow', delayMs: 45_000, then: { kind: 'healthy' } },
    'fetch settles OK after 45s',
  ),
  f(
    'F29',
    'fetch:getAccess',
    'refreshAccess',
    {
      kind: 'slow',
      delayMs: 30_000,
      then: { kind: 'reject', error: NETWORK_ERROR() },
    },
    'fetch rejects after 30s',
  ),
  f(
    'F30',
    'fetch:getAccess',
    'refreshAccess',
    http(200, {
      premium: false,
      entitlements: [],
      freeRatings: {
        limit: 2,
        used: 2,
        reserved: 0,
        remaining: 0,
        availableToReserve: 0,
      },
      canStartRating: false,
      paywallRequired: false,
    }),
    '200 exhausted but paywallRequired:false',
  ),
  f(
    'F31',
    'fetch:getAccess',
    'initialize',
    { kind: 'reject', error: NETWORK_ERROR() },
    'initialize: access fetch rejects',
  ),
  f(
    'F32',
    'fetch:getAccess',
    'initialize',
    http(503, { error: 'unavailable' }),
    'initialize: access HTTP 503',
  ),
  f(
    'F33',
    'fetch:getAccess',
    'initialize',
    { kind: 'never' },
    'initialize: access fetch never settles',
    true,
  ),
  f(
    'F34',
    'fetch:getAccess',
    'initialize',
    http(
      200,
      malformedAccess(a => (fr(a)['used'] = 9)),
    ),
    'initialize: access malformed',
  ),
  // ── fetch: POST /v1/billing/sync ──────────────────────────────────────
  f(
    'S01',
    'fetch:syncBilling',
    'syncBilling',
    { kind: 'reject', error: NETWORK_ERROR() },
    'sync fetch rejects',
  ),
  f(
    'S02',
    'fetch:syncBilling',
    'syncBilling',
    { kind: 'throw', error: new Error('fetch threw synchronously') },
    'sync fetch throws synchronously',
  ),
  f(
    'S03',
    'fetch:syncBilling',
    'syncBilling',
    http(401, { error: 'unauthorized' }),
    'sync HTTP 401',
  ),
  f(
    'S04',
    'fetch:syncBilling',
    'syncBilling',
    http(429, { error: 'rate limited' }),
    'sync HTTP 429',
  ),
  f(
    'S05',
    'fetch:syncBilling',
    'syncBilling',
    http(500, { error: 'internal' }),
    'sync HTTP 500',
  ),
  f(
    'S06',
    'fetch:syncBilling',
    'syncBilling',
    http(503, { error: 'unavailable' }),
    'sync HTTP 503',
  ),
  f(
    'S07',
    'fetch:syncBilling',
    'syncBilling',
    http(200, 'not json', true),
    'sync 200 non-JSON',
  ),
  f(
    'S08',
    'fetch:syncBilling',
    'syncBilling',
    http(200, null),
    'sync 200 JSON null',
  ),
  f(
    'S09',
    'fetch:syncBilling',
    'syncBilling',
    http(200, { access: serverAccess(true, 2) }),
    'sync 200 billing missing',
  ),
  f(
    'S10',
    'fetch:syncBilling',
    'syncBilling',
    http(200, { billing: serverBilling(true) }),
    'sync 200 access missing',
  ),
  f(
    'S11',
    'fetch:syncBilling',
    'syncBilling',
    http(200, { billing: serverBilling(true), access: serverAccess(false, 1) }),
    'sync 200 billing.premium != access.premium',
  ),
  f(
    'S12',
    'fetch:syncBilling',
    'syncBilling',
    http(200, {
      billing: { ...serverBilling(true), verifiedAt: 'yesterday' },
      access: serverAccess(true, 1),
    }),
    'sync 200 verifiedAt not ISO',
  ),
  f(
    'S13',
    'fetch:syncBilling',
    'syncBilling',
    http(200, {
      billing: { ...serverBilling(true), expiresAt: 'never' },
      access: serverAccess(true, 1),
    }),
    'sync 200 expiresAt malformed',
  ),
  f(
    'S14',
    'fetch:syncBilling',
    'syncBilling',
    http(200, {
      billing: { ...serverBilling(true), productKey: 12 },
      access: serverAccess(true, 1),
    }),
    'sync 200 productKey wrong type',
  ),
  f(
    'S15',
    'fetch:syncBilling',
    'syncBilling',
    http(200, {
      billing: serverBilling(true),
      access: malformedAccess(a => {
        a['premium'] = true;
        fr(a)['used'] = 7;
      }),
    }),
    'sync 200 access malformed',
  ),
  f(
    'S16',
    'fetch:syncBilling',
    'syncBilling',
    { kind: 'never' },
    'sync fetch never settles',
    true,
  ),
  f(
    'S17',
    'fetch:syncBilling',
    'syncBilling',
    { kind: 'slow', delayMs: 20_000, then: { kind: 'healthy' } },
    'sync settles after 20s',
  ),
  f(
    'S18',
    'fetch:syncBilling',
    'syncBilling',
    { kind: 'slow', delayMs: 59_000, then: { kind: 'healthy' } },
    'sync settles after 59s',
  ),
  f(
    'S19',
    'fetch:syncBilling',
    'syncBilling',
    {
      kind: 'slow',
      delayMs: 10_000,
      then: { kind: 'reject', error: NETWORK_ERROR() },
    },
    'sync rejects after 10s',
  ),
  f(
    'S20',
    'fetch:syncBilling',
    'purchaseSelected',
    { kind: 'reject', error: NETWORK_ERROR() },
    'purchase: sync rejects after store success',
  ),
  f(
    'S21',
    'fetch:syncBilling',
    'purchaseSelected',
    http(200, {
      billing: serverBilling(false),
      access: serverAccess(false, 1),
    }),
    'purchase: server says not premium after store success',
  ),
  f(
    'S22',
    'fetch:syncBilling',
    'purchaseSelected',
    { kind: 'never' },
    'purchase: sync never settles',
    true,
  ),
  f(
    'S23',
    'fetch:syncBilling',
    'purchaseSelected',
    http(200, { billing: serverBilling(true), access: serverAccess(false, 1) }),
    'purchase: sync premium mismatch',
  ),
  f(
    'S24',
    'fetch:syncBilling',
    'restorePurchases',
    { kind: 'reject', error: NETWORK_ERROR() },
    'restore: sync rejects',
  ),
  f(
    'S25',
    'fetch:syncBilling',
    'restorePurchases',
    http(200, {
      billing: serverBilling(false),
      access: serverAccess(false, 1),
    }),
    'restore: nothing to restore',
  ),
  f(
    'S26',
    'fetch:syncBilling',
    'restorePurchases',
    { kind: 'never' },
    'restore: sync never settles',
    true,
  ),
  f(
    'S27',
    'fetch:syncBilling',
    'restorePurchases',
    http(500, { error: 'internal' }),
    'restore: sync HTTP 500',
  ),
  // ── RevenueCat SDK ────────────────────────────────────────────────────
  f(
    'R01',
    'rc:isConfigured',
    'initialize',
    { kind: 'reject', error: new Error('RC bridge missing') },
    'isConfigured rejects',
  ),
  f(
    'R02',
    'rc:isConfigured',
    'initialize',
    { kind: 'throw', error: new Error('RC bridge threw') },
    'isConfigured throws synchronously',
  ),
  f(
    'R03',
    'rc:isConfigured',
    'initialize',
    { kind: 'never' },
    'isConfigured never settles',
    true,
  ),
  f(
    'R04',
    'rc:configure',
    'initialize',
    { kind: 'reject', error: new Error('configure failed') },
    'configure rejects',
  ),
  f(
    'R05',
    'rc:configure',
    'initialize',
    { kind: 'throw', error: new Error('configure threw') },
    'configure throws synchronously',
  ),
  f(
    'R06',
    'rc:configure',
    'initialize',
    { kind: 'never' },
    'configure never settles',
    true,
  ),
  f(
    'R07',
    'rc:getAppUserID',
    'initialize',
    { kind: 'value', value: 'someone-else' },
    'getAppUserID returns another account',
  ),
  f(
    'R08',
    'rc:getAppUserID',
    'initialize',
    { kind: 'reject', error: new Error('no app user id') },
    'getAppUserID rejects',
  ),
  f(
    'R09',
    'rc:logIn',
    'initialize',
    { kind: 'reject', error: new Error('logIn failed') },
    'logIn rejects (SDK already configured for another user)',
  ),
  f(
    'R10',
    'rc:getOfferings',
    'initialize',
    { kind: 'reject', error: new Error('offerings failed') },
    'getOfferings rejects',
  ),
  f(
    'R11',
    'rc:getOfferings',
    'initialize',
    { kind: 'throw', error: new Error('offerings threw') },
    'getOfferings throws synchronously',
  ),
  f(
    'R12',
    'rc:getOfferings',
    'initialize',
    { kind: 'never' },
    'getOfferings never settles',
    true,
  ),
  f(
    'R13',
    'rc:getOfferings',
    'initialize',
    { kind: 'value', value: { current: null } },
    'getOfferings current null',
  ),
  f(
    'R14',
    'rc:getOfferings',
    'initialize',
    {
      kind: 'value',
      value: {
        current: {
          identifier: 'default',
          annual: null,
          monthly: null,
          lifetime: null,
        },
      },
    },
    'getOfferings all packages null',
  ),
  f(
    'R15',
    'rc:getOfferings',
    'initialize',
    {
      kind: 'value',
      value: {
        current: {
          ...healthyOffering(),
          annual: healthyPackage('$rc_annual', 'MONTHLY', 'x', 1),
          monthly: healthyPackage('$rc_monthly', 'ANNUAL', 'y', 1),
          lifetime: healthyPackage('$rc_lifetime', 'CUSTOM', 'z', 1),
        },
      },
    },
    'getOfferings package types all mismatched',
  ),
  f(
    'R16',
    'rc:getOfferings',
    'initialize',
    {
      kind: 'value',
      value: {
        current: {
          ...healthyOffering(),
          annual: healthyPackage('$rc_annual', 'ANNUAL', 'a', Number.NaN),
          monthly: healthyPackage('$rc_monthly', 'MONTHLY', 'b', -1),
          lifetime: {
            ...healthyPackage('$rc_lifetime', 'LIFETIME', 'c', 1),
            product: {
              ...healthyPackage('$rc_lifetime', 'LIFETIME', 'c', 1).product,
              priceString: '',
            },
          },
        },
      },
    },
    'getOfferings prices NaN / negative / empty priceString',
  ),
  f(
    'R17',
    'rc:getOfferings',
    'initialize',
    { kind: 'slow', delayMs: 15_000, then: { kind: 'healthy' } },
    'getOfferings after 15s',
  ),
  f(
    'R18',
    'rc:getOfferings',
    'initialize',
    {
      kind: 'value',
      value: {
        current: { ...healthyOffering(), monthly: null, lifetime: null },
      },
    },
    'getOfferings only annual',
  ),
  f(
    'R19',
    'rc:getOfferings',
    'initialize',
    {
      kind: 'value',
      value: { current: { ...healthyOffering(), annual: null } },
    },
    'getOfferings annual missing',
  ),
  f(
    'R20',
    'rc:getOfferings',
    'initialize',
    {
      kind: 'value',
      value: {
        current: { ...healthyOffering(), annual: null, lifetime: null },
      },
    },
    'getOfferings only monthly',
  ),
  f(
    'R21',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'reject', error: new Error('StoreKit failed') },
    'purchasePackage rejects',
  ),
  f(
    'R22',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'reject', error: { userCancelled: true, message: 'cancelled' } },
    'purchasePackage user cancelled',
  ),
  f(
    'R23',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'reject', error: { code: '1', message: 'PURCHASE_CANCELLED' } },
    'purchasePackage cancelled (code 1)',
  ),
  f(
    'R24',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'throw', error: new Error('purchase threw') },
    'purchasePackage throws synchronously',
  ),
  f(
    'R25',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'never' },
    'purchasePackage never settles (StoreKit sheet hangs)',
    true,
  ),
  f(
    'R26',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'slow', delayMs: 40_000, then: { kind: 'healthy' } },
    'purchasePackage after 40s',
  ),
  f(
    'R27',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'value', value: { customerInfo: freeCustomerInfo } },
    'purchasePackage resolves without entitlement',
  ),
  f(
    'R28',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'value', value: { customerInfo: { entitlements: undefined } } },
    'purchasePackage malformed customerInfo',
  ),
  f(
    'R29',
    'rc:purchasePackage',
    'purchaseSelected',
    { kind: 'value', value: null },
    'purchasePackage resolves null',
  ),
  f(
    'R30',
    'rc:restorePurchases',
    'restorePurchases',
    { kind: 'reject', error: new Error('restore failed') },
    'restorePurchases rejects',
  ),
  f(
    'R31',
    'rc:restorePurchases',
    'restorePurchases',
    { kind: 'throw', error: new Error('restore threw') },
    'restorePurchases throws synchronously',
  ),
  f(
    'R32',
    'rc:restorePurchases',
    'restorePurchases',
    { kind: 'never' },
    'restorePurchases never settles',
    true,
  ),
  f(
    'R33',
    'rc:restorePurchases',
    'restorePurchases',
    { kind: 'slow', delayMs: 25_000, then: { kind: 'healthy' } },
    'restorePurchases after 25s',
  ),
  f(
    'R34',
    'rc:restorePurchases',
    'restorePurchases',
    { kind: 'value', value: { entitlements: null } },
    'restorePurchases malformed customerInfo',
  ),
  f(
    'R35',
    'rc:restorePurchases',
    'restorePurchases',
    { kind: 'value', value: freeCustomerInfo },
    'restorePurchases finds nothing',
  ),
  f(
    'R36',
    'rc:checkTrial',
    'initialize',
    { kind: 'reject', error: new Error('eligibility failed') },
    'trial eligibility rejects (intro-priced offering)',
  ),
  f(
    'R37',
    'rc:checkTrial',
    'initialize',
    { kind: 'never' },
    'trial eligibility never settles (intro-priced offering)',
    true,
  ),
  f(
    'R38',
    'rc:checkTrial',
    'initialize',
    { kind: 'value', value: {} },
    'trial eligibility empty map',
  ),
  f(
    'R39',
    'rc:checkTrial',
    'initialize',
    { kind: 'throw', error: new Error('eligibility threw') },
    'trial eligibility throws synchronously',
  ),
  f(
    'R40',
    'rc:getAppUserID',
    'initialize',
    { kind: 'never' },
    'getAppUserID never settles',
    true,
  ),
  // ── client configuration ──────────────────────────────────────────────
  f(
    'K01',
    'cfg:sdkKey',
    'initialize',
    { kind: 'config', value: null },
    'RevenueCat public SDK key missing',
  ),
  f(
    'K02',
    'cfg:sdkKey',
    'initialize',
    { kind: 'config', value: 'sk_SECRET_KEY_SHOULD_NEVER_BE_HERE' },
    'RevenueCat SECRET key supplied to client',
  ),
  f(
    'K03',
    'cfg:canonicalId',
    'initialize',
    { kind: 'config', value: '001234.abcdef.apple-subject' },
    'non-canonical (Apple subject) account id',
  ),
  f(
    'K04',
    'cfg:canonicalId',
    'initialize',
    { kind: 'config', value: '' },
    'canonical account id empty',
  ),
  f(
    'K05',
    'cfg:apiToken',
    'refreshAccess',
    { kind: 'config', value: null },
    'bearer token missing (signed out mid-flight)',
  ),
  f(
    'K06',
    'cfg:apiBaseUrl',
    'initialize',
    { kind: 'config', value: '' },
    'API base URL empty',
  ),
  f(
    'K07',
    'cfg:apiToken',
    'syncBilling',
    { kind: 'config', value: '   ' },
    'bearer token blank on sync',
  ),
  f(
    'K08',
    'cfg:apiToken',
    'initialize',
    { kind: 'config', value: null },
    'bearer token missing on initialize',
  ),
  // ── direct seam (type-violating dependency results) ───────────────────
  f(
    'D01',
    'direct:getAccess',
    'refreshAccess',
    { kind: 'value', value: undefined },
    'getAccess resolves undefined',
  ),
  f(
    'D02',
    'direct:getAccess',
    'refreshAccess',
    { kind: 'value', value: null },
    'getAccess resolves null',
  ),
  f(
    'D03',
    'direct:getAccess',
    'initialize',
    { kind: 'throw', error: new Error('sync throw') },
    'getAccess throws synchronously (non-async client)',
  ),
  f(
    'D04',
    'direct:loadPlans',
    'initialize',
    { kind: 'value', value: null },
    'loadPlans resolves null',
  ),
  f(
    'D05',
    'direct:loadPlans',
    'initialize',
    { kind: 'value', value: { offeringId: 'x' } },
    'loadPlans resolves partial plans',
  ),
  f(
    'D06',
    'direct:loadPlans',
    'initialize',
    { kind: 'throw', error: new Error('sync throw') },
    'loadPlans throws synchronously',
  ),
  f(
    'D07',
    'direct:syncBilling',
    'syncBilling',
    { kind: 'value', value: {} },
    'syncBilling resolves {} (no access)',
  ),
  f(
    'D08',
    'direct:syncBilling',
    'purchaseSelected',
    { kind: 'value', value: { access: null } },
    'purchase: syncBilling resolves access:null',
  ),
  f(
    'D09',
    'direct:syncBilling',
    'restorePurchases',
    { kind: 'throw', error: new Error('sync throw') },
    'restore: syncBilling throws synchronously',
  ),
  f(
    'D10',
    'direct:configure',
    'initialize',
    { kind: 'throw', error: new Error('sync throw') },
    'store.configure throws synchronously',
  ),
  f(
    'D11',
    'direct:purchase',
    'purchaseSelected',
    { kind: 'throw', error: new Error('sync throw') },
    'store.purchase throws synchronously',
  ),
  f(
    'D12',
    'direct:restore',
    'restorePurchases',
    { kind: 'throw', error: new Error('sync throw') },
    'store.restore throws synchronously',
  ),
  f(
    'D13',
    'direct:getAccess',
    'initialize',
    { kind: 'value', value: undefined },
    'initialize: getAccess resolves undefined',
  ),
  f(
    'D14',
    'direct:syncBilling',
    'syncBilling',
    { kind: 'throw', error: new Error('sync throw') },
    'syncBilling throws synchronously',
  ),
];

function f(
  id: string,
  seam: Seam,
  op: StoreOp,
  behaviour: Behaviour,
  describe: string,
  hangs = false,
): Fault {
  return { id, seam, op, behaviour, hangs, describe };
}

export const FAULTS_BY_ID: ReadonlyMap<string, Fault> = new Map(
  FAULT_CATALOG.map(fault => [fault.id, fault]),
);

// ─── Environment builder ───────────────────────────────────────────────────

export interface CallLog {
  seam: Seam;
  faultId: string | null;
  at: number;
}

export interface Environment {
  deps: BillingAccessDependencies;
  calls: CallLog[];
  /** Every well-formed access snapshot the server served, in settle order;
   * `seq` is the request order, so a lower `seq` landing later is stale. */
  servedAccess: ServedAccess[];
  /** True once the server served a well-formed premium snapshot. */
  servedPremium: () => boolean;
  /** Faults are consumed only after `arm()` (lets a scenario warm up). */
  arm: () => void;
  /** Resolves every pending "never" behaviour with the healthy result. */
  release: () => void;
  countCalls: (seam: Seam) => number;
  /** Highest number of simultaneously in-flight calls observed per seam. */
  maxInFlight: (seam: Seam) => number;
  /** Mutable server truth: what GET /v1/me/access returns when healthy. */
  server: { access: CanonicalAccessState; syncPremium: boolean };
}

export interface EnvironmentOptions {
  /** Faults by seam; a seam may have a queue of faults consumed per call. */
  faults: ReadonlyMap<Seam, readonly Fault[]>;
  /** Server truth at the start of the scenario. */
  access: CanonicalAccessState;
  /** Whether the server verifies premium on POST /v1/billing/sync. */
  syncPremium: boolean;
  /** Offering with introductory pricing (exercises the trial-eligibility seam). */
  introOffering?: boolean;
  /** RevenueCat SDK reports already configured (for another user). */
  sdkPreconfiguredFor?: string | null;
  /** Start armed (default false: faults wait for `arm()`). */
  armed?: boolean;
}

interface FakeResponse extends Response {
  __body: unknown;
}

function fakeResponse(
  status: number,
  body: unknown,
  nonJson: boolean,
): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    __body: nonJson ? undefined : body,
    json: () =>
      nonJson
        ? Promise.reject(new SyntaxError('Unexpected token <'))
        : Promise.resolve(body),
  } as unknown as FakeResponse;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Independent re-statement of the canonical access contract (mirrors the
 * rules in src/billing/accessApi.ts without importing them, so a parser bug
 * cannot hide itself).
 */
export function isConsistentAccess(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const {
    premium,
    entitlements,
    freeRatings,
    canStartRating,
    paywallRequired,
  } = value;
  if (typeof premium !== 'boolean') return false;
  if (!Array.isArray(entitlements)) return false;
  if (!entitlements.every(e => typeof e === 'string')) return false;
  if (!isRecord(freeRatings)) return false;
  const { limit, used, reserved, remaining, availableToReserve } = freeRatings;
  const ints = [limit, used, reserved, remaining, availableToReserve];
  if (!ints.every(n => typeof n === 'number' && Number.isSafeInteger(n))) {
    return false;
  }
  if (limit !== 2) return false;
  if ((used as number) < 0 || (used as number) > 2) return false;
  if ((reserved as number) < 0) return false;
  if (remaining !== 2 - (used as number)) return false;
  if ((reserved as number) > (remaining as number)) return false;
  if (availableToReserve !== (remaining as number) - (reserved as number)) {
    return false;
  }
  const hasPremiumEntitlement =
    entitlements.includes('premium') ||
    entitlements.includes('pickle_sensei_pro');
  if (premium !== hasPremiumEntitlement) return false;
  const expectedCanStart = premium || (availableToReserve as number) > 0;
  if (canStartRating !== expectedCanStart) return false;
  if (paywallRequired !== !expectedCanStart) return false;
  return true;
}

export interface ServedAccess {
  seq: number;
  access: CanonicalAccessState;
}

export function buildEnvironment(options: EnvironmentOptions): Environment {
  const calls: CallLog[] = [];
  const servedAccess: ServedAccess[] = [];
  let requestSeq = 0;
  const queues = new Map<Seam, Fault[]>();
  for (const [seam, faults] of options.faults) queues.set(seam, [...faults]);
  const releases: Array<() => void> = [];
  let released = false;
  const inFlight = new Map<Seam, number>();
  const maxInFlight = new Map<Seam, number>();
  const server = { access: options.access, syncPremium: options.syncPremium };
  let armed = options.armed === true;
  let premiumServed = false;
  let sdkConfigured = options.sdkPreconfiguredFor != null;
  let sdkUser: string | null = options.sdkPreconfiguredFor ?? null;

  const serve = (seq: number, body: unknown) => {
    if (isConsistentAccess(body)) {
      servedAccess.push({ seq, access: body as CanonicalAccessState });
      if ((body as CanonicalAccessState).premium) premiumServed = true;
    }
  };

  /** Construction-time config seams read their fault immediately; the token
   * getter (read per request) honours arming like every other seam. */
  const configValue = (
    seam: Seam,
    healthy: string | null,
    perRequest: boolean,
  ): string | null => {
    const fault = queues.get(seam)?.[0];
    if (fault && fault.behaviour.kind === 'config' && (!perRequest || armed)) {
      return fault.behaviour.value;
    }
    return healthy;
  };

  const enter = (seam: Seam) => {
    const current = (inFlight.get(seam) ?? 0) + 1;
    inFlight.set(seam, current);
    maxInFlight.set(seam, Math.max(maxInFlight.get(seam) ?? 0, current));
  };
  const leave = (seam: Seam) => {
    inFlight.set(seam, (inFlight.get(seam) ?? 1) - 1);
  };

  /** Applies the next queued fault for `seam` or the healthy behaviour. */
  function drive<T>(seam: Seam, healthy: () => T): Promise<T> | T {
    const queue = queues.get(seam);
    const fault = armed && queue && queue.length > 0 ? queue.shift()! : null;
    calls.push({ seam, faultId: fault?.id ?? null, at: Date.now() });
    enter(seam);
    let result: unknown;
    try {
      result = fault ? run(fault.behaviour, healthy) : healthy();
    } catch (error) {
      leave(seam);
      throw error;
    }
    if (result instanceof Promise) {
      return result.then(
        value => {
          leave(seam);
          return value as T;
        },
        error => {
          leave(seam);
          throw error;
        },
      );
    }
    leave(seam);
    return result as T;
  }

  function run(behaviour: Behaviour, healthy: () => unknown): unknown {
    switch (behaviour.kind) {
      case 'throw':
        throw behaviour.error;
      case 'reject':
        return Promise.reject(behaviour.error);
      case 'never':
        // Once released, a hang that is only reached through another released
        // hang (purchase → sync) answers healthily instead of re-hanging.
        if (released) return Promise.resolve(healthyFallback(healthy));
        return new Promise<unknown>(resolve => {
          releases.push(() => resolve(healthyFallback(healthy)));
        });
      case 'slow':
        return new Promise<unknown>((resolve, reject) => {
          setTimeout(() => {
            try {
              const next = run(behaviour.then, healthy);
              if (next instanceof Promise) next.then(resolve, reject);
              else resolve(next);
            } catch (error) {
              reject(error);
            }
          }, behaviour.delayMs);
        });
      case 'value':
        return Promise.resolve(behaviour.value);
      case 'healthy':
        return healthy();
      case 'http':
        return Promise.resolve(
          fakeResponse(behaviour.status, behaviour.body, !!behaviour.nonJson),
        );
      case 'config':
        return healthy();
    }
  }

  function healthyFallback(healthy: () => unknown): unknown {
    try {
      return healthy();
    } catch {
      return undefined;
    }
  }

  const served = (
    seam: 'fetch:getAccess' | 'fetch:syncBilling',
    seq: number,
    response: Response,
  ) => {
    const body = (response as FakeResponse).__body;
    if (response.status !== 200) return;
    if (seam === 'fetch:getAccess') serve(seq, body);
    else if (isRecord(body)) serve(seq, body['access']);
  };

  const fetchFn = (input: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    if (method === 'GET' && input.endsWith('/v1/me/access')) {
      // A real server answers with the truth at request time, however late
      // the answer lands — that is what makes a slow answer stale.
      const requested = server.access;
      requestSeq += 1;
      const seq = requestSeq;
      return Promise.resolve(
        drive('fetch:getAccess', () => fakeResponse(200, requested, false)),
      ).then(response => {
        served('fetch:getAccess', seq, response);
        return response;
      });
    }
    if (method === 'POST' && input.endsWith('/v1/billing/sync')) {
      const premium = server.syncPremium;
      requestSeq += 1;
      const seq = requestSeq;
      const access = serverAccess(
        premium,
        server.access.freeRatings.used,
        server.access.freeRatings.reserved,
      );
      return Promise.resolve(
        drive('fetch:syncBilling', () => {
          server.access = access;
          return fakeResponse(
            200,
            { billing: serverBilling(premium), access },
            false,
          );
        }),
      ).then(response => {
        served('fetch:syncBilling', seq, response);
        return response;
      });
    }
    return Promise.resolve(
      fakeResponse(404, { error: 'unknown route' }, false),
    );
  };

  const sdk: RevenueCatSdk = {
    isConfigured: () =>
      Promise.resolve(drive('rc:isConfigured', () => sdkConfigured)),
    configure: configuration =>
      drive('rc:configure', () => {
        sdkConfigured = true;
        sdkUser = configuration.appUserID;
        return undefined;
      }) as void | Promise<void>,
    getAppUserID: () =>
      Promise.resolve(drive('rc:getAppUserID', () => sdkUser ?? '')),
    logIn: appUserID =>
      Promise.resolve(
        drive('rc:logIn', () => {
          sdkUser = appUserID;
          return { customerInfo: freeCustomerInfo };
        }),
      ),
    getOfferings: () =>
      Promise.resolve(
        drive('rc:getOfferings', () => ({
          current: healthyOffering(!!options.introOffering),
        })),
      ),
    purchasePackage: () =>
      Promise.resolve(
        drive('rc:purchasePackage', () => ({
          customerInfo: premiumCustomerInfo,
        })),
      ),
    restorePurchases: () =>
      Promise.resolve(drive('rc:restorePurchases', () => premiumCustomerInfo)),
    getCustomerInfo: () => Promise.resolve(freeCustomerInfo),
    checkTrialOrIntroductoryPriceEligibility: ids =>
      Promise.resolve(
        drive('rc:checkTrial', () =>
          Object.fromEntries(ids.map(id => [id, { status: 2 }])),
        ),
      ),
  };

  const realDeps = createBillingAccessDependencies({
    revenueCatPublicSdkKey: configValue('cfg:sdkKey', SDK_KEY, false),
    canonicalAppUserId: configValue('cfg:canonicalId', CANONICAL_ID, false),
    apiBaseUrl: configValue('cfg:apiBaseUrl', BASE_URL, false),
    get apiToken() {
      return configValue('cfg:apiToken', BEARER, true);
    },
    fetchFn,
    revenueCatSdk: sdk,
    platform: 'ios',
  });

  // Direct seam: type-violating results bypassing the production parsers.
  const direct = <T>(seam: Seam, real: () => Promise<T>): Promise<T> => {
    const queue = queues.get(seam);
    if (!armed || !queue || queue.length === 0) return real();
    const fault = queue.shift()!;
    calls.push({ seam, faultId: fault.id, at: Date.now() });
    return run(fault.behaviour, () => undefined) as Promise<T>;
  };
  const deps: BillingAccessDependencies = {
    store: {
      configure: () => direct('direct:configure', realDeps.store.configure),
      loadPlans: () => direct('direct:loadPlans', realDeps.store.loadPlans),
      purchase: planId =>
        direct('direct:purchase', () => realDeps.store.purchase(planId)),
      restore: () => direct('direct:restore', realDeps.store.restore),
      readEntitlement: realDeps.store.readEntitlement,
    },
    backend: {
      getAccess: () => direct('direct:getAccess', realDeps.backend.getAccess),
      syncBilling: () =>
        direct('direct:syncBilling', realDeps.backend.syncBilling),
    },
  };

  return {
    deps,
    calls,
    servedAccess,
    servedPremium: () => premiumServed,
    arm: () => {
      armed = true;
    },
    release: () => {
      released = true;
      for (const r of releases.splice(0)) r();
    },
    countCalls: seam => calls.filter(c => c.seam === seam).length,
    maxInFlight: seam => maxInFlight.get(seam) ?? 0,
    server,
  };
}

// ─── Invariants ────────────────────────────────────────────────────────────

export interface Violation {
  invariant: string;
  detail: string;
  /** Set when the violation matches a pinned, already-reported finding. */
  knownBrokenId?: string;
}

export const KB = {
  /** No deadline on any store/backend call: a never-settling dependency
   * leaves status=loading / operation busy forever with no retry control. */
  noDeadline: 'KB1-no-deadline-infinite-loading',
  /** initialize() unconditionally writes operation:'idle' when it settles,
   * erasing an in-flight purchase/restore/sync flag. */
  initializeClearsOperation: 'KB2-initialize-clears-inflight-operation',
  /** Direct seam only: a dependency resolving `undefined`/`null` is stored
   * as-is (undefined breaks the selectors; null is a silent failure). */
  undefinedSnapshot: 'KB3-nullish-snapshot-stored',
  /** Direct seam only: a synchronously-throwing dependency rejects the op. */
  syncThrowRejects: 'KB4-sync-throwing-dependency-rejects-op',
  /** Direct seam only: type-violating plans object stored as-is. */
  directPlans: 'KB5-direct-malformed-plans-stored',
  /** Overlapping snapshot writers (refresh/initialize/sync/purchase/restore)
   * are only fenced per configuration version, not per request: the older
   * server answer can land (or be written by initialize, which holds its
   * access result until plans resolve) after a newer one and win. */
  staleSnapshotWins: 'KB6-older-access-snapshot-overwrites-newer',
  /** A cancelled purchase writes `error: null`, erasing the error a
   * concurrently failed refresh/initialize just surfaced (status stays
   * 'error'). */
  cancelClearsError: 'KB7-purchase-cancel-clears-concurrent-error',
  /** reset() sets `operation: 'idle'` while a store purchase/restore is
   * still awaiting StoreKit, so a second tap reaches the store concurrently. */
  resetClearsOperation: 'KB8-reset-clears-inflight-operation',
} as const;

/** Mirrors PaywallScreen's `showRetry` (src/screens/PaywallScreen.tsx). */
export function paywallShowsRetry(state: AccessStoreState): boolean {
  return (
    state.status !== 'loading' &&
    (!state.plans || state.canonicalAccess === null)
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function selectedPlanOf(plans: StorePlans | null, period: string) {
  if (!plans) return null;
  if (period === 'annual') return plans.annual;
  if (period === 'monthly') return plans.monthly;
  if (period === 'lifetime') return plans.lifetime;
  return null;
}

export interface SettledOp {
  op: StoreOp;
  settled: boolean;
  result: boolean | undefined | 'rejected';
  rejection?: string;
  /** Configuration cut (reset/clear/reconfigure) happened while pending. */
  cutWhilePending: boolean;
  /** Which cut hit this op first (reset keeps the dependencies). */
  cutBy?: 'reset' | 'clear' | 'reconfigure';
}

export interface TerminalOptions {
  /** Ids of armed faults that never settle (hang is then KNOWN_BROKEN KB1). */
  hungFaults: string[];
  /** Armed direct-seam faults (type violations → KB3/KB4/KB5). */
  directFaults: Fault[];
  /** True when initialize() ran concurrently with a purchase/restore/sync. */
  initializeOverlappedOperation: boolean;
  /** True when two snapshot-writing ops were ever in flight together. */
  opsOverlapped: boolean;
  /** The user dismissed the error card (clearError) after the last op; the
   * error was shown, so a null error afterwards is not a silent failure. */
  userClearedError: boolean;
  /** A cancelled purchase overlapped another op (KB7 attribution). */
  purchaseCancelOverlapped: boolean;
  /** reset() cut a pending purchase/restore and the same action was started
   * again while the cut call was still in flight (KB8 attribution). */
  resetOverlappedOperation: boolean;
}

/** Checks the store's state after a scenario settled (or after 60s). */
export function checkTerminalInvariants(
  state: AccessStoreState,
  env: Environment,
  ops: SettledOp[],
  options: TerminalOptions,
): Violation[] {
  const violations: Violation[] = [];
  const anyPending = ops.some(o => !o.settled);
  const direct = options.directFaults.length > 0;
  const directSyncThrow = options.directFaults.some(
    f => f.behaviour.kind === 'throw',
  );
  const directNullSnapshot = options.directFaults.some(
    f =>
      f.seam === 'direct:getAccess' &&
      f.behaviour.kind === 'value' &&
      f.behaviour.value == null,
  );
  // A rejected op under a synchronously-throwing direct dependency leaves
  // the store wherever it was; every consequence belongs to that one finding.
  const rejectedUnderDirectThrow =
    directSyncThrow && ops.some(o => o.result === 'rejected');
  const kbRejected = rejectedUnderDirectThrow
    ? { knownBrokenId: KB.syncThrowRejects }
    : {};

  for (const op of ops) {
    if (op.result === 'rejected') {
      violations.push({
        invariant: 'store_method_never_rejects',
        detail: `${op.op}() rejected: ${op.rejection ?? ''}`,
        ...(directSyncThrow ? { knownBrokenId: KB.syncThrowRejects } : {}),
      });
    }
  }

  if (anyPending) {
    const pendingOps = ops.filter(o => !o.settled).map(o => o.op);
    violations.push({
      invariant: 'no_infinite_spinner_60s',
      detail: `ops still pending after 60s: ${pendingOps.join(',')} status=${state.status} operation=${state.operation} showRetry=${paywallShowsRetry(state)}`,
      ...(options.hungFaults.length > 0
        ? { knownBrokenId: KB.noDeadline }
        : {}),
    });
  } else {
    if (state.status === 'loading') {
      violations.push({
        invariant: 'terminal_status_not_loading',
        detail: 'status=loading after every op settled',
        ...kbRejected,
      });
    }
    if (state.operation !== 'idle') {
      violations.push({
        invariant: 'terminal_operation_idle',
        detail: `operation=${state.operation} after every op settled`,
        ...kbRejected,
      });
    }
  }

  let premium = false;
  try {
    premium = selectHasPremium(state);
    selectCanStartRating(state);
    selectPaywallRequired(state);
  } catch (error) {
    violations.push({
      invariant: 'selectors_never_throw',
      detail: `selector threw: ${error instanceof Error ? error.message : String(error)}`,
      ...(direct ? { knownBrokenId: KB.undefinedSnapshot } : {}),
    });
  }
  if (premium && !env.servedPremium()) {
    violations.push({
      invariant: 'no_fake_premium',
      detail: 'store reports premium but the server never served premium',
    });
  }

  if (state.canonicalAccess !== null) {
    if (!isConsistentAccess(state.canonicalAccess)) {
      violations.push({
        invariant: 'snapshot_internally_consistent',
        detail: `canonicalAccess=${JSON.stringify(state.canonicalAccess)}`,
        ...(direct && state.canonicalAccess === undefined
          ? { knownBrokenId: KB.undefinedSnapshot }
          : {}),
      });
    } else if (
      !env.servedAccess.some(served =>
        deepEqual(served.access, state.canonicalAccess),
      )
    ) {
      violations.push({
        invariant: 'snapshot_is_server_value_or_null',
        detail: `canonicalAccess=${JSON.stringify(state.canonicalAccess)}`,
      });
    } else {
      const newest = env.servedAccess.reduce((best, served) =>
        served.seq > best.seq ? served : best,
      );
      const landedOutOfOrder = env.servedAccess.some(
        (served, index) =>
          index > 0 && served.seq < env.servedAccess[index - 1]!.seq,
      );
      if (!deepEqual(newest.access, state.canonicalAccess)) {
        violations.push({
          invariant: 'newest_requested_snapshot_wins',
          detail: `canonicalAccess=${JSON.stringify(state.canonicalAccess)} newestRequested(seq=${newest.seq})=${JSON.stringify(newest.access)} landedOutOfOrder=${landedOutOfOrder} opsOverlapped=${options.opsOverlapped}`,
          ...(landedOutOfOrder || options.opsOverlapped
            ? { knownBrokenId: KB.staleSnapshotWins }
            : {}),
        });
      }
    }
  }

  if (state.plans) {
    const plan = selectedPlanOf(state.plans, state.selectedPeriod);
    const anyPlan =
      state.plans.annual || state.plans.monthly || state.plans.lifetime;
    if (anyPlan && !plan) {
      violations.push({
        invariant: 'selected_period_has_plan',
        detail: `selectedPeriod=${state.selectedPeriod} plans=${JSON.stringify(state.plans)}`,
      });
    }
    if (!anyPlan) {
      violations.push({
        invariant: 'plans_never_empty',
        detail: `plans=${JSON.stringify(state.plans)}`,
        ...(direct ? { knownBrokenId: KB.directPlans } : {}),
      });
    }
  }

  if (state.error) {
    if (!KNOWN_CODES.includes(state.error.code)) {
      violations.push({
        invariant: 'error_code_known',
        detail: `code=${String(state.error.code)}`,
      });
    }
    if (typeof state.error.retryable !== 'boolean') {
      violations.push({
        invariant: 'error_retryable_boolean',
        detail: `retryable=${String(state.error.retryable)}`,
      });
    }
    if (
      typeof state.error.message !== 'string' ||
      state.error.message.trim() === ''
    ) {
      violations.push({
        invariant: 'error_message_present',
        detail: `message=${String(state.error.message)}`,
      });
    }
  }
  const blob = JSON.stringify(state);
  if (blob.includes(BEARER) || blob.includes('sk_SECRET')) {
    violations.push({
      invariant: 'no_secret_in_state',
      detail: 'bearer token or secret key string found in store state',
    });
  }

  if (
    !anyPending &&
    state.canonicalAccess === null &&
    state.status !== 'idle' &&
    state.error === null &&
    !options.userClearedError
  ) {
    violations.push({
      invariant: 'no_silent_failure',
      detail: `canonicalAccess=null status=${state.status} error=null`,
      ...(directNullSnapshot
        ? { knownBrokenId: KB.undefinedSnapshot }
        : options.purchaseCancelOverlapped && state.status === 'error'
          ? { knownBrokenId: KB.cancelClearsError }
          : kbRejected),
    });
  }
  if (
    !anyPending &&
    (state.status === 'error' || state.status === 'unconfigured') &&
    state.error === null &&
    !options.userClearedError
  ) {
    violations.push({
      invariant: 'error_status_has_error',
      detail: `status=${state.status} error=null`,
      ...(options.purchaseCancelOverlapped && state.status === 'error'
        ? { knownBrokenId: KB.cancelClearsError }
        : kbRejected),
    });
  }
  if (
    !anyPending &&
    (state.canonicalAccess === null || state.plans === null) &&
    state.status !== 'idle' &&
    !paywallShowsRetry(state)
  ) {
    violations.push({
      invariant: 'retry_control_visible',
      detail: `status=${state.status} plans=${state.plans ? 'set' : 'null'} canonicalAccess=${state.canonicalAccess ? 'set' : 'null'}`,
      ...kbRejected,
    });
  }

  if (env.maxInFlight('rc:purchasePackage') > 1) {
    violations.push({
      invariant: 'no_concurrent_store_purchase',
      detail: `purchasePackage in flight concurrently x${env.maxInFlight('rc:purchasePackage')}`,
      ...(options.initializeOverlappedOperation
        ? { knownBrokenId: KB.initializeClearsOperation }
        : options.resetOverlappedOperation
          ? { knownBrokenId: KB.resetClearsOperation }
          : {}),
    });
  }
  if (env.maxInFlight('rc:restorePurchases') > 1) {
    violations.push({
      invariant: 'no_concurrent_store_restore',
      detail: `restorePurchases in flight concurrently x${env.maxInFlight('rc:restorePurchases')}`,
      ...(options.initializeOverlappedOperation
        ? { knownBrokenId: KB.initializeClearsOperation }
        : options.resetOverlappedOperation
          ? { knownBrokenId: KB.resetClearsOperation }
          : {}),
    });
  }
  return violations;
}

/**
 * Mid-flight check, run after every step: while a purchase/restore/sync is
 * pending (and no configuration cut happened), `operation` must report it —
 * PaywallScreen disables both store buttons from that flag.
 */
export function checkInFlightInvariants(
  state: AccessStoreState,
  env: Environment,
  ops: SettledOp[],
  initializeOverlapped: boolean,
): Violation[] {
  const violations: Violation[] = [];
  const busy = ops.filter(
    o =>
      !o.settled &&
      !o.cutWhilePending &&
      (o.op === 'purchaseSelected' ||
        o.op === 'restorePurchases' ||
        o.op === 'syncBilling'),
  );
  if (busy.length > 0 && state.operation === 'idle') {
    violations.push({
      invariant: 'operation_reflects_inflight_action',
      detail: `operation=idle while ${busy.map(o => o.op).join(',')} pending`,
      ...(initializeOverlapped
        ? { knownBrokenId: KB.initializeClearsOperation }
        : {}),
    });
  }
  let premium = false;
  try {
    premium = selectHasPremium(state);
  } catch {
    premium = false;
  }
  if (premium && !env.servedPremium()) {
    violations.push({
      invariant: 'no_fake_premium_midflight',
      detail: 'premium reported before the server served premium',
    });
  }
  return violations;
}

// ─── Async helpers (fake-timer safe) ───────────────────────────────────────

export async function flushMicrotasks(rounds = 40): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}

/** Tracks whether a store op promise has settled without awaiting it. */
export function track(
  op: StoreOp,
  promise: Promise<boolean | void>,
): SettledOp {
  const record: SettledOp = {
    op,
    settled: false,
    result: undefined,
    cutWhilePending: false,
  };
  promise.then(
    value => {
      record.settled = true;
      record.result = value === undefined ? undefined : Boolean(value);
    },
    error => {
      record.settled = true;
      record.result = 'rejected';
      record.rejection = error instanceof Error ? error.message : String(error);
    },
  );
  return record;
}

export function dedupeViolations(violations: Violation[]): Violation[] {
  const seen = new Set<string>();
  return violations.filter(v => {
    const key = `${v.invariant}|${v.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** One store/backend action per user action, never more. */
export function checkCallCounts(
  env: Environment,
  started: Record<StoreOp, number>,
): Violation[] {
  const violations: Violation[] = [];
  if (env.countCalls('rc:purchasePackage') > started.purchaseSelected) {
    violations.push({
      invariant: 'purchase_called_at_most_once_per_op',
      detail: `purchasePackage=${env.countCalls('rc:purchasePackage')} purchaseSelected()=${started.purchaseSelected}`,
    });
  }
  if (env.countCalls('rc:restorePurchases') > started.restorePurchases) {
    violations.push({
      invariant: 'restore_called_at_most_once_per_op',
      detail: `restorePurchases=${env.countCalls('rc:restorePurchases')} restorePurchases()=${started.restorePurchases}`,
    });
  }
  const syncs = env.countCalls('fetch:syncBilling');
  const syncOps =
    started.syncBilling + started.purchaseSelected + started.restorePurchases;
  if (syncs > syncOps) {
    violations.push({
      invariant: 'sync_called_at_most_once_per_op',
      detail: `syncBilling fetches=${syncs} ops=${syncOps}`,
    });
  }
  return violations;
}
