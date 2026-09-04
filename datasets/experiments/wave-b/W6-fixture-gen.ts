/**
 * W6 FIXTURE GENERATOR — exports a dev-split rally run's wrist-speed series +
 * expected session-engine emissions into a static JSON fixture
 * (apps/mobile/__tests__/fixtures/sessionReplay.<runId>.json). Both the mobile
 * jest suite and the @pickle/swing-lab session-replay regression
 * (packages/swing-lab/test/sessionEngine.test.ts) replay from that tracked
 * fixture, so neither reads the gitignored run directories at test time and
 * the replay executes on CI and on fresh clones.
 *
 * Reconstruction is the SAME path as workstream E's replay validation
 * (packages/swing-lab/test/sessionEngine.test.ts reconstructRun): canonical
 * parse → tap-seeded target → scene restriction → offline window →
 * dominantWristSpeeds mirror → wrist-only batch proposals; then the series is
 * streamed per-sample through SessionEventEngine to record expected emissions.
 *
 * Run from packages/swing-lab (its tsx + deps), on a machine holding the
 * canonical run directory (datasets/paddle-bench/runs/<runId>, regenerated on
 * a Mac with `pnpm lab:regen --exec`):
 *   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-b/W6-fixture-gen.ts
 *   cd packages/swing-lab && npx tsx ../../datasets/experiments/wave-b/W6-fixture-gen.ts --run afn-sasebo-rally2
 * The generator throws (writes nothing) when the reconstruction diverges from
 * the recorded report.json (target identity, window) — the drift guards.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parsePoseSequence, toLegacyPoseFrames, type PoseSequence } from "@pickle/swing-domain";
import { detectOfflineStrokeWindow } from "@pickle/vision-geometry";
import { REPO_ROOT } from "../../../packages/swing-lab/src/engine/corpus.js";
import {
  buildPlayerTracks,
  initializeTargetFromSeed,
  targetPoseSequence,
  type PeopleFile,
} from "../../../packages/swing-lab/src/playerTracker.js";
import {
  clampToScene,
  decideScene,
  type ScenesFile,
} from "../../../packages/swing-lab/src/sceneValidity.js";
import {
  proposeStrokeEventsV2,
  type StrokeEventProposalV2,
} from "../../../packages/swing-lab/src/strokeEvents.js";
import {
  SessionEventEngine,
  type SessionStrokeEvent,
  type SpeedSample,
} from "../../../packages/swing-lab/src/sessionEngine.js";

const runFlag = process.argv.indexOf("--run");
const RUN_ID = runFlag >= 0 ? process.argv[runFlag + 1] : "afn-sasebo-rally1";
if (!RUN_ID || !/^[a-z0-9][a-z0-9-]*$/.test(RUN_ID)) {
  throw new Error(
    "usage: W6-fixture-gen.ts [--run <runId>]  (runId: lowercase letters, digits, dashes)",
  );
}
const runDir = join(REPO_ROOT, "datasets/paddle-bench/runs", RUN_ID);
if (!existsSync(join(runDir, "report.json"))) {
  throw new Error(
    `${runDir}/report.json missing — the canonical run directory is gitignored; regenerate it on a Mac with \`pnpm lab:regen --exec\``,
  );
}

interface ReportShape {
  window: { startMs: number; endMs: number; peakMotionMs: number };
  player: { targetTrackId: number; aliasTrackIds: number[]; targetCoverage: number };
  events: {
    proposals: Array<{
      eventId: string;
      startMs: number;
      endMs: number;
      peakMs: number;
      paddleConfirmed: boolean;
      paddlePeakMs: number | null;
    }>;
  };
}

/** Mirror of analyzeVideo.ts dominantWristSpeeds (same as E's test mirror). */
function mirrorDominantWristSpeeds(
  sequence: PoseSequence,
  window: { startMs: number; endMs: number },
): SpeedSample[] {
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  const perWrist: Record<"left" | "right", SpeedSample[]> = { left: [], right: [] };
  const legacy = toLegacyPoseFrames(sequence);
  for (const frame of legacy) {
    for (const sideName of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${sideName}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[sideName];
      if (prior) {
        const dtSec =
          perWrist[sideName].length > 0
            ? (frame.timestampMs - perWrist[sideName][perWrist[sideName].length - 1]!.timestampMs) /
              1000
            : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[sideName].push({ timestampMs: frame.timestampMs, value: step / dtSec });
          if (frame.timestampMs >= window.startMs && frame.timestampMs <= window.endMs) {
            travel[sideName] += step;
          }
        }
      }
      last[sideName] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}

const report = JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as ReportShape;
const meta = JSON.parse(readFileSync(join(runDir, "extract-meta.json"), "utf8")) as {
  video: { durationMs: number };
};
const parsed = parsePoseSequence(readFileSync(join(runDir, "pose.json"), "utf8"), {
  providerId: "pose.apple-vision",
  runtime: "vision_framework",
  executionTarget: "on_device",
  artifactHash: null,
});
if (!parsed.ok) throw new Error("pose parse failed");
const peopleFile = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
const tracks = buildPlayerTracks(peopleFile);
const base = tracks.find((track) => track.trackId === report.player.targetTrackId);
if (!base) throw new Error("target track missing");
const early = base.frames[Math.min(3, base.frames.length - 1)]!;
const seeded = initializeTargetFromSeed(tracks, {
  mode: "user_tapped_person",
  point: { x: early.torsoMid.x, y: early.torsoMid.y },
});
if (!seeded.ok) throw new Error("target seed failed");
if (seeded.value.identity.trackId !== report.player.targetTrackId) {
  throw new Error("reconstructed target diverged from recorded report");
}
let sequence = targetPoseSequence(peopleFile, seeded.value.target);
const scenesPath = join(runDir, "scenes.json");
let analysisSegment: { startMs: number; endMs: number } | null = null;
if (existsSync(scenesPath)) {
  const scenes = JSON.parse(readFileSync(scenesPath, "utf8")) as ScenesFile;
  const scene = decideScene(
    scenes,
    sequence.frames.map((frame) => frame.timestampMs),
  );
  if (scene.multiShot) {
    analysisSegment = scene.analysisSegment;
    sequence = {
      ...sequence,
      frames: sequence.frames.filter(
        (frame) =>
          frame.timestampMs >= scene.analysisSegment.startMs &&
          frame.timestampMs < scene.analysisSegment.endMs,
      ),
    };
  }
}
const window = detectOfflineStrokeWindow(sequence);
if (!window.ok) throw new Error("offline window failed");
let strokeWindow = window.value;
if (analysisSegment) {
  const clamped = clampToScene(strokeWindow, analysisSegment);
  if (!clamped) throw new Error("scene clamp failed");
  strokeWindow = { ...strokeWindow, startMs: clamped.startMs, endMs: clamped.endMs };
}
if (
  strokeWindow.startMs !== report.window.startMs ||
  strokeWindow.endMs !== report.window.endMs ||
  strokeWindow.peakMotionMs !== report.window.peakMotionMs
) {
  throw new Error("reconstructed window diverged from recorded report");
}
const wristSpeeds = mirrorDominantWristSpeeds(sequence, strokeWindow);
const batch = proposeStrokeEventsV2({
  paddleSpeeds: null,
  wristSpeeds,
  clipStartMs: 0,
  clipEndMs: meta.video.durationMs,
});
if (batch.source !== "wrist") throw new Error("expected wrist-sourced batch");

// Stream through the session engine to record the expected emissions.
const engine = new SessionEventEngine({
  sessionId: `w6-fixture-${RUN_ID}`,
  captureMeta: { source: "replay" },
});
const emitted: SessionStrokeEvent[] = [];
for (const sample of wristSpeeds) emitted.push(...engine.pushWristSample(sample));
emitted.push(...engine.flush());

const fixture = {
  fixtureVersion: 1,
  runId: RUN_ID,
  split: "dev",
  provenance:
    "Generated by datasets/experiments/wave-b/W6-fixture-gen.ts from datasets/paddle-bench/runs/" +
    RUN_ID +
    " via the exact workstream-E replay reconstruction (analyzeVideo.ts mirror). Do not hand-edit.",
  motionUnit: "normalized_image_units_per_second",
  wristSamples: wristSpeeds.map((sample) => ({ tMs: sample.timestampMs, v: sample.value })),
  batchProposals: batch.events.map((event: StrokeEventProposalV2) => ({
    startMs: event.startMs,
    peakMs: event.peakMs,
    endMs: event.endMs,
    peakSpeed: event.peakSpeed,
  })),
  expectedEmissions: emitted.map((event) => ({
    eventId: event.eventId,
    startMs: event.proposal.startMs,
    peakMs: event.proposal.peakMs,
    endMs: event.proposal.endMs,
    closeReason: event.closeReason,
    closedAtMs: event.closedAtMs,
  })),
  qualityNotes: engine.snapshot().qualityState.notes,
};

const outPath = join(REPO_ROOT, "apps/mobile/__tests__/fixtures", `sessionReplay.${RUN_ID}.json`);
writeFileSync(outPath, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${outPath}`);
console.log(
  `samples=${fixture.wristSamples.length} batch=${fixture.batchProposals.length} emitted=${fixture.expectedEmissions.length}`,
);
console.log(
  `closeReasons=${fixture.expectedEmissions.map((event) => event.closeReason).join(",")}`,
);
