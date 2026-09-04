/**
 * LIFECYCLE/PERSISTENCE matrix — every NON-auth store that reads device kv at
 * launch, under every corruption/omission of its persisted keys plus SQLite
 * faults, for each data owner (guest, canonical account, signed-out).
 *
 * Stores under test (all read through getKv/setKv on the shared LocalDb):
 *   appStore.hydrate()              profile:<owner>, legacy `profile`,
 *                                   onboarding.pending-profile
 *   notificationStore.hydrate()     notifications:<owner>,
 *                                   onboarding.pending-notifications
 *   consistencyStore.hydrate()      consistency:<owner> (+ local_shot rows)
 *   walkthroughStore                walkthrough.device-complete
 *   rankCelebrationStore            rank.celebrated:<owner>
 *   appStoreReview                  review.prompt-state
 *   practiceSet                     practice.set:<owner>
 *
 * Invariants (contract: a corrupt device record must degrade to a safe
 * default, never throw out of hydrate, never destroy product rows, and never
 * lock the player out of the app):
 *   noThrow             hydrate()/entry point resolves
 *   shotsPreserved      local_shot rows byte-identical, no destructive SQL
 *   ownerUnchanged      active data owner is untouched by the store
 *   shapeSafe           in-memory state matches its declared type afterwards
 *   recoverable         a corrupt LOCAL record with a healthy database does
 *                       not leave the store in a permanent error state
 *   stashConsumed       a valid pre-auth stash is adopted exactly once
 *   noLegacyLeak        legacy `profile` kv is migrated/cleared for guests
 */
import type { Profile } from '../../../src/state/appStore';
import type {
  PermissionState,
  SchedulerPort,
} from '../../../src/notifications/service';
import type { PlannedNotification } from '../../../src/notifications/types';
import type { PlayerRankSummary } from '@pickle/shared-types';
import { NativeModules } from 'react-native';
import { FakeLocalDb } from '../../../xc-harness/lifecycle-persistence/fakeLocalDb';
import {
  CANONICAL_ID,
  GENERIC_JSON_KV_VARIANTS,
  PENDING_PROFILE_KV_VARIANTS,
  PROFILE_KV_VARIANTS,
  RAW_STRING_VARIANTS,
  makePrng,
  pick,
  validProfile,
} from '../../../xc-harness/lifecycle-persistence/seeds';
import {
  heapSnapshot,
  matrixMarkdown,
  summarize,
  writeJsonArtifact,
  writeTextArtifact,
  type MatrixRow,
} from '../../../xc-harness/lifecycle-persistence/artifacts';

// ─── Module seams ────────────────────────────────────────────────────────────

const mockDb = { current: new FakeLocalDb() };
jest.mock('../../../src/data/db', () => ({
  getDb: () => mockDb.current.handle(),
}));

type CanonicalFetchMode = 'profile' | 'none' | 'throws';
const mockOnboarding = {
  fetchMode: 'profile' as CanonicalFetchMode,
  saveMode: 'ok' as 'ok' | 'throws',
  fetchCalls: 0,
  saveCalls: 0,
};
jest.mock('../../../src/account/onboarding', () => ({
  fetchCanonicalOnboardingProfile: async () => {
    mockOnboarding.fetchCalls += 1;
    if (mockOnboarding.fetchMode === 'throws') {
      throw new Error('Network request failed (simulated)');
    }
    return mockOnboarding.fetchMode === 'profile'
      ? {
          skillLevel: 'intermediate',
          handedness: 'right',
          goal: 'consistency',
          biggestProblem: 'popups',
          focusCheckpoint: 'contact_point',
          firstName: 'Server',
        }
      : null;
  },
  saveCanonicalOnboardingProfile: async (
    _session: unknown,
    profile: Profile,
  ) => {
    mockOnboarding.saveCalls += 1;
    if (mockOnboarding.saveMode === 'throws') {
      throw new Error('503 (simulated)');
    }
    return { ...profile, focusCheckpoint: 'server_focus' };
  },
}));

const nativeModules = NativeModules as {
  PickleStoreReview?: { requestReview: () => Promise<boolean> };
};

import { useAppStore } from '../../../src/state/appStore';
import { useNotificationStore } from '../../../src/notifications/notificationStore';
import { useConsistencyStore } from '../../../src/consistency/store';
import { useWalkthroughStore } from '../../../src/walkthrough/walkthroughStore';
import { useRankCelebrationStore } from '../../../src/progress/rankCelebration';
import { reportScoredAnalysisForReview } from '../../../src/review/appStoreReview';
import { resumeOrStartPracticeSet } from '../../../src/analysis/practiceSet';
import {
  clearApiSession,
  establishApiSession,
} from '../../../src/account/apiSession';
import {
  GUEST_DATA_OWNER,
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
  setActiveDataOwner,
} from '../../../src/data/accountScope';
import { DEFAULT_NOTIFICATION_PREFS } from '../../../src/notifications/types';

// ─── Scenario space ──────────────────────────────────────────────────────────

const OWNERS = ['guest', 'canonical', 'signed-out'] as const;
type OwnerKind = (typeof OWNERS)[number];
function ownerKey(kind: OwnerKind): string {
  return kind === 'guest'
    ? GUEST_DATA_OWNER
    : kind === 'canonical'
      ? CANONICAL_ID
      : SIGNED_OUT_DATA_OWNER;
}

const DB_MODES = [
  'ok',
  'open-throws',
  'reads-throw',
  'writes-throw',
  'all-throw',
] as const;
type DbMode = (typeof DB_MODES)[number];
function applyDbFaults(db: FakeLocalDb, mode: DbMode): void {
  switch (mode) {
    case 'open-throws':
      db.faults = { openThrows: 'SQLITE_CANTOPEN (simulated)' };
      break;
    case 'reads-throw':
      db.faults = { sqlThrows: /^SELECT/ };
      break;
    case 'writes-throw':
      db.faults = { sqlThrows: /^INSERT/ };
      break;
    case 'all-throw':
      db.faults = { allThrow: 'SQLITE_IOERR (simulated)' };
      break;
    default:
      db.faults = {};
  }
}

const NOTIFICATION_PREFS_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  valid: JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, enabled: true }),
  'minutes-negative': JSON.stringify({
    ...DEFAULT_NOTIFICATION_PREFS,
    practiceReminderMinutes: -5,
  }),
  'minutes-huge': JSON.stringify({
    ...DEFAULT_NOTIFICATION_PREFS,
    practiceReminderMinutes: 1e9,
  }),
  'minutes-nan-string': JSON.stringify({
    ...DEFAULT_NOTIFICATION_PREFS,
    practiceReminderMinutes: 'NaN',
  }),
  'minutes-float': JSON.stringify({
    ...DEFAULT_NOTIFICATION_PREFS,
    practiceReminderMinutes: 17.75 * 60,
  }),
  'bools-as-strings': JSON.stringify({
    version: 1,
    enabled: 'true',
    practiceReminder: 'false',
  }),
  'version-2': JSON.stringify({ ...DEFAULT_NOTIFICATION_PREFS, version: 2 }),
};

const PENDING_NOTIFICATION_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  'valid-enable': JSON.stringify({ version: 1, enabled: true }),
  'valid-not-now': JSON.stringify({ version: 1, enabled: false }),
  'enabled-string': JSON.stringify({ version: 1, enabled: 'true' }),
  'version-0': JSON.stringify({ version: 0, enabled: true }),
};

const LEDGER_VARIANTS: Record<string, string | null> = {
  ...GENERIC_JSON_KV_VARIANTS,
  valid: JSON.stringify({
    version: 1,
    drills: [
      {
        id: 'd1',
        slug: 'dink-ladder',
        title: 'Dink ladder',
        completedAtIso: '2026-01-02T10:00:00.000Z',
      },
    ],
    celebrated: { 'streak-3': '2026-01-03' },
    daySecuredShownDay: '2026-01-03',
  }),
  'drills-not-array': JSON.stringify({
    version: 1,
    drills: { id: 'x' },
    celebrated: [],
  }),
  'drills-garbage-entries': JSON.stringify({
    version: 1,
    drills: [
      null,
      1,
      'x',
      {},
      { id: 'ok', completedAtIso: 'not-a-date' },
      { id: 'ok2', completedAtIso: '2026-01-01T00:00:00Z' },
    ],
    celebrated: { a: 1, b: null, c: 'day' },
    daySecuredShownDay: 42,
  }),
  'drills-100k': JSON.stringify({
    version: 1,
    drills: Array.from({ length: 5000 }, (_, i) => ({
      id: `d${i}`,
      slug: 's',
      title: 't',
      completedAtIso: '2026-01-01T00:00:00Z',
    })),
    celebrated: {},
  }),
};

const RANK_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  'valid-lower-tier': JSON.stringify({
    version: 1,
    tier: 'bronze',
    rating: 2.1,
  }),
  'valid-same-tier': JSON.stringify({
    version: 1,
    tier: 'silver',
    rating: 4.2,
  }),
  'valid-higher-tier': JSON.stringify({
    version: 1,
    tier: 'diamond',
    rating: 8.5,
  }),
  'unknown-tier': JSON.stringify({
    version: 1,
    tier: 'platinum-plus',
    rating: 4.2,
  }),
  'rating-string': JSON.stringify({
    version: 1,
    tier: 'silver',
    rating: '4.2',
  }),
  'rating-infinity': '{"version":1,"tier":"silver","rating":1e999}',
  'rating-nan': JSON.stringify({ version: 1, tier: 'silver', rating: null }),
};

const REVIEW_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  'valid-unreviewed': JSON.stringify({
    version: 1,
    scoredAnalyses: 3,
    promptedCount: 3,
    lastPromptedAtIso: '2026-01-01T00:00:00Z',
    reviewedAtIso: null,
  }),
  'valid-reviewed': JSON.stringify({
    version: 1,
    scoredAnalyses: 3,
    promptedCount: 3,
    lastPromptedAtIso: null,
    reviewedAtIso: '2026-01-01T00:00:00Z',
  }),
  'counts-negative': JSON.stringify({
    version: 1,
    scoredAnalyses: -4,
    promptedCount: -1,
  }),
  'counts-strings': JSON.stringify({
    version: 1,
    scoredAnalyses: '9',
    promptedCount: '9',
  }),
  'counts-huge': JSON.stringify({
    version: 1,
    scoredAnalyses: Number.MAX_SAFE_INTEGER,
    promptedCount: 1e308,
  }),
  'reviewed-empty-string': JSON.stringify({ version: 1, reviewedAtIso: '' }),
};

const PRACTICE_NOW_ISO = '2026-03-01T12:00:00.000Z';
const PRACTICE_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  'valid-live': JSON.stringify({
    sessionId: 'set-live',
    shotType: 'forehand_drive',
    startedAtIso: '2026-03-01T11:00:00.000Z',
    lastActivityAtIso: '2026-03-01T11:58:00.000Z',
  }),
  'valid-stale': JSON.stringify({
    sessionId: 'set-stale',
    shotType: null,
    startedAtIso: '2026-02-01T11:00:00.000Z',
    lastActivityAtIso: '2026-02-01T11:58:00.000Z',
  }),
  'valid-future-stamp': JSON.stringify({
    sessionId: 'set-future',
    shotType: null,
    startedAtIso: PRACTICE_NOW_ISO,
    lastActivityAtIso: '2099-01-01T00:00:00.000Z',
  }),
  'stamp-garbage': JSON.stringify({
    sessionId: 'set-garbage',
    shotType: null,
    startedAtIso: 'yesterday',
    lastActivityAtIso: 'now',
  }),
  'session-empty': JSON.stringify({
    sessionId: '',
    shotType: null,
    startedAtIso: PRACTICE_NOW_ISO,
    lastActivityAtIso: PRACTICE_NOW_ISO,
  }),
  'session-number': JSON.stringify({
    sessionId: 42,
    shotType: null,
    startedAtIso: PRACTICE_NOW_ISO,
    lastActivityAtIso: PRACTICE_NOW_ISO,
  }),
  'shot-type-number': JSON.stringify({
    sessionId: 'set-x',
    shotType: 7,
    startedAtIso: PRACTICE_NOW_ISO,
    lastActivityAtIso: PRACTICE_NOW_ISO,
  }),
};

const WALKTHROUGH_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  seen: JSON.stringify({ version: 1 }),
};

function prefixed(
  prefix: string,
  variants: Record<string, string | null>,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(variants))
    out[`${prefix}-${name}`] = value;
  return out;
}

const LEGACY_PROFILE_VARIANTS: Record<string, string | null> = {
  ...prefixed('raw', RAW_STRING_VARIANTS),
  valid: JSON.stringify(validProfile({ firstName: 'Legacy' })),
};

interface StoreScenario {
  name: string;
  seed: number | null;
  owner: OwnerKind;
  db: DbMode;
  apiSession: boolean;
  canonicalFetch: CanonicalFetchMode;
  canonicalSave: 'ok' | 'throws';
  profile: string;
  legacyProfile: string;
  pendingProfile: string;
  notificationPrefs: string;
  pendingNotifications: string;
  ledger: string;
  rank: string;
  review: string;
  practice: string;
  walkthrough: string;
  shots: number;
}

const BASELINE: Omit<StoreScenario, 'name' | 'seed'> = {
  owner: 'canonical',
  db: 'ok',
  apiSession: true,
  canonicalFetch: 'profile',
  canonicalSave: 'ok',
  profile: 'valid',
  legacyProfile: 'raw-absent',
  pendingProfile: 'raw-absent',
  notificationPrefs: 'valid',
  pendingNotifications: 'raw-absent',
  ledger: 'valid',
  rank: 'valid-lower-tier',
  review: 'valid-unreviewed',
  practice: 'valid-live',
  walkthrough: 'raw-absent',
  shots: 12,
};

const GUEST_BASELINE = {
  ...BASELINE,
  owner: 'guest' as const,
  apiSession: false,
};

function sweep(
  prefix: string,
  base: Omit<StoreScenario, 'name' | 'seed'>,
): StoreScenario[] {
  const out: StoreScenario[] = [
    { ...base, name: `${prefix}/baseline`, seed: null },
  ];
  const factor = <K extends keyof typeof base>(
    key: K,
    values: readonly (typeof base)[K][],
  ) => {
    for (const value of values) {
      if (value === base[key]) continue;
      out.push({
        ...base,
        [key]: value,
        name: `${prefix}/${String(key)}=${String(value)}`,
        seed: null,
      });
    }
  };
  factor('owner', OWNERS);
  factor('db', DB_MODES);
  factor('apiSession', [true, false]);
  factor('canonicalFetch', ['profile', 'none', 'throws']);
  factor('canonicalSave', ['ok', 'throws']);
  factor('profile', Object.keys(PROFILE_KV_VARIANTS));
  factor('legacyProfile', Object.keys(LEGACY_PROFILE_VARIANTS));
  factor('pendingProfile', Object.keys(PENDING_PROFILE_KV_VARIANTS));
  factor('notificationPrefs', Object.keys(NOTIFICATION_PREFS_VARIANTS));
  factor('pendingNotifications', Object.keys(PENDING_NOTIFICATION_VARIANTS));
  factor('ledger', Object.keys(LEDGER_VARIANTS));
  factor('rank', Object.keys(RANK_VARIANTS));
  factor('review', Object.keys(REVIEW_VARIANTS));
  factor('practice', Object.keys(PRACTICE_VARIANTS));
  factor('walkthrough', Object.keys(WALKTHROUGH_VARIANTS));
  return out;
}

function seeded(seed: number): StoreScenario {
  const rng = makePrng(seed);
  return {
    name: `seeded/${seed}`,
    seed,
    owner: pick(rng, OWNERS),
    db: pick(rng, DB_MODES),
    apiSession: rng() < 0.7,
    canonicalFetch: pick(rng, ['profile', 'none', 'throws'] as const),
    canonicalSave: pick(rng, ['ok', 'throws'] as const),
    profile: pick(rng, Object.keys(PROFILE_KV_VARIANTS)),
    legacyProfile: pick(rng, Object.keys(LEGACY_PROFILE_VARIANTS)),
    pendingProfile: pick(rng, Object.keys(PENDING_PROFILE_KV_VARIANTS)),
    notificationPrefs: pick(rng, Object.keys(NOTIFICATION_PREFS_VARIANTS)),
    pendingNotifications: pick(rng, Object.keys(PENDING_NOTIFICATION_VARIANTS)),
    ledger: pick(rng, Object.keys(LEDGER_VARIANTS)),
    rank: pick(rng, Object.keys(RANK_VARIANTS)),
    review: pick(rng, Object.keys(REVIEW_VARIANTS)),
    practice: pick(rng, Object.keys(PRACTICE_VARIANTS)),
    walkthrough: pick(rng, Object.keys(WALKTHROUGH_VARIANTS)),
    shots: Math.floor(rng() * 30),
  };
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

class FakeScheduler implements SchedulerPort {
  permission: PermissionState = 'granted';
  applied: PlannedNotification[][] = [];
  cancelAllCalls = 0;
  async permissionState(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async applyPlan(plan: readonly PlannedNotification[]): Promise<void> {
    this.applied.push([...plan]);
  }
  async cancelAllPlanned(): Promise<void> {
    this.cancelAllCalls += 1;
  }
  async openSystemSettings(): Promise<void> {}
}

const RANK_SUMMARY: PlayerRankSummary = {
  rating: 4.2,
  tier: 'silver',
  tierLabel: 'Silver',
  division: 2,
  divisionLabel: 'II',
  techniqueCount: 3,
  scoredAnalysisCount: 12,
} as PlayerRankSummary;

/** JSON.stringify that survives the deep-nesting corruption variant. */
function safeJson(value: unknown, max = 400): string {
  try {
    const text = JSON.stringify(value);
    return text === undefined
      ? 'undefined'
      : text.length > max
        ? `${text.slice(0, max)}…(${text.length} chars)`
        : text;
  } catch (error) {
    return `<unserializable: ${error instanceof Error ? error.message : String(error)}>`;
  }
}

/** kv snapshots keep the artifact replayable without embedding 1 MB blobs. */
function compactValue(value: string): string {
  return value.length > 160
    ? `${value.slice(0, 120)}…(${value.length} chars)`
    : value;
}
function compactKv(
  entries: Iterable<[string, string]>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of entries) out[key] = compactValue(value);
  return out;
}

function isProfileShape(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return [
    'skillLevel',
    'handedness',
    'goal',
    'biggestProblem',
    'focusCheckpoint',
  ].every(key => typeof record[key] === 'string');
}

function isPrefsShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    p['version'] === 1 &&
    [
      'enabled',
      'practiceReminder',
      'streakDefense',
      'weeklyRecap',
      'comeback',
      'promptDismissed',
    ].every(key => typeof p[key] === 'boolean') &&
    typeof p['practiceReminderMinutes'] === 'number' &&
    Number.isInteger(p['practiceReminderMinutes']) &&
    (p['practiceReminderMinutes'] as number) >= 0 &&
    (p['practiceReminderMinutes'] as number) < 1440
  );
}

function resetStores(): void {
  clearApiSession();
  setActiveDataOwner(SIGNED_OUT_DATA_OWNER);
  useAppStore.setState({
    hydrated: false,
    ownerKey: null,
    profile: null,
    hydrateError: null,
    onboardingBusy: false,
    onboardingError: null,
  });
  useNotificationStore.setState({
    hydrated: false,
    ownerKey: null,
    prefs: { ...DEFAULT_NOTIFICATION_PREFS },
    permission: 'unknown',
    persistFailed: false,
    scheduleFailed: false,
  });
  useConsistencyStore.setState({
    hydrated: false,
    ownerKey: null,
    snapshot: null,
    loadError: false,
    celebration: null,
    daySecured: null,
  });
  useWalkthroughStore.setState({ visible: false, queued: false });
  useRankCelebrationStore.setState({ current: null, pending: null });
  mockOnboarding.fetchCalls = 0;
  mockOnboarding.saveCalls = 0;
}

// ─── Known deviations ────────────────────────────────────────────────────────

const KNOWN_DEVIATIONS = {
  'XC-LP-3':
    'appStore.hydrate(): a stored profile:<owner> value that is not valid JSON is parsed with a bare JSON.parse in the success path; the SyntaxError lands in hydrateError and the Gate shows a permanent retry state (retry re-parses the same bytes) — the player is locked out until reinstall',
  'XC-LP-4':
    'appStore.hydrate(): a stored profile:<owner> value that IS valid JSON but not a Profile (number/string/array/{}/wrong field types) is installed as `profile` unchecked, so the Gate skips onboarding for an account that has no usable profile',
} as const;
type DeviationId = keyof typeof KNOWN_DEVIATIONS;

type ProfileRawKind =
  'absent' | 'valid' | 'json-null' | 'invalid-json' | 'json-not-profile';

/** What appStore.hydrate() will see in the profile slot it ends up reading. */
function profileRawKind(raw: string | null): ProfileRawKind {
  if (raw === null || raw === '') return 'absent';
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'invalid-json';
  }
  if (parsed === null) return 'json-null';
  return isProfileShape(parsed) ? 'valid' : 'json-not-profile';
}

// ─── Scenario runner ─────────────────────────────────────────────────────────

async function runScenario(scenario: StoreScenario): Promise<MatrixRow> {
  const started = Date.now();
  resetStores();
  const owner = ownerKey(scenario.owner);
  const db = new FakeLocalDb();
  mockDb.current = db;
  db.seedShots(
    owner === SIGNED_OUT_DATA_OWNER ? CANONICAL_ID : owner,
    scenario.shots,
  );
  db.seedShots(GUEST_DATA_OWNER, 3, 'guest-shot');
  const seedKv = (key: string, value: string | null) => {
    if (value !== null) db.kv.set(key, value);
  };
  seedKv(`profile:${owner}`, PROFILE_KV_VARIANTS[scenario.profile] ?? null);
  seedKv('profile', LEGACY_PROFILE_VARIANTS[scenario.legacyProfile] ?? null);
  seedKv(
    'onboarding.pending-profile',
    PENDING_PROFILE_KV_VARIANTS[scenario.pendingProfile] ?? null,
  );
  seedKv(
    `notifications:${owner}`,
    NOTIFICATION_PREFS_VARIANTS[scenario.notificationPrefs] ?? null,
  );
  seedKv(
    'onboarding.pending-notifications',
    PENDING_NOTIFICATION_VARIANTS[scenario.pendingNotifications] ?? null,
  );
  seedKv(`consistency:${owner}`, LEDGER_VARIANTS[scenario.ledger] ?? null);
  seedKv(`rank.celebrated:${owner}`, RANK_VARIANTS[scenario.rank] ?? null);
  seedKv('review.prompt-state', REVIEW_VARIANTS[scenario.review] ?? null);
  seedKv(`practice.set:${owner}`, PRACTICE_VARIANTS[scenario.practice] ?? null);
  seedKv(
    'walkthrough.device-complete',
    WALKTHROUGH_VARIANTS[scenario.walkthrough] ?? null,
  );
  const shotsBefore = db.shotFingerprint();
  const kvBefore = new Map(db.kv);
  applyDbFaults(db, scenario.db);

  setActiveDataOwner(owner);
  if (scenario.apiSession && scenario.owner === 'canonical') {
    establishApiSession({
      apiBaseUrl: 'https://api.example.test',
      bearerToken: 'access-in-memory',
      canonicalAppUserId: CANONICAL_ID,
      provider: 'apple',
      refreshToken: 'refresh-in-memory',
      bearerExpiresAtMs: Date.now() + 3_600_000,
    });
  }
  mockOnboarding.fetchMode = scenario.canonicalFetch;
  mockOnboarding.saveMode = scenario.canonicalSave;
  const scheduler = new FakeScheduler();

  const threw: Record<string, string | null> = {};
  const attempt = async (
    label: string,
    fn: () => Promise<unknown>,
  ): Promise<unknown> => {
    try {
      const value = await fn();
      threw[label] = null;
      return value;
    } catch (error) {
      threw[label] =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      return undefined;
    }
  };

  await attempt('app', () => useAppStore.getState().hydrate());
  await attempt('notifications', () =>
    useNotificationStore.getState().hydrate({
      scheduler,
      loadContext: async () => ({
        nowMs: Date.now(),
        streakDays: 1,
        practicedToday: false,
        hasAnyHistory: true,
      }),
    }),
  );
  await attempt('consistency', () => useConsistencyStore.getState().hydrate());
  await attempt('walkthrough', () =>
    Promise.all([
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
      useWalkthroughStore.getState().maybeShowFirstRun(),
    ]),
  );
  await attempt('rank', () =>
    useRankCelebrationStore.getState().maybeCelebrate(RANK_SUMMARY),
  );
  await attempt('review', () => reportScoredAnalysisForReview({ delayMs: 0 }));
  const practiceResult = (await attempt('practice', () =>
    resumeOrStartPracticeSet(db.handle({ ignoreOpenFault: true }), {
      shotType: 'forehand_drive',
      nowIso: PRACTICE_NOW_ISO,
    }),
  )) as { sessionId: string | null; resumed: boolean } | undefined;

  const app = useAppStore.getState();
  const notifications = useNotificationStore.getState();
  const consistency = useConsistencyStore.getState();
  const walkthrough = useWalkthroughStore.getState();
  const rank = useRankCelebrationStore.getState();
  const kvAfter = Object.fromEntries(db.kv);

  const dbHealthy = scenario.db === 'ok';
  const writable = scenario.owner !== 'signed-out';
  const ownProfileRaw = PROFILE_KV_VARIANTS[scenario.profile] ?? null;
  const legacyRaw = LEGACY_PROFILE_VARIANTS[scenario.legacyProfile] ?? null;
  const legacyApplies =
    scenario.owner === 'guest' &&
    profileRawKind(ownProfileRaw) === 'absent' &&
    legacyRaw !== null &&
    legacyRaw !== '';
  const effectiveRaw = legacyApplies ? legacyRaw : ownProfileRaw;
  const kind = profileRawKind(effectiveRaw);
  const pendingValid = scenario.pendingProfile === 'valid';
  const canonicalOnline = scenario.owner === 'canonical' && scenario.apiSession;

  const invariants: Record<string, boolean> = {};
  const knownDeviations: string[] = [];

  invariants['noThrow'] = Object.entries(threw)
    .filter(([label]) => label !== 'practice')
    .every(([, error]) => error === null);
  invariants['shotsPreserved'] =
    db.shotFingerprint() === shotsBefore &&
    db.destructiveStatements().length === 0;
  invariants['ownerUnchanged'] = getActiveDataOwner() === owner;
  invariants['appHydrated'] = app.hydrated === true && app.ownerKey === owner;
  // The profile bytes reach JSON.parse when reads work — and, for the guest
  // legacy migration, when the preceding kv writes work too.
  const readsOk =
    scenario.db === 'ok' || (scenario.db === 'writes-throw' && !legacyApplies);
  invariants['profileShapeSafe'] = isProfileShape(app.profile);
  if (
    !invariants['profileShapeSafe'] &&
    kind === 'json-not-profile' &&
    readsOk
  ) {
    knownDeviations.push('XC-LP-4:profileShapeSafe');
  }
  if (kind === 'invalid-json' && readsOk && !(pendingValid && writable)) {
    // Corrupt LOCAL bytes with a healthy database: retrying the same read can
    // never help, so a sticky hydrateError is a lockout, not a retry state.
    invariants['corruptProfileRecoverable'] = app.hydrateError === null;
    if (!invariants['corruptProfileRecoverable']) {
      knownDeviations.push('XC-LP-3:corruptProfileRecoverable');
    }
  }
  if (kind === 'valid' && dbHealthy && !(pendingValid && writable)) {
    invariants['validProfileKept'] =
      isProfileShape(app.profile) &&
      app.profile !== null &&
      app.hydrateError === null;
  }
  if (
    kind === 'absent' &&
    dbHealthy &&
    canonicalOnline &&
    !(pendingValid && writable)
  ) {
    invariants['canonicalFetchOutcome'] =
      scenario.canonicalFetch === 'profile'
        ? app.profile?.firstName === 'Server' &&
          kvAfter[`profile:${owner}`] !== undefined
        : scenario.canonicalFetch === 'none'
          ? app.profile === null && app.hydrateError === null
          : app.profile === null && app.hydrateError !== null;
  }
  if (pendingValid && writable && dbHealthy) {
    const saveOk = !canonicalOnline || scenario.canonicalSave === 'ok';
    invariants['stashConsumed'] = saveOk
      ? (kvAfter['onboarding.pending-profile'] ?? '') === '' &&
        app.profile !== null &&
        app.profile.goal === validProfile().goal &&
        (!canonicalOnline ||
          String(app.profile.focusCheckpoint) === 'server_focus')
      : kvAfter['onboarding.pending-profile'] ===
        PENDING_PROFILE_KV_VARIANTS['valid'];
  }
  if (pendingValid && !writable && dbHealthy) {
    invariants['stashKeptWhileSignedOut'] =
      kvAfter['onboarding.pending-profile'] ===
      PENDING_PROFILE_KV_VARIANTS['valid'];
  }
  if (legacyApplies && dbHealthy && !(pendingValid && writable)) {
    invariants['noLegacyLeak'] =
      (kvAfter['profile'] ?? '') === '' &&
      kvAfter[`profile:${owner}`] === legacyRaw;
    if (scenario.legacyProfile === 'valid') {
      invariants['legacyProfileAdopted'] = app.profile?.firstName === 'Legacy';
    }
  }

  invariants['notificationsHydrated'] =
    notifications.hydrated === true && notifications.ownerKey === owner;
  invariants['prefsShapeSafe'] = isPrefsShape(notifications.prefs);
  if (!writable) {
    invariants['signedOutCancelsPlanned'] = scheduler.cancelAllCalls >= 1;
  }
  if (writable && dbHealthy) {
    const pendingParsed =
      scenario.pendingNotifications === 'valid-enable' ||
      scenario.pendingNotifications === 'valid-not-now';
    invariants['pendingNotificationsConsumed'] = pendingParsed
      ? (kvAfter['onboarding.pending-notifications'] ?? '') === ''
      : true;
    if (
      pendingParsed &&
      (NOTIFICATION_PREFS_VARIANTS[scenario.notificationPrefs] ?? '') === ''
    ) {
      invariants['pendingNotificationsAdopted'] =
        notifications.prefs.enabled ===
          (scenario.pendingNotifications === 'valid-enable') &&
        notifications.prefs.promptDismissed === true;
    }
  }

  invariants['consistencyHydrated'] = consistency.hydrated === true;
  if (writable && dbHealthy) {
    invariants['consistencySnapshot'] =
      consistency.snapshot !== null && consistency.loadError === false;
  }
  if (
    writable &&
    (scenario.db === 'reads-throw' ||
      scenario.db === 'all-throw' ||
      scenario.db === 'open-throws')
  ) {
    invariants['consistencyLoadErrorFlagged'] =
      consistency.loadError === true && consistency.snapshot === null;
  }

  const walkthroughRaw = WALKTHROUGH_VARIANTS[scenario.walkthrough] ?? null;
  const walkthroughUnseen = walkthroughRaw === null || walkthroughRaw === '';
  invariants['walkthroughShownAtMostOnce'] =
    dbHealthy && walkthroughUnseen
      ? walkthrough.visible === true &&
        db.kvWrites().filter(w => w.key === 'walkthrough.device-complete')
          .length === 1
      : dbHealthy
        ? walkthrough.visible === false
        : walkthrough.visible === false;

  if (writable && dbHealthy) {
    const rankRecordAfter = kvAfter[`rank.celebrated:${owner}`];
    let parsed: unknown = null;
    try {
      parsed = rankRecordAfter ? JSON.parse(rankRecordAfter) : null;
    } catch {
      parsed = 'unparseable';
    }
    invariants['rankRecordRepaired'] =
      typeof parsed === 'object' &&
      parsed !== null &&
      (parsed as Record<string, unknown>)['tier'] === 'silver' &&
      (parsed as Record<string, unknown>)['rating'] === 4.2;
    // The walkthrough owns the screen on a fresh device: the ceremony parks
    // in `pending` until it dismisses, so either slot counts as raised.
    const raised = rank.current ?? rank.pending;
    invariants['rankCelebrationSane'] =
      scenario.rank === 'valid-higher-tier' ||
      scenario.rank === 'valid-same-tier'
        ? raised === null
        : raised !== null && raised.toTier === 'silver';
  }

  if (dbHealthy) {
    const reviewAfter = kvAfter['review.prompt-state'];
    const reviewed = scenario.review === 'valid-reviewed';
    let parsedReview: Record<string, unknown> | null = null;
    try {
      parsedReview = reviewAfter
        ? (JSON.parse(reviewAfter) as Record<string, unknown>)
        : null;
    } catch {
      parsedReview = null;
    }
    invariants['reviewStateSane'] = reviewed
      ? reviewAfter === REVIEW_VARIANTS['valid-reviewed']
      : parsedReview !== null &&
        typeof parsedReview['scoredAnalyses'] === 'number' &&
        Number.isFinite(parsedReview['scoredAnalyses']) &&
        (parsedReview['scoredAnalyses'] as number) >= 1 &&
        typeof parsedReview['promptedCount'] === 'number' &&
        Number.isFinite(parsedReview['promptedCount']) &&
        (parsedReview['promptedCount'] as number) >= 1;
  }

  if (scenario.db === 'ok' || scenario.db === 'open-throws') {
    // practiceSet takes the LocalDb as a parameter; open-throws is not a
    // fault it can observe, so those rows run against a healthy handle.
    invariants['practiceNoThrow'] = threw['practice'] === null;
    if (writable) {
      invariants['practiceResultSane'] =
        practiceResult !== undefined &&
        typeof practiceResult.sessionId === 'string' &&
        practiceResult.sessionId.length > 0 &&
        (scenario.practice === 'valid-live'
          ? practiceResult.sessionId === 'set-live' && practiceResult.resumed
          : !practiceResult.resumed);
    } else {
      invariants['practiceResultSane'] =
        practiceResult !== undefined && practiceResult.sessionId === null;
    }
  } else {
    invariants['practiceFailsLoudly'] = threw['practice'] !== null || !writable;
  }

  const failed = Object.entries(invariants)
    .filter(([, held]) => !held)
    .map(([name]) => name)
    .filter(name => !knownDeviations.some(d => d.endsWith(`:${name}`)));

  return {
    suite: 'stores-hydrate',
    scenario: scenario.name,
    seed: scenario.seed,
    inputs: { ...scenario },
    observed: {
      threw,
      app: {
        hydrated: app.hydrated,
        ownerKey: app.ownerKey,
        profile: safeJson(app.profile),
        hydrateError: app.hydrateError,
      },
      notifications: {
        hydrated: notifications.hydrated,
        prefs: notifications.prefs,
        persistFailed: notifications.persistFailed,
        scheduleFailed: notifications.scheduleFailed,
        cancelAllCalls: scheduler.cancelAllCalls,
        appliedPlans: scheduler.applied.length,
      },
      consistency: {
        hydrated: consistency.hydrated,
        loadError: consistency.loadError,
        hasSnapshot: consistency.snapshot !== null,
        totalActivities: consistency.snapshot?.totalActivities ?? null,
      },
      walkthrough: { visible: walkthrough.visible, queued: walkthrough.queued },
      rank: {
        current: rank.current
          ? { from: rank.current.fromTier, to: rank.current.toTier }
          : null,
        pending: rank.pending
          ? { from: rank.pending.fromTier, to: rank.pending.toTier }
          : null,
      },
      practice: practiceResult ?? null,
      owner: getActiveDataOwner(),
      onboardingCalls: {
        fetch: mockOnboarding.fetchCalls,
        save: mockOnboarding.saveCalls,
      },
      kvBefore: compactKv(kvBefore),
      kvAfter: compactKv(Object.entries(kvAfter)),
      kvWrites: db
        .kvWrites()
        .map(w => ({ key: w.key, value: compactValue(w.value) })),
      destructiveStatements: db.destructiveStatements(),
      knownDeviations,
    },
    invariants,
    ok: failed.length === 0,
    failed,
    durationMs: Date.now() - started,
  };
}

// ─── Execution ───────────────────────────────────────────────────────────────

const allRows: MatrixRow[] = [];

async function runBatch(scenarios: StoreScenario[]): Promise<MatrixRow[]> {
  const rows: MatrixRow[] = [];
  for (const scenario of scenarios) rows.push(await runScenario(scenario));
  allRows.push(...rows);
  return rows;
}

function failuresOf(rows: MatrixRow[]): string[] {
  return rows
    .filter(row => !row.ok)
    .map(row => {
      const observed = row.observed as { app: unknown; threw: unknown };
      return `${row.scenario} [seed=${row.seed}] failed ${row.failed.join(',')} :: inputs=${safeJson(row.inputs)} app=${safeJson(observed.app)} threw=${safeJson(observed.threw)}`;
    });
}

const SEEDED_COUNT = 1500;
const CHUNK = 100;

describe('non-auth stores persisted-state matrix', () => {
  const canonical = sweep('canonical', BASELINE);
  const guest = sweep('guest', GUEST_BASELINE);

  beforeAll(() => {
    nativeModules.PickleStoreReview = { requestReview: async () => true };
  });

  afterAll(() => {
    const summary = {
      ...summarize(allRows),
      knownDeviations: KNOWN_DEVIATIONS,
      knownDeviationRows: allRows.reduce<Record<string, number>>((acc, row) => {
        for (const d of (row.observed as { knownDeviations: string[] })
          .knownDeviations) {
          const id = d.split(':')[0] as string;
          acc[id] = (acc[id] ?? 0) + 1;
        }
        return acc;
      }, {}),
    };
    writeJsonArtifact('stores-hydrate-matrix.rows.json', allRows);
    writeJsonArtifact('stores-hydrate-matrix.summary.json', summary);
    writeTextArtifact(
      'stores-hydrate-matrix.matrix.md',
      matrixMarkdown(allRows),
    );
  });

  it('canonical account: every single-factor corruption', async () => {
    const batch = await runBatch(canonical);
    expect(failuresOf(batch)).toEqual([]);
  });

  it('guest: every single-factor corruption', async () => {
    const batch = await runBatch(guest);
    expect(failuresOf(batch)).toEqual([]);
  });

  for (let from = 0; from < SEEDED_COUNT; from += CHUNK) {
    it(`seeded random combinations ${from}..${from + CHUNK - 1} (mulberry32, seed = index)`, async () => {
      const before = heapSnapshot();
      const batch = await runBatch(
        Array.from({ length: CHUNK }, (_, i) => seeded(from + i)),
      );
      const after = heapSnapshot();
      writeJsonArtifact(`stores-hydrate-matrix.heap.${from}.json`, {
        before,
        after,
      });
      expect(failuresOf(batch)).toEqual([]);
    });
  }

  it('every triaged deviation is still reproduced (remove it from KNOWN_DEVIATIONS once fixed)', () => {
    const seen = new Set<DeviationId>();
    for (const row of allRows) {
      for (const d of (row.observed as { knownDeviations: string[] })
        .knownDeviations) {
        seen.add(d.split(':')[0] as DeviationId);
      }
    }
    expect([...seen].sort()).toEqual(Object.keys(KNOWN_DEVIATIONS).sort());
  });
});
