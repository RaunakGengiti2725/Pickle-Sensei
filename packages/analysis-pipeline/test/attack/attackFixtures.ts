import type { AnalysisRecord } from "@pickle/swing-domain";
import type { SpeedSample } from "../../src/sessionEngine.js";

/**
 * Shared fixtures for the adversarial suite (pass 3, tester #2). Everything
 * here is deterministic: the PRNG is a seeded mulberry32 so every run of a
 * given scenario replays byte-identical input (seed recorded per test).
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Synthetic wrist-speed stream: 30 Hz (33.333 ms) samples, a gaussian stroke
 * bump every `strokeEveryMs`, low baseline plus optional seeded jitter.
 */
export function syntheticStream(options: {
  durationMs: number;
  hz?: number;
  strokeEveryMs?: number;
  firstStrokeMs?: number;
  height?: number;
  halfWidthMs?: number;
  baseline?: number;
  jitter?: number;
  seed?: number;
}): SpeedSample[] {
  const hz = options.hz ?? 30;
  const stepMs = 1000 / hz;
  const strokeEveryMs = options.strokeEveryMs ?? 3000;
  const firstStrokeMs = options.firstStrokeMs ?? 1500;
  const height = options.height ?? 2.0;
  const halfWidthMs = options.halfWidthMs ?? 120;
  const baseline = options.baseline ?? 0.08;
  const jitter = options.jitter ?? 0;
  const rng = mulberry32(options.seed ?? 1);
  const out: SpeedSample[] = [];
  const count = Math.floor(options.durationMs / stepMs);
  for (let index = 0; index < count; index += 1) {
    const t = index * stepMs;
    // Nearest stroke centre to t (strokes are periodic).
    const k = Math.round((t - firstStrokeMs) / strokeEveryMs);
    const centre = firstStrokeMs + k * strokeEveryMs;
    let value = baseline + height * Math.exp(-0.5 * ((t - centre) / halfWidthMs) ** 2);
    if (jitter > 0) value += (rng() - 0.5) * 2 * jitter;
    out.push({ timestampMs: t, value: Math.max(0, value) });
  }
  return out;
}

/** Bounds-only view of an emitted event, for cross-feed equality checks. */
export function boundsOf(event: {
  eventId: string;
  proposal: { startMs: number; peakMs: number; endMs: number };
}): { eventId: string; startMs: number; peakMs: number; endMs: number } {
  return {
    eventId: event.eventId,
    startMs: event.proposal.startMs,
    peakMs: event.proposal.peakMs,
    endMs: event.proposal.endMs,
  };
}

export const fakeAnalysis = { id: "attack-synthetic-analysis" } as unknown as AnalysisRecord;
