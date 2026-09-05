/**
 * mod-library-focus · failure-injection · SQLite / clock layer.
 *
 * Drives the real `listScoredCheckpointFacts` → `computeLibraryFocus` →
 * display-helper chain against a scripted `LocalDb` whose `execute` is made
 * to throw, reject, hang, resolve slowly, or hand back malformed / partial
 * result sets. Each seed is replayable:
 *
 *   STRESS_SEED=<seed> npx jest --ci __tests__/stress/libraryFocusFaultInjection.repository.test.ts
 *
 * Campaign size: STRESS_ITER (default 72). Rows are written to
 * artifacts/stress/mod-library-focus/repository-sqlite-clock.json (or
 * $STRESS_OUT) as a seed → outcome table.
 *
 * Invariants checked per scenario (ids appear in the JSON `violations`):
 *   I1 no fake success — a fault that yields no valid evidence yields null.
 *   I2 no silent failure — throw/reject surface as a rejection; hangs stay
 *      pending (never resolve to an invented value) for 60s of fake time.
 *   I3 well-typed facts — every returned fact matches ScoredCheckpointFact.
 *   I4 renderable focus — computeLibraryFocus returns null or a focus whose
 *      averageScore is a finite integer and whose labels are strings.
 *   I5 display helpers never throw on the focus the module produced.
 *   I6 no persisted-state writes — the read path issues SELECT only.
 *   I7 evidence parity — the valid rows the module keeps are exactly the
 *      well-formed real scored payloads (nothing dropped, nothing invented).
 *
 * Tests named "DEFECT:" pin behaviour confirmed while auditing (repo
 * convention, see wf/flow-data-layer-typed-failures.test.ts); they pass
 * against the current code so the evidence is executable and flip when the
 * defect is fixed.
 */
import type { LocalDb } from '../../src/data/db';
import {
  SIGNED_OUT_DATA_OWNER,
  getActiveDataOwner,
} from '../../src/data/accountScope';
import { listScoredCheckpointFacts } from '../../src/data/repository';
import {
  checkpointDisplayName,
  computeLibraryFocus,
  familyDisplayLabel,
  focusEvidenceLine,
  recommendDrills,
  techniqueDisplayName,
} from '../../src/library/libraryFocus';
import {
  FAULT_MODES,
  HANG_BUDGET_MS,
  MALFORMED_CLASSES,
  type FaultMode,
  type MalformedClass,
  type RawRow,
  type Rng,
  type ScenarioRow,
  chance,
  deferred,
  int,
  isRenderableFocus,
  isWellTypedFact,
  malformedRow,
  mulberry32,
  pick,
  referenceFocusPossible,
  seedList,
  validRow,
  writeCampaignReport,
} from '../../test-support/stress/libraryFocusFaultKit';

const REPLAY =
  'STRESS_SEED=<seed> npx jest --ci __tests__/stress/libraryFocusFaultInjection.repository.test.ts';

// ─── Scripted SQLite ─────────────────────────────────────────────────────────

interface ScriptedDb extends LocalDb {
  sqlLog: string[];
  writes: string[];
}

function scriptedDb(
  behaviour: (
    sql: string,
    params: unknown[] | undefined,
  ) => Promise<{ rows: Record<string, unknown>[] }>,
): ScriptedDb {
  const sqlLog: string[] = [];
  const writes: string[] = [];
  return {
    sqlLog,
    writes,
    execute(sql, params) {
      sqlLog.push(sql);
      if (!/^\s*SELECT\b/i.test(sql)) writes.push(sql);
      return behaviour(sql, params);
    },
    close() {},
  };
}

// ─── Scenario model ──────────────────────────────────────────────────────────

interface Scenario {
  seed: number;
  fault: FaultMode;
  detail: string;
  rows: RawRow[];
  /** Fake-time delay for `slow`. */
  delayMs: number;
  /** Partial-result shape for `partial`. */
  partialShape:
    | 'rows-undefined'
    | 'rows-null'
    | 'rows-not-array'
    | 'row-null'
    | 'truncated';
}

function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed);
  const fault = pick(rng, FAULT_MODES);
  const rowCount = int(rng, 0, 14);
  const rows: RawRow[] = [];
  const classes: MalformedClass[] = [];
  // A third of malformed seeds concentrate on ONE corruption class so
  // same-class rows can accumulate into a focus (the render-path defects
  // need two ill-typed reads of the same technique).
  const concentrated =
    fault === 'malformed' && chance(rng, 0.34)
      ? pick(rng, MALFORMED_CLASSES)
      : null;
  for (let i = 0; i < rowCount; i += 1) {
    if (fault === 'malformed' && chance(rng, 0.55)) {
      const cls = concentrated ?? pick(rng, MALFORMED_CLASSES);
      classes.push(cls);
      rows.push(malformedRow(rng, cls));
    } else {
      rows.push(validRow(rng));
    }
  }
  if (fault === 'malformed' && classes.length === 0) {
    const cls = concentrated ?? pick(rng, MALFORMED_CLASSES);
    classes.push(cls);
    rows.push(malformedRow(rng, cls));
  }
  const partialShape = pick(rng, [
    'rows-undefined',
    'rows-null',
    'rows-not-array',
    'row-null',
    'truncated',
  ] as const);
  const delayMs = int(rng, 1, HANG_BUDGET_MS - 1);
  const detail =
    fault === 'malformed'
      ? `rows=${rows.length} classes=${[...new Set(classes)].sort().join(',')}`
      : fault === 'partial'
        ? `rows=${rows.length} shape=${partialShape}`
        : fault === 'slow'
          ? `rows=${rows.length} delayMs=${delayMs}`
          : `rows=${rows.length}`;
  return { seed, fault, detail, rows, delayMs, partialShape };
}

/** Known defect classes so BROKEN rows are attributed, never hidden. A row
 * may hit several; they are joined with '+'. Anything unattributed fails the
 * campaign. */
const TYPE_LEAK_CLASSES: readonly MalformedClass[] = [
  'shottype-number',
  'shottype-null',
  'shottype-object',
  'shottype-missing',
  'capturedat-number',
  'capturedat-null',
  'capturedat-object',
  'capturedat-missing',
  'id-number',
  'id-null',
  'id-missing',
];
const SHOT_TYPE_CLASSES: readonly MalformedClass[] = [
  'shottype-number',
  'shottype-null',
  'shottype-object',
  'shottype-missing',
];
const OVERFLOW_CLASSES: readonly MalformedClass[] = [
  'checkpoint-score-huge',
  'checkpoint-score-negative',
];

function defectFor(
  rows: readonly RawRow[],
  violations: readonly string[],
): string | null {
  if (violations.length === 0) return null;
  const labels = new Set(rows.map(r => r.label));
  const has = (cls: readonly MalformedClass[]) => cls.some(c => labels.has(c));
  const defects: string[] = [];
  const remaining = new Set(violations);
  if (has(SHOT_TYPE_CLASSES) && (remaining.has('I5') || remaining.has('I4'))) {
    defects.push('D1-shotType-unvalidated-render-throw');
    remaining.delete('I5');
    if (!has(OVERFLOW_CLASSES)) remaining.delete('I4');
  }
  if (has(OVERFLOW_CLASSES) && remaining.has('I4')) {
    defects.push('D2-score-overflow-nonfinite-average');
    remaining.delete('I4');
  }
  if (has(TYPE_LEAK_CLASSES) && remaining.has('I3')) {
    defects.push('D3-fact-fields-unvalidated');
    remaining.delete('I3');
  }
  // Any violation not explained by a pinned class leaves the row unattributed.
  if (remaining.size > 0) return null;
  return defects.join('+');
}

async function runScenario(scenario: Scenario): Promise<ScenarioRow> {
  const violations: string[] = [];
  const rawRows = scenario.rows.map(r => r.row);

  let db: ScriptedDb;
  let settledSlow = false;
  switch (scenario.fault) {
    case 'throw':
      db = scriptedDb(() => {
        throw new Error(`sqlite threw synchronously (seed ${scenario.seed})`);
      });
      break;
    case 'reject':
      db = scriptedDb(() =>
        Promise.reject(new Error(`sqlite rejected (seed ${scenario.seed})`)),
      );
      break;
    case 'timeout':
    case 'never':
      db = scriptedDb(
        () => deferred<{ rows: Record<string, unknown>[] }>().promise,
      );
      break;
    case 'slow':
      db = scriptedDb(
        () =>
          new Promise(resolve =>
            setTimeout(() => {
              settledSlow = true;
              resolve({ rows: rawRows });
            }, scenario.delayMs),
          ),
      );
      break;
    case 'malformed':
      db = scriptedDb(async () => ({ rows: rawRows }));
      break;
    case 'partial':
      db = scriptedDb(async () => {
        switch (scenario.partialShape) {
          case 'rows-undefined':
            return {} as { rows: Record<string, unknown>[] };
          case 'rows-null':
            return { rows: null } as unknown as {
              rows: Record<string, unknown>[];
            };
          case 'rows-not-array':
            return { rows: { length: 3 } } as unknown as {
              rows: Record<string, unknown>[];
            };
          case 'row-null':
            return {
              rows: [null, ...rawRows] as unknown as Record<string, unknown>[],
            };
          case 'truncated':
            return { rows: rawRows.slice(0, Math.floor(rawRows.length / 2)) };
        }
      });
      break;
  }

  let settled:
    | { kind: 'resolved'; value: unknown }
    | { kind: 'rejected'; error: unknown }
    | null = null;
  void listScoredCheckpointFacts(db).then(
    value => {
      settled = { kind: 'resolved', value };
    },
    (error: unknown) => {
      settled = { kind: 'rejected', error };
    },
  );

  // Let microtasks run, then advance the hang budget so slow reads land and
  // hung reads are provably still pending.
  await Promise.resolve();
  await jest.advanceTimersByTimeAsync(HANG_BUDGET_MS);
  await Promise.resolve();

  // I6 — read path never writes.
  if (db.writes.length > 0) violations.push('I6');

  const state = settled as
    | { kind: 'resolved'; value: unknown }
    | { kind: 'rejected'; error: unknown }
    | null;

  switch (scenario.fault) {
    case 'throw':
    case 'reject': {
      // I2 — the fault must surface as a rejection carrying an Error.
      if (state === null || state.kind !== 'rejected') violations.push('I2');
      else if (!(state.error instanceof Error)) violations.push('I2');
      break;
    }
    case 'timeout':
    case 'never': {
      // I2 — a hung read never resolves to an invented value inside 60s.
      if (state !== null) violations.push('I2');
      break;
    }
    case 'slow':
    case 'malformed':
    case 'partial': {
      if (scenario.fault === 'slow' && !settledSlow) violations.push('I2');
      if (state === null) {
        violations.push('I2');
        break;
      }
      if (state.kind === 'rejected') {
        // Partial driver results that are not iterable are allowed to
        // reject (the consumer catches), but must not be silent.
        if (!(state.error instanceof Error)) violations.push('I2');
        const shape = scenario.partialShape;
        const rejectable =
          scenario.fault === 'partial' &&
          (shape === 'rows-undefined' ||
            shape === 'rows-null' ||
            shape === 'rows-not-array' ||
            shape === 'row-null');
        if (!rejectable) violations.push('I2');
        break;
      }
      const facts = state.value;
      if (!Array.isArray(facts)) {
        violations.push('I3');
        break;
      }
      // I3 — well-typed facts.
      if (!facts.every(isWellTypedFact)) violations.push('I3');
      // I7 — evidence parity: the module keeps exactly the rows the
      // reference policy keeps (truncated results are judged against what the
      // driver actually returned). Ids are compared as text because the
      // reference deliberately does not type-check fields (I3 does).
      const keptRows =
        scenario.fault === 'partial' && scenario.partialShape === 'truncated'
          ? scenario.rows.slice(0, Math.floor(scenario.rows.length / 2))
          : scenario.rows;
      const keptPayloads = keptRows.flatMap(r =>
        r.payload ? [r.payload] : [],
      );
      const expectedIds = keptPayloads.map(p => String(p.id)).sort();
      const gotIds = (facts as Array<{ id: unknown }>)
        .map(f => String(f.id))
        .sort();
      if (JSON.stringify(expectedIds) !== JSON.stringify(gotIds))
        violations.push('I7');
      // I1/I4/I5 — run the module and its labels on whatever came back.
      let focus: unknown;
      try {
        focus = computeLibraryFocus(facts as never);
      } catch {
        violations.push('I4');
        break;
      }
      if (focus !== null && !isRenderableFocus(focus)) violations.push('I4');
      // I1 — a focus with no reference evidence behind it is fake success.
      if (focus !== null && !referenceFocusPossible(keptPayloads))
        violations.push('I1');
      if (focus !== null) {
        try {
          const f = focus as Parameters<typeof focusEvidenceLine>[0];
          const line = focusEvidenceLine(f);
          const label = familyDisplayLabel(f.family);
          const name = checkpointDisplayName(f.checkpoint);
          const technique = techniqueDisplayName(f.shotType);
          const recs = recommendDrills(
            [
              { slug: 'a', families: ['dink'] },
              { slug: 'b', families: ['global'] },
              { slug: 'c', families: [f.family] },
            ],
            f,
          );
          if (
            typeof line !== 'string' ||
            typeof label !== 'string' ||
            typeof name !== 'string' ||
            typeof technique !== 'string' ||
            !Array.isArray(recs)
          ) {
            violations.push('I5');
          }
        } catch {
          violations.push('I5');
        }
      }
      break;
    }
  }

  const uniqueViolations = [...new Set(violations)];
  return {
    seed: scenario.seed,
    dependency: 'sqlite.execute',
    fault: scenario.fault,
    detail: scenario.detail,
    outcome: uniqueViolations.length === 0 ? 'HELD' : 'BROKEN',
    violations: uniqueViolations,
    defect: defectFor(scenario.rows, uniqueViolations),
    replay: REPLAY.replace('<seed>', String(scenario.seed)),
  };
}

// ─── Campaign ────────────────────────────────────────────────────────────────

const rows: ScenarioRow[] = [];

describe('mod-library-focus · failure-injection · SQLite read path', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });
  afterAll(() => {
    writeCampaignReport(
      'repository-sqlite-clock',
      'mobile (jest, real repository.listScoredCheckpointFacts + libraryFocus, scripted LocalDb, fake timers)',
      REPLAY,
      rows,
    );
  });

  it('reads as the signed-out owner (no auth store, no Keychain) under jest', () => {
    expect(getActiveDataOwner()).toBe(SIGNED_OUT_DATA_OWNER);
  });

  it('every seeded SQLite fault either HOLDS or lands in a pinned defect class', async () => {
    const seeds = seedList();
    const unattributed: ScenarioRow[] = [];
    for (const seed of seeds) {
      const row = await runScenario(buildScenario(seed));
      rows.push(row);
      if (row.outcome === 'BROKEN' && row.defect === null)
        unattributed.push(row);
    }
    expect(rows.length).toBe(seeds.length);
    // Every fault mode is exercised in a default-size campaign.
    if (seeds.length >= 40) {
      for (const mode of FAULT_MODES) {
        expect(rows.some(r => r.fault === mode)).toBe(true);
      }
    }
    // A BROKEN row outside the three pinned defect classes is a regression.
    expect(unattributed).toEqual([]);
    // Non-malformed faults must all HOLD — throw/reject/hang/slow/partial
    // have no pinned defects.
    expect(
      rows.filter(r => r.fault !== 'malformed' && r.outcome === 'BROKEN'),
    ).toEqual([]);
  });

  it('clock skew never changes the focus: capturedAt is compared as text, not parsed', () => {
    const rng: Rng = mulberry32(0xc10c);
    const skews = [
      0,
      1_000,
      -1_000,
      86_400_000 * 365 * 30,
      -86_400_000 * 365 * 50,
    ];
    for (const skew of skews) {
      jest.setSystemTime(new Date('2026-09-05T00:00:00.000Z').getTime() + skew);
      const facts = Array.from({ length: int(rng, 2, 12) }, () => validRow(rng))
        .map(r => r.payload!)
        .map(p => ({
          id: String(p.id),
          shotType: String(p.shotType),
          // Future-dated, past-dated and non-ISO capture stamps.
          capturedAt: pick(rng, [
            String(p.capturedAtIso),
            '2099-01-01T00:00:00.000Z',
            '1970-01-01T00:00:00.000Z',
            'not-a-date',
            '',
          ]),
          checkpoints: (
            p.checkpoints as {
              key: string;
              score: number | null;
              applicable: boolean;
            }[]
          ).map(cp => ({ ...cp })),
        }));
      const a = computeLibraryFocus(facts);
      jest.setSystemTime(new Date('2000-01-01T00:00:00.000Z').getTime());
      const b = computeLibraryFocus(facts);
      expect(b).toEqual(a);
      if (a !== null) expect(isRenderableFocus(a)).toBe(true);
    }
  });

  it('DEFECT: a persisted shotType that is not a string reaches the display helpers and throws', async () => {
    const rng = mulberry32(0xd1);
    // Two reads with the same non-string shotType so the window carries
    // enough evidence for a focus.
    const one = malformedRow(rng, 'shottype-number');
    const two = malformedRow(rng, 'shottype-number');
    const db = scriptedDb(async () => ({ rows: [one.row, two.row] }));
    const factsPromise = listScoredCheckpointFacts(db);
    await jest.advanceTimersByTimeAsync(0);
    const facts = await factsPromise;
    // The repository keeps the row: nothing validates the field type.
    expect(facts).toHaveLength(2);
    expect(facts.every(f => typeof f.shotType === 'number')).toBe(true);
    const focus = computeLibraryFocus(facts);
    // Two reads, ≥1 shared applicable finite checkpoint → focus is possible.
    if (focus !== null) {
      expect(typeof focus.shotType).toBe('number');
      expect(() => focusEvidenceLine(focus)).toThrow(TypeError);
      expect(() => techniqueDisplayName(focus.shotType)).toThrow(TypeError);
    } else {
      // Random checkpoints may not overlap for this seed; the type leak is
      // still the defect.
      expect(facts.some(f => typeof f.shotType !== 'string')).toBe(true);
    }
  });

  it('DEFECT: a finite but astronomically large persisted score yields a non-finite averageScore', () => {
    const facts = [
      {
        id: 'b',
        shotType: 'dink',
        capturedAt: '2026-08-02T00:00:00.000Z',
        checkpoints: [
          {
            key: 'contact_position',
            score: Number.MAX_VALUE,
            applicable: true,
          },
        ],
      },
      {
        id: 'a',
        shotType: 'dink',
        capturedAt: '2026-08-01T00:00:00.000Z',
        checkpoints: [{ key: 'contact_position', score: 10, applicable: true }],
      },
    ];
    const focus = computeLibraryFocus(facts);
    expect(focus).not.toBeNull();
    // Number.isFinite(score) passes per read, but score × weight overflows.
    expect(Number.isFinite(focus!.averageScore)).toBe(false);
    expect(isRenderableFocus(focus)).toBe(false);
  });

  it('DEFECT: capturedAtIso / id of the wrong type are kept as-is instead of being excluded', async () => {
    const rng = mulberry32(0xd3);
    const rowsIn = [
      malformedRow(rng, 'capturedat-number'),
      malformedRow(rng, 'capturedat-null'),
      malformedRow(rng, 'id-number'),
      malformedRow(rng, 'id-missing'),
    ];
    const db = scriptedDb(async () => ({ rows: rowsIn.map(r => r.row) }));
    const factsPromise = listScoredCheckpointFacts(db);
    await jest.advanceTimersByTimeAsync(0);
    const facts = await factsPromise;
    expect(facts).toHaveLength(4);
    expect(facts.filter(isWellTypedFact)).toHaveLength(0);
    // computeLibraryFocus tolerates them (string comparison on mixed types
    // does not throw), so the leak is silent — recorded, not a crash.
    expect(() => computeLibraryFocus(facts)).not.toThrow();
  });
});
