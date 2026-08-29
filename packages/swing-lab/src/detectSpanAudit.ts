import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { detectOfflineStrokeWindow } from "@pickle/vision-geometry";
import { REPO_ROOT } from "./engine/corpus.js";
import {
  dominantWristSpeeds,
  planDetectSpanHull,
  planDetectSpanSegments,
  segmentsCoverageMs,
} from "./detectSpanPlan.js";
import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "./playerTracker.js";
import { proposeStrokeEventsV2 } from "./strokeEvents.js";

/**
 * DETECT-SPAN AUDIT (D4-07) — replay the pipeline's pose pre-pass on the
 * committed wave-a development cases and compare the legacy hull detect span
 * against the tight per-event plan (--tight-window). Deterministic: committed
 * people.json in, numbers out; frame counts are span×fps at detector stride 1
 * (the detector adds a ±250ms halo per invocation, reported separately).
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/detectSpanAudit.ts
 */

const PB = join(REPO_ROOT, "datasets/paddle-bench");
const DETECTOR_HALO_MS = 250;

const boundsPath = join(PB, "event-bounds-wave-a.json");
const cases = (
  JSON.parse(readFileSync(boundsPath, "utf8")) as {
    cases: Array<{ id: string; labels: string; runDir: string; role?: string }>;
  }
).cases.filter((entry) => entry.role === "development");

const rows: object[] = [];
for (const benchCase of cases) {
  const peoplePath = resolve(PB, benchCase.runDir, "people.json");
  if (!existsSync(peoplePath)) continue;
  const people = JSON.parse(readFileSync(peoplePath, "utf8")) as PeopleFile;
  const tracks = buildPlayerTracks(people);
  const target = [...tracks].sort(
    (a, b) => b.coverage * b.meanTorsoSpan - a.coverage * a.meanTorsoSpan,
  )[0];
  if (!target) continue;
  const sequence = targetPoseSequence(people, target);
  const window = detectOfflineStrokeWindow(sequence);
  if (!window.ok) {
    rows.push({ caseId: benchCase.id, strokeWindow: null, note: window.failure.message });
    continue;
  }
  const strokeWindow = window.value;
  const prePass = proposeStrokeEventsV2({
    paddleSpeeds: null,
    wristSpeeds: dominantWristSpeeds(sequence, strokeWindow),
    clipStartMs: strokeWindow.startMs,
    clipEndMs: strokeWindow.endMs,
  });
  const hull = planDetectSpanHull(strokeWindow, prePass.events);
  const segments = planDetectSpanSegments(strokeWindow, prePass.events);
  const fps = people.video.fps;
  const hullMs = hull.endMs - hull.startMs;
  const tightMs = segmentsCoverageMs(segments);
  const hullInvocationMs = hullMs + 2 * DETECTOR_HALO_MS;
  const tightInvocationMs = tightMs + segments.length * 2 * DETECTOR_HALO_MS;
  rows.push({
    caseId: benchCase.id,
    fps: Math.round(fps * 100) / 100,
    strokeWindowMs: Math.round(strokeWindow.endMs - strokeWindow.startMs),
    prePassEvents: prePass.events.length,
    hullSpanMs: Math.round(hullMs),
    tightSegments: segments.length,
    tightCoveredMs: Math.round(tightMs),
    savedMs: Math.round(hullMs - tightMs),
    hullInvocationFrames: Math.round((hullInvocationMs / 1000) * fps),
    tightInvocationFrames: Math.round((tightInvocationMs / 1000) * fps),
    framesSaved: Math.round(((hullInvocationMs - tightInvocationMs) / 1000) * fps),
    identicalPlan: segments.length === 1 && Math.round(hullMs) === Math.round(tightMs),
  });
}

console.log(
  JSON.stringify({ auditor: "d4-07-clip-trim", detectorHaloMs: DETECTOR_HALO_MS, rows }, null, 2),
);
