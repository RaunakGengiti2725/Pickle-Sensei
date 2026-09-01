import { Linking, NativeModules, Platform } from 'react-native';
import { getDb } from '../data/db';
import { getKv, setKv } from '../data/repository';
import { getRuntimePublicConfig } from '../config/runtimeConfig';

/**
 * App Store rating prompts (device-level kv, never owner-scoped: a rating
 * belongs to the phone's App Store account, not a Pickle Sensei account, so
 * the record survives sign-out and account deletion).
 *
 * Policy:
 * - EVERY scored swing analysis asks StoreKit for the in-app rating sheet,
 *   starting with the very first one. iOS itself decides whether a sheet
 *   actually appears — at most ~3 prompts per 365 days, silenced for good
 *   once the person has rated the app on this device — so repeated asks are
 *   Apple-throttled, never a custom nag (App Review 5.6.1 forbids one).
 * - Settings carries an explicit "Rate Pickle Sensei" row. When the numeric
 *   app id is configured it deep-links straight to the App Store
 *   write-review page and the stored state flips to reviewed, which stops
 *   the per-analysis asks permanently (StoreKit gives no "user rated"
 *   callback, so the explicit trip to the store page is the strongest
 *   signal this app can observe).
 */

interface NativePickleStoreReview {
  requestReview(): Promise<boolean>;
}

export const REVIEW_PROMPT_KV_KEY = 'review.prompt-state';

/** Lets the settled Result screen paint before the OS sheet lands on it. */
export const REVIEW_PROMPT_DELAY_MS = 1_200;

export interface ReviewPromptState {
  version: 1;
  /** Scored analyses observed on this device (prompt eligibility trigger). */
  scoredAnalyses: number;
  /** How many times StoreKit was asked (not how many sheets iOS showed). */
  promptedCount: number;
  lastPromptedAtIso: string | null;
  /** Set once the user was sent to the write-review page; ends all asks. */
  reviewedAtIso: string | null;
}

const EMPTY_STATE: ReviewPromptState = {
  version: 1,
  scoredAnalyses: 0,
  promptedCount: 0,
  lastPromptedAtIso: null,
  reviewedAtIso: null,
};

export function parseReviewPromptState(raw: string | null): ReviewPromptState {
  if (!raw) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return EMPTY_STATE;
    }
    const record = parsed as Record<string, unknown>;
    const count = (value: unknown): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
    const iso = (value: unknown): string | null =>
      typeof value === 'string' && value.length > 0 ? value : null;
    return {
      version: 1,
      scoredAnalyses: count(record['scoredAnalyses']),
      promptedCount: count(record['promptedCount']),
      lastPromptedAtIso: iso(record['lastPromptedAtIso']),
      reviewedAtIso: iso(record['reviewedAtIso']),
    };
  } catch {
    return EMPTY_STATE;
  }
}

/** Pure policy: ask on every scored analysis until the user has reviewed. */
export function shouldRequestReview(state: ReviewPromptState): boolean {
  return state.reviewedAtIso === null;
}

function nativeStoreReview(): NativePickleStoreReview | null {
  if (Platform.OS !== 'ios') return null;
  const native = (
    NativeModules as { PickleStoreReview?: NativePickleStoreReview }
  ).PickleStoreReview;
  return native?.requestReview ? native : null;
}

/** Asks StoreKit for the system rating sheet. True means the request was
 * handed to the OS — whether a sheet appears is Apple's call alone. */
export async function requestNativeReviewPrompt(): Promise<boolean> {
  const native = nativeStoreReview();
  if (!native) return false;
  try {
    return Boolean(await native.requestReview());
  } catch {
    // A refused or unavailable prompt is never an error the user should see.
    return false;
  }
}

async function loadState(): Promise<ReviewPromptState> {
  return parseReviewPromptState(await getKv(getDb(), REVIEW_PROMPT_KV_KEY));
}

async function saveState(state: ReviewPromptState): Promise<void> {
  await setKv(getDb(), REVIEW_PROMPT_KV_KEY, JSON.stringify(state));
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Serialized like rankCelebration: concurrent reports queue up. */
let reviewQueue: Promise<void> = Promise.resolve();

/**
 * Report one freshly scored swing analysis. Fire-and-forget from the analyze
 * flow (never rejects): records the event, then — unless the user has
 * already gone through the review flow — asks StoreKit for the rating sheet
 * after a short delay so it lands on the settled Result screen. The state
 * write happens BEFORE the prompt so a crash can never replay it.
 */
export async function reportScoredAnalysisForReview(options?: {
  delayMs?: number;
}): Promise<void> {
  const run = async () => {
    // No StoreKit on this platform/build (Android, missing pod): nothing to
    // ask and nothing to record — promptedCount counts real asks only.
    if (!nativeStoreReview()) return;
    let state: ReviewPromptState;
    try {
      state = await loadState();
    } catch {
      // Unreadable state: skip rather than risk over-prompting.
      return;
    }
    if (!shouldRequestReview(state)) return;
    try {
      await saveState({
        ...state,
        scoredAnalyses: state.scoredAnalyses + 1,
        promptedCount: state.promptedCount + 1,
        lastPromptedAtIso: new Date().toISOString(),
      });
    } catch {
      // If the record cannot be persisted, do not prompt: an unbounded
      // crash-replay of the sheet request would be worse than missing one.
      return;
    }
    await delay(options?.delayMs ?? REVIEW_PROMPT_DELAY_MS);
    await requestNativeReviewPrompt();
  };
  reviewQueue = reviewQueue.then(run, run);
  await reviewQueue;
}

/** Durably ends the per-analysis prompting (user went to the review page). */
export async function markStoreReviewCompleted(): Promise<void> {
  const run = async () => {
    try {
      const state = await loadState();
      if (state.reviewedAtIso) return;
      await saveState({ ...state, reviewedAtIso: new Date().toISOString() });
    } catch {
      // Best effort: the next Settings tap can mark it again.
    }
  };
  reviewQueue = reviewQueue.then(run, run);
  await reviewQueue;
}

export type SettingsRateOutcome =
  | 'store_page'
  | 'native_prompt'
  | 'unavailable';

/**
 * Settings' "Rate Pickle Sensei" row. Prefers the App Store write-review
 * deep link (guaranteed UI, and the signal that stops the per-analysis
 * prompts); before the app id is configured it falls back to the in-app
 * StoreKit sheet, which iOS may decline to show and which therefore does
 * NOT mark the review complete. Injectable deps keep it testable.
 */
export async function rateAppFromSettings(deps?: {
  writeReviewUrl?: string | null;
  openUrl?: (url: string) => Promise<unknown>;
}): Promise<SettingsRateOutcome> {
  const url =
    deps?.writeReviewUrl !== undefined
      ? deps.writeReviewUrl
      : getRuntimePublicConfig().appStoreWriteReviewUrl;
  const openUrl = deps?.openUrl ?? (target => Linking.openURL(target));
  if (url) {
    try {
      await openUrl(url);
      await markStoreReviewCompleted();
      return 'store_page';
    } catch {
      // Store page unreachable (e.g. app not live yet): fall back to the
      // in-app sheet below.
    }
  }
  return (await requestNativeReviewPrompt()) ? 'native_prompt' : 'unavailable';
}
