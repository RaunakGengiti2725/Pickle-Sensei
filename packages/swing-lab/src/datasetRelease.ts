import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { StrokeEventLabel, SwingAnnotation } from "./annotationSchema.js";
import { corpusPaths, loadRecordings, loadSources, readAllEvents } from "./engine/corpus.js";
import { trainingEligible } from "./engine/rights.js";
import { auditSplits, loadSplits } from "./engine/splits.js";
import { gateEventForTraining } from "./trainingGate.js";

/**
 * Canonical immutable dataset releases: pickle-real-vX.Y
 *
 *   pnpm lab:dataset-release <version>
 *
 * - Scans the CORPUS (sources/recordings/splits/events) + bench manifests +
 *   annotations.
 * - Runs integrity checks (provenance, per-modality rights, duplicates,
 *   lineage-aware leakage, label sanity, bench↔corpus hash consistency).
 * - Emits datasets/releases/pickle-real-vX.Y/manifest.json with SHA-256
 *   hashes of every referenced artifact, the 4-layer split ladder, per-event
 *   training-ready records, TIER accounting (GOLD human labels vs Tier-C
 *   machine candidates — never conflated), and explicit exclusions.
 * - Refuses to overwrite an existing release directory (immutability).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const PB = join(ROOT, "datasets/paddle-bench");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface RegistryVideo {
  id: string;
  file: string;
  source: string;
  license: string;
  provenance: string;
  realFootage: boolean;
  sessionKey?: string;
  description?: string;
  cameraAngle?: string;
}

interface BenchCase {
  id: string;
  video: string;
  labels: string;
  runDir: string;
  sourceKey?: string;
  sessionKey?: string;
  role?: string;
}

const isMain = process.argv[1]?.endsWith("datasetRelease.ts");
if (isMain) {
  const version = process.argv[2] ?? "pickle-real-v0.2";
  const releaseDir = join(ROOT, "datasets/releases", version);
  if (existsSync(releaseDir)) {
    console.error(`release ${version} already exists — releases are immutable; bump the version`);
    process.exit(2);
  }

  const registry = JSON.parse(readFileSync(join(PB, "registry.json"), "utf8")) as {
    videos: RegistryVideo[];
  };
  const bench = JSON.parse(readFileSync(join(PB, "paddle-bench.json"), "utf8")) as {
    cases: BenchCase[];
  };

  const problems: string[] = [];
  const warnings: string[] = [];

  // ── Duplicate/subclip audit: file hashes + derived-from mapping ────────
  const fileHashes = new Map<string, string[]>();
  for (const video of registry.videos) {
    const path = join(PB, video.file);
    if (!existsSync(path)) {
      problems.push(`registered file missing: ${video.file}`);
      continue;
    }
    const hash = sha256(path);
    fileHashes.set(hash, [...(fileHashes.get(hash) ?? []), video.id]);
    if (!video.license) problems.push(`missing license: ${video.id}`);
    if (!video.source) problems.push(`missing source/provenance: ${video.id}`);
  }
  for (const [hash, ids] of fileHashes) {
    if (ids.length > 1)
      problems.push(
        `byte-identical files registered twice: ${ids.join(", ")} (${hash.slice(0, 12)})`,
      );
  }
  // Unique SOURCE recordings (subclips of one recording are NOT independent).
  const uniqueSources = new Set(
    registry.videos.filter((video) => video.realFootage).map((video) => video.source),
  );

  // ── Cases, annotations, label sanity ───────────────────────────────────
  interface EventRecord {
    exampleId: string;
    caseId: string;
    sessionKey: string;
    split: string;
    event: StrokeEventLabel;
    strokeV3: string | null;
    contactUncertainty: string | null;
    refs: Record<string, { path: string; sha256: string } | null>;
    masks: { paddleTrack: boolean; ballTrack: boolean; contactEstimate: boolean };
    annotator: string;
    annotationRevision: number;
    trainingEligible: boolean;
    quarantineReasons: string[];
  }
  const events: EventRecord[] = [];
  const videoPathByCase = new Map<string, string>();
  const cases: object[] = [];
  const sessionsBySplit = new Map<string, Set<string>>();

  for (const benchCase of bench.cases) {
    const labelsPath = resolve(PB, benchCase.labels);
    const annotation = JSON.parse(readFileSync(labelsPath, "utf8")) as SwingAnnotation & {
      annotatedStrokeV3?: string;
      contactUncertainty?: string;
      eventLabels?: StrokeEventLabel[];
    };
    const split = benchCase.role ?? "unassigned";
    const session = benchCase.sessionKey ?? "unspecified";
    sessionsBySplit.set(split, (sessionsBySplit.get(split) ?? new Set()).add(session));

    // Label sanity.
    for (const frame of [...(annotation.paddleFrames ?? []), ...(annotation.ballFrames ?? [])]) {
      if (
        frame.point &&
        (frame.point.x < 0 || frame.point.x > 1 || frame.point.y < 0 || frame.point.y > 1)
      ) {
        problems.push(`${benchCase.id}: label point outside frame at ${frame.tMs}ms`);
      }
    }
    const phases = annotation.phases ?? {};
    const order = [
      "preparationStartMs",
      "accelerationStartMs",
      "contactMs",
      "followThroughEndMs",
      "recoveryEndMs",
    ]
      .map((key) => (phases as unknown as Record<string, number | null>)[key])
      .filter((value): value is number => typeof value === "number");
    for (let index = 1; index < order.length; index += 1) {
      if (order[index]! < order[index - 1]!) {
        problems.push(`${benchCase.id}: phase ordering violation`);
        break;
      }
    }
    for (const event of annotation.eventLabels ?? []) {
      if (
        event.contactMs !== null &&
        (event.contactMs < event.eventStartMs || event.contactMs > event.eventEndMs)
      ) {
        problems.push(`${benchCase.id}: contact outside event`);
      }
    }
    if (!annotation.annotatorId) problems.push(`${benchCase.id}: missing annotator id`);

    const videoPath = resolve(PB, benchCase.video);
    videoPathByCase.set(benchCase.id, videoPath);
    const runDir = resolve(PB, benchCase.runDir);
    const ref = (path: string) =>
      existsSync(path) ? { path: path.replace(`${ROOT}/`, ""), sha256: sha256(path) } : null;
    // Annotations EVOLVE (revisions append); a release must be self-contained,
    // so the annotation bytes are SNAPSHOTTED into the release directory and
    // the manifest references the frozen copy (governance fix after v0.1–v0.3
    // referenced live paths and legitimate label growth broke their hashes).
    const snapshotDir = join(releaseDir, "annotations");
    mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = join(snapshotDir, `${benchCase.id}.json`);
    writeFileSync(snapshotPath, readFileSync(labelsPath));
    const caseRefs = {
      video: ref(videoPath),
      annotation: ref(snapshotPath),
      annotationLive: ref(labelsPath),
      pose: ref(join(runDir, "pose.json")),
      people: ref(join(runDir, "people.json")),
      report: ref(join(runDir, "report.json")),
      debug: ref(join(runDir, "debug.json")),
      sequence: ref(join(runDir, "sequence.json")),
    };
    cases.push({
      caseId: benchCase.id,
      sessionKey: session,
      sourceKey: benchCase.sourceKey ?? "unspecified",
      split,
      annotators: [annotation.annotatorId],
      refs: caseRefs,
    });

    // Training-ready per-event records (target-owner events only).
    for (const [index, event] of (annotation.eventLabels ?? []).entries()) {
      if (event.owner !== "target") continue;
      const report = existsSync(join(runDir, "report.json"))
        ? (JSON.parse(readFileSync(join(runDir, "report.json"), "utf8")) as {
            paddle?: { status?: string } | null;
            ballStage?: { status?: string } | null;
            contact?: { status?: string } | null;
          })
        : null;
      events.push({
        exampleId: `${benchCase.id}#E${index + 1}`,
        caseId: benchCase.id,
        sessionKey: session,
        split,
        event,
        strokeV3: annotation.annotatedStrokeV3 ?? null,
        contactUncertainty: annotation.contactUncertainty ?? null,
        refs: caseRefs,
        masks: {
          paddleTrack: report?.paddle?.status === "tracked",
          ballTrack: report?.ballStage?.status === "tracked",
          contactEstimate: report?.contact?.status === "estimated",
        },
        annotator: annotation.annotatorId,
        annotationRevision: annotation.revision,
        trainingEligible: false,
        quarantineReasons: [],
      });
    }
  }

  // ── Leakage audit: a session must not span splits ───────────────────────
  const sessionSplits = new Map<string, Set<string>>();
  for (const [split, sessions] of sessionsBySplit) {
    for (const session of sessions) {
      sessionSplits.set(session, (sessionSplits.get(session) ?? new Set()).add(split));
    }
  }
  for (const [session, splits] of sessionSplits) {
    if (splits.size > 1) {
      const message = `session ${session} spans splits: ${[...splits].join(", ")}`;
      if (session === "wm-tournament-2014") {
        warnings.push(
          `${message} — KNOWN LIMITATION: dev volley-02 and held-out dink-01 come from one recording (different players). Acceptable only while the corpus is tiny; future releases must separate.`,
        );
      } else {
        problems.push(`LEAKAGE: ${message}`);
      }
    }
  }

  // ── CORPUS: hierarchy, rights, 4-layer ladder, tiers ────────────────────
  const corpus = corpusPaths();
  const sources = loadSources();
  const recordings = loadRecordings();
  const splitsFile = loadSplits(corpus.splits);
  const tierCEvents = readAllEvents();
  for (const finding of auditSplits(recordings, splitsFile)) {
    (finding.severity === "problem" ? problems : warnings).push(finding.message);
  }
  const rightsUnclear = sources.filter((source) => !trainingEligible(source.rights));
  for (const source of rightsUnclear) {
    warnings.push(
      `rights not training-eligible (quarantined from training): ${source.sourceId} (${source.license})`,
    );
  }
  // Bench media must be corpus recordings with identical bytes.
  const recordingByPath = new Map(
    recordings.map((recording) => [join(ROOT, recording.path), recording]),
  );
  for (const benchCase of bench.cases) {
    const videoPath = resolve(PB, benchCase.video);
    const recording = recordingByPath.get(videoPath);
    if (!recording) {
      problems.push(
        `bench case ${benchCase.id}: video not registered in corpus (${benchCase.video})`,
      );
      continue;
    }
    if (sha256(videoPath) !== recording.sha256) {
      problems.push(
        `bench case ${benchCase.id}: bytes differ from corpus recording ${recording.recordingId}`,
      );
    }
  }
  const sourceById = new Map(sources.map((source) => [source.sourceId, source]));
  for (const event of events) {
    const videoPath = videoPathByCase.get(event.caseId);
    const recording = videoPath ? recordingByPath.get(videoPath) : undefined;
    const rights = recording ? (sourceById.get(recording.sourceId)?.rights ?? null) : null;
    const gate = gateEventForTraining(event.split, rights);
    event.trainingEligible = gate.trainingEligible;
    event.quarantineReasons = gate.quarantineReasons;
    if (event.trainingEligible && event.split !== "development") {
      problems.push(
        `TRAINING GATE VIOLATION: non-development event marked eligible: ${event.exampleId}`,
      );
    }
  }
  const ladder: Record<string, { sessions: string[]; rootMinutes: number }> = {};
  for (const recording of recordings.filter((entry) => entry.derivedFrom.length === 0)) {
    const split = splitsFile.assigned[recording.sessionKey]?.split ?? "UNASSIGNED";
    ladder[split] ??= { sessions: [], rootMinutes: 0 };
    if (!ladder[split]!.sessions.includes(recording.sessionKey))
      ladder[split]!.sessions.push(recording.sessionKey);
    ladder[split]!.rootMinutes = Number(
      (ladder[split]!.rootMinutes + recording.probe.durationMs / 60000).toFixed(1),
    );
  }
  const goldLabelCounts = {
    paddleFrames: 0,
    otherPaddleFrames: 0,
    ballFrames: 0,
    contactEstimates: 0,
    strokeLabels: 0,
    phaseBoundaries: 0,
    eventLabels: 0,
  };
  for (const benchCase of bench.cases) {
    const annotation = JSON.parse(
      readFileSync(resolve(PB, benchCase.labels), "utf8"),
    ) as SwingAnnotation & {
      annotatedStrokeV3?: string;
      eventLabels?: StrokeEventLabel[];
    };
    goldLabelCounts.paddleFrames += (annotation.paddleFrames ?? []).length;
    goldLabelCounts.otherPaddleFrames += (annotation.otherPaddleFrames ?? []).length;
    goldLabelCounts.ballFrames += (annotation.ballFrames ?? []).length;
    goldLabelCounts.contactEstimates += annotation.phases?.contactMs !== null ? 1 : 0;
    goldLabelCounts.strokeLabels += annotation.annotatedStrokeV3 ? 1 : 0;
    goldLabelCounts.phaseBoundaries += Object.values(annotation.phases ?? {}).filter(
      (value) => typeof value === "number",
    ).length;
    goldLabelCounts.eventLabels += (annotation.eventLabels ?? []).length;
  }
  const taCasesPath = join(ROOT, "datasets/ta-bench/cases.json");
  const taCases = existsSync(taCasesPath)
    ? (
        JSON.parse(readFileSync(taCasesPath, "utf8")) as {
          cases: Array<{ verification: { state: string } }>;
        }
      ).cases
    : [];
  const eventsShardRefs = existsSync(corpus.eventsDir)
    ? readdirSync(corpus.eventsDir)
        .filter((name) => name.endsWith(".jsonl"))
        .map((name) => ({
          path: `datasets/corpus/events/${name}`,
          sha256: sha256(join(corpus.eventsDir, name)),
          events: readFileSync(join(corpus.eventsDir, name), "utf8")
            .split("\n")
            .filter((line) => line.trim()).length,
        }))
    : [];
  const corpusArtifact = (relativePath: string) => {
    const path = join(ROOT, relativePath);
    return existsSync(path) ? { path: relativePath, sha256: sha256(path) } : null;
  };

  const manifest = {
    datasetId: "pickle-real",
    version,
    schemaVersion: 2,
    createdAtIso: new Date().toISOString(),
    immutable: true,
    counts: {
      uniqueSources: uniqueSources.size,
      registeredFiles: registry.videos.length,
      sessions: new Set(registry.videos.map((video) => video.sessionKey ?? "unspecified")).size,
      annotatedCases: bench.cases.length,
      targetEvents: events.length,
      annotators: 1,
      expertCoaches: 0,
    },
    corpus: {
      sources: sources.length,
      sourcesByOrigin: Object.fromEntries(
        [...new Set(sources.map((source) => source.origin))].map((origin) => [
          origin,
          sources.filter((source) => source.origin === origin).length,
        ]),
      ),
      trainingEligibleSources: sources.length - rightsUnclear.length,
      rightsQuarantinedSources: rightsUnclear.length,
      recordings: recordings.length,
      rootRecordings: recordings.filter((recording) => recording.derivedFrom.length === 0).length,
      sessions: new Set(recordings.map((recording) => recording.sessionKey)).size,
      rootFootageMinutes: Number(
        recordings
          .filter((recording) => recording.derivedFrom.length === 0)
          .reduce((total, recording) => total + recording.probe.durationMs / 60000, 0)
          .toFixed(1),
      ),
      splitLadder: ladder,
      splitPolicy:
        "session-level, deterministic salted-hash assignment for new sessions; pinned (documented) for previously inspected sessions; derived recordings inherit the parent session; shadow is never mined/inspected",
    },
    tiers: {
      GOLD: {
        definition:
          "human-verified ground truth (single annotator devin-visual-v1 — second annotator still absent, recorded gap)",
        labels: goldLabelCounts,
        taBenchVerifiedCases: taCases.filter((entry) => entry.verification.state === "verified")
          .length,
      },
      SILVER: {
        definition: "verified teacher/prelabel output",
        count: 0,
        note: "no teacher output has passed verification yet — nothing is silver-washed",
      },
      TIER_C: {
        definition: "machine-mined candidates; NEVER reported as labels",
        candidateStrokeEvents: tierCEvents.length,
        byMiner: [...new Set(tierCEvents.map((event) => event.minerVersion))],
        taBenchProposedCases: taCases.filter((entry) => entry.verification.state === "proposed")
          .length,
      },
    },
    corpusArtifacts: {
      sources: corpusArtifact("datasets/corpus/sources.json"),
      recordings: corpusArtifact("datasets/corpus/recordings.json"),
      splits: corpusArtifact("datasets/corpus/splits.json"),
      dedupReport: corpusArtifact("datasets/corpus/dedup-report.json"),
      failureQueue: corpusArtifact("datasets/corpus/failure-queue.json"),
      annotationQueue: corpusArtifact("datasets/corpus/annotation-queue.json"),
      learningCurves: corpusArtifact("datasets/corpus/learning-curves.json"),
      taCases: corpusArtifact("datasets/ta-bench/cases.json"),
      eventShards: eventsShardRefs,
    },
    splitStrategy:
      "by sessionKey (player identity unavailable beyond session grouping at this corpus size); frames are never split",
    splits: Object.fromEntries(
      [...sessionsBySplit.entries()].map(([split, sessions]) => [split, [...sessions]]),
    ),
    devInspectionLog: [
      "wm-volley-02, afn-sasebo-rally1, afn-sasebo-rally2: used for identity/occlusion/event debugging",
      "wm-dink-01: held out from tuning; inspected only for annotation + causal verification",
      "afn-vic-rally1: selected from two stills; single pipeline run; no threshold iteration",
    ],
    exclusions: [
      {
        id: "wm-farplayer-return",
        reason:
          "PLAYER_ASSOCIATION_FAILURE exhibit — multi-player far-court scene, target-player concept ill-defined",
      },
      {
        id: "afn-vic-rally1 (original 22-28s cut)",
        reason:
          "SCENE_CUT_UNDETECTED — spans rally + interview shots; preserved as failure exhibit",
      },
      {
        id: "afn-infocus-pro",
        reason:
          "registered, unlabeled (clinic/interview footage; gameplay segments pending annotation)",
      },
    ],
    hardNegativePool: [
      "datasets/ball-bench/failures/BALL_FALSE_POSITIVE_BACKGROUND-wm-dink-01 (background drift track)",
      "datasets/ball-bench/failures/SCENE_CUT_UNDETECTED-afn-vic-rally1 (whiteboard-scene ball+contact false positives)",
      "datasets/ball-bench/failures/BALL_BODY_OVERLAP-afn-sasebo-rally1 (fragmentation region)",
    ],
    cases,
    events,
    problems,
    warnings,
  };

  if (problems.length > 0) {
    console.error("INTEGRITY PROBLEMS (release still written for inspection):");
    for (const problem of problems) console.error(`  ✗ ${problem}`);
  }
  for (const warning of warnings) console.log(`  ⚠ ${warning}`);
  mkdirSync(releaseDir, { recursive: true });
  const body = JSON.stringify(manifest, null, 2);
  writeFileSync(join(releaseDir, "manifest.json"), body);
  writeFileSync(
    join(releaseDir, "manifest.sha256"),
    createHash("sha256").update(body).digest("hex"),
  );
  console.log(`release written: datasets/releases/${version}`);
  console.log(
    `bench: cases ${manifest.counts.annotatedCases} · gold target events ${manifest.counts.targetEvents}`,
  );
  console.log(
    `corpus: sources ${manifest.corpus.sources} (${manifest.corpus.trainingEligibleSources} training-eligible) · recordings ${manifest.corpus.recordings} · ${manifest.corpus.rootFootageMinutes}min root footage · Tier-C candidates ${manifest.tiers.TIER_C.candidateStrokeEvents}`,
  );
  console.log(`problems ${problems.length} · warnings ${warnings.length}`);
}
