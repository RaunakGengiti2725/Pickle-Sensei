import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPlayerTracks, type PeopleFile } from "../playerTracker.js";
import type { ScenesFile } from "../sceneValidity.js";
import { CORPUS_DIR, corpusPaths, loadRecordings, readAllEvents } from "./corpus.js";
import { sparseWristSuspect, trackLivenessEvidence } from "./gameplayValidity.js";
import { loadSplits } from "./splits.js";

/**
 * CORPUS-WIDE FAILURE MINING — actively hunt where the pipeline will break.
 *
 *   pnpm lab:failure-mine
 *
 * Scans every extracted dev/val recording for measurable perception stress
 * signals (no labels needed) and merges them with high-uncertainty Tier-C
 * candidates into ONE ranked annotation queue, so human labeling time is
 * always spent where the product is most likely to fail:
 *
 *   TRACK_FRAGMENTATION  — many short person tracks (identity churn)
 *   TARGET_LOSS          — long loss periods inside player tracks
 *   CROWDED_SCENE        — ≥4 concurrent people (ownership risk)
 *   SMALL_PLAYERS        — every track tiny (far court; paddle/ball starved)
 *   SCENE_CHURN          — cuts/minute so high gameplay never stabilizes
 *   NO_PEOPLE            — scenes with zero usable tracks (pose failure or
 *                          non-gameplay footage; acquisition-quality signal)
 *
 * Protected splits are excluded: failure mining implies human inspection.
 */

interface FailureItem {
  kind: string;
  recordingId: string;
  sessionKey: string;
  split: string;
  sceneIndex: number;
  windowMs: { start: number; end: number };
  severity: number; // 0..1
  evidence: string;
}

const isMain = process.argv[1]?.endsWith("failureMine.ts");
if (isMain) {
  const paths = corpusPaths();
  const splits = loadSplits(paths.splits);
  const recordings = loadRecordings().filter((recording) => {
    const split = splits.assigned[recording.sessionKey]?.split;
    return recording.derivedFrom.length === 0 && (split === "dev" || split === "val");
  });
  const items: FailureItem[] = [];

  for (const recording of recordings) {
    const runDir = join(paths.runsDir, recording.recordingId);
    if (!existsSync(join(runDir, "people.json"))) continue;
    const people = JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile;
    const scenes = JSON.parse(readFileSync(join(runDir, "scenes.json"), "utf8")) as ScenesFile;
    const split = splits.assigned[recording.sessionKey]!.split;
    const durationMin = recording.probe.durationMs / 60000;
    const cutsPerMin = durationMin > 0 ? scenes.cuts.length / durationMin : 0;
    if (cutsPerMin > 6 && recording.probe.durationMs > 60000) {
      items.push({
        kind: "SCENE_CHURN",
        recordingId: recording.recordingId,
        sessionKey: recording.sessionKey,
        split,
        sceneIndex: -1,
        windowMs: { start: 0, end: recording.probe.durationMs },
        severity: Math.min(1, cutsPerMin / 20),
        evidence: `${scenes.cuts.length} cuts in ${durationMin.toFixed(1)}min (${cutsPerMin.toFixed(1)}/min) — gameplay rarely stabilizes`,
      });
    }
    for (const [sceneIndex, segment] of scenes.segments.entries()) {
      const lengthMs = segment.endMs - segment.startMs;
      if (lengthMs < 2000) continue;
      const frames = people.frames.filter(
        (frame) => frame.t >= segment.startMs && frame.t < segment.endMs,
      );
      if (frames.length < 20) continue;
      const tracks = buildPlayerTracks({ ...people, frames });
      const window = { start: Math.round(segment.startMs), end: Math.round(segment.endMs) };
      const base = {
        recordingId: recording.recordingId,
        sessionKey: recording.sessionKey,
        split,
        sceneIndex,
        windowMs: window,
      };
      if (tracks.length === 0) {
        const peakPeople = Math.max(0, ...frames.map((frame) => frame.p.length));
        items.push({
          ...base,
          kind: "NO_PEOPLE",
          severity: 0.3,
          evidence: `scene ${Math.round(lengthMs / 1000)}s with ${peakPeople} raw detections but 0 usable tracks`,
        });
        continue;
      }
      const substantial = tracks.filter((track) => track.coverage >= 0.3);
      const meanCoverage = substantial.length
        ? substantial.reduce((total, track) => total + track.coverage, 0) / substantial.length
        : 0;
      const liveness = substantial.map((track) => trackLivenessEvidence(track));
      const staticTracks = liveness.filter((evidence) => evidence.verdict === "static_or_graphic");
      if (staticTracks.length > 0) {
        items.push({
          ...base,
          kind: "STATIC_HUMAN_GRAPHIC",
          severity: Math.min(1, 0.5 + staticTracks.length / 6),
          evidence: `${staticTracks.length}/${substantial.length} substantial tracks show no wrist-relative-to-torso motion (graphic/title-card/portrait humans) — gameplay-validity exhibit`,
        });
      }
      const sparseSuspects = liveness.filter((evidence) => sparseWristSuspect(evidence));
      if (sparseSuspects.length > 0) {
        items.push({
          ...base,
          kind: "SPARSE_WRIST_SUSPECT",
          severity: 0.45,
          evidence: `${sparseSuspects.length} tracks with sparse wrist detection + high jitter (animated graphic OR heavy motion blur — needs human review): ${sparseSuspects.map((evidence) => `${evidence.wristPairsPerSec}pairs/s@${evidence.relativeSpeedPerSec}rel/s`).join(", ")}`,
        });
      }
      const shortTracks = tracks.filter((track) => track.coverage < 0.3).length;
      if (tracks.length >= 5 && shortTracks / tracks.length >= 0.6) {
        items.push({
          ...base,
          kind: "TRACK_FRAGMENTATION",
          severity: Math.min(1, shortTracks / 10),
          evidence: `${tracks.length} tracks, ${shortTracks} short (<30% coverage) — identity churn`,
        });
      }
      const concurrent = Math.max(...frames.map((frame) => frame.p.length));
      if (concurrent >= 4) {
        items.push({
          ...base,
          kind: "CROWDED_SCENE",
          severity: Math.min(1, concurrent / 8),
          evidence: `${concurrent} concurrent people at peak — ownership/contamination stress`,
        });
      }
      for (const track of substantial) {
        const longLosses = track.lossPeriods.filter((loss) => loss.toMs - loss.fromMs >= 500);
        if (longLosses.length > 0) {
          const longest = Math.max(...longLosses.map((loss) => loss.toMs - loss.fromMs));
          items.push({
            ...base,
            kind: "TARGET_LOSS",
            severity: Math.min(1, longest / 3000),
            evidence: `track p${track.trackId} (coverage ${track.coverage.toFixed(2)}) has ${longLosses.length} loss periods ≥500ms (longest ${Math.round(longest)}ms)`,
          });
        }
      }
      if (
        substantial.length > 0 &&
        substantial.every((track) => track.meanTorsoSpan < 0.06) &&
        meanCoverage > 0.5
      ) {
        items.push({
          ...base,
          kind: "SMALL_PLAYERS",
          severity: 0.5,
          evidence: `all ${substantial.length} substantial tracks have torso span <0.06 — far-court paddle/ball starvation`,
        });
      }
    }
  }

  items.sort((a, b) => b.severity - a.severity);
  writeFileSync(
    join(CORPUS_DIR, "failure-queue.json"),
    JSON.stringify(
      { generatedAtIso: new Date().toISOString(), scope: "dev+val roots", items },
      null,
      2,
    ),
  );

  // ── Unified annotation queue: failures + high-uncertainty candidates ────
  const events = readAllEvents().filter((event) => event.split === "dev" || event.split === "val");
  const queue = [
    ...items.slice(0, 60).map((item) => ({
      priority: Number((0.5 + item.severity / 2).toFixed(3)),
      kind: `FAILURE:${item.kind}`,
      ref: `${item.recordingId} scene ${item.sceneIndex} [${item.windowMs.start}–${item.windowMs.end}ms]`,
      why: item.evidence,
    })),
    ...events
      .filter((event) => event.uncertainty >= 0.7)
      .slice(0, 200)
      .map((event) => ({
        priority: event.uncertainty,
        kind: "CANDIDATE_EVENT",
        ref: event.eventId,
        why: event.reasons.join("; ") || "uncertain stroke candidate",
      })),
  ].sort((a, b) => b.priority - a.priority);
  writeFileSync(
    join(CORPUS_DIR, "annotation-queue.json"),
    JSON.stringify({ generatedAtIso: new Date().toISOString(), entries: queue }, null, 2),
  );

  const byKind = new Map<string, number>();
  for (const item of items) byKind.set(item.kind, (byKind.get(item.kind) ?? 0) + 1);
  console.log("═".repeat(66));
  console.log(`FAILURE MINING: ${items.length} findings across ${recordings.length} dev/val roots`);
  for (const [kind, count] of [...byKind.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(22)} ${count}`);
  }
  console.log(`annotation queue: ${queue.length} entries → datasets/corpus/annotation-queue.json`);
  console.log("top 10:");
  for (const entry of queue.slice(0, 10)) {
    console.log(`  ${entry.priority.toFixed(2)} ${entry.kind.padEnd(28)} ${entry.ref}`);
    console.log(`       ${entry.why}`);
  }
}
