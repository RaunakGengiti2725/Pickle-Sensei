import type { LocalDb } from '../../src/data/db';

/**
 * Failure-injection world for the SplashScreen stress campaign
 * (`__tests__/stress/splashScreen.failureInjection.stress.test.tsx`).
 *
 * Every native / process edge the launch touches while the intro is on
 * screen is replaced by a fault-injectable double whose behaviour is a pure
 * function of the `FaultSpec`s applied for the iteration: the native video
 * player (driven through the react-native-video mock's callbacks), the
 * Keychain, SQLite, `fetch`, the Google Sign-In SDK, the notification
 * scheduler, StatusBar's native stack, the reduce-motion accessibility
 * query, and the wall clock. Nothing here is random at import time; a seeded
 * iteration is replayable from its seed alone.
 */

// ─── Deterministic PRNG ──────────────────────────────────────────────────────

/** mulberry32 — the same generator the lifecycle matrices use. */
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(rng: () => number, items: readonly T[]): T {
  const index = Math.floor(rng() * items.length);
  return items[Math.min(index, items.length - 1)] as T;
}

// ─── Fault catalogue ─────────────────────────────────────────────────────────

export type FaultCategory =
  | 'video'
  | 'a11y'
  | 'clock'
  | 'keychain'
  | 'sqlite'
  | 'fetch'
  | 'google'
  | 'scheduler'
  | 'statusbar'
  | 'lifecycle';

export type FaultKind =
  | 'throw'
  | 'reject'
  | 'timeout'
  | 'malformed'
  | 'partial'
  | 'slow'
  | 'never'
  | 'sequence';

export interface FaultSpec {
  id: string;
  category: FaultCategory;
  kind: FaultKind;
  /** One line of what the double does when this fault is armed. */
  describe: string;
  /** Install kinds this fault needs to bite at all (default: any). */
  requiresInstall?: readonly InstallKind[];
  /** Install the single-fault sweep uses (default: first of requiresInstall,
   *  else 'existing-vault'). */
  sweepInstall?: InstallKind;
  /** Faults that cannot be armed together with this one (same knob). */
  excludes?: readonly string[];
}

export type InstallKind =
  | 'fresh'
  | 'existing-vault'
  | 'existing-vault-no-profile'
  | 'existing-guest'
  | 'legacy-google-flag';

export const INSTALL_KINDS: readonly InstallKind[] = [
  'fresh',
  'existing-vault',
  'existing-vault-no-profile',
  'existing-guest',
  'legacy-google-flag',
];

const VIDEO_EXCL = ['video.*'];
const KEYCHAIN_EXCL = ['keychain.*'];
const SQLITE_GET_EXCL = ['sqlite.get-*', 'sqlite.open-throws', 'sqlite.all-*'];
const FETCH_EXCL = ['fetch.*'];
const GOOGLE_EXCL = ['google.*'];
const A11Y_EXCL = ['a11y.*'];
const CLOCK_EXCL = ['clock.*'];

export const FAULT_CATALOG: readonly FaultSpec[] = [
  // ── native video player (react-native-video) ─────────────────────────────
  {
    id: 'video.error-immediate',
    category: 'video',
    kind: 'throw',
    describe: 'onError fires at t=0 with a native error payload',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.error-after-2s',
    category: 'video',
    kind: 'throw',
    describe: 'plays 2 s of progress, then onError',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.error-undefined-payload',
    category: 'video',
    kind: 'malformed',
    describe: 'onError(undefined)',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.error-string-payload',
    category: 'video',
    kind: 'malformed',
    describe: "onError('AVFoundationErrorDomain -11800')",
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.stall-no-events',
    category: 'video',
    kind: 'never',
    describe: 'player never emits progress, end or error (decoder hang)',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.stall-after-first-frame',
    category: 'video',
    kind: 'never',
    describe: 'one progress tick at 0.2 s then silence forever',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-nan',
    category: 'video',
    kind: 'malformed',
    describe: 'every onProgress carries currentTime: NaN',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-negative',
    category: 'video',
    kind: 'malformed',
    describe: 'currentTime goes -5 → -1 then normal',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-empty-object',
    category: 'video',
    kind: 'partial',
    describe: 'onProgress({}) — no currentTime field',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-string-time',
    category: 'video',
    kind: 'malformed',
    describe: "currentTime is the string '2.5'",
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-huge',
    category: 'video',
    kind: 'malformed',
    describe: 'currentTime 1e12 on the first tick',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-out-of-order',
    category: 'video',
    kind: 'sequence',
    describe: 'progress 3, 1, 2, 0, 4 then end',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-flood',
    category: 'video',
    kind: 'sequence',
    describe: '600 progress events inside the first second',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.end-at-0ms',
    category: 'video',
    kind: 'sequence',
    describe: 'onEnd before any progress (zero-length asset)',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.end-twice',
    category: 'video',
    kind: 'sequence',
    describe: 'onEnd fires twice 100 ms apart',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.end-then-error',
    category: 'video',
    kind: 'sequence',
    describe: 'onEnd then onError 50 ms later',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.error-then-end',
    category: 'video',
    kind: 'sequence',
    describe: 'onError then onEnd 50 ms later',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.late-end-30s',
    category: 'video',
    kind: 'slow',
    describe: 'progress stalls at 1 s; onEnd arrives at 30 s (after watchdog)',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.end-at-watchdog-tick',
    category: 'video',
    kind: 'sequence',
    describe: 'onEnd lands on the same tick as the 8 s watchdog',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.progress-after-exit',
    category: 'video',
    kind: 'sequence',
    describe: 'progress keeps firing every 100 ms through and after the exit',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.first-progress-at-7.9s',
    category: 'video',
    kind: 'slow',
    describe: 'first progress (1.5 s) arrives 100 ms before the watchdog',
    excludes: VIDEO_EXCL,
  },
  {
    id: 'video.callbacks-after-unmount',
    category: 'video',
    kind: 'sequence',
    describe:
      'captured onProgress/onEnd/onError invoked after the splash unmounted',
    excludes: VIDEO_EXCL,
  },
  // ── reduce-motion accessibility query ────────────────────────────────────
  {
    id: 'a11y.reduce-motion-true',
    category: 'a11y',
    kind: 'sequence',
    describe: 'reduceMotionChanged(true) before the intro starts',
    excludes: A11Y_EXCL,
  },
  {
    id: 'a11y.reduce-motion-flip-mid-exit',
    category: 'a11y',
    kind: 'sequence',
    describe: 'reduceMotionChanged(true) 200 ms into the exit fade',
    excludes: A11Y_EXCL,
  },
  {
    id: 'a11y.reduce-motion-storm',
    category: 'a11y',
    kind: 'sequence',
    describe: 'reduceMotionChanged toggles 50× during playback',
    excludes: A11Y_EXCL,
  },
  {
    id: 'a11y.reduce-motion-event-null',
    category: 'a11y',
    kind: 'malformed',
    describe: 'reduceMotionChanged(null) then (undefined)',
    excludes: A11Y_EXCL,
  },
  {
    id: 'a11y.reduce-motion-event-string',
    category: 'a11y',
    kind: 'malformed',
    describe: "reduceMotionChanged('true') — a non-boolean truthy value",
    excludes: A11Y_EXCL,
  },
  // ── wall clock ───────────────────────────────────────────────────────────
  {
    id: 'clock.jump-forward-1h-mid-fade',
    category: 'clock',
    kind: 'sequence',
    describe: 'Date.now() jumps +1 h 100 ms into the exit fade',
    excludes: CLOCK_EXCL,
  },
  {
    id: 'clock.jump-backward-5s-mid-fade',
    category: 'clock',
    kind: 'sequence',
    describe: 'Date.now() jumps −5 s 100 ms into the exit fade',
    excludes: CLOCK_EXCL,
  },
  {
    id: 'clock.jump-backward-1h-mid-fade',
    category: 'clock',
    kind: 'sequence',
    describe: 'Date.now() jumps −1 h 100 ms into the exit fade',
    excludes: CLOCK_EXCL,
  },
  {
    id: 'clock.jump-backward-1h-during-playback',
    category: 'clock',
    kind: 'sequence',
    describe: 'Date.now() jumps −1 h at 500 ms, before the watchdog / exit',
    excludes: CLOCK_EXCL,
  },
  {
    id: 'clock.jump-forward-1d-at-launch',
    category: 'clock',
    kind: 'sequence',
    describe: 'Date.now() jumps +24 h at 50 ms (bearer TTL math)',
    excludes: CLOCK_EXCL,
  },
  // ── Keychain (react-native-keychain) ─────────────────────────────────────
  {
    id: 'keychain.get-throws-sync',
    category: 'keychain',
    kind: 'throw',
    describe: 'getGenericPassword throws synchronously',
    excludes: KEYCHAIN_EXCL,
  },
  {
    id: 'keychain.get-rejects',
    category: 'keychain',
    kind: 'reject',
    describe: 'getGenericPassword rejects (errSecInteractionNotAllowed)',
    excludes: KEYCHAIN_EXCL,
  },
  {
    id: 'keychain.get-never-resolves',
    category: 'keychain',
    kind: 'never',
    describe: 'getGenericPassword never settles',
    excludes: KEYCHAIN_EXCL,
  },
  {
    id: 'keychain.get-slow-5s',
    category: 'keychain',
    kind: 'slow',
    describe: 'getGenericPassword resolves after 5 s',
    excludes: KEYCHAIN_EXCL,
  },
  {
    id: 'keychain.get-slow-30s',
    category: 'keychain',
    kind: 'timeout',
    describe: 'getGenericPassword resolves after 30 s',
    excludes: KEYCHAIN_EXCL,
  },
  {
    id: 'keychain.record-not-json',
    category: 'keychain',
    kind: 'malformed',
    describe: "stored password is 'definitely not json'",
    excludes: KEYCHAIN_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'keychain.record-truncated',
    category: 'keychain',
    kind: 'partial',
    describe: 'stored password is a truncated JSON document',
    excludes: KEYCHAIN_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'keychain.record-wrong-shape',
    category: 'keychain',
    kind: 'malformed',
    describe: 'stored record has version 2 and a non-string refresh token',
    excludes: KEYCHAIN_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'keychain.record-non-uuid-account',
    category: 'keychain',
    kind: 'malformed',
    describe: 'record parses but canonicalAppUserId is not a UUID',
    excludes: KEYCHAIN_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'keychain.reset-rejects',
    category: 'keychain',
    kind: 'reject',
    describe:
      'resetGenericPassword rejects (malformed record cannot be cleared)',
    excludes: KEYCHAIN_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  // ── SQLite (op-sqlite through src/data/db) ───────────────────────────────
  {
    id: 'sqlite.open-throws',
    category: 'sqlite',
    kind: 'throw',
    describe: 'getDb() throws (database disk image is malformed)',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.get-rejects-all',
    category: 'sqlite',
    kind: 'reject',
    describe: 'every kv SELECT rejects with SQLITE_IOERR',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.get-rejects-profile-only',
    category: 'sqlite',
    kind: 'reject',
    describe: 'only the profile:<owner> kv SELECT rejects',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.get-never-resolves',
    category: 'sqlite',
    kind: 'never',
    describe: 'every kv SELECT never settles (locked database)',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.get-never-resolves-profile-only',
    category: 'sqlite',
    kind: 'never',
    describe: 'only the profile:<owner> kv SELECT never settles',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.get-slow-5s',
    category: 'sqlite',
    kind: 'slow',
    describe: 'every kv SELECT takes 5 s',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.get-slow-20s',
    category: 'sqlite',
    kind: 'timeout',
    describe:
      'the first kv SELECT takes 20 s (one stalled read), later ones are instant',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.rows-undefined',
    category: 'sqlite',
    kind: 'malformed',
    describe: 'execute resolves { rows: undefined }',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.row-without-value',
    category: 'sqlite',
    kind: 'partial',
    describe: 'execute resolves { rows: [{}] } for every kv read',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.value-object',
    category: 'sqlite',
    kind: 'malformed',
    describe: 'kv value column is an object instead of text',
    excludes: SQLITE_GET_EXCL,
  },
  {
    id: 'sqlite.profile-not-json',
    category: 'sqlite',
    kind: 'malformed',
    describe: "profile:<owner> row holds 'definitely not json'",
    excludes: SQLITE_GET_EXCL,
    requiresInstall: ['existing-vault', 'existing-guest'],
  },
  {
    id: 'sqlite.profile-truncated',
    category: 'sqlite',
    kind: 'partial',
    describe: 'profile:<owner> row holds a truncated JSON document',
    excludes: SQLITE_GET_EXCL,
    requiresInstall: ['existing-vault', 'existing-guest'],
  },
  {
    id: 'sqlite.local-mode-not-json',
    category: 'sqlite',
    kind: 'malformed',
    describe: "auth.local-mode row holds 'not json'",
    excludes: SQLITE_GET_EXCL,
    requiresInstall: ['existing-guest'],
  },
  {
    id: 'sqlite.set-rejects',
    category: 'sqlite',
    kind: 'reject',
    describe: 'every kv INSERT OR REPLACE rejects',
  },
  {
    id: 'sqlite.set-never-resolves',
    category: 'sqlite',
    kind: 'never',
    describe:
      'every kv INSERT OR REPLACE never settles (appStore.hydrate awaits the canonical-profile write when the owner has no local profile row)',
    sweepInstall: 'existing-vault-no-profile',
  },
  {
    id: 'sqlite.all-reject-after-open',
    category: 'sqlite',
    kind: 'reject',
    describe: 'database opens, then every statement rejects',
    excludes: SQLITE_GET_EXCL,
  },
  // ── fetch (/v1/auth/refresh at launch) ───────────────────────────────────
  {
    id: 'fetch.refresh-401',
    category: 'fetch',
    kind: 'reject',
    describe: 'refresh answers 401 (revoked)',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.refresh-403',
    category: 'fetch',
    kind: 'reject',
    describe: 'refresh answers 403',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.refresh-500',
    category: 'fetch',
    kind: 'throw',
    describe: 'refresh answers 500',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.refresh-429',
    category: 'fetch',
    kind: 'throw',
    describe: 'refresh answers 429',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.network-error',
    category: 'fetch',
    kind: 'reject',
    describe: 'fetch rejects TypeError: Network request failed',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.hang',
    category: 'fetch',
    kind: 'never',
    describe: 'refresh never answers (client abort is the only exit)',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.malformed-200',
    category: 'fetch',
    kind: 'malformed',
    describe: 'refresh answers 200 with an HTML body',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.partial-200',
    category: 'fetch',
    kind: 'partial',
    describe: 'refresh answers 200 { session: {} } (no tokens)',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.slow-9s',
    category: 'fetch',
    kind: 'slow',
    describe: 'refresh rotates after 9 s (past the 8 s launch wait)',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.throws-sync',
    category: 'fetch',
    kind: 'throw',
    describe: 'fetch itself throws synchronously',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  {
    id: 'fetch.undefined',
    category: 'fetch',
    kind: 'throw',
    describe: 'globalThis.fetch is undefined for the launch',
    excludes: FETCH_EXCL,
    requiresInstall: ['existing-vault', 'existing-vault-no-profile'],
  },
  // ── Google Sign-In SDK (legacy silent restore) ───────────────────────────
  {
    id: 'google.silent-rejects',
    category: 'google',
    kind: 'reject',
    describe: 'signInSilently rejects',
    excludes: GOOGLE_EXCL,
    requiresInstall: ['legacy-google-flag'],
  },
  {
    id: 'google.silent-throws-sync',
    category: 'google',
    kind: 'throw',
    describe: 'signInSilently throws synchronously',
    excludes: GOOGLE_EXCL,
    requiresInstall: ['legacy-google-flag'],
  },
  {
    id: 'google.silent-never-resolves',
    category: 'google',
    kind: 'never',
    describe: 'signInSilently never settles',
    excludes: GOOGLE_EXCL,
    requiresInstall: ['legacy-google-flag'],
  },
  {
    id: 'google.silent-slow-20s',
    category: 'google',
    kind: 'timeout',
    describe: 'signInSilently answers noSavedCredentialFound after 20 s',
    excludes: GOOGLE_EXCL,
    requiresInstall: ['legacy-google-flag'],
  },
  {
    id: 'google.silent-success-no-token',
    category: 'google',
    kind: 'partial',
    describe: 'signInSilently succeeds without an idToken',
    excludes: GOOGLE_EXCL,
    requiresInstall: ['legacy-google-flag'],
  },
  {
    id: 'google.configure-throws',
    category: 'google',
    kind: 'throw',
    describe: 'GoogleSignin.configure throws (native module missing)',
    excludes: GOOGLE_EXCL,
    requiresInstall: ['legacy-google-flag'],
  },
  // ── notification scheduler (native notifications) ────────────────────────
  {
    id: 'scheduler.module-missing',
    category: 'scheduler',
    kind: 'throw',
    describe:
      'the native notifications module cannot be loaded: every scheduler method rejects (loadModule() throws inside the async methods, as in production when the pod is missing)',
  },
  {
    id: 'scheduler.permission-rejects',
    category: 'scheduler',
    kind: 'reject',
    describe: 'permissionState() rejects',
  },
  {
    id: 'scheduler.apply-never',
    category: 'scheduler',
    kind: 'never',
    describe: 'applyPlan() / cancelAllPlanned() never settle',
  },
  // ── StatusBar native stack ───────────────────────────────────────────────
  {
    id: 'statusbar.push-throws',
    category: 'statusbar',
    kind: 'throw',
    describe: "StatusBar.pushStackEntry throws on the splash's mount",
    excludes: ['statusbar.*'],
  },
  {
    id: 'statusbar.pop-throws',
    category: 'statusbar',
    kind: 'throw',
    describe: "StatusBar.popStackEntry throws on the splash's cleanup",
    excludes: ['statusbar.*'],
  },
  // ── lifecycle around the screen ──────────────────────────────────────────
  {
    id: 'lifecycle.unmount-mid-fade',
    category: 'lifecycle',
    kind: 'sequence',
    describe:
      'the whole App unmounts 200 ms into the exit fade, then 60 s pass',
    excludes: ['lifecycle.*'],
  },
  {
    id: 'lifecycle.unmount-before-watchdog',
    category: 'lifecycle',
    kind: 'sequence',
    describe: 'the whole App unmounts at 3 s, then 60 s pass',
    excludes: ['lifecycle.*'],
  },
  {
    id: 'lifecycle.remount-at-2s',
    category: 'lifecycle',
    kind: 'sequence',
    describe: 'App unmounts and remounts at 2 s (a second cold splash)',
    excludes: ['lifecycle.*'],
  },
  {
    id: 'lifecycle.remount-storm',
    category: 'lifecycle',
    kind: 'sequence',
    describe: '12 unmount/remount cycles 150 ms apart',
    excludes: ['lifecycle.*'],
  },
  {
    id: 'lifecycle.background-during-intro',
    category: 'lifecycle',
    kind: 'sequence',
    describe: 'AppState background at 1 s, active at 3 s',
    excludes: ['lifecycle.*'],
  },
];

export const FAULT_IDS: readonly string[] = FAULT_CATALOG.map(f => f.id);

export function faultById(id: string): FaultSpec {
  const spec = FAULT_CATALOG.find(f => f.id === id);
  if (!spec) throw new Error(`unknown fault ${id}`);
  return spec;
}

function globMatches(pattern: string, id: string): boolean {
  if (pattern.endsWith('*')) return id.startsWith(pattern.slice(0, -1));
  return pattern === id;
}

export function faultsConflict(a: FaultSpec, b: FaultSpec): boolean {
  if (a.id === b.id) return true;
  const ab = (a.excludes ?? []).some(p => globMatches(p, b.id));
  const ba = (b.excludes ?? []).some(p => globMatches(p, a.id));
  return ab || ba;
}

export function faultApplies(spec: FaultSpec, install: InstallKind): boolean {
  return !spec.requiresInstall || spec.requiresInstall.includes(install);
}

/** Install kinds in which the fault actually bites, preferring the first. */
export function defaultInstallFor(spec: FaultSpec): InstallKind {
  return spec.sweepInstall ?? spec.requiresInstall?.[0] ?? 'existing-vault';
}

// ─── Async fault plumbing ────────────────────────────────────────────────────

export type AsyncMode = 'ok' | 'throw' | 'reject' | 'never' | 'slow';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

// ─── SQLite double ───────────────────────────────────────────────────────────

export type RowShape =
  'ok' | 'rows-undefined' | 'row-without-value' | 'value-object';

export interface DbFaults {
  open: 'ok' | 'throw';
  get: AsyncMode;
  /** null → every key; otherwise only these keys are affected by `get`. */
  getKeys: readonly string[] | null;
  getDelayMs: number;
  /** Apply `get` to the first affected SELECT only, then revert to 'ok'. */
  getOnce: boolean;
  set: AsyncMode;
  setDelayMs: number;
  rows: RowShape;
  /** After a successful open, every statement rejects. */
  allReject: boolean;
}

export function defaultDbFaults(): DbFaults {
  return {
    open: 'ok',
    get: 'ok',
    getKeys: null,
    getDelayMs: 0,
    getOnce: false,
    set: 'ok',
    setDelayMs: 0,
    rows: 'ok',
    allReject: false,
  };
}

export class FaultDb {
  readonly kv = new Map<string, string>();
  readonly statements: { sql: string; params: unknown[]; at: number }[] = [];
  faults: DbFaults = defaultDbFaults();
  now: () => number = () => 0;

  private affected(key: string): boolean {
    return this.faults.getKeys === null || this.faults.getKeys.includes(key);
  }

  destructiveStatements(): string[] {
    return this.statements
      .map(entry => entry.sql)
      .filter(sql => /^(DELETE|DROP|UPDATE|ALTER|TRUNCATE)\b/i.test(sql));
  }

  kvWrites(): { key: string; value: string }[] {
    return this.statements
      .filter(entry => entry.sql.startsWith('INSERT OR REPLACE INTO kv'))
      .map(entry => ({
        key: String(entry.params[0]),
        value: String(entry.params[1]),
      }));
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries([...this.kv.entries()].sort());
  }

  handle(): LocalDb {
    if (this.faults.open === 'throw') {
      throw new Error('database disk image is malformed (simulated)');
    }
    return {
      execute: async (sql: string, params: unknown[] = []) => {
        const statement = sql.trim().replace(/\s+/g, ' ');
        this.statements.push({ sql: statement, params, at: this.now() });
        if (this.faults.allReject) {
          throw new Error('SQLITE_IOERR (simulated, post-open)');
        }
        if (statement.startsWith('SELECT value FROM kv')) {
          const key = String(params[0]);
          if (this.affected(key)) {
            const mode = this.faults.get;
            if (this.faults.getOnce) this.faults.get = 'ok';
            switch (mode) {
              case 'throw':
              case 'reject':
                throw new Error(`SQLITE_IOERR (simulated) reading kv ${key}`);
              case 'never':
                return never();
              case 'slow':
                await sleep(this.faults.getDelayMs);
                break;
              case 'ok':
                break;
            }
            switch (this.faults.rows) {
              case 'rows-undefined':
                return { rows: undefined } as unknown as { rows: never[] };
              case 'row-without-value':
                return { rows: [{}] };
              case 'value-object':
                return { rows: [{ value: { nested: true } }] };
              case 'ok':
                break;
            }
          }
          const value = this.kv.get(key);
          return { rows: value === undefined ? [] : [{ value }] };
        }
        if (statement.startsWith('INSERT OR REPLACE INTO kv')) {
          const key = String(params[0]);
          switch (this.faults.set) {
            case 'throw':
            case 'reject':
              throw new Error(`SQLITE_IOERR (simulated) writing kv ${key}`);
            case 'never':
              return never();
            case 'slow':
              await sleep(this.faults.setDelayMs);
              break;
            case 'ok':
              break;
          }
          this.kv.set(key, String(params[1]));
          return { rows: [] };
        }
        if (/^DELETE FROM kv WHERE key/.test(statement)) {
          for (const param of params) this.kv.delete(String(param));
          return { rows: [] };
        }
        return { rows: [] };
      },
      close: () => {},
    };
  }
}

// ─── Keychain double ─────────────────────────────────────────────────────────

export interface KeychainFaults {
  get: AsyncMode;
  getDelayMs: number;
  reset: AsyncMode;
  set: AsyncMode;
}

export class FaultKeychain {
  readonly store = new Map<string, { username: string; password: string }>();
  readonly log: { op: 'get' | 'set' | 'reset'; at: number }[] = [];
  faults: KeychainFaults = { get: 'ok', getDelayMs: 0, reset: 'ok', set: 'ok' };
  now: () => number = () => 0;

  private async gate(mode: AsyncMode, delayMs: number, what: string) {
    switch (mode) {
      case 'throw':
        throw new Error(`Keychain ${what} failed synchronously (simulated)`);
      case 'reject':
        await Promise.reject(
          new Error(`errSecInteractionNotAllowed (simulated ${what})`),
        );
        return;
      case 'never':
        await never();
        return;
      case 'slow':
        await sleep(delayMs);
        return;
      case 'ok':
        return;
    }
  }

  /** The module surface `react-native-keychain` exposes to sessionVault. */
  module() {
    return {
      ACCESSIBLE: {
        AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY:
          'AccessibleAfterFirstUnlockThisDeviceOnly',
      },
      setGenericPassword: (
        username: string,
        password: string,
        options: { service?: string } = {},
      ) => {
        this.log.push({ op: 'set', at: this.now() });
        if (this.faults.set === 'throw') {
          throw new Error('Keychain set failed synchronously (simulated)');
        }
        return (async () => {
          await this.gate(this.faults.set, 0, 'set');
          this.store.set(options.service ?? '__default__', {
            username,
            password,
          });
          return { service: options.service, storage: 'mock' };
        })();
      },
      getGenericPassword: (options: { service?: string } = {}) => {
        this.log.push({ op: 'get', at: this.now() });
        if (this.faults.get === 'throw') {
          throw new Error('Keychain get failed synchronously (simulated)');
        }
        return (async () => {
          await this.gate(this.faults.get, this.faults.getDelayMs, 'get');
          const item = this.store.get(options.service ?? '__default__');
          if (!item) return false as const;
          return { service: options.service, storage: 'mock', ...item };
        })();
      },
      resetGenericPassword: (options: { service?: string } = {}) => {
        this.log.push({ op: 'reset', at: this.now() });
        if (this.faults.reset === 'throw') {
          throw new Error('Keychain reset failed synchronously (simulated)');
        }
        return (async () => {
          await this.gate(this.faults.reset, 0, 'reset');
          return this.store.delete(options.service ?? '__default__');
        })();
      },
    };
  }
}

// ─── fetch double ────────────────────────────────────────────────────────────

export type ServerMode =
  | 'rotate'
  | 'refuse-401'
  | 'refuse-403'
  | 'error-500'
  | 'error-429'
  | 'network'
  | 'hang'
  | 'malformed-200'
  | 'partial-200'
  | 'throw-sync';

export interface RefreshCall {
  at: number;
  token: string;
  outcome: string;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export class FaultServer {
  mode: ServerMode = 'rotate';
  latencyMs = 0;
  readonly valid = new Set<string>();
  readonly refreshCalls: RefreshCall[] = [];
  readonly otherCalls: string[] = [];
  now: () => number = () => 0;
  private counter = 0;

  constructor(readonly apiBase: string) {}

  seed(token: string): void {
    this.valid.add(token);
  }

  private readonly openDelays = new Set<() => void>();

  /** Requests still open at teardown (each holds one server-side timer). */
  get inFlight(): number {
    return this.openDelays.size;
  }

  /**
   * Teardown: the network goes away. Every open request fails with a network
   * error so the app's own timeout guards get their `finally`. What is still
   * pending on the fake clock afterwards belongs to the app.
   */
  dropConnections(): void {
    for (const drop of [...this.openDelays]) drop();
  }

  private delay(ms: number, signal: AbortSignal | null | undefined) {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.openDelays.delete(drop);
        resolve();
      }, ms);
      const drop = () => {
        clearTimeout(timer);
        this.openDelays.delete(drop);
        reject(new TypeError('Network request failed (connection dropped)'));
      };
      this.openDelays.add(drop);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        this.openDelays.delete(drop);
        reject(new Error('AbortError (simulated fetch abort)'));
      });
    });
  }

  readonly fetch = (url: string, init: RequestInit = {}): Promise<Response> => {
    if (this.mode === 'throw-sync') {
      throw new TypeError('fetch is not a function (simulated)');
    }
    return this.handle(url, init);
  };

  private async handle(url: string, init: RequestInit): Promise<Response> {
    const signal = init.signal;
    if (url === `${this.apiBase}/v1/auth/refresh`) {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        refreshToken?: string;
      };
      const token = String(body.refreshToken ?? '');
      const call: RefreshCall = { at: this.now(), token, outcome: 'pending' };
      this.refreshCalls.push(call);
      try {
        if (this.mode === 'hang') {
          await this.delay(10 * 60_000, signal);
          call.outcome = 'hang-elapsed';
          return new Response(null, { status: 599 });
        }
        await this.delay(this.latencyMs, signal);
        switch (this.mode) {
          case 'refuse-401':
            call.outcome = '401';
            return jsonResponse(401, { error: { message: 'revoked' } });
          case 'refuse-403':
            call.outcome = '403';
            return jsonResponse(403, { error: { message: 'forbidden' } });
          case 'error-500':
            call.outcome = '500';
            return jsonResponse(500, { error: { message: 'boom' } });
          case 'error-429':
            call.outcome = '429';
            return jsonResponse(429, { error: { message: 'slow down' } });
          case 'network':
            call.outcome = 'network-error';
            throw new TypeError('Network request failed');
          case 'malformed-200':
            call.outcome = '200-malformed';
            return new Response('<html>not json</html>', { status: 200 });
          case 'partial-200':
            call.outcome = '200-partial';
            return jsonResponse(200, { session: {} });
          default: {
            if (this.valid.has(token)) {
              this.counter += 1;
              const next = {
                access: `access-${this.counter}`,
                refresh: `refresh-${this.counter}`,
                exp: Math.floor(Date.now() / 1000) + 3600,
              };
              this.valid.delete(token);
              this.valid.add(next.refresh);
              call.outcome = `rotated→${next.refresh}`;
              return jsonResponse(200, {
                session: {
                  accessToken: next.access,
                  refreshToken: next.refresh,
                  expiresAt: next.exp,
                },
              });
            }
            call.outcome = '401-unknown-token';
            return jsonResponse(401, {
              error: { message: 'The session could not be refreshed.' },
            });
          }
        }
      } catch (error) {
        if (call.outcome === 'pending') {
          call.outcome =
            error instanceof TypeError
              ? 'dropped-at-teardown'
              : 'aborted-by-client';
        }
        throw error;
      }
    }
    this.otherCalls.push(url);
    if (url === `${this.apiBase}/v1/me`) {
      await this.delay(Math.min(this.latencyMs, 200), signal);
      return jsonResponse(200, {
        onboardingState: 'complete',
        profile: {
          skill_level: 'intermediate',
          handedness: 'right',
          primary_goal: 'consistency',
          biggest_problem: 'popups',
          first_name: 'Server',
        },
      });
    }
    if (url === `${this.apiBase}/v1/auth/logout`) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(404, { error: { message: 'unexpected route' } });
  }
}

// ─── Google Sign-In double ───────────────────────────────────────────────────

export type GoogleSilentMode =
  | 'no-credential'
  | 'reject'
  | 'throw-sync'
  | 'never'
  | 'slow'
  | 'success-no-token';

export class FaultGoogle {
  silent: GoogleSilentMode = 'no-credential';
  silentDelayMs = 0;
  configureThrows = false;
  hasPrevious = true;
  readonly calls: string[] = [];

  module() {
    return {
      GoogleSignin: {
        configure: () => {
          this.calls.push('configure');
          if (this.configureThrows) {
            throw new Error('RNGoogleSignin native module missing (simulated)');
          }
        },
        hasPlayServices: async () => true,
        hasPreviousSignIn: () => {
          this.calls.push('hasPreviousSignIn');
          return this.hasPrevious;
        },
        signIn: async () => {
          throw new Error('interactive sign-in is not part of launch');
        },
        signInSilently: () => {
          this.calls.push('signInSilently');
          if (this.silent === 'throw-sync') {
            throw new Error('signInSilently threw synchronously (simulated)');
          }
          return (async () => {
            switch (this.silent) {
              case 'reject':
                throw new Error('SIGN_IN_REQUIRED (simulated)');
              case 'never':
                return never<{ type: string; data?: { idToken?: string } }>();
              case 'slow':
                await sleep(this.silentDelayMs);
                return { type: 'noSavedCredentialFound' as const };
              case 'success-no-token':
                return { type: 'success' as const, data: { idToken: null } };
              default:
                return { type: 'noSavedCredentialFound' as const };
            }
          })();
        },
        signOut: async () => {},
        revokeAccess: async () => {},
      },
    };
  }
}

// ─── Notification scheduler double ───────────────────────────────────────────

export class FaultScheduler {
  moduleMissing = false;
  permissionRejects = false;
  applyNever = false;
  readonly applied: unknown[][] = [];
  cancelAllCalls = 0;

  private loadModule(): void {
    if (this.moduleMissing) {
      throw new Error(
        "Cannot find module 'react-native-notify-kit' (simulated)",
      );
    }
  }

  port() {
    return {
      permissionState: async () => {
        this.loadModule();
        if (this.permissionRejects) {
          throw new Error('UNNotificationCenter unavailable (simulated)');
        }
        return 'granted' as const;
      },
      requestPermission: async () => {
        this.loadModule();
        return 'granted' as const;
      },
      applyPlan: async (plan: readonly unknown[]) => {
        this.loadModule();
        if (this.applyNever) return never<void>();
        this.applied.push([...plan]);
      },
      cancelAllPlanned: async () => {
        this.cancelAllCalls += 1;
        this.loadModule();
        if (this.applyNever) return never<void>();
      },
      openSystemSettings: async () => {
        this.loadModule();
      },
    };
  }
}

// ─── The world ───────────────────────────────────────────────────────────────

export interface TimelineEvent {
  at: number;
  kind: string;
  detail?: Record<string, unknown>;
}

export class FaultWorld {
  db = new FaultDb();
  keychain = new FaultKeychain();
  server: FaultServer;
  google = new FaultGoogle();
  scheduler = new FaultScheduler();
  statusBar = { pushThrows: false, popThrows: false };
  fetchUndefined = false;
  readonly timeline: TimelineEvent[] = [];
  now: () => number = () => 0;

  constructor(apiBase: string) {
    this.server = new FaultServer(apiBase);
  }

  bindClock(now: () => number): void {
    this.now = now;
    this.db.now = now;
    this.keychain.now = now;
    this.server.now = now;
  }

  log(kind: string, detail?: Record<string, unknown>): void {
    this.timeline.push({ at: this.now(), kind, ...(detail ? { detail } : {}) });
  }
}
