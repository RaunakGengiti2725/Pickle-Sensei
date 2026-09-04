import type { ShotTypeSlug } from '@pickle/shared-types';
import {
  getActiveDataOwner,
  SIGNED_OUT_DATA_OWNER,
} from '../data/accountScope';
import type { LocalDb } from '../data/db';
import {
  getKv,
  saveSession,
  setKv,
  type SessionInput,
} from '../data/repository';
import { makeUuid } from '../util/uuid';

/**
 * PRACTICE SET — the analyses a player records in one sitting.
 *
 * The user analyzes a stroke, reads the advice, re-records the same stroke
 * and must be able to see whether the score moved WITHIN the sitting. Every
 * analysis in a sitting therefore shares one `sessionId` (a `local_session`
 * row of mode `practice_set`, synced through the existing session.create
 * outbox kind so the server accepts the shots that reference it).
 *
 * Lifecycle, kept deliberately small:
 *  - A set is resumed while analyses keep landing; it ends after
 *    PRACTICE_SET_IDLE_TIMEOUT_MS without one (nothing is "closed" — the
 *    next analysis simply starts a new set).
 *  - A TRY AGAIN re-arm carries the original attempt's sessionId
 *    (`preferredSessionId`) and always wins, so a re-record joins the set
 *    it came from even after a longer break.
 *  - The live set is one owner-scoped kv record (`practice.set:<owner>`);
 *    the set itself is derived from `local_shot.session_id`, never stored.
 *
 * Pure over LocalDb + an injected clock so Jest pins it with a fake driver.
 */

/** A set ends after this long without an analysis. */
export const PRACTICE_SET_IDLE_TIMEOUT_MS = 20 * 60_000;

/** `local_session.mode` for sets — distinct from live/guided session modes. */
export const PRACTICE_SET_MODE = 'practice_set';

export const PRACTICE_SET_KV_NAMESPACE = 'practice.set';

export function practiceSetKeyForOwner(owner: string): string {
  return `${PRACTICE_SET_KV_NAMESPACE}:${owner}`;
}

/** Persisted shape of the live set (kv JSON). */
export interface StoredPracticeSet {
  sessionId: string;
  shotType: ShotTypeSlug | null;
  startedAtIso: string;
  lastActivityAtIso: string;
}

function parseStoredPracticeSet(raw: string | null): StoredPracticeSet | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const sessionId = record['sessionId'];
    const startedAtIso = record['startedAtIso'];
    const lastActivityAtIso = record['lastActivityAtIso'];
    const shotType = record['shotType'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
    if (typeof startedAtIso !== 'string') return null;
    if (typeof lastActivityAtIso !== 'string') return null;
    if (shotType !== null && typeof shotType !== 'string') return null;
    return {
      sessionId,
      shotType: shotType as ShotTypeSlug | null,
      startedAtIso,
      lastActivityAtIso,
    };
  } catch {
    // A corrupt record reads as "no live set" — a fresh set starts, nothing
    // is repaired into a sitting the player never had.
    return null;
  }
}

/** True while `stored` is still the live set at `nowMs` (idle timeout not
 * exceeded). An unparseable or future-dated activity stamp ends the set. */
function isLive(stored: StoredPracticeSet, nowMs: number): boolean {
  const lastActivityMs = Date.parse(stored.lastActivityAtIso);
  if (!Number.isFinite(lastActivityMs)) return false;
  const idleMs = nowMs - lastActivityMs;
  return idleMs >= 0 && idleMs <= PRACTICE_SET_IDLE_TIMEOUT_MS;
}

function resolveNow(nowIso: string | undefined): { iso: string; ms: number } {
  const iso = nowIso ?? new Date().toISOString();
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) {
    throw new Error('nowIso must be a parseable ISO timestamp.');
  }
  return { iso, ms };
}

/** Owner whose product data may be written; null while signed out (the
 * signed-out bucket is neither readable nor writable — see accountScope). */
function writableOwner(): string | null {
  const owner = getActiveDataOwner();
  return owner === SIGNED_OUT_DATA_OWNER ? null : owner;
}

async function readStoredSet(
  db: LocalDb,
  owner: string,
): Promise<StoredPracticeSet | null> {
  return parseStoredPracticeSet(await getKv(db, practiceSetKeyForOwner(owner)));
}

async function writeStoredSet(
  db: LocalDb,
  owner: string,
  stored: StoredPracticeSet,
): Promise<void> {
  await setKv(db, practiceSetKeyForOwner(owner), JSON.stringify(stored));
}

export interface ResumeOrStartPracticeSetInput {
  /** The stroke being practiced; null for an AUTO DETECT run. */
  shotType: ShotTypeSlug | null;
  /** Injected clock (tests / deterministic callers); defaults to now. */
  nowIso?: string;
  /** A TRY AGAIN handoff's sessionId: the re-record joins THAT set. */
  preferredSessionId?: string | null;
}

export interface ResumeOrStartPracticeSetResult {
  /** Null when the active owner cannot hold product data (signed out). */
  sessionId: string | null;
  /** True when an existing set was continued, false when one was created
   * (or none could be). */
  resumed: boolean;
}

/**
 * A resolved-but-uncommitted set: `planPracticeSet` decides which sessionId
 * the next analysis belongs to WITHOUT writing anything, so the capture flow
 * can embed it in the analysis and commit only once a score exists. A run
 * that abstains or fails leaves no session row, no outbox entry and no kv
 * record behind — nothing is bookkept for an analysis that never happened.
 */
export interface PracticeSetPlan {
  sessionId: string;
  /** True when an existing set is continued, false when this plan would
   * create a new one on commit. */
  resumed: boolean;
  shotType: ShotTypeSlug | null;
  /** Carried from the stored record when continuing; the plan time otherwise. */
  startedAtIso: string;
  nowIso: string;
  owner: string;
}

/**
 * Decides the set for the next analysis (pure read of the kv record).
 *
 * Order of precedence:
 *  1. `preferredSessionId` (from a TRY AGAIN handoff) — always resumed;
 *  2. the stored live set, when its idle timeout has not elapsed;
 *  3. a new set id (created on commit).
 * Null when the active owner cannot hold product data (signed out).
 */
export async function planPracticeSet(
  db: LocalDb,
  input: ResumeOrStartPracticeSetInput,
): Promise<PracticeSetPlan | null> {
  const owner = writableOwner();
  if (owner === null) return null;
  const now = resolveNow(input.nowIso);
  const stored = await readStoredSet(db, owner);

  const preferred = input.preferredSessionId ?? null;
  if (preferred !== null && preferred.length > 0) {
    const continuing = stored?.sessionId === preferred ? stored : null;
    return {
      sessionId: preferred,
      resumed: true,
      shotType: continuing?.shotType ?? input.shotType,
      startedAtIso: continuing?.startedAtIso ?? now.iso,
      nowIso: now.iso,
      owner,
    };
  }
  if (stored && isLive(stored, now.ms)) {
    return {
      sessionId: stored.sessionId,
      resumed: true,
      shotType: stored.shotType,
      startedAtIso: stored.startedAtIso,
      nowIso: now.iso,
      owner,
    };
  }
  return {
    sessionId: makeUuid(),
    resumed: false,
    shotType: input.shotType,
    startedAtIso: now.iso,
    nowIso: now.iso,
    owner,
  };
}

/**
 * The `local_session` row a plan stands for. The capture flow hands it to
 * runCaptureAnalysis so saveAnalysis writes the set (row + session.create
 * outbox entry) in the SAME transaction as the scored shot when this device
 * has no row for it yet — a shot can never outlive the set it names.
 */
export function practiceSetSession(plan: PracticeSetPlan): SessionInput {
  return {
    id: plan.sessionId,
    mode: PRACTICE_SET_MODE,
    shotType: plan.shotType,
    focusCheckpoint: null,
    startedAt: plan.startedAtIso,
  };
}

/**
 * Persists a plan: a new set writes its `practice_set` local_session row +
 * session.create outbox entry (drained ahead of shots by sync.ts; the entry
 * is skipped when one for the set is already queued — saveAnalysis usually
 * wrote it beside the shot); every commit refreshes the kv record's activity
 * stamp. Called AFTER a scored analysis was saved with the plan's sessionId.
 */
export async function commitPracticeSet(
  db: LocalDb,
  plan: PracticeSetPlan,
  nowIso?: string,
): Promise<void> {
  const now = resolveNow(nowIso ?? plan.nowIso);
  if (!plan.resumed) {
    await saveSession(db, practiceSetSession(plan));
  }
  await writeStoredSet(db, plan.owner, {
    sessionId: plan.sessionId,
    shotType: plan.shotType,
    startedAtIso: plan.startedAtIso,
    lastActivityAtIso: now.iso,
  });
}

/**
 * Plan + commit in one step, for callers that already know an analysis will
 * be recorded in the set (the capture flow itself defers the commit until a
 * score exists — see planPracticeSet / commitPracticeSet).
 */
export async function resumeOrStartPracticeSet(
  db: LocalDb,
  input: ResumeOrStartPracticeSetInput,
): Promise<ResumeOrStartPracticeSetResult> {
  const plan = await planPracticeSet(db, input);
  if (plan === null) return { sessionId: null, resumed: false };
  await commitPracticeSet(db, plan);
  return { sessionId: plan.sessionId, resumed: plan.resumed };
}

/**
 * Marks an analysis landing in `sessionId` — keeps the set alive for another
 * idle window. A set the kv record no longer names (a handoff into an older
 * set) becomes the live set again. No-op while signed out.
 */
export async function notePracticeSetAnalysis(
  db: LocalDb,
  sessionId: string,
  nowIso?: string,
): Promise<void> {
  const owner = writableOwner();
  if (owner === null || sessionId.length === 0) return;
  const now = resolveNow(nowIso);
  const stored = await readStoredSet(db, owner);
  const continuing = stored?.sessionId === sessionId ? stored : null;
  await writeStoredSet(db, owner, {
    sessionId,
    shotType: continuing?.shotType ?? null,
    startedAtIso: continuing?.startedAtIso ?? now.iso,
    lastActivityAtIso: now.iso,
  });
}

/**
 * The live set's id without creating or touching anything — null when no set
 * is live at `nowIso` (none stored, idle timeout elapsed, signed out).
 */
export async function currentPracticeSetId(
  db: LocalDb,
  nowIso?: string,
): Promise<string | null> {
  const owner = writableOwner();
  if (owner === null) return null;
  const now = resolveNow(nowIso);
  const stored = await readStoredSet(db, owner);
  return stored && isLive(stored, now.ms) ? stored.sessionId : null;
}
