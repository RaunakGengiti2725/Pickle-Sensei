/**
 * mod-capture / concurrency — `src/camera/captureEnvelope.ts` under seeded
 * interleavings.
 *
 * Scenario `evidence_buffer_two_actors`: one shared AttemptEvidenceBuffer
 * (the screen owns exactly one) driven by two capture-attempt actors whose
 * readiness / quality notes and `beginAttempt()` calls are interleaved by
 * the seeded scheduler across async hops, with a reference model tracking
 * "last note since the most recent beginAttempt". Invariants: the buffer
 * never holds evidence from before the current attempt began (no stale
 * carry-over), the latest note always wins (no lost update), the live
 * envelope is null exactly when nothing has been measured, and readyGate
 * blocks only on UNSUPPORTED.
 *
 * Scenario `odd_fps_aspect_burst`: Promise.all bursts of attempt /
 * session-event envelope evaluations over odd fps (0, 7.5, 23.976 … 1000),
 * odd aspects (1×1, 4096×1, 7680×4320 …) and odd durations. Invariants:
 * pure + idempotent (burst results equal a sequential re-evaluation of the
 * same inputs, byte for byte), never throws, 13 dimensions, supplied
 * dimensions are measured, sessionEventClipEnvelope leaves clip_duration
 * NOT_MEASURED, guidance lines exist exactly for measured non-SUPPORTED
 * dimensions in canonical order, qualityBlockedMessage is idempotent.
 *
 * Replay: STRESS_SEED=<seed> npx jest --ci __tests__/stress/captureEnvelopeConcurrency.stress.test.ts
 */
import { ENVELOPE_DIMENSIONS } from '@pickle/shared-types';
import type { CaptureQualitySignalsV1 } from '../../src/camera/capture';
import {
  attemptCaptureEnvelope,
  captureGuidanceLines,
  createAttemptEvidenceBuffer,
  liveCaptureEnvelope,
  qualityBlockedMessage,
  readyGate,
  sessionEventClipEnvelope,
  type ReadinessSnapshot,
} from '../../src/camera/captureEnvelope';
import {
  ODD_ASPECT,
  ODD_DURATION_MS,
  ODD_FPS,
  qualitySignals,
  READINESS_STATES,
} from '../../testing/stress/captureFixtures';
import {
  describeFailures,
  flushMicrotasks,
  pick,
  randomInt,
  runCampaign,
  SeededScheduler,
  stableJson,
  type IterationResult,
  type Rng,
} from '../../testing/stress/harness';

const SUITE = 'captureEnvelopeConcurrency';

type BufferAction =
  | { kind: 'begin'; actor: number }
  | { kind: 'readiness'; actor: number; value: ReadinessSnapshot }
  | { kind: 'quality'; actor: number; value: CaptureQualitySignalsV1 }
  | { kind: 'observe'; actor: number };

async function evidenceBufferIteration(
  _seed: number,
  random: Rng,
): Promise<IterationResult> {
  const violations: string[] = [];
  const scheduler = new SeededScheduler(random);
  const buffer = createAttemptEvidenceBuffer();

  // Reference model: what the buffer must hold after each applied action.
  let modelReadiness: ReadinessSnapshot | null = null;
  let modelQuality: CaptureQualitySignalsV1 | null = null;
  let attempt = 0;
  let notesSinceBegin = 0;
  const applied: string[] = [];

  const actorCount = 2;
  const actionsPerActor = randomInt(random, 3, 12);
  const plans: BufferAction[][] = [];
  for (let actor = 0; actor < actorCount; actor += 1) {
    const plan: BufferAction[] = [];
    for (let i = 0; i < actionsPerActor; i += 1) {
      const roll = random();
      if (roll < 0.2) plan.push({ kind: 'begin', actor });
      else if (roll < 0.55) {
        plan.push({
          kind: 'readiness',
          actor,
          value: {
            state: pick(random, READINESS_STATES),
            jointCoverage: random(),
          },
        });
      } else if (roll < 0.85) {
        plan.push({ kind: 'quality', actor, value: qualitySignals(random) });
      } else plan.push({ kind: 'observe', actor });
    }
    plans.push(plan);
  }

  const check = (where: string): void => {
    if (stableJson(buffer.readiness) !== stableJson(modelReadiness)) {
      violations.push(
        `${where}: readiness ${stableJson(buffer.readiness)} != model ${stableJson(modelReadiness)}`,
      );
    }
    if (stableJson(buffer.quality) !== stableJson(modelQuality)) {
      violations.push(`${where}: quality diverged from model`);
    }
    const live = liveCaptureEnvelope(buffer.readiness, buffer.quality);
    const nothingMeasured =
      buffer.readiness === null && buffer.quality === null;
    if ((live === null) !== nothingMeasured) {
      violations.push(
        `${where}: liveCaptureEnvelope null=${live === null} but nothingMeasured=${nothingMeasured}`,
      );
    }
    if (live) {
      if (live.dimensions.length !== 13) {
        violations.push(`${where}: ${live.dimensions.length} dimensions`);
      }
      const gate = readyGate(live);
      const unsupported = live.dimensions
        .filter(d => d.status === 'UNSUPPORTED')
        .map(d => d.dimension);
      if (
        gate.blocked !== unsupported.length > 0 ||
        stableJson(gate.blockingDimensions) !== stableJson(unsupported)
      ) {
        violations.push(`${where}: readyGate disagrees with UNSUPPORTED set`);
      }
      // Readiness-only evidence: quality dimensions must stay NOT_MEASURED.
      if (buffer.quality === null) {
        const measuredQuality = live.dimensions.filter(
          d =>
            [
              'resolution',
              'frame_rate',
              'brightness',
              'motion_blur',
              'camera_motion',
            ].includes(d.dimension) && d.status !== 'NOT_MEASURED',
        );
        if (measuredQuality.length > 0) {
          violations.push(
            `${where}: quality dimension measured without quality evidence: ${measuredQuality.map(d => d.dimension).join(',')}`,
          );
        }
      }
    }
  };

  // Each actor runs its plan across async hops the scheduler releases in a
  // seed-chosen order, so notes/begins from the two attempts interleave.
  const actorRuns = plans.map(async (plan, actor) => {
    for (const action of plan) {
      await scheduler.hold(`actor${actor}`, () => null);
      switch (action.kind) {
        case 'begin':
          buffer.beginAttempt();
          modelReadiness = null;
          modelQuality = null;
          attempt += 1;
          notesSinceBegin = 0;
          applied.push(`a${actor}:begin`);
          break;
        case 'readiness':
          buffer.noteReadiness(action.value);
          modelReadiness = action.value;
          notesSinceBegin += 1;
          applied.push(`a${actor}:readiness`);
          break;
        case 'quality':
          buffer.noteQuality(action.value);
          modelQuality = action.value;
          notesSinceBegin += 1;
          applied.push(`a${actor}:quality`);
          break;
        case 'observe':
          applied.push(`a${actor}:observe`);
          break;
      }
      check(`after ${applied[applied.length - 1]}`);
    }
  });

  await flushMicrotasks();
  await scheduler.drain();
  await Promise.all(actorRuns);

  // Stale carry-over probe: a fresh beginAttempt must leave nothing behind
  // regardless of how many notes the interleaving produced.
  buffer.beginAttempt();
  if (buffer.readiness !== null || buffer.quality !== null) {
    violations.push('beginAttempt left evidence behind');
  }
  if (liveCaptureEnvelope(buffer.readiness, buffer.quality) !== null) {
    violations.push(
      'liveCaptureEnvelope fabricated a verdict after beginAttempt',
    );
  }

  return {
    detail: {
      actionsPerActor,
      applied,
      attempts: attempt,
      notesInLastAttempt: notesSinceBegin,
      settleOrder: scheduler.settledOrder,
    },
    violations,
  };
}

interface EnvelopeInput {
  index: number;
  kind: 'attempt' | 'session';
  clip: { width: number; height: number; fps: number; durationMs: number };
  quality: CaptureQualitySignalsV1 | null;
  readiness: ReadinessSnapshot | null;
}

function evaluate(input: EnvelopeInput) {
  return input.kind === 'attempt'
    ? attemptCaptureEnvelope(input.clip, input.quality, input.readiness)
    : sessionEventClipEnvelope(input.clip);
}

async function oddGeometryIteration(
  _seed: number,
  random: Rng,
): Promise<IterationResult> {
  const violations: string[] = [];
  const burst = randomInt(random, 4, 24);
  const inputs: EnvelopeInput[] = [];
  for (let i = 0; i < burst; i += 1) {
    const [width, height] = pick(random, ODD_ASPECT);
    inputs.push({
      index: i,
      kind: random() < 0.6 ? 'attempt' : 'session',
      clip: {
        width,
        height,
        fps: pick(random, ODD_FPS),
        durationMs: pick(random, ODD_DURATION_MS),
      },
      quality: random() < 0.3 ? null : qualitySignals(random),
      readiness:
        random() < 0.3
          ? null
          : { state: pick(random, READINESS_STATES), jointCoverage: random() },
    });
  }

  // Concurrent burst: every evaluation hops through the scheduler first so
  // they complete in a seed-chosen order, then are compared to sequential.
  const scheduler = new SeededScheduler(random);
  const burstResults = Promise.all(
    inputs.map(async input => {
      await scheduler.hold(`eval#${input.index}`, () => null);
      try {
        return { ok: true as const, verdict: evaluate(input) };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  await flushMicrotasks();
  await scheduler.drain();
  const results = await burstResults;

  results.forEach((result, i) => {
    const input = inputs[i] as EnvelopeInput;
    const at = `input#${i}(${input.kind} ${input.clip.width}x${input.clip.height}@${input.clip.fps}fps ${input.clip.durationMs}ms)`;
    if (!result.ok) {
      violations.push(`${at} threw: ${result.error}`);
      return;
    }
    const verdict = result.verdict;
    const sequential = evaluate(input);
    if (stableJson(sequential) !== stableJson(verdict)) {
      violations.push(`${at} burst result != sequential result`);
    }
    if (verdict.dimensions.length !== 13) {
      violations.push(`${at} ${verdict.dimensions.length} dimensions`);
    }
    const byDim = new Map<string, string>(
      verdict.dimensions.map(d => [d.dimension, d.status]),
    );
    for (const dim of ['resolution', 'frame_rate']) {
      if (byDim.get(dim) === 'NOT_MEASURED') {
        violations.push(`${at} ${dim} NOT_MEASURED despite a supplied value`);
      }
    }
    if (
      input.kind === 'attempt' &&
      byDim.get('clip_duration') === 'NOT_MEASURED'
    ) {
      violations.push(
        `${at} clip_duration NOT_MEASURED despite a supplied value`,
      );
    }
    if (
      input.kind === 'session' &&
      byDim.get('clip_duration') !== 'NOT_MEASURED'
    ) {
      violations.push(`${at} session clip judged clip_duration`);
    }
    const lines = captureGuidanceLines(verdict);
    const wantDims = ENVELOPE_DIMENSIONS.filter(d => {
      const status = byDim.get(d);
      return status === 'DEGRADED' || status === 'UNSUPPORTED';
    });
    if (stableJson(lines.map(l => l.dimension)) !== stableJson(wantDims)) {
      violations.push(
        `${at} guidance lines != measured non-SUPPORTED dimensions`,
      );
    }
    if (lines.some(l => l.text.length === 0)) {
      violations.push(`${at} empty guidance text`);
    }
    const message = qualityBlockedMessage('Analysis withheld.', verdict);
    if (message !== qualityBlockedMessage('Analysis withheld.', verdict)) {
      violations.push(`${at} qualityBlockedMessage not idempotent`);
    }
    if (lines.length === 0 && message !== 'Analysis withheld.') {
      violations.push(`${at} guidance appended without lines`);
    }
    if (lines.length > 0 && !message.startsWith('Analysis withheld.\n\n• ')) {
      violations.push(`${at} blocked message format`);
    }
    const gate = readyGate(verdict);
    const unsupported = verdict.dimensions.filter(
      d => d.status === 'UNSUPPORTED',
    );
    if (gate.blocked !== unsupported.length > 0) {
      violations.push(`${at} readyGate blocked mismatch`);
    }
  });

  return {
    detail: {
      burst,
      inputs: inputs.map(i => ({ ...i.clip, kind: i.kind })),
      settleOrder: scheduler.settledOrder,
      blocked: results.filter(r => r.ok && readyGate(r.verdict).blocked).length,
    },
    violations,
  };
}

describe('mod-capture concurrency stress — capture envelope', () => {
  it('evidence_buffer_two_actors: interleaved attempts never leak or lose evidence', async () => {
    const table = await runCampaign(
      SUITE,
      'evidence_buffer_two_actors',
      evidenceBufferIteration,
    );
    expect(table.iterations).toBeGreaterThan(0);
    expect(describeFailures(table)).toBe('');
    expect(table.failingSeeds).toEqual([]);
  });

  it('odd_fps_aspect_burst: concurrent envelope evaluation is pure and honest', async () => {
    const table = await runCampaign(
      SUITE,
      'odd_fps_aspect_burst',
      oddGeometryIteration,
    );
    expect(table.iterations).toBeGreaterThan(0);
    expect(describeFailures(table)).toBe('');
    expect(table.failingSeeds).toEqual([]);
  });
});
