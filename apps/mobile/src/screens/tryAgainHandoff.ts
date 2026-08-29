import {
  SELECTABLE_TECHNIQUES_V1,
  TECHNIQUE_INTENT_VERSION,
  type ShotTypeSlug,
  type TechniqueIntent,
} from '@pickle/shared-types';
import type { ShotAnalysis } from '@pickle/shared-types';
import type { StrokeResultEvidenceRecord } from '../components/strokeResultModel';

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
}

let pendingHandoff: TryAgainHandoff | null = null;

export function armTryAgain(handoff: TryAgainHandoff): void {
  pendingHandoff = handoff;
}

/** Single-shot: the first consumer takes it; later calls see null. */
export function consumeTryAgainHandoff(): TryAgainHandoff | null {
  const handoff = pendingHandoff;
  pendingHandoff = null;
  return handoff;
}

/** Test hook — inspect without consuming. */
export function peekTryAgainHandoff(): TryAgainHandoff | null {
  return pendingHandoff;
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
  analysis: Pick<ShotAnalysis, 'shotType'> | null,
): TryAgainHandoff {
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
      };
    }
    return {
      source: 'camera',
      declaredStroke: null,
      declaredCanonical: null,
      auto: true,
    };
  }
  return {
    source: 'camera',
    declaredStroke: analysis?.shotType ?? null,
    declaredCanonical: null,
    auto: false,
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
