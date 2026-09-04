/**
 * ATTACK PROBE (not a gate): differential run of the 4d812e1a full-series
 * engine vs the 28402cb7 bounded-retention engine over seeded synthetic
 * sessions. Prints a classification of every divergence so the coordinator
 * can judge which are the documented floor-windowing changes and which are
 * not. Writes $ATTACK_OUT/differential.json when ATTACK_OUT is set; ATTACK_SEEDS
 * (default 8) controls how many seeded sessions run (the baseline engine is
 * quadratic, so 40 seeds × 240 s take ~7 min). The baseline fixture
 * ./sessionEngine.baseline4d812e1a.ts is a byte-identical copy of
 * `git show 4d812e1a:packages/analysis-pipeline/src/sessionEngine.ts`.
 *
 * Measured on 28402cb7 vs 4d812e1a (40 seeds × 240 s at 30 fps, mixed
 * dinks/drives/smashes): missing_on_candidate 0, bounds_differ 0 — the fix
 * never drops or re-bounds a baseline event. It does EMIT MORE: +223 events
 * over 928 baseline (+24 %), all with peakSpeed 0.49–2.05 u/s, i.e. strokes
 * under the session-global 30 % floor but above the windowed one (the change
 * the fix documents as "windowed rather than session-global"); 105 of those
 * are later flagged SESSION_EVENT_RETRO_SUPPRESSED by the candidate itself.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SessionEventEngine as Baseline } from "./sessionEngine.baseline4d812e1a.js";
import {
  SessionEventEngine as Candidate,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../src/sessionEngine.js";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Stroke {
  peakMs: number;
  height: number;
  halfWidthMs: number;
}

/** Random rally: strokes of random height with random gaps (incl. idle
 * stretches), gaussian bumps on a jittery idle baseline. */
function randomSession(
  seed: number,
  durationMs: number,
  stepMs: number,
): {
  wrist: SpeedSample[];
  strokes: Stroke[];
} {
  const rng = mulberry32(seed);
  const strokes: Stroke[] = [];
  let t = 1000 + rng() * 2000;
  while (t < durationMs - 2000) {
    const r = rng();
    // heights: 40% dinks (0.4–1.2), 40% drives (1.2–3.5), 20% smashes (3.5–7)
    const height = r < 0.4 ? 0.4 + rng() * 0.8 : r < 0.8 ? 1.2 + rng() * 2.3 : 3.5 + rng() * 3.5;
    strokes.push({ peakMs: Math.round(t), height, halfWidthMs: 80 + rng() * 100 });
    const g = rng();
    // gaps: 70% rally cadence 0.8–3.5 s, 20% point break 3.5–12 s, 10% idle 12–40 s
    t += g < 0.7 ? 800 + rng() * 2700 : g < 0.9 ? 3500 + rng() * 8500 : 12_000 + rng() * 28_000;
  }
  const wrist: SpeedSample[] = [];
  for (let ts = 0; ts <= durationMs; ts += stepMs) {
    let value = 0.05 + rng() * 0.06;
    for (const s of strokes) {
      const d = ts - s.peakMs;
      if (Math.abs(d) < 4 * s.halfWidthMs)
        value += s.height * Math.exp(-0.5 * (d / s.halfWidthMs) ** 2);
    }
    wrist.push({ timestampMs: ts, value: Number(value.toFixed(4)) });
  }
  return { wrist, strokes };
}

interface Divergence {
  seed: number;
  kind:
    | "added_on_candidate"
    | "missing_on_candidate"
    | "bounds_differ"
    | "field_differ"
    | "notes_differ";
  detail: string;
}

describe("[attack] differential: 4d812e1a full-series vs 28402cb7 bounded retention", () => {
  it("classifies every divergence across seeded random sessions", () => {
    const divergences: Divergence[] = [];
    const summary: Array<{
      seed: number;
      baselineEvents: number;
      candidateEvents: number;
      added: number;
      missing: number;
      boundsDiffer: number;
      fieldDiffer: number;
      maxRetained: number;
      samples: number;
      baselineRetroNotes: number;
      candidateRetroNotes: number;
      candidateOnlyRetro: number;
    }> = [];
    const seeds = Number(process.env.ATTACK_SEEDS ?? 8);
    for (let seed = 1; seed <= seeds; seed += 1) {
      const { wrist } = randomSession(0x5eed_1000 + seed, 240_000, 33);
      const base = new Baseline({ sessionId: `b-${seed}` });
      const cand = new Candidate({ sessionId: `c-${seed}` });
      const baseEvents: SessionStrokeEvent[] = [];
      const candEvents: SessionStrokeEvent[] = [];
      let maxRetained = 0;
      for (const s of wrist) {
        baseEvents.push(...base.pushWristSample(s));
        candEvents.push(...cand.pushWristSample(s));
        maxRetained = Math.max(maxRetained, cand.retainedWristSampleCount());
      }
      baseEvents.push(...base.flush());
      candEvents.push(...cand.flush());

      const key = (e: SessionStrokeEvent) => Math.round(e.proposal.peakMs);
      const baseByPeak = new Map(baseEvents.map((e) => [key(e), e]));
      const candByPeak = new Map(candEvents.map((e) => [key(e), e]));
      let added = 0;
      let missing = 0;
      let boundsDiffer = 0;
      let fieldDiffer = 0;
      for (const [k, ce] of candByPeak) {
        const be = baseByPeak.get(k);
        if (!be) {
          added += 1;
          divergences.push({
            seed,
            kind: "added_on_candidate",
            detail: `peak ${k}ms speed ${ce.proposal.peakSpeed.toFixed(2)} [${ce.proposal.startMs},${ce.proposal.endMs}] ${ce.closeReason} lowAmp=${String(ce.proposal.lowAmplitude ?? false)}`,
          });
          continue;
        }
        if (
          be.proposal.startMs !== ce.proposal.startMs ||
          be.proposal.endMs !== ce.proposal.endMs
        ) {
          boundsDiffer += 1;
          divergences.push({
            seed,
            kind: "bounds_differ",
            detail: `peak ${k}ms base [${be.proposal.startMs},${be.proposal.endMs}] cand [${ce.proposal.startMs},${ce.proposal.endMs}]`,
          });
        }
        if (
          be.closeReason !== ce.closeReason ||
          be.closedAtMs !== ce.closedAtMs ||
          Math.abs(be.proposal.prominence - ce.proposal.prominence) > 1e-9 ||
          Math.abs(be.proposal.confidence - ce.proposal.confidence) > 1e-9 ||
          be.proposal.lowAmplitude !== ce.proposal.lowAmplitude
        ) {
          fieldDiffer += 1;
          divergences.push({
            seed,
            kind: "field_differ",
            detail: `peak ${k}ms base {${be.closeReason}@${be.closedAtMs} prom ${be.proposal.prominence.toFixed(3)} conf ${be.proposal.confidence.toFixed(3)} low=${String(be.proposal.lowAmplitude ?? false)}} cand {${ce.closeReason}@${ce.closedAtMs} prom ${ce.proposal.prominence.toFixed(3)} conf ${ce.proposal.confidence.toFixed(3)} low=${String(ce.proposal.lowAmplitude ?? false)}}`,
          });
        }
      }
      for (const k of baseByPeak.keys()) {
        if (!candByPeak.has(k)) {
          missing += 1;
          const be = baseByPeak.get(k)!;
          divergences.push({
            seed,
            kind: "missing_on_candidate",
            detail: `peak ${k}ms speed ${be.proposal.peakSpeed.toFixed(2)} [${be.proposal.startMs},${be.proposal.endMs}] ${be.closeReason}`,
          });
        }
      }
      const retro = (notes: string[]) =>
        notes
          .filter((n) => n.includes("SESSION_EVENT_RETRO_SUPPRESSED"))
          .map((n) => n.split(" ")[1]!);
      const bRetro = retro(base.snapshot().qualityState.notes);
      const cRetro = retro(cand.snapshot().qualityState.notes);
      // Map candidate retro ids to peaks, check the baseline flagged the same physical event.
      const cRetroPeaks = cRetro.map((id) => key(candEvents.find((e) => e.eventId === id)!));
      const bRetroPeaks = new Set(
        bRetro.map((id) => key(baseEvents.find((e) => e.eventId === id)!)),
      );
      const candidateOnlyRetro = cRetroPeaks.filter((p) => !bRetroPeaks.has(p));
      if (candidateOnlyRetro.length > 0) {
        divergences.push({
          seed,
          kind: "notes_differ",
          detail: `candidate flags RETRO_SUPPRESSED at peaks ${candidateOnlyRetro.join(",")} which baseline does not`,
        });
      }
      summary.push({
        seed,
        baselineEvents: baseEvents.length,
        candidateEvents: candEvents.length,
        added,
        missing,
        boundsDiffer,
        fieldDiffer,
        maxRetained,
        samples: wrist.length,
        baselineRetroNotes: bRetro.length,
        candidateRetroNotes: cRetro.length,
        candidateOnlyRetro: candidateOnlyRetro.length,
      });
    }
    const counts = divergences.reduce<Record<string, number>>((acc, d) => {
      acc[d.kind] = (acc[d.kind] ?? 0) + 1;
      return acc;
    }, {});
    console.log(JSON.stringify({ counts, summary }, null, 1));
    for (const d of divergences.slice(0, 80)) console.log(`${d.kind} seed=${d.seed} ${d.detail}`);
    if (process.env.ATTACK_OUT) {
      mkdirSync(process.env.ATTACK_OUT, { recursive: true });
      writeFileSync(
        `${process.env.ATTACK_OUT}/differential.json`,
        JSON.stringify({ counts, summary, divergences }, null, 2),
      );
    }
    expect(summary.length).toBe(seeds);
    // The fix's own invariants (sessionEngine.ts BOUNDED RETENTION note):
    // pruning never removes or re-bounds an event the full series emits.
    expect(counts["missing_on_candidate"] ?? 0).toBe(0);
    expect(counts["bounds_differ"] ?? 0).toBe(0);
  }, 900_000);
});
