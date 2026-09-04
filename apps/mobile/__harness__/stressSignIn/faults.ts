/**
 * The failure-injection matrix for the SignIn flow.
 *
 * Two sources of scenarios, both fully deterministic:
 *   1. CATALOG — one row per (dependency, fault mode, provider): every
 *      dependency the real SignIn flow touches, in every fault mode the lens
 *      asks for (throw / reject / timeout / malformed / partial / slow /
 *      never-resolves). Each row's seed is a stable hash of its id.
 *   2. seededScenario(seed) — a random COMBINATION of faults across
 *      dependencies drawn from mulberry32(seed), for the STRESS_ITER campaign.
 *
 * `expectation()` is the oracle: given the fault set it states whether the
 * server could have accepted the sign-in, whether the user cancelled, and
 * which faults are synthetic (cannot occur with the real native/fetch
 * implementation) so their failures are labelled as such in the results.
 */
import { makePrng, pick } from '../../xc-harness/lifecycle-persistence/seeds';
import {
  APPLE_FAULTS,
  BOOTSTRAP_FAULTS,
  BOOTSTRAP_MINTS_REFRESH,
  BOOTSTRAP_SERVER_ACCEPTED,
  CLOCK_FAULTS,
  CONFIG_FAULTS,
  DB_FAULTS,
  GOOGLE_FAULTS,
  KEYCHAIN_OK,
  KEYCHAIN_OP_FAULTS,
  ME_FAULTS,
  NAV_FAULTS,
  PERMISSION_FAULTS,
  REFRESH_FAULTS,
  REVENUECAT_FAULTS,
  type AppleFault,
  type BootstrapFault,
  type ClockFault,
  type ConfigFault,
  type DbFault,
  type GoogleFault,
  type KeychainFaults,
  type MeFault,
  type NavFault,
  type PermissionFault,
  type RefreshFault,
  type RevenueCatFault,
} from './world';

export type Provider = 'apple' | 'google';

export interface FaultSet {
  db: DbFault;
  /** Arm the SQLite fault only after launch hydrate (so the fault hits the
   * sign-in writes) instead of from the very first statement. */
  dbArmAfterLaunch: boolean;
  keychain: KeychainFaults;
  apple: AppleFault;
  google: GoogleFault;
  bootstrap: BootstrapFault;
  me: MeFault;
  refresh: RefreshFault;
  permission: PermissionFault;
  revenueCat: RevenueCatFault;
  config: ConfigFault;
  clock: ClockFault;
  nav: NavFault;
}

export type Category =
  | 'fetch/api'
  | 'sqlite'
  | 'keychain'
  | 'apple-native'
  | 'google-sdk'
  | 'permissions'
  | 'revenuecat'
  | 'config'
  | 'clock'
  | 'navigation'
  | 'combo';

export type FaultMode =
  | 'none'
  | 'throw'
  | 'reject'
  | 'timeout'
  | 'malformed'
  | 'partial'
  | 'slow'
  | 'never-resolves'
  | 'missing'
  | 'cancel'
  | 'status'
  | 'skew'
  | 'interaction';

export interface Scenario {
  id: string;
  seed: number;
  provider: Provider;
  category: Category;
  mode: FaultMode;
  faults: FaultSet;
}

export const HEALTHY: FaultSet = {
  db: 'ok',
  dbArmAfterLaunch: true,
  keychain: { ...KEYCHAIN_OK },
  apple: 'ok',
  google: 'ok',
  bootstrap: 'ok',
  me: 'ok',
  refresh: 'ok',
  permission: 'ok',
  revenueCat: 'ok',
  config: 'ok',
  clock: 'now',
  nav: 'none',
};

/** FNV-1a of the id → stable 32-bit seed for catalog rows. */
export function seedFor(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function row(
  category: Category,
  mode: FaultMode,
  provider: Provider,
  name: string,
  faults: Partial<FaultSet>,
): Scenario {
  const id = `${category}/${name}/${provider}`;
  return {
    id,
    seed: seedFor(id),
    provider,
    category,
    mode,
    faults: { ...HEALTHY, keychain: { ...KEYCHAIN_OK }, ...faults },
  };
}

const BOOTSTRAP_MODE: Record<BootstrapFault, FaultMode> = {
  ok: 'none',
  'ok-no-session': 'partial',
  'ok-session-partial-no-refresh': 'partial',
  'ok-session-expires-string': 'malformed',
  'ok-session-expires-past': 'skew',
  'ok-session-expires-negative': 'malformed',
  'ok-huge-body': 'malformed',
  'ok-error-envelope': 'malformed',
  'ok-onboarding-pending': 'partial',
  'throw-sync': 'throw',
  'reject-network': 'reject',
  'reject-string': 'reject',
  'hang-honours-abort': 'timeout',
  'hang-ignores-abort': 'never-resolves',
  'body-hangs': 'never-resolves',
  'slow-5s': 'slow',
  'slow-14s': 'slow',
  'slow-16s': 'timeout',
  'html-200': 'malformed',
  'json-null-200': 'malformed',
  'empty-body-200': 'malformed',
  'truncated-json-200': 'malformed',
  'user-missing-id': 'partial',
  'user-id-not-uuid': 'malformed',
  'onboarding-state-bogus': 'malformed',
  'status-401': 'status',
  'status-403': 'status',
  'status-429': 'status',
  'status-404': 'status',
  'status-500': 'status',
  'status-503-html': 'status',
  'json-rejects': 'reject',
};

const DB_MODE: Record<DbFault, FaultMode> = {
  ok: 'none',
  'open-throws': 'throw',
  'all-throw': 'throw',
  'kv-get-throws': 'throw',
  'kv-set-throws-last-provider': 'throw',
  'kv-set-throws-local-mode': 'throw',
  'kv-set-hangs': 'never-resolves',
  'all-hang': 'never-resolves',
  'slow-3s': 'slow',
  'malformed-rows': 'malformed',
  'kv-garbage-values': 'malformed',
  'dies-after-first-write': 'throw',
};

const APPLE_MODE: Record<AppleFault, FaultMode> = {
  ok: 'none',
  'module-missing': 'missing',
  'method-missing': 'missing',
  'throw-sync': 'throw',
  'reject-error': 'reject',
  'reject-cancel': 'cancel',
  'reject-string': 'reject',
  'reject-undefined': 'reject',
  hang: 'never-resolves',
  'slow-5s': 'slow',
  'resolve-null': 'malformed',
  'resolve-string': 'malformed',
  'resolve-no-token': 'partial',
  'resolve-empty-token': 'partial',
  'resolve-whitespace-token': 'partial',
  'resolve-partial': 'partial',
  'return-non-promise': 'malformed',
};

const GOOGLE_MODE: Record<GoogleFault, FaultMode> = {
  ok: 'none',
  'module-missing': 'missing',
  'configure-throws': 'throw',
  'play-services-rejects': 'reject',
  'play-services-hangs': 'never-resolves',
  'play-services-slow-5s': 'slow',
  'signin-rejects': 'reject',
  'signin-rejects-string': 'reject',
  'signin-throws-sync': 'throw',
  'signin-cancelled': 'cancel',
  'signin-type-garbage': 'malformed',
  'signin-hangs': 'never-resolves',
  'signin-slow-5s': 'slow',
  'signin-resolve-null': 'malformed',
  'signin-success-no-data': 'partial',
  'signin-success-no-idtoken': 'partial',
  'signin-success-no-user': 'partial',
};

const KEYCHAIN_MODE: Record<KeychainFaults['set'], FaultMode> = {
  ok: 'none',
  'throw-sync': 'throw',
  reject: 'reject',
  hang: 'never-resolves',
  'slow-5s': 'slow',
  malformed: 'malformed',
  'returns-false': 'partial',
  'silent-drop': 'partial',
};

const PERMISSION_MODE: Record<PermissionFault, FaultMode> = {
  ok: 'none',
  denied: 'status',
  reject: 'reject',
  'throw-sync': 'throw',
  hang: 'never-resolves',
  malformed: 'malformed',
  'cancel-all-rejects': 'reject',
  'apply-plan-rejects': 'reject',
};

const ME_MODE: Record<MeFault, FaultMode> = {
  ok: 'none',
  pending: 'partial',
  'status-500': 'status',
  hang: 'timeout',
  malformed: 'malformed',
};

const REFRESH_MODE: Record<RefreshFault, FaultMode> = {
  ok: 'none',
  'status-401': 'status',
  'status-500': 'status',
  hang: 'timeout',
};

export function buildCatalog(): Scenario[] {
  const out: Scenario[] = [];
  const providers: Provider[] = ['apple', 'google'];

  for (const provider of providers) {
    out.push(row('combo', 'none', provider, 'healthy', {}));
  }

  for (const bootstrap of BOOTSTRAP_FAULTS) {
    if (bootstrap === 'ok') continue;
    for (const provider of providers) {
      out.push(
        row('fetch/api', BOOTSTRAP_MODE[bootstrap], provider, bootstrap, {
          bootstrap,
        }),
      );
    }
  }
  for (const me of ME_FAULTS) {
    if (me === 'ok') continue;
    out.push(row('fetch/api', ME_MODE[me], 'apple', `me-${me}`, { me }));
  }
  for (const refresh of REFRESH_FAULTS) {
    if (refresh === 'ok') continue;
    out.push(
      row('fetch/api', REFRESH_MODE[refresh], 'google', `refresh-${refresh}`, {
        refresh,
        bootstrap: 'ok-session-expires-past',
      }),
    );
  }

  for (const db of DB_FAULTS) {
    if (db === 'ok') continue;
    for (const provider of providers) {
      out.push(row('sqlite', DB_MODE[db], provider, db, { db }));
    }
    out.push(
      row('sqlite', DB_MODE[db], 'apple', `${db}-from-launch`, {
        db,
        dbArmAfterLaunch: false,
      }),
    );
  }

  out.push(
    row('keychain', 'missing', 'apple', 'module-missing', {
      keychain: { ...KEYCHAIN_OK, moduleMissing: true },
    }),
  );
  out.push(
    row('keychain', 'missing', 'google', 'module-missing', {
      keychain: { ...KEYCHAIN_OK, moduleMissing: true },
    }),
  );
  for (const op of ['get', 'set', 'reset'] as const) {
    for (const fault of KEYCHAIN_OP_FAULTS) {
      if (fault === 'ok') continue;
      if (
        op === 'reset' &&
        (fault === 'malformed' || fault === 'returns-false')
      ) {
        continue;
      }
      if (op === 'get' && fault === 'silent-drop') continue;
      const providersForOp: Provider[] = op === 'set' ? providers : ['apple'];
      for (const provider of providersForOp) {
        out.push(
          row('keychain', KEYCHAIN_MODE[fault], provider, `${op}-${fault}`, {
            keychain: { ...KEYCHAIN_OK, [op]: fault },
          }),
        );
      }
    }
  }

  for (const apple of APPLE_FAULTS) {
    if (apple === 'ok') continue;
    out.push(row('apple-native', APPLE_MODE[apple], 'apple', apple, { apple }));
  }
  for (const google of GOOGLE_FAULTS) {
    if (google === 'ok') continue;
    out.push(
      row('google-sdk', GOOGLE_MODE[google], 'google', google, { google }),
    );
  }

  for (const permission of PERMISSION_FAULTS) {
    if (permission === 'ok') continue;
    out.push(
      row('permissions', PERMISSION_MODE[permission], 'apple', permission, {
        permission,
      }),
    );
  }

  for (const revenueCat of REVENUECAT_FAULTS) {
    if (revenueCat === 'ok') continue;
    for (const provider of providers) {
      out.push(
        row('revenuecat', 'throw', provider, revenueCat, { revenueCat }),
      );
    }
  }

  for (const config of CONFIG_FAULTS) {
    if (config === 'ok') continue;
    const providersFor: Provider[] =
      config === 'google-web-client-null' ? ['google'] : providers;
    for (const provider of providersFor) {
      out.push(row('config', 'missing', provider, config, { config }));
    }
  }

  for (const clock of CLOCK_FAULTS) {
    if (clock === 'now') continue;
    for (const provider of providers) {
      out.push(row('clock', 'skew', provider, clock, { clock }));
    }
  }

  for (const nav of NAV_FAULTS) {
    if (nav === 'none') continue;
    for (const provider of providers) {
      out.push(row('navigation', 'interaction', provider, nav, { nav }));
      out.push(
        row('navigation', 'interaction', provider, `${nav}+bootstrap-500`, {
          nav,
          bootstrap: 'status-500',
        }),
      );
    }
    out.push(
      row('navigation', 'interaction', 'apple', `${nav}+bootstrap-slow-5s`, {
        nav,
        bootstrap: 'slow-5s',
      }),
    );
  }

  return out;
}

/** A random multi-dependency fault combination, fully determined by seed. */
export function seededScenario(seed: number): Scenario {
  const rng = makePrng(seed);
  const provider: Provider = rng() < 0.5 ? 'apple' : 'google';
  const maybe = <T>(options: readonly T[], healthy: T, p: number): T =>
    rng() < p ? pick(rng, options) : healthy;
  const faults: FaultSet = {
    db: maybe(DB_FAULTS, 'ok', 0.35),
    dbArmAfterLaunch: rng() < 0.7,
    keychain: {
      moduleMissing: rng() < 0.05,
      get: maybe(KEYCHAIN_OP_FAULTS, 'ok', 0.25),
      set: maybe(KEYCHAIN_OP_FAULTS, 'ok', 0.35),
      reset: maybe(KEYCHAIN_OP_FAULTS, 'ok', 0.15),
    },
    apple: provider === 'apple' ? maybe(APPLE_FAULTS, 'ok', 0.4) : 'ok',
    google: provider === 'google' ? maybe(GOOGLE_FAULTS, 'ok', 0.4) : 'ok',
    bootstrap: maybe(BOOTSTRAP_FAULTS, 'ok', 0.6),
    me: maybe(ME_FAULTS, 'ok', 0.2),
    refresh: maybe(REFRESH_FAULTS, 'ok', 0.2),
    permission: maybe(PERMISSION_FAULTS, 'ok', 0.3),
    revenueCat: maybe(REVENUECAT_FAULTS, 'ok', 0.15),
    config: maybe(CONFIG_FAULTS, 'ok', 0.1),
    clock: maybe(CLOCK_FAULTS, 'now', 0.3),
    nav: maybe(NAV_FAULTS, 'none', 0.35),
  };
  return {
    id: `seed/${seed}/${provider}`,
    seed,
    provider,
    category: 'combo',
    mode: 'interaction',
    faults,
  };
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

export interface Expectation {
  /** The provider handed the app a usable identity token. */
  providerYieldsToken: boolean;
  /** The user (not a fault) cancelled the provider sheet. */
  userCancelled: boolean;
  /** The provider step itself never settles. */
  providerNeverSettles: boolean;
  /** The runtime config refuses the sign-in before any network call. */
  configRefuses: boolean;
  /** The server accepted the token and minted an account. */
  serverAccepts: boolean;
  /** The server minted a refresh token (something to persist). */
  serverMintsRefresh: boolean;
  /** A dependency AFTER the server accepted throws and aborts the sign-in. */
  postAcceptThrows: boolean;
  /** Something the sign-in awaits never settles (a hang the store must
   * bound). Which dependency, for the report. */
  hangingDependency: string | null;
  /** Faults that cannot occur with the real fetch / native implementation. */
  synthetic: string[];
  /** Production behaviour this scenario is known to expose (a finding in
   * the stress report). Rows carrying a finding id are pinned as EXPECTED
   * failures: the default run records them without failing the suite, the
   * `known-broken pins` test proves the minimal repro still fails, and
   * STRESS_STRICT=1 fails them like any other row. */
  knownBroken: KnownBroken | null;
}

export type KnownBroken =
  'F1-native-hang-unbounded' | 'F2-google-malformed-response-as-cancel';

export const KNOWN_BROKEN: Record<KnownBroken, string> = {
  'F1-native-hang-unbounded':
    'authStore awaits SQLite kv / Keychain promises with no timeout: a never-settling native call at launch (hydrate) or during sign-in leaves LoadingState / the busy spinner for 60s+ with no retry',
  'F2-google-malformed-response-as-cancel':
    'signInWithGoogle treats any response whose type is not "success" as auth.canceled, so a malformed SDK response is swallowed with no visible error',
};

/** Canonical minimal catalog rows for each finding (strict xfail pins). */
export const KNOWN_BROKEN_PINS: Record<KnownBroken, readonly string[]> = {
  'F1-native-hang-unbounded': [
    'sqlite/kv-set-hangs/apple',
    'sqlite/all-hang-from-launch/apple',
    'keychain/get-hang/apple',
    'keychain/set-hang/google',
  ],
  'F2-google-malformed-response-as-cancel': [
    'google-sdk/signin-type-garbage/google',
  ],
};

export function expectation(scenario: Scenario): Expectation {
  const f = scenario.faults;
  const synthetic: string[] = [];
  let providerYieldsToken = true;
  let userCancelled = false;
  let providerNeverSettles = false;
  if (scenario.provider === 'apple') {
    switch (f.apple) {
      case 'ok':
      case 'slow-5s':
      case 'resolve-partial':
      case 'return-non-promise':
        break;
      case 'reject-cancel':
        userCancelled = true;
        providerYieldsToken = false;
        break;
      case 'hang':
        providerNeverSettles = true;
        providerYieldsToken = false;
        synthetic.push('apple:hang');
        break;
      default:
        providerYieldsToken = false;
    }
  } else {
    switch (f.google) {
      case 'ok':
      case 'signin-slow-5s':
      case 'play-services-slow-5s':
        break;
      case 'signin-cancelled':
        userCancelled = true;
        providerYieldsToken = false;
        break;
      case 'signin-hangs':
      case 'play-services-hangs':
        providerNeverSettles = true;
        providerYieldsToken = false;
        synthetic.push(`google:${f.google}`);
        break;
      default:
        providerYieldsToken = false;
    }
  }
  const configRefuses =
    f.config === 'api-null' ||
    f.config === 'api-http-remote' ||
    f.config === 'api-garbage' ||
    (scenario.provider === 'google' && f.config === 'google-web-client-null');
  const networkReached = providerYieldsToken && !configRefuses;
  const serverAccepts =
    networkReached && BOOTSTRAP_SERVER_ACCEPTED.has(f.bootstrap);
  const serverMintsRefresh =
    serverAccepts && BOOTSTRAP_MINTS_REFRESH.has(f.bootstrap);
  const postAcceptThrows =
    serverAccepts && f.revenueCat === 'client-construct-throws';

  let hangingDependency: string | null = null;
  if (providerNeverSettles) {
    hangingDependency =
      scenario.provider === 'apple' ? 'apple-native' : 'google-sdk';
  } else if (networkReached && f.bootstrap === 'hang-ignores-abort') {
    hangingDependency = 'fetch:hang-ignores-abort';
    synthetic.push(
      'fetch:hang-ignores-abort (real RN fetch honours AbortSignal)',
    );
  } else if (networkReached && f.bootstrap === 'body-hangs') {
    hangingDependency = 'fetch:body-hangs';
    synthetic.push(
      'fetch:body-hangs (RN fetch buffers the body before resolving)',
    );
  } else if (serverAccepts && !postAcceptThrows) {
    const dbHangs = f.db === 'kv-set-hangs' || f.db === 'all-hang';
    if (dbHangs) hangingDependency = `sqlite:${f.db}`;
    else if (
      serverMintsRefresh &&
      !f.keychain.moduleMissing &&
      f.keychain.set === 'hang'
    ) {
      hangingDependency = 'keychain:set-hang';
    }
  }
  if (f.db === 'all-hang' && !f.dbArmAfterLaunch) {
    hangingDependency = 'sqlite:all-hang-at-launch';
  }
  if (f.keychain.get === 'hang' && !f.keychain.moduleMissing) {
    hangingDependency = 'keychain:get-hang-at-launch';
  }
  let knownBroken: KnownBroken | null = null;
  if (hangingDependency !== null && synthetic.length === 0) {
    knownBroken = 'F1-native-hang-unbounded';
  } else if (
    scenario.provider === 'google' &&
    f.google === 'signin-type-garbage' &&
    !configRefuses
  ) {
    knownBroken = 'F2-google-malformed-response-as-cancel';
  }
  return {
    providerYieldsToken,
    userCancelled,
    providerNeverSettles,
    configRefuses,
    serverAccepts,
    serverMintsRefresh,
    postAcceptThrows,
    hangingDependency,
    synthetic,
    knownBroken,
  };
}
