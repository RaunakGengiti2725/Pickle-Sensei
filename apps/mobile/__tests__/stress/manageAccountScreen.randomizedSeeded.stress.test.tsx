/**
 * Seeded randomized long-run stress for ManageAccountScreen.
 *
 * The screen is rendered inside the real providers the app uses — a real
 * `SafeAreaProvider`, a real `NavigationContainer` + native-stack navigator
 * (a stub "Settings"-like host route sits underneath so Back has somewhere
 * to go, exactly like Settings → Manage account in RootNavigator), the real
 * `BrandNoticeHost`, the real zustand auth/api-session stores and the REAL
 * `src/account/deletion` client. Only native boundaries are replaced: the
 * SQLite handle (unavailable in jest), Keychain (repo `__mocks__`), Linking
 * (jest preset mock, given a promise-returning implementation) and
 * `globalThis.fetch` (scripted: every call becomes a pending entry the
 * generator settles later with a chosen wire outcome, honouring the
 * client's 15 s AbortController timeout).
 *
 * A hand-rolled seeded RNG (mulberry32) generates legal/near-legal action
 * sequences (length 5–60) over the screen's public surface — every tap the
 * user can make, typing in the comment box, wall-clock ticks, server
 * responses, hardware back, programmatic navigation pop/push (deep-link /
 * parent reset), and store-level session changes (implicit sign-out). After
 * EVERY action the rendered tree is compared against an executable model of
 * the invariants documented in ManageAccountScreen.tsx / AGENTS.md
 * ("nothing is deleted until the second explicit tap succeeds server-side",
 * survey never blocks deletion, busy phases cannot be dismissed, stale
 * continuations never touch a later presentation, one request in flight at
 * a time, countdown 5→0 never wraps, ...).
 *
 * Every sequence is replayable from its seed. The default campaign is small
 * so the suite stays fast; the full run is `STRESS_ITER=2000`. Set
 * `STRESS_OUT=/abs/path.json` to write the seed → outcome table (with every
 * failing seed minimized by ddmin, re-run 10× for a flake rate, and a
 * same-seed-twice determinism check) — see the header of that file.
 *
 *   STRESS_ITER=250 STRESS_SEED=20260904 STRESS_OUT=/tmp/ma.json \
 *     npx jest --ci __tests__/stress/manageAccountScreen.randomizedSeeded
 *
 * Keep a single process to a few hundred seeds: each real-navigator
 * mount/unmount retains memory in the jest process (navigation/test infra,
 * not the screen — see `manageAccountScreen.campaign.mjs`), so the full
 * 2000-seed campaign is driven as shards by that script:
 *
 *   node __tests__/stress/manageAccountScreen.campaign.mjs \
 *     --iterations 2000 --seed 20260904 --shard 250 --concurrency 4 \
 *     --out /tmp/manage-account-campaign
 */
import React from 'react';
import { writeFileSync } from 'fs';
import { Linking, Modal, Pressable, Text, TextInput } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';

jest.mock('../../src/config/authConfig', () => ({
  GOOGLE_WEB_CLIENT_ID: null,
  GOOGLE_IOS_CLIENT_ID: null,
}));

jest.mock('../../src/data/db', () => ({
  getDb: () => {
    throw new Error('no native sqlite in jest');
  },
}));

import { NavigationContainer, useNavigation } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ManageAccountScreen } from '../../src/screens/ManageAccountScreen';
import { BrandNoticeHost } from '../../src/design/BrandNotice';
import { Button } from '../../src/design/components';
import { useAuthStore, type AuthSession } from '../../src/auth/authStore';
import {
  clearApiSession,
  establishApiSession,
  getApiSession,
  type ApiSession,
} from '../../src/account/apiSession';
import {
  ACCOUNT_DELETION_DETAILS_MAX,
  type AccountDeletionSurvey,
} from '../../src/account/deletion';
import { getRuntimePublicConfig } from '../../src/config/runtimeConfig';

// ---------------------------------------------------------------------------
// Campaign knobs
// ---------------------------------------------------------------------------

const ITERATIONS = Math.max(1, Number(process.env.STRESS_ITER ?? 40));
const BASE_SEED = Number(process.env.STRESS_SEED ?? 20260904) >>> 0;
const OUT_PATH = process.env.STRESS_OUT ?? null;
/** `STRESS_HEAP_EVERY=N` samples `process.memoryUsage()` every N seeds
 * (after `global.gc()` when node runs with `--expose-gc`) into the report. */
const HEAP_EVERY = Math.max(0, Number(process.env.STRESS_HEAP_EVERY ?? 0));
const MIN_LEN = 5;
const MAX_LEN = 60;
const FLAKE_RERUNS = 10;
/** Every Nth seed (plus every failing seed) is replayed for determinism. */
const DETERMINISM_EVERY = 10;

jest.setTimeout(Math.max(30_000, ITERATIONS * 3_000));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CANONICAL_ID = '11111111-1111-4111-8111-111111111111';
const API_BASE = 'https://api.example.test';
const BEARER = 'access-token-stress';

const syncedSession: AuthSession = {
  provider: 'google',
  subject: CANONICAL_ID,
  canonicalAppUserId: CANONICAL_ID,
  localOnly: false,
  displayName: 'Alex Chen',
  email: 'alex@example.com',
};

const localOnlySession: AuthSession = {
  provider: 'guest',
  subject: 'local-only',
  canonicalAppUserId: null,
  localOnly: true,
  displayName: null,
  email: null,
};

const apiSession: ApiSession = {
  apiBaseUrl: API_BASE,
  bearerToken: BEARER,
  canonicalAppUserId: CANONICAL_ID,
  provider: 'google',
};

const REASONS = [
  'not_using',
  'not_helpful',
  'scores_inaccurate',
  'technical_issues',
  'too_expensive',
  'privacy',
  'other',
] as const;
const REASON_LABELS = [
  "I don't use it enough",
  "It hasn't improved my game",
  'The technique reads felt off',
  'Bugs, crashes, or camera trouble',
  "It's too expensive",
  'Privacy or data concerns',
  'Something else',
];
const WANTED = [
  'accuracy',
  'price',
  'content',
  'stability',
  'switched',
  'nothing',
] as const;
const WANTED_LABELS = [
  'More accurate technique reads',
  'A lower price or a free tier',
  'More drills and coaching guidance',
  'Fewer bugs and smoother capture',
  "Nothing — I've found another app or a coach",
  "Nothing — I just don't need it anymore",
];

const DETAIL_VARIANTS: readonly string[] = [
  '',
  ' ',
  '\n\t  ',
  'a',
  'ok thanks',
  'The camera kept losing me mid-rally.',
  '  padded on both sides  ',
  'x'.repeat(ACCOUNT_DELETION_DETAILS_MAX),
  'y'.repeat(ACCOUNT_DELETION_DETAILS_MAX - 1) + ' ',
  '🎾 emoji + "quotes" + <tags> & ampersands',
  '\u200b', // zero-width space: non-empty but looks blank
];

const CHALLENGE_ID = '33333333-3333-4333-8333-333333333333';
const REQUEST_TIMEOUT_MS = 15_000;
const ARM_SECONDS = 5;

const COPY = {
  q1: "What's making you leave?",
  q2: 'What would have kept you?',
  review: 'Delete your account?',
  details: 'Account details',
  requestDefault:
    'The deletion request could not be completed. Nothing was deleted.',
  offline:
    'Account deletion is temporarily offline. Nothing was deleted — please try again.',
  expired: 'Your sign-in has expired. Sign in again, then delete your account.',
  invalidResponse: 'The server returned an invalid deletion response.',
  invalidChallenge: 'The server returned an invalid deletion challenge.',
  notConfirmed: 'The server did not confirm the deletion.',
  notConfigured: 'Sign in to a synced account before deleting it.',
  serverMessage: 'Deletion is paused for this account.',
  cleanupNotice: 'LOCAL CLEANUP NEEDED',
  storeNotice: 'STORE UNAVAILABLE',
} as const;

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — every sequence is a pure function of its seed.
// ---------------------------------------------------------------------------

class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = seed >>> 0;
  }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }
  pick<T>(items: readonly T[]): T {
    const item = items[this.int(items.length)];
    if (item === undefined) throw new Error('pick from empty list');
    return item;
  }
  weighted<T>(entries: ReadonlyArray<readonly [number, T]>): T {
    const total = entries.reduce((sum, [w]) => sum + w, 0);
    let roll = this.next() * total;
    for (const [w, value] of entries) {
      roll -= w;
      if (roll < 0) return value;
    }
    const last = entries[entries.length - 1];
    if (!last) throw new Error('weighted pick from empty list');
    return last[1];
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

type RequestOutcome =
  | 'ok'
  | 'http401'
  | 'http403_message'
  | 'http429'
  | 'http500'
  | 'http200_not_json'
  | 'http200_missing_challenge'
  | 'network';
type ConfirmOutcome =
  | 'ok_not_applicable'
  | 'ok_revoked'
  | 'ok_manual_action'
  | 'ok_legacy_shape'
  | 'http200_not_deleted'
  | 'http401'
  | 'http409_message'
  | 'http429'
  | 'http500'
  | 'network';

type Action =
  | { kind: 'tap'; label: string }
  | { kind: 'tap_button'; label: string }
  | { kind: 'type_details'; variant: number }
  | { kind: 'hardware_back' }
  | { kind: 'tick'; ms: number }
  | { kind: 'settle_request'; outcome: RequestOutcome }
  | { kind: 'settle_confirm'; outcome: ConfirmOutcome }
  | { kind: 'nav_pop' }
  | { kind: 'nav_push' }
  | { kind: 'session_signout' }
  | { kind: 'session_local_only' }
  | { kind: 'session_restore' }
  | { kind: 'store_link_fails'; fails: boolean };

const REQUEST_OUTCOMES: readonly RequestOutcome[] = [
  'ok',
  'ok',
  'ok',
  'ok',
  'http401',
  'http403_message',
  'http429',
  'http500',
  'http200_not_json',
  'http200_missing_challenge',
  'network',
];
const CONFIRM_OUTCOMES: readonly ConfirmOutcome[] = [
  'ok_not_applicable',
  'ok_revoked',
  'ok_manual_action',
  'ok_legacy_shape',
  'http200_not_deleted',
  'http401',
  'http409_message',
  'http429',
  'http500',
  'network',
];
const TICKS = [1, 250, 999, 1000, 1001, 2500, 5000, 5001, 16000];

const LABELS = {
  deleteAccount: 'Delete account',
  screenBack: 'Back',
  hostOpen: 'Open Manage account',
  skipSurvey: 'Skip the survey',
  skipQ2: 'Skip this question',
  backQ: 'Back to the previous question',
  closeSurvey: 'Close and keep my account',
  closeConfirm: 'Close account deletion confirmation',
  backdrop: 'Cancel account deletion',
  storeLink: 'Manage subscription in the App Store',
  detailsInput: 'Anything else you want us to know',
} as const;
const BUTTONS = {
  next: 'Next',
  cont: 'Continue',
  keep: 'Keep my account',
  request: 'Continue to delete',
  confirm: 'Permanently delete',
  gotIt: 'Got it',
} as const;

// ---------------------------------------------------------------------------
// Model — the invariants, executable.
// ---------------------------------------------------------------------------

type Phase = 'why' | 'kept' | 'review' | 'requesting' | 'armed' | 'deleting';
type SessionKind = 'synced' | 'local_only' | 'none';

interface PendingCall {
  id: number;
  kind: 'request' | 'confirm';
  /** Presentation the continuation belongs to; stale once the dialog closed. */
  presentation: number;
  /** Mount generation of the screen the call was made from. */
  mountGen: number;
  survey: AccountDeletionSurvey | null;
  challenge: string | null;
  abortAt: number;
}

interface Model {
  now: number;
  mounted: boolean;
  mountGen: number;
  session: SessionKind;
  apiSession: boolean;
  open: boolean;
  presentation: number;
  phase: Phase;
  reason: (typeof REASONS)[number] | null;
  wanted: (typeof WANTED)[number] | null;
  details: string;
  survey: AccountDeletionSurvey | null;
  error: string | null;
  challenge: string | null;
  secondsLeft: number;
  /** Fake-clock instant the countdown started (armed with seconds > 0). */
  armedAt: number | null;
  pending: PendingCall[];
  nextFetchId: number;
  fetchCalls: number;
  completeCalls: number;
  deleted: boolean;
  notice: string | null;
  storeLinkFails: boolean;
  storeOpens: number;
}

function freshModel(): Model {
  return {
    now: 0,
    mounted: false,
    mountGen: 0,
    session: 'synced',
    apiSession: true,
    open: false,
    presentation: 0,
    phase: 'why',
    reason: null,
    wanted: null,
    details: '',
    survey: null,
    error: null,
    challenge: null,
    secondsLeft: 0,
    armedAt: null,
    pending: [],
    nextFetchId: 1,
    fetchCalls: 0,
    completeCalls: 0,
    deleted: false,
    notice: null,
    storeLinkFails: false,
    storeOpens: 0,
  };
}

function modelBusy(m: Model): boolean {
  return m.open && (m.phase === 'requesting' || m.phase === 'deleting');
}

function modelDialogPage(m: Model): 'q1' | 'q2' | 'confirm' | null {
  if (!m.mounted || !m.open) return null;
  if (m.phase === 'why') return 'q1';
  if (m.phase === 'kept') return 'q2';
  return 'confirm';
}

function buildSurvey(
  m: Model,
  keptAnswer: (typeof WANTED)[number] | null,
  comment: string,
): AccountDeletionSurvey | null {
  if (m.reason === null) return null;
  const trimmed = comment.trim();
  return {
    reason: m.reason,
    wanted: keptAnswer,
    details: trimmed.length > 0 ? trimmed : null,
    platform: 'ios',
    appVersion: getRuntimePublicConfig().appVersion,
  };
}

/** Resets everything the dialog owns (mirrors the `!visible` effect). */
function modelCloseDialog(m: Model) {
  if (!m.open) return;
  m.open = false;
  m.presentation += 1;
  m.phase = 'why';
  m.reason = null;
  m.wanted = null;
  m.details = '';
  m.survey = null;
  m.error = null;
  m.challenge = null;
  m.secondsLeft = 0;
  m.armedAt = null;
}

function modelUnmount(m: Model) {
  if (!m.mounted) return;
  m.mounted = false;
  m.open = false;
  m.presentation += 1;
  m.phase = 'why';
  m.reason = null;
  m.wanted = null;
  m.details = '';
  m.survey = null;
  m.error = null;
  m.challenge = null;
  m.secondsLeft = 0;
  m.armedAt = null;
}

function modelMount(m: Model) {
  m.mounted = true;
  m.mountGen += 1;
  m.open = false;
  m.phase = 'why';
  m.reason = null;
  m.wanted = null;
  m.details = '';
  m.survey = null;
  m.error = null;
  m.challenge = null;
  m.secondsLeft = 0;
  m.armedAt = null;
}

/** The server account is gone: the screen closes the dialog and the auth
 * store's completeAccountDeletion() purges the local identity. */
function modelDeleted(m: Model) {
  m.deleted = true;
  m.completeCalls += 1;
  m.session = 'none';
  m.apiSession = false;
  if (m.mounted) modelCloseDialog(m);
  // getDb() throws in jest → the owner purge fails → the cleanup notice.
  m.notice = COPY.cleanupNotice;
}

/** A pending call whose continuation is still live for the current dialog. */
function isLive(m: Model, call: PendingCall): boolean {
  return (
    m.mounted &&
    call.mountGen === m.mountGen &&
    m.open &&
    call.presentation === m.presentation
  );
}

function requestError(outcome: RequestOutcome | 'abort'): string {
  switch (outcome) {
    case 'ok':
      throw new Error('not an error');
    case 'http401':
      return COPY.expired;
    case 'http403_message':
      return COPY.serverMessage;
    case 'http429':
    case 'http500':
      return COPY.requestDefault;
    case 'http200_not_json':
      return COPY.invalidResponse;
    case 'http200_missing_challenge':
      return COPY.invalidChallenge;
    case 'network':
    case 'abort':
      return COPY.offline;
  }
}

function confirmFailure(
  outcome: ConfirmOutcome | 'abort',
): { message: string; retryable: boolean } | null {
  switch (outcome) {
    case 'ok_not_applicable':
    case 'ok_revoked':
    case 'ok_manual_action':
    case 'ok_legacy_shape':
      return null;
    case 'http200_not_deleted':
      return { message: COPY.notConfirmed, retryable: false };
    case 'http401':
      return { message: COPY.expired, retryable: false };
    case 'http409_message':
      return { message: COPY.serverMessage, retryable: false };
    case 'http429':
    case 'http500':
      return { message: COPY.requestDefault, retryable: true };
    case 'network':
    case 'abort':
      return { message: COPY.offline, retryable: true };
  }
}

function modelSettleRequest(
  m: Model,
  call: PendingCall,
  outcome: RequestOutcome | 'abort',
) {
  m.pending = m.pending.filter(p => p.id !== call.id);
  if (!isLive(m, call)) return;
  if (outcome === 'ok') {
    m.phase = 'armed';
    m.challenge = CHALLENGE_ID;
    m.secondsLeft = ARM_SECONDS;
    m.armedAt = m.now;
    m.error = null;
    return;
  }
  m.phase = 'review';
  m.error = requestError(outcome);
}

function modelSettleConfirm(
  m: Model,
  call: PendingCall,
  outcome: ConfirmOutcome | 'abort',
) {
  m.pending = m.pending.filter(p => p.id !== call.id);
  const failure = confirmFailure(outcome);
  if (failure === null) {
    // onDeleted has no presentation guard on purpose: the account IS gone.
    modelDeleted(m);
    return;
  }
  if (!isLive(m, call)) return;
  if (failure.retryable) {
    m.phase = 'armed';
    m.challenge = call.challenge;
    m.secondsLeft = 0;
    m.armedAt = null;
  } else {
    m.phase = 'review';
    m.challenge = null;
  }
  m.error = failure.message;
}

/** Advance the fake clock: countdown ticks and 15 s request timeouts, in
 * timestamp order (jest fires timers in due-time order). */
function modelTick(m: Model, ms: number) {
  const end = m.now + ms;
  for (;;) {
    let nextAt = Infinity;
    let which: 'countdown' | PendingCall | null = null;
    if (m.armedAt !== null && m.secondsLeft > 0) {
      const ticksSoFar = ARM_SECONDS - m.secondsLeft;
      const at = m.armedAt + (ticksSoFar + 1) * 1000;
      if (at < nextAt) {
        nextAt = at;
        which = 'countdown';
      }
    }
    for (const call of m.pending) {
      if (call.abortAt < nextAt) {
        nextAt = call.abortAt;
        which = call;
      }
    }
    if (which === null || nextAt > end) break;
    m.now = nextAt;
    if (which === 'countdown') {
      m.secondsLeft -= 1;
      if (m.secondsLeft <= 0) {
        m.secondsLeft = 0;
        m.armedAt = null;
      }
    } else if (which.kind === 'request') {
      modelSettleRequest(m, which, 'abort');
    } else {
      modelSettleConfirm(m, which, 'abort');
    }
  }
  m.now = end;
}

type TapPrediction = 'absent' | 'disabled' | 'behind_modal' | 'fires';

/** Where a labelled control is and whether a finger can reach it. */
function predictTap(m: Model, label: string, isButton: boolean): TapPrediction {
  if (isButton && label === BUTTONS.gotIt)
    return m.notice === null ? 'absent' : 'fires';
  const beneath = predictTapBeneathNotice(m, label, isButton);
  // The notice dialog is presented on top of everything: whatever exists
  // underneath is unreachable, whatever does not exist stays absent.
  if (m.notice !== null && beneath !== 'absent') return 'behind_modal';
  return beneath;
}

function predictTapBeneathNotice(
  m: Model,
  label: string,
  isButton: boolean,
): TapPrediction {
  const page = modelDialogPage(m);
  const busy = modelBusy(m);
  if (isButton) {
    switch (label) {
      case BUTTONS.gotIt:
        return 'absent';
      case BUTTONS.next:
        if (page !== 'q1') return 'absent';
        return m.reason === null ? 'disabled' : 'fires';
      case BUTTONS.cont:
        if (page !== 'q2') return 'absent';
        return m.wanted === null && m.details.trim().length === 0
          ? 'disabled'
          : 'fires';
      case BUTTONS.keep:
        if (page !== 'confirm') return 'absent';
        return busy ? 'disabled' : 'fires';
      case BUTTONS.request:
        if (page !== 'confirm') return 'absent';
        if (m.phase === 'review') return 'fires';
        if (m.phase === 'requesting') return 'disabled';
        return 'absent';
      case BUTTONS.confirm:
        if (page !== 'confirm') return 'absent';
        if (m.phase === 'armed')
          return m.secondsLeft > 0 ? 'disabled' : 'fires';
        if (m.phase === 'deleting') return 'disabled';
        return 'absent';
      default:
        return 'absent';
    }
  }
  switch (label) {
    case LABELS.hostOpen:
      // The host route stays mounted underneath the pushed screen.
      return m.mounted ? 'behind_modal' : 'fires';
    case LABELS.deleteAccount:
      if (!m.mounted || m.session !== 'synced') return 'absent';
      return m.open ? 'behind_modal' : 'fires';
    case LABELS.screenBack:
      if (!m.mounted) return 'absent';
      return m.open ? 'behind_modal' : 'fires';
    case LABELS.skipSurvey:
      return page === 'q1' ? 'fires' : 'absent';
    case LABELS.skipQ2:
      return page === 'q2' ? 'fires' : 'absent';
    case LABELS.backQ:
      return page === 'q2' ? 'fires' : 'absent';
    case LABELS.closeSurvey:
      return page === 'q1' || page === 'q2' ? 'fires' : 'absent';
    case LABELS.closeConfirm:
      if (page !== 'confirm') return 'absent';
      return busy ? 'disabled' : 'fires';
    case LABELS.backdrop:
      if (page === null) return 'absent';
      return busy ? 'disabled' : 'fires';
    case LABELS.storeLink:
      return page === 'confirm' ? 'fires' : 'absent';
    default: {
      const reasonIndex = REASON_LABELS.indexOf(label);
      if (reasonIndex >= 0) return page === 'q1' ? 'fires' : 'absent';
      const wantedIndex = WANTED_LABELS.indexOf(label);
      if (wantedIndex >= 0) return page === 'q2' ? 'fires' : 'absent';
      return 'absent';
    }
  }
}

/** Apply a tap that the model predicted 'fires'. */
function modelFire(m: Model, label: string, isButton: boolean) {
  if (isButton) {
    switch (label) {
      case BUTTONS.gotIt:
        m.notice = null;
        return;
      case BUTTONS.next:
        m.phase = 'kept';
        return;
      case BUTTONS.cont:
        m.survey = buildSurvey(m, m.wanted, m.details);
        m.phase = 'review';
        return;
      case BUTTONS.keep:
        modelCloseDialog(m);
        return;
      case BUTTONS.request: {
        m.error = null;
        m.phase = 'requesting';
        if (!m.apiSession) {
          // Rejects before any fetch: not_configured, non-retryable.
          m.phase = 'review';
          m.error = COPY.notConfigured;
          return;
        }
        m.pending.push({
          id: m.nextFetchId++,
          kind: 'request',
          presentation: m.presentation,
          mountGen: m.mountGen,
          survey: m.survey,
          challenge: null,
          abortAt: m.now + REQUEST_TIMEOUT_MS,
        });
        m.fetchCalls += 1;
        return;
      }
      case BUTTONS.confirm: {
        const challenge = m.challenge;
        m.error = null;
        m.phase = 'deleting';
        if (!m.apiSession) {
          m.phase = 'review';
          m.challenge = null;
          m.error = COPY.notConfigured;
          return;
        }
        m.pending.push({
          id: m.nextFetchId++,
          kind: 'confirm',
          presentation: m.presentation,
          mountGen: m.mountGen,
          survey: null,
          challenge,
          abortAt: m.now + REQUEST_TIMEOUT_MS,
        });
        m.fetchCalls += 1;
        return;
      }
      default:
        throw new Error(`model: unknown button ${label}`);
    }
  }
  switch (label) {
    case LABELS.hostOpen:
      modelMount(m);
      return;
    case LABELS.deleteAccount:
      m.open = true;
      return;
    case LABELS.screenBack:
      modelUnmount(m);
      return;
    case LABELS.skipSurvey:
      m.survey = null;
      m.phase = 'review';
      return;
    case LABELS.skipQ2:
      m.survey = buildSurvey(m, null, '');
      m.phase = 'review';
      return;
    case LABELS.backQ:
      m.phase = 'why';
      return;
    case LABELS.closeSurvey:
    case LABELS.closeConfirm:
    case LABELS.backdrop:
      modelCloseDialog(m);
      return;
    case LABELS.storeLink:
      m.storeOpens += 1;
      if (m.storeLinkFails) m.notice = COPY.storeNotice;
      return;
    default: {
      const reasonIndex = REASON_LABELS.indexOf(label);
      if (reasonIndex >= 0) {
        m.reason = REASONS[reasonIndex] ?? null;
        return;
      }
      const wantedIndex = WANTED_LABELS.indexOf(label);
      if (wantedIndex >= 0) {
        m.wanted = WANTED[wantedIndex] ?? null;
        return;
      }
      throw new Error(`model: unknown control ${label}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Generator: legal + near-legal actions from the model's current state.
// ---------------------------------------------------------------------------

const ALL_TAP_LABELS: readonly string[] = [
  ...Object.values(LABELS).filter(l => l !== LABELS.detailsInput),
  ...REASON_LABELS,
  ...WANTED_LABELS,
];
const ALL_BUTTON_LABELS: readonly string[] = Object.values(BUTTONS);

function generateAction(rng: Rng, m: Model): Action {
  // ~8% fully random near-legal noise: any control, present or not.
  if (rng.next() < 0.08) {
    return rng.weighted<Action>([
      [3, { kind: 'tap', label: rng.pick(ALL_TAP_LABELS) }],
      [2, { kind: 'tap_button', label: rng.pick(ALL_BUTTON_LABELS) }],
      [1, { kind: 'type_details', variant: rng.int(DETAIL_VARIANTS.length) }],
      [1, { kind: 'hardware_back' }],
      [1, { kind: 'settle_request', outcome: rng.pick(REQUEST_OUTCOMES) }],
      [1, { kind: 'settle_confirm', outcome: rng.pick(CONFIRM_OUTCOMES) }],
    ]);
  }
  if (m.notice !== null) {
    return rng.weighted<Action>([
      [6, { kind: 'tap_button', label: BUTTONS.gotIt }],
      [1, { kind: 'tick', ms: rng.pick(TICKS) }],
      [1, { kind: 'tap', label: rng.pick(ALL_TAP_LABELS) }],
    ]);
  }
  if (!m.mounted) {
    return rng.weighted<Action>([
      [8, { kind: 'nav_push' }],
      [2, { kind: 'tick', ms: rng.pick(TICKS) }],
      [1, { kind: 'settle_request', outcome: rng.pick(REQUEST_OUTCOMES) }],
      [1, { kind: 'settle_confirm', outcome: rng.pick(CONFIRM_OUTCOMES) }],
      [1, { kind: 'session_restore' }],
      [1, { kind: 'session_signout' }],
    ]);
  }
  const page = modelDialogPage(m);
  const rare: ReadonlyArray<readonly [number, Action]> = [
    [1, { kind: 'nav_pop' }],
    [1, { kind: 'session_signout' }],
    [1, { kind: 'session_local_only' }],
    [1, { kind: 'session_restore' }],
    [1, { kind: 'store_link_fails', fails: rng.next() < 0.5 }],
    [2, { kind: 'tick', ms: rng.pick(TICKS) }],
  ];
  if (page === null) {
    if (m.session !== 'synced') {
      // Signed out / local-only: the entry point is gone; exercise that.
      return rng.weighted<Action>([
        [6, { kind: 'tap', label: LABELS.deleteAccount }],
        [6, { kind: 'session_restore' }],
        [3, { kind: 'tap', label: LABELS.screenBack }],
        [2, { kind: 'hardware_back' }],
        ...rare,
      ]);
    }
    return rng.weighted<Action>([
      [30, { kind: 'tap', label: LABELS.deleteAccount }],
      [4, { kind: 'tap', label: LABELS.screenBack }],
      [2, { kind: 'hardware_back' }],
      ...rare,
    ]);
  }
  if (page === 'q1') {
    return rng.weighted<Action>([
      [10, { kind: 'tap', label: rng.pick(REASON_LABELS) }],
      [8, { kind: 'tap_button', label: BUTTONS.next }],
      [5, { kind: 'tap', label: LABELS.skipSurvey }],
      [2, { kind: 'tap', label: LABELS.closeSurvey }],
      [1, { kind: 'tap', label: LABELS.backdrop }],
      [1, { kind: 'hardware_back' }],
      [1, { kind: 'tap', label: LABELS.deleteAccount }],
      [1, { kind: 'tap_button', label: BUTTONS.cont }],
      ...rare,
    ]);
  }
  if (page === 'q2') {
    return rng.weighted<Action>([
      [8, { kind: 'tap', label: rng.pick(WANTED_LABELS) }],
      [6, { kind: 'type_details', variant: rng.int(DETAIL_VARIANTS.length) }],
      [8, { kind: 'tap_button', label: BUTTONS.cont }],
      [4, { kind: 'tap', label: LABELS.skipQ2 }],
      [3, { kind: 'tap', label: LABELS.backQ }],
      [2, { kind: 'tap', label: LABELS.closeSurvey }],
      [1, { kind: 'tap', label: LABELS.backdrop }],
      [1, { kind: 'hardware_back' }],
      ...rare,
    ]);
  }
  // Confirmation page.
  const settle: ReadonlyArray<readonly [number, Action]> =
    m.pending.length > 0
      ? [
          [
            18,
            m.pending[0]?.kind === 'request'
              ? { kind: 'settle_request', outcome: rng.pick(REQUEST_OUTCOMES) }
              : { kind: 'settle_confirm', outcome: rng.pick(CONFIRM_OUTCOMES) },
          ],
        ]
      : [];
  return rng.weighted<Action>([
    [8, { kind: 'tap_button', label: BUTTONS.request }],
    [8, { kind: 'tap_button', label: BUTTONS.confirm }],
    [8, { kind: 'tick', ms: rng.pick(TICKS) }],
    [3, { kind: 'tap_button', label: BUTTONS.keep }],
    [2, { kind: 'tap', label: LABELS.closeConfirm }],
    [2, { kind: 'tap', label: LABELS.backdrop }],
    [2, { kind: 'hardware_back' }],
    [1, { kind: 'tap', label: LABELS.storeLink }],
    [1, { kind: 'settle_request', outcome: rng.pick(REQUEST_OUTCOMES) }],
    [1, { kind: 'settle_confirm', outcome: rng.pick(CONFIRM_OUTCOMES) }],
    ...settle,
    ...rare,
  ]);
}

function describeAction(a: Action): string {
  switch (a.kind) {
    case 'tap':
      return `tap(${a.label})`;
    case 'tap_button':
      return `button(${a.label})`;
    case 'type_details':
      return `type(#${a.variant}:${JSON.stringify(DETAIL_VARIANTS[a.variant] ?? '').slice(0, 24)})`;
    case 'hardware_back':
      return 'hardwareBack';
    case 'tick':
      return `tick(${a.ms}ms)`;
    case 'settle_request':
      return `settleRequest(${a.outcome})`;
    case 'settle_confirm':
      return `settleConfirm(${a.outcome})`;
    case 'nav_pop':
      return 'navPop';
    case 'nav_push':
      return 'navPush';
    case 'session_signout':
      return 'sessionSignOut';
    case 'session_local_only':
      return 'sessionLocalOnly';
    case 'session_restore':
      return 'sessionRestore';
    case 'store_link_fails':
      return `storeLinkFails(${a.fails})`;
  }
}

// ---------------------------------------------------------------------------
// Scripted fetch (the only network boundary) + timer bookkeeping
// ---------------------------------------------------------------------------

interface FetchCall {
  id: number;
  url: string;
  init: RequestInit | undefined;
  body: unknown;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

class ScriptedFetch {
  pending: FetchCall[] = [];
  calls: FetchCall[] = [];
  private nextId = 1;
  install() {
    this.pending = [];
    this.calls = [];
    this.nextId = 1;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const call: FetchCall = {
          id: this.nextId++,
          url: String(input),
          init,
          body:
            typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
          resolve,
          reject,
          settled: false,
        };
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            if (call.settled) return;
            call.settled = true;
            this.pending = this.pending.filter(p => p !== call);
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        }
        this.pending.push(call);
        this.calls.push(call);
      })) as typeof fetch;
  }
  settle(call: FetchCall, response: Response | Error) {
    if (call.settled) return;
    call.settled = true;
    this.pending = this.pending.filter(p => p !== call);
    if (response instanceof Error) call.reject(response);
    else call.resolve(response);
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function notJsonResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.reject(new SyntaxError('not json')),
  } as unknown as Response;
}

function requestResponse(outcome: RequestOutcome): Response | Error {
  switch (outcome) {
    case 'ok':
      return jsonResponse(200, {
        challenge: CHALLENGE_ID,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    case 'http401':
      return jsonResponse(401, { error: { message: 'expired' } });
    case 'http403_message':
      return jsonResponse(403, { error: { message: COPY.serverMessage } });
    case 'http429':
      return notJsonResponse(429);
    case 'http500':
      return jsonResponse(500, { error: 'not an object' });
    case 'http200_not_json':
      return notJsonResponse(200);
    case 'http200_missing_challenge':
      return jsonResponse(200, { expiresAt: '2099-01-01T00:00:00.000Z' });
    case 'network':
      return new TypeError('Network request failed');
  }
}

function confirmResponse(outcome: ConfirmOutcome): Response | Error {
  switch (outcome) {
    case 'ok_not_applicable':
      return jsonResponse(200, {
        deleted: true,
        appleAuthorizationRevocation: 'not_applicable',
      });
    case 'ok_revoked':
      return jsonResponse(200, {
        deleted: true,
        appleAuthorizationRevocation: 'revoked',
      });
    case 'ok_manual_action':
      return jsonResponse(200, {
        deleted: true,
        appleAuthorizationRevocation: 'manual_action_required',
      });
    case 'ok_legacy_shape':
      return jsonResponse(200, { deleted: true });
    case 'http200_not_deleted':
      return jsonResponse(200, { deleted: false });
    case 'http401':
      return notJsonResponse(401);
    case 'http409_message':
      return jsonResponse(409, { error: { message: COPY.serverMessage } });
    case 'http429':
      return jsonResponse(429, {});
    case 'http500':
      return notJsonResponse(503);
    case 'network':
      return new TypeError('Network request failed');
  }
}

/** Live (created, not yet cleared) intervals — the countdown is the only
 * setInterval the screen owns, so this pins "no leaked countdown". */
class IntervalLedger {
  live = new Map<number, number>();
  private originalSet: typeof setInterval | null = null;
  private originalClear: typeof clearInterval | null = null;
  install() {
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    this.originalSet = originalSet;
    this.originalClear = originalClear;
    const live = this.live;
    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const id = originalSet(...args) as unknown as number;
      live.set(id, Number(args[1] ?? 0));
      return id as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id: Parameters<typeof clearInterval>[0]) => {
      live.delete(id as unknown as number);
      return originalClear(id);
    }) as typeof clearInterval;
  }
  uninstall() {
    if (this.originalSet) globalThis.setInterval = this.originalSet;
    if (this.originalClear) globalThis.clearInterval = this.originalClear;
    this.live.clear();
  }
  countdownIntervals(): number {
    let n = 0;
    for (const ms of this.live.values()) if (ms === 1000) n += 1;
    return n;
  }
}

// ---------------------------------------------------------------------------
// The rendered app: real navigator + providers around the real screen.
// ---------------------------------------------------------------------------

type StressStackParams = { Host: undefined; ManageAccount: undefined };
const Stack = createNativeStackNavigator<StressStackParams>();

function HostScreen() {
  const navigation = useNavigation();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={LABELS.hostOpen}
      onPress={() =>
        (navigation as { navigate: (route: 'ManageAccount') => void }).navigate(
          'ManageAccount',
        )
      }
    >
      <Text>Settings host</Text>
    </Pressable>
  );
}

function StressApp() {
  return (
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 47, bottom: 34, left: 0, right: 0 },
      }}
    >
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Host">
          <Stack.Screen name="Host" component={HostScreen} />
          <Stack.Screen
            name="ManageAccount"
            component={ManageAccountScreen}
            options={{ title: 'Manage Account' }}
          />
        </Stack.Navigator>
      </NavigationContainer>
      <BrandNoticeHost />
    </SafeAreaProvider>
  );
}

type Renderer = TestRenderer.ReactTestRenderer;
type Instance = TestRenderer.ReactTestInstance;

function isPressable(node: Instance): boolean {
  if (typeof node.type === 'string') return false;
  const { displayName, name } = node.type as {
    displayName?: string;
    name?: string;
  };
  return (displayName ?? name) === 'Pressable';
}

function pressables(renderer: Renderer, label: string): Instance[] {
  return renderer.root.findAll(
    node => isPressable(node) && node.props.accessibilityLabel === label,
  );
}

function buttons(renderer: Renderer, label: string): Instance[] {
  // The two danger buttons relabel while busy ("Requesting…" / "Deleting…");
  // a finger aiming at them still lands on the same (disabled) control.
  return renderer.root.findAllByType(Button).filter(node => {
    const rendered = String(node.props.label);
    if (label === BUTTONS.confirm)
      return rendered.startsWith(label) || rendered === 'Deleting…';
    if (label === BUTTONS.request)
      return rendered === label || rendered === 'Requesting…';
    return rendered === label;
  });
}

function allText(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .flat()
    .filter((c): c is string => typeof c === 'string')
    .join(' ');
}

function screenModals(renderer: Renderer): Instance[] {
  const screens = renderer.root.findAllByType(ManageAccountScreen);
  return screens.flatMap(s => s.findAllByType(Modal));
}

function radios(renderer: Renderer): Instance[] {
  return renderer.root.findAll(
    node => isPressable(node) && node.props.accessibilityRole === 'radio',
  );
}

async function flush() {
  await act(async () => {
    await new Promise<void>(resolve => setImmediate(resolve));
    await new Promise<void>(resolve => setImmediate(resolve));
  });
}

// ---------------------------------------------------------------------------
// Invariant checking — every clause names itself so a failure is legible.
// ---------------------------------------------------------------------------

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
    this.name = 'InvariantViolation';
  }
}

function check(invariant: string, ok: boolean, detail: () => string) {
  if (!ok) throw new InvariantViolation(invariant, detail());
}

function expectedConfirmButton(m: Model): {
  label: string;
  disabled: boolean;
} | null {
  if (modelDialogPage(m) !== 'confirm') return null;
  switch (m.phase) {
    case 'review':
      return { label: BUTTONS.request, disabled: false };
    case 'requesting':
      return { label: 'Requesting…', disabled: true };
    case 'armed':
      return m.secondsLeft > 0
        ? { label: `Permanently delete (${m.secondsLeft})`, disabled: true }
        : { label: BUTTONS.confirm, disabled: false };
    case 'deleting':
      return { label: 'Deleting…', disabled: true };
    default:
      return null;
  }
}

function checkInvariants(
  renderer: Renderer,
  m: Model,
  fetchStub: ScriptedFetch,
  intervals: IntervalLedger,
  consoleNoise: string[],
) {
  const text = allText(renderer);
  check(
    'I0.console-clean',
    consoleNoise.length === 0,
    () => `console.error/warn during step: ${consoleNoise.join(' | ')}`,
  );

  // Screen presence and the deletion entry point.
  check(
    'I1.screen-mounted',
    text.includes(COPY.details) === m.mounted,
    () =>
      `mounted=${m.mounted} but "${COPY.details}" present=${text.includes(COPY.details)}`,
  );
  const link = pressables(renderer, LABELS.deleteAccount);
  const linkExpected = m.mounted && m.session === 'synced';
  check(
    'I2.delete-link-iff-synced',
    (link.length === 1) === linkExpected && link.length <= 1,
    () => `session=${m.session} mounted=${m.mounted} links=${link.length}`,
  );
  if (m.mounted) {
    check(
      'I2b.sync-pill',
      text.includes(m.session === 'synced' ? 'SYNCED' : 'LOCAL'),
      () => `pill for session=${m.session} missing`,
    );
  }

  // Dialog visibility + page.
  const modals = screenModals(renderer);
  check(
    'I3.one-dialog-modal',
    modals.length === (m.mounted ? 1 : 0),
    () => `modals=${modals.length} mounted=${m.mounted}`,
  );
  const modal = modals[0];
  check(
    'I3b.dialog-visible-iff-open',
    (modal?.props.visible === true) === (m.mounted && m.open),
    () => `visible=${String(modal?.props.visible)} open=${m.open}`,
  );
  const page = modelDialogPage(m);
  const onQ1 = text.includes(COPY.q1);
  const onQ2 = text.includes(COPY.q2);
  const onConfirm = text.includes(COPY.review);
  check(
    'I4.exactly-the-model-page',
    onQ1 === (page === 'q1') &&
      onQ2 === (page === 'q2') &&
      onConfirm === (page === 'confirm'),
    () => `page=${page} q1=${onQ1} q2=${onQ2} confirm=${onConfirm}`,
  );
  check(
    'I4b.progress-marker',
    text.includes('QUESTION 1 OF 2') === (page === 'q1') &&
      text.includes('QUESTION 2 OF 2') === (page === 'q2'),
    () => `page=${page}`,
  );

  // Survey pages.
  const rows = radios(renderer);
  if (page === 'q1') {
    check(
      'I5.q1-radios',
      rows.length === REASON_LABELS.length &&
        rows.every(
          (row, i) =>
            row.props.accessibilityLabel === REASON_LABELS[i] &&
            row.props.accessibilityState?.selected ===
              (m.reason !== null && REASONS[i] === m.reason),
        ),
      () =>
        `reason=${m.reason} selected=${rows
          .filter(r => r.props.accessibilityState?.selected)
          .map(r => r.props.accessibilityLabel)
          .join(',')}`,
    );
    const next = buttons(renderer, BUTTONS.next);
    check(
      'I6.next-needs-reason',
      next.length === 1 && next[0]?.props.disabled === (m.reason === null),
      () => `reason=${m.reason} next=${next.map(n => n.props.disabled).join()}`,
    );
    check(
      'I6b.q1-controls',
      pressables(renderer, LABELS.skipSurvey).length === 1 &&
        pressables(renderer, LABELS.backQ).length === 0 &&
        pressables(renderer, LABELS.closeSurvey).length === 1,
      () => 'skip/back/close control set on question 1',
    );
  } else if (page === 'q2') {
    check(
      'I7.q2-radios',
      rows.length === WANTED_LABELS.length &&
        rows.every(
          (row, i) =>
            row.props.accessibilityLabel === WANTED_LABELS[i] &&
            row.props.accessibilityState?.selected ===
              (m.wanted !== null && WANTED[i] === m.wanted),
        ),
      () => `wanted=${m.wanted}`,
    );
    const inputs = renderer.root
      .findAllByType(TextInput)
      .filter(n => n.props.accessibilityLabel === LABELS.detailsInput);
    check(
      'I8.details-input',
      inputs.length === 1 &&
        inputs[0]?.props.value === m.details &&
        inputs[0]?.props.maxLength === ACCOUNT_DELETION_DETAILS_MAX &&
        inputs[0]?.props.placeholder ===
          (m.reason === 'other'
            ? 'Tell us what happened'
            : 'Anything else? (optional)'),
      () =>
        `inputs=${inputs.length} value=${JSON.stringify(inputs[0]?.props.value)} model=${JSON.stringify(m.details)}`,
    );
    check(
      'I8b.details-counter',
      text.includes(`${m.details.length}/${ACCOUNT_DELETION_DETAILS_MAX}`),
      () =>
        `counter ${m.details.length}/${ACCOUNT_DELETION_DETAILS_MAX} missing`,
    );
    const cont = buttons(renderer, BUTTONS.cont);
    const contDisabled = m.wanted === null && m.details.trim().length === 0;
    check(
      'I9.continue-needs-answer',
      cont.length === 1 && cont[0]?.props.disabled === contDisabled,
      () =>
        `wanted=${m.wanted} details=${JSON.stringify(m.details)} disabled=${String(cont[0]?.props.disabled)}`,
    );
    check(
      'I9b.q2-controls',
      pressables(renderer, LABELS.skipQ2).length === 1 &&
        pressables(renderer, LABELS.backQ).length === 1 &&
        pressables(renderer, LABELS.closeSurvey).length === 1,
      () => 'skip/back/close control set on question 2',
    );
  } else {
    check(
      'I5b.no-radios-off-survey',
      rows.length === 0,
      () => `${rows.length}`,
    );
  }

  // Confirmation page.
  const busy = modelBusy(m);
  if (page === 'confirm') {
    const keep = buttons(renderer, BUTTONS.keep);
    check(
      'I10.keep-disabled-iff-busy',
      keep.length === 1 && keep[0]?.props.disabled === busy,
      () => `phase=${m.phase} keep.disabled=${String(keep[0]?.props.disabled)}`,
    );
    const expected = expectedConfirmButton(m);
    const danger = renderer.root
      .findAllByType(Button)
      .filter(n => n.props.variant === 'danger');
    check(
      'I11.danger-button-label-and-gate',
      danger.length === 1 &&
        expected !== null &&
        danger[0]?.props.label === expected.label &&
        Boolean(danger[0]?.props.disabled) === expected.disabled,
      () =>
        `phase=${m.phase} secondsLeft=${m.secondsLeft} expected=${JSON.stringify(expected)} got=${JSON.stringify(danger.map(d => [d.props.label, d.props.disabled]))}`,
    );
    const close = pressables(renderer, LABELS.closeConfirm);
    check(
      'I12.close-disabled-iff-busy',
      close.length === 1 && Boolean(close[0]?.props.disabled) === busy,
      () => `phase=${m.phase}`,
    );
    check(
      'I13.no-survey-controls-on-confirm',
      pressables(renderer, LABELS.closeSurvey).length === 0 &&
        pressables(renderer, LABELS.backQ).length === 0,
      () => 'survey chrome leaked onto confirmation',
    );
    check(
      'I14.store-link-present',
      pressables(renderer, LABELS.storeLink).length === 1,
      () => 'subscription link missing',
    );
  }
  if (page !== null) {
    const backdrop = pressables(renderer, LABELS.backdrop);
    check(
      'I15.backdrop-disabled-iff-busy',
      backdrop.length === 1 && Boolean(backdrop[0]?.props.disabled) === busy,
      () => `phase=${m.phase} backdrop=${backdrop.length}`,
    );
    check(
      'I16.hardware-back-blocked-iff-busy',
      (typeof modal?.props.onRequestClose === 'function') === !busy,
      () =>
        `phase=${m.phase} onRequestClose=${typeof modal?.props.onRequestClose}`,
    );
  }

  // Error copy.
  const errorShown = m.error !== null && text.includes(m.error);
  check(
    'I17.error-copy',
    m.error === null
      ? !text.includes('Nothing was deleted') &&
          !text.includes(COPY.expired) &&
          !text.includes(COPY.serverMessage) &&
          !text.includes(COPY.notConfigured)
      : errorShown && page === 'confirm',
    () => `model.error=${JSON.stringify(m.error)} page=${page}`,
  );

  // Network + timers.
  check(
    'I18.pending-fetch-set',
    fetchStub.pending.length === m.pending.length &&
      fetchStub.pending.every((call, i) => call.id === m.pending[i]?.id),
    () =>
      `real=${fetchStub.pending.map(c => c.id).join()} model=${m.pending.map(c => c.id).join()}`,
  );
  check(
    'I18b.fetch-call-count',
    fetchStub.calls.length === m.fetchCalls,
    () => `real=${fetchStub.calls.length} model=${m.fetchCalls}`,
  );
  const liveIn = m.pending.filter(p => isLive(m, p)).length;
  check(
    'I19.at-most-one-live-call',
    liveIn <= 1 && (liveIn === 0 || busy),
    () => `live=${liveIn} phase=${m.phase}`,
  );
  const countdownIntervals = intervals.countdownIntervals();
  const expectedIntervals =
    m.mounted && m.open && m.phase === 'armed' && m.secondsLeft > 0 ? 1 : 0;
  check(
    'I20.countdown-interval-ledger',
    countdownIntervals === expectedIntervals,
    () =>
      `live 1000ms intervals=${countdownIntervals} expected=${expectedIntervals} (mounted=${m.mounted} open=${m.open} phase=${m.phase} secondsLeft=${m.secondsLeft})`,
  );

  // Store-level outcome of a deletion.
  const auth = useAuthStore.getState();
  check(
    'I21.auth-session-matches',
    m.session === 'none'
      ? auth.session === null
      : auth.session !== null &&
          auth.session.localOnly === (m.session === 'local_only'),
    () => `model=${m.session} store=${JSON.stringify(auth.session)}`,
  );
  check(
    'I21b.api-session-matches',
    (getApiSession() !== null) === m.apiSession,
    () => `model.apiSession=${m.apiSession}`,
  );
  const noticeModals = renderer.root
    .findAllByType(BrandNoticeHost)
    .flatMap(host => host.findAllByType(Modal))
    .filter(n => n.props.visible === true);
  check(
    'I22.notice',
    noticeModals.length === (m.notice === null ? 0 : 1) &&
      text.includes('Account deleted') === (m.notice === COPY.cleanupNotice) &&
      text.includes('Could not open subscriptions') ===
        (m.notice === COPY.storeNotice) &&
      (m.notice === null || text.includes(m.notice)),
    () => `model.notice=${m.notice} noticeModals=${noticeModals.length}`,
  );
  if (m.deleted) {
    check(
      'I23.deleted-means-cleanup-ran',
      auth.deletionCleanup !== null && auth.session === null,
      () => `cleanup=${JSON.stringify(auth.deletionCleanup)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Executor: performs one action against the tree, then predicts + compares.
// ---------------------------------------------------------------------------

interface StepRecord {
  i: number;
  action: string;
  outcome: string;
  state: string;
}

function stateDigest(m: Model): string {
  return [
    m.mounted ? 'M' : 'u',
    m.session[0],
    m.apiSession ? 'A' : 'a',
    m.open ? `open:${m.phase}` : 'closed',
    `r=${m.reason ?? '-'}`,
    `w=${m.wanted ?? '-'}`,
    `d=${m.details.length}`,
    `s=${m.survey ? 'S' : '-'}`,
    `e=${m.error ? m.error.slice(0, 12) : '-'}`,
    `c=${m.challenge ? 'C' : '-'}`,
    `sec=${m.secondsLeft}`,
    `p=${m.pending.map(p => `${p.kind[0]}${p.id}`).join('/')}`,
    `f=${m.fetchCalls}`,
    `del=${m.completeCalls}`,
    `n=${m.notice ?? '-'}`,
    `t=${m.now}`,
  ].join(' ');
}

class World {
  renderer!: Renderer;
  model = freshModel();
  readonly fetchStub = new ScriptedFetch();
  readonly intervals = new IntervalLedger();
  consoleNoise: string[] = [];
  private errorSpy: jest.SpyInstance | null = null;
  private warnSpy: jest.SpyInstance | null = null;
  private openUrlSpy: jest.SpyInstance | null = null;

  async setup() {
    jest.useFakeTimers({
      doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
    });
    this.intervals.install();
    this.fetchStub.install();
    this.errorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        this.consoleNoise.push(`error: ${args.map(String).join(' ')}`);
      });
    this.warnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation((...args: unknown[]) => {
        this.consoleNoise.push(`warn: ${args.map(String).join(' ')}`);
      });
    this.openUrlSpy = jest
      .spyOn(Linking, 'openURL')
      .mockImplementation(() =>
        this.model.storeLinkFails
          ? Promise.reject(new Error('no store'))
          : Promise.resolve(),
      );
    useAuthStore.setState({
      hydrated: true,
      session: syncedSession,
      busy: false,
      error: null,
      deletionCleanup: null,
    });
    establishApiSession(apiSession);
    this.model = freshModel();
    await act(async () => {
      this.renderer = TestRenderer.create(<StressApp />);
    });
    await flush();
    // Settings → Manage account, the way the app arrives on this screen.
    await this.tap(LABELS.hostOpen, false);
    this.consoleNoise = [];
  }

  async teardown() {
    await act(async () => {
      this.renderer.unmount();
    });
    await flush();
    this.errorSpy?.mockRestore();
    this.warnSpy?.mockRestore();
    this.openUrlSpy?.mockRestore();
    this.intervals.uninstall();
    jest.useRealTimers();
    clearApiSession();
  }

  private async tap(label: string, isButton: boolean): Promise<string> {
    const predicted = predictTap(this.model, label, isButton);
    const nodes = isButton
      ? buttons(this.renderer, label)
      : pressables(this.renderer, label);
    // Controls underneath a presented Modal are unreachable to a finger.
    const noticeUp = this.model.notice !== null;
    const dialogUp = this.model.mounted && this.model.open;
    const behindModal =
      (noticeUp && !(isButton && label === BUTTONS.gotIt)) ||
      (dialogUp &&
        !isButton &&
        (label === LABELS.deleteAccount || label === LABELS.screenBack)) ||
      (this.model.mounted && !isButton && label === LABELS.hostOpen);
    let observed: TapPrediction;
    if (nodes.length === 0) observed = 'absent';
    else if (nodes.length > 1)
      throw new InvariantViolation(
        'I24.unique-control',
        `${nodes.length} controls labelled ${label}`,
      );
    else if (behindModal) observed = 'behind_modal';
    else if (nodes[0]?.props.disabled) observed = 'disabled';
    else observed = 'fires';
    check(
      'I25.tap-reachability',
      observed === predicted,
      () =>
        `${isButton ? 'button' : 'tap'}(${label}) predicted=${predicted} observed=${observed} [${stateDigest(this.model)}]`,
    );
    if (observed !== 'fires') return observed;
    const node = nodes[0];
    if (!node) return 'absent';
    await act(async () => {
      node.props.onPress();
    });
    await flush();
    modelFire(this.model, label, isButton);
    return 'fired';
  }

  async perform(action: Action): Promise<string> {
    const m = this.model;
    switch (action.kind) {
      case 'tap':
        return this.tap(action.label, false);
      case 'tap_button':
        return this.tap(action.label, true);
      case 'type_details': {
        const value = DETAIL_VARIANTS[action.variant] ?? '';
        const inputs = this.renderer.root
          .findAllByType(TextInput)
          .filter(n => n.props.accessibilityLabel === LABELS.detailsInput);
        const reachable = modelDialogPage(m) === 'q2' && m.notice === null;
        check(
          'I26.details-input-iff-q2',
          (inputs.length === 1) === (modelDialogPage(m) === 'q2'),
          () => `inputs=${inputs.length} page=${modelDialogPage(m)}`,
        );
        if (!reachable) return 'absent';
        const input = inputs[0];
        if (!input) return 'absent';
        await act(async () => {
          input.props.onChangeText(value);
        });
        m.details = value;
        return 'typed';
      }
      case 'hardware_back': {
        const modal = screenModals(this.renderer)[0];
        const handler = modal?.props.visible
          ? modal.props.onRequestClose
          : undefined;
        if (typeof handler !== 'function') return 'no-handler';
        check(
          'I27.hardware-back-only-when-not-busy',
          !modelBusy(m) && m.open,
          () => `phase=${m.phase}`,
        );
        await act(async () => {
          handler();
        });
        await flush();
        modelCloseDialog(m);
        return 'closed';
      }
      case 'tick': {
        await act(async () => {
          jest.advanceTimersByTime(action.ms);
        });
        await flush();
        modelTick(m, action.ms);
        return `t=${m.now}`;
      }
      case 'settle_request':
      case 'settle_confirm': {
        const kind = action.kind === 'settle_request' ? 'request' : 'confirm';
        const target = m.pending.find(p => p.kind === kind);
        const real = this.fetchStub.pending.find(c =>
          c.url.endsWith(
            kind === 'request'
              ? '/v1/me/delete-request'
              : '/v1/me/delete-confirm',
          ),
        );
        check(
          'I28.settle-target-agrees',
          (target === undefined) === (real === undefined) &&
            (target === undefined || real?.id === target.id),
          () => `model=${target?.id} real=${real?.id}`,
        );
        if (!target || !real) return 'no-pending';
        // The wire shape the real client put on this call.
        check(
          'I29.wire-shape',
          real.init?.method === 'POST' &&
            (real.init.headers as Record<string, string>)['Authorization'] ===
              `Bearer ${BEARER}` &&
            (kind === 'request'
              ? JSON.stringify(real.body) ===
                JSON.stringify(
                  target.survey ? { survey: target.survey } : undefined,
                )
              : JSON.stringify(real.body) ===
                JSON.stringify({ challenge: target.challenge })),
          () =>
            `kind=${kind} body=${JSON.stringify(real.body)} expected=${JSON.stringify(kind === 'request' ? target.survey : target.challenge)}`,
        );
        const response =
          action.kind === 'settle_request'
            ? requestResponse(action.outcome)
            : confirmResponse(action.outcome);
        await act(async () => {
          this.fetchStub.settle(real, response);
        });
        await flush();
        await flush();
        if (action.kind === 'settle_request') {
          modelSettleRequest(m, target, action.outcome);
        } else {
          modelSettleConfirm(m, target, action.outcome);
        }
        return `settled#${target.id}`;
      }
      case 'nav_pop': {
        if (!m.mounted) return 'not-mounted';
        const back = pressables(this.renderer, LABELS.screenBack)[0];
        if (!back) return 'no-back';
        // Programmatic pop (deep link / parent reset) — bypasses the modal.
        await act(async () => {
          back.props.onPress();
        });
        await flush();
        modelUnmount(m);
        return 'popped';
      }
      case 'nav_push': {
        if (m.mounted) return 'already-mounted';
        return this.tap(LABELS.hostOpen, false);
      }
      case 'session_signout': {
        if (m.session === 'none') return 'already-signed-out';
        await act(async () => {
          useAuthStore.setState({ session: null });
          clearApiSession();
        });
        await flush();
        m.session = 'none';
        m.apiSession = false;
        return 'signed-out';
      }
      case 'session_local_only': {
        if (m.session !== 'synced') return 'not-synced';
        await act(async () => {
          useAuthStore.setState({ session: localOnlySession });
          clearApiSession();
        });
        await flush();
        m.session = 'local_only';
        m.apiSession = false;
        return 'local-only';
      }
      case 'session_restore': {
        if (m.session === 'synced') return 'already-synced';
        await act(async () => {
          useAuthStore.setState({
            session: syncedSession,
            deletionCleanup: null,
          });
          establishApiSession(apiSession);
        });
        await flush();
        m.session = 'synced';
        m.apiSession = true;
        m.deleted = false;
        return 'restored';
      }
      case 'store_link_fails':
        m.storeLinkFails = action.fails;
        return `fails=${action.fails}`;
    }
  }

  async step(i: number, action: Action): Promise<StepRecord> {
    this.consoleNoise = [];
    const outcome = await this.perform(action);
    checkInvariants(
      this.renderer,
      this.model,
      this.fetchStub,
      this.intervals,
      this.consoleNoise,
    );
    return {
      i,
      action: describeAction(action),
      outcome,
      state: stateDigest(this.model),
    };
  }
}

// ---------------------------------------------------------------------------
// Campaign runner
// ---------------------------------------------------------------------------

interface Failure {
  step: number;
  action: string;
  invariant: string;
  message: string;
}

interface SequenceResult {
  seed: number;
  length: number;
  executed: number;
  outcome: 'HELD' | 'BROKEN';
  failure: Failure | null;
  trace: StepRecord[];
  actions: Action[];
}

function sequenceLength(rng: Rng): number {
  return MIN_LEN + rng.int(MAX_LEN - MIN_LEN + 1);
}

function toFailure(error: unknown, step: number, action: Action): Failure {
  if (error instanceof InvariantViolation) {
    return {
      step,
      action: describeAction(action),
      invariant: error.invariant,
      message: error.message,
    };
  }
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return { step, action: describeAction(action), invariant: 'THROW', message };
}

/** Generate-and-run from a seed (actions depend on the model state, which
 * is itself a deterministic function of the seed). */
async function runSeed(seed: number): Promise<SequenceResult> {
  const rng = new Rng(seed);
  const length = sequenceLength(rng);
  const world = new World();
  const trace: StepRecord[] = [];
  const actions: Action[] = [];
  let failure: Failure | null = null;
  await world.setup();
  try {
    for (let i = 0; i < length; i += 1) {
      const action = generateAction(rng, world.model);
      actions.push(action);
      try {
        trace.push(await world.step(i, action));
      } catch (error) {
        failure = toFailure(error, i, action);
        break;
      }
    }
  } finally {
    await world.teardown();
  }
  return {
    seed,
    length,
    executed: failure ? failure.step + 1 : actions.length,
    outcome: failure ? 'BROKEN' : 'HELD',
    failure,
    trace,
    actions,
  };
}

/** Replay an explicit action list (used by ddmin minimization). */
async function replayActions(
  actions: readonly Action[],
): Promise<Failure | null> {
  const world = new World();
  let failure: Failure | null = null;
  await world.setup();
  try {
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i];
      if (!action) break;
      try {
        await world.step(i, action);
      } catch (error) {
        failure = toFailure(error, i, action);
        break;
      }
    }
  } finally {
    await world.teardown();
  }
  return failure;
}

/** ddmin: smallest action subsequence that still trips the same invariant. */
async function minimize(
  actions: readonly Action[],
  invariant: string,
): Promise<Action[]> {
  let current = [...actions];
  let n = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / n);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length === 0) continue;
      const failure = await replayActions(candidate);
      if (failure && failure.invariant === invariant) {
        current = candidate;
        n = Math.max(n - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (n >= current.length) break;
      n = Math.min(current.length, n * 2);
    }
  }
  return current;
}

interface CampaignReport {
  unit: string;
  lens: string;
  baseSeed: number;
  iterations: number;
  lengthRange: [number, number];
  scenariosExecuted: number;
  stepsExecuted: number;
  held: number;
  broken: number;
  durationMs: number;
  results: Array<{
    seed: number;
    length: number;
    executed: number;
    outcome: 'HELD' | 'BROKEN';
    failure: Failure | null;
  }>;
  failures: Array<{
    seed: number;
    failure: Failure;
    minimizedActions: string[];
    minimizedLength: number;
    flakeRerunFailures: number;
    flakeReruns: number;
    trace: StepRecord[];
  }>;
  determinism: Array<{ seed: number; identical: boolean }>;
  actionHistogram: Record<string, number>;
  outcomeHistogram: Record<string, number>;
  heap: Array<{ afterSeeds: number; heapUsedMb: number; rssMb: number }>;
}

function sampleHeap(afterSeeds: number): CampaignReport['heap'][number] {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (typeof gc === 'function') gc();
  const usage = process.memoryUsage();
  return {
    afterSeeds,
    heapUsedMb: Math.round(usage.heapUsed / 1_048_576),
    rssMb: Math.round(usage.rss / 1_048_576),
  };
}

describe('ManageAccountScreen — seeded randomized long-run (real navigator + providers)', () => {
  beforeAll(async () => {
    // Settle the design system's one-time reduce-motion probe inside act().
    let warmUp!: Renderer;
    useAuthStore.setState({ hydrated: true, session: syncedSession });
    await act(async () => {
      warmUp = TestRenderer.create(<StressApp />);
    });
    await act(async () => {
      warmUp.unmount();
    });
  });

  it(`holds every invariant across ${ITERATIONS} seeded sequences (seed ${BASE_SEED})`, async () => {
    const startedAt = Date.now();
    const results: SequenceResult[] = [];
    const actionHistogram: Record<string, number> = {};
    const outcomeHistogram: Record<string, number> = {};
    const heap: CampaignReport['heap'] = HEAP_EVERY > 0 ? [sampleHeap(0)] : [];
    for (let i = 0; i < ITERATIONS; i += 1) {
      const seed = (BASE_SEED + i) >>> 0;
      const result = await runSeed(seed);
      results.push(result);
      if (HEAP_EVERY > 0 && (i + 1) % HEAP_EVERY === 0) {
        const sample = sampleHeap(i + 1);
        heap.push(sample);
        process.stdout.write(
          `[stress] seeds=${sample.afterSeeds} heapUsed=${sample.heapUsedMb}MB rss=${sample.rssMb}MB\n`,
        );
      }
      for (const step of result.trace) {
        const key = step.action.replace(/\(.*$/, '');
        actionHistogram[key] = (actionHistogram[key] ?? 0) + 1;
        outcomeHistogram[step.outcome.replace(/[#=].*$/, '')] =
          (outcomeHistogram[step.outcome.replace(/[#=].*$/, '')] ?? 0) + 1;
      }
    }

    const broken = results.filter(r => r.outcome === 'BROKEN');
    const failures: CampaignReport['failures'] = [];
    for (const result of broken) {
      if (!result.failure) continue;
      const executed = result.actions.slice(0, result.failure.step + 1);
      const minimized = await minimize(executed, result.failure.invariant);
      let rerunFailures = 0;
      for (let k = 0; k < FLAKE_RERUNS; k += 1) {
        const again = await runSeed(result.seed);
        if (again.outcome === 'BROKEN') rerunFailures += 1;
      }
      failures.push({
        seed: result.seed,
        failure: result.failure,
        minimizedActions: minimized.map(describeAction),
        minimizedLength: minimized.length,
        flakeRerunFailures: rerunFailures,
        flakeReruns: FLAKE_RERUNS,
        trace: result.trace,
      });
    }

    // Determinism: the same seed must produce the identical trace.
    const determinism: CampaignReport['determinism'] = [];
    const seedsToReplay = new Set<number>();
    results.forEach((r, i) => {
      if (i % DETERMINISM_EVERY === 0 || r.outcome === 'BROKEN')
        seedsToReplay.add(r.seed);
    });
    for (const seed of seedsToReplay) {
      const first = results.find(r => r.seed === seed);
      const second = await runSeed(seed);
      const identical =
        first !== undefined &&
        JSON.stringify(first.trace) === JSON.stringify(second.trace) &&
        JSON.stringify(first.failure) === JSON.stringify(second.failure);
      determinism.push({ seed, identical });
    }

    const report: CampaignReport = {
      unit: 'scr-manageaccountscreen',
      lens: 'randomized-seeded',
      baseSeed: BASE_SEED,
      iterations: ITERATIONS,
      lengthRange: [MIN_LEN, MAX_LEN],
      scenariosExecuted: results.length,
      stepsExecuted: results.reduce((sum, r) => sum + r.executed, 0),
      held: results.length - broken.length,
      broken: broken.length,
      durationMs: Date.now() - startedAt,
      results: results.map(r => ({
        seed: r.seed,
        length: r.length,
        executed: r.executed,
        outcome: r.outcome,
        failure: r.failure,
      })),
      failures,
      determinism,
      actionHistogram,
      outcomeHistogram,
      heap,
    };
    if (OUT_PATH) writeFileSync(OUT_PATH, JSON.stringify(report, null, 2));

    const nonDeterministic = determinism.filter(d => !d.identical);
    expect(nonDeterministic).toEqual([]);
    expect(results.every(r => r.length >= MIN_LEN && r.length <= MAX_LEN)).toBe(
      true,
    );
    expect(
      broken.map(r => ({
        seed: r.seed,
        failure: r.failure,
        minimized: failures.find(f => f.seed === r.seed)?.minimizedActions,
      })),
    ).toEqual([]);
  });
});
