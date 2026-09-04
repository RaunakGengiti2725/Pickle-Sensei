import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { PoseSequence } from "@pickle/swing-domain";
import {
  SEEDS,
  applyTimingJitter,
  runCapture,
  runClassifier,
  scenarioForSeed,
  synthesize,
} from "./harness.js";

/**
 * Adversarial pins against the XCF-08/09/10 fix (471c05b7) on the
 * AUTO-DETECT route (classifyStroke with contactMs=null, eventPeakMs=peak —
 * the exact call analyzeCapture and apps/mobile providers.ts make).
 *
 * Every input here is a CLEAN synthetic forehand (zero keypoint noise, no
 * landmark dropout, no frame dropout) or a stream whose sampling around the
 * event is uniform. Numbers in comments are Linux replay-proxy measurements
 * of base 4d812e1a vs candidate 471c05b7 on the same harness.
 */

const OUT = process.env.RANDOMIZED_D_OUT ?? null;
function dump(name: string, value: unknown): void {
  if (OUT === null) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, JSON.stringify(value, null, 2));
}

describe("[ATTACK 471c05b7] clean-input recall on the AUTO-DETECT route", () => {
  it("clean synthetic forehands (seeds 4000-4099, no perturbation): the classifier commits FOREHAND on at least 90/100 — base commits 94/100 with 0 mirrored", () => {
    const rows: Array<{ seed: number; label: string; limitingFactors: readonly string[] }> = [];
    let committed = 0;
    let mirrored = 0;
    const abstainReasons: Record<string, number> = {};
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      const { sequence, window } = synthesize(scenario);
      const out = runClassifier(sequence, window, scenario.handedness);
      rows.push({ seed, label: out.label, limitingFactors: out.limitingFactors });
      if (out.label === "FOREHAND") committed += 1;
      if (out.label === "BACKHAND") mirrored += 1;
      if (out.label === "UNKNOWN") {
        const reason = out.limitingFactors[out.limitingFactors.length - 1] ?? "?";
        abstainReasons[reason] = (abstainReasons[reason] ?? 0) + 1;
      }
    }
    dump("attack_clean_recall.json", { committed, mirrored, abstainReasons, rows });
    expect(mirrored).toBe(0);
    // Candidate: 56/100 (30 side_margin_within_no_contact_evidence_abstention_band,
    // 10 side_not_stable_across_neighbouring_frames, 4 contact_too_close_to_midline).
    expect(committed, JSON.stringify(abstainReasons)).toBeGreaterThanOrEqual(90);
  });

  it("clean synthetic forehands through analyzeCapture AUTO: at least 90/100 captures are scored — base scores 94/100", async () => {
    const outcomes: Record<string, number> = {};
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      const { sequence, window } = synthesize(scenario);
      const capture = await runCapture(
        sequence,
        window,
        scenario.handedness,
        null,
        `attack-auto-${seed}`,
      );
      outcomes[capture.outcome] = (outcomes[capture.outcome] ?? 0) + 1;
    }
    dump("attack_clean_auto_capture.json", outcomes);
    // Candidate: { scored: 56, no_result: 44 }.
    expect(outcomes["scored"] ?? 0, JSON.stringify(outcomes)).toBeGreaterThanOrEqual(90);
  });
});

describe("[ATTACK 471c05b7] sampling gate (gate 14) false positives on fully sampled event windows", () => {
  it("frame rate halving mid-clip (60 fps → 30 fps before the event): the event window is uniformly sampled at 30 fps and must not be judged sparse", () => {
    let sparse = 0;
    let committed = 0;
    let n = 0;
    const examples: unknown[] = [];
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      if (scenario.truth.fps !== 60) continue;
      const { sequence, window } = synthesize(scenario);
      const mid = Math.floor(sequence.frames.length / 2);
      const midMs = sequence.frames[mid]?.timestampMs ?? 0;
      if (window.peakMs <= midMs + 2 * (1000 / 30)) continue; // event must sit well inside the 30 fps half
      n += 1;
      // Keep every frame before the midpoint (60 fps), every other frame after
      // it (30 fps). Nothing around the event is missing relative to a 30 fps
      // capture of the same swing.
      const frames = sequence.frames.filter((_, index) => index < mid || index % 2 === 0);
      const seq: PoseSequence = { ...sequence, frames };
      const out = runClassifier(seq, window, scenario.handedness);
      if (out.limitingFactors.includes("sampling.sparse_event_window")) {
        sparse += 1;
        if (examples.length < 3) examples.push({ seed, out });
      }
      if (out.label === "FOREHAND") committed += 1;
    }
    dump("attack_fps_switch.json", { n, sparse, committed, examples });
    expect(n).toBeGreaterThan(20);
    // Candidate: sparse 44 / committed 1 of 45. Base: committed 43 of 45.
    expect(sparse, JSON.stringify(examples[0] ?? null)).toBe(0);
  });

  it("uniform stream with ±0.3-frame monotone timestamp jitter (no frame dropped) never abstains with sampling.sparse_event_window", () => {
    let sparse = 0;
    const examples: unknown[] = [];
    for (const seed of SEEDS) {
      const scenario = scenarioForSeed(seed);
      const { sequence, window } = synthesize(scenario);
      const interval = 1000 / (scenario.truth.fps ?? 30);
      for (const jitterFrac of [0.3, 0.4]) {
        const jittered = applyTimingJitter(sequence, seed, jitterFrac * interval);
        const out = runClassifier(jittered, window, scenario.handedness);
        if (out.limitingFactors.includes("sampling.sparse_event_window")) {
          sparse += 1;
          if (examples.length < 3) examples.push({ seed, jitterFrac, out });
        }
      }
    }
    dump("attack_jitter_phantom_gap.json", { sparse, examples });
    // Candidate: dozens of clean, fully sampled swings abstain as "sparse"
    // once per-frame jitter exceeds 0.25 frame (label flips vs clean:
    // 14 @0.3, 45 @0.4, 58 @0.49; base 2 / 1 / 4).
    expect(sparse, JSON.stringify(examples[0] ?? null)).toBe(0);
  });
});
