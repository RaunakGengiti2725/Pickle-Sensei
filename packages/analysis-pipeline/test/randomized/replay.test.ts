/**
 * Replay ONE randomized-pipeline-D row and dump the exact generated input plus
 * every surface's output — the replay handle for any finding in
 * randomizedPipelineD.test.ts.
 *
 *   RANDOMIZED_D_REPLAY="<seed>:<perturbation>[:<param>]" \
 *   RANDOMIZED_D_OUT=<dir> pnpm --filter @pickle/analysis-pipeline exec vitest run test/randomized/replay
 *
 * perturbation ∈ clean | ladder:<level> | position:<level> | dropout:<p> |
 *                jitter:<frameFraction> | reorder:<swaps>
 *
 * Without RANDOMIZED_D_REPLAY this file is a no-op (skipped, and reported as
 * skipped — it is a tool, not a check).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { PoseSequence } from "@pickle/swing-domain";
import {
  NOISE_LADDER,
  POSITION_ONLY_LADDER,
  applyFrameDropout,
  applyFrameReordering,
  applyNoise,
  applyTimingJitter,
  isStrictlyMonotone,
  noiseField,
  runCapture,
  runClassifier,
  runSegmenter,
  scenarioForSeed,
  synthesize,
} from "./harness.js";

const REPLAY = process.env["RANDOMIZED_D_REPLAY"] ?? null;
const OUT_DIR = process.env["RANDOMIZED_D_OUT"] ?? null;

interface ReplaySpec {
  seed: number;
  perturbation: string;
  param: string | null;
}

function parseSpec(raw: string): ReplaySpec {
  const [seedText, perturbation, param] = raw.split(":");
  const seed = Number(seedText);
  if (!Number.isInteger(seed) || perturbation === undefined || perturbation.length === 0) {
    throw new Error(`RANDOMIZED_D_REPLAY must be "<seed>:<perturbation>[:<param>]", got "${raw}"`);
  }
  return { seed, perturbation, param: param ?? null };
}

function perturb(
  spec: ReplaySpec,
  sequence: PoseSequence,
): { sequence: PoseSequence; detail: Record<string, unknown> } {
  const param = spec.param === null ? Number.NaN : Number(spec.param);
  switch (spec.perturbation) {
    case "clean":
      return { sequence, detail: {} };
    case "ladder": {
      const level = NOISE_LADDER.find((rung) => rung.level === param);
      if (!level) throw new Error(`unknown ladder level ${spec.param}`);
      return {
        sequence: applyNoise(sequence, noiseField(spec.seed, sequence), level),
        detail: { level },
      };
    }
    case "position": {
      const level = POSITION_ONLY_LADDER.find((rung) => rung.level === param);
      if (!level) throw new Error(`unknown position-only level ${spec.param}`);
      return {
        sequence: applyNoise(sequence, noiseField(spec.seed, sequence), level),
        detail: { level },
      };
    }
    case "dropout":
      return { sequence: applyFrameDropout(sequence, spec.seed, param), detail: { p: param } };
    case "jitter": {
      const fps = scenarioForSeed(spec.seed).truth.fps ?? 60;
      const jitterMs = Number((param * (1000 / fps)).toFixed(3));
      return {
        sequence: applyTimingJitter(sequence, spec.seed, jitterMs),
        detail: { frameFraction: param, jitterMs },
      };
    }
    case "reorder": {
      const reordered = applyFrameReordering(sequence, spec.seed, param);
      return {
        sequence: reordered.sequence,
        detail: { swaps: param, swappedIndices: reordered.swappedIndices },
      };
    }
    default:
      throw new Error(`unknown perturbation "${spec.perturbation}"`);
  }
}

describe("randomized-pipeline-D — replay one row", () => {
  it.skipIf(REPLAY === null)(
    "dumps the generated input and every surface output for RANDOMIZED_D_REPLAY",
    async () => {
      if (REPLAY === null) return;
      const spec = parseSpec(REPLAY);
      const scenario = scenarioForSeed(spec.seed);
      const { sequence, window } = synthesize(scenario);
      const perturbed = perturb(spec, sequence);
      const id = `replay-${spec.seed}-${spec.perturbation}-${spec.param ?? ""}`;
      const payload = {
        spec,
        scenario,
        window,
        perturbation: perturbed.detail,
        inputIsStrictlyMonotone: isStrictlyMonotone(perturbed.sequence),
        frames: perturbed.sequence.frames.length,
        segmenter: await runSegmenter(perturbed.sequence, window),
        classifier: runClassifier(perturbed.sequence, window, scenario.handedness),
        declared: await runCapture(
          perturbed.sequence,
          window,
          scenario.handedness,
          scenario.declared,
          `${id}-decl`,
        ),
        auto: await runCapture(perturbed.sequence, window, scenario.handedness, null, `${id}-auto`),
        input: perturbed.sequence,
      };
      const json = JSON.stringify(payload, null, 2);
      if (OUT_DIR) {
        mkdirSync(OUT_DIR, { recursive: true });
        const file = join(OUT_DIR, `${id}.json`);
        writeFileSync(file, json);
        process.stdout.write(`replay written: ${file}\n`);
      } else {
        process.stdout.write(`${json}\n`);
      }
      expect(payload.frames).toBeGreaterThan(0);
    },
  );
});
