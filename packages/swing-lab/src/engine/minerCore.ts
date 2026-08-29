import { buildPlayerTracks, targetPoseSequence, type PeopleFile } from "../playerTracker.js";
import { proposeStrokeEvents } from "../strokeEvents.js";
import type { ScenesFile } from "../sceneValidity.js";
import { eventId, type CandidateEventRecord, type RecordingRecord, type SplitName } from "./corpus.js";
import { classifyTrackLiveness, windowValidity } from "./gameplayValidity.js";

/**
 * MINER CORE — scene-safe kinematic StrokeEvent candidate generation.
 *
 * Same physics as the original lab:mine (scene segmentation → multi-person
 * tracks → per-player wrist-speed event proposals → uncertainty ranking),
 * lifted into a pure function over corpus records so the factory can run it
 * across hundreds of recordings, resumably, with stable event IDs.
 *
 * v3 WINDOWED MINING: the v2 miner silently produced ZERO candidates on long
 * continuous recordings (measured: 237s tournament recording, 4.1 people per
 * frame, wrists visible → 0 candidates) because per-scene track COVERAGE
 * collapses when players rotate through a long scene, and every track died
 * at the coverage gate. Scenes are therefore mined in overlapping windows
 * (12s, 2s overlap): coverage regains its meaning ("present during this
 * exchange"), and duplicate proposals from window overlap are merged by
 * peak-time + torso proximity.
 *
 * Output is TIER-C: candidates for annotation/failure mining, never labels.
 */

export const MINER_VERSION =
  "video-mining-4 (windowed + gameplay-validity gate: static/graphic humans produce no candidates)";

const WINDOW_MS = 12_000;
const WINDOW_STEP_MS = 10_000;

export function mineRecording(input: {
  recording: RecordingRecord;
  split: SplitName;
  peopleFile: PeopleFile;
  scenes: ScenesFile;
}): CandidateEventRecord[] {
  const { recording, split, peopleFile, scenes } = input;
  const candidates: CandidateEventRecord[] = [];
  const usableSegments = scenes.segments.filter((segment) => segment.endMs - segment.startMs >= 1500);
  for (const [sceneIndex, segment] of usableSegments.entries()) {
    for (let windowStart = segment.startMs; windowStart < segment.endMs; windowStart += WINDOW_STEP_MS) {
      const windowEnd = Math.min(windowStart + WINDOW_MS, segment.endMs);
      if (windowEnd - windowStart < 3000 && windowStart > segment.startMs) break; // tail already covered by overlap
      const windowIndex = Math.round((windowStart - segment.startMs) / WINDOW_STEP_MS);
      const windowFrames = peopleFile.frames.filter((frame) => frame.t >= windowStart && frame.t < windowEnd);
      if (windowFrames.length < 20) continue;
      const windowFile: PeopleFile = { ...peopleFile, frames: windowFrames };
      const tracks = buildPlayerTracks(windowFile);
      // GAMEPLAY VALIDITY: windows whose judgeable people are all static
      // graphics (title cards, portraits) yield no candidates; individual
      // static tracks are skipped even in otherwise-live windows.
      if (!windowValidity(tracks).valid) continue;
      for (const track of tracks.filter(
        (entry) => entry.coverage >= 0.25 && classifyTrackLiveness(entry) !== "static_or_graphic",
      ).slice(0, 4)) {
        const sequence = targetPoseSequence(windowFile, track);
        const wristSpeeds = dominantWristSpeeds(sequence.frames);
        const { events } = proposeStrokeEvents({
          paddleSpeeds: null,
          wristSpeeds,
          clipStartMs: windowStart,
          clipEndMs: windowEnd,
        });
        for (const event of events) {
          const reasons: string[] = [];
          let uncertainty = 0.35;
          if (event.prominence < 4) {
            uncertainty += 0.2;
            reasons.push("low prominence (is this a stroke at all?)");
          }
          if (event.peakSpeed > 2.2) {
            uncertainty += 0.15;
            reasons.push("very fast swing (blur risk)");
          }
          if (tracks.length >= 3) {
            uncertainty += 0.2;
            reasons.push(`${tracks.length} people in scene (ownership/contamination risk)`);
          }
          if (track.meanTorsoSpan < 0.08) {
            uncertainty += 0.2;
            reasons.push("small player (far court / small paddle+ball)");
          }
          if (track.lossPeriods.length > 0) {
            uncertainty += 0.15;
            reasons.push("target track has loss periods");
          }
          const peakFrame = track.frames.reduce((best, frame) =>
            Math.abs(frame.timestampMs - event.peakMs) < Math.abs(best.timestampMs - event.peakMs) ? frame : best,
          );
          candidates.push({
            schemaVersion: 1,
            eventId: eventId(recording.recordingId, sceneIndex, track.trackId, event.peakMs, windowIndex),
            tier: "C",
            recordingId: recording.recordingId,
            sourceId: recording.sourceId,
            sessionKey: recording.sessionKey,
            split,
            sceneIndex,
            sceneStartMs: Math.round(segment.startMs),
            sceneEndMs: Math.round(segment.endMs),
            windowIndex,
            playerTrackId: track.trackId,
            playerCoverage: Number(track.coverage.toFixed(3)),
            meanTorsoSpan: Number(track.meanTorsoSpan.toFixed(4)),
            torsoAtPeak: {
              x: Number(peakFrame.torsoMid.x.toFixed(4)),
              y: Number(peakFrame.torsoMid.y.toFixed(4)),
            },
            peopleInScene: tracks.length,
            startMs: Math.round(event.startMs),
            peakMs: Math.round(event.peakMs),
            endMs: Math.round(event.endMs),
            peakSpeed: Number(event.peakSpeed.toFixed(3)),
            prominence: Number(event.prominence.toFixed(2)),
            uncertainty: Number(Math.min(1, uncertainty).toFixed(2)),
            reasons,
            minerVersion: MINER_VERSION,
            minedAtIso: new Date().toISOString(),
          });
        }
      }
    }
  }
  return dedupeAcrossWindows(candidates).sort(
    (a, b) => b.uncertainty - a.uncertainty || b.prominence - a.prominence,
  );
}

/** Overlapping windows re-propose the same swing: same scene, peaks within
 * 200ms, torsos within 0.08 → keep the higher-prominence proposal. */
function dedupeAcrossWindows(candidates: CandidateEventRecord[]): CandidateEventRecord[] {
  const byTime = [...candidates].sort((a, b) => a.peakMs - b.peakMs);
  const kept: CandidateEventRecord[] = [];
  for (const candidate of byTime) {
    const duplicate = kept.find(
      (existing) =>
        existing.sceneIndex === candidate.sceneIndex &&
        Math.abs(existing.peakMs - candidate.peakMs) <= 200 &&
        Math.hypot(
          existing.torsoAtPeak.x - candidate.torsoAtPeak.x,
          existing.torsoAtPeak.y - candidate.torsoAtPeak.y,
        ) <= 0.08,
    );
    if (!duplicate) kept.push(candidate);
    else if (candidate.prominence > duplicate.prominence) kept[kept.indexOf(duplicate)] = candidate;
  }
  return kept;
}

export function dominantWristSpeeds(
  frames: ReadonlyArray<{ timestampMs: number; landmarks: ReadonlyArray<{ name: string; x: number; y: number; visibility: number }> }>,
): Array<{ timestampMs: number; value: number }> {
  const perWrist: Record<"left" | "right", Array<{ timestampMs: number; value: number }>> = { left: [], right: [] };
  const travel = { left: 0, right: 0 };
  const last: Record<string, { x: number; y: number } | undefined> = {};
  for (const frame of frames) {
    for (const side of ["left", "right"] as const) {
      const mark = frame.landmarks.find(
        (landmark) => landmark.name === `${side}_wrist` && landmark.visibility >= 0.25,
      );
      if (!mark) continue;
      const prior = last[side];
      if (prior) {
        const previousSample = perWrist[side][perWrist[side].length - 1];
        const dtSec = previousSample ? (frame.timestampMs - previousSample.timestampMs) / 1000 : 0.04;
        const step = Math.hypot(mark.x - prior.x, mark.y - prior.y);
        if (dtSec > 0 && dtSec <= 0.15) {
          perWrist[side].push({ timestampMs: frame.timestampMs, value: step / dtSec });
          travel[side] += step;
        }
      }
      last[side] = { x: mark.x, y: mark.y };
    }
  }
  return travel.right >= travel.left ? perWrist.right : perWrist.left;
}
