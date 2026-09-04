import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CHECKPOINTS, RANK_FORM_WINDOW } from '@pickle/shared-types';
import { CHECKPOINT_NAMES } from '../../src/components/strokeResultModel';
import {
  FAMILY_LABELS,
  MIN_FOCUS_SAMPLES,
  SHOT_FAMILY,
  checkpointDisplayName,
  computeLibraryFocus,
  familyDisplayLabel,
  focusEvidenceLine,
  recommendDrills,
  techniqueDisplayName,
  type LibraryFocus,
  type ScoredCheckpointFact,
} from '../../src/library/libraryFocus';

/**
 * SEEDED RANDOMIZED LONG-RUN STRESS — library/libraryFocus (module).
 *
 * A model-checking harness over the module's public API. Each sequence is a
 * seeded script of 5–60 legal / near-legal "user history" actions (record a
 * scored analysis, record one back-dated from another device, record one at
 * an identical instant, delete one / a technique / everything, reorder the
 * storage, query recommendations, render the copy, and — at low probability —
 * the hostile shapes a corrupt local database could produce). After EVERY
 * step the honesty contract documented at the top of libraryFocus.ts is
 * checked against an independent model:
 *
 *  I1  never throws; result is null or a well-formed LibraryFocus
 *  I2  equals the independent reference model (windowing, weighting,
 *      evidence gate, full tie-break order)
 *  I3  averageScore is a finite integer bounded by the observed scores;
 *      sampleCount ∈ [MIN_FOCUS_SAMPLES, RANK_FORM_WINDOW]; family mapping
 *  I4  weakest: no evidenced (technique, checkpoint) pair averages lower
 *  I5  null ⇔ no pair reaches MIN_FOCUS_SAMPLES inside its form window
 *  I6  storage order never matters (shuffled + reversed input ⇒ same focus)
 *  I7  purity + idempotence (input never mutated, second call identical)
 *  I8  only the newest RANK_FORM_WINDOW reads per technique count (dropping
 *      every out-of-window fact, or adding an ancient one, changes nothing)
 *  I9  the repository's newest-120 projection is exact for ≤ 15 techniques
 *  I10 metamorphic: scoring the focus checkpoint 100 (0) on a new legal read
 *      never lowers (raises) that pair's average
 *  I11 recommendDrills: bounded, deduplicated, catalog-ordered, family-honest
 *  I12 display helpers: canonical names, exact evidence line, store-safe copy
 *  I13 sampleCount never exceeds the number of distinct in-window reads that
 *      observed the checkpoint ("one bad read is a data point")
 *
 * Determinism: every sequence is replayed from its seed and must produce a
 * byte-identical trace. Failures are minimized (ddmin over the resolved
 * action script) and the seed → outcome table is written as JSON.
 *
 * Scale is controlled by env so the suite stays fast by default:
 *   STRESS_ITER   number of sequences (default 250; campaign runs use ≥2000)
 *   STRESS_SEED   campaign base seed (default 20260904)
 *   STRESS_REPORT path for the JSON seed table (unset ⇒ not written)
 */

// ─── Seeded PRNG (mulberry32) ───────────────────────────────────────────────

type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function int(rng: Rng, minInclusive: number, maxInclusive: number): number {
  return minInclusive + Math.floor(rng() * (maxInclusive - minInclusive + 1));
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)]!;
}

function shuffled<T>(rng: Rng, items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

// ─── Vocabulary ─────────────────────────────────────────────────────────────

const LEGAL_TECHNIQUES = Object.keys(SHOT_FAMILY);
const HOSTILE_TECHNIQUES = ['', 'mystery_shot', 'Dink', 'dink '];
const HOSTILE_KEYS = ['', 'contact_height', 'weird key!!', 'Contact_Position'];
const HOSTILE_SCORES: readonly number[] = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  -50,
  250,
  100.5,
  -0,
];
// Finite, but large enough that weight × score overflows a double.
const EXTREME_FINITE_SCORES: readonly number[] = [
  1e308,
  -1e308,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
];
const HOSTILE_INSTANTS = ['not-a-date', '', '2026-08-01', '2026-08-01T10:00Z'];
const FAMILY_POOL = [...Object.keys(FAMILY_LABELS), 'junk_family'];

/** Store copy rules (docs/APP_STORE_SUBMISSION.md) the module's copy helpers
 * must never violate, whatever the persisted tokens look like. */
const FORBIDDEN_COPY =
  /android|google play|guest mode|live court|dupr|swingvision|pb vision|selkirk|joola|\d+\s*%|best|perfect|guaranteed/i;

// ─── Action script (fully resolved at generation, replayable & minimizable) ─

interface CheckpointSpec {
  key: string;
  score: number | null;
  applicable: boolean;
}

type Action =
  | {
      kind: 'record';
      technique: string;
      /** Milliseconds after the sequence epoch; may be negative for
       * back-dated (synced-from-another-device) reads. */
      atMs: number;
      /** Reuse the instant of the fact at this fraction of the store
       * instead of `atMs` (identical-timestamp tie). */
      tieWith: number | null;
      checkpoints: CheckpointSpec[];
      /** Reuse the id of an existing fact (fraction) — duplicate id. */
      duplicateIdWith: number | null;
      /** Replace the instant with a malformed string. */
      malformedInstant: string | null;
    }
  | { kind: 'delete_one'; at: number }
  | { kind: 'delete_technique'; technique: string }
  | { kind: 'clear_all' }
  | { kind: 'reorder'; seed: number }
  | { kind: 'improve_focus'; atMs: number }
  | { kind: 'worsen_focus'; atMs: number }
  | { kind: 'recommend'; seed: number; catalogSize: number; limit: number }
  | { kind: 'display' };

interface ScriptOptions {
  /** Probability that a `record` uses a hostile shape (0 ⇒ purely legal). */
  hostileRate: number;
  /** Include the extreme-but-finite score class among hostile scores. */
  extremeFinite: boolean;
  /** Allow one hostile read to list the same checkpoint key more than once. */
  duplicateKeys: boolean;
}

function legalCheckpoints(rng: Rng): CheckpointSpec[] {
  const keys = shuffled(rng, CHECKPOINTS).slice(
    0,
    int(rng, 3, CHECKPOINTS.length),
  );
  return keys.map(key => {
    const applicable = rng() < 0.85;
    const observed = rng() < 0.85;
    return {
      key,
      score: observed ? int(rng, 0, 100) : null,
      applicable,
    };
  });
}

function hostileCheckpoints(
  rng: Rng,
  options: ScriptOptions,
): CheckpointSpec[] {
  const base = legalCheckpoints(rng);
  const corrupt = int(rng, 0, 3);
  for (let i = 0; i < corrupt; i += 1) {
    const roll = rng();
    const scorePool =
      options.extremeFinite && rng() < 0.5
        ? EXTREME_FINITE_SCORES
        : HOSTILE_SCORES;
    const key = roll < 0.4 ? pick(rng, HOSTILE_KEYS) : pick(rng, CHECKPOINTS);
    if (!options.duplicateKeys && base.some(existing => existing.key === key))
      continue;
    base.push({
      key,
      score: roll < 0.2 ? int(rng, 0, 100) : pick(rng, scorePool),
      applicable: rng() < 0.8,
    });
  }
  return shuffled(rng, base);
}

function generateScript(seed: number, options: ScriptOptions): Action[] {
  const rng = mulberry32(seed);
  const length = int(rng, 5, 60);
  const actions: Action[] = [];
  let clockMs = 0;
  for (let step = 0; step < length; step += 1) {
    const roll = rng();
    if (roll < 0.5) {
      clockMs += int(rng, 1, 3 * 24 * 3600 * 1000);
      const hostile = rng() < options.hostileRate;
      const variant = rng();
      actions.push({
        kind: 'record',
        technique:
          hostile && variant < 0.3
            ? pick(rng, HOSTILE_TECHNIQUES)
            : pick(rng, LEGAL_TECHNIQUES),
        atMs:
          variant < 0.15
            ? clockMs - int(rng, 1, 30 * 24 * 3600 * 1000)
            : clockMs,
        tieWith: !hostile && variant >= 0.15 && variant < 0.25 ? rng() : null,
        checkpoints: hostile
          ? hostileCheckpoints(rng, options)
          : legalCheckpoints(rng),
        duplicateIdWith:
          hostile && variant >= 0.3 && variant < 0.4 ? rng() : null,
        malformedInstant:
          hostile && variant >= 0.4 && variant < 0.5
            ? pick(rng, HOSTILE_INSTANTS)
            : null,
      });
    } else if (roll < 0.6) {
      actions.push({ kind: 'delete_one', at: rng() });
    } else if (roll < 0.64) {
      actions.push({
        kind: 'delete_technique',
        technique: pick(rng, LEGAL_TECHNIQUES),
      });
    } else if (roll < 0.66) {
      actions.push({ kind: 'clear_all' });
    } else if (roll < 0.74) {
      actions.push({ kind: 'reorder', seed: int(rng, 1, 2 ** 31) });
    } else if (roll < 0.8) {
      clockMs += int(rng, 1, 24 * 3600 * 1000);
      actions.push({ kind: 'improve_focus', atMs: clockMs });
    } else if (roll < 0.86) {
      clockMs += int(rng, 1, 24 * 3600 * 1000);
      actions.push({ kind: 'worsen_focus', atMs: clockMs });
    } else if (roll < 0.95) {
      actions.push({
        kind: 'recommend',
        seed: int(rng, 1, 2 ** 31),
        catalogSize: int(rng, 0, 40),
        limit: pick(rng, [-2, 0, 1, 2, 3, 3, 3, 5, 50]),
      });
    } else {
      actions.push({ kind: 'display' });
    }
  }
  return actions;
}

// ─── Independent reference model ────────────────────────────────────────────

interface PairEvidence {
  shotType: string;
  checkpoint: string;
  scores: number[];
  weights: number[];
  latest: string;
}

function newestFirst(
  facts: readonly ScoredCheckpointFact[],
): ScoredCheckpointFact[] {
  return [...facts].sort((a, b) => {
    if (a.capturedAt !== b.capturedAt)
      return a.capturedAt < b.capturedAt ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });
}

/** The newest RANK_FORM_WINDOW facts per technique, newest first. */
function formWindows(
  facts: readonly ScoredCheckpointFact[],
): Map<string, ScoredCheckpointFact[]> {
  const windows = new Map<string, ScoredCheckpointFact[]>();
  for (const fact of newestFirst(facts)) {
    const list = windows.get(fact.shotType) ?? [];
    if (list.length < RANK_FORM_WINDOW) list.push(fact);
    windows.set(fact.shotType, list);
  }
  return windows;
}

function observed(score: number | null, applicable: boolean): score is number {
  return applicable && score !== null && Number.isFinite(score);
}

/** Every (technique, checkpoint) pair with its in-window observations. */
function pairEvidence(facts: readonly ScoredCheckpointFact[]): PairEvidence[] {
  const pairs: PairEvidence[] = [];
  for (const [shotType, window] of formWindows(facts)) {
    const keys = [
      ...new Set(window.flatMap(fact => fact.checkpoints.map(c => c.key))),
    ];
    for (const checkpoint of keys) {
      const evidence: PairEvidence = {
        shotType,
        checkpoint,
        scores: [],
        weights: [],
        latest: '',
      };
      window.forEach((fact, index) => {
        for (const c of fact.checkpoints) {
          if (c.key !== checkpoint || !observed(c.score, c.applicable))
            continue;
          if (evidence.scores.length === 0) evidence.latest = fact.capturedAt;
          evidence.scores.push(c.score);
          evidence.weights.push(window.length - index);
        }
      });
      if (evidence.scores.length > 0) pairs.push(evidence);
    }
  }
  return pairs;
}

function weightedAverage(evidence: PairEvidence): number {
  let sum = 0;
  let weight = 0;
  evidence.scores.forEach((score, i) => {
    sum += score * evidence.weights[i]!;
    weight += evidence.weights[i]!;
  });
  return sum / weight;
}

function checkpointRank(key: string): number {
  const index = (CHECKPOINTS as readonly string[]).indexOf(key);
  return index === -1 ? CHECKPOINTS.length : index;
}

function referenceFocus(
  facts: readonly ScoredCheckpointFact[],
): LibraryFocus | null {
  const candidates = pairEvidence(facts)
    .filter(evidence => evidence.scores.length >= MIN_FOCUS_SAMPLES)
    .map(evidence => ({
      shotType: evidence.shotType,
      checkpoint: evidence.checkpoint,
      averageScore: Math.round(weightedAverage(evidence)),
      sampleCount: evidence.scores.length,
      family: SHOT_FAMILY[evidence.shotType] ?? 'global',
      latest: evidence.latest,
    }));
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      a.averageScore - b.averageScore ||
      b.sampleCount - a.sampleCount ||
      (a.latest === b.latest ? 0 : a.latest < b.latest ? 1 : -1) ||
      checkpointRank(a.checkpoint) - checkpointRank(b.checkpoint) ||
      (a.shotType < b.shotType ? -1 : a.shotType > b.shotType ? 1 : 0),
  );
  const { latest: _latest, ...best } = candidates[0]!;
  return best;
}

// ─── Model state + invariant checks ─────────────────────────────────────────

class InvariantViolation extends Error {
  constructor(
    readonly invariant: string,
    detail: string,
  ) {
    super(`${invariant}: ${detail}`);
  }
}

function assertInvariant(
  condition: boolean,
  invariant: string,
  detail: () => string,
): void {
  if (!condition) throw new InvariantViolation(invariant, detail());
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'number' && !Number.isFinite(v) ? `__${String(v)}__` : v,
  );
}

function isWellFormedFocus(value: unknown): value is LibraryFocus {
  if (typeof value !== 'object' || value === null) return false;
  const focus = value as Record<string, unknown>;
  return (
    Object.keys(focus).sort().join(',') ===
      'averageScore,checkpoint,family,sampleCount,shotType' &&
    typeof focus['shotType'] === 'string' &&
    typeof focus['checkpoint'] === 'string' &&
    typeof focus['averageScore'] === 'number' &&
    typeof focus['sampleCount'] === 'number' &&
    typeof focus['family'] === 'string'
  );
}

interface Drill {
  slug: string;
  families: string[];
}

interface ModelState {
  facts: ScoredCheckpointFact[];
  nextId: number;
  epochMs: number;
}

const REPOSITORY_FACT_LIMIT = 120;

function instantFor(state: ModelState, atMs: number): string {
  return new Date(state.epochMs + atMs).toISOString();
}

function freshId(state: ModelState): string {
  state.nextId += 1;
  return `00000000-0000-4000-8000-${String(state.nextId).padStart(12, '0')}`;
}

function pairAverage(
  facts: readonly ScoredCheckpointFact[],
  shotType: string,
  checkpoint: string,
): { average: number; legal: boolean } | null {
  const evidence = pairEvidence(facts).find(
    e => e.shotType === shotType && e.checkpoint === checkpoint,
  );
  if (!evidence) return null;
  return {
    average: weightedAverage(evidence),
    legal: evidence.scores.every(score => score >= 0 && score <= 100),
  };
}

/** Full invariant sweep over the current store. Returns the focus. */
function checkFocusInvariants(
  facts: readonly ScoredCheckpointFact[],
): LibraryFocus | null {
  const before = stableJson(facts);
  const focus = computeLibraryFocus(facts);
  assertInvariant(
    focus === null || isWellFormedFocus(focus),
    'I1 well-formed',
    () => `got ${stableJson(focus)}`,
  );

  const reference = referenceFocus(facts);
  assertInvariant(
    stableJson(focus) === stableJson(reference),
    'I2 reference model',
    () =>
      `production ${stableJson(focus)} vs reference ${stableJson(reference)}`,
  );

  const pairs = pairEvidence(facts);
  const evidenced = pairs.filter(e => e.scores.length >= MIN_FOCUS_SAMPLES);
  if (focus === null) {
    assertInvariant(
      evidenced.length === 0,
      'I5 null only without evidence',
      () => `null focus but ${evidenced.length} evidenced pair(s)`,
    );
  } else {
    assertInvariant(
      Number.isFinite(focus.averageScore) &&
        Number.isInteger(focus.averageScore),
      'I3 finite integer average',
      () => `averageScore=${String(focus.averageScore)}`,
    );
    const own = pairs.find(
      e => e.shotType === focus.shotType && e.checkpoint === focus.checkpoint,
    );
    assertInvariant(own !== undefined, 'I3 focus pair exists', () =>
      stableJson(focus),
    );
    const min = Math.min(...own!.scores);
    const max = Math.max(...own!.scores);
    assertInvariant(
      focus.averageScore >= Math.floor(min) &&
        focus.averageScore <= Math.ceil(max),
      'I3 average bounded by observations',
      () => `${focus.averageScore} outside [${min}, ${max}]`,
    );
    if (min >= 0 && max <= 100) {
      assertInvariant(
        focus.averageScore >= 0 && focus.averageScore <= 100,
        'I3 average in 0-100 for legal scores',
        () => String(focus.averageScore),
      );
    }
    assertInvariant(
      focus.sampleCount === own!.scores.length &&
        focus.sampleCount >= MIN_FOCUS_SAMPLES &&
        focus.sampleCount <= RANK_FORM_WINDOW,
      'I3 sampleCount',
      () => `${focus.sampleCount} vs ${own!.scores.length}`,
    );
    assertInvariant(
      focus.family === (SHOT_FAMILY[focus.shotType] ?? 'global'),
      'I3 family mapping',
      () => `${focus.shotType} → ${focus.family}`,
    );
    const weaker = evidenced.filter(
      e => Math.round(weightedAverage(e)) < focus.averageScore,
    );
    assertInvariant(
      weaker.length === 0,
      'I4 weakest evidenced pair',
      () =>
        `weaker pairs: ${stableJson(weaker.map(e => [e.shotType, e.checkpoint, Math.round(weightedAverage(e))]))}`,
    );
  }

  // I6 storage order never matters.
  const orderRng = mulberry32(facts.length * 7919 + 17);
  const expected = stableJson(focus);
  assertInvariant(
    stableJson(computeLibraryFocus(shuffled(orderRng, facts))) === expected &&
      stableJson(computeLibraryFocus([...facts].reverse())) === expected,
    'I6 order independence',
    () => 'shuffled or reversed input changed the focus',
  );

  // I7 purity + idempotence.
  assertInvariant(
    stableJson(facts) === before &&
      stableJson(computeLibraryFocus(facts)) === expected,
    'I7 purity/idempotence',
    () => 'input mutated or second call differed',
  );

  // I13 a read observes a checkpoint at most once.
  const windows = formWindows(facts);
  if (focus !== null) {
    const readsObserving = (windows.get(focus.shotType) ?? []).filter(fact =>
      fact.checkpoints.some(
        c =>
          c.key === focus.checkpoint &&
          c.applicable &&
          c.score !== null &&
          Number.isFinite(c.score),
      ),
    ).length;
    assertInvariant(
      focus.sampleCount <= readsObserving,
      'I13 sampleCount ≤ distinct reads',
      () =>
        `sampleCount=${focus.sampleCount} but only ${readsObserving} read(s) observed ${focus.checkpoint}`,
    );
  }

  // I8 only the form window counts.
  const inWindow = new Set<ScoredCheckpointFact>();
  for (const window of windows.values())
    for (const fact of window) inWindow.add(fact);
  const windowOnly = facts.filter(fact => inWindow.has(fact));
  assertInvariant(
    stableJson(computeLibraryFocus(windowOnly)) === expected,
    'I8 out-of-window facts irrelevant',
    () =>
      `dropping ${facts.length - windowOnly.length} out-of-window fact(s) changed the focus`,
  );
  for (const [technique, window] of windows) {
    if (window.length < RANK_FORM_WINDOW) continue;
    const ancient: ScoredCheckpointFact = {
      id: '00000000-0000-4000-8000-000000000000',
      shotType: technique,
      capturedAt: '1970-01-01T00:00:00.000Z',
      checkpoints: CHECKPOINTS.map(key => ({
        key,
        score: 0,
        applicable: true,
      })),
    };
    // Recency is the module's documented string order; a malformed instant
    // that sorts before the epoch would legitimately be displaced by it.
    if (
      facts.some(
        fact =>
          fact.shotType === technique && fact.capturedAt <= ancient.capturedAt,
      )
    )
      break;
    assertInvariant(
      stableJson(computeLibraryFocus([ancient, ...facts])) === expected,
      'I8 ancient fact irrelevant',
      () => `an ancient ${technique} read changed the focus`,
    );
    break;
  }

  // I9 the repository's newest-120 projection is exact for ≤ 15 techniques.
  if (
    facts.length > REPOSITORY_FACT_LIMIT &&
    windows.size * RANK_FORM_WINDOW <= REPOSITORY_FACT_LIMIT
  ) {
    const projected = newestFirst(facts).slice(0, REPOSITORY_FACT_LIMIT);
    assertInvariant(
      stableJson(computeLibraryFocus(projected)) === expected,
      'I9 repository projection',
      () => 'newest-120 projection changed the focus',
    );
  }

  return focus;
}

function checkRecommendInvariants(
  drills: readonly Drill[],
  focus: LibraryFocus,
  limit: number,
): void {
  const result = recommendDrills(drills, focus, limit);
  assertInvariant(
    result.length <= Math.max(0, limit),
    'I11 bounded',
    () => `${result.length} > ${limit}`,
  );
  assertInvariant(
    new Set(result).size === result.length,
    'I11 deduplicated',
    () => stableJson(result.map(d => d.slug)),
  );
  const isPrimary = (drill: Drill) => drill.families.includes(focus.family);
  const isFill = (drill: Drill) =>
    focus.family !== 'global' && drill.families.includes('global');
  let seenFill = false;
  let lastPrimaryIndex = -1;
  let lastFillIndex = -1;
  for (const drill of result) {
    assertInvariant(
      drills.includes(drill),
      'I11 subset of catalog',
      () => drill.slug,
    );
    assertInvariant(
      isPrimary(drill) || isFill(drill),
      'I11 family honesty',
      () =>
        `${drill.slug} ${stableJson(drill.families)} for family ${focus.family}`,
    );
    const index = drills.indexOf(drill);
    if (isPrimary(drill)) {
      assertInvariant(!seenFill, 'I11 primary before fill', () => drill.slug);
      assertInvariant(
        index > lastPrimaryIndex,
        'I11 catalog order (primary)',
        () => drill.slug,
      );
      lastPrimaryIndex = index;
    } else {
      seenFill = true;
      assertInvariant(
        index > lastFillIndex,
        'I11 catalog order (fill)',
        () => drill.slug,
      );
      lastFillIndex = index;
    }
  }
  const eligible = drills.filter(d => isPrimary(d) || isFill(d));
  assertInvariant(
    result.length === Math.min(Math.max(0, limit), eligible.length),
    'I11 fills the limit when eligible drills exist',
    () => `${result.length} of ${eligible.length} eligible, limit ${limit}`,
  );
  assertInvariant(
    stableJson(recommendDrills(drills, focus, limit)) === stableJson(result),
    'I11 deterministic',
    () => 'second call differed',
  );
}

function checkDisplayInvariants(focus: LibraryFocus | null): void {
  if (focus !== null) {
    const line = focusEvidenceLine(focus);
    const expected = `${techniqueDisplayName(focus.shotType)} · from ${focus.sampleCount} recent scored read${
      focus.sampleCount === 1 ? '' : 's'
    }`;
    assertInvariant(
      line === expected,
      'I12 evidence line',
      () => `${line} vs ${expected}`,
    );
    assertInvariant(
      /^.* · from \d+ recent scored reads?$/.test(line) &&
        !FORBIDDEN_COPY.test(line),
      'I12 evidence line copy',
      () => line,
    );
    const family = familyDisplayLabel(focus.family);
    assertInvariant(
      family === (FAMILY_LABELS[focus.family] ?? family) &&
        family.length > 0 &&
        !FORBIDDEN_COPY.test(family),
      'I12 family label',
      () => family,
    );
    const name = checkpointDisplayName(focus.checkpoint);
    assertInvariant(
      (CHECKPOINT_NAMES[focus.checkpoint] === undefined ||
        name === CHECKPOINT_NAMES[focus.checkpoint]) &&
        !FORBIDDEN_COPY.test(name),
      'I12 checkpoint name',
      () => name,
    );
    if (focus.shotType.trim().length > 0) {
      const technique = techniqueDisplayName(focus.shotType);
      assertInvariant(
        technique.length > 0 &&
          technique[0] === technique[0]!.toUpperCase() &&
          !technique.includes('_'),
        'I12 technique name',
        () => technique,
      );
    }
  }
  for (const key of CHECKPOINTS) {
    assertInvariant(
      checkpointDisplayName(key) === CHECKPOINT_NAMES[key],
      'I12 canonical checkpoint names',
      () => key,
    );
  }
  for (const family of Object.keys(FAMILY_LABELS)) {
    assertInvariant(
      familyDisplayLabel(family) === FAMILY_LABELS[family],
      'I12 canonical family labels',
      () => family,
    );
  }
}

// ─── Execution ──────────────────────────────────────────────────────────────

interface StepTrace {
  step: number;
  kind: Action['kind'];
  facts: number;
  focus: string;
}

interface RunResult {
  trace: StepTrace[];
  failure: { step: number; invariant: string; detail: string } | null;
  focusSteps: number;
}

function applyAction(
  state: ModelState,
  action: Action,
  previousFocus: LibraryFocus | null,
): void {
  switch (action.kind) {
    case 'record': {
      const tie =
        action.tieWith !== null && state.facts.length > 0
          ? state.facts[Math.floor(action.tieWith * state.facts.length)]!
              .capturedAt
          : null;
      const duplicate =
        action.duplicateIdWith !== null && state.facts.length > 0
          ? state.facts[
              Math.floor(action.duplicateIdWith * state.facts.length)
            ]!.id
          : null;
      state.facts.push({
        id: duplicate ?? freshId(state),
        shotType: action.technique,
        capturedAt:
          action.malformedInstant ?? tie ?? instantFor(state, action.atMs),
        checkpoints: action.checkpoints.map(c => ({ ...c })),
      });
      return;
    }
    case 'delete_one':
      if (state.facts.length > 0)
        state.facts.splice(Math.floor(action.at * state.facts.length), 1);
      return;
    case 'delete_technique':
      state.facts = state.facts.filter(
        fact => fact.shotType !== action.technique,
      );
      return;
    case 'clear_all':
      state.facts = [];
      return;
    case 'reorder':
      state.facts = shuffled(mulberry32(action.seed), state.facts);
      return;
    case 'improve_focus':
    case 'worsen_focus': {
      if (previousFocus === null) return;
      state.facts.push({
        id: freshId(state),
        shotType: previousFocus.shotType,
        capturedAt: instantFor(state, action.atMs),
        checkpoints: [
          {
            key: previousFocus.checkpoint,
            score: action.kind === 'improve_focus' ? 100 : 0,
            applicable: true,
          },
        ],
      });
      return;
    }
    case 'recommend':
    case 'display':
      return;
  }
}

function runScript(seed: number, actions: readonly Action[]): RunResult {
  const state: ModelState = {
    facts: [],
    nextId: 0,
    epochMs: Date.UTC(2026, 0, 1),
  };
  const trace: StepTrace[] = [];
  let focus: LibraryFocus | null = null;
  let focusSteps = 0;
  for (let step = 0; step < actions.length; step += 1) {
    const action = actions[step]!;
    try {
      const previousFocus = focus;
      const beforeFacts = state.facts;
      const beforePair =
        (action.kind === 'improve_focus' || action.kind === 'worsen_focus') &&
        previousFocus
          ? pairAverage(
              beforeFacts,
              previousFocus.shotType,
              previousFocus.checkpoint,
            )
          : null;

      applyAction(state, action, previousFocus);
      focus = checkFocusInvariants(state.facts);
      if (focus !== null) focusSteps += 1;

      if (
        (action.kind === 'improve_focus' || action.kind === 'worsen_focus') &&
        previousFocus
      ) {
        const afterPair = pairAverage(
          state.facts,
          previousFocus.shotType,
          previousFocus.checkpoint,
        );
        assertInvariant(afterPair !== null, 'I10 pair persists', () =>
          stableJson(previousFocus),
        );
        if (beforePair && beforePair.legal && afterPair!.legal) {
          const ok =
            action.kind === 'improve_focus'
              ? afterPair!.average >= beforePair.average - 1e-9
              : afterPair!.average <= beforePair.average + 1e-9;
          assertInvariant(
            ok,
            `I10 ${action.kind} monotonic`,
            () =>
              `${previousFocus.shotType}/${previousFocus.checkpoint}: ${beforePair.average} → ${afterPair!.average}`,
          );
        }
      }
      if (action.kind === 'recommend' && focus !== null) {
        const rng = mulberry32(action.seed);
        const drills: Drill[] = Array.from(
          { length: action.catalogSize },
          (_, i) => ({
            slug: `drill-${seed}-${step}-${i}`,
            families: Array.from({ length: int(rng, 0, 2) }, () =>
              pick(rng, FAMILY_POOL),
            ),
          }),
        );
        checkRecommendInvariants(drills, focus, action.limit);
      }
      if (action.kind === 'display') checkDisplayInvariants(focus);

      trace.push({
        step,
        kind: action.kind,
        facts: state.facts.length,
        focus: stableJson(focus),
      });
    } catch (error) {
      const invariant =
        error instanceof InvariantViolation
          ? error.invariant
          : 'I1 never throws';
      const detail = error instanceof Error ? error.message : String(error);
      return { trace, failure: { step, invariant, detail }, focusSteps };
    }
  }
  return { trace, failure: null, focusSteps };
}

/** ddmin over the action script: smallest sub-script still failing the SAME
 * invariant. */
function minimize(
  seed: number,
  actions: readonly Action[],
  invariant: string,
): Action[] {
  const fails = (candidate: readonly Action[]) => {
    const result = runScript(seed, candidate);
    return result.failure !== null && result.failure.invariant === invariant;
  };
  let current = [...actions];
  let granularity = 2;
  while (current.length >= 2) {
    const chunk = Math.ceil(current.length / granularity);
    let reduced = false;
    for (let start = 0; start < current.length; start += chunk) {
      const candidate = [
        ...current.slice(0, start),
        ...current.slice(start + chunk),
      ];
      if (candidate.length > 0 && fails(candidate)) {
        current = candidate;
        granularity = Math.max(granularity - 1, 2);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (granularity >= current.length) break;
      granularity = Math.min(current.length, granularity * 2);
    }
  }
  return current;
}

interface SequenceOutcome {
  seed: number;
  length: number;
  outcome: 'HELD' | 'BROKEN';
  focusSteps: number;
  deterministic: boolean;
  failure: { step: number; invariant: string; detail: string } | null;
  minimized: { length: number; actions: Action[] } | null;
}

interface Campaign {
  label: string;
  baseSeed: number;
  iterations: number;
  options: ScriptOptions;
  scenariosExecuted: number;
  held: number;
  broken: number;
  nonDeterministic: number;
  invariantHistogram: Record<string, number>;
  actionHistogram: Record<string, number>;
  outcomes: SequenceOutcome[];
}

function runCampaign(
  label: string,
  baseSeed: number,
  iterations: number,
  options: ScriptOptions,
): Campaign {
  const campaign: Campaign = {
    label,
    baseSeed,
    iterations,
    options,
    scenariosExecuted: 0,
    held: 0,
    broken: 0,
    nonDeterministic: 0,
    invariantHistogram: {},
    actionHistogram: {},
    outcomes: [],
  };
  for (let i = 0; i < iterations; i += 1) {
    const seed = baseSeed + i;
    const actions = generateScript(seed, options);
    const first = runScript(seed, actions);
    const second = runScript(seed, generateScript(seed, options));
    const deterministic =
      stableJson(first.trace) === stableJson(second.trace) &&
      stableJson(first.failure) === stableJson(second.failure);
    campaign.scenariosExecuted += 1;
    for (const action of actions) {
      campaign.actionHistogram[action.kind] =
        (campaign.actionHistogram[action.kind] ?? 0) + 1;
    }
    if (!deterministic) campaign.nonDeterministic += 1;
    const outcome: SequenceOutcome = {
      seed,
      length: actions.length,
      outcome: first.failure === null && deterministic ? 'HELD' : 'BROKEN',
      focusSteps: first.focusSteps,
      deterministic,
      failure: first.failure,
      minimized: null,
    };
    if (first.failure !== null) {
      const minimized = minimize(seed, actions, first.failure.invariant);
      outcome.minimized = { length: minimized.length, actions: minimized };
      campaign.invariantHistogram[first.failure.invariant] =
        (campaign.invariantHistogram[first.failure.invariant] ?? 0) + 1;
    }
    if (outcome.outcome === 'HELD') campaign.held += 1;
    else campaign.broken += 1;
    campaign.outcomes.push(outcome);
  }
  return campaign;
}

function writeReport(campaigns: readonly Campaign[]): void {
  const path = process.env['STRESS_REPORT'];
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify(
      {
        unit: 'apps/mobile/src/library/libraryFocus.ts',
        lens: 'randomized-seeded',
        generatedAt: new Date().toISOString(),
        node: process.version,
        campaigns: campaigns.map(campaign => ({
          ...campaign,
          outcomes: campaign.outcomes.map(outcome => ({
            ...outcome,
            // Keep the table compact: HELD rows carry seed/length/focusSteps only.
            minimized: outcome.minimized,
          })),
        })),
      },
      null,
      2,
    ),
  );
}

const ITERATIONS = Math.max(
  1,
  Number(process.env['STRESS_ITER'] ?? 250) || 250,
);
const BASE_SEED = Number(process.env['STRESS_SEED'] ?? 20260904) || 20260904;

const MIXED: ScriptOptions = {
  hostileRate: 0.12,
  extremeFinite: false,
  duplicateKeys: false,
};
const LEGAL: ScriptOptions = {
  hostileRate: 0,
  extremeFinite: false,
  duplicateKeys: false,
};
const EXTREME_FINITE: ScriptOptions = {
  hostileRate: 0.35,
  extremeFinite: true,
  duplicateKeys: false,
};
const DUPLICATE_KEYS: ScriptOptions = {
  hostileRate: 0.35,
  extremeFinite: false,
  duplicateKeys: true,
};

const campaigns: Campaign[] = [];
afterAll(() => writeReport(campaigns));

/** Compact failure digest so a red run names its seeds without a wall of JSON. */
function brokenDigest(campaign: Campaign): {
  seed: number;
  invariant: string;
  detail: string;
  minimizedLength: number;
}[] {
  return campaign.outcomes
    .filter(o => o.outcome === 'BROKEN')
    .slice(0, 5)
    .map(o => ({
      seed: o.seed,
      invariant:
        o.failure?.invariant ??
        (o.deterministic ? 'unknown' : 'non-deterministic replay'),
      detail: o.failure?.detail ?? '',
      minimizedLength: o.minimized?.length ?? o.length,
    }));
}

describe('libraryFocus — seeded randomized long-run (legal + near-legal histories)', () => {
  it(`holds every honesty invariant on ${ITERATIONS} seeded sequences of 5–60 actions and replays each seed identically`, () => {
    const campaign = runCampaign('mixed', BASE_SEED, ITERATIONS, MIXED);
    campaigns.push(campaign);
    expect(brokenDigest(campaign)).toEqual([]);
    expect(campaign.scenariosExecuted).toBe(ITERATIONS);
    // The generator must actually exercise the focus path, not just empty stores.
    expect(
      campaign.outcomes.filter(o => o.focusSteps > 0).length,
    ).toBeGreaterThan(ITERATIONS / 2);
  });

  it(`holds on ${ITERATIONS} purely legal sequences (what the scoring engine can persist)`, () => {
    const campaign = runCampaign(
      'legal',
      BASE_SEED + 1_000_000,
      ITERATIONS,
      LEGAL,
    );
    campaigns.push(campaign);
    expect(brokenDigest(campaign)).toEqual([]);
  });

  it('replays a fixed seed to a byte-identical trace 10× in a row', () => {
    const actions = generateScript(BASE_SEED, MIXED);
    const reference = stableJson(runScript(BASE_SEED, actions));
    for (let i = 0; i < 10; i += 1) {
      expect(
        stableJson(runScript(BASE_SEED, generateScript(BASE_SEED, MIXED))),
      ).toBe(reference);
    }
  });
});

describe('libraryFocus — non-conforming persisted payloads (corrupt local DB)', () => {
  /**
   * libraryFocus.ts:144-150 states that a corrupt persisted score must never
   * poison the average and guards NaN/±Infinity. A score that is finite but
   * of magnitude ~1e308 passes that guard, `score * weight` overflows to
   * ±Infinity and the focus is emitted with a non-finite averageScore. The
   * assertion is the module's own contract.
   */
  it(`keeps averageScore finite on ${ITERATIONS} sequences that include ±1e308 scores`, () => {
    const campaign = runCampaign(
      'extreme-finite',
      BASE_SEED + 2_000_000,
      ITERATIONS,
      EXTREME_FINITE,
    );
    campaigns.push(campaign);
    expect(brokenDigest(campaign)).toEqual([]);
  });

  /**
   * libraryFocus.ts:17-19 / :40 define sampleCount as the number of recent
   * reads that observed the checkpoint and MIN_FOCUS_SAMPLES as "one bad read
   * is a data point, not a diagnosis". A read whose checkpoint list repeats a
   * key is counted once per entry, so a single read can clear the gate.
   */
  it(`counts a read at most once per checkpoint on ${ITERATIONS} sequences with repeated checkpoint keys`, () => {
    const campaign = runCampaign(
      'duplicate-keys',
      BASE_SEED + 3_000_000,
      ITERATIONS,
      DUPLICATE_KEYS,
    );
    campaigns.push(campaign);
    expect(brokenDigest(campaign)).toEqual([]);
  });
});
