import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  estimateContact,
  paddleOwnershipFromHandAffinity,
  type StrokeFamily,
} from "../src/index.js";
import {
  buildPlayerTracks,
  targetPoseSequence,
  type PeopleFile,
} from "../../swing-lab/src/playerTracker.js";
import { toLegacyPoseFrames, type BallObservation } from "@pickle/swing-domain";

/**
 * WAVE-E E02 — contact localization replay on the enlarged Wave D contact
 * gold (LINUX-CPU, pose from committed runs-wave-a people.json windows,
 * ORACLE-BALL condition: ball observations are the visually-verified gold
 * ball annotation frames, confidence 0.9 by construction — this measures the
 * estimator's temporal fusion, NOT the ball tracker). No paddle track exists
 * on Linux for these bundles, so paddleSpeeds/paddleCenters are null
 * (disclosed; the paddle modality is absent, not zeroed).
 *
 * Held-out cases (wm-dink-01, afn-vic-rally1) are never read.
 */

const REPO = join(import.meta.dirname, "../../..");
const PB = join(REPO, "datasets/paddle-bench");
const RUNS = join(PB, "runs-wave-a");
const BUNDLES = join(PB, "bundles");

const HELD_OUT = new Set(["wm-dink-01", "afn-vic-rally1"]);

export interface GoldContactEvent {
  bundle: string;
  session: string;
  eventStartMs: number;
  eventEndMs: number;
  contactMs: number;
  owner: "target" | "other";
  kind: string;
  family: StrokeFamily;
  ballObservationsInWindow: number;
}

export interface ReplayRow {
  event: GoldContactEvent;
  status: "estimated" | "abstained";
  estimatedContactMs: number | null;
  confidence: number | null;
  errorMs: number | null;
  reason: string | null;
  limitingFactors: string[];
  ballConfirmed: boolean | null;
  supportingEvidence: Array<{ signal: string; timestampMs: number; weight: number }>;
}

/** Source session per bundle (grouping unit — never random-frame splits). */
const SESSION: Record<string, string> = {
  "wavea-944403-dink": "dvids-944403",
  "wavea-944403-smash": "dvids-944403",
  "wavea-faead-feed": "dvids-faead",
  "wavea-faead-rally": "dvids-faead",
  "wavea-marne-dig": "dvids-marne",
  "wavea-marne-serve": "dvids-marne",
  "wavea-sasebo-volleys": "dvids-sasebo",
  "wavea-wgm-wheelchair": "dvids-wgm",
};

function familyFromKind(kind: string): StrokeFamily {
  const lower = kind.toLowerCase();
  if (/\bvolley\b/.test(lower)) return "volley";
  if (/\bdink\b/.test(lower)) return "dink";
  if (/\bserve\b/.test(lower)) return "serve";
  if (/\bsmash\b|\boverhead\b/.test(lower)) return "overhead";
  if (/\bdrive\b/.test(lower)) return "drive";
  return "unknown";
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface WaveDContactSidecar {
  captureBundle: string;
  annotatorId: string;
  eventLabels: Array<{
    eventStartMs: number;
    contactMs: number;
    eventEndMs: number;
    owner: "target" | "other";
    note: string;
  }>;
}

interface BallSidecar {
  ballFrames?: Array<{
    tMs: number;
    point: { x: number; y: number } | null;
    visibility: string;
  }>;
}

export function loadGoldEvents(): GoldContactEvent[] {
  const events: GoldContactEvent[] = [];
  for (const bundle of Object.keys(SESSION)) {
    if (HELD_OUT.has(bundle)) continue;
    const sidecarPath = join(BUNDLES, bundle, "annotation", "devin-visual-v3-waveD-contact.json");
    if (!existsSync(sidecarPath)) continue;
    const sidecar = loadJson<WaveDContactSidecar>(sidecarPath);
    for (const label of sidecar.eventLabels) {
      events.push({
        bundle,
        session: SESSION[bundle]!,
        eventStartMs: label.eventStartMs,
        eventEndMs: label.eventEndMs,
        contactMs: label.contactMs,
        owner: label.owner,
        kind: label.note.split(";")[0] ?? "",
        family: familyFromKind(label.note),
        ballObservationsInWindow: 0,
      });
    }
  }
  return events;
}

export function loadBallObservations(bundle: string): BallObservation[] {
  const annotationDir = join(BUNDLES, bundle, "annotation");
  if (!existsSync(annotationDir)) return [];
  const observations: BallObservation[] = [];
  for (const file of readdirSync(annotationDir)) {
    if (!/waveC\.json$|waveD2-ball\.json$/.test(file)) continue;
    const sidecar = loadJson<BallSidecar>(join(annotationDir, file));
    for (const [index, frame] of (sidecar.ballFrames ?? []).entries()) {
      if (!frame.point) continue;
      observations.push({
        frameIndex: index,
        timestampMs: frame.tMs,
        x: frame.point.x,
        y: frame.point.y,
        confidence: 0.9,
      });
    }
  }
  return observations.sort((a, b) => a.timestampMs - b.timestampMs);
}

export function replayAll(options?: {
  pad?: number;
  /** g05: run with the ownership-conditioned posterior flag ON, deriving the
   * ownership confidence from hand affinity (null when no paddle track
   * exists — unmeasured, no conditioning). */
  ownershipConditionedPosterior?: boolean;
}): ReplayRow[] {
  const pad = options?.pad ?? 250;
  const rows: ReplayRow[] = [];
  for (const bundle of Object.keys(SESSION)) {
    const peoplePath = join(RUNS, bundle, "people.json");
    if (!existsSync(peoplePath)) continue;
    const people = loadJson<PeopleFile>(peoplePath);
    const tracks = buildPlayerTracks(people);
    if (tracks.length === 0) continue;
    // Auto target policy (coverage × size), as the pipeline does pre-seed.
    const target = [...tracks].sort(
      (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
    )[0]!;
    const sequence = targetPoseSequence(people, target);
    const ball = loadBallObservations(bundle);

    const events = loadGoldEvents().filter((event) => event.bundle === bundle);
    for (const event of events) {
      const startMs = event.eventStartMs - pad;
      const endMs = event.eventEndMs + pad;
      // peakMotionMs: dominant-wrist speed peak inside the scan window (the
      // trigger the pipeline would hand the estimator).
      const frames = toLegacyPoseFrames(sequence).filter(
        (frame) => frame.timestampMs >= startMs && frame.timestampMs <= endMs,
      );
      const peakMotionMs = wristSpeedPeakMs(frames);
      event.ballObservationsInWindow = ball.filter(
        (observation) =>
          observation.timestampMs >= startMs - 250 && observation.timestampMs <= endMs + 250,
      ).length;

      const targetWrists = wristSeries(frames);
      const ownership =
        options?.ownershipConditionedPosterior === true
          ? paddleOwnershipFromHandAffinity({ sequence, paddleCenters: null, targetWrists })
          : null;
      const estimate = estimateContact({
        sequence,
        window: { startMs, endMs, peakMotionMs },
        ballObservations: ball.length > 0 ? ball : null,
        paddleSpeeds: null,
        paddleCenters: null,
        targetWrists,
        strokeFamily: event.family,
        ...(options?.ownershipConditionedPosterior === true
          ? {
              ownershipConditionedPosterior: true,
              paddleOwnershipConfidence: ownership?.confidence ?? null,
            }
          : {}),
      });

      rows.push(
        estimate.status === "estimated"
          ? {
              event,
              status: "estimated",
              estimatedContactMs: estimate.estimatedContactMs,
              confidence: estimate.confidence,
              errorMs: Math.abs(estimate.estimatedContactMs - event.contactMs),
              reason: null,
              limitingFactors: estimate.limitingFactors,
              ballConfirmed: estimate.ballConfirmed,
              supportingEvidence: estimate.supportingEvidence.map((signal) => ({
                signal: signal.signal,
                timestampMs: Math.round(signal.timestampMs),
                weight: signal.weight,
              })),
            }
          : {
              event,
              status: "abstained",
              estimatedContactMs: null,
              confidence: null,
              errorMs: null,
              reason: estimate.reason,
              limitingFactors: estimate.limitingFactors ?? [],
              ballConfirmed: null,
              supportingEvidence: [],
            },
      );
    }
  }
  return rows;
}

interface LegacyFrame {
  timestampMs: number;
  landmarks: Array<{ name: string; x: number; y: number; visibility: number }>;
}

function wristSeries(frames: LegacyFrame[]): Array<{ timestampMs: number; x: number; y: number }> {
  const series: Array<{ timestampMs: number; x: number; y: number }> = [];
  for (const frame of frames) {
    for (const name of ["left_wrist", "right_wrist"]) {
      const joint = frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility > 0.1,
      );
      if (joint) series.push({ timestampMs: frame.timestampMs, x: joint.x, y: joint.y });
    }
  }
  return series;
}

function wristSpeedPeakMs(frames: LegacyFrame[]): number | null {
  let best: { tMs: number; speed: number } | null = null;
  for (const name of ["left_wrist", "right_wrist"]) {
    let previous: { tMs: number; x: number; y: number } | null = null;
    for (const frame of frames) {
      const joint = frame.landmarks.find(
        (landmark) => landmark.name === name && landmark.visibility > 0.1,
      );
      if (!joint) continue;
      if (previous && frame.timestampMs > previous.tMs) {
        const dt = (frame.timestampMs - previous.tMs) / 1000;
        const speed = Math.hypot(joint.x - previous.x, joint.y - previous.y) / dt;
        if (!best || speed > best.speed) best = { tMs: frame.timestampMs, speed };
      }
      previous = { tMs: frame.timestampMs, x: joint.x, y: joint.y };
    }
  }
  return best?.tMs ?? null;
}

export function quantile(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}
