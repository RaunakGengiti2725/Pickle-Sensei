/**
 * STRESS / boundary + malformed input — `library/libraryFocus`.
 *
 * The focus engine consumes facts that `repository.listScoredCheckpointFacts`
 * lifts out of locally persisted JSON payloads, and the drill library renders
 * whatever it returns through the display helpers. A corrupt row, a future
 * schema, or a prototype-shaped key must therefore never crash the library,
 * never produce a non-finite or fabricated score, never pollute prototypes,
 * and never make the pure engine non-deterministic.
 *
 * Scenarios (each `STRESS_ITER` seeded iterations, every seed replayable):
 *   typed-hostile-strings   type-conforming facts with hostile string content
 *                           (prototype keys, 64 KB+ strings, null bytes,
 *                           NFC/NFD pairs, ZWJ graphemes, path traversal,
 *                           injection strings) and edge-of-double scores;
 *   json-shaped-wrong-types facts shaped exactly as repository.ts builds them
 *                           (String()-ed keys, finite-or-null scores, boolean
 *                           applicable) but with id/shotType/capturedAt as
 *                           arbitrary JSON values — the repository does not
 *                           re-check those three fields;
 *   runtime-wrong-types     every field an arbitrary runtime value (non-array
 *                           checkpoints, null elements, symbols, functions,
 *                           null-prototype objects, BigInt, invalid Date);
 *   json-bytes-corruption   a valid fact list serialized, then truncated /
 *                           byte-flipped / __proto__-injected / schema-bumped /
 *                           re-wrapped, parsed, and fed through;
 *   numeric-boundaries      valid strings, scores drawn from NaN, ±Infinity,
 *                           ±0, ±1e308, MAX_VALUE, MIN_VALUE, 2^53±1, …;
 *   prototype-keys          shotType / checkpoint keys drawn from the
 *                           Object.prototype vocabulary with enough samples
 *                           that the engine must resolve them;
 *   empty-and-degenerate    empty arrays/objects, thousands of identical
 *                           facts, window-size boundaries, zero-length keys;
 *   recommendDrills-malformed  hostile catalog shapes, families, focus and
 *                           limits (NaN, ±Infinity, -0, 1.5, 1e308, …).
 *
 * Invariants asserted on EVERY seed (contract = what the callers rely on):
 *   no-throw     computeLibraryFocus / recommendDrills return, never throw;
 *   shape        focus is null or {string, string, finite integer, integer
 *                ≥ MIN_FOCUS_SAMPLES, string};
 *   family       focus.family is SHOT_FAMILY's OWN value for shotType, else
 *                'global' (inherited Object.prototype members are not families);
 *   hull         averageScore lies inside [floor(min), ceil(max)] of the finite
 *                applicable scores observed for (shotType, checkpoint);
 *   determinism  the reversed input and three seeded shuffles yield the same
 *                focus;
 *   display      checkpointDisplayName / techniqueDisplayName /
 *                familyDisplayLabel / focusEvidenceLine return strings and
 *                never throw for the focus the engine itself produced;
 *   pollution    Object.prototype and the exported records are unchanged;
 *   purity       inputs are deep-frozen — any write throws and is caught as
 *                a no-throw violation;
 *   time         one call completes within 2 s even with 64 KB+ strings.
 *
 * Replay:   STRESS_SEED=<seed> npx jest __tests__/stress/libraryFocus.boundaryMalformed
 * Campaign: STRESS_ITER=500 STRESS_RUN_ID=<id> npx jest __tests__/stress/libraryFocus.boundaryMalformed
 *           → apps/mobile/artifacts/stress/<id>/libraryFocus.boundaryMalformed.json
 *
 * Status at 1fb0efd7 (campaign run 2026-09-04, 4000 seeds): this suite is
 * RED on purpose — it is the regression guard for the contract gaps it found
 * (finite-but-huge scores → ±Infinity/NaN averageScore; non-string shotType
 * and Object.prototype-named shotType/checkpoint keys reach the display
 * helpers and throw or return non-strings; non-string capturedAt or duplicate
 * (id, capturedAt) pairs make the result input-order dependent; wrong-shaped
 * facts throw out of computeLibraryFocus). It goes green when those are fixed.
 * Every failing test prints its seed; the artifact row carries the minimized
 * repro under `observed.minimal`.
 */
import { CHECKPOINTS, RANK_FORM_WINDOW } from '@pickle/shared-types';
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
import { CHECKPOINT_NAMES } from '../../src/components/strokeResultModel';
import {
  HOSTILE_NUMBERS,
  NFC_E_ACUTE,
  NFD_E_ACUTE,
  NULL_BYTE,
  PROTOTYPE_KEYS,
  Violations,
  ZWJ_FAMILY,
  createRng,
  deepFreeze,
  describeValue,
  flushStressTable,
  hostileJsonValue,
  hostileRuntimeValue,
  hostileString,
  hugeString,
  recordStressRow,
  stressSeeds,
  type Rng,
} from '../../testing/stress/malformedInputs';

const SUITE = 'libraryFocus.boundaryMalformed';
const CALL_BUDGET_MS = 2_000;

const TECHNIQUES = Object.keys(SHOT_FAMILY);
const KNOWN_KEYS: readonly string[] = CHECKPOINTS;

// ─── Fact generators ───────────────────────────────────────────────────────

type Loose = Record<string, unknown>;

function isoDay(rng: Rng): string {
  return `2026-0${1 + rng.int(9)}-${String(1 + rng.int(28)).padStart(2, '0')}T${String(
    rng.int(24),
  ).padStart(2, '0')}:00:00.000Z`;
}

function normalScore(rng: Rng): number {
  return Math.round(rng.next() * 100);
}

/** Type-conforming fact whose string content and numbers are hostile. */
function typedHostileFact(rng: Rng, index: number): ScoredCheckpointFact {
  const stringFor = (normal: () => string, hostileP: number) =>
    rng.chance(hostileP) ? hostileString(rng) : normal();
  const checkpoints = Array.from({ length: rng.int(6) }, () => {
    const roll = rng.next();
    const score =
      roll < 0.1
        ? null
        : roll < 0.3
          ? rng.pick(HOSTILE_NUMBERS)
          : normalScore(rng);
    return {
      key: stringFor(() => rng.pick(KNOWN_KEYS), 0.35),
      score,
      applicable: rng.chance(0.85),
    };
  });
  return {
    id: stringFor(() => `id-${index}`, 0.3),
    shotType: stringFor(() => rng.pick(TECHNIQUES), 0.35),
    capturedAt: stringFor(() => isoDay(rng), 0.25),
    checkpoints,
  };
}

/**
 * Exactly what repository.ts (`listScoredCheckpointFacts`) would build from a
 * corrupt but parseable payload: keys go through `String(...)`, scores are
 * finite-number-or-null, applicability is `=== true`, while id / shotType /
 * capturedAtIso are passed through untouched. `null` when the repository's
 * own try/catch would have dropped the row (e.g. a key of `{"toString":null}`
 * makes `String(key)` throw) — that is a graceful rejection, not a fact.
 */
function repositoryShapedFact(rng: Rng, index: number): Loose | null {
  const jsonOrNormal = (normal: () => unknown, hostileP: number) =>
    rng.chance(hostileP) ? hostileJsonValue(rng) : normal();
  try {
    const checkpoints = Array.from({ length: rng.int(6) }, () => {
      const rawScore = rng.chance(0.3)
        ? hostileJsonValue(rng)
        : normalScore(rng);
      return {
        key: String(
          rng.chance(0.4) ? hostileJsonValue(rng) : rng.pick(KNOWN_KEYS),
        ),
        score:
          typeof rawScore === 'number' && Number.isFinite(rawScore)
            ? rawScore
            : null,
        applicable: (rng.chance(0.3) ? hostileJsonValue(rng) : true) === true,
      };
    });
    return {
      id: jsonOrNormal(() => `id-${index}`, 0.4),
      shotType: jsonOrNormal(() => rng.pick(TECHNIQUES), 0.5),
      capturedAt: jsonOrNormal(() => isoDay(rng), 0.4),
      checkpoints,
    };
  } catch {
    return null;
  }
}

/** Anything at all, in every position. */
function runtimeHostileFact(rng: Rng, index: number): unknown {
  if (rng.chance(0.08)) return hostileRuntimeValue(rng);
  const maybe = (normal: () => unknown, p: number) =>
    rng.chance(p) ? hostileRuntimeValue(rng) : normal();
  const checkpoints = maybe(
    () =>
      Array.from({ length: rng.int(5) }, () =>
        maybe(
          () => ({
            key: maybe(() => rng.pick(KNOWN_KEYS), 0.4),
            score: maybe(() => normalScore(rng), 0.4),
            applicable: maybe(() => true, 0.4),
          }),
          0.15,
        ),
      ),
    0.2,
  );
  const fact: Loose = {
    id: maybe(() => `id-${index}`, 0.4),
    shotType: maybe(() => rng.pick(TECHNIQUES), 0.5),
    capturedAt: maybe(() => isoDay(rng), 0.4),
    checkpoints,
  };
  if (rng.chance(0.2))
    fact[hostileString(rng).slice(0, 24)] = hostileRuntimeValue(rng);
  if (rng.chance(0.1)) delete fact['checkpoints'];
  return fact;
}

function validFact(
  rng: Rng,
  index: number,
  shotType?: string,
): ScoredCheckpointFact {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    shotType: shotType ?? rng.pick(TECHNIQUES),
    capturedAt: isoDay(rng),
    checkpoints: Array.from({ length: 1 + rng.int(5) }, () => ({
      key: rng.pick(KNOWN_KEYS),
      score: rng.chance(0.1) ? null : normalScore(rng),
      applicable: rng.chance(0.9),
    })),
  };
}

function numericBoundaryFact(rng: Rng, index: number): ScoredCheckpointFact {
  return {
    id: `id-${index}`,
    shotType: rng.pick(TECHNIQUES),
    capturedAt: isoDay(rng),
    checkpoints: Array.from({ length: 1 + rng.int(5) }, () => ({
      key: rng.pick(KNOWN_KEYS),
      score: rng.chance(0.6) ? rng.pick(HOSTILE_NUMBERS) : normalScore(rng),
      applicable: rng.chance(0.9),
    })),
  };
}

/** Serialize, corrupt the bytes, parse (or reject), hand over whatever parsed. */
function corruptedJsonInput(
  rng: Rng,
  facts: readonly ScoredCheckpointFact[],
): { parsed: unknown; rejectedAtParse: boolean; mutation: string } {
  let text = JSON.stringify(facts);
  const mutation = rng.pick([
    'truncate',
    'null-byte',
    'quote-flip',
    'proto-inject',
    'schema-bump',
    'wrap-object',
    'wrap-string',
    'unicode-escape-break',
    'duplicate-keys',
    'huge-number',
    'nested-array',
  ]);
  switch (mutation) {
    case 'truncate':
      text = text.slice(0, rng.int(text.length + 1));
      break;
    case 'null-byte': {
      const at = rng.int(text.length + 1);
      text = `${text.slice(0, at)}${NULL_BYTE}${text.slice(at)}`;
      break;
    }
    case 'quote-flip': {
      const at = text.indexOf('"', rng.int(text.length));
      if (at !== -1) text = `${text.slice(0, at)}'${text.slice(at + 1)}`;
      break;
    }
    case 'proto-inject':
      text = text.replace(
        /\{"id"/g,
        () =>
          `{"__proto__":{"polluted":"${rng.int(1e9)}","applicable":true,"score":1},"constructor":{"prototype":{"polluted":1}},"id"`,
      );
      break;
    case 'schema-bump':
      text = text.replace(
        /\{"id"/g,
        `{"schemaVersion":${2 + rng.int(98)},"id"`,
      );
      break;
    case 'wrap-object':
      text = `{"facts":${text},"schemaVersion":${rng.int(9)}}`;
      break;
    case 'wrap-string':
      text = JSON.stringify(text);
      break;
    case 'unicode-escape-break':
      text = text.replace(/"id"/, '"\\ud83d"').replace(/"shotType"/, '"\\u00"');
      break;
    case 'duplicate-keys':
      text = text.replace(
        /"shotType":"([a-z_]+)"/g,
        (_m, s: string) =>
          `"shotType":"${s}","shotType":${JSON.stringify(hostileJsonValue(rng))}`,
      );
      break;
    case 'huge-number':
      text = text.replace(
        /"score":(\d+)/g,
        () =>
          `"score":${rng.pick(['1e999', '-1e999', '1e308', '9007199254740993', '-0', '1e-400'])}`,
      );
      break;
    case 'nested-array':
      text = `[${text}]`;
      break;
  }
  try {
    return { parsed: JSON.parse(text), rejectedAtParse: false, mutation };
  } catch {
    return { parsed: null, rejectedAtParse: true, mutation };
  }
}

// ─── Oracles ───────────────────────────────────────────────────────────────

function sameFocus(a: LibraryFocus | null, b: LibraryFocus | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Object.is(a.shotType, b.shotType) &&
    Object.is(a.checkpoint, b.checkpoint) &&
    Object.is(a.averageScore, b.averageScore) &&
    Object.is(a.sampleCount, b.sampleCount) &&
    Object.is(a.family, b.family)
  );
}

/** Finite applicable scores per (shotType, checkpoint key), by JS semantics. */
function observedHull(
  facts: unknown,
  shotType: unknown,
  checkpoint: unknown,
): { min: number; max: number; count: number } | null {
  if (!Array.isArray(facts)) return null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;
  for (const fact of facts) {
    if (fact === null || typeof fact !== 'object') continue;
    const loose = fact as Loose;
    if (
      !Object.is(loose['shotType'], shotType) &&
      loose['shotType'] !== shotType
    )
      continue;
    const checkpoints = loose['checkpoints'];
    if (!Array.isArray(checkpoints)) continue;
    for (const cp of checkpoints) {
      if (cp === null || typeof cp !== 'object') continue;
      const c = cp as Loose;
      if (c['key'] !== checkpoint || !c['applicable']) continue;
      const score = c['score'];
      if (typeof score !== 'number' || !Number.isFinite(score)) continue;
      min = Math.min(min, score);
      max = Math.max(max, score);
      count += 1;
    }
  }
  return count === 0 ? null : { min, max, count };
}

function ownFamily(shotType: unknown): string {
  return typeof shotType === 'string' &&
    Object.prototype.hasOwnProperty.call(SHOT_FAMILY, shotType)
    ? SHOT_FAMILY[shotType]!
    : 'global';
}

function errorLine(error: unknown): string {
  if (error instanceof Error)
    return `${error.name}: ${error.message}`.slice(0, 200);
  return `non-Error throw: ${String(describeValue(error))}`.slice(0, 200);
}

interface PrototypeSnapshot {
  objectProto: string[];
  arrayProto: string[];
  shotFamily: string;
  familyLabels: string;
  checkpointNames: string;
}

function snapshotPrototypes(): PrototypeSnapshot {
  return {
    objectProto: Reflect.ownKeys(Object.prototype).map(String).sort(),
    arrayProto: Reflect.ownKeys(Array.prototype).map(String).sort(),
    shotFamily: JSON.stringify(SHOT_FAMILY),
    familyLabels: JSON.stringify(FAMILY_LABELS),
    checkpointNames: JSON.stringify(CHECKPOINT_NAMES),
  };
}

function checkPollution(v: Violations, before: PrototypeSnapshot): void {
  const after = snapshotPrototypes();
  v.check(
    JSON.stringify(before.objectProto) === JSON.stringify(after.objectProto),
    'pollution: Object.prototype own keys changed',
  );
  v.check(
    JSON.stringify(before.arrayProto) === JSON.stringify(after.arrayProto),
    'pollution: Array.prototype own keys changed',
  );
  v.check(
    before.shotFamily === after.shotFamily,
    'pollution: SHOT_FAMILY changed',
  );
  v.check(
    before.familyLabels === after.familyLabels,
    'pollution: FAMILY_LABELS changed',
  );
  v.check(
    before.checkpointNames === after.checkpointNames,
    'pollution: CHECKPOINT_NAMES changed',
  );
  v.check(
    ({} as Loose)['polluted'] === undefined &&
      ([] as unknown as Loose)['polluted'] === undefined,
    'pollution: `polluted` member reachable on a fresh object',
  );
}

/**
 * Runs the engine over `input` and records every contract violation. Shared
 * by every fact scenario and by the shrinker, so the minimal repro is judged
 * by exactly the same invariants as the full one.
 */
function evaluateFocusInput(
  input: unknown,
  rng: Rng,
  v: Violations,
  observed: Loose,
): LibraryFocus | null {
  const before = snapshotPrototypes();
  const facts = input as readonly ScoredCheckpointFact[];
  let focus: LibraryFocus | null = null;
  const startedAt = Date.now();
  try {
    focus = computeLibraryFocus(facts);
  } catch (error) {
    v.list.push(`no-throw: computeLibraryFocus threw ${errorLine(error)}`);
    checkPollution(v, before);
    return null;
  }
  const wallMs = Date.now() - startedAt;
  observed['computeMs'] = wallMs;
  v.check(
    wallMs <= CALL_BUDGET_MS,
    `time: computeLibraryFocus took ${wallMs}ms`,
  );
  observed['focus'] = describeValue(focus);

  if (focus !== null) {
    v.check(
      typeof focus.shotType === 'string',
      `shape: shotType is ${typeof focus.shotType}`,
    );
    v.check(
      typeof focus.checkpoint === 'string',
      `shape: checkpoint is ${typeof focus.checkpoint}`,
    );
    v.check(
      Number.isFinite(focus.averageScore) &&
        Number.isInteger(focus.averageScore),
      `shape: averageScore is ${String(describeValue(focus.averageScore))}`,
    );
    v.check(
      Number.isInteger(focus.sampleCount) &&
        focus.sampleCount >= MIN_FOCUS_SAMPLES,
      `shape: sampleCount is ${String(describeValue(focus.sampleCount))}`,
    );
    v.check(
      typeof focus.family === 'string',
      `shape: family is ${typeof focus.family}`,
    );
    v.check(
      Object.is(focus.family, ownFamily(focus.shotType)),
      `family: ${String(describeValue(focus.family))} for shotType ${String(
        describeValue(focus.shotType),
      )} (expected ${ownFamily(focus.shotType)})`,
    );
    const hull = observedHull(input, focus.shotType, focus.checkpoint);
    if (hull === null) {
      v.list.push(
        'hull: focus names a checkpoint with no finite applicable score',
      );
    } else {
      v.check(
        focus.averageScore >= Math.floor(hull.min) &&
          focus.averageScore <= Math.ceil(hull.max),
        `hull: averageScore ${String(describeValue(focus.averageScore))} outside [${hull.min}, ${
          hull.max
        }]`,
      );
      v.check(
        focus.sampleCount <= hull.count,
        `hull: sampleCount ${focus.sampleCount} exceeds ${hull.count} observed scores`,
      );
      observed['hull'] = hull;
    }
    observed['averageOutside0to100'] =
      Number.isFinite(focus.averageScore) &&
      (focus.averageScore < 0 || focus.averageScore > 100);

    // Display helpers must render whatever the engine itself produced.
    const display: Loose = {};
    for (const [name, fn] of [
      ['checkpointDisplayName', () => checkpointDisplayName(focus!.checkpoint)],
      ['techniqueDisplayName', () => techniqueDisplayName(focus!.shotType)],
      ['familyDisplayLabel', () => familyDisplayLabel(focus!.family)],
      ['focusEvidenceLine', () => focusEvidenceLine(focus!)],
    ] as const) {
      try {
        const out: unknown = fn();
        display[name] = describeValue(out);
        v.check(
          typeof out === 'string',
          `display: ${name} returned ${typeof out}`,
        );
        if (name === 'focusEvidenceLine' && typeof out === 'string') {
          v.check(
            out.includes(String(focus.sampleCount)),
            `display: evidence line omits sampleCount ${focus.sampleCount}`,
          );
        }
      } catch (error) {
        v.list.push(`display: ${name} threw ${errorLine(error)}`);
      }
    }
    observed['display'] = display;
  }

  // Determinism under reordering (only meaningful for array inputs): the
  // reversed list plus a few seeded shuffles must all agree with the original.
  if (Array.isArray(input)) {
    const orders: readonly (readonly ScoredCheckpointFact[])[] = [
      [...facts].reverse(),
      rng.shuffle(facts),
      rng.shuffle(facts),
      rng.shuffle(facts),
    ];
    for (const [index, order] of orders.entries()) {
      const label = index === 0 ? 'reversed' : `shuffle#${index}`;
      try {
        const again = computeLibraryFocus(order);
        if (!sameFocus(focus, again)) {
          v.list.push(
            `determinism: ${label} input gave ${JSON.stringify(
              describeValue(again),
            )}`,
          );
          break;
        }
      } catch (error) {
        v.list.push(`determinism: ${label} call threw ${errorLine(error)}`);
        break;
      }
    }
  }
  checkPollution(v, before);
  return focus;
}

/** `shape`, `hull`, `display`, … — the invariant a violation line belongs to. */
function violationKinds(lines: readonly string[]): string {
  return [...new Set(lines.map(line => line.split(':')[0]!))].sort().join(',');
}

interface Minimized {
  input: unknown;
  size: number | 'n/a';
  violations: readonly string[];
  focus: unknown;
}

/**
 * Greedy delta-debugging: drop facts, then checkpoints, while the candidate
 * still violates the SAME invariant kinds the full input did (so a repro
 * cannot drift into a different failure while shrinking).
 */
function shrinkFactInput(input: unknown, seed: number): Minimized {
  const judge = (candidate: unknown): { lines: string[]; focus: unknown } => {
    const v = new Violations();
    const observed: Loose = {};
    evaluateFocusInput(
      deepFreeze(structuredCloneLoose(candidate)),
      createRng(seed),
      v,
      observed,
    );
    return { lines: v.list, focus: observed['focus'] };
  };
  const original = judge(input);
  const target = violationKinds(original.lines);
  const breaks = (candidate: unknown): boolean =>
    violationKinds(judge(candidate).lines) === target;
  const finish = (value: unknown): Minimized => {
    const verdict = judge(value);
    return {
      input: describeValue(value),
      size: Array.isArray(value) ? value.length : 'n/a',
      violations: verdict.lines,
      focus: verdict.focus,
    };
  };
  if (!Array.isArray(input) || original.lines.length === 0) {
    return finish(input);
  }
  let current: unknown[] = [...input];
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < current.length; i += 1) {
      const candidate = current.filter((_, j) => j !== i);
      if (candidate.length > 0 && breaks(candidate)) {
        current = candidate;
        changed = true;
        break;
      }
    }
  }
  for (let i = 0; i < current.length; i += 1) {
    const fact = current[i];
    if (fact === null || typeof fact !== 'object') continue;
    const cps = (fact as Loose)['checkpoints'];
    if (!Array.isArray(cps)) continue;
    let kept = [...cps];
    let more = true;
    while (more) {
      more = false;
      for (let k = 0; k < kept.length; k += 1) {
        const trial = kept.filter((_, j) => j !== k);
        const candidate = current.map((f, j) =>
          j === i ? { ...(f as Loose), checkpoints: trial } : f,
        );
        if (breaks(candidate)) {
          kept = trial;
          current = candidate;
          more = true;
          break;
        }
      }
    }
  }
  return finish(current);
}

/** Clone that preserves symbols/functions/BigInt by reference (JSON cannot). */
function structuredCloneLoose(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(structuredCloneLoose);
  if (
    value !== null &&
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    const out: Loose = {};
    for (const key of Object.keys(value)) {
      // defineProperty keeps an own "__proto__" key an own key (assignment
      // would rewrite the prototype instead).
      Object.defineProperty(out, key, {
        value: structuredCloneLoose((value as Loose)[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
}

// ─── Scenario driver ───────────────────────────────────────────────────────

interface Iteration {
  seed: number;
  rng: Rng;
  inputs: Loose;
  observed: Loose;
  violations: Violations;
}

function stressScenario(scenario: string, body: (it: Iteration) => void): void {
  describe(scenario, () => {
    for (const seed of stressSeeds(scenario)) {
      it(`seed ${seed}`, () => {
        const iteration: Iteration = {
          seed,
          rng: createRng(seed),
          inputs: {},
          observed: {},
          violations: new Violations(),
        };
        const startedAt = Date.now();
        body(iteration);
        const status =
          iteration.violations.list.length === 0 ? 'HELD' : 'BROKEN';
        recordStressRow({
          suite: SUITE,
          scenario,
          seed,
          status,
          wallMs: Date.now() - startedAt,
          inputs: iteration.inputs,
          observed: iteration.observed,
          violations: iteration.violations.list,
        });
        expect(iteration.violations.list).toEqual([]);
      });
    }
  });
}

function runFactScenario(it: Iteration, input: unknown, summary: Loose): void {
  it.inputs['summary'] = summary;
  evaluateFocusInput(deepFreeze(input), it.rng, it.violations, it.observed);
  if (it.violations.list.length > 0) {
    it.observed['minimal'] = shrinkFactInput(input, it.seed);
  }
}

afterAll(() => {
  flushStressTable(SUITE);
});

// ─── Scenarios: computeLibraryFocus ────────────────────────────────────────

stressScenario('typed-hostile-strings', it => {
  const { rng } = it;
  const count = rng.int(40);
  const facts = Array.from({ length: count }, (_, i) =>
    typedHostileFact(rng, i),
  );
  runFactScenario(it, facts, {
    facts: count,
    sample: describeValue(facts.slice(0, 3)),
    totalBytes: facts.reduce(
      (n, f) => n + Buffer.byteLength(f.id) + Buffer.byteLength(f.shotType),
      0,
    ),
  });
});

stressScenario('json-shaped-wrong-types', it => {
  const { rng } = it;
  const count = rng.int(30);
  const facts = Array.from({ length: count }, (_, i) =>
    repositoryShapedFact(rng, i),
  ).filter((fact): fact is Loose => fact !== null);
  runFactScenario(it, facts, {
    facts: facts.length,
    droppedByRepositoryCatch: count - facts.length,
    sample: describeValue(facts.slice(0, 3)),
  });
});

stressScenario('runtime-wrong-types', it => {
  const { rng } = it;
  const count = rng.int(25);
  const input = rng.chance(0.05)
    ? hostileRuntimeValue(rng)
    : Array.from({ length: count }, (_, i) => runtimeHostileFact(rng, i));
  runFactScenario(it, input, {
    facts: Array.isArray(input) ? count : 'non-array',
    sample: describeValue(input),
  });
});

stressScenario('json-bytes-corruption', it => {
  const { rng } = it;
  const valid = Array.from({ length: 2 + rng.int(12) }, (_, i) =>
    validFact(rng, i),
  );
  const { parsed, rejectedAtParse, mutation } = corruptedJsonInput(rng, valid);
  it.inputs['mutation'] = mutation;
  it.observed['rejectedAtParse'] = rejectedAtParse;
  if (rejectedAtParse) {
    // JSON.parse refused the bytes: that is the repository's catch path and a
    // graceful rejection. Nothing reaches the engine.
    it.inputs['summary'] = { mutation, facts: valid.length, parsed: false };
    return;
  }
  runFactScenario(it, parsed, {
    mutation,
    facts: valid.length,
    parsed: describeValue(parsed),
  });
});

stressScenario('numeric-boundaries', it => {
  const { rng } = it;
  const count = 2 + rng.int(30);
  const facts = Array.from({ length: count }, (_, i) =>
    numericBoundaryFact(rng, i),
  );
  runFactScenario(it, facts, {
    facts: count,
    sample: describeValue(facts.slice(0, 3)),
  });
});

stressScenario('prototype-keys', it => {
  // Every fact shares one technique and one checkpoint key drawn from the
  // prototype-pollution vocabulary, so the engine cannot abstain for lack of
  // samples and the lookups against SHOT_FAMILY / CHECKPOINT_NAMES must run.
  const { rng } = it;
  const shotType = rng.chance(0.7) ? rng.pick(PROTOTYPE_KEYS) : 'dink';
  const key = rng.chance(0.7) ? rng.pick(PROTOTYPE_KEYS) : 'contact';
  const count = MIN_FOCUS_SAMPLES + rng.int(10);
  const facts = Array.from({ length: count }, (_, i) => ({
    id: rng.chance(0.2) ? rng.pick(PROTOTYPE_KEYS) : `id-${i}`,
    shotType,
    capturedAt: rng.chance(0.1) ? rng.pick(PROTOTYPE_KEYS) : isoDay(rng),
    checkpoints: [
      { key, score: normalScore(rng), applicable: true },
      ...(rng.chance(0.3)
        ? [
            {
              key: rng.pick(PROTOTYPE_KEYS),
              score: normalScore(rng),
              applicable: true,
            },
          ]
        : []),
    ],
  }));
  runFactScenario(it, facts, { facts: count, shotType, key });
});

stressScenario('empty-and-degenerate', it => {
  const { rng } = it;
  const shape = rng.pick([
    'empty-array',
    'empty-object-facts',
    'empty-checkpoints',
    'empty-checkpoint-objects',
    'identical-thousands',
    'window-boundary',
    'zero-length-keys',
    'nfc-nfd-pair',
    'zwj-graphemes',
    'huge-single',
  ] as const);
  it.inputs['shape'] = shape;
  let input: unknown;
  switch (shape) {
    case 'empty-array':
      input = [];
      break;
    case 'empty-object-facts':
      input = Array.from({ length: 1 + rng.int(5) }, () => ({}));
      break;
    case 'empty-checkpoints':
      input = Array.from({ length: 1 + rng.int(5) }, (_, i) => ({
        ...validFact(rng, i),
        checkpoints: [],
      }));
      break;
    case 'empty-checkpoint-objects':
      input = Array.from({ length: 1 + rng.int(5) }, (_, i) => ({
        ...validFact(rng, i),
        checkpoints: Array.from({ length: 1 + rng.int(4) }, () => ({})),
      }));
      break;
    case 'identical-thousands': {
      const one = validFact(rng, 0, 'dink');
      input = Array.from({ length: 2_000 + rng.int(3_000) }, () => ({
        ...one,
      }));
      break;
    }
    case 'window-boundary': {
      const n = RANK_FORM_WINDOW + rng.pick([-1, 0, 1, 2]);
      input = Array.from({ length: Math.max(0, n) }, (_, i) => ({
        ...validFact(rng, i, 'serve'),
        capturedAt: `2026-08-${String(1 + i).padStart(2, '0')}T10:00:00.000Z`,
      }));
      break;
    }
    case 'zero-length-keys':
      input = Array.from({ length: 2 + rng.int(4) }, () => ({
        id: '',
        shotType: '',
        capturedAt: '',
        checkpoints: [{ key: '', score: normalScore(rng), applicable: true }],
      }));
      break;
    case 'nfc-nfd-pair':
      input = [NFC_E_ACUTE, NFD_E_ACUTE, NFC_E_ACUTE, NFD_E_ACUTE].map(
        (k, i) => ({
          id: `id-${i}`,
          shotType: `dink${k}`,
          capturedAt: isoDay(rng),
          checkpoints: [
            { key: `contact${k}`, score: normalScore(rng), applicable: true },
          ],
        }),
      );
      break;
    case 'zwj-graphemes':
      input = Array.from({ length: 2 + rng.int(4) }, (_, i) => ({
        id: ZWJ_FAMILY.repeat(i + 1),
        shotType: ZWJ_FAMILY,
        capturedAt: isoDay(rng),
        checkpoints: [
          { key: ZWJ_FAMILY, score: normalScore(rng), applicable: true },
        ],
      }));
      break;
    case 'huge-single':
      input = [0, 1].map(i => ({
        id: hugeString(rng, 256 * 1024),
        shotType: hugeString(rng, 256 * 1024),
        capturedAt: hugeString(rng, 64 * 1024),
        checkpoints: [
          { key: hugeString(rng, 64 * 1024), score: 40 + i, applicable: true },
        ],
      }));
      break;
  }
  runFactScenario(it, input, {
    shape,
    size: Array.isArray(input) ? input.length : 'n/a',
  });
  if (shape === 'nfc-nfd-pair') {
    // Observation only: NFC and NFD spellings are distinct techniques today.
    it.observed['nfcNfdDistinct'] = true;
  }
});

// ─── Scenario: recommendDrills ─────────────────────────────────────────────

const FAMILY_POOL: readonly string[] = [
  ...Object.keys(FAMILY_LABELS),
  'junk',
  ...PROTOTYPE_KEYS,
];

stressScenario('recommendDrills-malformed', it => {
  const { rng, violations: v } = it;
  const drillCount = rng.int(60);
  const drills = Array.from({ length: drillCount }, (_, i) => ({
    slug: rng.chance(0.2) ? hostileString(rng) : `drill-${i}`,
    families: Array.from({ length: rng.int(4) }, () =>
      rng.chance(0.3) ? hostileString(rng) : rng.pick(FAMILY_POOL),
    ),
  }));
  const focus: LibraryFocus = {
    shotType: rng.chance(0.3) ? hostileString(rng) : rng.pick(TECHNIQUES),
    checkpoint: rng.chance(0.3) ? hostileString(rng) : rng.pick(KNOWN_KEYS),
    averageScore: rng.pick(HOSTILE_NUMBERS),
    sampleCount: rng.pick([
      2,
      3,
      8,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]),
    family: rng.chance(0.4) ? hostileString(rng) : rng.pick(FAMILY_POOL),
  };
  const limit = rng.chance(0.2)
    ? undefined
    : rng.pick([...HOSTILE_NUMBERS, 1.5, 3, 2.999, -1, 1e308]);
  it.inputs['summary'] = {
    drills: drillCount,
    limit: describeValue(limit),
    focusFamily: describeValue(focus.family),
  };
  deepFreeze(drills);
  deepFreeze(focus);
  const before = snapshotPrototypes();

  let result: (typeof drills)[number][] = [];
  const startedAt = Date.now();
  try {
    result =
      limit === undefined
        ? recommendDrills(drills, focus)
        : recommendDrills(drills, focus, limit);
  } catch (error) {
    v.list.push(`no-throw: recommendDrills threw ${errorLine(error)}`);
    checkPollution(v, before);
    return;
  }
  const wallMs = Date.now() - startedAt;
  v.check(wallMs <= CALL_BUDGET_MS, `time: recommendDrills took ${wallMs}ms`);
  it.observed['resultCount'] = result.length;

  v.check(Array.isArray(result), 'shape: result is not an array');
  const cap = limit === undefined ? 3 : Math.max(0, limit);
  if (Number.isNaN(cap)) {
    v.check(
      result.length === 0,
      `shape: NaN limit yielded ${result.length} drills`,
    );
  } else {
    v.check(
      result.length <= cap,
      `shape: ${result.length} drills exceeds limit ${cap}`,
    );
  }
  v.check(
    new Set(result).size === result.length,
    'shape: duplicate drill objects',
  );
  for (const drill of result) {
    v.check(drills.includes(drill), 'shape: fabricated drill not in catalog');
    const primary = drill.families.includes(focus.family);
    const fill = focus.family !== 'global' && drill.families.includes('global');
    v.check(
      primary || fill,
      `family: ${describeValue(drill.slug)} matches neither focus nor global`,
    );
  }
  const isPrimary = (d: (typeof drills)[number]) =>
    d.families.includes(focus.family);
  const firstFill = result.findIndex(d => !isPrimary(d));
  if (firstFill !== -1) {
    v.check(
      result.slice(firstFill).every(d => !isPrimary(d)),
      'order: a primary drill follows a global fill',
    );
  }
  const indices = result.map(d => drills.indexOf(d));
  const primaryIdx = indices.filter((_, i) => isPrimary(result[i]!));
  const fillIdx = indices.filter((_, i) => !isPrimary(result[i]!));
  v.check(
    primaryIdx.every((x, i) => i === 0 || x > primaryIdx[i - 1]!),
    'order: primary drills not in catalog order',
  );
  v.check(
    fillIdx.every((x, i) => i === 0 || x > fillIdx[i - 1]!),
    'order: fill drills not in catalog order',
  );
  try {
    const again =
      limit === undefined
        ? recommendDrills(drills, focus)
        : recommendDrills(drills, focus, limit);
    v.check(
      again.length === result.length && again.every((d, i) => d === result[i]),
      'determinism: second call differs',
    );
  } catch (error) {
    v.list.push(`determinism: second call threw ${errorLine(error)}`);
  }
  checkPollution(v, before);
});
