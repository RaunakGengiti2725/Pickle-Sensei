import { CHECKPOINTS, RANK_FORM_WINDOW } from '@pickle/shared-types';
import {
  CHECKPOINT_NAMES,
  humanizeToken,
} from '../components/strokeResultModel';

/**
 * Library focus — the one checkpoint the drill library sorts itself around,
 * computed on this device from the user's own scored analyses.
 *
 * Honesty contract (matches the rest of the app):
 *  - Only real, scored analyses contribute. Abstentions and fixtures never
 *    produce a focus, and no evidence yields null — never an invented pick.
 *  - Per technique, only the most recent RANK_FORM_WINDOW scored reads count,
 *    weighted linearly with the newest heaviest — the same "current form"
 *    window the player rank uses, so both surfaces tell one story.
 *  - A checkpoint needs at least MIN_FOCUS_SAMPLES observed scores inside
 *    that window before it can be named a focus: one bad read is a data
 *    point, not a diagnosis.
 *  - Drill recommendations are matched by technique FAMILY only. No claim is
 *    ever made that a specific catalog drill was validated for a specific
 *    checkpoint — the UI copy states the family matching explicitly.
 *
 * Everything here is pure (no React, no IO) so jest pins it directly.
 */

/** Checkpoint evidence extracted from one locally persisted scored analysis. */
export interface ScoredCheckpointFact {
  id: string;
  shotType: string;
  capturedAt: string;
  checkpoints: { key: string; score: number | null; applicable: boolean }[];
}

export interface LibraryFocus {
  shotType: string;
  checkpoint: string;
  /** 0-100 recency-weighted average across the observed reads, rounded. */
  averageScore: number;
  /** How many recent scored reads actually observed this checkpoint. */
  sampleCount: number;
  /** The drill family that trains this technique. */
  family: string;
}

/** A checkpoint must be observed this often (within one technique's form
 * window) before the library will call it the focus. */
export const MIN_FOCUS_SAMPLES = 2;

/** Technique → catalog drill family. Overhead has no dedicated family in the
 * catalog, so it honestly falls back to the whole-game family. */
export const SHOT_FAMILY: Record<string, string> = {
  dink: 'dink',
  volley: 'volley',
  forehand_drive: 'drive',
  backhand_drive: 'drive',
  serve: 'serve',
  return: 'return',
  third_shot_drop: 'drop_reset',
  overhead: 'global',
};

/** Human labels for catalog family slugs (UI only — filters keep the slug). */
export const FAMILY_LABELS: Record<string, string> = {
  dink: 'Dinks',
  volley: 'Volleys',
  drive: 'Drives',
  serve: 'Serves',
  return: 'Returns',
  drop_reset: 'Drops & resets',
  global: 'Fundamentals',
};

function titleCase(value: string): string {
  const clean = humanizeToken(value).toLowerCase();
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function familyDisplayLabel(family: string): string {
  return FAMILY_LABELS[family] ?? titleCase(family);
}

export function checkpointDisplayName(key: string): string {
  return CHECKPOINT_NAMES[key] ?? titleCase(key);
}

export function techniqueDisplayName(shotType: string): string {
  return titleCase(shotType);
}

/** Honest provenance line for the focus card — technique plus the exact
 * number of recent scored reads the average is built from. */
export function focusEvidenceLine(focus: LibraryFocus): string {
  return `${techniqueDisplayName(focus.shotType)} · from ${
    focus.sampleCount
  } recent scored read${focus.sampleCount === 1 ? '' : 's'}`;
}

function checkpointOrder(key: string): number {
  const index = (CHECKPOINTS as readonly string[]).indexOf(key);
  return index === -1 ? CHECKPOINTS.length : index;
}

/** Newest first; ties break by id descending so the order is deterministic
 * for identical capture instants (mirrors the player-rank convention). */
function byRecency(a: ScoredCheckpointFact, b: ScoredCheckpointFact): number {
  if (a.capturedAt !== b.capturedAt) {
    return a.capturedAt < b.capturedAt ? 1 : -1;
  }
  if (a.id !== b.id) return a.id < b.id ? 1 : -1;
  return 0;
}

/**
 * The user's weakest sufficiently-evidenced checkpoint across their recent
 * form, or null when the history cannot support a claim.
 */
export function computeLibraryFocus(
  facts: readonly ScoredCheckpointFact[],
): LibraryFocus | null {
  const ordered = [...facts].sort(byRecency);
  const windows = new Map<string, ScoredCheckpointFact[]>();
  for (const fact of ordered) {
    const window = windows.get(fact.shotType) ?? [];
    if (window.length < RANK_FORM_WINDOW) {
      window.push(fact);
      windows.set(fact.shotType, window);
    }
  }

  interface Candidate extends LibraryFocus {
    latestCapturedAt: string;
  }
  const candidates: Candidate[] = [];
  for (const [shotType, window] of windows) {
    const accumulators = new Map<
      string,
      { weightedSum: number; weightSum: number; count: number; latest: string }
    >();
    window.forEach((fact, index) => {
      // Linear recency weights, newest heaviest — the rank's form weighting.
      const weight = window.length - index;
      for (const checkpoint of fact.checkpoints) {
        // Defense in depth: a corrupt persisted score (NaN/Infinity) must
        // never poison the average — it is treated as unobserved.
        if (
          !checkpoint.applicable ||
          checkpoint.score === null ||
          !Number.isFinite(checkpoint.score)
        ) {
          continue;
        }
        const entry = accumulators.get(checkpoint.key) ?? {
          weightedSum: 0,
          weightSum: 0,
          count: 0,
          latest: fact.capturedAt,
        };
        entry.weightedSum += checkpoint.score * weight;
        entry.weightSum += weight;
        entry.count += 1;
        accumulators.set(checkpoint.key, entry);
      }
    });
    for (const [key, entry] of accumulators) {
      if (entry.count < MIN_FOCUS_SAMPLES) continue;
      candidates.push({
        shotType,
        checkpoint: key,
        averageScore: Math.round(entry.weightedSum / entry.weightSum),
        sampleCount: entry.count,
        family: SHOT_FAMILY[shotType] ?? 'global',
        latestCapturedAt: entry.latest,
      });
    }
  }
  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) =>
      a.averageScore - b.averageScore ||
      b.sampleCount - a.sampleCount ||
      (a.latestCapturedAt === b.latestCapturedAt
        ? 0
        : a.latestCapturedAt < b.latestCapturedAt
          ? 1
          : -1) ||
      checkpointOrder(a.checkpoint) - checkpointOrder(b.checkpoint) ||
      (a.shotType < b.shotType ? -1 : a.shotType > b.shotType ? 1 : 0),
  );
  const best = candidates[0]!;
  return {
    shotType: best.shotType,
    checkpoint: best.checkpoint,
    averageScore: best.averageScore,
    sampleCount: best.sampleCount,
    family: best.family,
  };
}

/**
 * Catalog drills for the focus: drills of the technique's family first (in
 * catalog order), then whole-game drills as fill. Never fabricates relevance
 * beyond family membership.
 */
export function recommendDrills<
  T extends { slug: string; families: readonly string[] },
>(drills: readonly T[], focus: LibraryFocus, limit = 3): T[] {
  const primary = drills.filter(drill => drill.families.includes(focus.family));
  const fill =
    focus.family === 'global'
      ? []
      : drills.filter(
          drill =>
            !drill.families.includes(focus.family) &&
            drill.families.includes('global'),
        );
  return [...primary, ...fill].slice(0, Math.max(0, limit));
}
