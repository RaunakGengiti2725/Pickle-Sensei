import React from 'react';
import { Text } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
import {
  StrokeResult,
  StrokeResultAnalyzing,
} from '../../src/components/StrokeResult';
import {
  FONT_SCALES,
  HAZARD_STRINGS,
  LOCALES,
  LOCALE_CORPUS,
  WIDTHS,
  auditInteractive,
  campaignSeeds,
  campaignSize,
  copyLeaks,
  estimateLayout,
  renderedTreeEvidence,
  writeArtifact,
  type InteractiveAudit,
  type LayoutIssue,
} from '../../testing/stress/strokeResultStress.helpers';
import {
  buildScenario,
  type Scenario,
} from '../../testing/stress/strokeResultStress.scenarios';

/**
 * STRESS — cmp-stroke-result / lens boundary-i18n-a11y — rendered tree.
 *
 * Every seed renders <StrokeResult> with a scenario from
 * strokeResultStress.scenarios.ts (12 locales × 3 font scales × 3 widths are
 * assigned deterministically from the seed; free text and numerics are
 * seeded) and then audits the host tree:
 *
 *  VERIFIED at the rendered-tree level (read straight from host props):
 *   - render does not throw, React logs no console.error (duplicate keys,
 *     invalid children…);
 *   - no placeholder copy ("undefined"/"NaN"/…) in text or a11y strings;
 *   - every interactive node (onPress/onClick/responder/a11y action or an
 *     interactive accessibilityRole) has a role AND a non-empty label;
 *   - every interactive node whose touch edge is fixed by style resolves to
 *     ≥ 44pt including hitSlop.
 *  INFERRED (no Yoga in react-test-renderer — a static estimator over
 *  flattened styles + glyph widths; see helpers): row-embedded text that
 *  cannot shrink and is wider than the width budget, overflow-hidden boxes
 *  whose estimated content exceeds their height, absolutely positioned
 *  siblings whose estimated boxes intersect. Reported in the table with the
 *  estimate, never asserted as iOS truth.
 *
 * Replay: STRESS_SEED=<seed> npx jest --ci __tests__/stress/strokeResult.render
 * Scale:  STRESS_ITER=<n> …   Table + trees: STRESS_ARTIFACT_DIR=<dir> …
 */

const TYPED_BASE = 10_000;
const HOSTILE_BASE = 60_000;

interface RenderOutcome {
  seed: number;
  tier: Scenario['tier'];
  shape: string;
  locale: string;
  fontScale: number;
  width: number;
  timezone: string;
  mutations: string[];
  threw: string | null;
  consoleErrors: string[];
  leaks: string[];
  interactive: number;
  unlabeled: Array<Pick<InteractiveAudit, 'path' | 'role' | 'label'>>;
  smallTargets: Array<
    Pick<
      InteractiveAudit,
      | 'path'
      | 'role'
      | 'label'
      | 'width'
      | 'height'
      | 'hitSlop'
      | 'effectiveMinEdge'
    >
  >;
  unresolvedTargets: number;
  layoutInferred: LayoutIssue[];
  textNodes: number;
  outcome: 'pass' | 'fail' | 'threw';
}

async function renderScenario(scenario: Scenario) {
  const slot = (text: string | null) =>
    text === null ? undefined : <Text>{text}</Text>;
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <StrokeResult
        analysis={scenario.analysis}
        record={scenario.record}
        clip={scenario.clip}
        attempts={scenario.attempts}
        currentAnalysisId={scenario.currentAnalysisId}
        onOpenAttempt={() => undefined}
        onTryAgain={() => undefined}
        onDone={() => undefined}
        scoreSlot={slot(scenario.slots.score)}
        reviewSlot={slot(scenario.slots.review)}
        fixSlot={slot(scenario.slots.fix)}
        hideCtaRow={scenario.hideCtaRow}
      >
        {slot(scenario.slots.children)}
      </StrokeResult>,
    );
  });
  return renderer;
}

async function runSeed(
  seed: number,
  tier: Scenario['tier'],
  trees: Record<string, string[]>,
): Promise<RenderOutcome> {
  const scenario = buildScenario(seed, tier);
  const consoleErrors: string[] = [];
  const spy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      consoleErrors.push(
        args
          .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
          .join(' ')
          .slice(0, 200),
      );
    });
  const base = {
    seed,
    tier,
    shape: scenario.shape,
    locale: scenario.locale,
    fontScale: scenario.fontScale,
    width: scenario.width,
    timezone: scenario.timezone,
    mutations: scenario.mutations,
  };
  try {
    const renderer = await renderScenario(scenario);
    const json = renderer.toJSON();
    const audit = auditInteractive(json);
    const unlabeled = audit.filter(a => !a.hasRole || !a.hasLabel);
    const small = audit.filter(a => a.meets44 === false);
    const layout = estimateLayout(json, {
      width: scenario.width,
      fontScale: scenario.fontScale,
    });
    const leaks = copyLeaks(json, scenario.inputs);
    let textNodes = 0;
    JSON.stringify(json, (_key, value: unknown) => {
      if (typeof value === 'string') textNodes += 1;
      return value;
    });
    const outcome: RenderOutcome = {
      ...base,
      threw: null,
      consoleErrors,
      leaks,
      interactive: audit.length,
      unlabeled: unlabeled.map(({ path, role, label }) => ({
        path,
        role,
        label,
      })),
      smallTargets: small.map(
        ({ path, role, label, width, height, hitSlop, effectiveMinEdge }) => ({
          path,
          role,
          label,
          width,
          height,
          hitSlop,
          effectiveMinEdge,
        }),
      ),
      unresolvedTargets: audit.filter(a => a.meets44 === 'unresolved').length,
      layoutInferred: layout,
      textNodes,
      outcome:
        consoleErrors.length === 0 &&
        leaks.length === 0 &&
        unlabeled.length === 0 &&
        small.length === 0
          ? 'pass'
          : 'fail',
    };
    if (outcome.outcome !== 'pass' && Object.keys(trees).length < 12) {
      trees[`seed-${seed}`] = renderedTreeEvidence(json);
    }
    await act(async () => renderer.unmount());
    return outcome;
  } catch (error) {
    return {
      ...base,
      threw:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      consoleErrors,
      leaks: [],
      interactive: 0,
      unlabeled: [],
      smallTargets: [],
      unresolvedTargets: 0,
      layoutInferred: [],
      textNodes: 0,
      outcome: 'threw',
    };
  } finally {
    spy.mockRestore();
  }
}

function summarize(outcomes: RenderOutcome[]) {
  const smallByLabel = new Map<
    string,
    { count: number; sample: RenderOutcome['smallTargets'][number] }
  >();
  const layoutByKey = new Map<
    string,
    {
      count: number;
      scales: Set<number>;
      widths: Set<number>;
      sample: LayoutIssue;
    }
  >();
  for (const o of outcomes) {
    for (const s of o.smallTargets) {
      const key = `${s.role}|${s.label}`;
      const entry = smallByLabel.get(key);
      if (entry) entry.count += 1;
      else smallByLabel.set(key, { count: 1, sample: s });
    }
    for (const issue of o.layoutInferred) {
      const key = `${issue.kind}|${issue.path.replace(/\[\d+\]/g, '')}|${issue.text.slice(0, 20)}`;
      const entry = layoutByKey.get(key);
      if (entry) {
        entry.count += 1;
        entry.scales.add(issue.fontScale);
        entry.widths.add(issue.width);
      } else {
        layoutByKey.set(key, {
          count: 1,
          scales: new Set([issue.fontScale]),
          widths: new Set([issue.width]),
          sample: issue,
        });
      }
    }
  }
  return {
    smallTargets: [...smallByLabel.entries()].map(([key, v]) => ({
      key,
      ...v,
    })),
    layoutInferred: [...layoutByKey.entries()].map(([key, v]) => ({
      key,
      count: v.count,
      fontScales: [...v.scales].sort(),
      widths: [...v.widths].sort(),
      sample: v.sample,
    })),
  };
}

describe('stress: <StrokeResult> rendered variants (typed tier)', () => {
  const seeds = campaignSeeds(TYPED_BASE, campaignSize(216));
  const outcomes: RenderOutcome[] = [];
  const trees: Record<string, string[]> = {};

  beforeAll(async () => {
    for (const seed of seeds)
      outcomes.push(await runSeed(seed, 'typed', trees));
  }, 240_000);

  afterAll(() => {
    writeArtifact('render-typed.json', {
      campaign: 'strokeResult.render.stress typed',
      executed: outcomes.length,
      matrix: {
        locales: [...new Set(outcomes.map(o => o.locale))],
        fontScales: [...new Set(outcomes.map(o => o.fontScale))],
        widths: [...new Set(outcomes.map(o => o.width))],
        shapes: [...new Set(outcomes.map(o => o.shape))],
      },
      summary: summarize(outcomes),
      outcomes,
    });
    writeArtifact('render-typed-trees.json', trees);
  });

  it('renders every variant without throwing or logging console.error', () => {
    expect(outcomes.length).toBe(seeds.length);
    expect(
      outcomes
        .filter(o => o.threw !== null)
        .map(o => `seed ${o.seed}: ${o.threw}`),
    ).toEqual([]);
    expect(
      outcomes
        .filter(o => o.consoleErrors.length > 0)
        .map(o => `seed ${o.seed}: ${o.consoleErrors.join(' | ')}`),
    ).toEqual([]);
  });

  it('never renders placeholder copy (undefined / NaN / null / [object Object] / Infinity)', () => {
    expect(
      outcomes
        .filter(o => o.leaks.length > 0)
        .map(o => `seed ${o.seed}: ${o.leaks.join('; ')}`),
    ).toEqual([]);
  });

  it('gives every interactive node an accessibility role and a non-empty label', () => {
    expect(outcomes.reduce((n, o) => n + o.interactive, 0)).toBeGreaterThan(0);
    expect(
      outcomes
        .filter(o => o.unlabeled.length > 0)
        .map(o => `seed ${o.seed}: ${JSON.stringify(o.unlabeled)}`),
    ).toEqual([]);
  });

  it('covers 12 locales × 3 font scales × 3 widths and every shape', () => {
    if (process.env['STRESS_SEED']) return;
    expect(new Set(outcomes.map(o => o.locale)).size).toBe(LOCALES.length);
    expect(new Set(outcomes.map(o => o.fontScale)).size).toBe(
      FONT_SCALES.length,
    );
    expect(new Set(outcomes.map(o => o.width)).size).toBe(WIDTHS.length);
    expect(new Set(outcomes.map(o => o.shape)).size).toBeGreaterThanOrEqual(11);
  });

  it.failing(
    'every interactive node with a style-fixed touch edge resolves to ≥ 44pt (incl. hitSlop)',
    () => {
      // Pinned: the replay scrubber is a 40pt-high adjustable with no hitSlop
      // and the attempt chips are minHeight 40 + hitSlop 4 = 48 (ok); see
      // StrokeResult.tsx styles.scrubTrack / styles.attemptChip.
      const small = outcomes.filter(o => o.smallTargets.length > 0);
      expect(
        small.map(o => `seed ${o.seed}: ${JSON.stringify(o.smallTargets)}`),
      ).toEqual([]);
    },
  );

  it('INFERRED layout estimator: no row overflow / clip / overlap at the default font scale', () => {
    const atDefault = outcomes.filter(o => o.fontScale === 1);
    expect(
      atDefault
        .filter(o => o.layoutInferred.length > 0)
        .map(
          o =>
            `seed ${o.seed} (${o.width}pt): ${o.layoutInferred.map(i => `${i.kind} ${i.detail}`).join('; ')}`,
        ),
    ).toEqual([]);
  });
});

describe('stress: <StrokeResult> shape-drift renders (hostile tier)', () => {
  const seeds = campaignSeeds(HOSTILE_BASE, campaignSize(48));
  const outcomes: RenderOutcome[] = [];
  const trees: Record<string, string[]> = {};

  beforeAll(async () => {
    for (const seed of seeds)
      outcomes.push(await runSeed(seed, 'hostile', trees));
  }, 240_000);

  afterAll(() => {
    writeArtifact('render-hostile.json', {
      campaign: 'strokeResult.render.stress hostile',
      executed: outcomes.length,
      threw: outcomes
        .filter(o => o.threw !== null)
        .map(o => ({ seed: o.seed, mutations: o.mutations, threw: o.threw })),
      summary: summarize(outcomes),
      outcomes,
    });
    writeArtifact('render-hostile-trees.json', trees);
  });

  it('attributes every render throw to a named shape-drift mutation', () => {
    expect(outcomes.length).toBe(seeds.length);
    const unattributed = outcomes.filter(
      o => o.threw !== null && o.mutations.length === 0,
    );
    expect(unattributed.map(o => `seed ${o.seed}: ${o.threw}`)).toEqual([]);
  });

  it('non-finite numbers alone (no shape drift) never crash the surface', () => {
    const numericOnly = outcomes.filter(o => o.mutations.length === 0);
    expect(
      numericOnly
        .filter(o => o.threw !== null)
        .map(o => `seed ${o.seed}: ${o.threw}`),
    ).toEqual([]);
  });
});

describe('stress: <StrokeResultAnalyzing> captions across locales and hazards', () => {
  const captions = [
    ...LOCALES.flatMap(locale => [...LOCALE_CORPUS[locale]]),
    ...HAZARD_STRINGS,
  ];

  it(`renders ${captions.length} captions with a live region + label and no leak`, async () => {
    const failures: string[] = [];
    for (const [index, caption] of captions.entries()) {
      let renderer!: TestRenderer.ReactTestRenderer;
      await act(async () => {
        renderer = TestRenderer.create(
          <StrokeResultAnalyzing
            caption={caption}
            detail={index % 2 === 0 ? caption : undefined}
          />,
        );
      });
      const json = renderer.toJSON();
      const audit = auditInteractive(json);
      const leaks = copyLeaks(json, [caption]);
      let live: string | null = null;
      JSON.stringify(json, (key, value: unknown) => {
        if (key === 'accessibilityLiveRegion' && typeof value === 'string')
          live = value;
        return value;
      });
      if (live !== 'polite')
        failures.push(`caption[${index}]: no polite live region`);
      if (leaks.length > 0)
        failures.push(`caption[${index}]: ${leaks.join('; ')}`);
      if (audit.some(a => !a.hasLabel || !a.hasRole))
        failures.push(`caption[${index}]: unlabeled interactive`);
      await act(async () => renderer.unmount());
    }
    expect(failures).toEqual([]);
  });
});
