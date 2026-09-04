import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GeometricPhaseSegmenter } from "@pickle/vision-geometry";
import { toLegacyPoseFrames } from "@pickle/swing-domain";
import type { PhaseSpan } from "@pickle/shared-types";
import { REPO_ROOT } from "./engine/corpus.js";
import { dominantWristSpeeds } from "./engine/minerCore.js";
import { overlapOfGold } from "./eventFailureOracle.js";
import { segmentPhasesTemporalV2 } from "./phaseTemporal.js";
import {
  buildPlayerTracks,
  targetPoseSequence,
  type PeopleFile,
  type PlayerTrack,
} from "./playerTracker.js";
import { SessionEventEngine } from "./sessionEngine.js";
import { proposeStrokeEventsV2, type StrokeEventProposalV2 } from "./strokeEvents.js";
import type { StrokeEventLabel } from "./annotationSchema.js";

/**
 * XC-CV-TEMPORAL-SEGMENTATION — fps-sensitivity harness for stroke
 * segmentation against the COMMITTED wave-a gold (read-only, Linux replay
 * proxy; NOT Apple device truth).
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/fpsTemporalSegmentation.ts --out <dir>
 *
 * WHAT IS MEASURED (every number is a per-case count on a tiny corpus — 8
 * windowed runDirs, 10 target-owner gold events, 8 phase timelines):
 *
 *  1. EVENT BOUNDS  — proposeStrokeEventsV2 (stroke-event-2, the production
 *     proposer mirrored byte-for-byte into the mobile SessionEventEngine) on
 *     the auto-target wrist-speed series derived from the committed pose,
 *     scored against the wave-a eventLabels: matched (overlap > 0.3 of gold),
 *     PROPOSED_OK (overlap ≥ 0.5 OR gold contact inside ±60ms — the D06/E13
 *     criterion), |start|/|end| error, |proposal peak − gold contact|.
 *  2. STREAMING PARITY — the same wrist series fed one sample at a time
 *     through SessionEventEngine (the shipped session-mode segmenter) must
 *     emit the same bounds as the batch proposer.
 *  3. PHASE TIMING — (a) segmentPhasesTemporalV2 (lab, anchored on gold
 *     contact and anchor-free) and (b) GeometricPhaseSegmenter (the mobile
 *     analyzeCapture phase provider, aspectRatio 1 as providers.ts builds it)
 *     against the committed `phases` block of each wave-a annotation, in ms.
 *     The GEOMETRIC segmenter is also run in its exact production
 *     composition — bounds + peak of the MATCHED PROPOSAL as the trigger
 *     (session.ts → runCaptureAnalysis → analyzeCapture) — so the composed
 *     contact estimate can be scored against gold contact.
 *
 * FPS VARIANTS. The committed pose is 59.94 / 29.97–30 / 24 fps. Each runDir
 * is replayed natively (reference) and re-sampled to 24, 30, 60 and 120 fps:
 *   - DECIMATION (target ≤ native): real frames nearest to a uniform grid;
 *     timestamps stay real. `phase` selects the grid offset in native frames
 *     (a 60→24 grid has 5 distinct offsets), so phase-sensitivity is
 *     measurable, not averaged away.
 *   - INTERPOLATION (target > native): landmarks linearly interpolated
 *     between bracketing real frames, persons associated by torso proximity.
 *     This is SYNTHETIC — it adds no information and can only measure the
 *     algorithm's sensitivity to sample density (frame-count gates,
 *     moving-average windows), never real 120 fps pose quality. Worse, any
 *     up-sampled interval that straddles a native frame averages two native
 *     velocities, so single-frame speed peaks are DILUTED (a 24→30 grid
 *     straddles 4 of every 5 intervals). Rows carry `synthetic: true`,
 *     the headline `decimationOnly` table excludes them, and their deltas
 *     must be read as "harness artefact + algorithm density sensitivity".
 * Adversarial perturbations (seeded, replayable): uniform timestamp jitter
 * ±j ms and Bernoulli frame drops, both applied AFTER resampling.
 *
 * Every variant is fully described by a `VariantSpec` recorded on each row;
 * `--replay '<json spec>'` re-runs exactly one variant.
 */

export const FPS_TEMPORAL_HARNESS_VERSION = "xc-cv-temporal-segmentation-1";
export const TARGET_FPS = [24, 30, 60, 120] as const;

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const CONTACT_INSIDE_TOL_MS = 60;
/** CONTACT_ACCEPT_MS from packages/evaluation/src/regression/benches.ts. */
const CONTACT_ACCEPT_MS = 132;
const MAX_INTERPOLATION_GAP_MS = 150;
const TORSO_ASSOC_RADIUS = 0.12;

// ─── Gold ───────────────────────────────────────────────────────────────────

export interface GoldPhases {
  preparationStartMs: number | null;
  accelerationStartMs: number | null;
  contactMs: number | null;
  followThroughEndMs: number | null;
  recoveryEndMs: number | null;
}

export interface GoldCase {
  bundle: string;
  runDir: string;
  windowMs: { from: number; to: number };
  nativeFps: number;
  events: StrokeEventLabel[];
  /** The committed `phases` block; belongs to the target event that contains
   * phases.contactMs (null when no target event contains it). */
  phases: GoldPhases | null;
  phaseEventIndex: number | null;
}

interface WaveAManifest {
  cases: Array<{
    id: string;
    labels: string;
    runDir: string;
    windowMs: { from: number; to: number };
    role: string;
  }>;
}

interface WaveAAnnotation {
  eventLabels?: StrokeEventLabel[];
  phases?: Partial<Record<keyof GoldPhases, number | null>>;
}

export function loadGoldCases(): GoldCase[] {
  const manifest = JSON.parse(
    readFileSync(join(PB, "event-bounds-wave-a.json"), "utf8"),
  ) as WaveAManifest;
  const cases: GoldCase[] = [];
  for (const entry of manifest.cases) {
    if (entry.role !== "development") continue;
    const peoplePath = join(PB, entry.runDir, "people.json");
    if (!existsSync(peoplePath)) continue;
    const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
    const annotation = JSON.parse(readFileSync(join(PB, entry.labels), "utf8")) as WaveAAnnotation;
    const events = annotation.eventLabels ?? [];
    let phases: GoldPhases | null = null;
    let phaseEventIndex: number | null = null;
    if (annotation.phases) {
      phases = {
        preparationStartMs: annotation.phases.preparationStartMs ?? null,
        accelerationStartMs: annotation.phases.accelerationStartMs ?? null,
        contactMs: annotation.phases.contactMs ?? null,
        followThroughEndMs: annotation.phases.followThroughEndMs ?? null,
        recoveryEndMs: annotation.phases.recoveryEndMs ?? null,
      };
      const contact = phases.contactMs;
      if (contact !== null) {
        const index = events.findIndex(
          (event) =>
            event.owner === "target" &&
            contact >= event.eventStartMs &&
            contact <= event.eventEndMs,
        );
        phaseEventIndex = index >= 0 ? index : null;
      }
    }
    cases.push({
      bundle: entry.id,
      runDir: entry.runDir,
      windowMs: entry.windowMs,
      nativeFps: people.video.fps,
      events,
      phases,
      phaseEventIndex,
    });
  }
  return cases;
}

export function loadPeople(runDir: string): PeopleFile {
  return JSON.parse(readFileSync(join(PB, runDir, "people.json"), "utf8")) as PeopleFile;
}

// ─── Deterministic PRNG (mulberry32) ────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── Resampling ─────────────────────────────────────────────────────────────

export interface VariantSpec {
  bundle: string;
  /** null = native (no resampling). */
  fps: number | null;
  /** Grid offset in native frames for decimation (ignored for interpolation). */
  phase: number;
  /** Uniform timestamp jitter amplitude in ms (0 = none). */
  jitterMs: number;
  /** Bernoulli frame-drop probability (0 = none). */
  dropRate: number;
  /** PRNG seed for jitter/drops. */
  seed: number;
}

export interface ResampleResult {
  file: PeopleFile;
  nativeFps: number;
  nativeIntervalMs: number;
  mode: "native" | "decimate" | "interpolate";
  synthetic: boolean;
  nativeFrames: number;
  outputFrames: number;
  interpolatedFrames: number;
  droppedFrames: number;
  /** Number of distinct decimation grid offsets for this fps (1 otherwise). */
  phaseCount: number;
}

function medianOf(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Mean frame interval (people.json timestamps are integer ms, so a 59.94
 * fps source alternates 16/17 — the median would say 17, the mean 16.68). */
function nativeInterval(frames: PeopleFile["frames"]): number {
  if (frames.length < 2) return 0;
  return (frames[frames.length - 1]!.t - frames[0]!.t) / (frames.length - 1);
}

/** Number of distinct decimation grid offsets, in native frames: the
 * smallest integer N = k·ratio (k ≤ 12, within 1%) after which the
 * native→grid alignment pattern repeats (60→30: 2, 60→24: 5, 30→24: 5).
 * Falls back to 12 offsets for irrational-looking ratios. */
export function decimationPhaseCount(ratio: number): number {
  for (let k = 1; k <= 12; k += 1) {
    const product = k * ratio;
    if (Math.abs(product - Math.round(product)) < 0.01 * Math.max(1, product)) {
      return Math.max(1, Math.round(product));
    }
  }
  return 12;
}

type Person = PeopleFile["frames"][number]["p"][number];

function torsoMid(person: Person): { x: number; y: number } | null {
  const ls = person.l.find((mark) => mark.n === "left_shoulder");
  const rs = person.l.find((mark) => mark.n === "right_shoulder");
  if (!ls || !rs) return null;
  return { x: (ls.x + rs.x) / 2, y: (ls.y + rs.y) / 2 };
}

function interpolatePersons(a: Person[], b: Person[], alpha: number): Person[] {
  const usedB = new Set<number>();
  const out: Person[] = [];
  for (const personA of a) {
    const midA = torsoMid(personA);
    if (!midA) continue;
    let best: { index: number; distance: number } | null = null;
    for (const [index, personB] of b.entries()) {
      if (usedB.has(index)) continue;
      const midB = torsoMid(personB);
      if (!midB) continue;
      const distance = Math.hypot(midA.x - midB.x, midA.y - midB.y);
      if (distance <= TORSO_ASSOC_RADIUS && (!best || distance < best.distance)) {
        best = { index, distance };
      }
    }
    if (!best) continue;
    usedB.add(best.index);
    const personB = b[best.index]!;
    const landmarks: Person["l"] = [];
    for (const markA of personA.l) {
      const markB = personB.l.find((mark) => mark.n === markA.n);
      if (!markB) continue;
      landmarks.push({
        n: markA.n,
        x: markA.x + (markB.x - markA.x) * alpha,
        y: markA.y + (markB.y - markA.y) * alpha,
        v: Math.min(markA.v, markB.v),
      });
    }
    out.push({ c: Math.min(personA.c, personB.c), l: landmarks });
  }
  return out;
}

export function resamplePeople(people: PeopleFile, spec: VariantSpec): ResampleResult {
  const frames = people.frames;
  const nativeFps = people.video.fps;
  const intervalMs = nativeInterval(frames);
  const first = frames[0];
  const last = frames[frames.length - 1];
  let output: PeopleFile["frames"];
  let mode: ResampleResult["mode"] = "native";
  let interpolatedFrames = 0;
  let phaseCount = 1;

  if (spec.fps === null || !first || !last || intervalMs <= 0) {
    output = frames.map((frame) => ({ t: frame.t, p: frame.p }));
  } else {
    const targetInterval = 1000 / spec.fps;
    const ratio = targetInterval / intervalMs;
    if (spec.fps <= nativeFps * 1.02) {
      mode = "decimate";
      phaseCount = decimationPhaseCount(ratio);
      const offsetFrame = frames[Math.min(frames.length - 1, spec.phase % phaseCount)]!;
      output = [];
      let cursor = 0;
      for (let grid = offsetFrame.t; grid <= last.t + 0.5; grid += targetInterval) {
        while (cursor + 1 < frames.length && frames[cursor + 1]!.t <= grid) cursor += 1;
        const candidates = [frames[cursor]!, frames[cursor + 1]].filter(
          (frame): frame is PeopleFile["frames"][number] => frame !== undefined,
        );
        let nearest = candidates[0]!;
        for (const candidate of candidates) {
          if (Math.abs(candidate.t - grid) < Math.abs(nearest.t - grid)) nearest = candidate;
        }
        if (Math.abs(nearest.t - grid) > intervalMs * 0.5 + 0.5) continue;
        if (output.length > 0 && output[output.length - 1]!.t === nearest.t) continue;
        output.push({ t: nearest.t, p: nearest.p });
      }
    } else {
      mode = "interpolate";
      output = [];
      let cursor = 0;
      for (let grid = first.t; grid <= last.t + 0.5; grid += targetInterval) {
        while (cursor + 1 < frames.length && frames[cursor + 1]!.t <= grid) cursor += 1;
        const a = frames[cursor]!;
        const b = frames[cursor + 1];
        const t = Math.round(grid);
        if (output.length > 0 && output[output.length - 1]!.t >= t) continue;
        if (Math.abs(a.t - grid) < 0.5 || !b) {
          if (Math.abs(a.t - grid) < 0.5) output.push({ t: a.t, p: a.p });
          continue;
        }
        if (b.t - a.t > MAX_INTERPOLATION_GAP_MS) continue;
        const alpha = (grid - a.t) / (b.t - a.t);
        output.push({ t, p: interpolatePersons(a.p, b.p, alpha) });
        interpolatedFrames += 1;
      }
    }
  }

  // Perturbations (seeded): drops first, then jitter, both replayable.
  const random = mulberry32(spec.seed);
  let droppedFrames = 0;
  if (spec.dropRate > 0) {
    const kept: PeopleFile["frames"] = [];
    for (const frame of output) {
      if (random() < spec.dropRate) {
        droppedFrames += 1;
        continue;
      }
      kept.push(frame);
    }
    output = kept;
  }
  if (spec.jitterMs > 0) {
    const jittered = output.map((frame) => ({
      t: Math.round(frame.t + (random() * 2 - 1) * spec.jitterMs),
      p: frame.p,
    }));
    jittered.sort((a, b) => a.t - b.t);
    for (let index = 1; index < jittered.length; index += 1) {
      if (jittered[index]!.t <= jittered[index - 1]!.t) {
        jittered[index]!.t = jittered[index - 1]!.t + 1;
      }
    }
    output = jittered;
  }

  return {
    file: {
      schemaVersion: people.schemaVersion,
      poseModelVersion: people.poseModelVersion,
      video: { ...people.video, fps: spec.fps ?? nativeFps },
      frames: output,
    },
    nativeFps,
    nativeIntervalMs: intervalMs,
    mode,
    synthetic: mode === "interpolate",
    nativeFrames: frames.length,
    outputFrames: output.length,
    interpolatedFrames,
    droppedFrames,
    phaseCount,
  };
}

// ─── Scoring ────────────────────────────────────────────────────────────────

export interface EventScore {
  eventIndex: number;
  owner: "target" | "other";
  goldSpanMs: [number, number];
  goldContactMs: number | null;
  contactDisputed: boolean;
  /** Wrist speed inside the gold span: max raw sample, and max of the
   * proposer's 3-sample moving average (`smoothedSpeed` is what the 0.5 n/s
   * `minPeakSpeed` gate actually sees — its temporal width is 3 frames, so
   * a short stroke's peak is attenuated more at lower fps). */
  goldSpanPeak: {
    speed: number;
    smoothedSpeed: number;
    timestampMs: number;
    samples: number;
  } | null;
  outcome: "PROPOSED_OK" | "MIS_BOUNDED" | "MISSED";
  matched: {
    eventId: string;
    startMs: number;
    peakMs: number;
    endMs: number;
    overlapOfGold: number;
    reused: boolean;
  } | null;
  startErrMs: number | null;
  endErrMs: number | null;
  /** |proposal peak − gold contact| (the proposal peak is what session mode
   * hands to analyzeCapture as trigger.peakMotionMs). */
  peakVsContactMs: number | null;
  contactInside: boolean | null;
}

export interface PhaseScore {
  segmenter:
    | "temporalV2.anchored"
    | "temporalV2.anchorFree"
    | "geometric.goldAnchored"
    | "geometric.anchorFree"
    | "geometric.composed";
  status: "segmented" | "abstained" | "not_run";
  reason: string | null;
  /** Signed ms (estimate − gold); null when either side is absent. */
  preparationStartErrMs: number | null;
  accelerationStartErrMs: number | null;
  contactErrMs: number | null;
  followThroughEndErrMs: number | null;
  recoveryEndErrMs: number | null;
}

export interface VariantRow {
  spec: VariantSpec;
  resample: Omit<ResampleResult, "file">;
  target: {
    trackId: number;
    coverage: number;
    frames: number;
    /** Mean torso-mid of the auto-selected target; identity drift across
     * variants is detected by comparing this to the native row. */
    torsoMid: { x: number; y: number };
  } | null;
  wristSamples: number;
  proposals: Array<{
    eventId: string;
    startMs: number;
    peakMs: number;
    endMs: number;
    peakSpeed: number;
    prominence: number;
    lowAmplitude: boolean;
  }>;
  proposalSource: string;
  streaming: {
    emitted: Array<{ startMs: number; peakMs: number; endMs: number; closeReason: string }>;
    parity: boolean;
    mismatch: string | null;
  };
  events: EventScore[];
  phases: PhaseScore[];
  perf: { elapsedMs: number; heapUsedDeltaBytes: number; heapUsedAfterBytes: number };
}

function selectTarget(tracks: PlayerTrack[]): PlayerTrack | null {
  return (
    [...tracks].sort((a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan)[0] ??
    null
  );
}

function scoreEvents(
  gold: GoldCase,
  proposals: StrokeEventProposalV2[],
  speeds: ReadonlyArray<{ timestampMs: number; value: number }>,
): EventScore[] {
  const candidates: Array<{ index: number; proposal: StrokeEventProposalV2; fraction: number }> =
    [];
  for (const [index, label] of gold.events.entries()) {
    for (const proposal of proposals) {
      const fraction = overlapOfGold(proposal, label);
      if (fraction > 0.3) candidates.push({ index, proposal, fraction });
    }
  }
  const sorted = [...speeds].sort((a, b) => a.timestampMs - b.timestampMs);
  const ownerRank = (index: number) => (gold.events[index]!.owner === "target" ? 0 : 1);
  candidates.sort((a, b) => ownerRank(a.index) - ownerRank(b.index) || b.fraction - a.fraction);
  const assigned = new Map<
    number,
    { proposal: StrokeEventProposalV2; fraction: number; reused: boolean }
  >();
  const used = new Set<string>();
  for (const candidate of candidates) {
    if (assigned.has(candidate.index) || used.has(candidate.proposal.eventId)) continue;
    assigned.set(candidate.index, {
      proposal: candidate.proposal,
      fraction: candidate.fraction,
      reused: false,
    });
    used.add(candidate.proposal.eventId);
  }
  for (const candidate of candidates) {
    if (assigned.has(candidate.index)) continue;
    assigned.set(candidate.index, {
      proposal: candidate.proposal,
      fraction: candidate.fraction,
      reused: true,
    });
  }
  return gold.events.map((label, index) => {
    const match = assigned.get(index) ?? null;
    const contactInside =
      match && label.contactMs !== null
        ? label.contactMs >= match.proposal.startMs - CONTACT_INSIDE_TOL_MS &&
          label.contactMs <= match.proposal.endMs + CONTACT_INSIDE_TOL_MS
        : null;
    const outcome: EventScore["outcome"] = !match
      ? "MISSED"
      : match.fraction >= 0.5 || contactInside === true
        ? "PROPOSED_OK"
        : "MIS_BOUNDED";
    let peak: EventScore["goldSpanPeak"] = null;
    let smoothedMax = 0;
    let samples = 0;
    for (const [index, sample] of sorted.entries()) {
      if (sample.timestampMs < label.eventStartMs || sample.timestampMs > label.eventEndMs)
        continue;
      samples += 1;
      const window = sorted.slice(Math.max(0, index - 1), index + 2);
      const smoothed = window.reduce((total, entry) => total + entry.value, 0) / window.length;
      smoothedMax = Math.max(smoothedMax, smoothed);
      if (!peak || sample.value > peak.speed) {
        peak = {
          speed: Number(sample.value.toFixed(3)),
          smoothedSpeed: 0,
          timestampMs: sample.timestampMs,
          samples: 0,
        };
      }
    }
    if (peak) {
      peak.smoothedSpeed = Number(smoothedMax.toFixed(3));
      peak.samples = samples;
    }
    return {
      eventIndex: index,
      owner: label.owner,
      goldSpanMs: [label.eventStartMs, label.eventEndMs],
      goldContactMs: label.contactMs,
      contactDisputed: label.contactDisputed === true,
      goldSpanPeak: peak,
      outcome,
      matched: match
        ? {
            eventId: match.proposal.eventId,
            startMs: round1(match.proposal.startMs),
            peakMs: round1(match.proposal.peakMs),
            endMs: round1(match.proposal.endMs),
            overlapOfGold: Number(match.fraction.toFixed(3)),
            reused: match.reused,
          }
        : null,
      startErrMs: match ? round1(Math.abs(match.proposal.startMs - label.eventStartMs)) : null,
      endErrMs: match ? round1(Math.abs(match.proposal.endMs - label.eventEndMs)) : null,
      peakVsContactMs:
        match && label.contactMs !== null
          ? round1(Math.abs(match.proposal.peakMs - label.contactMs))
          : null,
      contactInside,
    };
  });
}

const round1 = (value: number): number => Math.round(value * 10) / 10;
const signedErr = (estimate: number | null | undefined, gold: number | null): number | null =>
  estimate === null || estimate === undefined || gold === null || !Number.isFinite(estimate)
    ? null
    : round1(estimate - gold);

function phaseFromSpans(spans: PhaseSpan[], key: PhaseSpan["key"]): PhaseSpan | null {
  return spans.find((span) => span.key === key) ?? null;
}

async function scorePhases(
  gold: GoldCase,
  speeds: Array<{ timestampMs: number; value: number }>,
  legacyFrames: ReturnType<typeof toLegacyPoseFrames>,
  eventScores: EventScore[],
): Promise<PhaseScore[]> {
  if (!gold.phases || gold.phaseEventIndex === null) return [];
  const phases = gold.phases;
  const label = gold.events[gold.phaseEventIndex]!;
  const event = { startMs: label.eventStartMs, endMs: label.eventEndMs };
  const out: PhaseScore[] = [];

  for (const mode of ["anchored", "anchorFree"] as const) {
    const outcome = segmentPhasesTemporalV2({
      event,
      contactMs: mode === "anchored" ? label.contactMs : null,
      paddleSpeeds: null,
      wristSpeeds: speeds,
    });
    const segmenter = mode === "anchored" ? "temporalV2.anchored" : "temporalV2.anchorFree";
    if (outcome.status === "abstained") {
      out.push(emptyPhase(segmenter, "abstained", outcome.reason));
      continue;
    }
    const b = outcome.boundaries;
    out.push({
      segmenter,
      status: "segmented",
      reason: null,
      preparationStartErrMs: signedErr(b.preparationStartMs, phases.preparationStartMs),
      accelerationStartErrMs: signedErr(b.accelerationStartMs, phases.accelerationStartMs),
      contactErrMs:
        mode === "anchored"
          ? signedErr(b.contactMs, phases.contactMs)
          : signedErr(b.motionPeakMs ?? null, phases.contactMs),
      followThroughEndErrMs: signedErr(b.followThroughEndMs, phases.followThroughEndMs),
      recoveryEndErrMs: signedErr(b.recoveryEndMs, phases.recoveryEndMs),
    });
  }

  const geometric = new GeometricPhaseSegmenter({ aspectRatio: 1 });
  const matched = eventScores[gold.phaseEventIndex]?.matched ?? null;
  const geometricRuns: Array<{
    segmenter: PhaseScore["segmenter"];
    stroke: { startMs: number; endMs: number; contactMs: number | null } | null;
  }> = [
    {
      segmenter: "geometric.goldAnchored",
      stroke: { startMs: event.startMs, endMs: event.endMs, contactMs: label.contactMs },
    },
    {
      segmenter: "geometric.anchorFree",
      stroke: { startMs: event.startMs, endMs: event.endMs, contactMs: null },
    },
    {
      segmenter: "geometric.composed",
      stroke: matched
        ? { startMs: matched.startMs, endMs: matched.endMs, contactMs: matched.peakMs }
        : null,
    },
  ];
  for (const run of geometricRuns) {
    if (!run.stroke) {
      out.push(emptyPhase(run.segmenter, "not_run", "no matched proposal for the phase event"));
      continue;
    }
    const result = await geometric.segmentPhases(legacyFrames, [], {
      startMs: run.stroke.startMs,
      endMs: run.stroke.endMs,
      contactMs: run.stroke.contactMs,
      shotTypeHypothesis: null,
      confidence: 1,
    });
    if (!result.ok) {
      out.push(
        emptyPhase(run.segmenter, "abstained", `${result.failure.code}: ${result.failure.message}`),
      );
      continue;
    }
    const spans = result.value;
    out.push({
      segmenter: run.segmenter,
      status: "segmented",
      reason: null,
      preparationStartErrMs: signedErr(
        phaseFromSpans(spans, "prepare")?.startMs,
        phases.preparationStartMs,
      ),
      accelerationStartErrMs: signedErr(
        phaseFromSpans(spans, "accelerate")?.startMs,
        phases.accelerationStartMs,
      ),
      contactErrMs: signedErr(phaseFromSpans(spans, "contact")?.representativeMs, phases.contactMs),
      followThroughEndErrMs: signedErr(
        phaseFromSpans(spans, "follow_through")?.endMs,
        phases.followThroughEndMs,
      ),
      recoveryEndErrMs: signedErr(phaseFromSpans(spans, "recover")?.endMs, phases.recoveryEndMs),
    });
  }
  return out;
}

function emptyPhase(
  segmenter: PhaseScore["segmenter"],
  status: "abstained" | "not_run",
  reason: string,
): PhaseScore {
  return {
    segmenter,
    status,
    reason,
    preparationStartErrMs: null,
    accelerationStartErrMs: null,
    contactErrMs: null,
    followThroughEndErrMs: null,
    recoveryEndErrMs: null,
  };
}

function streamThroughEngine(
  speeds: Array<{ timestampMs: number; value: number }>,
  batch: StrokeEventProposalV2[],
): VariantRow["streaming"] {
  const engine = new SessionEventEngine({
    sessionId: "xc-fps",
    captureMeta: { source: "replay" },
  });
  const emitted: VariantRow["streaming"]["emitted"] = [];
  const collect = (events: ReturnType<SessionEventEngine["push"]>) => {
    for (const event of events) {
      emitted.push({
        startMs: round1(event.proposal.startMs),
        peakMs: round1(event.proposal.peakMs),
        endMs: round1(event.proposal.endMs),
        closeReason: event.closeReason,
      });
    }
  };
  for (const sample of speeds) collect(engine.pushWristSample(sample));
  collect(engine.flush());
  let mismatch: string | null = null;
  if (emitted.length !== batch.length) {
    mismatch = `count streamed=${emitted.length} batch=${batch.length}`;
  } else {
    for (const [index, event] of emitted.entries()) {
      const proposal = batch[index]!;
      if (
        Math.abs(event.startMs - proposal.startMs) > 0.05 ||
        Math.abs(event.peakMs - proposal.peakMs) > 0.05 ||
        Math.abs(event.endMs - proposal.endMs) > 0.05
      ) {
        mismatch = `E${index + 1} streamed ${event.startMs}/${event.peakMs}/${event.endMs} vs batch ${round1(proposal.startMs)}/${round1(proposal.peakMs)}/${round1(proposal.endMs)}`;
        break;
      }
    }
  }
  return { emitted, parity: mismatch === null, mismatch };
}

export async function runVariant(gold: GoldCase, spec: VariantSpec): Promise<VariantRow> {
  const people = loadPeople(gold.runDir);
  const heapBefore = process.memoryUsage().heapUsed;
  const started = performance.now();
  const resample = resamplePeople(people, spec);
  const tracks = buildPlayerTracks(resample.file);
  const target = selectTarget(tracks);
  const sequence = target ? targetPoseSequence(resample.file, target) : null;
  const speeds = sequence ? dominantWristSpeeds(sequence.frames) : [];
  const { events: proposals, source } = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds: speeds,
    clipStartMs: gold.windowMs.from,
    clipEndMs: gold.windowMs.to,
  });
  const streaming = streamThroughEngine(speeds, proposals);
  const events = scoreEvents(gold, proposals, speeds);
  const phases = sequence
    ? await scorePhases(gold, speeds, toLegacyPoseFrames(sequence), events)
    : [];
  const elapsedMs = performance.now() - started;
  const heapAfter = process.memoryUsage().heapUsed;
  const { file: _file, ...resampleMeta } = resample;
  return {
    spec,
    resample: resampleMeta,
    target: target
      ? {
          trackId: target.trackId,
          coverage: Number(target.coverage.toFixed(3)),
          frames: target.frames.length,
          torsoMid: {
            x: Number(
              (
                target.frames.reduce((sum, frame) => sum + frame.torsoMid.x, 0) /
                target.frames.length
              ).toFixed(3),
            ),
            y: Number(
              (
                target.frames.reduce((sum, frame) => sum + frame.torsoMid.y, 0) /
                target.frames.length
              ).toFixed(3),
            ),
          },
        }
      : null,
    wristSamples: speeds.length,
    proposals: proposals.map((proposal) => ({
      eventId: proposal.eventId,
      startMs: round1(proposal.startMs),
      peakMs: round1(proposal.peakMs),
      endMs: round1(proposal.endMs),
      peakSpeed: Number(proposal.peakSpeed.toFixed(3)),
      prominence: Number(proposal.prominence.toFixed(2)),
      lowAmplitude: proposal.lowAmplitude === true,
    })),
    proposalSource: source,
    streaming,
    events,
    phases,
    perf: {
      elapsedMs: round1(elapsedMs),
      heapUsedDeltaBytes: heapAfter - heapBefore,
      heapUsedAfterBytes: heapAfter,
    },
  };
}

// ─── Aggregation ────────────────────────────────────────────────────────────

export interface FpsMatrixRow {
  fps: number | "native";
  /** True when ANY bundle in this row was up-sampled (interpolated). */
  synthetic: boolean;
  syntheticBundles: number;
  bundles: number;
  targetEvents: number;
  matched: number;
  proposedOk: number;
  missed: number;
  contactInside: number;
  contactScored: number;
  startErrMedianMs: number | null;
  startErrMaxMs: number | null;
  endErrMedianMs: number | null;
  endErrMaxMs: number | null;
  peakVsContactMedianMs: number | null;
  peakVsContactMaxMs: number | null;
  unmatchedProposals: number;
  totalProposals: number;
  streamingParityBundles: number;
  targetIdentitySwitches: number;
  phases: Record<
    PhaseScore["segmenter"],
    {
      segmented: number;
      total: number;
      contactAbsMedianMs: number | null;
      contactAbsMaxMs: number | null;
      contactWithinAcceptMs: number;
      accelerationStartAbsMedianMs: number | null;
      followThroughEndAbsMedianMs: number | null;
    }
  >;
  perf: { elapsedTotalMs: number; heapUsedAfterMaxBytes: number };
}

const PHASE_SEGMENTERS: PhaseScore["segmenter"][] = [
  "temporalV2.anchored",
  "temporalV2.anchorFree",
  "geometric.goldAnchored",
  "geometric.anchorFree",
  "geometric.composed",
];

export function aggregate(
  rows: VariantRow[],
  nativeByBundle: Map<string, VariantRow>,
  fps: number | "native",
): FpsMatrixRow {
  const targetScores = rows.flatMap((row) =>
    row.events.filter((event) => event.owner === "target"),
  );
  const matched = targetScores.filter((event) => event.matched !== null);
  const contactScored = targetScores.filter(
    (event) => event.contactInside !== null && !event.contactDisputed,
  );
  const abs = (values: Array<number | null>) =>
    values.flatMap((value) => (value === null ? [] : [Math.abs(value)]));
  const max = (values: number[]) => (values.length > 0 ? Math.max(...values) : null);
  const startErrs = abs(matched.map((event) => event.startErrMs));
  const endErrs = abs(matched.map((event) => event.endErrMs));
  const peakErrs = abs(
    matched.filter((event) => !event.contactDisputed).map((event) => event.peakVsContactMs),
  );
  const totalProposals = rows.reduce((sum, row) => sum + row.proposals.length, 0);
  const matchedIds = new Set(
    rows.flatMap((row) =>
      row.events
        .filter((event) => event.matched && !event.matched.reused)
        .map((event) => `${row.spec.bundle}:${event.matched!.eventId}`),
    ),
  );
  const phases = {} as FpsMatrixRow["phases"];
  for (const segmenter of PHASE_SEGMENTERS) {
    const scores = rows.flatMap((row) => row.phases.filter((p) => p.segmenter === segmenter));
    const segmented = scores.filter((p) => p.status === "segmented");
    const contactAbs = abs(segmented.map((p) => p.contactErrMs));
    phases[segmenter] = {
      segmented: segmented.length,
      total: scores.length,
      contactAbsMedianMs: medianOf(contactAbs),
      contactAbsMaxMs: max(contactAbs),
      contactWithinAcceptMs: contactAbs.filter((value) => value <= CONTACT_ACCEPT_MS).length,
      accelerationStartAbsMedianMs: medianOf(abs(segmented.map((p) => p.accelerationStartErrMs))),
      followThroughEndAbsMedianMs: medianOf(abs(segmented.map((p) => p.followThroughEndErrMs))),
    };
  }
  let identitySwitches = 0;
  for (const row of rows) {
    const native = nativeByBundle.get(row.spec.bundle);
    if (!native?.target || !row.target) {
      if ((native?.target ?? null) !== (row.target ?? null)) identitySwitches += 1;
      continue;
    }
    const drift = Math.hypot(
      native.target.torsoMid.x - row.target.torsoMid.x,
      native.target.torsoMid.y - row.target.torsoMid.y,
    );
    if (drift > TORSO_ASSOC_RADIUS) identitySwitches += 1;
  }
  return {
    fps,
    synthetic: rows.some((row) => row.resample.synthetic),
    syntheticBundles: rows.filter((row) => row.resample.synthetic).length,
    bundles: rows.length,
    targetEvents: targetScores.length,
    matched: matched.length,
    proposedOk: targetScores.filter((event) => event.outcome === "PROPOSED_OK").length,
    missed: targetScores.filter((event) => event.outcome === "MISSED").length,
    contactInside: contactScored.filter((event) => event.contactInside === true).length,
    contactScored: contactScored.length,
    startErrMedianMs: medianOf(startErrs),
    startErrMaxMs: max(startErrs),
    endErrMedianMs: medianOf(endErrs),
    endErrMaxMs: max(endErrs),
    peakVsContactMedianMs: medianOf(peakErrs),
    peakVsContactMaxMs: max(peakErrs),
    unmatchedProposals: totalProposals - matchedIds.size,
    totalProposals,
    streamingParityBundles: rows.filter((row) => row.streaming.parity).length,
    targetIdentitySwitches: identitySwitches,
    phases,
    perf: {
      elapsedTotalMs: round1(rows.reduce((sum, row) => sum + row.perf.elapsedMs, 0)),
      heapUsedAfterMaxBytes: Math.max(0, ...rows.map((row) => row.perf.heapUsedAfterBytes)),
    },
  };
}

export interface Failure {
  kind:
    | "event_lost_vs_native"
    | "event_gained_vs_native"
    | "contact_inside_lost"
    | "phase_abstained_vs_native"
    | "phase_contact_outside_accept"
    | "streaming_parity_broken"
    | "target_identity_switch"
    | "bounds_shift_over_one_native_frame";
  bundle: string;
  spec: VariantSpec;
  detail: string;
  replay: string;
}

export function diffAgainstNative(row: VariantRow, native: VariantRow): Failure[] {
  const failures: Failure[] = [];
  const replay = `pnpm --filter @pickle/swing-lab exec tsx src/fpsTemporalSegmentation.ts --replay '${JSON.stringify(row.spec)}'`;
  const push = (kind: Failure["kind"], detail: string) =>
    failures.push({ kind, bundle: row.spec.bundle, spec: row.spec, detail, replay });

  for (const [index, event] of row.events.entries()) {
    if (event.owner !== "target") continue;
    const base = native.events[index];
    if (!base) continue;
    const label = `event#${index} gold ${event.goldSpanMs[0]}–${event.goldSpanMs[1]}`;
    if (base.matched && !event.matched)
      push("event_lost_vs_native", `${label}: matched natively, MISSED here`);
    if (!base.matched && event.matched)
      push("event_gained_vs_native", `${label}: MISSED natively, matched here (${event.outcome})`);
    if (base.contactInside === true && event.contactInside === false && !event.contactDisputed) {
      push(
        "contact_inside_lost",
        `${label}: gold contact ${event.goldContactMs} inside natively, outside proposal ${event.matched?.startMs}–${event.matched?.endMs} here`,
      );
    }
    if (base.matched && event.matched) {
      const tolerance = row.resample.nativeIntervalMs;
      const startShift = Math.abs(event.matched.startMs - base.matched.startMs);
      const endShift = Math.abs(event.matched.endMs - base.matched.endMs);
      if (startShift > tolerance || endShift > tolerance) {
        push(
          "bounds_shift_over_one_native_frame",
          `${label}: native ${base.matched.startMs}–${base.matched.endMs}, here ${event.matched.startMs}–${event.matched.endMs} (Δstart ${round1(startShift)} Δend ${round1(endShift)} > ${tolerance}ms)`,
        );
      }
    }
  }
  for (const phase of row.phases) {
    const base = native.phases.find((p) => p.segmenter === phase.segmenter);
    if (base?.status === "segmented" && phase.status === "abstained") {
      push(
        "phase_abstained_vs_native",
        `${phase.segmenter}: segmented natively, abstained here (${phase.reason})`,
      );
    }
    if (
      phase.status === "segmented" &&
      phase.contactErrMs !== null &&
      Math.abs(phase.contactErrMs) > CONTACT_ACCEPT_MS
    ) {
      push(
        "phase_contact_outside_accept",
        `${phase.segmenter}: contact error ${phase.contactErrMs}ms (> ${CONTACT_ACCEPT_MS}ms accept band)`,
      );
    }
  }
  if (!row.streaming.parity) push("streaming_parity_broken", row.streaming.mismatch ?? "mismatch");
  if (native.target && row.target) {
    const drift = Math.hypot(
      native.target.torsoMid.x - row.target.torsoMid.x,
      native.target.torsoMid.y - row.target.torsoMid.y,
    );
    if (drift > TORSO_ASSOC_RADIUS)
      push(
        "target_identity_switch",
        `auto-target torso drifted ${drift.toFixed(3)} (track ${native.target.trackId} → ${row.target.trackId})`,
      );
  } else if (native.target && !row.target) {
    push("target_identity_switch", "no target track survived resampling");
  }
  return failures;
}

// ─── Full run ───────────────────────────────────────────────────────────────

export interface HarnessOptions {
  sweepPhases: boolean;
  jitterMs: number[];
  dropRates: number[];
  seeds: number;
  bundles?: string[];
  /** Additional decimation-only fps points (e.g. 15, 12 for the F18
   * frame-rate degraded-band question); never up-sampled. */
  extraFps?: number[];
}

export interface HarnessReport {
  harnessVersion: string;
  generatedAtIso: string;
  evidenceClass: "linux_replay_proxy";
  gold: string;
  options: HarnessOptions;
  cases: Array<
    Pick<GoldCase, "bundle" | "nativeFps" | "windowMs" | "phaseEventIndex"> & {
      targetEvents: number;
      otherEvents: number;
    }
  >;
  matrix: FpsMatrixRow[];
  /** metric(fps) − metric(native) for the deterministic phase-0 runs. */
  deltas: Array<Record<string, number | string | boolean | null>>;
  /** Same as `matrix`/`deltas` but restricted, per fps, to bundles whose
   * native rate is ≥ that fps (pure decimation — no synthetic frames). The
   * native reference row is recomputed over the same bundle subset. */
  decimationOnly: Array<{
    fps: number;
    bundles: string[];
    native: FpsMatrixRow;
    variant: FpsMatrixRow;
    delta: Record<string, number | string | boolean | null>;
  }>;
  /** Extra decimation-only fps points (below the assignment ladder). */
  extraFps: Array<{ fps: number; bundles: string[]; variant: FpsMatrixRow; failures: number }>;
  /** Per-fps matrix of gold target-event outcomes (rows = events, cols = fps). */
  eventOutcomeMatrix: Array<{
    bundle: string;
    eventIndex: number;
    goldSpanMs: [number, number];
    goldContactMs: number | null;
    byFps: Record<
      string,
      {
        outcome: string;
        goldSpanPeakSpeed: number | null;
        goldSpanSmoothedPeakSpeed: number | null;
        goldSpanSamples: number | null;
        startErrMs: number | null;
        endErrMs: number | null;
        peakVsContactMs: number | null;
        contactInside: boolean | null;
      }
    >;
  }>;
  phaseSweep: Array<{
    bundle: string;
    fps: number;
    phaseCount: number;
    outcomesByPhase: string[];
    flips: boolean;
  }>;
  perturbations: Array<{
    kind: "jitter" | "drop";
    amount: number;
    seed: number;
    fps: number | "native";
    failures: number;
    eventLost: number;
    eventGained: number;
    contactInsideLost: number;
    streamingBroken: number;
  }>;
  failures: Failure[];
  rows: VariantRow[];
}

export async function runHarness(options: HarnessOptions): Promise<HarnessReport> {
  const cases = loadGoldCases().filter(
    (entry) => !options.bundles || options.bundles.includes(entry.bundle),
  );
  const rows: VariantRow[] = [];
  const failures: Failure[] = [];
  const nativeByBundle = new Map<string, VariantRow>();
  const baseSpec = (bundle: string, fps: number | null, phase = 0): VariantSpec => ({
    bundle,
    fps,
    phase,
    jitterMs: 0,
    dropRate: 0,
    seed: 0,
  });

  for (const entry of cases) {
    const native = await runVariant(entry, baseSpec(entry.bundle, null));
    rows.push(native);
    nativeByBundle.set(entry.bundle, native);
  }
  const deterministic = new Map<number, VariantRow[]>();
  for (const fps of TARGET_FPS) {
    const list: VariantRow[] = [];
    for (const entry of cases) {
      const row = await runVariant(entry, baseSpec(entry.bundle, fps));
      rows.push(row);
      list.push(row);
      failures.push(...diffAgainstNative(row, nativeByBundle.get(entry.bundle)!));
    }
    deterministic.set(fps, list);
  }

  const phaseSweep: HarnessReport["phaseSweep"] = [];
  if (options.sweepPhases) {
    for (const fps of TARGET_FPS) {
      for (const entry of cases) {
        const probe = deterministic.get(fps)!.find((row) => row.spec.bundle === entry.bundle)!;
        if (probe.resample.mode !== "decimate" || probe.resample.phaseCount < 2) continue;
        const outcomes: string[] = [];
        for (let phase = 0; phase < probe.resample.phaseCount; phase += 1) {
          const row =
            phase === 0 ? probe : await runVariant(entry, baseSpec(entry.bundle, fps, phase));
          if (phase !== 0) {
            rows.push(row);
            failures.push(...diffAgainstNative(row, nativeByBundle.get(entry.bundle)!));
          }
          outcomes.push(
            row.events
              .filter((event) => event.owner === "target")
              .map(
                (event) =>
                  `${event.outcome}${event.contactInside === null ? "" : event.contactInside ? "+ci" : "-ci"}`,
              )
              .join(","),
          );
        }
        phaseSweep.push({
          bundle: entry.bundle,
          fps,
          phaseCount: probe.resample.phaseCount,
          outcomesByPhase: outcomes,
          flips: new Set(outcomes).size > 1,
        });
      }
    }
  }

  const perturbations: HarnessReport["perturbations"] = [];
  const perturbationFps: Array<number | null> = [null, ...TARGET_FPS.filter((fps) => fps !== 120)];
  for (const kind of ["jitter", "drop"] as const) {
    const amounts = kind === "jitter" ? options.jitterMs : options.dropRates;
    for (const amount of amounts) {
      if (amount <= 0) continue;
      for (let seed = 1; seed <= options.seeds; seed += 1) {
        for (const fps of perturbationFps) {
          const bucket = {
            failures: 0,
            eventLost: 0,
            eventGained: 0,
            contactInsideLost: 0,
            streamingBroken: 0,
          };
          for (const entry of cases) {
            const spec: VariantSpec = {
              bundle: entry.bundle,
              fps,
              phase: 0,
              jitterMs: kind === "jitter" ? amount : 0,
              dropRate: kind === "drop" ? amount : 0,
              seed,
            };
            const row = await runVariant(entry, spec);
            rows.push(row);
            const rowFailures = diffAgainstNative(row, nativeByBundle.get(entry.bundle)!);
            failures.push(...rowFailures);
            bucket.failures += rowFailures.length;
            bucket.eventLost += rowFailures.filter((f) => f.kind === "event_lost_vs_native").length;
            bucket.eventGained += rowFailures.filter(
              (f) => f.kind === "event_gained_vs_native",
            ).length;
            bucket.contactInsideLost += rowFailures.filter(
              (f) => f.kind === "contact_inside_lost",
            ).length;
            bucket.streamingBroken += rowFailures.filter(
              (f) => f.kind === "streaming_parity_broken",
            ).length;
          }
          perturbations.push({ kind, amount, seed, fps: fps ?? "native", ...bucket });
        }
      }
    }
  }

  const extraFps: HarnessReport["extraFps"] = [];
  for (const fps of options.extraFps ?? []) {
    const eligible = cases.filter((entry) => fps <= entry.nativeFps * 1.02);
    const list: VariantRow[] = [];
    let extraFailures = 0;
    for (const entry of eligible) {
      const row = await runVariant(entry, baseSpec(entry.bundle, fps));
      rows.push(row);
      list.push(row);
      const rowFailures = diffAgainstNative(row, nativeByBundle.get(entry.bundle)!);
      failures.push(...rowFailures);
      extraFailures += rowFailures.length;
    }
    extraFps.push({
      fps,
      bundles: eligible.map((entry) => entry.bundle),
      variant: aggregate(list, nativeByBundle, fps),
      failures: extraFailures,
    });
  }

  const nativeRows = [...nativeByBundle.values()];
  const matrix: FpsMatrixRow[] = [
    aggregate(nativeRows, nativeByBundle, "native"),
    ...TARGET_FPS.map((fps) => aggregate(deterministic.get(fps)!, nativeByBundle, fps)),
  ];
  const nativeMatrix = matrix[0]!;
  const deltaOf = (row: FpsMatrixRow, reference: FpsMatrixRow) => {
    const delta: Record<string, number | string | boolean | null> = {
      fps: row.fps,
      synthetic: row.synthetic,
    };
    const numeric: Array<keyof FpsMatrixRow> = [
      "matched",
      "proposedOk",
      "missed",
      "contactInside",
      "startErrMedianMs",
      "startErrMaxMs",
      "endErrMedianMs",
      "endErrMaxMs",
      "peakVsContactMedianMs",
      "peakVsContactMaxMs",
      "unmatchedProposals",
      "totalProposals",
      "streamingParityBundles",
      "targetIdentitySwitches",
    ];
    for (const key of numeric) {
      const a = row[key];
      const b = reference[key];
      delta[key] = typeof a === "number" && typeof b === "number" ? round1(a - b) : null;
    }
    for (const segmenter of PHASE_SEGMENTERS) {
      const a = row.phases[segmenter];
      const b = reference.phases[segmenter];
      delta[`${segmenter}.segmented`] = a.segmented - b.segmented;
      delta[`${segmenter}.contactAbsMedianMs`] =
        a.contactAbsMedianMs !== null && b.contactAbsMedianMs !== null
          ? round1(a.contactAbsMedianMs - b.contactAbsMedianMs)
          : null;
      delta[`${segmenter}.contactWithinAcceptMs`] =
        a.contactWithinAcceptMs - b.contactWithinAcceptMs;
    }
    return delta;
  };
  const deltas = matrix.slice(1).map((row) => deltaOf(row, nativeMatrix));
  const decimationOnly: HarnessReport["decimationOnly"] = TARGET_FPS.map((fps) => {
    const variantRows = deterministic.get(fps)!.filter((row) => !row.resample.synthetic);
    const bundles = variantRows.map((row) => row.spec.bundle);
    const referenceRows = bundles.map((bundle) => nativeByBundle.get(bundle)!);
    const native = aggregate(referenceRows, nativeByBundle, "native");
    const variant = aggregate(variantRows, nativeByBundle, fps);
    return { fps, bundles, native, variant, delta: deltaOf(variant, native) };
  });

  const eventOutcomeMatrix: HarnessReport["eventOutcomeMatrix"] = [];
  for (const entry of cases) {
    const native = nativeByBundle.get(entry.bundle)!;
    for (const [index, event] of native.events.entries()) {
      if (event.owner !== "target") continue;
      const byFps: HarnessReport["eventOutcomeMatrix"][number]["byFps"] = {};
      const cell = (score: EventScore) => ({
        outcome: score.outcome,
        goldSpanPeakSpeed: score.goldSpanPeak?.speed ?? null,
        goldSpanSmoothedPeakSpeed: score.goldSpanPeak?.smoothedSpeed ?? null,
        goldSpanSamples: score.goldSpanPeak?.samples ?? null,
        startErrMs: score.startErrMs,
        endErrMs: score.endErrMs,
        peakVsContactMs: score.peakVsContactMs,
        contactInside: score.contactInside,
      });
      byFps.native = cell(event);
      for (const fps of TARGET_FPS) {
        const row = deterministic.get(fps)!.find((r) => r.spec.bundle === entry.bundle)!;
        byFps[String(fps)] = cell(row.events[index]!);
      }
      eventOutcomeMatrix.push({
        bundle: entry.bundle,
        eventIndex: index,
        goldSpanMs: event.goldSpanMs,
        goldContactMs: event.goldContactMs,
        byFps,
      });
    }
  }

  return {
    harnessVersion: FPS_TEMPORAL_HARNESS_VERSION,
    generatedAtIso: new Date().toISOString(),
    evidenceClass: "linux_replay_proxy",
    gold: "datasets/paddle-bench/event-bounds-wave-a.json → per-bundle devin-visual-v2-wave-a.json eventLabels + phases (read-only; no labels added)",
    options,
    cases: cases.map((entry) => ({
      bundle: entry.bundle,
      nativeFps: entry.nativeFps,
      windowMs: entry.windowMs,
      phaseEventIndex: entry.phaseEventIndex,
      targetEvents: entry.events.filter((event) => event.owner === "target").length,
      otherEvents: entry.events.filter((event) => event.owner === "other").length,
    })),
    matrix,
    deltas,
    decimationOnly,
    extraFps,
    eventOutcomeMatrix,
    phaseSweep,
    perturbations,
    failures,
    rows,
  };
}

export function writeReport(report: HarnessReport, outDir: string): string[] {
  mkdirSync(outDir, { recursive: true });
  const written: string[] = [];
  const write = (name: string, value: unknown) => {
    const path = join(outDir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    written.push(path);
  };
  const { rows, ...summary } = report;
  write("fps-temporal-summary.json", summary);
  write("fps-temporal-rows.json", rows);
  write("fps-temporal-matrix.json", report.matrix);
  write("fps-temporal-deltas.json", report.deltas);
  write("fps-temporal-decimation-only.json", report.decimationOnly);
  write("fps-temporal-failures.json", report.failures);
  write("fps-temporal-event-outcomes.json", report.eventOutcomeMatrix);
  return written;
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function parseNumberList(value: string | undefined, fallback: number[]): number[] {
  if (!value) return fallback;
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const isMain = process.argv[1]?.endsWith("fpsTemporalSegmentation.ts");
if (isMain) {
  const log = (line: string) => process.stdout.write(`${line}\n`);
  const replay = argValue("--replay");
  if (replay) {
    const spec = JSON.parse(replay) as VariantSpec;
    const gold = loadGoldCases().find((entry) => entry.bundle === spec.bundle);
    if (!gold) throw new Error(`unknown bundle '${spec.bundle}'`);
    void runVariant(gold, spec).then(async (row) => {
      const native = await runVariant(gold, {
        ...spec,
        fps: null,
        phase: 0,
        jitterMs: 0,
        dropRate: 0,
        seed: 0,
      });
      log(JSON.stringify({ row, failuresVsNative: diffAgainstNative(row, native) }, null, 2));
    });
  } else {
    const outDir =
      argValue("--out") ??
      join(REPO_ROOT, "packages/swing-lab/artifacts/xc-cv-temporal-segmentation");
    const options: HarnessOptions = {
      sweepPhases: !process.argv.includes("--no-phase-sweep"),
      jitterMs: parseNumberList(argValue("--jitter"), [2, 4, 8]),
      dropRates: parseNumberList(argValue("--drops"), [0.05, 0.1, 0.2]),
      seeds: Number(argValue("--seeds") ?? 3),
    };
    const bundles = argValue("--bundles");
    if (bundles) options.bundles = bundles.split(",");
    const extra = argValue("--extra-fps");
    if (extra) options.extraFps = parseNumberList(extra, []);
    void runHarness(options).then((report) => {
      const written = writeReport(report, outDir);
      log(
        JSON.stringify(
          {
            matrix: report.matrix,
            deltas: report.deltas,
            decimationOnly: report.decimationOnly.map((entry) => ({
              fps: entry.fps,
              bundles: entry.bundles,
              delta: entry.delta,
            })),
            extraFps: report.extraFps,
          },
          null,
          2,
        ),
      );
      log(
        `phase sweep flips: ${report.phaseSweep.filter((entry) => entry.flips).length}/${report.phaseSweep.length}`,
      );
      log(`failures vs native: ${report.failures.length} (rows: ${report.rows.length})`);
      for (const path of written) log(`written: ${path}`);
    });
  }
}
