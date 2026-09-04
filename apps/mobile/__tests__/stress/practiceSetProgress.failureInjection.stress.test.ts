/**
 * FAILURE INJECTION — src/progress/practiceSetProgress.ts.
 *
 * Dependency under attack: the SQLite fact reader. `listRealAnalysisFacts`
 * does `JSON.parse(payload) as ShotAnalysis` with NO shape validation, so
 * every field of a RealAnalysisFact can arrive with any JSON type. Each
 * seeded iteration builds a fact set — several sittings, a mix of strokes,
 * scoring-model / shot-config version churn mid-sitting, abstentions,
 * unscored rows, string / null / NaN / out-of-range scores, unparseable and
 * zone-less timestamps, duplicate ids, non-string ids, empty / prototype-
 * shaped checkpoint keys (`constructor`, `__proto__`, `toString`) — and
 * checks:
 *
 *   no_throw       — the pure module never throws on repository-shaped facts
 *   oracle         — summary + latest-set selection equal an independent
 *                    brute-force computation
 *   deterministic  — same seed → identical JSON; shuffled facts → identical
 *   copy           — headline / insight contain no NaN / undefined / null /
 *                    Infinity / [object Object] and no empty clause
 *   options_reject — invalid asOfIso / maxAgeMs throw an Error
 *
 * The default campaign injects only type-level faults (what a corrupt or
 * older-schema row can carry). The gated hardening campaign
 * (STRESS_HARDENING=1) adds values the app's own scorer never writes but the
 * reader would pass through — scores outside 0–10, prototype-shaped
 * checkpoint keys — and documents the module's behaviour on them.
 *
 * Replay:  STRESS_ONLY=practiceSet:<seed>   Scale: STRESS_ITER=<n>
 * Table:   artifacts/stress/practiceSet.json
 */
import type { RealAnalysisFact } from '../../src/data/repository';
import {
  latestPracticeSet,
  practiceSetHeadline,
  practiceSetInsight,
  summarizePracticeSet,
  type PracticeSetAttempt,
  type PracticeSetSummary,
} from '../../src/progress/practiceSetProgress';
import { SeededRng } from '../../test-support/stress/seededRng';
import {
  CampaignTable,
  Checker,
  describeValue,
  forbiddenToken,
  planCampaign,
} from '../../test-support/stress/campaign';

const TEST_FILE =
  '__tests__/stress/practiceSetProgress.failureInjection.stress.test.ts';

const STROKES = ['serve', 'forehand_drive', 'dink', 'third_shot_drop'] as const;
const MODELS = ['scoring-3', 'scoring-4'] as const;
const CONFIGS = ['cfg-1', 'cfg-2'] as const;
const CHECKPOINT_KEYS = [
  'ready_position',
  'athletic_base',
  'preparation',
  'contact_point',
  'follow_through',
] as const;
const HOSTILE_KEYS = [
  '',
  ' ',
  'constructor',
  '__proto__',
  'toString',
  'hasOwnProperty',
  'valueOf',
  'not_a_checkpoint',
  'Ready Position',
] as const;

type FieldFault =
  | 'none'
  | 'score_string'
  | 'score_null'
  | 'score_nan'
  | 'score_infinity'
  | 'score_negative'
  | 'score_over_ten'
  | 'score_huge'
  | 'score_many_decimals'
  | 'capturedAt_garbage'
  | 'capturedAt_no_zone'
  | 'capturedAt_number'
  | 'capturedAt_undefined'
  | 'resultKind_unknown'
  | 'resultKind_abstained'
  | 'model_version_drift'
  | 'config_version_drift'
  | 'shotType_undefined'
  | 'shotType_number'
  | 'id_duplicate'
  | 'id_number'
  | 'id_undefined'
  | 'priority_hostile_key'
  | 'checkpoints_hostile_keys'
  | 'checkpoints_not_object'
  | 'checkpoints_non_finite';

const FIELD_FAULTS: readonly FieldFault[] = [
  'none',
  'none',
  'none',
  'none',
  'score_string',
  'score_null',
  'score_nan',
  'score_infinity',
  'score_negative',
  'score_over_ten',
  'score_huge',
  'score_many_decimals',
  'capturedAt_garbage',
  'capturedAt_no_zone',
  'capturedAt_number',
  'capturedAt_undefined',
  'resultKind_unknown',
  'resultKind_abstained',
  'model_version_drift',
  'config_version_drift',
  'shotType_undefined',
  'shotType_number',
  'id_duplicate',
  'id_number',
  'id_undefined',
  'priority_hostile_key',
  'checkpoints_hostile_keys',
  'checkpoints_not_object',
  'checkpoints_non_finite',
];

/** Faults whose values sit outside the domain contract (scores 0–10 with one
 * decimal, checkpoint keys from the stroke sequence); only the hardening
 * campaign injects them. */
const OUT_OF_CONTRACT: ReadonlySet<FieldFault> = new Set([
  'score_negative',
  'score_over_ten',
  'score_huge',
  'score_many_decimals',
  'priority_hostile_key',
  'checkpoints_hostile_keys',
]);

interface GeneratedFact {
  fact: RealAnalysisFact;
  fault: FieldFault;
}

function oneDecimal(rng: SeededRng): number {
  return rng.int(0, 100) / 10;
}

type FaultPool = 'none' | 'in_contract' | 'all';

const IN_CONTRACT_FAULTS: readonly FieldFault[] = FIELD_FAULTS.filter(
  fault => !OUT_OF_CONTRACT.has(fault),
);

function makeFact(
  index: number,
  session: {
    id: string | null;
    stroke: string;
    model: string;
    config: string;
    baseMs: number;
  },
  rng: SeededRng,
  pool: FaultPool,
): GeneratedFact {
  const fault =
    pool === 'none'
      ? 'none'
      : rng.pick(pool === 'all' ? FIELD_FAULTS : IN_CONTRACT_FAULTS);
  const capturedMs = session.baseMs + index * rng.int(20_000, 600_000);
  const checkpointScores: Record<string, number> = {};
  for (const key of CHECKPOINT_KEYS) {
    if (rng.chance(0.8)) checkpointScores[key] = rng.int(0, 100);
  }
  const record: Record<string, unknown> = {
    id: `fact-${index}-${rng.int(0, 1e6)}`,
    shotType: session.stroke,
    capturedAt: new Date(capturedMs).toISOString(),
    overallScore: oneDecimal(rng),
    confidence: rng.next(),
    resultKind: 'scored',
    scoringModelVersion: session.model,
    shotConfigVersion: session.config,
    sessionId: session.id,
    priorityCheckpoint: rng.chance(0.7) ? rng.pick(CHECKPOINT_KEYS) : null,
    checkpointScores,
  };
  switch (fault) {
    case 'none':
      break;
    case 'score_string':
      record.overallScore = String(record.overallScore);
      break;
    case 'score_null':
      record.overallScore = null;
      break;
    case 'score_nan':
      record.overallScore = NaN;
      break;
    case 'score_infinity':
      record.overallScore = rng.pick([Infinity, -Infinity]);
      break;
    case 'score_negative':
      record.overallScore = -oneDecimal(rng) - 0.1;
      break;
    case 'score_over_ten':
      record.overallScore = 10 + oneDecimal(rng);
      break;
    case 'score_huge':
      record.overallScore = rng.pick([
        1e300,
        1e308,
        -1e308,
        Number.MAX_SAFE_INTEGER,
      ]);
      break;
    case 'score_many_decimals':
      record.overallScore = rng.next() * 10;
      break;
    case 'capturedAt_garbage':
      record.capturedAt = rng.pick([
        '',
        'not a date',
        'NaN',
        '2026-13-45T25:61:00Z',
      ]);
      break;
    case 'capturedAt_no_zone':
      record.capturedAt = new Date(capturedMs).toISOString().replace(/Z$/, '');
      break;
    case 'capturedAt_number':
      record.capturedAt = capturedMs;
      break;
    case 'capturedAt_undefined':
      delete record.capturedAt;
      break;
    case 'resultKind_unknown':
      record.resultKind = rng.pick(['SCORED', 'pending', 42, null]);
      break;
    case 'resultKind_abstained':
      record.resultKind = 'abstained';
      record.overallScore = null;
      break;
    case 'model_version_drift':
      record.scoringModelVersion = rng.pick([
        'scoring-2',
        'scoring-3 ',
        undefined,
        3,
      ]);
      break;
    case 'config_version_drift':
      record.shotConfigVersion = rng.pick(['cfg-0', undefined, null]);
      break;
    case 'shotType_undefined':
      delete record.shotType;
      break;
    case 'shotType_number':
      record.shotType = 7;
      break;
    case 'id_duplicate':
      record.id = 'dup';
      break;
    case 'id_number':
      record.id = rng.int(0, 99);
      break;
    case 'id_undefined':
      delete record.id;
      break;
    case 'priority_hostile_key':
      record.priorityCheckpoint = rng.pick(HOSTILE_KEYS);
      break;
    case 'checkpoints_hostile_keys': {
      const key = rng.pick(HOSTILE_KEYS);
      // Own-property assignment (what applicableCheckpointScores does) — a
      // numeric `__proto__` assignment is a silent no-op on a plain object.
      (record.checkpointScores as Record<string, number>)[key] = rng.pick([
        10, 90,
      ]);
      break;
    }
    case 'checkpoints_not_object':
      record.checkpointScores = rng.pick([null, undefined, [], 'x', 5]);
      break;
    case 'checkpoints_non_finite':
      (record.checkpointScores as Record<string, number>)['contact_point'] =
        rng.pick([NaN, Infinity]);
      break;
  }
  return { fact: record as unknown as RealAnalysisFact, fault };
}

interface Scenario {
  facts: GeneratedFact[];
  sessionIds: string[];
  asOfIso: string;
  maxAgeMs: number | undefined;
}

function buildScenario(rng: SeededRng, pool: FaultPool): Scenario {
  const now = Date.UTC(2026, 7, 27, 12) + rng.int(-30, 30) * 86_400_000;
  const sessionCount = rng.int(1, 5);
  const facts: GeneratedFact[] = [];
  const sessionIds: string[] = [];
  let index = 0;
  for (let s = 0; s < sessionCount; s++) {
    const id = rng.chance(0.1) ? null : `set-${s}`;
    if (id) sessionIds.push(id);
    const stroke = rng.pick(STROKES);
    const model = rng.pick(MODELS);
    const config = rng.pick(CONFIGS);
    const baseMs = now - rng.int(0, 3 * 86_400_000);
    const attempts = rng.int(1, 8);
    for (let a = 0; a < attempts; a++) {
      const session = {
        id,
        // A different stroke slips into the sitting now and then.
        stroke: rng.chance(0.15) ? rng.pick(STROKES) : stroke,
        model,
        config,
        baseMs,
      };
      facts.push(makeFact(index++, session, rng, pool));
    }
  }
  // A few facts in the future relative to asOf.
  if (rng.chance(0.3) && sessionIds.length > 0) {
    facts.push(
      makeFact(
        index++,
        {
          id: sessionIds[0]!,
          stroke: rng.pick(STROKES),
          model: 'scoring-3',
          config: 'cfg-1',
          baseMs: now + 60_000,
        },
        rng,
        'none',
      ),
    );
  }
  const maxAgeMs = rng.chance(0.5)
    ? undefined
    : rng.pick([0, 60_000, 3_600_000, 86_400_000, 10 * 86_400_000]);
  return { facts, sessionIds, asOfIso: new Date(now).toISOString(), maxAgeMs };
}

// ─── Oracle ──────────────────────────────────────────────────────────────────

function tenths(score: number): number {
  return Math.round(score * 10);
}

function idLess(a: unknown, b: unknown): number {
  // The module compares ids with < and >; mirror that on unknown values.
  return (a as number) < (b as number)
    ? -1
    : (a as number) > (b as number)
      ? 1
      : 0;
}

function oracleAttempt(fact: RealAnalysisFact): PracticeSetAttempt {
  const scores: Record<string, number> = {};
  const raw: unknown = fact.checkpointScores;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) scores[k] = v;
    }
  }
  return {
    id: fact.id,
    capturedAt: fact.capturedAt,
    overallScore: fact.overallScore as number,
    priorityCheckpoint:
      typeof fact.priorityCheckpoint === 'string'
        ? fact.priorityCheckpoint
        : null,
    checkpointScores: scores,
  };
}

function oracleSummary(
  facts: readonly RealAnalysisFact[],
  sessionId: string,
): PracticeSetSummary | null {
  if (!sessionId) return null;
  const scored = facts
    .filter(
      f =>
        f.sessionId === sessionId &&
        f.resultKind === 'scored' &&
        typeof f.overallScore === 'number' &&
        Number.isFinite(f.overallScore) &&
        Number.isFinite(Date.parse(f.capturedAt)),
    )
    .map(f => ({ f, ms: Date.parse(f.capturedAt) }))
    .sort((a, b) => a.ms - b.ms || idLess(a.f.id, b.f.id));
  const newest = scored[scored.length - 1];
  if (!newest) return null;
  const sameStroke = scored.filter(e => e.f.shotType === newest.f.shotType);
  const comparable = sameStroke.filter(
    e =>
      e.f.scoringModelVersion === newest.f.scoringModelVersion &&
      e.f.shotConfigVersion === newest.f.shotConfigVersion,
  );
  if (comparable.length < 2) return null;
  const attempts = comparable.map(e => oracleAttempt(e.f));
  const first = attempts[0]!;
  const latest = attempts[attempts.length - 1]!;
  let best = first;
  for (const a of attempts)
    if (tenths(a.overallScore) >= tenths(best.overallScore)) best = a;
  const deltaTenths = tenths(latest.overallScore) - tenths(first.overallScore);
  const fixed: string[] = [];
  for (const [k, before] of Object.entries(first.checkpointScores)) {
    const after = Object.prototype.hasOwnProperty.call(
      latest.checkpointScores,
      k,
    )
      ? latest.checkpointScores[k]!
      : undefined;
    if (after !== undefined && before < 65 && after >= 80) fixed.push(k);
  }
  return {
    sessionId,
    shotType: newest.f.shotType,
    attempts,
    first,
    latest,
    best,
    deltaTenths,
    trend:
      deltaTenths >= 3 ? 'improved' : deltaTenths <= -3 ? 'slipped' : 'held',
    fixedCheckpoints: fixed,
    stillOpen: latest.priorityCheckpoint,
    excludedCount: sameStroke.length - comparable.length,
    startedAt: first.capturedAt,
    endedAt: latest.capturedAt,
  };
}

function oracleLatest(
  facts: readonly RealAnalysisFact[],
  asOfIso: string,
  maxAgeMs: number,
): PracticeSetSummary | null {
  const asOfMs = Date.parse(asOfIso);
  const visible = facts.filter(f => {
    const ms = Date.parse(f.capturedAt);
    return Number.isFinite(ms) && ms <= asOfMs;
  });
  const latestBySession = new Map<string, number>();
  for (const f of visible) {
    if (
      f.sessionId === null ||
      f.resultKind !== 'scored' ||
      typeof f.overallScore !== 'number' ||
      !Number.isFinite(f.overallScore)
    ) {
      continue;
    }
    const ms = Date.parse(f.capturedAt);
    const prev = latestBySession.get(f.sessionId);
    if (prev === undefined || ms > prev) latestBySession.set(f.sessionId, ms);
  }
  const candidates = [...latestBySession.entries()]
    .filter(([, ms]) => asOfMs - ms <= maxAgeMs)
    .sort(([aId, aMs], [bId, bMs]) => bMs - aMs || idLess(aId, bId));
  for (const [sid] of candidates) {
    const s = oracleSummary(visible, sid);
    if (s) return s;
  }
  return null;
}

function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) =>
    typeof v === 'number' && !Number.isFinite(v) ? `<${String(v)}>` : v,
  );
}

function checkCopy(
  checker: Checker,
  summary: PracticeSetSummary,
  label: string,
): void {
  const headline = practiceSetHeadline(summary);
  const insight = practiceSetInsight(summary);
  for (const [name, text] of [
    ['headline', headline],
    ['insight', insight],
  ] as const) {
    const token = forbiddenToken(text);
    checker.check(
      'copy',
      token === null,
      () => `${label} ${name} contains "${token}": ${JSON.stringify(text)}`,
    );
    checker.check(
      'copy',
      text.trim().length > 0,
      () => `${label} ${name} is empty`,
    );
  }
  checker.check(
    'copy',
    insight
      .split(' · ')
      .every(clause => clause.trim().length > 0 && !/^\s|\s{2,}/.test(clause)),
    () =>
      `${label} insight has an empty or mis-spaced clause: ${JSON.stringify(insight)}`,
  );
  checker.check(
    'copy',
    /^(Held steady in this set|[+\u2212]\d+\.\d in this set)$/.test(headline),
    () => `${label} headline off-format: ${JSON.stringify(headline)}`,
  );
}

// ─── Campaigns ───────────────────────────────────────────────────────────────

const main = planCampaign('practiceSet', 60, TEST_FILE);
const options = planCampaign('practiceSetOptions', 12, TEST_FILE);
const hardening = planCampaign('practiceSetHardening', 24, TEST_FILE, {
  hardening: true,
});
const mainTable = new CampaignTable(main, { fieldFaults: IN_CONTRACT_FAULTS });
const optionsTable = new CampaignTable(options);
const hardeningTable = new CampaignTable(hardening, {
  note: 'values the app scorer never writes: scores outside 0–10, prototype-shaped checkpoint keys',
  fieldFaults: FIELD_FAULTS,
  hostileKeys: HOSTILE_KEYS,
});

afterAll(() => {
  mainTable.flush();
  optionsTable.flush();
  hardeningTable.flush();
});

function runFactCampaign(
  table: CampaignTable,
  seed: number,
  pool: FaultPool,
): void {
  const rng = new SeededRng(seed);
  const scenario = buildScenario(rng, pool);
  const facts = scenario.facts.map(f => f.fact);
  const faults = [...new Set(scenario.facts.map(f => f.fault))].sort();
  const outOfContract = faults.filter(f => OUT_OF_CONTRACT.has(f));
  const checker = new Checker();
  const started = Date.now();
  const params = {
    facts: facts.length,
    sessions: scenario.sessionIds,
    asOfIso: scenario.asOfIso,
    maxAgeMs: scenario.maxAgeMs ?? 'default',
    faults,
    outOfContract,
    factTable: scenario.facts.map(f => ({
      fault: f.fault,
      id: describeValue(f.fact.id),
      sessionId: f.fact.sessionId,
      shotType: describeValue(f.fact.shotType),
      capturedAt: describeValue(f.fact.capturedAt),
      overallScore: describeValue(f.fact.overallScore),
      resultKind: describeValue(f.fact.resultKind),
      versions: `${describeValue(f.fact.scoringModelVersion)}/${describeValue(f.fact.shotConfigVersion)}`,
      priorityCheckpoint: describeValue(f.fact.priorityCheckpoint),
      checkpointKeys: describeValue(
        f.fact.checkpointScores && typeof f.fact.checkpointScores === 'object'
          ? Object.keys(f.fact.checkpointScores)
          : f.fact.checkpointScores,
      ),
    })),
  };
  const observedParts: string[] = [];
  try {
    for (const sessionId of [...scenario.sessionIds, '', 'missing-set']) {
      const summary = summarizePracticeSet(facts, sessionId);
      const expected = oracleSummary(facts, sessionId);
      checker.check(
        'oracle',
        stable(summary) === stable(expected),
        () =>
          `summarize(${sessionId}) ${stable(summary)} ≠ oracle ${stable(expected)}`,
      );
      const shuffled = summarizePracticeSet(rng.shuffle(facts), sessionId);
      checker.check(
        'deterministic',
        stable(shuffled) === stable(summary),
        () => `summarize(${sessionId}) changes with fact order`,
      );
      if (summary) {
        observedParts.push(
          `${sessionId}: ${summary.attempts.length} attempts Δ${summary.deltaTenths} ${summary.trend} excl=${summary.excludedCount}`,
        );
        checkCopy(checker, summary, `summarize(${sessionId})`);
      } else {
        observedParts.push(`${sessionId}: null`);
      }
    }
    const opts = {
      asOfIso: scenario.asOfIso,
      ...(scenario.maxAgeMs === undefined
        ? {}
        : { maxAgeMs: scenario.maxAgeMs }),
    };
    const latest = latestPracticeSet(facts, opts);
    const expectedLatest = oracleLatest(
      facts,
      scenario.asOfIso,
      scenario.maxAgeMs ?? 86_400_000,
    );
    checker.check(
      'oracle',
      stable(latest) === stable(expectedLatest),
      () =>
        `latestPracticeSet ${stable(latest)} ≠ oracle ${stable(expectedLatest)}`,
    );
    checker.check(
      'deterministic',
      stable(latestPracticeSet(rng.shuffle(facts), opts)) === stable(latest),
      () => 'latestPracticeSet changes with fact order',
    );
    observedParts.push(`latest=${latest ? latest.sessionId : 'null'}`);
    if (latest) checkCopy(checker, latest, 'latest');
  } catch (error) {
    observedParts.push(`threw ${describeValue(error)}`);
    checker.fail('no_throw', describeValue(error));
  }
  const faultLabel =
    outOfContract.length > 0 ? 'out_of_contract' : 'repository_shaped';
  const result = table.record(
    seed,
    faultLabel,
    params,
    checker,
    observedParts.join('; '),
    Date.now() - started,
  );
  expect({
    outcome: result.outcome,
    failures: result.failures,
    replay: result.replay,
  }).toEqual({
    outcome: 'HELD',
    failures: [],
    replay: result.replay,
  });
}

describe('practice set summaries over unvalidated repository facts', () => {
  for (const seed of main.seeds) {
    it(`seed ${seed}`, () => runFactCampaign(mainTable, seed, 'in_contract'));
  }
});

describe('practice set summaries over values the scorer never writes (hardening)', () => {
  for (const seed of hardening.seeds) {
    it(`seed ${seed}`, () => runFactCampaign(hardeningTable, seed, 'all'));
  }
});

describe('latestPracticeSet option faults are refused', () => {
  for (const seed of options.seeds) {
    it(`seed ${seed}`, () => {
      const rng = new SeededRng(seed);
      const scenario = buildScenario(rng, 'none');
      const facts = scenario.facts.map(f => f.fact);
      const fault = rng.pick(['asOf_invalid', 'maxAge_invalid'] as const);
      const checker = new Checker();
      const started = Date.now();
      const params: Record<string, unknown> = { fault };
      let observed = '';
      try {
        let value: unknown;
        if (fault === 'asOf_invalid') {
          const asOfIso = rng.pick([
            '',
            'now',
            'NaN',
            '2026-13-45T25:61:00Z',
            'Z',
          ]);
          params.asOfIso = asOfIso;
          value = latestPracticeSet(facts, { asOfIso });
        } else {
          const maxAgeMs = rng.pick([-1, NaN, Infinity, -Infinity]);
          params.maxAgeMs = String(maxAgeMs);
          value = latestPracticeSet(facts, {
            asOfIso: scenario.asOfIso,
            maxAgeMs,
          });
        }
        observed = `returned ${describeValue(value).slice(0, 120)}`;
        checker.fail('options_reject', observed);
      } catch (error) {
        observed = `threw ${describeValue(error)}`;
        checker.check(
          'options_reject',
          error instanceof Error && error.message.trim().length > 0,
          () =>
            `thrown value is not an Error with a message: ${describeValue(error)}`,
        );
      }
      const result = optionsTable.record(
        seed,
        fault,
        params,
        checker,
        observed,
        Date.now() - started,
      );
      expect({
        outcome: result.outcome,
        failures: result.failures,
        replay: result.replay,
      }).toEqual({
        outcome: 'HELD',
        failures: [],
        replay: result.replay,
      });
    });
  }
});
