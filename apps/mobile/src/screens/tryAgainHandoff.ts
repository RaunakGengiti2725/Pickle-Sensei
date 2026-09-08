import {
  SELECTABLE_TECHNIQUES_V1,
  TECHNIQUE_INTENT_VERSION,
  type ShotTypeSlug,
  type TechniqueIntent,
} from '@pickle/shared-types';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidenceRecord } from '../components/strokeResultModel';
import { stabilitySlo } from '../analysis/stabilityTelemetry';
import {
  getDataOwnerSnapshot,
  type DataOwnerContext,
} from '../data/accountScope';

/**
 * TRY AGAIN loop (MOBBIN brief §2): from a Stroke Result, one tap re-arms
 * the guided capture flow with the SAME technique intent, capture mode and
 * camera config — skipping the picker — so the player can go straight back
 * to their spot.
 *
 * The Analyze route's params are owned by the navigation workstream, so the
 * intent travels through this single-shot module handoff instead (same
 * pattern as flow/session.ts's completed-session registry). AnalyzeScreen
 * consumes it exactly once on mount; nothing persists.
 */

export interface TryAgainHandoff {
  /** Guided capture is the only mode that can produce an analysis today. */
  source: 'camera';
  /** The original declaration; null for an AUTO DETECT run. */
  declaredStroke: ShotTypeSlug | null;
  /** Canonical technique id when the original run recorded one. */
  declaredCanonical: string | null;
  /** True when the original run was AUTO DETECT (declared-null). */
  auto: boolean;
  /**
   * Practice set (sitting) the original attempt belonged to. The re-armed
   * capture joins the SAME set so the next read can be compared with this
   * one on the Result and Progress surfaces; null when the original attempt
   * was not part of a set (legacy rows, unknown analysis).
   */
  sessionId: string | null;
}

/**
 * A re-arm is the continuation of one tap, so it is only valid for as long as
 * that navigation takes. An armed handoff whose navigation never landed (the
 * app was backgrounded, the user went elsewhere) must expire instead of
 * seeding a later, unrelated capture with a declaration the player never made
 * for it.
 */
export const TRY_AGAIN_HANDOFF_TTL_MS = 30_000;

/**
 * Result → TRY AGAIN → Analyze → Result → TRY AGAIN … is one chain of hops.
 * The chain is kept as a bounded stack: the bottom entry is the retry armed
 * from the original clip, the top is the most recent hop, and older
 * intermediate hops are evicted so repeated cycles never grow the stack.
 */
export const TRY_AGAIN_STACK_LIMIT = 3;

interface TryAgainHop {
  readonly handoff: TryAgainHandoff;
  readonly armedAtMs: number;
  /** Owner generation the tap happened in; a later generation never consumes it. */
  readonly owner: DataOwnerContext;
  consumed: boolean;
}

let hops: TryAgainHop[] = [];

function top(): TryAgainHop | null {
  return hops.length > 0 ? hops[hops.length - 1]! : null;
}

function ownerCurrent(owner: DataOwnerContext): boolean {
  const current = getDataOwnerSnapshot();
  return (
    owner.ownerKey === current.ownerKey &&
    owner.generation === current.generation
  );
}

function chainCurrent(): boolean {
  const origin = hops[0];
  return origin !== undefined && ownerCurrent(origin.owner);
}

export function armTryAgain(handoff: TryAgainHandoff): void {
  if (!chainCurrent()) hops = [];
  const pending = top();
  if (pending !== null && !pending.consumed) hops.pop();
  hops.push({
    handoff,
    armedAtMs: Date.now(),
    owner: getDataOwnerSnapshot(),
    consumed: false,
  });
  while (hops.length > TRY_AGAIN_STACK_LIMIT) hops.splice(1, 1);
}

function expired(hop: TryAgainHop): boolean {
  return Date.now() - hop.armedAtMs > TRY_AGAIN_HANDOFF_TTL_MS;
}

function pendingHop(): TryAgainHop | null {
  const hop = top();
  return hop !== null && !hop.consumed ? hop : null;
}

/** Single-shot and time-bounded: the first prompt consumer takes it, a late
 * one gets nothing. Either way the handoff is cleared. */
export function consumeTryAgainHandoff(): TryAgainHandoff | null {
  const pending = pendingHop();
  if (pending === null) return null;
  if (!ownerCurrent(pending.owner)) {
    stabilitySlo.record({
      kind: 'try_again_failed',
      reason: 'owner_changed',
    });
    clearTryAgainHandoff();
    return null;
  }
  if (expired(pending)) {
    // A handoff WAS armed but its navigation never landed inside the TTL:
    // the re-arm the user asked for did not happen.
    stabilitySlo.record({
      kind: 'try_again_failed',
      reason: 'handoff_expired',
    });
    clearTryAgainHandoff();
    return null;
  }
  pending.consumed = true;
  stabilitySlo.record({ kind: 'try_again_rearmed' });
  return pending.handoff;
}

/** Drops any armed handoff — used when capture starts from another entry
 * point, so nothing stale can survive into the next re-arm window. */
export function clearTryAgainHandoff(): void {
  hops = [];
}

/** Test hook — inspect without consuming. */
export function peekTryAgainHandoff(): TryAgainHandoff | null {
  const pending = pendingHop();
  return pending !== null && ownerCurrent(pending.owner) && !expired(pending)
    ? pending.handoff
    : null;
}

/** Test hook — the retry entry armed from the original clip of the current
 * chain; null once the chain belongs to a previous owner generation. */
export function peekTryAgainOrigin(): TryAgainHandoff | null {
  return chainCurrent() ? hops[0]!.handoff : null;
}

/** Test hook — number of hops currently kept (never above the limit). */
export function tryAgainStackDepth(): number {
  return hops.length;
}

/** True when the registry maps this canonical to this exact legacy slug —
 * a canonical belonging to a different technique never seeds a re-arm. */
function canonicalMatchesSlug(canonical: string, slug: ShotTypeSlug): boolean {
  return SELECTABLE_TECHNIQUES_V1.some(
    technique =>
      technique.canonical === canonical && technique.legacySlug === slug,
  );
}

/**
 * Derive the re-arm intent from what the ORIGINAL run actually recorded.
 * declared/predicted never blur: an AUTO run re-arms AUTO (even if the
 * classifier predicted a stroke — re-declaring a prediction would fabricate
 * a declaration), and a declared run re-arms exactly the declared stroke.
 * Records without a strokeIntent envelope predate AUTO entirely, so their
 * analyzed shotType IS the historical declaration.
 */
export function tryAgainFromResult(
  record: Pick<StrokeResultEvidenceRecord, 'strokeIntent'> | null,
  analysis:
    | (Pick<ShotAnalysis, 'shotType'> &
        Partial<Pick<ShotAnalysis, 'sessionId'>>)
    | null,
): TryAgainHandoff {
  // The set tie travels with every branch below: a re-record inside the same
  // sitting must land in the same practice set regardless of how the
  // technique intent was resolved.
  const sessionId = analysis?.sessionId ?? null;
  const intent = record?.strokeIntent ?? null;
  if (intent) {
    if (intent.declaredStroke !== null) {
      const canonical =
        intent.resolutionBasis === 'declared' &&
        intent.resolvedProfileId !== null &&
        canonicalMatchesSlug(intent.resolvedProfileId, intent.declaredStroke)
          ? intent.resolvedProfileId
          : null;
      return {
        source: 'camera',
        declaredStroke: intent.declaredStroke,
        declaredCanonical: canonical,
        auto: false,
        sessionId,
      };
    }
    return {
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
      sessionId,
    };
  }
  return {
    source: 'camera',
    declaredStroke: analysis?.shotType ?? null,
    declaredCanonical: null,
    auto: false,
    sessionId,
  };
}

/**
 * Rebuild the TechniqueIntent that seeds the picker/zero-touch gate.
 * The TRY AGAIN tap is the user's re-affirmation of the same technique, so
 * a declared handoff carries source 'tap' with full confidence; an AUTO
 * handoff re-arms the canonical AUTO intent; and a handoff with no known
 * declaration seeds nothing — the picker shows, honestly unselected.
 */
export function techniqueIntentFromHandoff(
  handoff: TryAgainHandoff,
): TechniqueIntent | null {
  if (handoff.auto) {
    return {
      version: TECHNIQUE_INTENT_VERSION,
      source: 'auto',
      canonical: null,
      legacySlug: null,
      confidence: null,
    };
  }
  if (handoff.declaredStroke === null) return null;
  const canonical =
    handoff.declaredCanonical !== null
      ? handoff.declaredCanonical
      : uniqueCanonicalForSlug(handoff.declaredStroke);
  return {
    version: TECHNIQUE_INTENT_VERSION,
    source: 'tap',
    canonical,
    legacySlug: handoff.declaredStroke,
    confidence: 1,
  };
}

/** A slug maps to a canonical only when the mapping is unambiguous (e.g.
 * 'dink' → FOREHAND_DINK | BACKHAND_DINK stays null — never guessed). */
function uniqueCanonicalForSlug(slug: ShotTypeSlug): string | null {
  const matches = SELECTABLE_TECHNIQUES_V1.filter(
    technique => technique.legacySlug === slug,
  );
  return matches.length === 1 ? (matches[0]?.canonical ?? null) : null;
}
