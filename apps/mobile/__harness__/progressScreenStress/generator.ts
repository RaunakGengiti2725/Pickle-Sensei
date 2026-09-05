import {
  CURRENT_VERSIONS,
  FIXTURE_SHOT_TYPES,
  LEGACY_VERSIONS,
  type CaptureKind,
  type CaptureSpec,
  type ScoredFactSpec,
} from './fixtures';
import type { RangeKey } from './model';
import type { ShotTypeSlug } from '@pickle/shared-types';

/** mulberry32 — the same deterministic generator the xc-harness matrices use. */
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
  return items[Math.floor(rng() * items.length)]!;
}

export function intBetween(
  rng: () => number,
  min: number,
  max: number,
): number {
  return min + Math.floor(rng() * (max - min + 1));
}

export type ApiMode =
  'signed_out' | 'ok' | 'http_500' | 'malformed' | 'network_fail';

/**
 * Legal and near-legal actions over ProgressScreen's public surface: its two
 * tab bars, its two navigation exits, the bottom tab bar that hosts it, the
 * local database it reads on every focus, the account session that gates the
 * canonical fetch, and the storage fault its error state exists for.
 */
export type Action =
  | { kind: 'section'; section: 'technique' | 'practice' }
  | { kind: 'range'; range: RangeKey }
  | { kind: 'double_press'; target: 'section' | 'range' }
  | { kind: 'open_streak' }
  | { kind: 'open_attempt' }
  | { kind: 'back' }
  | { kind: 'switch_tab'; tab: 'Home' | 'Progress' }
  | { kind: 'add_fact'; fact: ScoredFactSpec }
  | { kind: 'add_capture'; capture: CaptureSpec }
  | { kind: 'api'; mode: ApiMode }
  | { kind: 'db_fault'; on: boolean }
  | { kind: 'retry' }
  | { kind: 'flush' };

export interface Scenario {
  seed: number;
  initialFacts: ScoredFactSpec[];
  initialCaptures: CaptureSpec[];
  initialApi: ApiMode;
  actions: Action[];
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** An instant `daysAgo` calendar days back, at a random hour that stays
 * inside that device-zone day for any clock reading (1h..23h before the
 * anchor's local midnight is not knowable here, so the offset is a whole
 * number of hours between 2 and 22 back from a same-day anchor). */
function instantDaysAgo(rng: () => number, nowMs: number, daysAgo: number) {
  const hoursBack = intBetween(rng, 2, 22);
  const minutes = intBetween(rng, 0, 59);
  return new Date(
    nowMs - daysAgo * DAY_MS - hoursBack * HOUR_MS - minutes * 60_000,
  ).toISOString();
}

let counter = 0;
function freshId(prefix: string, rng: () => number): string {
  counter += 1;
  return `${prefix}-${Math.floor(rng() * 1e9).toString(36)}-${counter}`;
}

export interface SessionSpec {
  id: string;
  shotType: ShotTypeSlug;
  /** Calendar days back the set was played (0 = today's sitting). */
  daysAgo: number;
}

export function randomFact(
  rng: () => number,
  nowMs: number,
  options: { sessions: SessionSpec[]; allowFuture: boolean },
): ScoredFactSpec {
  const roll = rng();
  let daysAgo =
    roll < 0.45
      ? intBetween(rng, 0, 6)
      : roll < 0.75
        ? intBetween(rng, 7, 27)
        : roll < 0.92
          ? intBetween(rng, 28, 89)
          : intBetween(rng, 90, 200);
  let shotType = pick(rng, FIXTURE_SHOT_TYPES);
  const sessionRoll = rng();
  let sessionId: string | null = null;
  if (sessionRoll < 0.35 && options.sessions.length > 0) {
    // Another read in an existing set: mostly the same stroke on the same
    // day (that is what makes a set summarisable), sometimes a stray one.
    const session = pick(rng, options.sessions);
    sessionId = session.id;
    if (rng() < 0.8) shotType = session.shotType;
    if (rng() < 0.8) daysAgo = session.daysAgo;
  } else if (sessionRoll < 0.5) {
    // Half of new sets are today's sitting so the practice-set card is
    // reachable; the rest are older sets the card must ignore.
    if (rng() < 0.5) daysAgo = 0;
    sessionId = freshId('set', rng);
    options.sessions.push({ id: sessionId, shotType, daysAgo });
  }
  const futureRoll = rng();
  const capturedAtIso =
    options.allowFuture && futureRoll < 0.05
      ? new Date(nowMs + intBetween(rng, 1, 48) * HOUR_MS).toISOString()
      : instantDaysAgo(rng, nowMs, daysAgo);
  const scoreRoll = rng();
  const overallScore =
    scoreRoll < 0.12 ? null : Math.round(intBetween(rng, 0, 100)) / 10;
  return {
    id: freshId('analysis', rng),
    shotType,
    capturedAtIso,
    overallScore,
    sessionId,
    versions: rng() < 0.15 ? LEGACY_VERSIONS : CURRENT_VERSIONS,
  };
}

const CAPTURE_KINDS: readonly CaptureKind[] = [
  'guided',
  'guided',
  'guided',
  'imported_measured',
  'imported_unmeasured',
  'corrupt_payload',
  'metadata_mismatch',
  'legacy_no_payload',
];

export function randomCapture(rng: () => number, nowMs: number): CaptureSpec {
  const roll = rng();
  const daysAgo =
    roll < 0.5
      ? intBetween(rng, 0, 6)
      : roll < 0.8
        ? intBetween(rng, 7, 27)
        : roll < 0.95
          ? intBetween(rng, 28, 89)
          : intBetween(rng, 90, 200);
  return {
    id: freshId('capture', rng),
    kind: pick(rng, CAPTURE_KINDS),
    capturedAtIso:
      rng() < 0.04
        ? new Date(nowMs + intBetween(rng, 1, 48) * HOUR_MS).toISOString()
        : instantDaysAgo(rng, nowMs, daysAgo),
    shotType: pick(rng, FIXTURE_SHOT_TYPES),
  };
}

const API_MODES: readonly ApiMode[] = [
  'signed_out',
  'signed_out',
  'ok',
  'ok',
  'http_500',
  'malformed',
  'network_fail',
];

export function generateScenario(seed: number, nowMs: number): Scenario {
  counter = 0;
  const rng = makePrng(seed);
  const sessions: SessionSpec[] = [];
  const initialFacts: ScoredFactSpec[] = [];
  const initialCaptures: CaptureSpec[] = [];
  const factCount = rng() < 0.15 ? 0 : intBetween(rng, 1, 14);
  for (let index = 0; index < factCount; index += 1) {
    initialFacts.push(randomFact(rng, nowMs, { sessions, allowFuture: true }));
  }
  const captureCount = rng() < 0.15 ? 0 : intBetween(rng, 1, 12);
  for (let index = 0; index < captureCount; index += 1) {
    initialCaptures.push(randomCapture(rng, nowMs));
  }
  const length = intBetween(rng, 5, 60);
  const actions: Action[] = [];
  while (actions.length < length) {
    const previous = actions[actions.length - 1];
    // Bias toward the follow-ups that make the interesting paths reachable:
    // a fault only surfaces on the next focus load, retry only exists in the
    // error state, and the screen only reacts while its tab is focused.
    if (previous?.kind === 'db_fault' && previous.on && rng() < 0.7) {
      actions.push({ kind: 'switch_tab', tab: 'Home' });
      actions.push({ kind: 'switch_tab', tab: 'Progress' });
      if (rng() < 0.6) actions.push({ kind: 'db_fault', on: false });
      actions.push({ kind: 'retry' });
      continue;
    }
    if (
      previous?.kind === 'switch_tab' &&
      previous.tab === 'Home' &&
      rng() < 0.6
    ) {
      actions.push({ kind: 'switch_tab', tab: 'Progress' });
      continue;
    }
    if (
      (previous?.kind === 'open_streak' || previous?.kind === 'open_attempt') &&
      rng() < 0.5
    ) {
      actions.push({ kind: 'back' });
      continue;
    }
    const roll = rng();
    if (roll < 0.16) {
      actions.push({
        kind: 'section',
        section: rng() < 0.5 ? 'technique' : 'practice',
      });
    } else if (roll < 0.32) {
      actions.push({ kind: 'range', range: pick(rng, ['7d', '28d', '90d']) });
    } else if (roll < 0.37) {
      actions.push({
        kind: 'double_press',
        target: rng() < 0.5 ? 'section' : 'range',
      });
    } else if (roll < 0.45) {
      actions.push({ kind: 'open_streak' });
    } else if (roll < 0.5) {
      actions.push({ kind: 'open_attempt' });
    } else if (roll < 0.6) {
      actions.push({ kind: 'back' });
    } else if (roll < 0.68) {
      actions.push({
        kind: 'switch_tab',
        tab: rng() < 0.5 ? 'Home' : 'Progress',
      });
    } else if (roll < 0.78) {
      actions.push({
        kind: 'add_fact',
        fact: randomFact(rng, nowMs, { sessions, allowFuture: true }),
      });
    } else if (roll < 0.86) {
      actions.push({ kind: 'add_capture', capture: randomCapture(rng, nowMs) });
    } else if (roll < 0.91) {
      actions.push({ kind: 'api', mode: pick(rng, API_MODES) });
    } else if (roll < 0.94) {
      actions.push({ kind: 'db_fault', on: rng() < 0.6 });
    } else if (roll < 0.97) {
      actions.push({ kind: 'retry' });
    } else {
      actions.push({ kind: 'flush' });
    }
  }
  actions.splice(length);
  return {
    seed,
    initialFacts,
    initialCaptures,
    initialApi: pick(rng, API_MODES),
    actions,
  };
}
