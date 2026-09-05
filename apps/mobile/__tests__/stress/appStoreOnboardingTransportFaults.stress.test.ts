/**
 * STRESS / failure-injection — mod-app-store, write paths + real transport.
 *
 * Complements appStoreHydrateFailureInjection: here the REAL
 * `src/account/onboarding.ts` module runs (its 15s abort, its retry-without-
 * identity-fields, its payload parsing) and faults are injected one layer
 * lower, at `globalThis.fetch` — network reject, sync throw, never-resolving
 * (honouring the abort signal like a real fetch), slow headers under/over the
 * abort budget, headers-then-stalled body, slow body, non-JSON 200, 4xx/5xx
 * with and without a server message, and partial/malformed 200 payloads.
 * SQLite faults land on the writes each action performs.
 *
 * Actions under test: hydrate() (canonical account, no local profile → GET
 * /v1/me), completeOnboarding() (guest = local only, canonical = PUT then
 * local), completePreAuthOnboarding() (local stash write).
 *
 * Seeded; every iteration replays with STRESS_SEED=<seed>. Default 300
 * iterations (fast — fake timers); STRESS_ITER=<n> scales it,
 * STRESS_SEED_BASE=<n> shifts the seed window. Artifacts under
 * artifacts/stress/mod-app-store/<STRESS_RUN_ID|local>/transport.*.json.
 */
import {
  CANONICAL_A,
  FaultKv,
  campaignConfig,
  isValidProfile,
  makeProfile,
  makeRng,
  parseProfileJson,
  writeArtifact,
  type Fault,
  type FaultMode,
} from '../../__harness__/appStoreFailureInjection/harness';
import type { ApiSession } from '../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import type { Profile } from '../../src/state/profile';

// ── dependency seams (db + session mocked; onboarding module is REAL) ──────

const mockDbSeam: { open: () => FaultKv } = {
  open: () => {
    throw new Error('db seam not configured');
  },
};
const mockSessionSeam: { read: () => ApiSession | null } = {
  read: () => null,
};

jest.mock('../../src/data/db', () => ({
  getDb: () => mockDbSeam.open(),
}));
jest.mock('../../src/account/apiSession', () => ({
  getApiSession: () => mockSessionSeam.read(),
}));

const SESSION_A: ApiSession = {
  apiBaseUrl: 'https://api.example.test',
  bearerToken: 'access-token-a',
  canonicalAppUserId: CANONICAL_A,
  provider: 'apple',
};

// ── scenario space ─────────────────────────────────────────────────────────

type Action = 'hydrate' | 'completeOnboarding' | 'completePreAuthOnboarding';
type OwnerKind = 'guest' | 'canonical-a';

/** One HTTP exchange's behaviour, applied per request index (GET / PUT#1 / PUT#2). */
type Transport =
  | 'ok'
  | 'network-reject'
  | 'sync-throw'
  | 'never'
  | 'slow-under-abort'
  | 'slow-over-abort'
  | 'stalled-body'
  | 'slow-body'
  | 'html-200'
  | 'empty-200'
  | 'status-500'
  | 'status-500-message'
  | 'status-401'
  | 'status-429'
  | 'status-400-identity'
  // GET /v1/me payload variants
  | 'get-pending-state'
  | 'get-partial-profile'
  | 'get-bad-handedness'
  | 'get-array'
  // PUT /v1/me/onboarding payload variants
  | 'put-no-checkpoint'
  | 'put-bad-checkpoint'
  | 'put-array';

const TRANSPORTS_GET: readonly Transport[] = [
  'ok',
  'ok',
  'ok',
  'network-reject',
  'sync-throw',
  'never',
  'slow-under-abort',
  'slow-over-abort',
  'stalled-body',
  'slow-body',
  'html-200',
  'empty-200',
  'status-500',
  'status-500-message',
  'status-401',
  'status-429',
  'get-pending-state',
  'get-partial-profile',
  'get-bad-handedness',
  'get-array',
];

const TRANSPORTS_PUT: readonly Transport[] = [
  'ok',
  'ok',
  'ok',
  'network-reject',
  'sync-throw',
  'never',
  'slow-under-abort',
  'slow-over-abort',
  'stalled-body',
  'slow-body',
  'html-200',
  'empty-200',
  'status-500',
  'status-500-message',
  'status-401',
  'status-429',
  'status-400-identity',
  'put-no-checkpoint',
  'put-bad-checkpoint',
  'put-array',
];

type KvSeam = 'db.open' | 'kv.set.profile' | 'kv.set.pending';

interface Scenario {
  seed: number;
  action: Action;
  owner: OwnerKind;
  /** Whether the canonical session matches the owner (only meaningful for canonical-a). */
  sessionPresent: boolean;
  /** Existing local profile for the owner (completeOnboarding replaces it). */
  storedProfile: boolean;
  transports: Transport[]; // by request index
  kvFaults: Partial<Record<KvSeam, Fault>>;
}

const RECOVERABLE_NETWORK_COPY =
  'Your coaching profile could not be securely saved. Check your connection and try again.';

function deriveScenario(seed: number): Scenario {
  const rng = makeRng(seed);
  const action = rng.weighted<Action>([
    ['hydrate', 4],
    ['completeOnboarding', 5],
    ['completePreAuthOnboarding', 2],
  ]);
  const owner: OwnerKind =
    action === 'hydrate'
      ? 'canonical-a'
      : rng.chance(0.7)
        ? 'canonical-a'
        : 'guest';
  const sessionPresent =
    owner === 'canonical-a' ? rng.chance(0.9) : rng.chance(0.3);
  const pool = action === 'hydrate' ? TRANSPORTS_GET : TRANSPORTS_PUT;
  const transports: Transport[] = [
    rng.pick(pool),
    rng.pick(pool),
    rng.pick(pool),
  ];
  const kvFaults: Partial<Record<KvSeam, Fault>> = {};
  if (rng.chance(0.25)) {
    const seam: KvSeam =
      action === 'completePreAuthOnboarding'
        ? rng.pick(['db.open', 'kv.set.pending'] as const)
        : rng.pick(['db.open', 'kv.set.profile'] as const);
    const mode: FaultMode =
      seam === 'db.open'
        ? 'throw'
        : rng.pick(['throw', 'reject', 'slow', 'never'] as const);
    kvFaults[seam] =
      mode === 'slow' ? { mode, slowMs: 250 + rng.int(3_000) } : { mode };
  }
  return {
    seed,
    action,
    owner,
    sessionPresent,
    storedProfile: rng.chance(0.4),
    transports,
    kvFaults,
  };
}

// ── fake fetch ─────────────────────────────────────────────────────────────

interface FetchCall {
  index: number;
  method: string;
  path: string;
  hasBearer: boolean;
  hasSignal: boolean;
  bodyKeys: string[] | null;
  transport: Transport;
}

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function fakeResponse(init: FakeResponseInit): Response {
  return init as unknown as Response;
}

function jsonOk(body: unknown): Response {
  return fakeResponse({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
}

function jsonStatus(status: number, body: unknown): Response {
  return fakeResponse({ ok: false, status, json: () => Promise.resolve(body) });
}

function abortable(
  signal: AbortSignal | null | undefined,
  ms: number | null,
  value: () => Response,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const onAbort = () =>
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (ms !== null) {
      setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value());
      }, ms);
    }
  });
}

function serverProfilePayload(profile: Profile): unknown {
  return {
    onboardingState: 'complete',
    profile: {
      skill_level: profile.skillLevel,
      handedness: profile.handedness,
      primary_goal: profile.goal,
      biggest_problem: profile.biggestProblem,
      ...(profile.firstName ? { first_name: profile.firstName } : {}),
      ...(profile.gender ? { gender: profile.gender } : {}),
    },
  };
}

function installFetch(
  scenario: Scenario,
  serverProfile: Profile,
  calls: FetchCall[],
): void {
  globalThis.fetch = ((input: string, init?: RequestInit) => {
    const index = calls.length;
    const transport = scenario.transports[index] ?? 'ok';
    const method = init?.method ?? 'GET';
    const path = input.replace(SESSION_A.apiBaseUrl, '');
    const headers = (init?.headers ?? {}) as Record<string, string>;
    let bodyKeys: string[] | null = null;
    if (typeof init?.body === 'string') {
      bodyKeys = Object.keys(
        JSON.parse(init.body) as Record<string, unknown>,
      ).sort();
    }
    calls.push({
      index,
      method,
      path,
      hasBearer: headers['Authorization'] === `Bearer ${SESSION_A.bearerToken}`,
      hasSignal: init?.signal instanceof AbortSignal,
      bodyKeys,
      transport,
    });
    const signal = init?.signal;
    const isGet = method === 'GET';
    const okPayload = () =>
      isGet
        ? jsonOk(serverProfilePayload(serverProfile))
        : jsonOk({ recommendedCheckpoint: 'recovery' });
    switch (transport) {
      case 'ok':
        return Promise.resolve(okPayload());
      case 'network-reject':
        return Promise.reject(new TypeError('Network request failed'));
      case 'sync-throw':
        throw new TypeError(
          "Cannot read properties of undefined (reading 'url')",
        );
      case 'never':
        return abortable(signal, null, okPayload);
      case 'slow-under-abort':
        return abortable(signal, 14_000, okPayload);
      case 'slow-over-abort':
        return abortable(signal, 16_000, okPayload);
      case 'stalled-body':
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () => new Promise(() => undefined),
          }),
        );
      case 'slow-body':
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () =>
              new Promise(resolve =>
                setTimeout(
                  () =>
                    resolve(
                      isGet
                        ? serverProfilePayload(serverProfile)
                        : { recommendedCheckpoint: 'recovery' },
                    ),
                  20_000,
                ),
              ),
          }),
        );
      case 'html-200':
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () =>
              Promise.reject(
                new SyntaxError('Unexpected token < in JSON at position 0'),
              ),
          }),
        );
      case 'empty-200':
        return Promise.resolve(
          fakeResponse({
            ok: true,
            status: 200,
            json: () =>
              Promise.reject(new SyntaxError('Unexpected end of JSON input')),
          }),
        );
      case 'status-500':
        return Promise.resolve(
          jsonStatus(500, { error: { code: 'internal' } }),
        );
      case 'status-500-message':
        return Promise.resolve(
          jsonStatus(500, {
            error: { message: 'Server message for the user.' },
          }),
        );
      case 'status-401':
        return Promise.resolve(
          jsonStatus(401, { error: { message: 'Unauthorized' } }),
        );
      case 'status-429':
        return Promise.resolve(
          jsonStatus(429, { error: { message: 'Too many requests' } }),
        );
      case 'status-400-identity':
        return Promise.resolve(
          bodyKeys?.includes('firstName') || bodyKeys?.includes('gender')
            ? jsonStatus(400, { error: { message: 'unknown field firstName' } })
            : okPayload(),
        );
      case 'get-pending-state':
        return Promise.resolve(
          jsonOk({ onboardingState: 'pending', profile: null }),
        );
      case 'get-partial-profile':
        return Promise.resolve(
          jsonOk({
            onboardingState: 'complete',
            profile: { skill_level: '3.5' },
          }),
        );
      case 'get-bad-handedness':
        return Promise.resolve(
          jsonOk({
            onboardingState: 'complete',
            profile: {
              skill_level: '3.5',
              handedness: 'both',
              primary_goal: 'dinks',
              biggest_problem: 'x',
            },
          }),
        );
      case 'get-array':
        return Promise.resolve(jsonOk([serverProfilePayload(serverProfile)]));
      case 'put-no-checkpoint':
        return Promise.resolve(jsonOk({ ok: true }));
      case 'put-bad-checkpoint':
        return Promise.resolve(
          jsonOk({ recommendedCheckpoint: 'not_a_checkpoint' }),
        );
      case 'put-array':
        return Promise.resolve(jsonOk([{ recommendedCheckpoint: 'recovery' }]));
    }
    return Promise.resolve(okPayload());
  }) as typeof globalThis.fetch;
}

// ── row / oracle ───────────────────────────────────────────────────────────

interface Row {
  seed: number;
  scenario: Scenario;
  settlement: 'resolved' | 'rejected' | 'hung';
  fakeMs: number;
  result?: unknown;
  error?: string;
  fetchCalls: FetchCall[];
  kvCalls: Array<{ op: string; key: string; mode: string }>;
  kvBefore: Record<string, string>;
  kvAfter: Record<string, string>;
  state: {
    hydrated: boolean;
    ownerKey: string | null;
    profile: unknown;
    hydrateError: string | null;
    onboardingBusy: boolean;
    onboardingError: string | null;
  };
  violations: string[];
  pins: string[];
}

function resetStore(): void {
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
    lastShotType: 'forehand_drive',
  });
}

function fixturesFor(seed: number): {
  stored: Profile;
  answered: Profile;
  serverProfile: Profile;
} {
  const rng = makeRng(seed ^ 0x7ab5);
  const stored = makeProfile(`stored-${seed}`, rng);
  const answered = makeProfile(`answered-${seed}`, rng);
  const serverProfile = makeProfile(`server-${seed}`, rng);
  return { stored, answered, serverProfile };
}

async function runScenario(scenario: Scenario): Promise<Row> {
  const ownerId = scenario.owner === 'guest' ? GUEST_DATA_OWNER : CANONICAL_A;
  const profileKey = profileKeyForOwner(ownerId);
  const { stored, answered, serverProfile } = fixturesFor(scenario.seed);

  const seedKv: Record<string, string> = {};
  if (scenario.storedProfile && scenario.action !== 'hydrate') {
    seedKv[profileKey] = JSON.stringify(stored);
  }
  const kv = new FaultKv(seedKv);
  const kvBefore = kv.snapshot();
  const setProfileFault = scenario.kvFaults['kv.set.profile'];
  if (setProfileFault) kv.fault('set', profileKey, setProfileFault);
  const setPendingFault = scenario.kvFaults['kv.set.pending'];
  if (setPendingFault)
    kv.fault('set', PENDING_ONBOARDING_PROFILE_KV_KEY, setPendingFault);

  mockDbSeam.open = () => {
    if (scenario.kvFaults['db.open']) {
      throw new Error('[op-sqlite] unable to open database file');
    }
    return kv;
  };
  mockSessionSeam.read = () => (scenario.sessionPresent ? SESSION_A : null);

  const fetchCalls: FetchCall[] = [];
  installFetch(scenario, serverProfile, fetchCalls);

  resetStore();
  setActiveDataOwner(ownerId);
  if (scenario.action !== 'hydrate') {
    // A screen only calls the write actions after hydrate; mirror that state.
    useAppStore.setState({
      hydrated: true,
      ownerKey: ownerId,
      profile: scenario.storedProfile ? stored : null,
    });
  }

  const store = useAppStore.getState();
  const promise: Promise<unknown> =
    scenario.action === 'hydrate'
      ? store.hydrate()
      : scenario.action === 'completeOnboarding'
        ? store.completeOnboarding(answered)
        : store.completePreAuthOnboarding(answered);

  let settlement: Row['settlement'] = 'hung';
  let result: unknown;
  let error: string | undefined;
  let settled = false;
  void promise.then(
    value => {
      settlement = 'resolved';
      result = value;
      settled = true;
    },
    (reason: unknown) => {
      settlement = 'rejected';
      error = reason instanceof Error ? reason.message : String(reason);
      settled = true;
    },
  );
  for (let i = 0; i < 20 && !settled; i += 1) await Promise.resolve();
  let elapsed = 0;
  while (!settled && elapsed < 60_000) {
    await jest.advanceTimersByTimeAsync(500);
    elapsed += 500;
  }

  const s = useAppStore.getState();
  const row: Row = {
    seed: scenario.seed,
    scenario,
    settlement,
    fakeMs: elapsed,
    ...(result !== undefined ? { result } : {}),
    ...(error !== undefined ? { error } : {}),
    fetchCalls,
    kvCalls: kv.calls.map(c => ({ op: c.op, key: c.key, mode: c.mode })),
    kvBefore,
    kvAfter: kv.snapshot(),
    state: {
      hydrated: s.hydrated,
      ownerKey: s.ownerKey,
      profile: s.profile,
      hydrateError: s.hydrateError,
      onboardingBusy: s.onboardingBusy,
      onboardingError: s.onboardingError,
    },
    violations: [],
    pins: [],
  };
  row.violations = judge(row, {
    stored,
    answered,
    serverProfile,
    profileKey,
    ownerId,
  });
  return row;
}

interface Ctx {
  stored: Profile;
  answered: Profile;
  serverProfile: Profile;
  profileKey: string;
  ownerId: string;
}

/** Was request #i attempted and, if so, how did it behave. */
function transportAt(row: Row, i: number): Transport | null {
  return row.fetchCalls[i]?.transport ?? null;
}

function carriesIdentity(call: FetchCall): boolean {
  return call.bodyKeys?.some(k => k === 'firstName' || k === 'gender') ?? false;
}

/** onboarding.ts request() threw (transport failure or non-2xx). */
function requestFailed(call: FetchCall): boolean {
  if (TRANSPORT_FAILS.has(call.transport)) return true;
  return call.transport === 'status-400-identity' && carriesIdentity(call);
}

/** request() returned, but saveCanonicalOnboardingProfile rejects the payload. */
function payloadInvalid(call: FetchCall): boolean {
  return [
    'html-200',
    'empty-200',
    'put-no-checkpoint',
    'put-bad-checkpoint',
    'put-array',
  ].includes(call.transport);
}

const GENERIC_SAVE_COPY = 'Your coaching profile could not be securely saved.';

function requestErrorCopy(call: FetchCall): string | null {
  switch (call.transport) {
    case 'network-reject':
    case 'sync-throw':
    case 'never':
    case 'slow-over-abort':
      return RECOVERABLE_NETWORK_COPY;
    case 'status-500':
      return GENERIC_SAVE_COPY;
    case 'status-500-message':
      return 'Server message for the user.';
    case 'status-401':
      return 'Unauthorized';
    case 'status-429':
      return 'Too many requests';
    case 'status-400-identity':
      return carriesIdentity(call) ? 'unknown field firstName' : null;
    default:
      return null;
  }
}

function payloadErrorCopy(call: FetchCall): string | null {
  switch (call.transport) {
    case 'html-200':
    case 'empty-200':
    case 'put-array':
      return 'The account server returned an invalid coaching profile.';
    case 'put-no-checkpoint':
    case 'put-bad-checkpoint':
      return 'The account server returned an invalid training focus.';
    default:
      return null;
  }
}

/** Copy completeOnboarding must surface for a failed canonical save; null = not a transport-determined failure. */
function expectedSaveCopy(
  put1: FetchCall,
  put2: FetchCall | undefined,
): string | null {
  if (requestFailed(put1)) {
    if (!put2) return requestErrorCopy(put1);
    if (requestFailed(put2)) return requestErrorCopy(put1);
    if (payloadInvalid(put2)) return payloadErrorCopy(put2);
    return null;
  }
  if (payloadInvalid(put1)) return payloadErrorCopy(put1);
  return null;
}

const TRANSPORT_FAILS: ReadonlySet<Transport> = new Set<Transport>([
  'network-reject',
  'sync-throw',
  'never',
  'slow-over-abort',
  'status-500',
  'status-500-message',
  'status-401',
  'status-429',
]);

function judge(row: Row, ctx: Ctx): string[] {
  const v = new Set<string>();
  const { scenario, state, kvAfter, kvBefore } = row;
  const kvNever = row.kvCalls.some(c => c.mode === 'never');
  const stalledBodyReached = row.fetchCalls.some(
    c => c.transport === 'stalled-body',
  );

  // Liveness
  if (row.settlement === 'rejected') v.add('action_rejected');
  if (row.settlement === 'hung') {
    if (kvNever) v.add('hung_on_kv_never');
    else if (stalledBodyReached) v.add('hung_on_stalled_body');
    else v.add('hung_unexplained');
  }
  if (row.settlement !== 'hung' && state.onboardingBusy)
    v.add('busy_after_settle');
  if (
    row.settlement === 'hung' &&
    scenario.action !== 'hydrate' &&
    !state.onboardingBusy
  ) {
    v.add('hung_but_not_busy');
  }

  // Transport contract (real onboarding.ts)
  for (const call of row.fetchCalls) {
    if (!call.hasBearer) v.add('missing_bearer');
    if (!call.hasSignal) v.add('missing_abort_signal');
  }
  if (scenario.owner === 'guest' && row.fetchCalls.length > 0)
    v.add('guest_hit_network');
  if (
    scenario.action === 'completePreAuthOnboarding' &&
    row.fetchCalls.length > 0
  ) {
    v.add('preauth_hit_network');
  }

  // Persistence integrity — every kv value must still be a JSON profile or the stash envelope
  for (const [key, value] of Object.entries(kvAfter)) {
    if (key === PENDING_ONBOARDING_PROFILE_KV_KEY) {
      const parsed = parseProfileJson(value) as
        { version?: unknown; profile?: unknown } | symbol;
      if (
        typeof parsed === 'symbol' ||
        parsed.version !== 1 ||
        !isValidProfile(parsed.profile)
      ) {
        v.add('corrupt_pending');
      }
      continue;
    }
    if (!isValidProfile(parseProfileJson(value)))
      v.add('corrupt_persisted_profile');
    if (key !== ctx.profileKey && kvBefore[key] !== value)
      v.add('cross_owner_write');
  }

  const localAfter = parseProfileJson(kvAfter[ctx.profileKey]);
  const localBefore = parseProfileJson(kvBefore[ctx.profileKey]);

  if (scenario.action === 'hydrate') {
    const t0 = transportAt(row, 0);
    if (row.settlement !== 'resolved') return [...v];
    if (!state.hydrated) v.add('not_hydrated_after_resolve');
    if (state.profile && state.hydrateError) v.add('error_and_profile');
    if (state.profile !== null && !isValidProfile(state.profile))
      v.add('invalid_profile_in_state');
    if (!scenario.sessionPresent) {
      if (row.fetchCalls.length > 0) v.add('fetched_without_session');
      return [...v];
    }
    const dbFault = scenario.kvFaults['db.open'];
    const setFault = scenario.kvFaults['kv.set.profile'];
    if (dbFault) {
      // getDb() throws before any read: outer catch → error state (raw copy, KI-2)
      if (row.fetchCalls.length > 0) v.add('fetched_after_db_open_failure');
      if (state.profile !== null || !state.hydrateError)
        v.add('silent_db_open_failure');
      if (state.hydrateError && /op-sqlite|SQLITE/.test(state.hydrateError))
        v.add('raw_error_copy');
      return [...v];
    }
    if (t0 === null) {
      v.add('canonical_not_fetched');
      return [...v];
    }
    if (TRANSPORT_FAILS.has(t0)) {
      // Recoverable: Gate renders ErrorState with onRetry when profile null + hydrateError
      if (state.profile !== null) v.add('profile_despite_transport_failure');
      if (state.hydrateError !== CANONICAL_PROFILE_UNAVAILABLE_MESSAGE)
        v.add('wrong_error_copy');
      if (kvAfter[ctx.profileKey] !== undefined) v.add('kv_written_on_failure');
      return [...v];
    }
    if (t0 === 'ok' || t0 === 'slow-under-abort' || t0 === 'slow-body') {
      const expected = { ...ctx.serverProfile };
      if (
        setFault &&
        (setFault.mode === 'throw' || setFault.mode === 'reject')
      ) {
        // fetched fine, local cache write failed → conservative error state with retry
        if (state.profile !== null)
          v.add('profile_despite_cache_write_failure');
        if (!state.hydrateError) v.add('silent_cache_write_failure');
        if (state.hydrateError && /op-sqlite|SQLITE/.test(state.hydrateError))
          v.add('raw_error_copy');
        if (kvAfter[ctx.profileKey] !== undefined)
          v.add('kv_written_despite_write_fault');
        return [...v];
      }
      if (JSON.stringify(state.profile) !== JSON.stringify(expected))
        v.add('server_profile_not_loaded');
      if (JSON.stringify(localAfter) !== JSON.stringify(expected))
        v.add('server_profile_not_persisted');
      if (state.hydrateError !== null) v.add('error_on_success');
      return [...v];
    }
    if (t0 === 'get-pending-state') {
      // Server says the account has no profile → questionnaire is correct.
      if (state.profile !== null || state.hydrateError !== null)
        v.add('pending_state_misread');
      return [...v];
    }
    // html-200 / empty-200 / get-partial-profile / get-bad-handedness / get-array:
    // the server did NOT say "no profile"; treating it as such is a silent failure.
    if (state.profile === null && state.hydrateError === null)
      v.add('silent_fallback_to_questionnaire');
    if (state.profile !== null) v.add('profile_from_garbage');
    return [...v];
  }

  if (scenario.action === 'completePreAuthOnboarding') {
    const pending = parseProfileJson(
      kvAfter[PENDING_ONBOARDING_PROFILE_KV_KEY],
    ) as { version?: unknown; profile?: unknown } | symbol | undefined;
    const faulted =
      scenario.kvFaults['db.open'] || scenario.kvFaults['kv.set.pending'];
    if (row.settlement !== 'resolved') return [...v];
    if (row.result === true) {
      if (
        pending === undefined ||
        typeof pending === 'symbol' ||
        JSON.stringify(pending.profile) !== JSON.stringify(ctx.answered)
      ) {
        v.add('fake_success_stash_not_written');
      }
      if (state.onboardingError !== null) v.add('error_on_success');
      if (faulted && faulted.mode !== 'slow') v.add('success_despite_fault');
    } else if (row.result === false) {
      if (!faulted) v.add('false_without_fault');
      if (
        typeof state.onboardingError !== 'string' ||
        state.onboardingError.length === 0
      ) {
        v.add('silent_failure_no_error');
      }
      if (pending !== undefined) v.add('stash_written_on_failure');
    } else {
      v.add('non_boolean_result');
    }
    return [...v];
  }

  // completeOnboarding
  const canonical = scenario.owner === 'canonical-a' && scenario.sessionPresent;
  const faulted =
    scenario.kvFaults['db.open'] || scenario.kvFaults['kv.set.profile'];
  if (row.settlement !== 'resolved') return [...v];
  const success =
    state.onboardingError === null &&
    state.profile !== null &&
    JSON.stringify(state.profile) !==
      JSON.stringify(scenario.storedProfile ? ctx.stored : null);
  if (canonical) {
    // getDb() is only reached after the save, so even a db.open fault must
    // have been preceded by the PUT.
    if (row.fetchCalls.length === 0) v.add('canonical_save_skipped');
    const put1 = row.fetchCalls[0];
    const put2 = row.fetchCalls[1];
    const hasIdentity =
      Boolean(ctx.answered.firstName) || ctx.answered.gender !== undefined;
    if (put1 && requestFailed(put1)) {
      // onboarding.ts:153-168 retries ONCE with the core body, only when the
      // first body carried identity fields.
      if (hasIdentity && !put2) v.add('retry_without_identity_skipped');
      if (!hasIdentity && put2) v.add('retry_without_identity_fields');
      if (put2?.bodyKeys?.some(k => k === 'firstName' || k === 'gender')) {
        v.add('retry_kept_identity_fields');
      }
    } else if (put2) {
      v.add('unexpected_retry');
    }
    const finalPut = put2 ?? put1;
    const saveAccepted =
      finalPut !== undefined &&
      !requestFailed(finalPut) &&
      !payloadInvalid(finalPut);
    if (success) {
      if (!saveAccepted) v.add('fake_success_save_not_accepted');
      if (faulted && faulted.mode !== 'slow') v.add('success_despite_fault');
      const expected = { ...ctx.answered, focusCheckpoint: 'recovery' };
      if (JSON.stringify(state.profile) !== JSON.stringify(expected))
        v.add('state_profile_wrong');
      if (JSON.stringify(localAfter) !== JSON.stringify(expected))
        v.add('state_ahead_of_kv');
    } else {
      if (
        typeof state.onboardingError !== 'string' ||
        state.onboardingError.length === 0
      ) {
        v.add('silent_failure_no_error');
      }
      if (JSON.stringify(localAfter) !== JSON.stringify(localBefore))
        v.add('kv_changed_on_failure');
      if (
        JSON.stringify(state.profile) !==
        JSON.stringify(scenario.storedProfile ? ctx.stored : null)
      ) {
        v.add('state_changed_on_failure');
      }
      if (saveAccepted && !faulted) v.add('failure_despite_accepted_save');
      if (put1 && !saveAccepted) {
        // The surfaced copy is the FIRST request's error when the retry also
        // fails (onboarding.ts:167 `throw error`), else the payload error.
        const expected = expectedSaveCopy(put1, put2);
        if (expected !== null && state.onboardingError !== expected) {
          v.add(
            put1.transport === 'network-reject' ||
              put1.transport === 'sync-throw' ||
              put1.transport === 'never' ||
              put1.transport === 'slow-over-abort'
              ? 'network_failure_wrong_copy'
              : 'save_failure_wrong_copy',
          );
        }
      }
      if (
        state.onboardingError &&
        /op-sqlite|SQLITE|undefined/.test(state.onboardingError)
      ) {
        v.add('raw_error_copy');
      }
    }
  } else {
    if (row.fetchCalls.length > 0) v.add('local_only_hit_network');
    if (success) {
      if (faulted && faulted.mode !== 'slow') v.add('success_despite_fault');
      if (JSON.stringify(state.profile) !== JSON.stringify(ctx.answered))
        v.add('state_profile_wrong');
      if (JSON.stringify(localAfter) !== JSON.stringify(ctx.answered))
        v.add('state_ahead_of_kv');
    } else {
      if (!faulted) v.add('failure_without_fault');
      if (
        typeof state.onboardingError !== 'string' ||
        state.onboardingError.length === 0
      ) {
        v.add('silent_failure_no_error');
      }
      if (JSON.stringify(localAfter) !== JSON.stringify(localBefore))
        v.add('kv_changed_on_failure');
      if (
        state.onboardingError &&
        /op-sqlite|SQLITE|undefined/.test(state.onboardingError)
      ) {
        v.add('raw_error_copy');
      }
    }
  }
  return [...v];
}

// ── known issues ───────────────────────────────────────────────────────────

interface Pin {
  id: string;
  finding: string;
  matches: (row: Row, violation: string) => boolean;
}

const KNOWN_ISSUES: readonly Pin[] = [
  {
    id: 'KI-1',
    finding:
      'no watchdog on SQLite writes: a never-settling setKv leaves hydrate on the splash / completeOnboarding with onboardingBusy=true forever',
    matches: (_row, violation) => violation === 'hung_on_kv_never',
  },
  {
    id: 'KI-2',
    finding:
      'raw SQLite driver text becomes onboardingError copy (appStore.ts:229-233 / :250-254 use error.message)',
    matches: (_row, violation) => violation === 'raw_error_copy',
  },
  {
    id: 'KI-8',
    finding:
      'onboarding.ts:request() clears the 15s abort timer in `finally` BEFORE `response.json()` (lines 59-62), so a response whose headers arrive but whose body stalls hangs hydrate()/completeOnboarding() forever — no spinner timeout, no retry',
    matches: (_row, violation) => violation === 'hung_on_stalled_body',
  },
  {
    id: 'KI-9',
    finding:
      'GET /v1/me 200 with a non-JSON body (captive portal / proxy page), an array, or a `complete` state whose profile fails validation is treated as "account has no profile": hydrate ends {profile:null, hydrateError:null} and the Gate shows the questionnaire to an already-onboarded account (onboarding.ts:62 `.json().catch(() => null)` + parseServerProfile → null; appStore.ts:150-153 only writes when non-null)',
    matches: (_row, violation) =>
      violation === 'silent_fallback_to_questionnaire',
  },
];

function pinFor(row: Row, violation: string): Pin | null {
  return KNOWN_ISSUES.find(pin => pin.matches(row, violation)) ?? null;
}

// ── campaign ───────────────────────────────────────────────────────────────

const config = campaignConfig(300);
const rows: Row[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
  jest.useFakeTimers();
  for (const seed of config.seeds) {
    rows.push(await runScenario(deriveScenario(seed)));
  }
  jest.useRealTimers();
  globalThis.fetch = realFetch;
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  for (const row of rows) {
    row.pins = row.violations
      .map(violation => pinFor(row, violation)?.id ?? null)
      .filter((id): id is string => id !== null);
  }
  const transportsHit = new Map<string, number>();
  const kvFaultsHit = new Map<string, number>();
  const violationCounts = new Map<string, number>();
  const pinCounts = new Map<string, number>();
  for (const row of rows) {
    for (const call of row.fetchCalls) {
      if (call.transport !== 'ok') {
        const key = `${call.method}#${call.index}:${call.transport}`;
        transportsHit.set(key, (transportsHit.get(key) ?? 0) + 1);
      }
    }
    for (const call of row.kvCalls) {
      if (call.mode !== 'ok') {
        const key = `${call.op}:${call.key}:${call.mode}`;
        kvFaultsHit.set(key, (kvFaultsHit.get(key) ?? 0) + 1);
      }
    }
    if (row.scenario.kvFaults['db.open'] && row.kvCalls.length === 0) {
      kvFaultsHit.set(
        'db.open:throw',
        (kvFaultsHit.get('db.open:throw') ?? 0) + 1,
      );
    }
    for (const violation of row.violations) {
      violationCounts.set(violation, (violationCounts.get(violation) ?? 0) + 1);
    }
    for (const pin of row.pins)
      pinCounts.set(pin, (pinCounts.get(pin) ?? 0) + 1);
  }
  writeArtifact('transport.rows.json', rows);
  writeArtifact(
    'transport.table.json',
    rows.map(row => ({
      seed: row.seed,
      outcome: row.violations.length === 0 ? 'HELD' : 'VIOLATION',
      violations: row.violations,
      pins: row.pins,
      action: row.scenario.action,
      owner: row.scenario.owner,
      session: row.scenario.sessionPresent,
      settlement: `${row.settlement}@${row.fakeMs}ms`,
      transports: row.fetchCalls.map(
        c => `${c.method}#${c.index}:${c.transport}`,
      ),
      kvFaults: row.scenario.kvFaults,
    })),
  );
  writeArtifact('transport.summary.json', {
    iterations: rows.length,
    replaySeed: config.replaySeed,
    held: rows.filter(r => r.violations.length === 0).length,
    withViolations: rows.filter(r => r.violations.length > 0).length,
    faultsFired:
      [...transportsHit.values()].reduce((a, b) => a + b, 0) +
      [...kvFaultsHit.values()].reduce((a, b) => a + b, 0),
    transportsHit: Object.fromEntries([...transportsHit.entries()].sort()),
    kvFaultsHit: Object.fromEntries([...kvFaultsHit.entries()].sort()),
    violations: Object.fromEntries([...violationCounts.entries()].sort()),
    pins: Object.fromEntries([...pinCounts.entries()].sort()),
    unpinned: rows
      .flatMap(row =>
        row.violations
          .filter(violation => pinFor(row, violation) === null)
          .map(violation => `${row.seed}:${violation}`),
      )
      .sort(),
  });
});

afterAll(() => {
  jest.useRealTimers();
  globalThis.fetch = realFetch;
});

test('campaign ran every seed', () => {
  expect(rows.length).toBe(config.seeds.length);
  expect(rows.length).toBeGreaterThan(0);
});

test('every violation is a pinned known issue, and every KI pin still reproduces', () => {
  const unpinned: string[] = [];
  const matched = new Set<string>();
  for (const row of rows) {
    for (const violation of row.violations) {
      const pin = pinFor(row, violation);
      if (pin) matched.add(pin.id);
      else {
        unpinned.push(
          `seed ${row.seed} [${row.scenario.action}/${row.scenario.owner}]: ${violation} (transports ${row.fetchCalls
            .map(c => c.transport)
            .join(',')}; kv ${JSON.stringify(row.scenario.kvFaults)})`,
        );
      }
    }
  }
  expect(unpinned).toEqual([]);
  if (config.isDefault) {
    const stale = KNOWN_ISSUES.filter(pin => !matched.has(pin.id)).map(
      pin => `${pin.id}: ${pin.finding}`,
    );
    expect(stale).toEqual([]);
  }
});

test('HELD: the real 15s abort bounds never-resolving and over-budget fetches; nothing rejects; nothing hangs without a pinned cause', () => {
  const abortBounded = rows.filter(row =>
    row.fetchCalls.some(
      c => c.transport === 'never' || c.transport === 'slow-over-abort',
    ),
  );
  if (config.isDefault) expect(abortBounded.length).toBeGreaterThan(20);
  for (const row of abortBounded) {
    const stalled = row.fetchCalls.some(c => c.transport === 'stalled-body');
    const kvNever = row.kvCalls.some(c => c.mode === 'never');
    if (!stalled && !kvNever) {
      expect(`${row.seed}:${row.settlement}`).toBe(`${row.seed}:resolved`);
      // two PUTs × 15s + a slow kv write (≤ 3.25s) at most, well under the 60s budget
      expect(row.fakeMs).toBeLessThanOrEqual(35_500);
    }
  }
  expect(
    rows.filter(r => r.violations.includes('action_rejected')).map(r => r.seed),
  ).toEqual([]);
  expect(
    rows
      .filter(r => r.violations.includes('hung_unexplained'))
      .map(r => r.seed),
  ).toEqual([]);
});

test('HELD: transport failures never produce fake success, never write kv, and surface recoverable copy', () => {
  const bad = rows.filter(row =>
    row.violations.some(violation =>
      [
        'profile_despite_transport_failure',
        'fake_success_save_not_accepted',
        'fake_success_stash_not_written',
        'kv_written_on_failure',
        'kv_changed_on_failure',
        'state_changed_on_failure',
        'wrong_error_copy',
        'network_failure_wrong_copy',
        'silent_failure_no_error',
        'profile_from_garbage',
        'corrupt_persisted_profile',
        'corrupt_pending',
        'cross_owner_write',
        'missing_bearer',
        'missing_abort_signal',
        'guest_hit_network',
        'preauth_hit_network',
        'local_only_hit_network',
        'fetched_without_session',
        'retry_without_identity_skipped',
        'retry_without_identity_fields',
        'retry_kept_identity_fields',
        'busy_after_settle',
        'hung_but_not_busy',
      ].includes(violation),
    ),
  );
  expect(bad.map(r => `${r.seed}:${r.violations.join(',')}`)).toEqual([]);
});

test('the campaign fired at least 60 injected faults', () => {
  if (!config.isDefault) return;
  let fired = 0;
  for (const row of rows) {
    fired += row.fetchCalls.filter(c => c.transport !== 'ok').length;
    fired += row.kvCalls.filter(c => c.mode !== 'ok').length;
    if (row.scenario.kvFaults['db.open']) fired += 1;
  }
  expect(fired).toBeGreaterThanOrEqual(60);
  const transports = new Set(
    rows.flatMap(row => row.fetchCalls.map(c => c.transport)),
  );
  for (const t of [...TRANSPORTS_GET, ...TRANSPORTS_PUT])
    expect(transports.has(t)).toBe(true);
});

// ── minimized reproductions (assert the CONTRACT; `failing` until fixed) ───

describe('minimized reproductions', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = realFetch;
  });

  const base: Omit<Scenario, 'seed' | 'action' | 'transports'> = {
    owner: 'canonical-a',
    sessionPresent: true,
    storedProfile: false,
    kvFaults: {},
  };

  test('HELD: a fetch that never resolves is aborted at 15s and hydrate lands on the retryable error state', async () => {
    const row = await runScenario({
      ...base,
      seed: 1,
      action: 'hydrate',
      transports: ['never', 'ok', 'ok'],
    });
    expect(row.settlement).toBe('resolved');
    expect(row.fakeMs).toBeLessThanOrEqual(15_500);
    expect(row.state.profile).toBeNull();
    expect(row.state.hydrateError).toBe(CANONICAL_PROFILE_UNAVAILABLE_MESSAGE);
  });

  test('HELD: a PUT that fails once with identity fields is retried with the core body only', async () => {
    let seed = 1;
    while (fixturesFor(seed).answered.firstName === undefined) seed += 1;
    const row = await runScenario({
      ...base,
      seed,
      action: 'completeOnboarding',
      transports: ['status-400-identity', 'ok', 'ok'],
    });
    expect(row.fetchCalls.map(c => c.transport)).toEqual([
      'status-400-identity',
      'ok',
    ]);
    expect(row.fetchCalls[1]!.bodyKeys).toEqual([
      'biggestProblem',
      'goal',
      'handedness',
      'skillLevel',
    ]);
    expect(row.state.onboardingError).toBeNull();
    expect((row.state.profile as Profile).focusCheckpoint).toBe('recovery');
  });

  test.failing(
    'KI-8: a 200 whose body never arrives settles hydrate within 60s',
    async () => {
      const row = await runScenario({
        ...base,
        seed: 2,
        action: 'hydrate',
        transports: ['stalled-body', 'ok', 'ok'],
      });
      expect(row.settlement).toBe('resolved');
    },
  );

  test.failing(
    'KI-8: a 200 whose body never arrives settles completeOnboarding within 60s (onboardingBusy must clear)',
    async () => {
      const row = await runScenario({
        ...base,
        seed: 2,
        action: 'completeOnboarding',
        transports: ['stalled-body', 'ok', 'ok'],
      });
      expect(row.state.onboardingBusy).toBe(false);
    },
  );

  test.failing(
    'KI-9: a non-JSON 200 from GET /v1/me is an error with retry, not "no profile"',
    async () => {
      const row = await runScenario({
        ...base,
        seed: 4,
        action: 'hydrate',
        transports: ['html-200', 'ok', 'ok'],
      });
      expect(row.settlement).toBe('resolved');
      expect(row.state.hydrateError).toBe(
        CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
      );
    },
  );

  test.failing(
    'KI-9: a `complete` account whose profile payload fails validation is an error, not "no profile"',
    async () => {
      const row = await runScenario({
        ...base,
        seed: 5,
        action: 'hydrate',
        transports: ['get-partial-profile', 'ok', 'ok'],
      });
      expect(row.state.hydrateError).not.toBeNull();
    },
  );
});
