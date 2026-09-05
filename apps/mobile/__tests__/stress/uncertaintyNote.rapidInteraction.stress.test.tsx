import React from 'react';
import TestRenderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import type { StrokeIntentEnvelope } from '@pickle/analysis-pipeline';
import type { PhaseKey, PhaseSpan, ShotAnalysis } from '@pickle/shared-types';
import type { ContactEstimate } from '@pickle/vision-geometry';
import {
  UNCERTAINTY_COPY,
  UNCERTAINTY_KINDS,
  UncertaintyNotes,
  uncertaintyNotes,
  type UncertaintyKind,
} from '../../src/components/UncertaintyNote';
import {
  analysisContactMs,
  contactMarkerPresentation,
  effectivePhaseTimeline,
  type StrokeResultEvidenceRecord,
  type TemporalPhasesV2,
} from '../../src/components/strokeResultModel';
import {
  NoiseRecorder,
  SeededRng,
  campaignConfig,
  describe as describeValue,
  flushMicrotasks,
  iterationSeeds,
  summarise,
  writeTable,
  type ScenarioOutcome,
} from '../../test-support/stress/rapidInteraction';

/**
 * STRESS LENS `rapid-interaction` — UncertaintyNotes.
 *
 * The block has no controls of its own; on the Result surface it re-renders
 * every time the evidence record / analysis props churn (detail screen
 * hydration, replay-card refresh, navigation back-and-forth). Each seed
 * builds a burst of 3–12 random evidence shapes (null, partial, abstained,
 * malformed: NaN spans, out-of-order phases, unknown envelope verdicts) and
 * drives them through `UncertaintyNotes` both as same-tick storms (several
 * `update()` calls inside one act) and as separate commits, then checks:
 *
 *   U1 pure            uncertaintyNotes(x) is deterministic and never throws
 *   U2 fixed-order     kinds are unique and in UNCERTAINTY_KINDS order
 *   U3 same-gate       each note is present iff the Result surface's own
 *                      gate withheld the element it explains
 *                      (contactMarkerPresentation / effectivePhaseTimeline /
 *                      overallScore / captureEnvelope.overall)
 *   U4 honest-render   the rendered tree carries exactly one note node per
 *                      selected kind, with the exact copy, in order; nothing
 *                      when clean
 *   U5 last-write-wins after a same-tick storm the tree reflects the LAST
 *                      input only (no stale/duplicated notes)
 *   U6 quiet           no console.error/warn (duplicate keys, act()),
 *                      no unhandled rejections
 *
 * Replays: STRESS_SEEDS=<seed[,seed]> STRESS_ITER=<n> STRESS_OUT=<json path>.
 */

const KIND_INDEX: Record<UncertaintyKind, number> = Object.fromEntries(
  UNCERTAINTY_KINDS.map((kind, index) => [kind, index]),
) as Record<UncertaintyKind, number>;

// ─── seeded evidence generator ──────────────────────────────────────────────

const PHASE_ORDER: PhaseKey[] = [
  'ready',
  'prepare',
  'accelerate',
  'contact',
  'follow_through',
  'recover',
];

function garbageNumber(rng: SeededRng): number {
  return rng.pick([Number.NaN, Infinity, -Infinity, -1, 0]);
}

function phaseSpans(rng: SeededRng): PhaseSpan[] {
  const shape = rng.weighted({
    none: 15,
    single: 10,
    clean: 40,
    reversed: 10,
    overlapping: 10,
    garbage: 10,
    duplicateKey: 5,
  });
  if (shape === 'none') return [];
  const spans: PhaseSpan[] = [];
  let cursor = 2000;
  const keys: PhaseKey[] =
    shape === 'single' ? ['contact'] : PHASE_ORDER.slice(rng.int(0, 2));
  for (const key of keys) {
    const length = rng.int(20, 200);
    const startMs = cursor;
    const endMs = cursor + length;
    spans.push({
      key,
      startMs,
      endMs,
      representativeMs:
        key === 'contact' && rng.chance(0.2)
          ? garbageNumber(rng)
          : startMs + length / 2,
      confidence: rng.float(),
    });
    cursor = endMs + (rng.chance(0.3) ? 0 : rng.int(1, 40));
  }
  if (shape === 'reversed') spans.reverse();
  const first = spans[0];
  const second = spans[1];
  if (shape === 'overlapping' && first && second) {
    spans[1] = { ...second, startMs: first.startMs - 5 };
  }
  if (shape === 'garbage' && spans.length >= 1) {
    const index = rng.int(0, spans.length - 1);
    const victim = spans[index];
    if (victim) {
      spans[index] = {
        ...victim,
        [rng.pick(['startMs', 'endMs'] as const)]: garbageNumber(rng),
      };
    }
  }
  if (shape === 'duplicateKey' && first && second) {
    spans.push({ ...first, startMs: cursor, endMs: cursor + 10 });
  }
  return spans;
}

function analysis(rng: SeededRng): ShotAnalysis | null {
  if (rng.chance(0.2)) return null;
  const scored = rng.chance(0.6);
  const contactMs = rng.weighted({ null: 40, finite: 45, garbage: 15 });
  return {
    id: `analysis-${rng.int(1, 1_000_000)}`,
    sessionId: null,
    shotType: 'forehand_drive',
    cameraView: 'side',
    handedness: 'right',
    capturedAtIso: '2026-08-30T10:00:00.000Z',
    timestamps: {
      startMs: 2000,
      contactMs:
        contactMs === 'null'
          ? null
          : contactMs === 'finite'
            ? 2000 + rng.int(0, 700)
            : garbageNumber(rng),
      endMs: 2700,
    },
    phases: phaseSpans(rng),
    measurements: [],
    checkpoints: [],
    overallScore: scored ? Math.round(rng.float() * 100) / 10 : null,
    analysisConfidence: rng.float(),
    resultKind: scored ? 'scored' : 'unscored',
    guidance: null,
    priorityFix: null,
    versionVector: {
      appVersion: '0.1.0',
      modelBundleVersion: 'on-device-fusion-1',
      poseModelVersion: 'apple-vision-bodypose-1',
      paddleModelVersion: 'none',
      strokeDetectorVersion: 'temporal-stroke-heuristic-2',
      phaseModelVersion: 'phase-heuristic-1',
      scoringModelVersion: 'scoring-1',
      shotConfigVersion: 'config-1',
    },
    source: 'real',
  } as ShotAnalysis;
}

function contact(rng: SeededRng): ContactEstimate | null | undefined {
  const shape = rng.weighted({
    undefined: 20,
    null: 20,
    abstained: 15,
    confirmed: 15,
    weak: 15,
    strongUnconfirmed: 10,
    garbageMs: 5,
  });
  switch (shape) {
    case 'undefined':
      return undefined;
    case 'null':
      return null;
    case 'abstained':
      return {
        status: 'abstained',
        reason: rng.pick(['no_temporal_consensus', 'no_paddle_track']),
      } as ContactEstimate;
    default: {
      const ballConfirmed = shape === 'confirmed' && rng.chance(0.7);
      const paddleConfirmed = shape === 'confirmed' && !ballConfirmed;
      return {
        status: 'estimated',
        estimatedContactMs: shape === 'garbageMs' ? garbageNumber(rng) : 2400,
        confidence:
          shape === 'weak' ? rng.float() * 0.3 : 0.7 + rng.float() * 0.3,
        ballConfirmed,
        paddleConfirmed,
        limitingFactors: [],
        supportingEvidence: [],
      } as ContactEstimate;
    }
  }
}

function temporalPhases(rng: SeededRng): TemporalPhasesV2 | null | undefined {
  const shape = rng.weighted({
    undefined: 30,
    null: 15,
    abstained: 20,
    segmented: 25,
    malformed: 10,
  });
  if (shape === 'undefined') return undefined;
  if (shape === 'null') return null;
  if (shape === 'abstained') {
    return { status: 'abstained', reason: 'no_paddle_track' };
  }
  const contactMs = shape === 'malformed' ? garbageNumber(rng) : 2400;
  return {
    status: 'segmented',
    boundaries: {
      version: 'phase.paddle-temporal.v2 (heuristic, uncalibrated)',
      source: 'paddle',
      anchor: 'contact_estimate',
      confidence: rng.float(),
      preparationStartMs: 2050,
      accelerationStartMs:
        shape === 'malformed' && rng.chance(0.5) ? 2500 : 2200,
      contactMs,
      followThroughEndMs: 2600,
      recoveryEndMs: 2680,
    },
  } as TemporalPhasesV2;
}

function strokeIntent(rng: SeededRng): StrokeIntentEnvelope | null | undefined {
  const shape = rng.weighted({
    undefined: 25,
    null: 15,
    declared: 30,
    abstained: 20,
    predicted: 10,
  });
  if (shape === 'undefined') return undefined;
  if (shape === 'null') return null;
  return {
    declaredStroke: shape === 'declared' ? 'forehand_drive' : null,
    predictedStroke: null,
    resolutionBasis:
      shape === 'declared'
        ? 'declared'
        : shape === 'abstained'
          ? 'abstained'
          : 'predicted_family',
    resolvedProfileId: shape === 'abstained' ? null : 'FOREHAND_DRIVE',
    resolvedProfileVersion:
      shape === 'abstained' ? null : 'technique-profile-v1',
    disagreement: null,
  } as StrokeIntentEnvelope;
}

function captureEnvelope(
  rng: SeededRng,
): StrokeResultEvidenceRecord['captureEnvelope'] {
  const shape = rng.weighted({
    undefined: 30,
    null: 10,
    SUPPORTED: 20,
    DEGRADED: 15,
    UNSUPPORTED: 15,
    unknownToken: 10,
  });
  if (shape === 'undefined') return undefined;
  if (shape === 'null') return null;
  return {
    thresholdsVersion: 'envelope-thresholds-v0',
    provisional: true,
    dimensions: [],
    overall: (shape === 'unknownToken' ? 'NOT_MEASURED' : shape) as never,
    overallWithCoverage: 'SUPPORTED_UNMEASURED',
    notMeasured: [],
  };
}

interface EvidenceInput {
  record: StrokeResultEvidenceRecord | null;
  analysis: ShotAnalysis | null;
}

function evidence(rng: SeededRng): EvidenceInput {
  if (rng.chance(0.1)) return { record: null, analysis: analysis(rng) };
  const record: StrokeResultEvidenceRecord = {
    id: `record-${rng.int(1, 1_000_000)}`,
    strokeIntent: strokeIntent(rng),
    result: rng.chance(0.5) ? analysis(rng) : undefined,
    contact: contact(rng),
    temporalPhasesV2: temporalPhases(rng),
    captureEnvelope: captureEnvelope(rng),
  };
  return { record, analysis: rng.chance(0.6) ? analysis(rng) : null };
}

function shortLabel(input: EvidenceInput): string {
  const record = input.record;
  if (!record) return `record=null analysis=${input.analysis ? 'yes' : 'null'}`;
  const parts = [
    `contact=${record.contact === undefined ? 'undef' : record.contact === null ? 'null' : record.contact.status}`,
    `intent=${record.strokeIntent?.resolutionBasis ?? 'none'}`,
    `phasesV2=${record.temporalPhasesV2?.status ?? 'none'}`,
    `env=${record.captureEnvelope?.overall ?? 'none'}`,
    `result=${record.result ? `score:${String(record.result.overallScore)}` : 'none'}`,
    `analysis=${input.analysis ? `score:${String(input.analysis.overallScore)},phases:${input.analysis.phases.length}` : 'null'}`,
  ];
  return parts.join(' ');
}

// ─── oracle: the Result surface's own gates ─────────────────────────────────

function expectedKinds(input: EvidenceInput): UncertaintyKind[] {
  const record = input.record;
  if (!record) return [];
  const effective = input.analysis ?? record.result ?? null;
  const kinds: UncertaintyKind[] = [];
  if (contactMarkerPresentation(record.contact).kind === 'not_established') {
    const wristPeak =
      (record.contact ?? null) === null &&
      analysisContactMs(effective) !== null;
    kinds.push(wristPeak ? 'contact_estimate' : 'contact');
  }
  if (record.strokeIntent?.resolutionBasis === 'abstained') {
    kinds.push('stroke_identity');
  }
  if (effectivePhaseTimeline(record, effective).kind === 'none') {
    kinds.push('phase_timing');
  }
  if (!effective || effective.overallScore === null) {
    kinds.push('technique_score');
  }
  const overall = record.captureEnvelope?.overall;
  if (
    kinds.length > 0 &&
    (overall === 'DEGRADED' || overall === 'UNSUPPORTED')
  ) {
    kinds.push('capture_quality');
  }
  return kinds;
}

// ─── rendered-tree inspection ───────────────────────────────────────────────

function renderedNotes(renderer: ReactTestRenderer): string[] {
  const json = renderer.toJSON();
  if (json === null) return [];
  const notes: string[] = [];
  const walk = (node: unknown) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    const element = node as {
      props?: Record<string, unknown>;
      children?: unknown[] | null;
    };
    if (element.props?.accessibilityLabel === 'Uncertainty note') {
      const text: string[] = [];
      const collect = (child: unknown) => {
        if (typeof child === 'string') text.push(child);
        else if (Array.isArray(child)) child.forEach(collect);
        else if (child && typeof child === 'object') {
          (child as { children?: unknown[] | null }).children?.forEach(collect);
        }
      };
      element.children?.forEach(collect);
      notes.push(text.join(''));
      return;
    }
    element.children?.forEach(walk);
  };
  walk(json);
  return notes;
}

// ─── scenario driver ────────────────────────────────────────────────────────

type Op =
  | { kind: 'commit'; input: EvidenceInput }
  | { kind: 'storm'; inputs: EvidenceInput[] }
  | { kind: 'unmount' }
  | { kind: 'remount'; input: EvidenceInput };

function generateScript(rng: SeededRng): Op[] {
  const length = rng.int(3, 12);
  const ops: Op[] = [];
  for (let i = 0; i < length; i += 1) {
    const kind = rng.weighted({
      commit: 50,
      storm: 30,
      unmount: 10,
      remount: 10,
    });
    switch (kind) {
      case 'commit':
        ops.push({ kind: 'commit', input: evidence(rng) });
        break;
      case 'storm': {
        const inputs: EvidenceInput[] = [];
        const count = rng.int(2, 6);
        for (let j = 0; j < count; j += 1) inputs.push(evidence(rng));
        ops.push({ kind: 'storm', inputs });
        break;
      }
      case 'unmount':
        ops.push({ kind: 'unmount' });
        break;
      case 'remount':
        ops.push({ kind: 'remount', input: evidence(rng) });
        break;
    }
  }
  return ops;
}

function opLabel(op: Op): string {
  switch (op.kind) {
    case 'commit':
      return `commit(${shortLabel(op.input)})`;
    case 'storm':
      return `storm[${op.inputs.length}](${op.inputs.map(shortLabel).join(' | ')})`;
    case 'remount':
      return `remount(${shortLabel(op.input)})`;
    default:
      return op.kind;
  }
}

async function runScenario(seed: number): Promise<ScenarioOutcome> {
  const rng = new SeededRng(seed);
  const script = generateScript(rng);
  const violations: Record<string, string> = {};
  const counters = {
    inputsEvaluated: 0,
    commits: 0,
    storms: 0,
    stormInputs: 0,
    notesRendered: 0,
    remounts: 0,
    consoleErrors: 0,
    consoleWarnings: 0,
    unhandledRejections: 0,
  };
  const violate = (id: string, message: string) => {
    if (!(id in violations)) violations[id] = message;
  };
  const noise = new NoiseRecorder();
  let renderer = null as ReactTestRenderer | null;
  let threw: string | null = null;
  let current: EvidenceInput | null = null;

  const checkSelector = (input: EvidenceInput, where: string) => {
    counters.inputsEvaluated += 1;
    let first: ReturnType<typeof uncertaintyNotes>;
    try {
      first = uncertaintyNotes(input);
    } catch (error) {
      violate(
        'U1_pure',
        `${where}: uncertaintyNotes threw ${describeValue(error)}`,
      );
      return null;
    }
    const second = uncertaintyNotes(input);
    if (JSON.stringify(first) !== JSON.stringify(second)) {
      violate('U1_pure', `${where}: two evaluations differ`);
    }
    const kinds = first.map(note => note.kind);
    for (let i = 1; i < kinds.length; i += 1) {
      const previous = kinds[i - 1];
      const next = kinds[i];
      if (!previous || !next || KIND_INDEX[next] <= KIND_INDEX[previous]) {
        violate('U2_fixed_order', `${where}: kinds ${kinds.join(',')}`);
        break;
      }
    }
    for (const note of first) {
      if (note.text !== UNCERTAINTY_COPY[note.kind]) {
        violate(
          'U4_honest_render',
          `${where}: text for ${note.kind} is not the canonical copy`,
        );
      }
    }
    const expected = expectedKinds(input);
    if (JSON.stringify(kinds) !== JSON.stringify(expected)) {
      violate(
        'U3_same_gate',
        `${where}: notes ${JSON.stringify(kinds)} vs surface gates ${JSON.stringify(expected)}`,
      );
    }
    return first;
  };

  const checkTree = (where: string) => {
    if (!renderer || !current) return;
    const expected = uncertaintyNotes(current).map(note => note.text);
    const rendered = renderedNotes(renderer);
    counters.notesRendered += rendered.length;
    if (JSON.stringify(rendered) !== JSON.stringify(expected)) {
      violate(
        'U5_last_write_wins',
        `${where}: rendered ${rendered.length} note(s) ${JSON.stringify(rendered.map(t => t.slice(0, 24)))} but last input selects ${expected.length} ${JSON.stringify(expected.map(t => t.slice(0, 24)))}`,
      );
    }
    if (expected.length === 0 && renderer.toJSON() !== null) {
      violate(
        'U4_honest_render',
        `${where}: clean evidence still rendered a block`,
      );
    }
  };

  const mount = async (input: EvidenceInput) => {
    current = input;
    await act(async () => {
      renderer = TestRenderer.create(
        <UncertaintyNotes record={input.record} analysis={input.analysis} />,
      );
      await flushMicrotasks();
    });
  };
  const unmount = async () => {
    if (!renderer) return;
    const r = renderer;
    renderer = null;
    await act(async () => {
      r.unmount();
      await flushMicrotasks();
    });
  };

  noise.start();
  try {
    const initial = evidence(rng);
    checkSelector(initial, 'initial');
    await mount(initial);
    checkTree('after mount');
    for (const op of script) {
      const where = `after ${op.kind}`;
      switch (op.kind) {
        case 'commit':
          checkSelector(op.input, where);
          counters.commits += 1;
          if (renderer) {
            const r = renderer;
            current = op.input;
            await act(async () => {
              r.update(
                <UncertaintyNotes
                  record={op.input.record}
                  analysis={op.input.analysis}
                />,
              );
              await flushMicrotasks();
            });
          }
          checkTree(where);
          break;
        case 'storm':
          counters.storms += 1;
          counters.stormInputs += op.inputs.length;
          op.inputs.forEach((input, index) =>
            checkSelector(input, `${where}[${index}]`),
          );
          if (renderer) {
            const r = renderer;
            current = op.inputs[op.inputs.length - 1] ?? null;
            await act(async () => {
              for (const input of op.inputs) {
                r.update(
                  <UncertaintyNotes
                    record={input.record}
                    analysis={input.analysis}
                  />,
                );
              }
              await flushMicrotasks();
            });
          }
          checkTree(where);
          break;
        case 'unmount':
          await unmount();
          break;
        case 'remount':
          counters.remounts += 1;
          checkSelector(op.input, where);
          await unmount();
          await mount(op.input);
          checkTree(where);
          break;
      }
    }
    await unmount();
  } catch (error) {
    threw = describeValue(error);
    try {
      await unmount();
    } catch {
      // already torn down
    }
  } finally {
    noise.stop();
  }
  if (noise.consoleErrors.length) {
    violate('U6_quiet', `console.error: ${noise.consoleErrors[0]}`);
  }
  if (noise.consoleWarnings.length) {
    violate('U6_quiet', `console.warn: ${noise.consoleWarnings[0]}`);
  }
  if (noise.unhandledRejections.length) {
    violate('U6_quiet', `unhandledRejection: ${noise.unhandledRejections[0]}`);
  }
  counters.consoleErrors = noise.consoleErrors.length;
  counters.consoleWarnings = noise.consoleWarnings.length;
  counters.unhandledRejections = noise.unhandledRejections.length;
  return { seed, script: script.map(opLabel), violations, counters, threw };
}

describe('UncertaintyNotes — rapid-interaction stress', () => {
  const config = campaignConfig({ iterations: 40, baseSeed: 0x5eed0003 });
  const seeds = iterationSeeds(config);
  const rows: ScenarioOutcome[] = [];

  afterAll(() => {
    writeTable(config, summarise('UncertaintyNotes', config, rows));
  });

  it.each(seeds.map(seed => [seed]))(
    'seed %d: pure selector, surface-gate parity, last-write-wins render, quiet',
    async seed => {
      const row = await runScenario(seed);
      rows.push(row);
      expect(row.threw).toBeNull();
      expect(row.violations).toEqual({});
    },
  );

  it('copy never carries a percentage, superlative or excluded platform term', () => {
    const banned =
      /\d+\s?%|Android|Google Play|guest mode|Live Court|DUPR|SwingVision|PB Vision|Selkirk|JOOLA|\bbest\b|most accurate/i;
    for (const kind of UNCERTAINTY_KINDS) {
      expect(UNCERTAINTY_COPY[kind]).not.toMatch(banned);
    }
  });

  it('harness sensitivity: renderedNotes tells a stale tree from the last input', async () => {
    // Renders a block for one input, then compares it against a different
    // input's expectation with the same renderedNotes/uncertaintyNotes pair
    // the U5 check relies on — the pair must see the difference.
    const clean: EvidenceInput = { record: null, analysis: null };
    const dirty: EvidenceInput = {
      record: {
        id: 'r',
        strokeIntent: { resolutionBasis: 'abstained' } as never,
      },
      analysis: null,
    };
    let renderer = null as ReactTestRenderer | null;
    await act(async () => {
      renderer = TestRenderer.create(
        <UncertaintyNotes record={dirty.record} analysis={dirty.analysis} />,
      );
    });
    const rendered = renderedNotes(renderer as ReactTestRenderer);
    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toEqual(
      uncertaintyNotes(clean).map(note => note.text),
    );
    await act(async () => {
      renderer?.unmount();
    });
  });
});
