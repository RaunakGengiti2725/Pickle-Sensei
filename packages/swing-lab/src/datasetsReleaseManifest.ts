import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATASET_RELEASE_SCHEMA_VERSION,
  validateDatasetReleaseManifest,
  type DatasetArtifactRef,
  type DatasetComponent,
  type DatasetReleaseManifest,
} from "@pickle/model-registry";
import {
  ANNOTATION_SCHEMA_VERSION,
  type StrokeEventLabel,
  type SwingAnnotation,
} from "./annotationSchema.js";
import { loadRecordings, loadSources, readAllEvents } from "./engine/corpus.js";
import { trainingEligible } from "./engine/rights.js";
import { loadSplits } from "./engine/splits.js";

/**
 * Repo-wide versioned dataset release (dataset-release-v1 schema from
 * @pickle/model-registry):
 *
 *   pnpm lab:datasets-release <version>          (default v1)
 *
 * Unlike `lab:dataset-release` (which snapshots the pickle-real bench/corpus
 * training view), this describes EVERY dataset directory under datasets/ —
 * with each component honestly classified, machine-generated / synthetic
 * material explicitly marked NOT-GOLD, and governance registries frozen by
 * content hash into the release directory. The resulting `version` is the
 * exact pointer target for model-registry `trainingDatasetVersion` /
 * `evaluationDatasetVersion` fields.
 *
 * Release directories are immutable: an existing version is never rewritten.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../..");
const DATASETS = join(ROOT, "datasets");
const DATASET_ID = "pickle-sensei-datasets";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

interface ComponentSpec {
  componentId: string;
  dir: string;
  description: string;
  classification: DatasetComponent["classification"];
  notGold: boolean;
  notGoldReason: string | null;
  /** Governance/registry files (relative to dir) frozen into the release. */
  freeze: string[];
}

/**
 * Every datasets/ directory must appear here exactly once; the generator
 * fails when the table and the filesystem drift.
 */
const COMPONENT_SPECS: ComponentSpec[] = [
  {
    componentId: "ball-bench",
    dir: "ball-bench",
    description:
      "ball-detection benchmark: human-labeled cases + machine run results and failure exhibits",
    classification: "mixed_human_and_machine",
    notGold: false,
    notGoldReason: null,
    freeze: ["ball-bench.json", "baselines.json", "failure-review.json"],
  },
  {
    componentId: "cascade",
    dir: "cascade",
    description: "cascade waterfall run outputs (machine measurements over the gold cases)",
    classification: "run_outputs",
    notGold: true,
    notGoldReason: "machine-generated measurements; never ground truth",
    freeze: [],
  },
  {
    componentId: "coach-review",
    dir: "coach-review",
    description:
      "coach review program artifacts: queue, DRAFT fault taxonomy, UNVALIDATED drill placeholders; coaches.json holds 0 real coaches",
    classification: "registry_metadata",
    notGold: true,
    notGoldReason:
      "no real coach reviews exist (recruitment BLOCKED_EXTERNAL); taxonomy is an engineering draft pending expert validation",
    freeze: ["queue.json", "coaches.json"],
  },
  {
    componentId: "completion-bench",
    dir: "completion-bench",
    description: "capture-completion strategy benchmark run outputs",
    classification: "run_outputs",
    notGold: true,
    notGoldReason: "machine-generated FIXED vs ADAPTIVE measurements; never ground truth",
    freeze: [],
  },
  {
    componentId: "corpus-registries",
    dir: "corpus",
    description:
      "corpus source/recording/session registries, split ladder, dedup report (human-curated governance records)",
    classification: "registry_metadata",
    notGold: false,
    notGoldReason: null,
    freeze: ["sources.json", "recordings.json", "splits.json", "dedup-report.json"],
  },
  {
    componentId: "corpus-mined-events",
    dir: "corpus/events",
    description: "tier-C machine-mined stroke-event candidates (per-recording JSONL shards)",
    classification: "machine_generated",
    notGold: true,
    notGoldReason: "miner output candidates; tier C is NEVER reported as labels",
    freeze: [],
  },
  {
    componentId: "experiments",
    dir: "experiments",
    description: "experiment records and integrity reports (machine + narrative outputs)",
    classification: "run_outputs",
    notGold: true,
    notGoldReason: "experiment bookkeeping, not labels",
    freeze: [],
  },
  {
    componentId: "mining",
    dir: "mining",
    description: "scene/candidate mining outputs from DVIDS footage",
    classification: "machine_generated",
    notGold: true,
    notGoldReason: "miner candidates and scene scores; never human labels",
    freeze: [],
  },
  {
    componentId: "ood",
    dir: "ood",
    description:
      "rights-cleared real negative clips used only to measure the pre-analysis OOD gate",
    classification: "media",
    notGold: true,
    notGoldReason: "negative-only media for gate measurement; carries no stroke labels",
    freeze: ["registry.json"],
  },
  {
    componentId: "paddle-bench",
    dir: "paddle-bench",
    description:
      "real-video perception benchmark: registry, human GOLD annotations (single annotator), machine run artifacts",
    classification: "mixed_human_and_machine",
    notGold: false,
    notGoldReason: null,
    freeze: ["registry.json", "paddle-bench.json", "stroke-gold.json"],
  },
  {
    componentId: "pickleball",
    dir: "pickleball",
    description:
      "public-source registry, fresh unlabeled holdout candidates, first-party capture protocol + consent-first collection manifest schema",
    classification: "registry_metadata",
    notGold: true,
    notGoldReason: "source registry and unlabeled candidate media; contains no labels",
    freeze: ["registry.json", "collection_manifest.schema.json"],
  },
  {
    componentId: "releases",
    dir: "releases",
    description: "prior immutable release manifests (pickle-real-v0.x, paddle-distill-v0.1)",
    classification: "release_snapshots",
    notGold: false,
    notGoldReason: null,
    freeze: [],
  },
  {
    componentId: "ta-bench",
    dir: "ta-bench",
    description:
      "target-acquisition benchmark cases (verified cases are human-checked; proposed cases are machine candidates)",
    classification: "mixed_human_and_machine",
    notGold: false,
    notGoldReason: null,
    freeze: ["cases.json"],
  },
];

interface BenchFile {
  cases: Array<{ id: string; labels: string; role?: string; sessionKey?: string }>;
}

export function buildDatasetsReleaseManifest(
  version: string,
  releaseDir: string,
): DatasetReleaseManifest {
  const problems: string[] = [];
  const warnings: string[] = [];

  // ── Component table ↔ filesystem drift check ─────────────────────────────
  const onDisk = new Set(
    readdirSync(DATASETS, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
  const covered = new Set(COMPONENT_SPECS.map((spec) => spec.dir.split("/")[0]!));
  for (const dir of onDisk) {
    if (!covered.has(dir)) problems.push(`datasets/${dir} exists but is not described`);
  }
  for (const dir of covered) {
    if (!onDisk.has(dir)) problems.push(`described component dir missing: datasets/${dir}`);
  }

  const freezeArtifact = (spec: ComponentSpec, relative: string): DatasetArtifactRef | null => {
    const livePath = join(DATASETS, spec.dir, relative);
    if (!existsSync(livePath)) {
      problems.push(`${spec.componentId}: expected governance file missing: ${relative}`);
      return null;
    }
    const frozenDir = join(releaseDir, "artifacts", spec.componentId);
    mkdirSync(frozenDir, { recursive: true });
    const frozenPath = join(frozenDir, basename(relative));
    writeFileSync(frozenPath, readFileSync(livePath));
    return {
      path: frozenPath.replace(`${ROOT}/`, ""),
      livePath: livePath.replace(`${ROOT}/`, ""),
      sha256: sha256(frozenPath),
    };
  };

  const components: DatasetComponent[] = COMPONENT_SPECS.map((spec) => ({
    componentId: spec.componentId,
    path: `datasets/${spec.dir}`,
    description: spec.description,
    classification: spec.classification,
    notGold: spec.notGold,
    notGoldReason: spec.notGoldReason,
    artifacts: spec.freeze
      .map((relative) => freezeArtifact(spec, relative))
      .filter((ref): ref is DatasetArtifactRef => ref !== null),
  }));

  // ── Statistics from the live registries (real recounts, not claims) ─────
  const sources = loadSources();
  const recordings = loadRecordings();
  const splitsFile = loadSplits(join(DATASETS, "corpus/splits.json"));
  const tierCEvents = readAllEvents();
  const rightsQuarantined = sources.filter((source) => !trainingEligible(source.rights));

  const bench = JSON.parse(
    readFileSync(join(DATASETS, "paddle-bench/paddle-bench.json"), "utf8"),
  ) as BenchFile;
  const goldLabelCounts: Record<string, number> = {
    paddleFrames: 0,
    otherPaddleFrames: 0,
    ballFrames: 0,
    contactEstimates: 0,
    strokeLabels: 0,
    phaseBoundaries: 0,
    eventLabels: 0,
  };
  let goldTargetEvents = 0;
  const annotators = new Set<string>();
  for (const benchCase of bench.cases) {
    const annotation = JSON.parse(
      readFileSync(resolve(join(DATASETS, "paddle-bench"), benchCase.labels), "utf8"),
    ) as SwingAnnotation & { annotatedStrokeV3?: string; eventLabels?: StrokeEventLabel[] };
    annotators.add(annotation.annotatorId);
    goldLabelCounts["paddleFrames"]! += (annotation.paddleFrames ?? []).length;
    goldLabelCounts["otherPaddleFrames"]! += (annotation.otherPaddleFrames ?? []).length;
    goldLabelCounts["ballFrames"]! += (annotation.ballFrames ?? []).length;
    goldLabelCounts["contactEstimates"]! += annotation.phases?.contactMs !== null ? 1 : 0;
    goldLabelCounts["strokeLabels"]! += annotation.annotatedStrokeV3 ? 1 : 0;
    goldLabelCounts["phaseBoundaries"]! += Object.values(annotation.phases ?? {}).filter(
      (value) => typeof value === "number",
    ).length;
    goldLabelCounts["eventLabels"]! += (annotation.eventLabels ?? []).length;
    goldTargetEvents += (annotation.eventLabels ?? []).filter(
      (event) => event.owner === "target",
    ).length;
  }
  const goldLabelTotal = Object.values(goldLabelCounts).reduce((total, count) => total + count, 0);

  const bySplit: Record<string, { sessions: string[] }> = {};
  for (const [sessionKey, assignment] of Object.entries(splitsFile.assigned)) {
    bySplit[assignment.split] ??= { sessions: [] };
    bySplit[assignment.split]!.sessions.push(sessionKey);
  }

  const dedupReportPath = join(DATASETS, "corpus/dedup-report.json");
  const dedupReport = JSON.parse(readFileSync(dedupReportPath, "utf8")) as {
    algo: string;
    limitations: string;
    findings: Array<{ declared: boolean; action: string }>;
  };

  const firstPartySources = sources.filter((source) => source.origin === "first_party");

  const manifest: DatasetReleaseManifest = {
    schemaVersion: DATASET_RELEASE_SCHEMA_VERSION,
    releaseId: `${DATASET_ID}@${version}`,
    datasetId: DATASET_ID,
    version,
    createdAtIso: new Date().toISOString(),
    immutable: true,
    annotationSchemaVersion: ANNOTATION_SCHEMA_VERSION,
    components,
    statistics: {
      sources: sources.length,
      recordings: recordings.length,
      rootRecordings: recordings.filter((recording) => recording.derivedFrom.length === 0).length,
      sessions: new Set(recordings.map((recording) => recording.sessionKey)).size,
      rootFootageMinutes: Number(
        recordings
          .filter((recording) => recording.derivedFrom.length === 0)
          .reduce((total, recording) => total + recording.probe.durationMs / 60000, 0)
          .toFixed(1),
      ),
      annotatedCases: bench.cases.length,
      goldTargetEvents,
      tierCCandidateEvents: tierCEvents.length,
      goldLabelCounts,
      annotators: annotators.size,
      expertCoaches: 0,
    },
    labels: {
      GOLD: {
        definition:
          "human-verified ground truth (single annotator lineage devin-visual-v*; no second annotator yet)",
        count: goldLabelTotal,
      },
      SILVER: {
        definition: "verified teacher/prelabel output",
        count: 0,
        verificationNote: "",
      },
      TIER_C: {
        definition: "machine-mined candidates; NEVER reported as labels",
        count: tierCEvents.length,
      },
    },
    rights: {
      trainingEligibleSources: sources.length - rightsQuarantined.length,
      rightsQuarantinedSources: rightsQuarantined.length,
      policy:
        "per-modality rights (store/analyze/annotate/train/redistribute/commercial) recorded per source with legal basis; a source enters training only when train+store+analyze are affirmative — anything unclear is quarantined",
    },
    consent: {
      firstPartyRecordings: firstPartySources.length,
      analysisConsentRecords: 0,
      trainingConsentRecords: 0,
      policy:
        "consent for analysis is separate from consent for training and neither is ever implied; no first-party consent ledger records exist in this repository — first-party intake verifies an exported append-only consent ledger at runtime",
    },
    splits: {
      policyVersion: splitsFile.policyVersion,
      unit: "session",
      bySplit,
      leakageFindings: [],
    },
    dedupLineage: {
      algo: dedupReport.algo,
      findings: dedupReport.findings.length,
      declaredLineageConfirmed: dedupReport.findings.filter((finding) => finding.declared).length,
      mergedSessions: dedupReport.findings.filter((finding) =>
        finding.action.startsWith("MERGED SESSIONS"),
      ).length,
      limitations: dedupReport.limitations,
      report: {
        path: dedupReportPath.replace(`${ROOT}/`, ""),
        livePath: null,
        sha256: sha256(dedupReportPath),
      },
    },
    knownLimitations: [
      "single annotator across all GOLD labels; no second-annotator agreement measurement exists",
      "0 expert coaches — fault taxonomy and drill library are unvalidated engineering drafts",
      "no first-party recordings and no consent records; all media is public-source under recorded rights",
      "wm-tournament-2014 spans the paddle-bench development/held-out roles (one recording, different players) — documented in pickle-real releases; acceptable only while the corpus is tiny",
      "tier-C mined events (199-scale) are candidates only and are never counted as labels",
      "corpus is tiny (tens of recordings); statistics here describe availability, not model-generalization evidence",
    ],
    problems,
    warnings,
  };
  return manifest;
}

const isMain = process.argv[1]?.endsWith("datasetsReleaseManifest.ts");
if (isMain) {
  const version = process.argv[2] ?? "v1";
  const releaseDir = join(DATASETS, "releases", `${DATASET_ID}-${version}`);
  if (existsSync(releaseDir)) {
    console.error(
      `release ${DATASET_ID}-${version} already exists — releases are immutable; bump the version`,
    );
    process.exit(2);
  }
  mkdirSync(releaseDir, { recursive: true });
  const manifest = buildDatasetsReleaseManifest(version, releaseDir);
  const validation = validateDatasetReleaseManifest(manifest);
  if (validation.length > 0 || manifest.problems.length > 0) {
    console.error("RELEASE PROBLEMS (written for inspection, do not ship):");
    for (const problem of [...validation, ...manifest.problems]) console.error(`  ✗ ${problem}`);
  }
  const body = JSON.stringify(manifest, null, 2);
  writeFileSync(join(releaseDir, "manifest.json"), body);
  writeFileSync(
    join(releaseDir, "manifest.sha256"),
    createHash("sha256").update(body).digest("hex"),
  );
  console.log(`release written: datasets/releases/${DATASET_ID}-${version}`);
  console.log(
    `components ${manifest.components.length} · sources ${manifest.statistics.sources} · recordings ${manifest.statistics.recordings} · gold labels ${manifest.labels.GOLD.count} · tier-C ${manifest.labels.TIER_C.count}`,
  );
  console.log(
    `validation problems ${validation.length} · scan problems ${manifest.problems.length}`,
  );
  process.exit(validation.length > 0 || manifest.problems.length > 0 ? 1 : 0);
}
