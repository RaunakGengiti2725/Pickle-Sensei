import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, corpusPaths, loadRecordings, readAllEvents } from "./engine/corpus.js";
import {
  peopleFileToReplayFrames, replayAcquisition, resampleTo30fps,
  TA_REPLAY_VERSION, START_REGION_RADIUS, REPLAY_VARIANTS, type ReplayVariant,
} from "./engine/taReplay.js";
import { loadSplits } from "./engine/splits.js";
import { buildPlayerTracks, type PeopleFile, type PlayerTrack } from "./playerTracker.js";
import { classifyTrackLiveness } from "./engine/gameplayValidity.js";
import type { ScenesFile } from "./sceneValidity.js";

/**
 * TARGET-ACQUISITION BENCH — measures the live guided-capture UX offline.
 *
 *   pnpm lab:ta-bench propose            # generate candidate cases from mined corpus scenes
 *   pnpm lab:ta-bench render [caseId]    # review PNGs (region + true target + others)
 *   pnpm lab:ta-bench run [--all]        # replay product logic, measure, write results
 *
 * A case = one scene window + one selected starting region + one TRUE target
 * (a player track verified by a human). The replay then answers, with the
 * real product constants:
 *   - did we lock? how fast? on the right person?
 *   - did ambiguity trigger? did natural motion cause a WRONG gesture lock?
 *   - after lock, does identity stay on the person (switches, loss)?
 *
 * Verification states: proposed (machine-generated, Tier-C) vs verified
 * (human looked at the render). `run` uses verified cases unless --all.
 */

const TA_DIR = join(REPO_ROOT, "datasets/ta-bench");
const CASES_PATH = join(TA_DIR, "cases.json");

interface TaCase {
  caseId: string;
  recordingId: string;
  sessionKey: string;
  split: string;
  windowMs: { start: number; end: number };
  regionNorm: { x: number; y: number };
  trueTrackId: number;
  situation: string[];
  verification: { state: "proposed" | "verified" | "rejected"; by: string; note: string };
}

interface CasesFile {
  schemaVersion: 1;
  replayVersion: string;
  cases: TaCase[];
}

function loadCases(): CasesFile {
  return existsSync(CASES_PATH)
    ? (JSON.parse(readFileSync(CASES_PATH, "utf8")) as CasesFile)
    : { schemaVersion: 1, replayVersion: TA_REPLAY_VERSION, cases: [] };
}

function saveCases(file: CasesFile): void {
  mkdirSync(TA_DIR, { recursive: true });
  writeFileSync(CASES_PATH, JSON.stringify(file, null, 2));
}

function loadRun(recordingId: string): { people: PeopleFile; scenes: ScenesFile } | null {
  const runDir = join(corpusPaths().runsDir, recordingId);
  if (!existsSync(join(runDir, "people.json"))) return null;
  return {
    people: JSON.parse(readFileSync(join(runDir, "people.json"), "utf8")) as PeopleFile,
    scenes: JSON.parse(readFileSync(join(runDir, "scenes.json"), "utf8")) as ScenesFile,
  };
}

function windowTracks(people: PeopleFile, start: number, end: number): PlayerTrack[] {
  const frames = people.frames.filter((frame) => frame.t >= start && frame.t < end);
  return buildPlayerTracks({ ...people, frames });
}

// ── propose ──────────────────────────────────────────────────────────────

function propose(includeLockedTest: boolean): void {
  const splits = loadSplits(corpusPaths().splits);
  const allowed = includeLockedTest ? ["dev", "val", "locked_test"] : ["dev", "val"];
  const recordings = loadRecordings().filter((recording) => {
    const split = splits.assigned[recording.sessionKey]?.split;
    return recording.derivedFrom.length === 0 && split !== undefined && allowed.includes(split);
  });
  const eventsByRecording = new Map<string, number>();
  for (const event of readAllEvents()) {
    eventsByRecording.set(event.recordingId, (eventsByRecording.get(event.recordingId) ?? 0) + 1);
  }
  const file = loadCases();
  const known = new Set(file.cases.map((entry) => entry.caseId));
  let added = 0;
  for (const recording of recordings) {
    const run = loadRun(recording.recordingId);
    if (!run) continue;
    for (const [sceneIndex, segment] of run.scenes.segments.entries()) {
      if (segment.endMs - segment.startMs < 3000) continue;
      // Long scenes are proposed in 12s windows (coverage must mean "present
      // during this exchange", not "present for a whole 4-minute scene").
      for (let windowStart = segment.startMs; windowStart < segment.endMs; windowStart += 10_000) {
      const windowEnd = Math.min(windowStart + 12_000, segment.endMs);
      if (windowEnd - windowStart < 3000) break;
      const windowIndex = Math.round((windowStart - segment.startMs) / 10_000);
      const tracks = windowTracks(run.people, windowStart, windowEnd);
      const substantial = tracks.filter(
        (track) =>
          track.coverage >= 0.5 &&
          track.meanTorsoSpan >= 0.05 &&
          // Gameplay validity: never propose a static/graphic human as a target.
          classifyTrackLiveness(track) !== "static_or_graphic",
      );
      for (const track of substantial) {
        const first = track.frames.slice(0, 5);
        if (first.length === 0) continue;
        const region = {
          x: Number((first.reduce((total, frame) => total + frame.torsoMid.x, 0) / first.length).toFixed(4)),
          y: Number((first.reduce((total, frame) => total + frame.torsoMid.y, 0) / first.length).toFixed(4)),
        };
        const caseId = `ta-${recording.recordingId.replace(/^rec-/, "")}-s${sceneIndex}w${windowIndex}-p${track.trackId}`;
        if (known.has(caseId)) continue;
        const othersNear = substantial.filter(
          (other) =>
            other.trackId !== track.trackId &&
            other.frames.some(
              (frame) => Math.hypot(frame.torsoMid.x - region.x, frame.torsoMid.y - region.y) <= START_REGION_RADIUS,
            ),
        ).length;
        file.cases.push({
          caseId,
          recordingId: recording.recordingId,
          sessionKey: recording.sessionKey,
          split: splits.assigned[recording.sessionKey]!.split,
          windowMs: { start: Math.round(windowStart), end: Math.round(windowEnd) },
          regionNorm: region,
          trueTrackId: track.trackId,
          situation: [
            tracks.length <= 1 ? "solo" : tracks.length === 2 ? "two_players" : "multi_player",
            ...(othersNear > 0 ? ["contested_region"] : []),
            ...(track.lossPeriods.length > 0 ? ["target_loss_periods"] : []),
            ...(track.meanTorsoSpan < 0.08 ? ["small_target"] : []),
          ],
          verification: { state: "proposed", by: "ta-bench propose (machine)", note: "unverified Tier-C case" },
        });
        known.add(caseId);
        added += 1;
      }
      }
    }
  }
  saveCases(file);
  console.log(`proposed ${added} new cases (total ${file.cases.length}) → ${CASES_PATH.replace(`${REPO_ROOT}/`, "")}`);
}

// ── render (human verification aid) ──────────────────────────────────────

function renderCase(taCase: TaCase): string | null {
  const recording = loadRecordings().find((entry) => entry.recordingId === taCase.recordingId);
  const run = loadRun(taCase.recordingId);
  if (!recording || !run) return null;
  const tracks = windowTracks(run.people, taCase.windowMs.start, taCase.windowMs.end);
  const truth = tracks.find((track) => track.trackId === taCase.trueTrackId);
  if (!truth) return null;
  const midFrame = truth.frames[Math.floor(truth.frames.length / 2)]!;
  const { w, h } = run.people.video;
  const boxes: string[] = [];
  const region = taCase.regionNorm;
  const radius = START_REGION_RADIUS;
  boxes.push(
    `drawbox=x=${Math.round((region.x - radius) * w)}:y=${Math.round((region.y - radius) * h)}:w=${Math.round(2 * radius * w)}:h=${Math.round(2 * radius * h)}:color=yellow@0.9:t=6`,
  );
  for (const track of tracks) {
    const at = track.frames.reduce((best, frame) =>
      Math.abs(frame.timestampMs - midFrame.timestampMs) < Math.abs(best.timestampMs - midFrame.timestampMs) ? frame : best,
    );
    if (Math.abs(at.timestampMs - midFrame.timestampMs) > 200) continue;
    const color = track.trackId === taCase.trueTrackId ? "lime" : "red";
    const size = Math.max(24, Math.round(at.torsoSpan * h));
    boxes.push(
      `drawbox=x=${Math.round(at.torsoMid.x * w - size / 2)}:y=${Math.round(at.torsoMid.y * h - size / 2)}:w=${size}:h=${size}:color=${color}@0.9:t=4`,
    );
  }
  const outDir = join(TA_DIR, "review");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${taCase.caseId}.png`);
  execFileSync("ffmpeg", [
    "-y", "-v", "error",
    "-ss", (midFrame.timestampMs / 1000).toFixed(3),
    "-i", join(REPO_ROOT, recording.path),
    "-vf", boxes.join(","),
    "-frames:v", "1",
    outPath,
  ]);
  return outPath;
}

// ── run ──────────────────────────────────────────────────────────────────

interface CaseResult {
  caseId: string;
  verification: string;
  situation: string[];
  outcome: "locked" | "never_locked" | "ambiguous_unresolved";
  lockSource: string | null;
  lockLatencyMs: number | null;
  lockCorrect: boolean | null;
  ambiguityEntered: boolean;
  postLock: {
    frames: number;
    onTargetFraction: number | null;
    switches: number;
    longestOffTargetMs: number;
  } | null;
}

function runCase(taCase: TaCase, variant: ReplayVariant = {}): CaseResult | null {
  const run = loadRun(taCase.recordingId);
  if (!run) return null;
  const frames = resampleTo30fps(
    peopleFileToReplayFrames(run.people, taCase.windowMs.start, taCase.windowMs.end),
  );
  const tracks = windowTracks(run.people, taCase.windowMs.start, taCase.windowMs.end);
  const truth = tracks.find((track) => track.trackId === taCase.trueTrackId);
  if (!truth) return null;
  const replay = replayAcquisition(frames, taCase.regionNorm, variant);

  const truthAt = (t: number) => {
    let best: { timestampMs: number; torsoMid: { x: number; y: number } } | null = null;
    for (const frame of truth.frames) {
      if (!best || Math.abs(frame.timestampMs - t) < Math.abs(best.timestampMs - t)) best = frame;
    }
    return best && Math.abs(best.timestampMs - t) <= 100 ? best.torsoMid : null;
  };

  let outcome: CaseResult["outcome"] = "never_locked";
  if (replay.lock) outcome = "locked";
  else if (replay.ambiguityEntered) outcome = "ambiguous_unresolved";

  let lockCorrect: boolean | null = null;
  if (replay.lock) {
    const torso = truthAt(replay.lock.t);
    lockCorrect =
      torso !== null &&
      Math.hypot(torso.x - replay.lock.torso.x, torso.y - replay.lock.torso.y) <= 0.06;
  }

  let postLock: CaseResult["postLock"] = null;
  if (replay.lock) {
    let considered = 0;
    let onTarget = 0;
    let switches = 0;
    let previousOn: boolean | null = null;
    let offStreakStart: number | null = null;
    let longestOff = 0;
    for (const pick of replay.follow) {
      const torso = truthAt(pick.t);
      if (!torso || !pick.torso) continue;
      considered += 1;
      const on = Math.hypot(torso.x - pick.torso.x, torso.y - pick.torso.y) <= 0.06;
      if (on) {
        onTarget += 1;
        if (offStreakStart !== null) {
          longestOff = Math.max(longestOff, pick.t - offStreakStart);
          offStreakStart = null;
        }
      } else if (offStreakStart === null) offStreakStart = pick.t;
      if (previousOn !== null && previousOn !== on) switches += 1;
      previousOn = on;
    }
    if (offStreakStart !== null && replay.follow.length > 0) {
      longestOff = Math.max(longestOff, replay.follow[replay.follow.length - 1]!.t - offStreakStart);
    }
    postLock = {
      frames: considered,
      onTargetFraction: considered > 0 ? Number((onTarget / considered).toFixed(3)) : null,
      switches,
      longestOffTargetMs: Math.round(longestOff),
    };
  }

  return {
    caseId: taCase.caseId,
    verification: taCase.verification.state,
    situation: taCase.situation,
    outcome,
    lockSource: replay.lock?.source ?? null,
    lockLatencyMs: replay.lock ? Math.round(replay.lock.t - taCase.windowMs.start) : null,
    lockCorrect,
    ambiguityEntered: replay.ambiguityEntered,
    postLock,
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("targetAcquisitionBench.ts");
if (isMain) {
  const mode = process.argv[2] ?? "run";
  if (mode === "propose") {
    // locked_test proposals are for the ONE-SHOT held-out evaluation only
    // (annotation-purpose inspection); shadow is never proposed.
    propose(process.argv.includes("--include-locked-test"));
  } else if (mode === "render") {
    const target = process.argv[3];
    const file = loadCases();
    const selected = target ? file.cases.filter((entry) => entry.caseId === target) : file.cases;
    for (const taCase of selected) {
      const out = renderCase(taCase);
      console.log(out ? `rendered ${out.replace(`${REPO_ROOT}/`, "")}` : `✗ cannot render ${taCase.caseId}`);
    }
  } else if (mode === "run") {
    const all = process.argv.includes("--all");
    const variantFlag = process.argv.indexOf("--variant");
    const variantName = variantFlag >= 0 ? process.argv[variantFlag + 1]! : "shipped";
    // Named variants live in the taReplay registry (shipped/legacy pinned
    // product semantics + measured ablations + wave-b bench candidates).
    const variant = REPLAY_VARIANTS[variantName];
    if (!variant) {
      console.error(`unknown --variant ${variantName} (${Object.keys(REPLAY_VARIANTS).join("|")})`);
      process.exit(2);
    }
    const splitFlag = process.argv.indexOf("--split");
    const splitFilter = splitFlag >= 0 ? process.argv[splitFlag + 1]! : null;
    const file = loadCases();
    const cases = file.cases.filter(
      (entry) =>
        (all ? entry.verification.state !== "rejected" : entry.verification.state === "verified") &&
        (splitFilter === null || entry.split === splitFilter),
    );
    if (cases.length === 0) {
      console.log(all ? "no cases" : "no VERIFIED cases — verify proposals first (lab:ta-bench render, then edit cases.json)");
      process.exit(1);
    }
    const results = cases
      .map((entry) => runCase(entry, variant))
      .filter((result): result is CaseResult => result !== null);
    const verified = results.filter((result) => result.verification === "verified");
    const summarize = (subset: CaseResult[]) => {
      const locked = subset.filter((result) => result.outcome === "locked");
      const correct = locked.filter((result) => result.lockCorrect === true);
      const latencies = locked.map((result) => result.lockLatencyMs!).sort((a, b) => a - b);
      const stable = locked.filter((result) => (result.postLock?.onTargetFraction ?? 0) >= 0.9);
      return {
        cases: subset.length,
        locked: locked.length,
        lockRate: subset.length ? Number((locked.length / subset.length).toFixed(3)) : null,
        lockCorrect: correct.length,
        lockCorrectRate: locked.length ? Number((correct.length / locked.length).toFixed(3)) : null,
        medianLockLatencyMs: latencies.length ? latencies[Math.floor(latencies.length / 2)]! : null,
        ambiguityEntered: subset.filter((result) => result.ambiguityEntered).length,
        gestureLocks: subset.filter((result) => result.lockSource === "gesture_confirmed").length,
        postLockStable90: stable.length,
        meanOnTargetFraction: locked.length
          ? Number(
              (locked.reduce((total, result) => total + (result.postLock?.onTargetFraction ?? 0), 0) / locked.length).toFixed(3),
            )
          : null,
      };
    };
    const report = {
      benchVersion: TA_REPLAY_VERSION,
      generatedAtIso: new Date().toISOString(),
      variant: { name: variantName, config: variant, shipped: variantName === "shipped" },
      constants: { START_REGION_RADIUS, framesToLock: 9, gestureElevation: 0.03, onTargetRadius: 0.06 },
      scope: all ? "all non-rejected cases (INCLUDES unverified Tier-C proposals)" : "verified cases only",
      summaryVerified: summarize(verified),
      summaryAll: summarize(results),
      results,
    };
    mkdirSync(join(TA_DIR, "results"), { recursive: true });
    const outPath = join(TA_DIR, "results", `ta-bench-${Date.now()}.json`);
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log("═".repeat(66));
    console.log(`TA BENCH · variant=${variantName} (${report.scope})`);
    console.log(JSON.stringify(report.summaryVerified, null, 2));
    if (all) console.log(`all-case view: ${JSON.stringify(report.summaryAll)}`);
    console.log(`written: ${outPath.replace(`${REPO_ROOT}/`, "")}`);
  } else {
    console.error("usage: pnpm lab:ta-bench <propose|render [caseId]|run [--all]>");
    process.exit(2);
  }
}
