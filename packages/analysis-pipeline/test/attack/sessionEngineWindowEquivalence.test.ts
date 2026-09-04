/**
 * ADVERSARIAL: the bounded-window SessionEventEngine (candidate for
 * xc-performance::XCP-1, e4e45826) claims to be event-equivalent to the
 * full-history engine at 4d812e1a. These tests drive both engines through
 * identical public-API call sequences and assert the observable traces are
 * identical. Each failing case is a concrete counter-example.
 *
 * Oracle: test/attack/fixtures/sessionEngineBaseline4d812e1a.ts (verbatim
 * copy of src/sessionEngine.ts at 4d812e1a).
 */
import { describe, expect, it } from "vitest";
import {
  compareSeed,
  runBoth,
  type EngineLike,
  type Sample,
} from "./fixtures/differentialHarness.js";

const FPS = 30;

describe("bounded-window SessionEventEngine vs 4d812e1a full-history engine", () => {
  it("still closes a stroke whose frames arrive late but AFTER the emission frontier (background/foreground burst)", () => {
    // 16 s of quiet wrist speed at 30 fps. The frames of one stroke
    // (3000..4500 ms) are delayed and delivered in one push once the live
    // stream has reached 12 s. No event has been emitted, so the frontier is
    // still -Infinity: per the engine contract only samples AT/BEFORE the
    // frontier are late. The full-history engine closes the stroke; the
    // bounded window silently drops all 45 frames.
    const { baseline, candidate } = runBoth((engine: EngineLike) => {
      for (let i = 0; i < 12 * FPS; i += 1) {
        const t = (i * 1000) / FPS;
        if (t >= 3000 && t <= 4500) continue;
        engine.push({ wrist: [{ timestampMs: t, value: 0.1 }] });
      }
      const late: Sample[] = [];
      for (let t = 3000; t <= 4500; t += 1000 / FPS) {
        const d = t - 3700;
        late.push({ timestampMs: t, value: 0.1 + 4 * Math.exp(-(d * d) / (2 * 120 * 120)) });
      }
      engine.push({ wrist: late });
      for (let i = 12 * FPS; i < 16 * FPS; i += 1) {
        engine.push({ wrist: [{ timestampMs: (i * 1000) / FPS, value: 0.1 }] });
      }
      engine.flush();
    });
    expect(baseline.events).toHaveLength(1);
    expect(baseline.qualityState.droppedLateSamples).toBe(0);
    expect(candidate.qualityState.droppedLateSamples).toBe(0);
    expect(candidate.events).toEqual(baseline.events);
  });

  it("records SESSION_EVENT_RETRO_SUPPRESSED notes in the same (event) order as the full-history engine", () => {
    // Two equal paddle-sourced strokes (3 s, 9 s) while the wrist is flat,
    // then a wrist stroke at 15 s that raises the relative floor and
    // retro-suppresses both. Baseline notes are in event order (E1, E2);
    // the candidate's retro queue is peak-sorted and emits E2 before E1.
    const { baseline, candidate } = runBoth((engine: EngineLike) => {
      for (let i = 0; i < 20 * FPS; i += 1) {
        const t = (i * 1000) / FPS;
        const d1 = t - 3000;
        const d2 = t - 9000;
        const pv =
          0.1 +
          3 * Math.exp(-(d1 * d1) / (2 * 100 * 100)) +
          3 * Math.exp(-(d2 * d2) / (2 * 100 * 100));
        const d3 = t - 15000;
        const wv = t < 12000 ? 0.05 : 0.1 + 3.5 * Math.exp(-(d3 * d3) / (2 * 100 * 100));
        engine.push({
          wrist: [{ timestampMs: t, value: wv }],
          paddle: [{ timestampMs: t, value: pv }],
        });
      }
      engine.flush();
    });
    expect(baseline.qualityState.notes).toHaveLength(2);
    expect(candidate.qualityState.notes).toEqual(baseline.qualityState.notes);
  });

  it("activeProposal() reports the same provisional eventId as the full-history engine (seed 11)", () => {
    const c = compareSeed(11);
    expect(c.eventsEqual).toBe(true);
    expect(c.candidate.active).toEqual(c.baseline.active);
  });

  it("qualityState.droppedLateSamples matches the full-history engine (seed 233: a post-frontier sample is dropped)", () => {
    const c = compareSeed(233);
    expect(c.eventsEqual).toBe(true);
    expect(c.candidate.qualityState.droppedLateSamples).toBe(
      c.baseline.qualityState.droppedLateSamples,
    );
  });

  it("differential fuzz: identical public traces over 60 seeded sessions (ordering, batching, late frames, gaps, paddle dropout, 24-120 fps)", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 60; seed += 1) {
      const c = compareSeed(seed);
      if (c.equal) continue;
      failures.push(
        `seed=${seed} events=${c.eventsEqual} returned=${c.returnedEqual} quality=${c.qualityEqual} ` +
          `active=${c.activeEqual} fps=${c.scenario.fps} batch=${c.scenario.batchSize} ` +
          `late=${c.scenario.lateEvery}/${c.scenario.lateDelay} paddle=${c.scenario.paddle}`,
      );
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
