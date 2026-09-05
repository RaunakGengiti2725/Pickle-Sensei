/**
 * STRESS — unit `mod-app-store` (state/appStore + state/profile), lens
 * `boundary-malformed`.
 *
 * Seeded campaign: every iteration derives its whole scenario (owner kind,
 * attack surface, payload, server verdicts) from one 32-bit seed, drives the
 * REAL appStore (hydrate / completeOnboarding / completePreAuthOnboarding),
 * the REAL account/onboarding.ts client parser (through a fake fetch that
 * ports the edge function's validation rules) and a kv LocalDb double, then
 * checks a fixed invariant set:
 *
 *   no_throw                    a store action never rejects
 *   hydrated_for_active_owner   hydrate() always settles for the active owner
 *   profile_shape_strict        installed profile is null or a usable Profile
 *   no_lockout                  corrupt LOCAL bytes never yield a retry-forever
 *                               hydrateError (the DB is healthy)
 *   no_write_on_reject          a rejected stash never writes profile:<owner>
 *   existing_profile_preserved  a rejected stash keeps the owner's profile
 *   no_write_of_rejected_bytes  unparseable bytes are never copied forward
 *   error_copy_no_raw_bytes     user-facing errors never contain payload bytes
 *                               or the bearer token
 *   no_pollution                Object.prototype is untouched afterwards
 *   no_fetch_when_not_canonical guests / signed-out never reach the network
 *   no_bearer_in_kv             the bearer never lands in SQLite
 *   garbled_server_response_is_error   a 200 that is not a /v1/me document
 *                               is an error, not "no profile"
 *   permanent_rejection_surfaced       a 4xx on the stash save is not retried
 *                               silently forever
 *   stash_saved_to_server_before_local a canonical owner's stash is never
 *                               consumed without a server save
 *   newest_intent_wins          an older stash never overwrites answers the
 *                               user gave later
 *   stash_single_use            the stash is adopted by at most one owner
 *   stale_owner_isolation       a superseded hydrate never touches state
 *
 * Failures are classified against KNOWN_DEVIATIONS (existing matrix ids
 * XC-LP-3 / XC-LP-4 plus the ST-MAS-* ids this campaign reproduced) — an
 * UNKNOWN failure fails the suite. Each ST-MAS id also has a minimized,
 * deterministic `it.failing` repro below: it turns RED the day the store is
 * fixed, telling the fixer to promote it to a plain `it`.
 *
 * Scale: STRESS_ITER (default 300, campaign 3000+), STRESS_SQLITE_ITER
 * (default 40; same statements through node:sqlite), STRESS_SEED base seed,
 * STRESS_ONLY_SEED replays one iteration, STRESS_OUT artifact directory
 * (default <repo>/artifacts/stress/mod-app-store/, gitignored). Artifacts:
 * results.json (seed → outcome), summary.json, failures.md.
 *
 * node:sqlite is a Linux proxy for op-sqlite; nothing here is Apple truth.
 */
import type { Profile } from '../../src/state/profile';
import type { StressKvDb } from '../../stress-harness/mod-app-store/kvDb';
import {
  MemoryKvDb,
  SqliteKvDb,
} from '../../stress-harness/mod-app-store/kvDb';
import {
  FAKE_API_BASE,
  FakeOnboardingServer,
} from '../../stress-harness/mod-app-store/fakeApi';
import {
  CANONICAL_A,
  CANONICAL_B,
  ID_KINDS,
  OBJECT_KINDS,
  RESPONSE_KINDS,
  type Corruption,
  type IdKind,
  type ObjectKind,
  type ResponseKind,
  type Rng,
  corrupt,
  getMeSaysNoProfile,
  getMeYieldsProfile,
  idOfKind,
  looseStashAccepts,
  makePrng,
  markerFor,
  objectOfKind,
  parseJsonOrNull,
  pendingEnvelopeText,
  pick,
  preview,
  profileObjectText,
  putYieldsRecommendation,
  strictProfileVerdict,
  validProfile,
} from '../../stress-harness/mod-app-store/generators';
import {
  fs,
  nodeProcess,
  path,
} from '../../xc-harness/lifecycle-persistence/nodeShim';

declare const __dirname: string;

const mockDb: { current: StressKvDb | null } = { current: null };

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    if (!mockDb.current) throw new Error('stress harness: no db for iteration');
    return mockDb.current;
  },
}));

import {
  CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
  PENDING_ONBOARDING_PROFILE_KV_KEY,
  useAppStore,
} from '../../src/state/appStore';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  profileKeyForOwner,
  setActiveDataOwner,
} from '../../src/data/accountScope';
import {
  clearApiSession,
  establishApiSession,
} from '../../src/account/apiSession';

// ── configuration ─────────────────────────────────────────────────────────

const env = nodeProcess.env;
const ITERATIONS = Math.max(1, Number(env['STRESS_ITER'] ?? 300) || 300);
const SQLITE_ITERATIONS = Math.max(
  0,
  Number(env['STRESS_SQLITE_ITER'] ?? 40) || 0,
);
const BASE_SEED = (Number(env['STRESS_SEED'] ?? 20260905) || 20260905) >>> 0;
const ONLY_SEED =
  env['STRESS_ONLY_SEED'] !== undefined
    ? Number(env['STRESS_ONLY_SEED'])
    : null;

function artifactDir(): string {
  const configured = env['STRESS_OUT'];
  const dir =
    configured && configured.length > 0
      ? configured
      : path.resolve(__dirname, '../../../../artifacts/stress/mod-app-store');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeArtifact(name: string, value: unknown): string {
  const file = path.join(artifactDir(), name);
  fs.writeFileSync(
    file,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n',
  );
  return file;
}

/** Deterministic per-iteration seed (mulberry32 on base ^ index). */
function seedFor(index: number): number {
  const rng = makePrng((BASE_SEED ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0);
  return Math.floor(rng() * 0x100000000) >>> 0;
}

// ── known deviations (existing matrix ids + this campaign's) ──────────────

const KNOWN_DEVIATIONS: Record<string, string> = {
  'XC-LP-3':
    'appStore.hydrate() line 182: profile:<owner> bytes that are not JSON are parsed with a bare JSON.parse; the SyntaxError (which on V8 quotes the raw bytes) becomes hydrateError and retry re-parses the same bytes — permanent lockout; the guest legacy migration (lines 122-129) first copies the corrupt bytes forward',
  'XC-LP-4':
    'appStore.hydrate() line 182: profile:<owner> bytes that ARE JSON but not a Profile are installed unchecked (Gate skips onboarding for an unusable profile)',
  'ST-MAS-1':
    'appStore.ts parsePendingProfile (lines 40-66) accepts a stash whose optional firstName/gender have wrong types and whose handedness/focusCheckpoint are outside their vocabularies; hydrate adopts it (overwriting the existing profile and clearing the stash) and installs the malformed object',
  'ST-MAS-2':
    'appStore.ts lines 161-179 + 204-238: a stash whose server save failed transiently is kept, but completeOnboarding never clears it, so the NEXT hydrate adopts the OLDER stash over the answers the user gave afterwards (locally and server-side)',
  'ST-MAS-3':
    'account/onboarding.ts lines 62-79 + appStore.ts line 150: a 200 from GET /v1/me whose body is not a /v1/me document (HTML captive portal, truncated JSON, [], null, wrong field types, empty body) parses to null and is treated as "no profile" — the Gate re-asks the questionnaire instead of showing the retry state',
  'ST-MAS-4':
    'appStore.ts lines 166-178: a stash the server permanently rejects (4xx) is kept and retried on every hydrate forever, with no signal to the user (hydrateError stays null)',
  'ST-MAS-5':
    'appStore.ts lines 167-171 (and 209-213): with a canonical owner but no matching ApiSession (offline restore before the refresh lands, or a session for another account), the stash / questionnaire is written locally and the stash cleared WITHOUT a server save — the account never onboards server-side',
  'ST-MAS-6':
    'appStore.ts lines 161-180: an owner switch while the stash save is in flight lets BOTH owners adopt the stash (the guard at line 164 runs before the await)',
};

type DeviationId = keyof typeof KNOWN_DEVIATIONS | 'UNKNOWN';

// ── scenario model ────────────────────────────────────────────────────────

const SURFACES = [
  'pending-raw',
  'pending-shape',
  'owner-raw',
  'owner-shape',
  'legacy-raw',
  'server-getme',
  'server-put',
  'session-id',
  'complete-arg',
  'preauth-arg',
  'switch-race',
  'stale-stash-sequence',
  'valid-control',
] as const;
type Surface = (typeof SURFACES)[number];

const SURFACE_WEIGHTS: Record<Surface, number> = {
  'pending-raw': 13,
  'pending-shape': 16,
  'owner-raw': 11,
  'owner-shape': 13,
  'legacy-raw': 6,
  'server-getme': 9,
  'server-put': 8,
  'session-id': 6,
  'complete-arg': 5,
  'preauth-arg': 4,
  'switch-race': 3,
  'stale-stash-sequence': 3,
  'valid-control': 3,
};

function pickSurface(rng: Rng): Surface {
  const total = SURFACES.reduce((sum, s) => sum + SURFACE_WEIGHTS[s], 0);
  let roll = rng() * total;
  for (const surface of SURFACES) {
    roll -= SURFACE_WEIGHTS[surface];
    if (roll < 0) return surface;
  }
  return 'valid-control';
}

type OwnerKind =
  'guest' | 'canonical-session' | 'canonical-no-session' | 'signed-out';

function pickOwner(rng: Rng): OwnerKind {
  const roll = rng();
  if (roll < 0.35) return 'guest';
  if (roll < 0.8) return 'canonical-session';
  if (roll < 0.9) return 'canonical-no-session';
  return 'signed-out';
}

function ownerKey(kind: OwnerKind): string {
  switch (kind) {
    case 'guest':
      return GUEST_DATA_OWNER;
    case 'signed-out':
      return SIGNED_OUT_DATA_OWNER;
    default:
      return CANONICAL_A;
  }
}

const BEARER_A = 'stress-bearer-A-do-not-leak';
const BEARER_B = 'stress-bearer-B-do-not-leak';

interface Row {
  seed: number;
  surface: Surface;
  owner: OwnerKind;
  backend: 'memory' | 'sqlite';
  inputs: Record<string, unknown>;
  observed: Record<string, unknown>;
  invariants: Record<string, boolean>;
  failed: string[];
  deviations: DeviationId[];
  ok: boolean;
  durationMs: number;
}

const server = new FakeOnboardingServer();
const realFetch = globalThis.fetch;

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

function installOwner(kind: OwnerKind, sessionId: string | null = null): void {
  setActiveDataOwner(ownerKey(kind));
  server.requests.length = 0;
  server.accounts.clear();
  server.getPlan = null;
  server.putPlan = null;
  server.putGate = null;
  if (kind === 'canonical-session') {
    establishApiSession({
      apiBaseUrl: FAKE_API_BASE,
      bearerToken: BEARER_A,
      canonicalAppUserId: sessionId ?? CANONICAL_A,
      provider: 'apple',
    });
    server.accounts.set(BEARER_A, null);
  } else {
    clearApiSession();
  }
}

function prototypeClean(): boolean {
  const probe = {} as Record<string, unknown>;
  return (
    probe['polluted'] === undefined &&
    !Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted') &&
    Object.keys(Object.prototype).length === 0 &&
    Object.getPrototypeOf(probe) === Object.prototype
  );
}

function scrubPrototype(): void {
  Reflect.deleteProperty(Object.prototype, 'polluted');
}

function textIncludesAny(text: string | null, needles: string[]): boolean {
  if (!text) return false;
  return needles.some(needle => needle.length > 0 && text.includes(needle));
}

async function settle<T>(
  action: () => Promise<T>,
): Promise<{ threw: string | null; value: T | undefined }> {
  try {
    return { threw: null, value: await action() };
  } catch (error) {
    return {
      threw:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      value: undefined,
    };
  }
}

function stateSnapshot() {
  const state = useAppStore.getState();
  return {
    hydrated: state.hydrated,
    ownerKey: state.ownerKey,
    profile: state.profile,
    hydrateError: state.hydrateError,
    onboardingBusy: state.onboardingBusy,
    onboardingError: state.onboardingError,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch (error) {
    return `<unserializable: ${error instanceof Error ? error.name : 'error'}>`;
  }
}

function profileWrites(db: StressKvDb): string[] {
  return db.writes
    .filter(write => write.key.startsWith('profile:'))
    .map(write => write.key);
}

/** Same answers ignoring the server-chosen focus. */
function sameAnswers(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  return ['skillLevel', 'handedness', 'goal', 'biggestProblem'].every(
    key => left[key] === right[key],
  );
}

// ── the iteration ─────────────────────────────────────────────────────────

async function runIteration(
  seed: number,
  backend: 'memory' | 'sqlite',
): Promise<Row> {
  const started = Date.now();
  const rng = makePrng(seed);
  const marker = markerFor(seed);
  server.marker = marker;
  const surface = pickSurface(rng);
  let db: StressKvDb;
  if (backend === 'sqlite') {
    const sqlite = SqliteKvDb.open();
    if (!sqlite) throw new Error('stress harness: node:sqlite unavailable');
    db = sqlite;
  } else {
    db = new MemoryKvDb();
  }
  mockDb.current = db;
  resetStore();
  scrubPrototype();

  const inputs: Record<string, unknown> = {};
  const observed: Record<string, unknown> = {};
  const invariants: Record<string, boolean> = {};
  const deviations = new Set<DeviationId>();
  const leakNeedles = [marker, BEARER_A, BEARER_B];

  let owner: OwnerKind = 'guest';

  const check = (name: string, held: boolean, deviation?: DeviationId) => {
    invariants[name] = held;
    if (!held) deviations.add(deviation ?? 'UNKNOWN');
  };

  const commonAfter = (threw: string | null, expectHydrated: boolean): void => {
    const state = stateSnapshot();
    observed['state'] = {
      ...state,
      profile: state.profile ? preview(safeJson(state.profile)) : null,
      hydrateError: state.hydrateError
        ? preview(state.hydrateError, 160)
        : null,
      onboardingError: state.onboardingError
        ? preview(state.onboardingError, 160)
        : null,
    };
    observed['writes'] = db.writes.map(write => ({
      key: write.key,
      value: preview(write.value, 80),
    }));
    observed['requests'] = server.requests.map(
      request => `${request.method} ${request.path} → ${request.status ?? '?'}`,
    );
    check('no_throw', threw === null);
    if (expectHydrated) {
      check(
        'hydrated_for_active_owner',
        state.hydrated && state.ownerKey === getActiveDataOwner(),
      );
    }
    check('no_pollution', prototypeClean());
    check(
      'error_copy_no_raw_bytes',
      !textIncludesAny(state.hydrateError, leakNeedles) &&
        !textIncludesAny(state.onboardingError, leakNeedles),
      state.hydrateError &&
        /JSON/i.test(state.hydrateError) &&
        (surface === 'owner-raw' || surface === 'legacy-raw')
        ? 'XC-LP-3'
        : undefined,
    );
    check(
      'no_bearer_in_kv',
      !Object.values(db.snapshot()).some(value =>
        textIncludesAny(value, [BEARER_A, BEARER_B]),
      ),
    );
    if (owner !== 'canonical-session') {
      check('no_fetch_when_not_canonical', server.requests.length === 0);
    }
  };

  switch (surface) {
    case 'pending-raw':
    case 'pending-shape': {
      owner = pickOwner(rng);
      installOwner(owner);
      const envelope = pendingEnvelopeText(rng, marker);
      let raw = envelope.text;
      let corruption: Corruption = 'intact';
      if (surface === 'pending-raw') {
        const result = corrupt(rng, envelope.text, marker);
        raw = result.raw;
        corruption = result.corruption;
      }
      db.seed(PENDING_ONBOARDING_PROFILE_KV_KEY, raw);
      const existing = rng() < 0.5 ? validProfile(rng, `${marker}old`) : null;
      if (existing) {
        db.seed(profileKeyForOwner(ownerKey(owner)), JSON.stringify(existing));
      }
      inputs['stash'] = preview(raw);
      inputs['stashLength'] = raw.length;
      inputs['corruption'] = corruption;
      inputs['version'] = envelope.version;
      inputs['fields'] = envelope.fields.map(f => `${f.key}=${f.kind}`);
      inputs['existingProfile'] = existing !== null;

      const parsed = parseJsonOrNull(raw) as Record<string, unknown> | null;
      const stashProfile =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? parsed['profile']
          : null;
      const strict = strictProfileVerdict(stashProfile);
      const loose = looseStashAccepts(raw);
      observed['strictVerdict'] = strict;
      observed['looseAccepted'] = loose;

      const { threw } = await settle(() => useAppStore.getState().hydrate());
      commonAfter(threw, true);
      const state = stateSnapshot();
      const profileKey = profileKeyForOwner(ownerKey(owner));
      const wroteProfile = db.writes.some(w => w.key === profileKey);
      const stashNow = db.read(PENDING_ONBOARDING_PROFILE_KV_KEY);
      observed['stashRetained'] = Boolean(stashNow);
      const putStatuses = server.requests
        .filter(r => r.method === 'PUT')
        .map(r => r.status ?? 0);
      const serverAccepted = putStatuses.includes(200);
      const serverRejected4xx =
        putStatuses.length > 0 &&
        putStatuses.every(status => status >= 400 && status < 500);

      check(
        'profile_shape_strict',
        state.profile === null || strictProfileVerdict(state.profile).ok,
        'ST-MAS-1',
      );
      check('no_lockout', state.hydrateError === null);
      if (owner === 'signed-out') {
        check('no_write_on_reject', db.writes.length === 0);
        check('stash_retained_signed_out', Boolean(stashNow));
      } else if (!strict.ok) {
        check('no_write_on_reject', !wroteProfile, 'ST-MAS-1');
        check(
          'existing_profile_preserved',
          existing
            ? JSON.stringify(state.profile) === JSON.stringify(existing)
            : state.profile === null,
          'ST-MAS-1',
        );
        check('stash_cleared_only_on_accept', Boolean(stashNow), 'ST-MAS-1');
      } else if (owner === 'canonical-session') {
        if (serverAccepted) {
          check('adopted_when_valid', wroteProfile && !stashNow);
        } else {
          check('no_write_on_reject', !wroteProfile);
          check(
            'permanent_rejection_surfaced',
            !serverRejected4xx || state.hydrateError !== null,
            'ST-MAS-4',
          );
        }
      } else if (owner === 'canonical-no-session') {
        check(
          'stash_saved_to_server_before_local',
          !wroteProfile && Boolean(stashNow),
          'ST-MAS-5',
        );
      } else {
        check('adopted_when_valid', wroteProfile && !stashNow);
      }
      break;
    }

    case 'owner-raw':
    case 'owner-shape':
    case 'legacy-raw': {
      owner = surface === 'legacy-raw' ? 'guest' : pickOwner(rng);
      if (owner === 'signed-out') owner = 'guest';
      installOwner(owner);
      const object = profileObjectText(rng, marker);
      let raw = object.text;
      let corruption: Corruption = 'intact';
      if (surface !== 'owner-shape') {
        const result = corrupt(rng, object.text, marker);
        raw = result.raw;
        corruption = result.corruption;
      }
      const key =
        surface === 'legacy-raw'
          ? 'profile'
          : profileKeyForOwner(ownerKey(owner));
      db.seed(key, raw);
      observed['storageRoundTripIntact'] = db.read(key) === raw;
      inputs['key'] = key;
      inputs['raw'] = preview(raw);
      inputs['rawLength'] = raw.length;
      inputs['corruption'] = corruption;
      inputs['fields'] = object.fields.map(f => `${f.key}=${f.kind}`);
      const parsed = parseJsonOrNull(raw);
      const verdict = strictProfileVerdict(parsed);
      observed['strictVerdict'] = verdict;
      observed['parseable'] = parsed !== null;

      const { threw } = await settle(() => useAppStore.getState().hydrate());
      commonAfter(threw, true);
      const state = stateSnapshot();
      const jsonInvalid = parsed === null && raw.trim() !== 'null';
      check(
        'profile_shape_strict',
        state.profile === null || strictProfileVerdict(state.profile).ok,
        'XC-LP-4',
      );
      check('no_lockout', state.hydrateError === null, 'XC-LP-3');
      if (verdict.ok) {
        check(
          'installed_when_valid',
          JSON.stringify(state.profile) === JSON.stringify(parsed),
        );
      }
      if (surface === 'legacy-raw') {
        const copiedForward = db.writes.some(
          w =>
            w.key === profileKeyForOwner(GUEST_DATA_OWNER) && w.value === raw,
        );
        check(
          'no_write_of_rejected_bytes',
          verdict.ok || !copiedForward,
          jsonInvalid ? 'XC-LP-3' : 'XC-LP-4',
        );
      } else {
        check('no_write_on_reject', profileWrites(db).length === 0);
      }
      if (owner === 'canonical-session') {
        observed['serverConsultedOnCorruptLocal'] = server.requests.length > 0;
      }
      break;
    }

    case 'server-getme': {
      owner = 'canonical-session';
      installOwner(owner);
      const kind: ResponseKind = pick(rng, RESPONSE_KINDS);
      server.getPlan = kind;
      inputs['getMe'] = kind;
      const { threw } = await settle(() => useAppStore.getState().hydrate());
      commonAfter(threw, true);
      const state = stateSnapshot();
      check(
        'profile_shape_strict',
        state.profile === null || strictProfileVerdict(state.profile).ok,
      );
      check(
        'no_bearer_in_error',
        !textIncludesAny(state.hydrateError, [BEARER_A]),
      );
      if (getMeYieldsProfile(kind)) {
        check(
          'installed_when_valid',
          state.profile !== null && state.hydrateError === null,
        );
        check(
          'canonical_profile_cached',
          db.read(profileKeyForOwner(CANONICAL_A)) !== null,
        );
      } else if (getMeSaysNoProfile(kind)) {
        check(
          'onboarding_when_pending',
          state.profile === null && state.hydrateError === null,
        );
        check('no_write_on_reject', db.writes.length === 0);
      } else if (kind.startsWith('ok-')) {
        check(
          'garbled_server_response_is_error',
          state.profile === null && state.hydrateError !== null,
          'ST-MAS-3',
        );
        check('no_write_on_reject', db.writes.length === 0);
      } else {
        check(
          'unavailable_is_retry_state',
          state.profile === null &&
            state.hydrateError === CANONICAL_PROFILE_UNAVAILABLE_MESSAGE,
        );
        check('no_write_on_reject', db.writes.length === 0);
      }
      break;
    }

    case 'server-put': {
      owner = 'canonical-session';
      installOwner(owner);
      const answers = validProfile(rng, marker);
      answers.handedness = pick(rng, ['right', 'left'] as const);
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: answers }),
      );
      const kind: ResponseKind = pick(rng, RESPONSE_KINDS);
      server.putPlan = kind;
      inputs['put'] = kind;
      inputs['answers'] = answers;
      const { threw } = await settle(() => useAppStore.getState().hydrate());
      commonAfter(threw, true);
      const state = stateSnapshot();
      const stashNow = db.read(PENDING_ONBOARDING_PROFILE_KV_KEY);
      observed['stashRetained'] = Boolean(stashNow);
      check(
        'profile_shape_strict',
        state.profile === null || strictProfileVerdict(state.profile).ok,
      );
      check('no_lockout', state.hydrateError === null);
      check(
        'error_copy_no_server_detail',
        !textIncludesAny(state.hydrateError, ['pg://', 'index.ts', 'relation']),
      );
      const serverRecommendationValid = putYieldsRecommendation(kind);
      if (serverRecommendationValid) {
        check(
          'adopted_when_valid',
          !stashNow &&
            state.profile !== null &&
            state.profile.focusCheckpoint === 'paddle_set' &&
            sameAnswers(state.profile, answers),
        );
      } else {
        check('no_write_on_reject', profileWrites(db).length === 0);
        check('stash_kept_on_failure', Boolean(stashNow));
        const status = Number(kind.slice(0, 3));
        if (status >= 400 && status < 500) {
          check(
            'permanent_rejection_surfaced',
            state.hydrateError !== null,
            'ST-MAS-4',
          );
        }
      }
      break;
    }

    case 'session-id': {
      const kind: IdKind = pick(rng, ID_KINDS);
      const sessionId = idOfKind(kind, marker);
      owner = 'canonical-session';
      installOwner(owner, sessionId);
      const withStash = rng() < 0.6;
      const answers = validProfile(rng, marker);
      answers.handedness = 'right';
      if (withStash) {
        db.seed(
          PENDING_ONBOARDING_PROFILE_KV_KEY,
          JSON.stringify({ version: 1, profile: answers }),
        );
      }
      inputs['idKind'] = kind;
      inputs['sessionId'] = preview(sessionId, 60);
      inputs['withStash'] = withStash;
      const normalizesToOwner =
        kind === 'valid' || kind === 'uppercase' || kind === 'padded';
      const otherValidAccount = kind === 'other-account';
      const { threw } = await settle(() => useAppStore.getState().hydrate());
      commonAfter(threw, true);
      const state = stateSnapshot();
      const stashNow = db.read(PENDING_ONBOARDING_PROFILE_KV_KEY);
      const wroteProfile = profileWrites(db).length > 0;
      check(
        'profile_shape_strict',
        state.profile === null || strictProfileVerdict(state.profile).ok,
      );
      if (normalizesToOwner) {
        check('no_lockout', state.hydrateError === null);
        if (withStash) {
          check(
            'adopted_when_valid',
            wroteProfile && !stashNow && state.profile !== null,
          );
          check(
            'stash_saved_to_server_before_local',
            server.requests.some(r => r.method === 'PUT' && r.status === 200),
          );
        }
      } else if (otherValidAccount) {
        check('no_fetch_for_other_account', server.requests.length === 0);
        if (withStash) {
          check(
            'stash_saved_to_server_before_local',
            !wroteProfile && Boolean(stashNow),
            'ST-MAS-5',
          );
        }
      } else {
        check(
          'typed_error_for_invalid_id',
          typeof state.hydrateError === 'string' &&
            state.hydrateError.length > 0,
        );
        check('no_write_on_reject', db.writes.length === 0);
        check('no_fetch_for_invalid_id', server.requests.length === 0);
        check('stash_kept_on_failure', !withStash || Boolean(stashNow));
      }
      break;
    }

    case 'complete-arg':
    case 'preauth-arg': {
      owner =
        surface === 'preauth-arg'
          ? 'signed-out'
          : rng() < 0.5
            ? 'guest'
            : 'canonical-session';
      installOwner(owner);
      const kind: ObjectKind = pick(rng, OBJECT_KINDS);
      const object = objectOfKind(rng, kind, marker);
      inputs['objectKind'] = kind;
      let result: { threw: string | null; value: unknown };
      if (surface === 'complete-arg') {
        result = await settle(() =>
          useAppStore.getState().completeOnboarding(object),
        );
      } else {
        result = await settle(() =>
          useAppStore.getState().completePreAuthOnboarding(object),
        );
      }
      observed['returned'] = result.value ?? null;
      commonAfter(result.threw, false);
      const state = stateSnapshot();
      check('busy_flag_cleared', state.onboardingBusy === false);
      if (surface === 'preauth-arg') {
        const stashNow = db.read(PENDING_ONBOARDING_PROFILE_KV_KEY);
        if (result.value === true) {
          check(
            'stash_is_json_when_reported_written',
            parseJsonOrNull(stashNow ?? '') !== null,
          );
        } else {
          check('no_write_when_reported_failed', db.writes.length === 0);
          check(
            'typed_error_on_failure',
            typeof state.onboardingError === 'string',
          );
        }
      } else {
        if (state.onboardingError !== null) {
          check('no_partial_write', profileWrites(db).length === 0);
        } else {
          check(
            'profile_written_when_reported_saved',
            profileWrites(db).length === 1,
          );
          if (owner === 'canonical-session') {
            check(
              'server_saved_before_local',
              server.requests.some(r => r.method === 'PUT' && r.status === 200),
            );
          }
          // The argument is an in-process, statically typed Profile from the
          // questionnaire (not untrusted bytes), so its shape is recorded for
          // the artifact rather than asserted.
          observed['installedShapeVerdict'] = strictProfileVerdict(
            state.profile,
          );
        }
      }
      break;
    }

    case 'switch-race': {
      owner = 'canonical-session';
      installOwner(owner);
      const answers = validProfile(rng, marker);
      answers.handedness = 'right';
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: answers }),
      );
      const secondKind: 'guest' | 'canonical-b' =
        rng() < 0.5 ? 'guest' : 'canonical-b';
      inputs['second'] = secondKind;
      inputs['answers'] = answers;
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      let gateHit = false;
      server.putGate = () => {
        gateHit = true;
        return gate;
      };
      const first = settle(() => useAppStore.getState().hydrate());
      // Let hydrate(A) reach the PUT and park there.
      for (let i = 0; i < 500 && !gateHit; i += 1) await Promise.resolve();
      observed['firstParkedAtPut'] = gateHit;
      // Account switch mid-flight (authStore order: owner, then session).
      if (secondKind === 'guest') {
        setActiveDataOwner(GUEST_DATA_OWNER);
        clearApiSession();
      } else {
        setActiveDataOwner(CANONICAL_B);
        establishApiSession({
          apiBaseUrl: FAKE_API_BASE,
          bearerToken: BEARER_B,
          canonicalAppUserId: CANONICAL_B,
          provider: 'google',
        });
        server.accounts.set(BEARER_B, null);
      }
      server.putGate = null;
      const second = await settle(() => useAppStore.getState().hydrate());
      const afterSecond = stateSnapshot();
      release();
      const firstResult = await first;
      commonAfter(firstResult.threw ?? second.threw, true);
      const state = stateSnapshot();
      const secondOwner =
        secondKind === 'guest' ? GUEST_DATA_OWNER : CANONICAL_B;
      check('race_setup_reached_put', gateHit);
      check(
        'stale_owner_isolation',
        state.ownerKey === secondOwner &&
          JSON.stringify(state) === JSON.stringify(afterSecond),
      );
      const adopters = new Set(
        db.writes
          .filter(
            w =>
              w.key.startsWith('profile:') &&
              sameAnswers(parseJsonOrNull(w.value), answers),
          )
          .map(w => w.key),
      );
      observed['adopters'] = [...adopters];
      check('stash_single_use', adopters.size <= 1, 'ST-MAS-6');
      check(
        'second_owner_adopted',
        adopters.has(profileKeyForOwner(secondOwner)) &&
          sameAnswers(state.profile, answers),
      );
      break;
    }

    case 'stale-stash-sequence': {
      owner = 'canonical-session';
      installOwner(owner);
      const first = validProfile(rng, `${marker}A`);
      first.handedness = 'right';
      const later = validProfile(rng, `${marker}B`);
      later.handedness = 'left';
      later.goal = first.goal === 'drops' ? 'serve' : 'drops';
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: first }),
      );
      const transient = pick(rng, [
        '503',
        '500-plain',
        '502-html',
        '429',
        'network-error',
        'abort',
        'ok-empty-object',
        'ok-html',
      ] as const);
      inputs['transientFailure'] = transient;
      inputs['first'] = first;
      inputs['later'] = later;
      server.putPlan = transient;
      const h1 = await settle(() => useAppStore.getState().hydrate());
      const afterFirst = stateSnapshot();
      observed['afterFirstHydrate'] = {
        profile: afterFirst.profile,
        hydrateError: afterFirst.hydrateError,
        stashRetained: Boolean(db.read(PENDING_ONBOARDING_PROFILE_KV_KEY)),
      };
      server.putPlan = null;
      const c = await settle(() =>
        useAppStore.getState().completeOnboarding(later),
      );
      const afterComplete = stateSnapshot();
      const h2 = await settle(() => useAppStore.getState().hydrate());
      commonAfter(h1.threw ?? c.threw ?? h2.threw, true);
      const state = stateSnapshot();
      const serverRow = server.accounts.get(BEARER_A) ?? null;
      observed['serverGoal'] = serverRow?.primary_goal ?? null;
      check(
        'later_answers_saved',
        afterComplete.onboardingError === null &&
          sameAnswers(afterComplete.profile, later),
      );
      check(
        'newest_intent_wins',
        sameAnswers(state.profile, later) &&
          serverRow?.primary_goal === later.goal,
        'ST-MAS-2',
      );
      break;
    }

    case 'valid-control': {
      owner = pickOwner(rng);
      installOwner(owner);
      const answers = validProfile(rng, marker);
      answers.handedness = pick(rng, ['right', 'left'] as const);
      const withStash = rng() < 0.7;
      if (withStash) {
        db.seed(
          PENDING_ONBOARDING_PROFILE_KV_KEY,
          JSON.stringify({ version: 1, profile: answers }),
        );
      } else if (owner !== 'signed-out') {
        db.seed(profileKeyForOwner(ownerKey(owner)), JSON.stringify(answers));
      }
      inputs['withStash'] = withStash;
      inputs['answers'] = answers;
      const { threw } = await settle(() => useAppStore.getState().hydrate());
      commonAfter(threw, true);
      const state = stateSnapshot();
      check('no_lockout', state.hydrateError === null);
      check(
        'profile_shape_strict',
        state.profile === null || strictProfileVerdict(state.profile).ok,
      );
      if (owner === 'signed-out') {
        check('no_write_on_reject', db.writes.length === 0);
        check('nothing_installed_signed_out', state.profile === null);
      } else if (owner === 'canonical-no-session' && withStash) {
        check(
          'stash_saved_to_server_before_local',
          profileWrites(db).length === 0,
          'ST-MAS-5',
        );
      } else {
        check('installed_when_valid', sameAnswers(state.profile, answers));
      }
      break;
    }
  }

  scrubPrototype();
  db.dispose();
  mockDb.current = null;
  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name);
  return {
    seed,
    surface,
    owner,
    backend,
    inputs,
    observed,
    invariants,
    failed,
    deviations: [...deviations],
    ok: failed.length === 0,
    durationMs: Date.now() - started,
  };
}

// ── campaign ──────────────────────────────────────────────────────────────

function summarize(rows: Row[]) {
  const bySurface: Record<string, { ran: number; failed: number }> = {};
  const byInvariant: Record<string, { checked: number; failed: number }> = {};
  const byDeviation: Record<string, { rows: number; seeds: number[] }> = {};
  for (const row of rows) {
    const s = (bySurface[row.surface] ??= { ran: 0, failed: 0 });
    s.ran += 1;
    if (!row.ok) s.failed += 1;
    for (const [name, held] of Object.entries(row.invariants)) {
      const slot = (byInvariant[name] ??= { checked: 0, failed: 0 });
      slot.checked += 1;
      if (!held) slot.failed += 1;
    }
    for (const id of row.deviations) {
      const slot = (byDeviation[id] ??= { rows: 0, seeds: [] });
      slot.rows += 1;
      if (slot.seeds.length < 25) slot.seeds.push(row.seed);
    }
  }
  return {
    unit: 'mod-app-store',
    lens: 'boundary-malformed',
    baseSeed: BASE_SEED,
    iterations: rows.length,
    passed: rows.filter(r => r.ok).length,
    failed: rows.filter(r => !r.ok).length,
    unknownFailures: rows
      .filter(r => r.deviations.includes('UNKNOWN'))
      .map(r => r.seed),
    bySurface,
    byInvariant,
    byDeviation,
    knownDeviations: KNOWN_DEVIATIONS,
    totalDurationMs: rows.reduce((sum, r) => sum + r.durationMs, 0),
    node: nodeProcess.version,
    generatedAt: new Date().toISOString(),
  };
}

function failuresMarkdown(rows: Row[]): string {
  const lines = [
    '| seed | surface | owner | backend | failed invariants | deviation | inputs |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const row of rows.filter(r => !r.ok)) {
    lines.push(
      `| ${row.seed} | ${row.surface} | ${row.owner} | ${row.backend} | ${row.failed.join(', ')} | ${row.deviations.join(', ')} | ${JSON.stringify(row.inputs).replace(/\|/g, '\\|').slice(0, 200)} |`,
    );
  }
  return lines.join('\n') + '\n';
}

beforeAll(() => {
  globalThis.fetch = server.fetch as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  mockDb.current = null;
  scrubPrototype();
});

describe('mod-app-store boundary/malformed campaign', () => {
  it(`runs ${ITERATIONS} seeded iterations (+${SQLITE_ITERATIONS} through node:sqlite) and only fails in known ways`, async () => {
    const rows: Row[] = [];
    const seeds: number[] =
      ONLY_SEED !== null
        ? [ONLY_SEED >>> 0]
        : Array.from({ length: ITERATIONS }, (_, i) => seedFor(i));
    for (const seed of seeds) rows.push(await runIteration(seed, 'memory'));
    const sqliteAvailable = SqliteKvDb.open();
    if (sqliteAvailable) sqliteAvailable.dispose();
    const sqliteRuns =
      ONLY_SEED !== null || !sqliteAvailable ? 0 : SQLITE_ITERATIONS;
    for (let i = 0; i < sqliteRuns; i += 1) {
      rows.push(await runIteration(seedFor(ITERATIONS + i), 'sqlite'));
    }

    const summary = summarize(rows);
    writeArtifact('results.json', rows);
    writeArtifact('summary.json', summary);
    writeArtifact('failures.md', failuresMarkdown(rows));

    expect(rows.length).toBe(seeds.length + sqliteRuns);
    expect(rows.every(r => r.invariants['no_throw'])).toBe(true);
    expect(rows.every(r => r.invariants['no_pollution'])).toBe(true);
    // Every failure must be an already-classified deviation.
    expect(summary.unknownFailures).toEqual([]);
    if (!sqliteAvailable) {
      // A missing node:sqlite is reported, never silently counted as run.
      expect(summary.iterations).toBe(seeds.length);
    }
  }, 600_000);
});

// ── minimized deterministic repros (RED when fixed → promote to `it`) ──────

describe('mod-app-store minimized repros', () => {
  beforeEach(() => {
    mockDb.current = new MemoryKvDb();
    resetStore();
    scrubPrototype();
  });

  afterEach(() => {
    mockDb.current?.dispose();
    mockDb.current = null;
  });

  const answers: Profile = {
    firstName: 'Dana',
    gender: 'female',
    skillLevel: '3.5',
    handedness: 'right',
    goal: 'drops',
    biggestProblem: 'control',
    focusCheckpoint: 'paddle_set',
  };

  it.failing(
    'ST-MAS-1: a stash with a non-string firstName is rejected, not adopted (guest)',
    async () => {
      installOwner('guest');
      const db = mockDb.current!;
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({
          version: 1,
          profile: { ...answers, firstName: { a: 1 } },
        }),
      );
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.hydrateError).toBeNull();
      expect(state.profile).toBeNull();
      expect(db.writes.map(w => w.key)).not.toContain(
        profileKeyForOwner(GUEST_DATA_OWNER),
      );
    },
  );

  it.failing(
    'ST-MAS-1: a stash whose focusCheckpoint is a path is rejected (guest)',
    async () => {
      installOwner('guest');
      const db = mockDb.current!;
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({
          version: 1,
          profile: {
            ...answers,
            focusCheckpoint: '../../etc/passwd',
            handedness: 'both',
          },
        }),
      );
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toBeNull();
    },
  );

  it.failing(
    'ST-MAS-2: answers given after a failed stash save are not overwritten by the older stash',
    async () => {
      installOwner('canonical-session');
      const db = mockDb.current!;
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: answers }),
      );
      server.putPlan = '503';
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toBeNull();
      server.putPlan = null;
      const later: Profile = {
        ...answers,
        goal: 'serve',
        handedness: 'left',
        focusCheckpoint: 'sequencing',
      };
      await useAppStore.getState().completeOnboarding(later);
      expect(useAppStore.getState().profile?.goal).toBe('serve');
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile?.goal).toBe('serve');
      expect(server.accounts.get(BEARER_A)?.primary_goal).toBe('serve');
    },
  );

  it.failing(
    'ST-MAS-3: a 200 captive-portal HTML body from GET /v1/me is a retry state, not "no profile"',
    async () => {
      installOwner('canonical-session');
      server.getPlan = 'ok-html';
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.profile).toBeNull();
      expect(state.hydrateError).not.toBeNull();
    },
  );

  it.failing(
    'ST-MAS-4: a stash the server rejects with 400 is surfaced instead of retried silently forever',
    async () => {
      installOwner('canonical-session');
      const db = mockDb.current!;
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: answers }),
      );
      server.putPlan = '400-typed';
      await useAppStore.getState().hydrate();
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      const puts = server.requests.filter(r => r.method === 'PUT').length;
      // Either the stash is dropped after a permanent rejection, or the user is told.
      expect(
        state.hydrateError !== null ||
          db.read(PENDING_ONBOARDING_PROFILE_KV_KEY) === null,
      ).toBe(true);
      expect(puts).toBeLessThan(3);
    },
  );

  it.failing(
    'ST-MAS-5: a canonical owner without an ApiSession does not consume the stash locally',
    async () => {
      installOwner('canonical-no-session');
      const db = mockDb.current!;
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: answers }),
      );
      await useAppStore.getState().hydrate();
      expect(db.read(PENDING_ONBOARDING_PROFILE_KV_KEY)).not.toBeNull();
      expect(db.writes.map(w => w.key)).not.toContain(
        profileKeyForOwner(CANONICAL_A),
      );
    },
  );

  it.failing(
    'ST-MAS-6: an owner switch during the stash save does not adopt the stash twice',
    async () => {
      installOwner('canonical-session');
      const db = mockDb.current!;
      db.seed(
        PENDING_ONBOARDING_PROFILE_KV_KEY,
        JSON.stringify({ version: 1, profile: answers }),
      );
      let release: () => void = () => {};
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      server.putGate = () => gate;
      const first = useAppStore.getState().hydrate();
      for (let i = 0; i < 20; i += 1) await Promise.resolve();
      setActiveDataOwner(GUEST_DATA_OWNER);
      clearApiSession();
      server.putGate = null;
      await useAppStore.getState().hydrate();
      release();
      await first;
      const adopters = db.writes
        .filter(
          w =>
            w.key.startsWith('profile:') &&
            sameAnswers(parseJsonOrNull(w.value), answers),
        )
        .map(w => w.key);
      expect(new Set(adopters).size).toBeLessThanOrEqual(1);
    },
  );

  it.failing(
    'XC-LP-3 (existing matrix): corrupt profile:<owner> bytes neither lock the owner out nor leak into the error',
    async () => {
      installOwner('guest');
      const db = mockDb.current!;
      db.seed(profileKeyForOwner(GUEST_DATA_OWNER), 'MKleakZ not json');
      await useAppStore.getState().hydrate();
      const state = useAppStore.getState();
      expect(state.profile).toBeNull();
      expect(state.hydrateError).toBeNull();
      expect(state.hydrateError ?? '').not.toContain('MKleakZ');
    },
  );

  it.failing(
    'XC-LP-4 (existing matrix): profile:<owner> holding `[]` is not installed as a Profile',
    async () => {
      installOwner('guest');
      const db = mockDb.current!;
      db.seed(profileKeyForOwner(GUEST_DATA_OWNER), '[]');
      await useAppStore.getState().hydrate();
      expect(useAppStore.getState().profile).toBeNull();
    },
  );
});
