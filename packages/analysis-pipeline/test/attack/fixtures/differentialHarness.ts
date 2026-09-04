/**
 * Differential harness: drives the candidate SessionEventEngine (bounded
 * reconciliation window) and the 4d812e1a full-history engine through the
 * SAME seeded scenario and returns both observable traces — everything a
 * caller of the public API can see: push() return values, activeProposal(),
 * snapshot().events and snapshot().qualityState.
 *
 * Scenarios are generated from a seeded LCG so every failure is replayable
 * from its seed alone (no fixture files).
 */
import { SessionEventEngine as CandidateEngine } from "../../../src/sessionEngine.js";
import { SessionEventEngine as BaselineEngine } from "./sessionEngineBaseline4d812e1a.js";

export interface Sample {
  timestampMs: number;
  value: number;
}

export function lcg(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface Scenario {
  seed: number;
  fps: number;
  durationMs: number;
  strokes: Array<{ atMs: number; amp: number; widthMs: number }>;
  noise: number;
  baseline: number;
  paddle: boolean;
  paddleDropout: number;
  batchSize: number;
  shuffleWithinBatch: boolean;
  /** Every N-th push loses its last wrist sample to a push `lateDelay` later. */
  lateEvery: number;
  lateDelay: number;
  activeProposalEvery: number;
  flush: boolean;
  gapMs: number;
}

export function makeScenario(seed: number, overrides: Partial<Scenario> = {}): Scenario {
  const r = lcg(seed);
  const fps = [30, 60, 24, 120][Math.floor(r() * 4)]!;
  const durationMs = 8_000 + Math.floor(r() * 50_000);
  const strokes: Scenario["strokes"] = [];
  let t = 500 + r() * 1500;
  const periodBase = 700 + r() * 4000;
  while (t < durationMs - 500) {
    const kind = r();
    const amp = kind < 0.2 ? 0.3 + r() * 0.3 : kind < 0.35 ? 0.5 + r() * 1.0 : 1.5 + r() * 6.5;
    strokes.push({ atMs: t, amp, widthMs: 60 + r() * 200 });
    t += periodBase * (0.5 + r()) + (r() < 0.1 ? 3000 + r() * 6000 : 0);
  }
  const base: Scenario = {
    seed,
    fps,
    durationMs,
    strokes,
    noise: r() * 0.25,
    baseline: r() * 0.3,
    paddle: r() < 0.5,
    paddleDropout: r() * 0.6,
    batchSize: [1, 1, 1, 2, 5, 17][Math.floor(r() * 6)]!,
    shuffleWithinBatch: r() < 0.3,
    lateEvery: r() < 0.3 ? 5 + Math.floor(r() * 40) : 0,
    lateDelay: 1 + Math.floor(r() * 30),
    activeProposalEvery: r() < 0.3 ? 1 + Math.floor(r() * 20) : 0,
    flush: r() < 0.7,
    gapMs: r() < 0.2 ? 1000 + r() * 4000 : 0,
  };
  return { ...base, ...overrides };
}

export function generateStreams(sc: Scenario): { wrist: Sample[]; paddle: Sample[] } {
  const r = lcg(sc.seed ^ 0x9e3779b9);
  const n = Math.floor((sc.durationMs / 1000) * sc.fps);
  const wrist: Sample[] = [];
  const paddle: Sample[] = [];
  const gapStart = sc.gapMs > 0 ? sc.durationMs * 0.4 : -1;
  for (let i = 0; i < n; i += 1) {
    const t = (i * 1000) / sc.fps;
    if (gapStart >= 0 && t > gapStart && t < gapStart + sc.gapMs) continue;
    let v = sc.baseline + sc.noise * r();
    let pv = sc.baseline * 0.8 + sc.noise * 1.2 * r();
    for (const s of sc.strokes) {
      const d = t - s.atMs;
      if (Math.abs(d) < 4 * s.widthMs) {
        const g = Math.exp(-(d * d) / (2 * s.widthMs * s.widthMs));
        v += s.amp * g;
        pv += s.amp * 1.4 * Math.exp(-((d - 30) * (d - 30)) / (2 * s.widthMs * s.widthMs));
      }
    }
    wrist.push({ timestampMs: t, value: v });
    if (sc.paddle && r() >= sc.paddleDropout) paddle.push({ timestampMs: t, value: pv });
  }
  return { wrist, paddle };
}

export interface EngineLike {
  push(input: { wrist?: readonly Sample[]; paddle?: readonly Sample[] }): unknown[];
  flush(): unknown[];
  activeProposal(): unknown;
  snapshot(): { events: unknown[]; qualityState: { notes: string[]; droppedLateSamples: number } };
}

export interface Trace {
  returned: unknown[];
  active: unknown[];
  events: unknown[];
  qualityState: { notes: string[]; droppedLateSamples: number };
}

export function drive(
  engine: EngineLike,
  sc: Scenario,
  streams: { wrist: Sample[]; paddle: Sample[] },
): Trace {
  const r = lcg(sc.seed ^ 0x51ed270b);
  const pushes: Array<{ wrist: Sample[]; paddle: Sample[] }> = [];
  let pi = 0;
  for (let i = 0; i < streams.wrist.length; i += sc.batchSize) {
    const batch = streams.wrist.slice(i, i + sc.batchSize);
    const paddleBatch: Sample[] = [];
    const lastT = batch[batch.length - 1]!.timestampMs;
    while (pi < streams.paddle.length && streams.paddle[pi]!.timestampMs <= lastT) {
      paddleBatch.push(streams.paddle[pi]!);
      pi += 1;
    }
    pushes.push({ wrist: batch, paddle: paddleBatch });
  }
  if (sc.lateEvery > 0) {
    for (let k = 0; k < pushes.length; k += 1) {
      const p = pushes[k]!;
      if (k % sc.lateEvery === 0 && p.wrist.length > 0) {
        const moved = p.wrist.pop()!;
        const target = Math.min(pushes.length - 1, k + sc.lateDelay);
        pushes[target]!.wrist.push(moved);
      }
    }
  }
  if (sc.shuffleWithinBatch) {
    for (const p of pushes) {
      for (let i = p.wrist.length - 1; i > 0; i -= 1) {
        const j = Math.floor(r() * (i + 1));
        [p.wrist[i], p.wrist[j]] = [p.wrist[j]!, p.wrist[i]!];
      }
    }
  }
  const returned: unknown[] = [];
  const active: unknown[] = [];
  pushes.forEach((p, k) => {
    const out = engine.push(
      p.paddle.length ? { wrist: p.wrist, paddle: p.paddle } : { wrist: p.wrist },
    );
    if (out.length) returned.push({ k, out });
    if (sc.activeProposalEvery > 0 && k % sc.activeProposalEvery === 0) {
      active.push(engine.activeProposal());
    }
  });
  if (sc.flush) returned.push({ k: "flush", out: engine.flush() });
  const snap = engine.snapshot();
  return { returned, active, events: snap.events, qualityState: snap.qualityState };
}

export function newBaseline(): EngineLike {
  return new BaselineEngine({ sessionId: "attack" }) as unknown as EngineLike;
}

export function newCandidate(): EngineLike {
  return new CandidateEngine({ sessionId: "attack" }) as unknown as EngineLike;
}

export interface Comparison {
  scenario: Scenario;
  samples: number;
  baseline: Trace;
  candidate: Trace;
  equal: boolean;
  eventsEqual: boolean;
  returnedEqual: boolean;
  qualityEqual: boolean;
  activeEqual: boolean;
}

export function compareSeed(seed: number, overrides: Partial<Scenario> = {}): Comparison {
  const scenario = makeScenario(seed, overrides);
  const streams = generateStreams(scenario);
  const baseline = drive(newBaseline(), scenario, streams);
  const candidate = drive(newCandidate(), scenario, streams);
  const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return {
    scenario,
    samples: streams.wrist.length,
    baseline,
    candidate,
    equal: eq(baseline, candidate),
    eventsEqual: eq(baseline.events, candidate.events),
    returnedEqual: eq(baseline.returned, candidate.returned),
    qualityEqual: eq(baseline.qualityState, candidate.qualityState),
    activeEqual: eq(baseline.active, candidate.active),
  };
}

/** Feed the same scripted pushes to a fresh baseline and candidate engine. */
export function runBoth(feed: (engine: EngineLike) => void): {
  baseline: ReturnType<EngineLike["snapshot"]>;
  candidate: ReturnType<EngineLike["snapshot"]>;
} {
  const a = newBaseline();
  const b = newCandidate();
  feed(a);
  feed(b);
  return { baseline: a.snapshot(), candidate: b.snapshot() };
}
