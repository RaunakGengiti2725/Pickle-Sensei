import {
  abstentionLedger,
  attemptChips,
  contactHaloHalfWidthMs,
  contactMarkerPresentation,
  effectivePhaseTimeline,
  isAbstainedResult,
  measuredRows,
  selectInsight,
  strokeResultHeader,
  techniqueScoreSectionVisible,
  visibleMeasuredRows,
  type AttemptRef,
} from '../../src/components/strokeResultModel';
import {
  LEAK_WORDS,
  LOCALES,
  TIMEZONES,
  campaignSeeds,
  campaignSize,
  writeArtifact,
} from '../../testing/stress/strokeResultStress.helpers';
import {
  EDGE_INSTANTS_ISO,
  buildScenario,
  isoFor,
  zoneOffsetMinutes,
  type IsoStyle,
  type Scenario,
} from '../../testing/stress/strokeResultStress.scenarios';

/**
 * STRESS — cmp-stroke-result / lens boundary-i18n-a11y — pure model layer.
 *
 * Campaign A (typed tier): every selector in strokeResultModel.ts is run on
 * seeded records whose free text comes from 12 locales + script hazards and
 * whose numbers come from the boundary pool (0, −0, ±1e15, 2^53, MAX_VALUE…).
 * Invariants asserted per seed: no throw, no placeholder leak
 * ("undefined"/"NaN"/"null"/"[object Object]"/"Infinity") in any copy, halo
 * within its documented bounds, ordered non-overlapping segments, row
 * collapse arithmetic, chip labels sequential with exactly one current chip,
 * scored-visible ⇒ not abstained.
 *
 * Campaign B (hostile tier): the same selectors on records with shape
 * drift (missing nested objects, wrong primitive types, null array items).
 * Throws are recorded in the outcome table per mutation, never hidden; the
 * pinned `.failing` tests below hold the minimized reproductions.
 *
 * Campaign C: attempt ordering across 8 timezones × 12 locales × 3 ISO
 * writer styles on DST-edge instants.
 *
 * Replay: STRESS_SEED=<seed> npx jest --ci __tests__/stress/strokeResultModel.boundary
 * Scale:  STRESS_ITER=<n> …   Table: STRESS_ARTIFACT_DIR=<dir> …
 */

const TYPED_BASE = 1_000;
const HOSTILE_BASE = 50_000;

/** Defect categories reproduced by the typed campaign and pinned below with
 * a minimized input. They are still recorded per seed in the table; the
 * campaign assertion excludes exactly these strings and a companion test
 * asserts they still reproduce, so a fix surfaces as "remove the pin". */
const PINNED_TYPED = ['header.title empty'] as const;

interface Outcome {
  seed: number;
  tier: Scenario['tier'];
  shape: string;
  locale: string;
  mutations: string[];
  outcome: 'pass' | 'fail';
  failures: string[];
  threw: string | null;
}

function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value))
    value.forEach(item => collectStrings(item, out));
  else if (value && typeof value === 'object') {
    Object.values(value as Record<string, unknown>).forEach(item =>
      collectStrings(item, out),
    );
  }
  return out;
}

function leaks(outputs: string[], inputs: readonly string[]): string[] {
  const found: string[] = [];
  for (const word of LEAK_WORDS) {
    if (inputs.some(input => input.includes(word))) continue;
    for (const text of outputs) {
      if (text.includes(word))
        found.push(`${word} in ${JSON.stringify(text.slice(0, 80))}`);
    }
  }
  return found;
}

function runSelectors(scenario: Scenario) {
  const { analysis, record } = scenario;
  const effectiveAnalysis = analysis ?? record?.result ?? null;
  const header = strokeResultHeader(record, effectiveAnalysis);
  const insight = selectInsight({
    strokeIntent: record?.strokeIntent ?? null,
    contact: record?.contact ?? null,
    temporalPhasesV2: record?.temporalPhasesV2 ?? null,
    limitingFactors: record?.uncertainty?.limitingFactors ?? [],
    analysis: effectiveAnalysis,
  });
  const marker = contactMarkerPresentation(record?.contact);
  const timeline = effectivePhaseTimeline(record, effectiveAnalysis);
  const rows = measuredRows({ analysis: effectiveAnalysis, record });
  const collapsed = visibleMeasuredRows(rows, false);
  const expanded = visibleMeasuredRows(rows, true);
  const chips = attemptChips(
    scenario.attempts ?? [],
    scenario.currentAnalysisId,
  );
  const abstained = isAbstainedResult(record, effectiveAnalysis);
  const scoredVisible = techniqueScoreSectionVisible(effectiveAnalysis);
  const ledger = abstained
    ? abstentionLedger({
        record,
        analysis: effectiveAnalysis,
        clipPresent: scenario.clip !== null,
      })
    : null;
  return {
    header,
    insight,
    marker,
    timeline,
    rows,
    collapsed,
    expanded,
    chips,
    abstained,
    scoredVisible,
    ledger,
  };
}

function checkInvariants(
  scenario: Scenario,
  out: ReturnType<typeof runSelectors>,
): string[] {
  const failures: string[] = [];
  const outputs = collectStrings([
    out.header,
    out.insight,
    out.marker,
    out.timeline,
    out.rows,
    out.chips,
    out.ledger,
  ]);
  failures.push(...leaks(outputs, scenario.inputs));

  if (out.header.title.trim().length === 0) failures.push('header.title empty');
  if (out.insight.sentence.trim().length === 0)
    failures.push('insight.sentence empty');

  if (out.marker.kind === 'marker') {
    if (!Number.isFinite(out.marker.contactMs))
      failures.push('marker.contactMs not finite');
    if (out.marker.haloHalfWidthMs < 33 || out.marker.haloHalfWidthMs > 165) {
      failures.push(`halo ${out.marker.haloHalfWidthMs} outside [33,165]`);
    }
    const contact = scenario.record?.contact;
    if (
      contact &&
      contact.status === 'estimated' &&
      !contact.ballConfirmed &&
      !contact.paddleConfirmed &&
      contact.confidence < 0.6
    ) {
      failures.push('marker drawn below the 0.6 unconfirmed gate');
    }
  }

  if (out.timeline.kind === 'segments') {
    const segments = out.timeline.segments;
    if (segments.length === 0) failures.push('segments kind with no segments');
    const keys = new Set<string>();
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i]!;
      if (!(segment.endMs > segment.startMs))
        failures.push(`segment ${segment.key} non-positive`);
      if (
        !Number.isFinite(segment.startMs) ||
        !Number.isFinite(segment.endMs)
      ) {
        failures.push(`segment ${segment.key} non-finite`);
      }
      const previous = segments[i - 1];
      if (previous && segment.startMs < previous.endMs)
        failures.push('segments overlap');
      if (keys.has(segment.key))
        failures.push(`duplicate segment key ${segment.key}`);
      keys.add(segment.key);
    }
    if (
      out.timeline.contactTickMs !== null &&
      !Number.isFinite(out.timeline.contactTickMs)
    ) {
      failures.push('contactTickMs non-finite');
    }
  }

  if (
    out.collapsed.visible.length + out.collapsed.hiddenCount !==
    out.rows.length
  ) {
    failures.push('collapsed rows arithmetic');
  }
  if (out.collapsed.visible.length > 4)
    failures.push('collapsed shows >4 rows');
  if (
    out.expanded.hiddenCount !== 0 ||
    out.expanded.visible.length !== out.rows.length
  ) {
    failures.push('expanded rows arithmetic');
  }
  const rowKeys = out.rows.map(row => row.key);
  if (new Set(rowKeys).size !== rowKeys.length)
    failures.push('duplicate row keys');

  if (out.chips.length > 0) {
    const current = out.chips.filter(chip => chip.isCurrent);
    if (current.length !== 1)
      failures.push(`chips current count ${current.length}`);
    out.chips.forEach((chip, index) => {
      if (chip.label !== `Attempt ${index + 1}`)
        failures.push(`chip label ${chip.label} at ${index}`);
    });
    const session = scenario.attempts?.find(
      a => a.analysisId === scenario.currentAnalysisId,
    )?.sessionId;
    if (session === null) failures.push('chips for a null session');
  }

  if (out.scoredVisible && out.abstained)
    failures.push('scored-visible AND abstained');
  if (out.ledger) {
    const all = [...out.ledger.held, ...out.ledger.notEstablished];
    if (new Set(all).size !== all.length)
      failures.push('ledger duplicate lines (React key collision)');
  }
  return failures;
}

function runCampaign(
  tier: Scenario['tier'],
  base: number,
  count: number,
): Outcome[] {
  return campaignSeeds(base, count).map(seed => {
    const scenario = buildScenario(seed, tier);
    let threw: string | null = null;
    let failures: string[] = [];
    try {
      failures = checkInvariants(scenario, runSelectors(scenario));
    } catch (error) {
      threw =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
    }
    return {
      seed,
      tier,
      shape: scenario.shape,
      locale: scenario.locale,
      mutations: scenario.mutations,
      outcome: threw === null && failures.length === 0 ? 'pass' : 'fail',
      failures,
      threw,
    };
  });
}

describe('stress: strokeResultModel boundary/i18n (typed tier)', () => {
  const outcomes = runCampaign('typed', TYPED_BASE, campaignSize(600));

  afterAll(() => {
    writeArtifact('model-typed.json', {
      campaign: 'strokeResultModel.boundary.stress typed',
      executed: outcomes.length,
      failed: outcomes.filter(o => o.outcome === 'fail').map(o => o.seed),
      outcomes,
    });
  });

  it(`holds every non-pinned invariant on ${outcomes.length} seeded records`, () => {
    const failed = outcomes
      .map(o => ({
        ...o,
        failures: o.failures.filter(
          f => !(PINNED_TYPED as readonly string[]).includes(f),
        ),
      }))
      .filter(o => o.threw !== null || o.failures.length > 0);
    expect(
      failed.map(
        o =>
          `seed ${o.seed} (${o.shape}, ${o.locale}): ${o.threw ?? o.failures.join('; ')}`,
      ),
    ).toEqual([]);
  });

  it('pinned typed-tier defects still reproduce (remove the pin when fixed)', () => {
    if (process.env['STRESS_SEED']) return;
    for (const category of PINNED_TYPED) {
      const seeds = outcomes
        .filter(o => o.failures.includes(category))
        .map(o => o.seed);
      expect({
        category,
        reproduced: seeds.length > 0,
        firstSeeds: seeds.slice(0, 3),
      }).toEqual(expect.objectContaining({ category, reproduced: true }));
    }
  });

  it('covers every shape and locale in the campaign', () => {
    const shapes = new Set(outcomes.map(o => o.shape));
    const locales = new Set(outcomes.map(o => o.locale));
    expect(shapes.size).toBeGreaterThanOrEqual(
      process.env['STRESS_SEED'] ? 1 : 11,
    );
    expect(locales.size).toBeGreaterThanOrEqual(
      process.env['STRESS_SEED'] ? 1 : LOCALES.length,
    );
  });
});

describe('stress: strokeResultModel shape drift (hostile tier)', () => {
  const outcomes = runCampaign('hostile', HOSTILE_BASE, campaignSize(200));

  afterAll(() => {
    writeArtifact('model-hostile.json', {
      campaign: 'strokeResultModel.boundary.stress hostile',
      executed: outcomes.length,
      threw: outcomes
        .filter(o => o.threw !== null)
        .map(o => ({ seed: o.seed, mutations: o.mutations, threw: o.threw })),
      failed: outcomes.filter(o => o.outcome === 'fail').map(o => o.seed),
      outcomes,
    });
  });

  it('records the outcome of every hostile seed (throws are attributed to a named mutation)', () => {
    // A throw with NO shape-drift mutation would be a typed-tier defect in
    // disguise; every throw must trace to a mutation the seed applied.
    const unattributed = outcomes.filter(
      o => o.threw !== null && o.mutations.length === 0,
    );
    expect(unattributed.map(o => `seed ${o.seed}: ${o.threw}`)).toEqual([]);
    expect(outcomes.length).toBeGreaterThan(0);
  });

  it('non-finite numbers alone (no shape drift) never throw', () => {
    // Seeds whose only hostility is NaN/±Infinity in numeric fields.
    const numericOnly = outcomes.filter(o => o.mutations.length === 0);
    expect(numericOnly.filter(o => o.threw !== null).map(o => o.seed)).toEqual(
      [],
    );
  });
});

describe('stress: pinned shape-drift reproductions (expected to fail until guarded)', () => {
  // measuredRows reads analysis.timestamps.startMs without the optional
  // chaining analysisContactMs uses for the same object (strokeResultModel.ts
  // ~L804 vs ~L588). A persisted result lacking `timestamps` throws.
  it.failing('measuredRows survives a result without `timestamps`', () => {
    const scenario = buildScenario(HOSTILE_BASE, 'hostile');
    const analysis =
      scenario.analysis ?? buildScenario(TYPED_BASE, 'typed').analysis!;
    delete (analysis as unknown as Record<string, unknown>)['timestamps'];
    expect(() => measuredRows({ analysis, record: null })).not.toThrow();
  });

  it.failing('measuredRows survives a non-numeric measurement value', () => {
    const analysis = buildScenario(TYPED_BASE, 'typed').analysis!;
    analysis.measurements = [
      {
        metricKey: 'wrist_speed',
        value: '12.5' as unknown as number,
        confidence: 1,
        unit: 'ratio',
        source: 'real',
      },
    ];
    expect(() => measuredRows({ analysis, record: null })).not.toThrow();
  });

  it.failing('measuredRows survives a measurement without `unit`', () => {
    const analysis = buildScenario(TYPED_BASE, 'typed').analysis!;
    analysis.measurements = [
      {
        metricKey: 'wrist_speed',
        value: 1,
        confidence: 1,
        source: 'real',
      } as unknown as (typeof analysis.measurements)[number],
    ];
    expect(() => measuredRows({ analysis, record: null })).not.toThrow();
  });

  it.failing(
    'measuredRows survives a JSON round-tripped NaN value (→ null)',
    () => {
      // JSON.stringify turns NaN/±Infinity into null, so a non-finite engine
      // value persisted through SQLite comes back as `value: null`.
      const analysis = buildScenario(TYPED_BASE, 'typed').analysis!;
      analysis.measurements = JSON.parse(
        JSON.stringify([
          {
            metricKey: 'wrist_speed',
            value: Number.NaN,
            confidence: 1,
            unit: 'ratio',
            source: 'real',
          },
        ]),
      );
      expect(() => measuredRows({ analysis, record: null })).not.toThrow();
    },
  );

  it.failing(
    'abstentionLedger survives a null entry in uncertainty.limitingFactors',
    () => {
      expect(() =>
        abstentionLedger({
          record: {
            id: 'r',
            strokeIntent: null,
            result: null,
            uncertainty: {
              analysisConfidence: 0,
              presentation: 'normal',
              limitingFactors: [null as unknown as string],
            },
          },
          analysis: null,
          clipPresent: false,
        }),
      ).not.toThrow();
    },
  );

  it.failing(
    'strokeResultHeader survives a disagreement without `declared`',
    () => {
      const intent = buildScenario(TYPED_BASE, 'typed').record?.strokeIntent;
      expect(() =>
        strokeResultHeader(
          {
            id: 'r',
            strokeIntent: {
              ...(intent ?? {
                declaredStroke: 'forehand_drive',
                predictedStroke: null,
                resolvedProfileId: null,
                resolvedProfileVersion: null,
              }),
              resolutionBasis: 'declared',
              disagreement: {
                predictedLabel: 'BACKHAND',
                basis: 'leaf_vs_declared',
              } as never,
            },
            result: null,
            uncertainty: null,
          },
          null,
        ),
      ).not.toThrow();
    },
  );
});

describe('stress: pinned typed-tier boundary defects (type-valid inputs, expected to fail until guarded)', () => {
  it.failing(
    'a whitespace-only declared stroke falls back to "Saved stroke" instead of an empty title',
    () => {
      const header = strokeResultHeader(
        {
          id: 'r',
          strokeIntent: {
            declaredStroke: '   \t' as never,
            predictedStroke: null,
            resolutionBasis: 'declared',
            resolvedProfileId: null,
            resolvedProfileVersion: null,
            disagreement: null,
          },
          result: null,
          uncertainty: null,
        },
        null,
      );
      expect(header.title.trim().length).toBeGreaterThan(0);
    },
  );

  it.failing(
    'non-finite measurement values never surface as literal "NaN"/"Infinity" copy',
    () => {
      const analysis = buildScenario(TYPED_BASE, 'typed').analysis!;
      analysis.timestamps = {
        startMs: 0,
        contactMs: null,
        endMs: Number.POSITIVE_INFINITY,
      };
      analysis.measurements = [
        {
          metricKey: 'wrist_speed',
          value: Number.NaN,
          confidence: 1,
          unit: 'ratio',
          source: 'real',
        },
        {
          metricKey: 'elbow_angle',
          value: Number.NEGATIVE_INFINITY,
          confidence: 1,
          unit: 'degrees',
          source: 'real',
        },
      ];
      const values = measuredRows({ analysis, record: null }).map(
        row => row.value,
      );
      expect(values.filter(v => /NaN|Infinity/.test(v))).toEqual([]);
    },
  );

  it.failing(
    'two measurements sharing a metricKey do not produce duplicate row keys',
    () => {
      const analysis = buildScenario(TYPED_BASE, 'typed').analysis!;
      analysis.measurements = [
        {
          metricKey: 'wrist_speed',
          value: 1,
          confidence: 1,
          unit: 'ratio',
          source: 'real',
        },
        {
          metricKey: 'wrist_speed',
          value: 2,
          confidence: 1,
          unit: 'ratio',
          source: 'real',
        },
      ];
      const keys = measuredRows({ analysis, record: null }).map(row => row.key);
      expect(new Set(keys).size).toBe(keys.length);
    },
  );
});

describe('stress: attempt ordering across 8 timezones × 12 locales', () => {
  const styles: IsoStyle[] = ['utc_seconds', 'utc_millis', 'offset'];
  const table: Array<{
    zone: string;
    locale: string;
    style: IsoStyle;
    ordered: boolean;
    sample: string[];
  }> = [];

  for (const zone of TIMEZONES) {
    for (const locale of LOCALES) {
      for (const style of styles) {
        const instants = EDGE_INSTANTS_ISO.map(iso => Date.parse(iso));
        const attempts: AttemptRef[] = instants.map((epoch, index) => ({
          analysisId: `a-${index}`,
          capturedAtIso: isoFor(epoch, style, zoneOffsetMinutes(zone, epoch)),
          sessionId: 's',
        }));
        // Prove the zone/locale pair is real for this ICU before relying on it.
        new Intl.DateTimeFormat(locale, {
          timeZone: zone,
          timeStyle: 'long',
        }).format(new Date(instants[0]!));
        const shuffled = [...attempts].reverse();
        const chips = attemptChips(shuffled, 'a-0');
        const chronological = [...attempts]
          .sort(
            (a, b) => Date.parse(a.capturedAtIso) - Date.parse(b.capturedAtIso),
          )
          .map(a => a.analysisId);
        table.push({
          zone,
          locale,
          style,
          ordered:
            JSON.stringify(chips.map(c => c.analysisId)) ===
            JSON.stringify(chronological),
          sample: attempts.slice(0, 2).map(a => a.capturedAtIso),
        });
      }
    }
  }

  afterAll(() => {
    writeArtifact('attempt-order-tz.json', {
      campaign: 'attemptChips ordering × timezone × locale × ISO style',
      executed: table.length,
      failed: table.filter(row => !row.ordered),
      table,
    });
  });

  it('orders UTC-normalised timestamps chronologically in every zone and locale (the two real writers)', () => {
    const utc = table.filter(row => row.style !== 'offset');
    expect(utc.length).toBe(TIMEZONES.length * LOCALES.length * 2);
    expect(utc.filter(row => !row.ordered)).toEqual([]);
  });

  it.failing(
    'orders zone-offset timestamps chronologically (string compare is not instant compare)',
    () => {
      // No shipping writer emits offset-form ISO strings today
      // (ClipMediaStore.swift → ISO8601DateFormatter UTC; JS → toISOString), so
      // this is a latent hazard of `capturedAtIso.localeCompare`, pinned here.
      const offset = table.filter(row => row.style === 'offset');
      expect(offset.filter(row => !row.ordered)).toEqual([]);
    },
  );

  it('the three target files never read wall-clock or locale APIs', () => {
    const fs = jest.requireActual<typeof import('node:fs')>('node:fs');
    const path = jest.requireActual<typeof import('node:path')>('node:path');
    const files = [
      'StrokeResult.tsx',
      'strokeResultData.ts',
      'strokeResultModel.ts',
    ];
    for (const file of files) {
      const source = fs.readFileSync(
        path.join(__dirname, '../../src/components', file),
        'utf8',
      );
      expect(source).not.toMatch(
        /new Date\(|Date\.now|Intl\.|toLocale(Date|Time)?String/,
      );
    }
  });
});

describe('stress: contactHaloHalfWidthMs bounds on the numeric pool', () => {
  it('stays within [33, 165] for every finite and non-finite confidence', () => {
    const pool = [
      0,
      -0,
      1,
      -1,
      0.5,
      0.6,
      1e15,
      -1e15,
      Number.MAX_VALUE,
      Number.NaN,
      Infinity,
      -Infinity,
    ];
    const results = pool.map(value => ({
      value,
      halo: contactHaloHalfWidthMs(value),
    }));
    const outOfBounds = results.filter(r => !(r.halo >= 33 && r.halo <= 165));
    writeArtifact(
      'halo-bounds.json',
      results.map(r => ({ value: String(r.value), halo: String(r.halo) })),
    );
    expect(
      outOfBounds
        .filter(r => !Number.isNaN(r.value))
        .map(r => `${r.value} → ${r.halo}`),
    ).toEqual([]);
  });

  it.failing(
    'a NaN confidence still yields a bounded halo (Math.min/max propagate NaN)',
    () => {
      const halo = contactHaloHalfWidthMs(Number.NaN);
      expect(halo >= 33 && halo <= 165).toBe(true);
    },
  );
});
