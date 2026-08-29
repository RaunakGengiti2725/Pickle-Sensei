import { spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { PeopleFile } from "../playerTracker.js";
import type { ScenesFile } from "../sceneValidity.js";
import {
  CORPUS_DIR,
  REPO_ROOT,
  corpusPaths,
  ensureCorpus,
  loadRecordings,
  loadSources,
  saveRecordings,
  writeEventsShard,
  type RecordingRecord,
  type SplitName,
} from "./corpus.js";
import {
  computeFingerprint,
  detectOverlap,
  loadFingerprint,
  saveFingerprint,
  type OverlapMatch,
} from "./fingerprint.js";
import { mineRecording, MINER_VERSION } from "./minerCore.js";
import { assignSplit, auditSplits, loadSplits, saveSplits, type LeakageFinding } from "./splits.js";

/**
 * THE DATA FACTORY — corpus-wide, resumable, parallel stage runner.
 *
 *   pnpm lab:factory [--stage all|extract|fingerprint|dedup|mine]
 *                    [--jobs N] [--include-protected] [--force <stage>]
 *
 * Stages (per ROOT recording; derived clips are covered by their parents):
 *   extract     — native pose/people/scene extraction (Swift, expensive)
 *   fingerprint — temporal dHash sequence (every recording, cheap)
 *   dedup       — corpus-wide overlap detection; merges sessions on detected
 *                 duplication so splits can never straddle the same pixels
 *   mine        — Tier-C StrokeEvent candidates → events/<recId>.jsonl
 *
 * Resumability: factory-state.json records status+stageVersion per recording
 * per stage; content-addressed recordingIds mean a re-registered file never
 * recomputes. Failures are recorded and skipped, never fatal to the run.
 *
 * PROTECTED SPLITS: mining implies humans will read candidate lists, so by
 * default only dev/val recordings are mined. locked_test requires
 * --include-protected; shadow is NEVER mined here — it must stay untouched.
 */

const SWIFT_BIN = join(REPO_ROOT, "native/swing-lab/.build/release/swing-lab");
const STAGE_VERSIONS = {
  extract: "extract-v5",
  fingerprint: "dhash64-9x8-gray@1fps",
  mine: MINER_VERSION,
} as const;

type StageName = keyof typeof STAGE_VERSIONS;

interface StageStatus {
  status: "done" | "failed";
  stageVersion: string;
  atIso: string;
  ms: number;
  error?: string;
  detail?: string;
}

interface FactoryState {
  schemaVersion: 1;
  recordings: Record<string, Partial<Record<StageName, StageStatus>>>;
}

function loadState(path: string): FactoryState {
  return existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as FactoryState)
    : { schemaVersion: 1, recordings: {} };
}

function saveState(path: string, state: FactoryState): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

function isDone(state: FactoryState, recordingId: string, stage: StageName): boolean {
  const status = state.recordings[recordingId]?.[stage];
  return status?.status === "done" && status.stageVersion === STAGE_VERSIONS[stage];
}

function record(
  state: FactoryState,
  statePath: string,
  recordingId: string,
  stage: StageName,
  status: StageStatus,
): void {
  state.recordings[recordingId] = { ...state.recordings[recordingId], [stage]: status };
  saveState(statePath, state);
}

async function pool<T>(items: T[], jobs: number, work: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, jobs) }, async () => {
    for (;;) {
      const item = queue.shift();
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(workers);
}

function spawnCapture(bin: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderrTail = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    child.on("error", rejectPromise);
    child.on("close", (code) =>
      code === 0 ? resolvePromise() : rejectPromise(new Error(`exit ${code}: ${stderrTail}`)),
    );
  });
}

const isRoot = (recording: RecordingRecord) => recording.derivedFrom.length === 0;

/** Adopt extraction artifacts computed by earlier runs instead of redoing them. */
function adoptLegacyExtraction(recording: RecordingRecord, runDir: string): boolean {
  const legacyId = recording.notes?.match(/legacy id: ([\w-]+)/)?.[1];
  if (!legacyId) return false;
  for (const candidateDir of [join(REPO_ROOT, "datasets/mining", legacyId)]) {
    if (
      !existsSync(join(candidateDir, "people.json")) ||
      !existsSync(join(candidateDir, "scenes.json"))
    )
      continue;
    mkdirSync(runDir, { recursive: true });
    for (const file of [
      "pose.json",
      "people.json",
      "scenes.json",
      "ball.json",
      "extract-meta.json",
    ]) {
      if (existsSync(join(candidateDir, file)))
        copyFileSync(join(candidateDir, file), join(runDir, file));
    }
    return true;
  }
  return false;
}

async function stageExtract(
  recordings: RecordingRecord[],
  state: FactoryState,
  statePath: string,
  jobs: number,
) {
  const paths = corpusPaths();
  const pending = recordings.filter(
    (recording) => isRoot(recording) && !isDone(state, recording.recordingId, "extract"),
  );
  console.log(
    `extract: ${pending.length} pending of ${recordings.filter(isRoot).length} root recordings`,
  );
  await pool(pending, jobs, async (recording) => {
    const started = Date.now();
    const runDir = join(paths.runsDir, recording.recordingId);
    try {
      let detail = "extracted";
      if (adoptLegacyExtraction(recording, runDir)) {
        detail = "adopted from datasets/mining (identical content, earlier run)";
      } else {
        mkdirSync(runDir, { recursive: true });
        await spawnCapture(SWIFT_BIN, [
          "extract",
          join(REPO_ROOT, recording.path),
          "--out",
          runDir,
        ]);
      }
      record(state, statePath, recording.recordingId, "extract", {
        status: "done",
        stageVersion: STAGE_VERSIONS.extract,
        atIso: new Date().toISOString(),
        ms: Date.now() - started,
        detail,
      });
      console.log(
        `  ✓ extract ${recording.recordingId} (${((Date.now() - started) / 1000).toFixed(1)}s · ${detail})`,
      );
    } catch (error) {
      record(state, statePath, recording.recordingId, "extract", {
        status: "failed",
        stageVersion: STAGE_VERSIONS.extract,
        atIso: new Date().toISOString(),
        ms: Date.now() - started,
        error: String(error).slice(0, 500),
      });
      console.log(`  ✗ extract ${recording.recordingId}: ${String(error).slice(0, 200)}`);
    }
  });
}

async function stageFingerprint(
  recordings: RecordingRecord[],
  state: FactoryState,
  statePath: string,
  jobs: number,
) {
  const paths = corpusPaths();
  const pending = recordings.filter(
    (recording) => !isDone(state, recording.recordingId, "fingerprint"),
  );
  console.log(`fingerprint: ${pending.length} pending of ${recordings.length} recordings`);
  await pool(pending, jobs, async (recording) => {
    const started = Date.now();
    try {
      const fingerprint = computeFingerprint(join(REPO_ROOT, recording.path));
      saveFingerprint(paths.fingerprintsDir, recording.recordingId, fingerprint);
      record(state, statePath, recording.recordingId, "fingerprint", {
        status: "done",
        stageVersion: STAGE_VERSIONS.fingerprint,
        atIso: new Date().toISOString(),
        ms: Date.now() - started,
        detail: `${fingerprint.hashes.length} sampled seconds`,
      });
    } catch (error) {
      record(state, statePath, recording.recordingId, "fingerprint", {
        status: "failed",
        stageVersion: STAGE_VERSIONS.fingerprint,
        atIso: new Date().toISOString(),
        ms: Date.now() - started,
        error: String(error).slice(0, 500),
      });
    }
  });
}

interface DedupFinding {
  recordingA: string;
  recordingB: string;
  match: OverlapMatch;
  declared: boolean;
  action: string;
}

/**
 * Corpus-wide overlap audit. Declared lineage is expected; DETECTED overlap
 * without declaration is the dangerous case — the two recordings are merged
 * into one session so they can never land in different splits.
 */
function stageDedup(recordings: RecordingRecord[]): {
  findings: DedupFinding[];
  leakage: LeakageFinding[];
} {
  const paths = corpusPaths();
  const findings: DedupFinding[] = [];
  const leakage: LeakageFinding[] = [];
  const splits = loadSplits(paths.splits);
  const prints = new Map(
    recordings.map((recording) => [
      recording.recordingId,
      loadFingerprint(paths.fingerprintsDir, recording.recordingId),
    ]),
  );
  const declaredPairs = new Set<string>();
  for (const recording of recordings) {
    for (const lineage of recording.derivedFrom) {
      declaredPairs.add([recording.recordingId, lineage.parentRecordingId].sort().join("+"));
    }
  }
  let mutated = false;
  for (let indexA = 0; indexA < recordings.length; indexA += 1) {
    for (let indexB = indexA + 1; indexB < recordings.length; indexB += 1) {
      const a = recordings[indexA]!;
      const b = recordings[indexB]!;
      const printA = prints.get(a.recordingId);
      const printB = prints.get(b.recordingId);
      if (!printA || !printB) continue;
      const match = detectOverlap(printA, printB);
      if (!match) continue;
      const shorterSeconds = Math.min(printA.hashes.length, printB.hashes.length);
      const strong = match.alignedSeconds >= Math.min(8, shorterSeconds) && match.meanHamming <= 10;
      const pairKey = [a.recordingId, b.recordingId].sort().join("+");
      const declared = declaredPairs.has(pairKey);
      let action = "none (weak match)";
      if (strong && !declared) {
        if (a.sessionKey !== b.sessionKey) {
          // Earlier-registered recording keeps its session; the newcomer joins it.
          const [keeper, joiner] = a.registeredAtIso <= b.registeredAtIso ? [a, b] : [b, a];
          action = `MERGED SESSIONS: ${joiner.recordingId} ${joiner.sessionKey} → ${keeper.sessionKey}`;
          leakage.push({
            severity: "warning",
            message: `detected undeclared overlap ${a.recordingId}↔${b.recordingId} (${match.alignedSeconds}s aligned, hamming ${match.meanHamming}); ${action}`,
          });
          joiner.sessionKey = keeper.sessionKey;
          joiner.derivedFrom.push({
            parentRecordingId: keeper.recordingId,
            relation: "unknown_overlap",
            detail: `phash overlap: ${match.alignedSeconds}s aligned at offset ${match.offsetSec}s, mean hamming ${match.meanHamming}`,
            evidence: "detected",
          });
          assignSplit(splits, keeper.sessionKey);
          mutated = true;
        } else {
          action = "same session already (subclip family)";
        }
      } else if (strong && declared) {
        action = "declared lineage confirmed by phash";
      }
      findings.push({
        recordingA: a.recordingId,
        recordingB: b.recordingId,
        match,
        declared,
        action,
      });
    }
  }
  if (mutated) {
    saveRecordings(recordings);
    saveSplits(paths.splits, splits);
  }
  leakage.push(...auditSplits(recordings, splits));
  writeFileSync(
    join(CORPUS_DIR, "dedup-report.json"),
    JSON.stringify(
      {
        generatedAtIso: new Date().toISOString(),
        algo: STAGE_VERSIONS.fingerprint,
        limitations:
          "temporal dHash does not catch SPATIAL crops — those rely on declared lineage at registration",
        findings,
        leakage,
      },
      null,
      2,
    ),
  );
  return { findings, leakage };
}

async function stageMine(
  recordings: RecordingRecord[],
  state: FactoryState,
  statePath: string,
  jobs: number,
  includeProtected: boolean,
) {
  const paths = corpusPaths();
  const splits = loadSplits(paths.splits);
  const minable: SplitName[] = includeProtected ? ["dev", "val", "locked_test"] : ["dev", "val"];
  const eligible = recordings.filter((recording) => {
    const split = splits.assigned[recording.sessionKey]?.split;
    return (
      isRoot(recording) &&
      split !== undefined &&
      minable.includes(split) &&
      isDone(state, recording.recordingId, "extract")
    );
  });
  const pending = eligible.filter((recording) => !isDone(state, recording.recordingId, "mine"));
  const shadowCount = recordings.filter(
    (recording) => splits.assigned[recording.sessionKey]?.split === "shadow" && isRoot(recording),
  ).length;
  console.log(
    `mine: ${pending.length} pending of ${eligible.length} eligible (${shadowCount} shadow roots untouched by policy)`,
  );
  await pool(pending, jobs, async (recording) => {
    const started = Date.now();
    try {
      const runDir = join(paths.runsDir, recording.recordingId);
      const peopleFile = JSON.parse(
        readFileSync(join(runDir, "people.json"), "utf8"),
      ) as PeopleFile;
      const scenes = JSON.parse(readFileSync(join(runDir, "scenes.json"), "utf8")) as ScenesFile;
      const split = splits.assigned[recording.sessionKey]!.split;
      const events = mineRecording({ recording, split, peopleFile, scenes });
      writeEventsShard(recording.recordingId, events);
      record(state, statePath, recording.recordingId, "mine", {
        status: "done",
        stageVersion: STAGE_VERSIONS.mine,
        atIso: new Date().toISOString(),
        ms: Date.now() - started,
        detail: `${events.length} candidates · ${scenes.segments.length} scenes`,
      });
      console.log(`  ✓ mine ${recording.recordingId}: ${events.length} candidates`);
    } catch (error) {
      record(state, statePath, recording.recordingId, "mine", {
        status: "failed",
        stageVersion: STAGE_VERSIONS.mine,
        atIso: new Date().toISOString(),
        ms: Date.now() - started,
        error: String(error).slice(0, 500),
      });
      console.log(`  ✗ mine ${recording.recordingId}: ${String(error).slice(0, 200)}`);
    }
  });
}

const isMain = process.argv[1]?.endsWith("factory.ts");
if (isMain) {
  const flag = (name: string) => {
    const index = process.argv.indexOf(name);
    return index >= 0 ? (process.argv[index + 1] ?? null) : null;
  };
  const stage = (flag("--stage") ?? "all") as "all" | StageName | "dedup";
  const jobs = Number(flag("--jobs") ?? 3);
  const includeProtected = process.argv.includes("--include-protected");
  const paths = ensureCorpus();
  const state = loadState(paths.factoryState);
  const recordings = loadRecordings();
  const sources = loadSources();
  console.log(
    `factory: ${recordings.length} recordings · ${sources.length} sources · stage=${stage} · jobs=${jobs}`,
  );

  (async () => {
    if (stage === "all" || stage === "extract")
      await stageExtract(recordings, state, paths.factoryState, jobs);
    if (stage === "all" || stage === "fingerprint")
      await stageFingerprint(recordings, state, paths.factoryState, jobs);
    if (stage === "all" || stage === "dedup") {
      const { findings, leakage } = stageDedup(loadRecordings());
      const detected = findings.filter((finding) => finding.action.startsWith("MERGED"));
      console.log(
        `dedup: ${findings.length} overlap pairs · ${detected.length} undeclared→merged · ${leakage.length} leakage findings`,
      );
      for (const finding of leakage)
        console.log(`  ${finding.severity === "problem" ? "✗" : "⚠"} ${finding.message}`);
    }
    if (stage === "all" || stage === "mine")
      await stageMine(loadRecordings(), state, paths.factoryState, jobs, includeProtected);
    const failed = Object.entries(state.recordings).flatMap(([recordingId, stages]) =>
      Object.entries(stages)
        .filter(([, status]) => status.status === "failed")
        .map(([stageName]) => `${recordingId}:${stageName}`),
    );
    if (failed.length > 0) {
      console.log(`FAILED STAGES (recorded, resumable): ${failed.join(", ")}`);
      process.exitCode = 1;
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
