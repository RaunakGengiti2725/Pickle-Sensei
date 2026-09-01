import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import {
  ANALYSIS_DURATION_HINT,
  ANALYSIS_STAGE_LABELS,
  AnalysisProgressBar,
  analysisStageProgress,
  extractionEtaSeconds,
  extractionProgress,
  extractionSublabel,
  observeExtractionProgress,
  type ExtractionEtaState,
} from '../src/components/AnalysisProgress';

/**
 * Analysis progress surface — the honest-progress contract:
 *  - the ETA is pure math over REAL native (t, progress) events: rate is an
 *    exponential moving average recomputed on every event, remaining time is
 *    rounded UP and clamped ≥1s, and no estimate exists before two events
 *    have actually measured a rate;
 *  - the bar renders a percentage ONLY in determinate mode; indeterminate
 *    mode is a pulse with a stage label — no fabricated numbers anywhere.
 */

// ─── ETA math (pure) ─────────────────────────────────────────────────────────

describe('extraction ETA math', () => {
  it('first event: percentage only — no rate has been measured yet', () => {
    const state = observeExtractionProgress(null, 0, 0.1);
    expect(state.eventCount).toBe(1);
    expect(state.smoothedRatePerMs).toBeNull();
    expect(extractionEtaSeconds(state)).toBeNull();
    expect(extractionSublabel(state)).toBe('10%');
  });

  it('second event measures the first real rate and yields an ETA', () => {
    let state = observeExtractionProgress(null, 0, 0.1);
    state = observeExtractionProgress(state, 1000, 0.2);
    // rate = 0.1 / 1000ms → remaining 0.8 → 8000ms → 8s.
    expect(extractionEtaSeconds(state)).toBe(8);
    expect(extractionSublabel(state)).toBe('20% · ~8s left');
  });

  it('recomputes per event through the EMA — a faster pass shrinks the ETA', () => {
    let state = observeExtractionProgress(null, 0, 0.1);
    state = observeExtractionProgress(state, 1000, 0.2);
    state = observeExtractionProgress(state, 2000, 0.4);
    // instant = 0.0002, ema = 0.4·0.0002 + 0.6·0.0001 = 0.00014 →
    // remaining 0.6 → 4285.7ms → ceil → 5s.
    expect(extractionEtaSeconds(state)).toBe(5);
    expect(extractionSublabel(state)).toBe('40% · ~5s left');
  });

  it('rounds up and clamps to ≥1s near completion', () => {
    let state = observeExtractionProgress(null, 0, 0.5);
    state = observeExtractionProgress(state, 100, 0.99);
    // remaining 0.01 at 0.0049/ms ≈ 2ms → 1s floor.
    expect(extractionEtaSeconds(state)).toBe(1);
    expect(extractionSublabel(state)).toBe('99% · ~1s left');
  });

  it('a stall keeps the last measured rate and recomputes (never frozen)', () => {
    let state = observeExtractionProgress(null, 0, 0.2);
    state = observeExtractionProgress(state, 1000, 0.4);
    expect(extractionEtaSeconds(state)).toBe(3);
    // Stalled event: same fraction one second later — rate is NOT re-derived
    // from the stall (that would divide by zero progress), remaining is
    // recomputed from the unchanged inputs.
    state = observeExtractionProgress(state, 2000, 0.4);
    expect(state.eventCount).toBe(3);
    expect(extractionEtaSeconds(state)).toBe(3);
    expect(extractionSublabel(state)).toBe('40% · ~3s left');
  });

  it('a zero-Δt event updates the fraction without inventing a rate', () => {
    let state = observeExtractionProgress(null, 0, 0.2);
    state = observeExtractionProgress(state, 1000, 0.4);
    const rateBefore = state.smoothedRatePerMs;
    state = observeExtractionProgress(state, 1000, 0.6);
    expect(state.smoothedRatePerMs).toBe(rateBefore);
    // remaining 0.4 at 0.0002/ms → 2000ms → 2s, from the NEW fraction.
    expect(extractionEtaSeconds(state)).toBe(2);
    expect(extractionSublabel(state)).toBe('60% · ~2s left');
  });

  it('a regressing fraction is displayed as reported, never a negative rate', () => {
    let state = observeExtractionProgress(null, 0, 0.2);
    state = observeExtractionProgress(state, 1000, 0.4);
    const rateBefore = state.smoothedRatePerMs;
    state = observeExtractionProgress(state, 2000, 0.3);
    expect(state.lastProgress).toBe(0.3);
    expect(state.smoothedRatePerMs).toBe(rateBefore);
    // remaining 0.7 at 0.0002/ms → 3500ms → 4s.
    expect(extractionEtaSeconds(state)).toBe(4);
  });

  it('completion drops the countdown: 100% with no "~0s left"', () => {
    let state = observeExtractionProgress(null, 0, 0.5);
    state = observeExtractionProgress(state, 1000, 1);
    expect(extractionEtaSeconds(state)).toBeNull();
    expect(extractionSublabel(state)).toBe('100%');
  });

  it('never yields an ETA when no forward rate was ever measured', () => {
    let state = observeExtractionProgress(null, 0, 0.3);
    state = observeExtractionProgress(state, 1000, 0.3);
    expect(state.eventCount).toBe(2);
    expect(state.smoothedRatePerMs).toBeNull();
    expect(extractionEtaSeconds(state)).toBeNull();
    expect(extractionSublabel(state)).toBe('30%');
  });

  it('clamps out-of-range native fractions instead of rendering them', () => {
    expect(observeExtractionProgress(null, 0, 1.7).lastProgress).toBe(1);
    expect(observeExtractionProgress(null, 0, -0.2).lastProgress).toBe(0);
    expect(observeExtractionProgress(null, 0, Number.NaN).lastProgress).toBe(0);
  });

  it('null state renders nothing — no invented sublabel', () => {
    expect(extractionSublabel(null)).toBeNull();
    expect(extractionEtaSeconds(null)).toBeNull();
  });
});

// ─── Stage model helpers ─────────────────────────────────────────────────────

describe('analysis stage snapshots', () => {
  it('unmeasured stages are indeterminate with the static honest hint', () => {
    for (const stage of ['verifying', 'measuring', 'saving'] as const) {
      expect(analysisStageProgress(stage)).toEqual({
        stage,
        progress: null,
        label: ANALYSIS_STAGE_LABELS[stage],
        sublabel: ANALYSIS_DURATION_HINT,
      });
    }
    expect(ANALYSIS_DURATION_HINT).toBe('usually under ~10 seconds');
  });

  it('extraction is indeterminate before the first native event, real after', () => {
    expect(extractionProgress(null)).toEqual({
      stage: 'extracting',
      progress: null,
      label: 'Reading player movement',
      sublabel: null,
    });
    let eta: ExtractionEtaState | null = null;
    eta = observeExtractionProgress(eta, 0, 0.1);
    eta = observeExtractionProgress(eta, 1000, 0.2);
    expect(extractionProgress(eta)).toEqual({
      stage: 'extracting',
      progress: 0.2,
      label: 'Reading player movement',
      sublabel: '20% · ~8s left',
    });
  });
});

// ─── Progress bar component ──────────────────────────────────────────────────

async function render(element: React.ReactElement) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element);
  });
  return renderer;
}

/** Rendered TEXT content only — style objects (e.g. width '100%') excluded. */
function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  const collect = (node: unknown): string => {
    if (node == null) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(collect).join('');
    const json = node as { children?: unknown[] };
    return (json.children ?? []).map(collect).join('\n');
  };
  return collect(renderer.toJSON());
}

function progressNode(renderer: TestRenderer.ReactTestRenderer) {
  const [node] = renderer.root.findAll(
    n => n.props.accessibilityRole === 'progressbar',
  );
  if (!node) throw new Error('No progressbar rendered');
  return node;
}

describe('AnalysisProgressBar', () => {
  // Fake timers: the indeterminate pulse is an Animated.loop — real timers
  // would keep scheduling frames past the suite's teardown.
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('determinate: exposes the real percentage and both labels', async () => {
    const renderer = await render(
      <AnalysisProgressBar
        dark
        progress={0.42}
        label="Reading player movement"
        sublabel="42% · ~6s left"
      />,
    );
    const node = progressNode(renderer);
    expect(node.props.accessibilityValue).toEqual({
      min: 0,
      max: 100,
      now: 42,
    });
    const rendered = textOf(renderer);
    expect(rendered).toContain('Reading player movement');
    expect(rendered).toContain('42% · ~6s left');
    expect(
      renderer.root.findAll(n => n.props.testID === 'analysis-progress-fill')
        .length,
    ).toBeGreaterThan(0);
    await act(async () => renderer.unmount());
  });

  it('indeterminate: no percentage value anywhere — pulse plus honest labels', async () => {
    const renderer = await render(
      <AnalysisProgressBar
        dark
        progress={null}
        label="Measuring your swing"
        sublabel="usually under ~10 seconds"
      />,
    );
    const node = progressNode(renderer);
    expect(node.props.accessibilityValue).toEqual({ min: 0, max: 100 });
    expect(node.props.accessibilityValue.now).toBeUndefined();
    const rendered = textOf(renderer);
    expect(rendered).toContain('Measuring your swing');
    expect(rendered).toContain('usually under ~10 seconds');
    expect(rendered).not.toContain('%');
    await act(async () => renderer.unmount());
  });

  it('sublabel row is omitted entirely when there is nothing to report', async () => {
    const renderer = await render(
      <AnalysisProgressBar progress={null} label="Reading player movement" />,
    );
    const rendered = textOf(renderer);
    expect(rendered).toContain('Reading player movement');
    expect(rendered).not.toContain('%');
    expect(rendered).not.toContain('s left');
    await act(async () => renderer.unmount());
  });
});
