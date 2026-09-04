import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SELECTABLE_TECHNIQUES_V1 } from "@pickle/shared-types";
import type { BallFrameLabel, PaddleFrameLabel, StrokeEventLabel } from "./annotationSchema.js";
import {
  compatibleTechniques,
  V3_LEAF_FAMILY,
  validateStrokeGoldFile,
  type StrokeGoldFile,
  type StrokeGoldLabel,
} from "./strokeTaxonomyBench.js";

/**
 * GOLD COVERAGE AUDIT — what the COMMITTED gold corpus can and cannot
 * measure, counted from the label files themselves.
 *
 *   pnpm --filter @pickle/swing-lab exec tsx src/goldCoverageAudit.ts \
 *     --out-dir /tmp/gold-coverage
 *
 * Read-only over datasets/. Every count in the output names the file(s) it
 * was derived from, and every dimension states its evidence class:
 *
 *  - gold_label            a human label in a committed annotation file
 *                          (stroke-gold.json events, bundle annotations,
 *                          Wave-F declared stroke observations, ta-bench
 *                          verified windows, ownership-review sidecar);
 *  - registry_metadata     a structured field in datasets/paddle-bench/
 *                          registry.json (cameraAngle) — describes the
 *                          footage, not a per-event label;
 *  - free_text_keyword     a regex hit inside a human-written description
 *                          (lighting has NO structured field anywhere in
 *                          datasets/, so this is the only signal and it is
 *                          reported as such, never as a label count);
 *  - absent                the schema has no field for it, or the field is
 *                          present but empty everywhere (reported as 0 with
 *                          the field name, never omitted).
 *
 * Nothing is inferred beyond what a file states: an event whose gold cannot
 * be mapped to exactly one product stroke class is counted as "ambiguous"
 * for each candidate class and is NOT added to any class's exact count.
 * Product claims are quoted verbatim from docs/APP_STORE_SUBMISSION.md and
 * scored SUPPORTED / PARTIAL / UNVERIFIED against the counts above; UNVERIFIED
 * means "no committed gold can measure this", not "false".
 *
 * Linux-only evidence: this audit never runs the analyzer, so nothing here
 * says anything about Apple Vision / iOS runtime behaviour.
 */

export const GOLD_COVERAGE_AUDIT_VERSION = "gold-coverage-audit-v1" as const;

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = resolve(HERE, "../../..");

export type EvidenceClass = "gold_label" | "registry_metadata" | "free_text_keyword" | "absent";

export type ClaimStatus = "SUPPORTED" | "PARTIAL" | "UNVERIFIED";

/** The seven classes named in the cv-gold-coverage-gaps role text. */
export const ROLE_STROKE_CLASSES = [
  "forehand",
  "backhand",
  "serve",
  "return",
  "dink",
  "volley",
  "overhead",
] as const;
export type RoleStrokeClass = (typeof ROLE_STROKE_CLASSES)[number];

/** The twelve product-selectable classes (SELECTABLE_TECHNIQUES_V1). */
export const PRODUCT_STROKE_CLASSES: readonly string[] = SELECTABLE_TECHNIQUES_V1.map(
  (technique) => technique.canonical,
);

// ── raw inputs ──────────────────────────────────────────────────────────────

export interface InputRecord {
  path: string;
  sha256: string;
  bytes: number;
}

interface RegistryVideo {
  id: string;
  file: string;
  realFootage: boolean;
  description?: string;
  cameraAngle?: string;
  playerVisibility?: string;
  paddleVisibility?: string;
  sessionKey?: string;
}

interface BenchCase {
  id: string;
  /** Clip-specific registry video (paddle-bench.json cases only). */
  video?: string;
  sourceKey: string;
  sessionKey: string;
  role: string;
  recordingId?: string;
  runDir?: string;
}

interface ReleaseManifestV2 {
  releaseId: string;
  statistics: {
    annotatedCases: number;
    goldTargetEvents: number;
    goldLabelCounts: Record<string, number>;
  };
}

interface CorpusRecording {
  recordingId: string;
  sessionKey: string;
  path: string;
  derivedFrom?: Array<{ relation: string; detail: string }>;
  notes?: string;
}

interface SplitsFile {
  pinned: Record<string, { split: string }>;
  assigned: Record<string, { split: string } | string>;
}

interface TaCase {
  caseId: string;
  recordingId: string;
  sessionKey: string;
  split: string;
  situation: string[];
  verification: { state: string; by?: string };
}

interface OodRegistry {
  items: Array<{ id: string; category: string; role: string }>;
  derivedItems: { items: Array<{ id: string; category: string; role: string }> };
}

interface OwnershipSidecarEntry {
  caseId: string;
  tMs: number;
  owners: Record<string, string>;
}

/** Canonical SwingAnnotation shape (subset) — files without `modality`. */
interface CanonicalAnnotation {
  captureBundle: string;
  annotatorId: string;
  stroke?: string;
  annotatedStrokeV3?: string;
  handedness?: string;
  analyzable?: boolean;
  notAnalyzableReason?: string | null;
  phases?: Record<string, number | null>;
  contactUncertainty?: unknown;
  faults?: unknown[];
  paddleFrames?: PaddleFrameLabel[];
  otherPaddleFrames?: PaddleFrameLabel[];
  ballFrames?: BallFrameLabel[];
  eventLabels?: StrokeEventLabel[];
  checkpointScores?: Record<string, number | null>;
  overallScore?: number | null;
}

interface ModalityAnnotation {
  captureBundle: string;
  annotatorId: string;
  modality: string;
  records?: Array<{
    recordId?: string;
    isEvent?: boolean;
    classification?: string;
    owner?: string | null;
    declaredStroke?: string;
    confidence?: number;
  }>;
  eventPhases?: Array<{
    owner: string;
    boundaries?: Array<{ phase: string; valueMs: number | null }>;
    phases?: Record<string, number | null>;
  }>;
}

interface KindAnnotation {
  captureBundle: string;
  annotatorId: string;
  kind: string;
}

export interface AnnotationFileRecord {
  path: string;
  bundle: string;
  annotatorId: string;
  /** canonical | <modality> | <kind> | stroke_labels_mirror | unknown */
  shape: string;
}

export interface GoldCorpus {
  repoRoot: string;
  inputs: InputRecord[];
  registry: RegistryVideo[];
  benchCases: BenchCase[];
  recordings: CorpusRecording[];
  splits: SplitsFile;
  strokeGold: StrokeGoldFile;
  strokeGoldPath: string;
  annotationFiles: AnnotationFileRecord[];
  canonical: Array<{ file: AnnotationFileRecord; annotation: CanonicalAnnotation }>;
  modal: Array<{ file: AnnotationFileRecord; annotation: ModalityAnnotation }>;
  taCases: TaCase[];
  ood: OodRegistry;
  ownershipSidecar: OwnershipSidecarEntry[];
  committedPoseCases: string[];
  coachReviewCount: number;
  coachCount: number;
  coachQueueStatus: string;
  releaseManifestV2: ReleaseManifestV2 | null;
  /** datasets/corpus/learning-curves.json — committed output of learningCurve.ts (which WRITES into datasets/, so the audit never runs it). */
  learningCurves: LearningCurvesFile | null;
}

interface LearningCurvesFile {
  generatedAtIso: string;
  tasks: Array<{ task: string; source: string; cases: number }>;
}

function sha256Of(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function readJsonTracked<T>(corpusInputs: InputRecord[], repoRoot: string, absPath: string): T {
  const buffer = readFileSync(absPath);
  corpusInputs.push({
    path: relative(repoRoot, absPath),
    sha256: sha256Of(buffer),
    bytes: buffer.byteLength,
  });
  return JSON.parse(buffer.toString("utf8")) as T;
}

export function loadGoldCorpus(repoRoot: string = DEFAULT_REPO_ROOT): GoldCorpus {
  const inputs: InputRecord[] = [];
  const pb = join(repoRoot, "datasets/paddle-bench");
  const read = <T>(absPath: string): T => readJsonTracked<T>(inputs, repoRoot, absPath);

  const registry = read<{ videos: RegistryVideo[] }>(join(pb, "registry.json")).videos;
  const paddleBench = read<{ cases: BenchCase[]; excludedCases?: BenchCase[] }>(
    join(pb, "paddle-bench.json"),
  );
  const waveA = read<{ cases: BenchCase[] }>(join(pb, "event-bounds-wave-a.json"));
  const benchCases = [...paddleBench.cases, ...waveA.cases];
  const recordings = read<CorpusRecording[]>(join(repoRoot, "datasets/corpus/recordings.json"));
  const splits = read<SplitsFile>(join(repoRoot, "datasets/corpus/splits.json"));
  const strokeGoldPath = join(pb, "stroke-gold.json");
  const strokeGold = read<StrokeGoldFile>(strokeGoldPath);
  const goldProblems = validateStrokeGoldFile(strokeGold);
  if (goldProblems.length > 0) {
    throw new Error(`stroke-gold.json failed validation: ${goldProblems.join("; ")}`);
  }

  const annotationFiles: AnnotationFileRecord[] = [];
  const canonical: GoldCorpus["canonical"] = [];
  const modal: GoldCorpus["modal"] = [];
  const bundlesDir = join(pb, "bundles");
  for (const bundle of readdirSync(bundlesDir).sort()) {
    const dir = join(bundlesDir, bundle, "annotation");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".json")) continue;
      const absPath = join(dir, name);
      const raw = read<Record<string, unknown>>(absPath);
      const relPath = relative(repoRoot, absPath);
      const annotatorId = typeof raw.annotatorId === "string" ? raw.annotatorId : "unknown";
      let shape: string;
      if (typeof raw.modality === "string") {
        shape = raw.modality;
        modal.push({
          file: { path: relPath, bundle, annotatorId, shape },
          annotation: raw as unknown as ModalityAnnotation,
        });
      } else if (typeof raw.kind === "string") {
        shape = (raw as unknown as KindAnnotation).kind;
      } else if (Array.isArray(raw.strokeLabels)) {
        shape = "stroke_labels_mirror";
      } else if (Array.isArray(raw.frames) && typeof raw.auditOf === "string") {
        shape = "ownership_audit";
      } else if (typeof raw.stroke === "string" && typeof raw.handedness === "string") {
        shape = "canonical";
        canonical.push({
          file: { path: relPath, bundle, annotatorId, shape },
          annotation: raw as unknown as CanonicalAnnotation,
        });
      } else {
        shape = "unknown";
      }
      annotationFiles.push({ path: relPath, bundle, annotatorId, shape });
    }
  }

  const taCases = read<{ cases: TaCase[] }>(join(repoRoot, "datasets/ta-bench/cases.json")).cases;
  const ood = read<OodRegistry>(join(repoRoot, "datasets/ood/registry.json"));
  const sidecarPath = join(pb, "ownership-review/ownership-review.json");
  const ownershipSidecar = existsSync(sidecarPath)
    ? read<OwnershipSidecarEntry[]>(sidecarPath)
    : [];

  const committedPoseCases: string[] = [];
  for (const benchCase of benchCases) {
    if (!benchCase.runDir) continue;
    if (existsSync(join(pb, benchCase.runDir, "people.json")))
      committedPoseCases.push(benchCase.id);
  }

  const coachQueue = read<{ status?: string }>(join(repoRoot, "datasets/coach-review/queue.json"));
  const coaches = read<{ coaches?: unknown[] }>(
    join(repoRoot, "datasets/coach-review/coaches.json"),
  );
  const agreement = read<{ realReviewCount?: number; coachCount?: number }>(
    join(repoRoot, "datasets/coach-review/agreement/agreement-report.json"),
  );
  const releasePath = join(repoRoot, "datasets/releases/pickle-sensei-datasets-v2/manifest.json");
  const releaseManifestV2 = existsSync(releasePath) ? read<ReleaseManifestV2>(releasePath) : null;
  const curvesPath = join(repoRoot, "datasets/corpus/learning-curves.json");
  const learningCurves = existsSync(curvesPath) ? read<LearningCurvesFile>(curvesPath) : null;

  return {
    repoRoot,
    inputs,
    registry,
    benchCases,
    recordings,
    splits,
    strokeGold,
    strokeGoldPath: relative(repoRoot, strokeGoldPath),
    annotationFiles,
    canonical,
    modal,
    taCases,
    ood,
    ownershipSidecar,
    committedPoseCases: committedPoseCases.sort(),
    coachReviewCount: agreement.realReviewCount ?? 0,
    coachCount: Array.isArray(coaches.coaches)
      ? coaches.coaches.length
      : (agreement.coachCount ?? 0),
    coachQueueStatus: coachQueue.status ?? "(no status field)",
    releaseManifestV2,
    learningCurves,
  };
}

// ── stroke-gold → product class resolution (pure) ───────────────────────────

export interface EventResolution {
  /** Exactly one product (v3) class, or null when gold cannot commit. */
  exact: string | null;
  /** Candidate classes when the gold is consistent with several. */
  candidates: string[];
  basis: "l3" | "l1_l2" | "l1_only" | "unknown";
}

function sideOfLeaf(leaf: string): "forehand" | "backhand" | null {
  if (leaf.startsWith("FOREHAND")) return "forehand";
  if (leaf.startsWith("BACKHAND")) return "backhand";
  return null;
}

/**
 * Map one stroke-gold label to the product's v3 classes WITHOUT guessing:
 *  - l3 known → every v3 leaf whose compatible-technique set contains l3;
 *  - else l1 (+l2) known → every v3 leaf in that family whose side agrees
 *    (two_hand_backhand is a backhand at the side level; sideless leaves
 *    such as SERVE/DROP accept any side);
 *  - l1 unknown → no candidates.
 * `exact` is set only when exactly one candidate survives.
 */
export function resolveGoldEvent(
  label: Pick<StrokeGoldLabel, "l1" | "l2" | "l3">,
): EventResolution {
  if (label.l3 !== "unknown") {
    const candidates = PRODUCT_STROKE_CLASSES.filter((leaf) =>
      compatibleTechniques(leaf).includes(label.l3 as never),
    );
    return { exact: candidates.length === 1 ? candidates[0]! : null, candidates, basis: "l3" };
  }
  if (label.l1 === "unknown") return { exact: null, candidates: [], basis: "unknown" };
  const goldSide =
    label.l2 === "forehand" || label.l2 === "backhand"
      ? label.l2
      : label.l2 === "two_hand_backhand"
        ? "backhand"
        : null;
  const candidates = PRODUCT_STROKE_CLASSES.filter((leaf) => {
    if (V3_LEAF_FAMILY[leaf] !== label.l1) return false;
    const leafSide = sideOfLeaf(leaf);
    if (leafSide === null || goldSide === null) return true;
    return leafSide === goldSide;
  });
  return {
    exact: candidates.length === 1 ? candidates[0]! : null,
    candidates,
    basis: goldSide ? "l1_l2" : "l1_only",
  };
}

/** Role classes a product v3 leaf belongs to (a leaf can be in two: side + family). */
export function roleClassesOfLeaf(leaf: string): RoleStrokeClass[] {
  const classes: RoleStrokeClass[] = [];
  const side = sideOfLeaf(leaf);
  if (side) classes.push(side);
  const family = V3_LEAF_FAMILY[leaf];
  if (family === "serve") classes.push("serve");
  if (family === "return") classes.push("return");
  if (family === "dink") classes.push("dink");
  if (family === "volley") classes.push("volley");
  if (family === "overhead_lob") classes.push("overhead");
  return classes;
}

// ── coverage tables ─────────────────────────────────────────────────────────

export interface Provenance {
  path: string;
  ref: string;
}

export interface CountWithProvenance {
  count: number;
  evidenceClass: EvidenceClass;
  provenance: Provenance[];
}

export interface StrokeClassRow {
  productClass: string;
  displayName: string;
  roleClasses: RoleStrokeClass[];
  /** stroke-gold.json events resolving to EXACTLY this class. */
  goldEventsExact: CountWithProvenance;
  /** How each exact event was resolved: from a committed l3 technique, or
   *  from l1 family + l2 side alone (l3 explicitly unknown). */
  goldEventsExactByBasis: { l3: number; l1_l2: number; l1_only: number };
  goldEventsExactTarget: number;
  goldEventsExactOther: number;
  /** stroke-gold events consistent with this class but not committed to it. */
  goldEventsAmbiguous: CountWithProvenance;
  /** Distinct clips (bundles) and sessions holding an exact event. */
  clipsWithExactEvent: string[];
  sessionsWithExactEvent: string[];
  /** Exact events whose clip has a committed Linux-replayable pose run. */
  exactEventsWithCommittedPose: number;
  /** Bundle-level annotatedStrokeV3 votes (one clip = one vote set). */
  bundleLevelClips: CountWithProvenance;
  /** Wave-F declared_stroke_observation records naming this class. */
  declaredObservations: CountWithProvenance;
  status: "GOLD_EVENTS" | "BUNDLE_LEVEL_ONLY" | "NO_GOLD";
}

export interface RoleClassRow {
  roleClass: RoleStrokeClass;
  goldEventsExact: number;
  goldEventsAmbiguous: number;
  clips: string[];
  sessions: string[];
  exactEventsWithCommittedPose: number;
  bundleLevelClips: number;
  status: "GOLD_EVENTS" | "BUNDLE_LEVEL_ONLY" | "NO_GOLD";
}

export interface AngleRow {
  cameraAngle: string;
  evidenceClass: EvidenceClass;
  registryVideos: string[];
  labeledClips: string[];
  goldEvents: number;
  goldEventsExactByClass: Record<string, number>;
  sessions: string[];
  splitOfSessions: Record<string, string>;
}

export interface LightingRow {
  keyword: string;
  evidenceClass: "free_text_keyword";
  registryVideos: string[];
  labeledClips: string[];
  goldEvents: number;
  matchedText: Provenance[];
}

export interface MultiPlayerCoverage {
  goldEventsByOwner: { target: number; other: number };
  clipsWithOtherOwnedEvents: string[];
  clipsWithOnlyTargetEvents: string[];
  otherPaddleFrames: {
    filesSummed: CountWithProvenance;
    distinctBundleTimestamps: number;
    /** dataGaps.ts definition: other paddle visible AND target paddle visible within 20 ms, summed over files. */
    bothPaddlesVisibleWithin20ms: number;
    visible: number;
    occluded: number;
    absent: number;
  };
  ownershipSidecarFrames: CountWithProvenance;
  ownershipSidecarFramesWithTwoOrMorePlayers: number;
  taBenchWindows: {
    total: number;
    bySituation: Record<string, number>;
    byVerification: Record<string, number>;
    verifiedMultiPlayer: number;
    verifiedTwoPlayers: number;
    verifiedSolo: number;
    provenance: Provenance[];
  };
  structuredPlayerCountLabels: CountWithProvenance;
  registryPlayerVisibilityText: Provenance[];
}

export interface PartialVisibilityCoverage {
  notAnalyzableClips: CountWithProvenance;
  notAnalyzableReasons: Array<{ bundle: string; reason: string; path: string }>;
  targetPaddleFrames: { visible: number; occluded: number; absent: number; files: number };
  ballFrames: {
    visible: number;
    occluded: number;
    not_visible: number;
    uncertain: number;
    files: number;
  };
  censoredEventRecords: CountWithProvenance;
  taBenchTargetLossWindows: { total: number; verified: number };
  taBenchSmallTargetWindows: { total: number; verified: number };
  structuredPartialBodyLabels: CountWithProvenance;
  registryPartialFramingText: Provenance[];
}

export interface HandednessCoverage {
  evidenceClass: "gold_label";
  /** Clips by the set of explicit handedness votes across canonical passes. */
  clipsRight: string[];
  clipsLeft: string[];
  clipsUnsureOnly: string[];
  clipsConflicting: string[];
  provenance: Provenance[];
}

export interface OtherGoldModalities {
  phaseBoundaryValuesD2: CountWithProvenance;
  phaseBoundaryNullsD2: number;
  contactUncertaintyRecords: CountWithProvenance;
  faultLabels: CountWithProvenance;
  checkpointScoreLabels: CountWithProvenance;
  overallScoreLabels: CountWithProvenance;
  coachReviews: CountWithProvenance;
  qualifiedCoaches: number;
  poseKeypointGold: CountWithProvenance;
  bounceLabels: CountWithProvenance;
  oodNegativesReal: CountWithProvenance;
  oodNegativesDerived: CountWithProvenance;
  firstPartyPhoneCaptures: CountWithProvenance;
  multiAnnotatorStrokeGoldEvents: number;
}

export interface ProductClaim {
  claimId: string;
  /** Verbatim from docs/APP_STORE_SUBMISSION.md. */
  claimText: string;
  source: Provenance;
  requiredGold: string;
  goldSupport: Record<string, number | string | string[]>;
  status: ClaimStatus;
  reason: string;
}

export interface CrossCheck {
  reporter: string;
  quantity: string;
  /** null when the reporter output was not supplied / the line was not found. */
  reporterValue: number | string | null;
  auditValue: number | string;
  /** null = could not compare (reporter output missing). */
  agrees: boolean | null;
  note: string;
}

/** Raw stdout of the existing reporters, captured by the CLI and parsed here
 *  so the cross-checks compare LIVE numbers, never hard-coded ones. */
export interface ReporterOutputs {
  datasetReport?: string;
  dataGaps?: string;
  strokeTaxonomyBench?: string;
}

export interface ParsedReporterFacts {
  datasetReport: {
    paddleFrames: number | null;
    paddleVisible: number | null;
    paddleOccluded: number | null;
    ballFrames: number | null;
    eventLabels: number | null;
    otherPlayerPaddleLabels: number | null;
    strokeLabelsV3: number | null;
    presentV3: string[] | null;
    missingV3: string[] | null;
  };
  dataGaps: {
    perClassLabeled: Record<string, number> | null;
    rightHandedClips: number | null;
    dualPaddleFrames: number | null;
    priorityLines: string[] | null;
  };
  strokeTaxonomyBench: {
    labels: number | null;
    cases: number | null;
  };
}

function firstNumber(text: string | undefined, pattern: RegExp): number | null {
  if (!text) return null;
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function firstList(text: string | undefined, pattern: RegExp): string[] | null {
  if (!text) return null;
  const match = pattern.exec(text);
  if (!match?.[1]) return null;
  return match[1]
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function parseReporterOutputs(outputs: ReporterOutputs): ParsedReporterFacts {
  const dr = outputs.datasetReport;
  const dg = outputs.dataGaps;
  const tb = outputs.strokeTaxonomyBench;
  let perClass: Record<string, number> | null = null;
  if (dg) {
    perClass = {};
    for (const match of dg.matchAll(/^\S*\s+([A-Z_]+): (\d+) labeled/gm)) {
      perClass[match[1]!] = Number(match[2]);
    }
  }
  const priorityLines = dg
    ? [...dg.matchAll(/^\s+\d+\. (.+)$/gm)].map((match) => match[1]!.trim())
    : null;
  return {
    datasetReport: {
      paddleFrames: firstNumber(dr, /PADDLE labels: (\d+) frames/),
      paddleVisible: firstNumber(dr, /PADDLE labels: \d+ frames \(visible (\d+)/),
      paddleOccluded: firstNumber(dr, /PADDLE labels: \d+ frames \(visible \d+, occluded (\d+)/),
      ballFrames: firstNumber(dr, /BALL labels\s*: (\d+) frames/),
      eventLabels: firstNumber(dr, /EVENT labels: (\d+)/),
      otherPlayerPaddleLabels: firstNumber(dr, /explicit other-player paddle labels: (\d+)/),
      strokeLabelsV3: firstNumber(dr, /STROKE labels \(v3\): (\d+)/),
      presentV3: firstList(dr, /^\s+present: (.+)$/m),
      missingV3: firstList(dr, /^\s+MISSING: (.+)$/m),
    },
    dataGaps: {
      perClassLabeled: perClass,
      rightHandedClips: firstNumber(dg, /right-handed: (\d+) clips/),
      dualPaddleFrames: firstNumber(dg, /dual-paddle labeled frames[^:]*: (\d+) frames/),
      priorityLines,
    },
    strokeTaxonomyBench: {
      labels: firstNumber(tb, /labels: (\d+) across/),
      cases: firstNumber(tb, /labels: \d+ across (\d+) cases/),
    },
  };
}

export interface GoldCoverageAudit {
  schema: typeof GOLD_COVERAGE_AUDIT_VERSION;
  generatedAtIso: string;
  gitSha: string | null;
  evidencePlane: "linux_read_only_label_inventory";
  inputs: InputRecord[];
  annotationFilesByShape: Record<string, number>;
  unknownShapeFiles: string[];
  strokeGold: {
    path: string;
    labels: number;
    target: number;
    other: number;
    cases: string[];
    heldOutCasesExcludedByFile: string[];
    annotators: Record<string, number>;
    l1: Record<string, number>;
    l2: Record<string, number>;
    l3: Record<string, number>;
    l1Unknown: number;
    l3Unknown: number;
    resolution: { exact: number; ambiguous: number; unresolvable: number };
    eventsWithCommittedPose: number;
    committedPoseCases: string[];
  };
  strokeClasses: StrokeClassRow[];
  roleClasses: RoleClassRow[];
  cameraAngle: { evidenceClass: "registry_metadata"; rows: AngleRow[]; unmappedClips: string[] };
  lighting: {
    structuredField: null;
    evidenceClass: "free_text_keyword";
    rows: LightingRow[];
    clipsWithNoLightingText: string[];
    lowLightOrNightLabels: 0;
  };
  multiPlayer: MultiPlayerCoverage;
  partialVisibility: PartialVisibilityCoverage;
  handedness: HandednessCoverage;
  otherGold: OtherGoldModalities;
  claims: ProductClaim[];
  unverifiedClaims: string[];
  crossChecks: CrossCheck[];
  caveats: string[];
}

function inc(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function uniqSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

function splitOfSession(splits: SplitsFile, sessionKey: string): string {
  const pinned = splits.pinned[sessionKey];
  if (pinned) return pinned.split;
  const assigned = splits.assigned[sessionKey];
  if (typeof assigned === "string") return assigned;
  if (assigned && typeof assigned === "object") return assigned.split;
  return "unassigned";
}

const LIGHTING_KEYWORDS: ReadonlyArray<[string, RegExp]> = [
  ["indoor", /\bindoor\b/i],
  ["outdoor", /\boutdoor\b/i],
  ["daylight", /\bdaylight\b/i],
  ["overcast", /\bovercast\b/i],
  ["gym_or_hall", /\bgym(nasium)?\b|\bhall\b/i],
  ["arena", /\barena\b/i],
  ["sunny_or_bright_sun", /\bsunny\b|\bbright sun\b|\bsunlit\b/i],
  ["shadow_or_backlit", /\bshadow\w*\b|\bbacklit\b/i],
  ["low_light_or_night", /\blow[- ]light\b|\bnight\b|\bdusk\b|\bdim\b|\bfloodl\w*/i],
];

const PARTIAL_FRAMING_KEYWORDS =
  /\bcrop\w*\b|\bframe edge\b|\bpartial\w*\b|\bout of frame\b|\bcut off\b/i;

export interface AuditOptions {
  now?: Date;
  gitSha?: string | null;
  /** stdout of the existing reporters; omitted → cross-checks report agrees=null. */
  reporterOutputs?: ReporterOutputs;
}

export function buildGoldCoverageAudit(
  corpus: GoldCorpus,
  options: AuditOptions = {},
): GoldCoverageAudit {
  const now = options.now ?? new Date();
  const caveats: string[] = [];

  // ── bundle → source / session / role / angle ──
  const caseById = new Map<string, BenchCase>();
  for (const benchCase of corpus.benchCases) caseById.set(benchCase.id, benchCase);
  const registryById = new Map<string, RegistryVideo>();
  for (const video of corpus.registry) registryById.set(video.id, video);
  const recordingById = new Map<string, CorpusRecording>();
  for (const recording of corpus.recordings) recordingById.set(recording.recordingId, recording);

  const bundles = uniqSorted(corpus.annotationFiles.map((file) => file.bundle));
  const heldOutBundles = uniqSorted(
    corpus.benchCases
      .filter((benchCase) => benchCase.role === "held_out" || benchCase.role === "test_held_out")
      .map((benchCase) => benchCase.id),
  );

  const registryByFile = new Map<string, RegistryVideo>();
  for (const video of corpus.registry) registryByFile.set(video.file, video);

  /** Clip-specific registry entry when paddle-bench.json names the clip's
   *  own video file; otherwise the parent source recording's entry. */
  const registryVideoOfBundle = (bundle: string): RegistryVideo | null => {
    const benchCase = caseById.get(bundle);
    if (!benchCase) return null;
    const clipVideo = benchCase.video ? registryByFile.get(benchCase.video) : undefined;
    return clipVideo ?? registryById.get(benchCase.sourceKey) ?? null;
  };
  const angleOfBundle = (bundle: string): { angle: string; registryVideo: string | null } => {
    const benchCase = caseById.get(bundle);
    if (!benchCase) return { angle: "unmapped_bundle", registryVideo: null };
    const video = registryVideoOfBundle(bundle);
    if (!video) {
      return { angle: `unregistered_source:${benchCase.sourceKey}`, registryVideo: null };
    }
    return { angle: video.cameraAngle ?? "unspecified", registryVideo: video.id };
  };
  const sessionOfBundle = (bundle: string): string =>
    caseById.get(bundle)?.sessionKey ?? "unknown_session";

  // Free text that describes a bundle's footage (registry + corpus recording).
  const freeTextOfBundle = (bundle: string): Provenance[] => {
    const out: Provenance[] = [];
    const benchCase = caseById.get(bundle);
    if (!benchCase) return out;
    const video = registryVideoOfBundle(bundle);
    if (video) {
      for (const field of ["description", "playerVisibility", "paddleVisibility"] as const) {
        const text = video[field];
        if (text)
          out.push({
            path: "datasets/paddle-bench/registry.json",
            ref: `${video.id}.${field}: ${text}`,
          });
      }
    }
    const recording = benchCase.recordingId ? recordingById.get(benchCase.recordingId) : undefined;
    if (recording) {
      for (const derived of recording.derivedFrom ?? []) {
        out.push({
          path: "datasets/corpus/recordings.json",
          ref: `${recording.recordingId}.derivedFrom.detail: ${derived.detail}`,
        });
      }
    }
    return out;
  };

  // ── stroke gold ──
  const gold = corpus.strokeGold.labels;
  const committedPose = new Set(corpus.committedPoseCases);
  const l1: Record<string, number> = {};
  const l2: Record<string, number> = {};
  const l3: Record<string, number> = {};
  const annotators: Record<string, number> = {};
  let exactCount = 0;
  let ambiguousCount = 0;
  let unresolvable = 0;
  let eventsWithPose = 0;
  const resolved = gold.map((label, index) => {
    inc(l1, label.l1);
    inc(l2, label.l2);
    inc(l3, label.l3);
    inc(annotators, label.annotatorId);
    const resolution = resolveGoldEvent(label);
    if (resolution.exact) exactCount += 1;
    else if (resolution.candidates.length > 0) ambiguousCount += 1;
    else unresolvable += 1;
    if (committedPose.has(label.caseId)) eventsWithPose += 1;
    return { label, index, resolution };
  });
  const goldCases = uniqSorted(gold.map((label) => label.caseId));
  const heldOutInGold = goldCases.filter((caseId) => heldOutBundles.includes(caseId));
  if (heldOutInGold.length > 0) {
    caveats.push(`stroke-gold.json contains held-out cases: ${heldOutInGold.join(", ")}`);
  }

  const goldRef = (index: number, label: StrokeGoldLabel): Provenance => ({
    path: corpus.strokeGoldPath,
    ref: `labels[${index}] ${label.caseId}@${label.eventStartMs}-${label.eventEndMs} owner=${label.owner} ${label.l1}/${label.l2}/${label.l3}`,
  });

  // ── bundle-level votes + Wave-F observations ──
  const bundleVotes = new Map<string, Map<string, Provenance[]>>();
  for (const { file, annotation } of corpus.canonical) {
    if (!annotation.annotatedStrokeV3) continue;
    const votes = bundleVotes.get(file.bundle) ?? new Map<string, Provenance[]>();
    const list = votes.get(annotation.annotatedStrokeV3) ?? [];
    list.push({ path: file.path, ref: `annotatedStrokeV3=${annotation.annotatedStrokeV3}` });
    votes.set(annotation.annotatedStrokeV3, list);
    bundleVotes.set(file.bundle, votes);
  }
  for (const [bundle, votes] of bundleVotes) {
    if (votes.size > 1) {
      caveats.push(
        `bundle ${bundle} has conflicting bundle-level annotatedStrokeV3 votes: ${[...votes.keys()].join(" vs ")}`,
      );
    }
  }
  const declared = new Map<string, Provenance[]>();
  for (const { file, annotation } of corpus.modal) {
    if (annotation.modality !== "declared_stroke_observation") continue;
    for (const record of annotation.records ?? []) {
      const stroke = record.declaredStroke;
      if (!stroke) continue;
      const list = declared.get(stroke) ?? [];
      list.push({ path: file.path, ref: `${record.recordId ?? "?"} owner=${record.owner ?? "?"}` });
      declared.set(stroke, list);
    }
  }

  // ── per product class ──
  const strokeClasses: StrokeClassRow[] = SELECTABLE_TECHNIQUES_V1.map((technique) => {
    const leaf = technique.canonical;
    const exactRows = resolved.filter((row) => row.resolution.exact === leaf);
    const ambiguousRows = resolved.filter(
      (row) => row.resolution.exact === null && row.resolution.candidates.includes(leaf),
    );
    const clips = uniqSorted(exactRows.map((row) => row.label.caseId));
    const bundleClips: Provenance[] = [];
    for (const [bundle, votes] of bundleVotes) {
      const list = votes.get(leaf);
      if (list)
        bundleClips.push({ path: list[0]!.path, ref: `${bundle} (${list.length} pass(es))` });
    }
    const declaredList = declared.get(leaf) ?? [];
    const status: StrokeClassRow["status"] =
      exactRows.length > 0
        ? "GOLD_EVENTS"
        : bundleClips.length > 0 || declaredList.length > 0
          ? "BUNDLE_LEVEL_ONLY"
          : "NO_GOLD";
    return {
      productClass: leaf,
      displayName: technique.displayName,
      roleClasses: roleClassesOfLeaf(leaf),
      goldEventsExact: {
        count: exactRows.length,
        evidenceClass: "gold_label",
        provenance: exactRows.map((row) => ({
          ...goldRef(row.index, row.label),
          ref: `${goldRef(row.index, row.label).ref} basis=${row.resolution.basis}`,
        })),
      },
      goldEventsExactByBasis: {
        l3: exactRows.filter((row) => row.resolution.basis === "l3").length,
        l1_l2: exactRows.filter((row) => row.resolution.basis === "l1_l2").length,
        l1_only: exactRows.filter((row) => row.resolution.basis === "l1_only").length,
      },
      goldEventsExactTarget: exactRows.filter((row) => row.label.owner === "target").length,
      goldEventsExactOther: exactRows.filter((row) => row.label.owner === "other").length,
      goldEventsAmbiguous: {
        count: ambiguousRows.length,
        evidenceClass: "gold_label",
        provenance: ambiguousRows.map((row) => ({
          ...goldRef(row.index, row.label),
          ref: `${goldRef(row.index, row.label).ref} candidates=${row.resolution.candidates.join("|")}`,
        })),
      },
      clipsWithExactEvent: clips,
      sessionsWithExactEvent: uniqSorted(clips.map(sessionOfBundle)),
      exactEventsWithCommittedPose: exactRows.filter((row) => committedPose.has(row.label.caseId))
        .length,
      bundleLevelClips: {
        count: bundleClips.length,
        evidenceClass: "gold_label",
        provenance: bundleClips,
      },
      declaredObservations: {
        count: declaredList.length,
        evidenceClass: "gold_label",
        provenance: declaredList,
      },
      status,
    };
  });

  // ── role classes (side + family, straight from l1/l2 so no leaf mapping is needed) ──
  const roleClasses: RoleClassRow[] = ROLE_STROKE_CLASSES.map((roleClass) => {
    const matches = (label: StrokeGoldLabel): "exact" | "ambiguous" | "no" => {
      switch (roleClass) {
        case "forehand":
          return label.l2 === "forehand" ? "exact" : label.l2 === "unknown" ? "ambiguous" : "no";
        case "backhand":
          return label.l2 === "backhand" || label.l2 === "two_hand_backhand"
            ? "exact"
            : label.l2 === "unknown"
              ? "ambiguous"
              : "no";
        case "serve":
          return label.l1 === "serve" ? "exact" : label.l1 === "unknown" ? "ambiguous" : "no";
        case "return":
          return label.l1 === "return" ? "exact" : label.l1 === "unknown" ? "ambiguous" : "no";
        case "dink":
          return label.l1 === "dink" ? "exact" : label.l1 === "unknown" ? "ambiguous" : "no";
        case "volley":
          return label.l1 === "volley" ? "exact" : label.l1 === "unknown" ? "ambiguous" : "no";
        case "overhead":
          return label.l1 === "overhead_lob"
            ? "exact"
            : label.l1 === "unknown"
              ? "ambiguous"
              : "no";
      }
    };
    const exact = gold.filter((label) => matches(label) === "exact");
    const ambiguous = gold.filter((label) => matches(label) === "ambiguous");
    const clips = uniqSorted(exact.map((label) => label.caseId));
    let bundleLevel = 0;
    for (const votes of bundleVotes.values()) {
      if ([...votes.keys()].some((leaf) => roleClassesOfLeaf(leaf).includes(roleClass))) {
        bundleLevel += 1;
      }
    }
    return {
      roleClass,
      goldEventsExact: exact.length,
      goldEventsAmbiguous: ambiguous.length,
      clips,
      sessions: uniqSorted(clips.map(sessionOfBundle)),
      exactEventsWithCommittedPose: exact.filter((label) => committedPose.has(label.caseId)).length,
      bundleLevelClips: bundleLevel,
      status: exact.length > 0 ? "GOLD_EVENTS" : bundleLevel > 0 ? "BUNDLE_LEVEL_ONLY" : "NO_GOLD",
    };
  });

  // ── camera angle ──
  const angleRows = new Map<string, AngleRow>();
  const unmappedClips: string[] = [];
  for (const video of corpus.registry.filter((video) => video.realFootage)) {
    const angle = video.cameraAngle ?? "unspecified";
    const row = angleRows.get(angle) ?? {
      cameraAngle: angle,
      evidenceClass: "registry_metadata",
      registryVideos: [],
      labeledClips: [],
      goldEvents: 0,
      goldEventsExactByClass: {},
      sessions: [],
      splitOfSessions: {},
    };
    row.registryVideos.push(video.id);
    angleRows.set(angle, row);
  }
  for (const bundle of bundles) {
    const { angle } = angleOfBundle(bundle);
    if (angle === "unmapped_bundle") {
      unmappedClips.push(bundle);
      continue;
    }
    const row = angleRows.get(angle) ?? {
      cameraAngle: angle,
      evidenceClass: "registry_metadata",
      registryVideos: [],
      labeledClips: [],
      goldEvents: 0,
      goldEventsExactByClass: {},
      sessions: [],
      splitOfSessions: {},
    };
    row.labeledClips.push(bundle);
    const session = sessionOfBundle(bundle);
    if (!row.sessions.includes(session)) row.sessions.push(session);
    row.splitOfSessions[session] = splitOfSession(corpus.splits, session);
    for (const { label, resolution } of resolved) {
      if (label.caseId !== bundle) continue;
      row.goldEvents += 1;
      if (resolution.exact) inc(row.goldEventsExactByClass, resolution.exact);
    }
    angleRows.set(angle, row);
  }
  for (const row of angleRows.values()) {
    if (row.cameraAngle.startsWith("unregistered_source:")) {
      caveats.push(
        `clips ${row.labeledClips.join(", ")} come from source ${row.cameraAngle.slice("unregistered_source:".length)} which has no paddle-bench registry entry, so no structured cameraAngle exists for them (free text only)`,
      );
    }
  }

  // ── lighting (free text only) ──
  const lightingRows = new Map<string, LightingRow>();
  const clipsWithNoLightingText: string[] = [];
  for (const [keyword] of LIGHTING_KEYWORDS) {
    lightingRows.set(keyword, {
      keyword,
      evidenceClass: "free_text_keyword",
      registryVideos: [],
      labeledClips: [],
      goldEvents: 0,
      matchedText: [],
    });
  }
  for (const video of corpus.registry.filter((video) => video.realFootage)) {
    const text = [video.description, video.playerVisibility, video.paddleVisibility]
      .filter(Boolean)
      .join(" ");
    for (const [keyword, regex] of LIGHTING_KEYWORDS) {
      if (regex.test(text)) lightingRows.get(keyword)!.registryVideos.push(video.id);
    }
  }
  for (const bundle of bundles) {
    const texts = freeTextOfBundle(bundle);
    let anyHit = false;
    for (const [keyword, regex] of LIGHTING_KEYWORDS) {
      const hits = texts.filter((text) => regex.test(text.ref));
      if (hits.length === 0) continue;
      anyHit = true;
      const row = lightingRows.get(keyword)!;
      row.labeledClips.push(bundle);
      row.goldEvents += gold.filter((label) => label.caseId === bundle).length;
      for (const hit of hits)
        row.matchedText.push({ path: hit.path, ref: `${bundle} ← ${hit.ref}` });
    }
    if (!anyHit) clipsWithNoLightingText.push(bundle);
  }
  caveats.push(
    "lighting: no annotation schema, registry, corpus, or release file carries a structured lighting/illumination field; lighting rows are regex hits on human-written descriptions and are NOT label counts",
  );

  // ── multi-player ──
  const ownerCounts = { target: 0, other: 0 };
  for (const label of gold) ownerCounts[label.owner] += 1;
  const clipsWithOther = uniqSorted(
    gold.filter((label) => label.owner === "other").map((label) => label.caseId),
  );
  const clipsOnlyTarget = goldCases.filter((caseId) => !clipsWithOther.includes(caseId));

  const otherPaddleProvenance: Provenance[] = [];
  const otherPaddleDistinct = new Set<string>();
  let otherVisible = 0;
  let otherOccluded = 0;
  let otherAbsent = 0;
  let otherSummed = 0;
  let bothVisibleWithin20ms = 0;
  let rightHandedFiles = 0;
  const targetPaddle = { visible: 0, occluded: 0, absent: 0, files: 0 };
  const ball = { visible: 0, occluded: 0, not_visible: 0, uncertain: 0, files: 0 };
  const notAnalyzable: Array<{ bundle: string; reason: string; path: string }> = [];
  const handVotes = new Map<string, Map<string, Provenance[]>>();
  let faultLabels = 0;
  let checkpointLabels = 0;
  let overallLabels = 0;
  let contactUncertaintyRecords = 0;
  const faultProv: Provenance[] = [];
  const checkpointProv: Provenance[] = [];
  const overallProv: Provenance[] = [];
  const contactProv: Provenance[] = [];
  const handProv: Provenance[] = [];
  for (const { file, annotation } of corpus.canonical) {
    const others = annotation.otherPaddleFrames ?? [];
    if (others.length > 0) {
      otherPaddleProvenance.push({ path: file.path, ref: `otherPaddleFrames×${others.length}` });
      otherSummed += others.length;
      const targetFrames = annotation.paddleFrames ?? [];
      bothVisibleWithin20ms += others.filter(
        (other) =>
          other.visibility === "visible" &&
          targetFrames.some(
            (target) => Math.abs(target.tMs - other.tMs) < 20 && target.visibility === "visible",
          ),
      ).length;
      for (const frame of others) {
        otherPaddleDistinct.add(`${file.bundle}@${frame.tMs}`);
        if (frame.visibility === "visible") otherVisible += 1;
        else if (frame.visibility === "occluded") otherOccluded += 1;
        else otherAbsent += 1;
      }
    }
    const targets = annotation.paddleFrames ?? [];
    if (targets.length > 0) {
      targetPaddle.files += 1;
      for (const frame of targets) targetPaddle[frame.visibility] += 1;
    }
    const balls = annotation.ballFrames ?? [];
    if (balls.length > 0) {
      ball.files += 1;
      for (const frame of balls) ball[frame.visibility] += 1;
    }
    if (annotation.analyzable === false) {
      notAnalyzable.push({
        bundle: file.bundle,
        reason: annotation.notAnalyzableReason ?? "(no reason recorded)",
        path: file.path,
      });
    }
    if (annotation.handedness === "right") rightHandedFiles += 1;
    if (annotation.handedness && annotation.handedness !== "unsure") {
      const votes = handVotes.get(file.bundle) ?? new Map<string, Provenance[]>();
      const list = votes.get(annotation.handedness) ?? [];
      list.push({ path: file.path, ref: `handedness=${annotation.handedness}` });
      votes.set(annotation.handedness, list);
      handVotes.set(file.bundle, votes);
      handProv.push({ path: file.path, ref: `handedness=${annotation.handedness}` });
    }
    const faults = annotation.faults ?? [];
    if (faults.length > 0) {
      faultLabels += faults.length;
      faultProv.push({ path: file.path, ref: `faults×${faults.length}` });
    }
    const checkpoints = Object.values(annotation.checkpointScores ?? {}).filter(
      (value) => value !== null && value !== undefined,
    );
    if (checkpoints.length > 0) {
      checkpointLabels += checkpoints.length;
      checkpointProv.push({ path: file.path, ref: `checkpointScores×${checkpoints.length}` });
    }
    if (annotation.overallScore !== null && annotation.overallScore !== undefined) {
      overallLabels += 1;
      overallProv.push({ path: file.path, ref: `overallScore=${annotation.overallScore}` });
    }
    if (annotation.contactUncertainty !== null && annotation.contactUncertainty !== undefined) {
      contactUncertaintyRecords += 1;
      contactProv.push({ path: file.path, ref: "contactUncertainty" });
    }
  }

  const sidecarTwoPlus = corpus.ownershipSidecar.filter(
    (entry) => Object.values(entry.owners).filter((owner) => owner !== "reject").length >= 2,
  ).length;

  const taBySituation: Record<string, number> = {};
  const taByVerification: Record<string, number> = {};
  let verifiedMulti = 0;
  let verifiedTwo = 0;
  let verifiedSolo = 0;
  const taLoss = { total: 0, verified: 0 };
  const taSmall = { total: 0, verified: 0 };
  for (const taCase of corpus.taCases) {
    for (const tag of taCase.situation) inc(taBySituation, tag);
    inc(taByVerification, taCase.verification.state);
    const verified = taCase.verification.state === "verified";
    if (taCase.situation.includes("multi_player") && verified) verifiedMulti += 1;
    if (taCase.situation.includes("two_players") && verified) verifiedTwo += 1;
    if (taCase.situation.includes("solo") && verified) verifiedSolo += 1;
    if (taCase.situation.includes("target_loss_periods")) {
      taLoss.total += 1;
      if (verified) taLoss.verified += 1;
    }
    if (taCase.situation.includes("small_target")) {
      taSmall.total += 1;
      if (verified) taSmall.verified += 1;
    }
  }

  const registryPlayerText: Provenance[] = corpus.registry
    .filter((video) => video.realFootage && video.playerVisibility)
    .map((video) => ({
      path: "datasets/paddle-bench/registry.json",
      ref: `${video.id}.playerVisibility: ${video.playerVisibility}`,
    }));

  const multiPlayer: MultiPlayerCoverage = {
    goldEventsByOwner: ownerCounts,
    clipsWithOtherOwnedEvents: clipsWithOther,
    clipsWithOnlyTargetEvents: clipsOnlyTarget,
    otherPaddleFrames: {
      filesSummed: {
        count: otherSummed,
        evidenceClass: "gold_label",
        provenance: otherPaddleProvenance,
      },
      distinctBundleTimestamps: otherPaddleDistinct.size,
      bothPaddlesVisibleWithin20ms: bothVisibleWithin20ms,
      visible: otherVisible,
      occluded: otherOccluded,
      absent: otherAbsent,
    },
    ownershipSidecarFrames: {
      count: corpus.ownershipSidecar.length,
      evidenceClass: "gold_label",
      provenance: [
        {
          path: "datasets/paddle-bench/ownership-review/ownership-review.json",
          ref: `entries×${corpus.ownershipSidecar.length}`,
        },
      ],
    },
    ownershipSidecarFramesWithTwoOrMorePlayers: sidecarTwoPlus,
    taBenchWindows: {
      total: corpus.taCases.length,
      bySituation: taBySituation,
      byVerification: taByVerification,
      verifiedMultiPlayer: verifiedMulti,
      verifiedTwoPlayers: verifiedTwo,
      verifiedSolo,
      provenance: [{ path: "datasets/ta-bench/cases.json", ref: `cases×${corpus.taCases.length}` }],
    },
    structuredPlayerCountLabels: {
      count: 0,
      evidenceClass: "absent",
      provenance: [
        {
          path: "packages/swing-lab/src/annotationSchema.ts",
          ref: "SwingAnnotation has no per-frame player-count or player-box field",
        },
      ],
    },
    registryPlayerVisibilityText: registryPlayerText,
  };

  // ── partial visibility ──
  const censoredProv: Provenance[] = [];
  for (const { file, annotation } of corpus.modal) {
    for (const record of annotation.records ?? []) {
      const classification = record.classification ?? "";
      const declaredStroke = record.declaredStroke ?? "";
      if (/censor/i.test(classification) || /^ABSTAIN/.test(declaredStroke)) {
        censoredProv.push({
          path: file.path,
          ref: `${record.recordId ?? "?"} ${classification || declaredStroke}`,
        });
      }
    }
  }
  const partialVisibility: PartialVisibilityCoverage = {
    notAnalyzableClips: {
      count: uniqSorted(notAnalyzable.map((entry) => entry.bundle)).length,
      evidenceClass: "gold_label",
      provenance: notAnalyzable.map((entry) => ({ path: entry.path, ref: entry.reason })),
    },
    notAnalyzableReasons: notAnalyzable,
    targetPaddleFrames: targetPaddle,
    ballFrames: ball,
    censoredEventRecords: {
      count: censoredProv.length,
      evidenceClass: "gold_label",
      provenance: censoredProv,
    },
    taBenchTargetLossWindows: taLoss,
    taBenchSmallTargetWindows: taSmall,
    structuredPartialBodyLabels: {
      count: 0,
      evidenceClass: "absent",
      provenance: [
        {
          path: "packages/swing-lab/src/annotationSchema.ts",
          ref: "no field records which body parts / how much of the player is out of frame",
        },
      ],
    },
    registryPartialFramingText: corpus.registry
      .filter(
        (video) =>
          video.realFootage &&
          PARTIAL_FRAMING_KEYWORDS.test(
            `${video.playerVisibility ?? ""} ${video.description ?? ""}`,
          ),
      )
      .map((video) => ({
        path: "datasets/paddle-bench/registry.json",
        ref: `${video.id}.playerVisibility: ${video.playerVisibility ?? ""}`,
      })),
  };

  // ── handedness ──
  const clipsRight: string[] = [];
  const clipsLeft: string[] = [];
  const clipsConflicting: string[] = [];
  for (const [bundle, votes] of handVotes) {
    const keys = [...votes.keys()];
    if (keys.length > 1) clipsConflicting.push(bundle);
    else if (keys[0] === "right") clipsRight.push(bundle);
    else if (keys[0] === "left") clipsLeft.push(bundle);
  }
  const handedness: HandednessCoverage = {
    evidenceClass: "gold_label",
    clipsRight: clipsRight.sort(),
    clipsLeft: clipsLeft.sort(),
    clipsUnsureOnly: bundles.filter((bundle) => !handVotes.has(bundle)),
    clipsConflicting: clipsConflicting.sort(),
    provenance: handProv,
  };

  // ── other gold modalities ──
  let phaseValues = 0;
  let phaseNulls = 0;
  const phaseProv: Provenance[] = [];
  for (const { file, annotation } of corpus.modal) {
    if (annotation.modality !== "phases") continue;
    let fileValues = 0;
    for (const event of annotation.eventPhases ?? []) {
      for (const boundary of event.boundaries ?? []) {
        if (boundary.valueMs === null) phaseNulls += 1;
        else {
          phaseValues += 1;
          fileValues += 1;
        }
      }
    }
    phaseProv.push({ path: file.path, ref: `phase boundaries with a value×${fileValues}` });
  }

  const multiAnnotatorEvents = (() => {
    const byEvent = new Map<string, Set<string>>();
    for (const label of gold) {
      const key = `${label.caseId}@${label.eventStartMs}-${label.eventEndMs}/${label.owner}`;
      const set = byEvent.get(key) ?? new Set<string>();
      set.add(label.annotatorId);
      byEvent.set(key, set);
    }
    return [...byEvent.values()].filter((set) => set.size > 1).length;
  })();

  const otherGold: OtherGoldModalities = {
    phaseBoundaryValuesD2: {
      count: phaseValues,
      evidenceClass: "gold_label",
      provenance: phaseProv,
    },
    phaseBoundaryNullsD2: phaseNulls,
    contactUncertaintyRecords: {
      count: contactUncertaintyRecords,
      evidenceClass: "gold_label",
      provenance: contactProv,
    },
    faultLabels: {
      count: faultLabels,
      evidenceClass: faultLabels === 0 ? "absent" : "gold_label",
      provenance:
        faultLabels === 0
          ? [
              {
                path: "datasets/paddle-bench/bundles/*/annotation/*.json",
                ref: "faults[] empty in every canonical annotation",
              },
            ]
          : faultProv,
    },
    checkpointScoreLabels: {
      count: checkpointLabels,
      evidenceClass: checkpointLabels === 0 ? "absent" : "gold_label",
      provenance:
        checkpointLabels === 0
          ? [
              {
                path: "datasets/paddle-bench/bundles/*/annotation/*.json",
                ref: "checkpointScores all null/empty",
              },
            ]
          : checkpointProv,
    },
    overallScoreLabels: {
      count: overallLabels,
      evidenceClass: overallLabels === 0 ? "absent" : "gold_label",
      provenance:
        overallLabels === 0
          ? [
              {
                path: "datasets/paddle-bench/bundles/*/annotation/*.json",
                ref: "overallScore null everywhere",
              },
            ]
          : overallProv,
    },
    coachReviews: {
      count: corpus.coachReviewCount,
      evidenceClass: corpus.coachReviewCount === 0 ? "absent" : "gold_label",
      provenance: [
        {
          path: "datasets/coach-review/agreement/agreement-report.json",
          ref: `reviews=${corpus.coachReviewCount}`,
        },
        { path: "datasets/coach-review/coaches.json", ref: `coaches=${corpus.coachCount}` },
      ],
    },
    qualifiedCoaches: corpus.coachCount,
    poseKeypointGold: {
      count: 0,
      evidenceClass: "absent",
      provenance: [
        {
          path: "packages/swing-lab/src/annotationSchema.ts",
          ref: "no keypoint field; runs-wave-a/*/people.json is Apple Vision OUTPUT, not human gold",
        },
      ],
    },
    bounceLabels: {
      count: 0,
      evidenceClass: "absent",
      provenance: [
        {
          path: "packages/swing-lab/src/annotationSchema.ts",
          ref: "no bounce/contact-state field",
        },
      ],
    },
    oodNegativesReal: {
      count: corpus.ood.items.length,
      evidenceClass: "gold_label",
      provenance: corpus.ood.items.map((item) => ({
        path: "datasets/ood/registry.json",
        ref: `${item.id} ${item.category}`,
      })),
    },
    oodNegativesDerived: {
      count: corpus.ood.derivedItems.items.length,
      evidenceClass: "gold_label",
      provenance: corpus.ood.derivedItems.items.map((item) => ({
        path: "datasets/ood/registry.json",
        ref: `derivedItems ${item.id} ${item.category}`,
      })),
    },
    firstPartyPhoneCaptures: {
      count: 0,
      evidenceClass: "absent",
      provenance: [
        {
          path: "datasets/paddle-bench/registry.json",
          ref: "every realFootage entry is broadcast/DoD/Commons footage; no iPhone capture from the shipped app is registered",
        },
      ],
    },
    multiAnnotatorStrokeGoldEvents: multiAnnotatorEvents,
  };

  // ── product claims ──
  const classRow = (leaf: string): StrokeClassRow =>
    strokeClasses.find((row) => row.productClass === leaf)!;
  const goldClasses = strokeClasses.filter((row) => row.status === "GOLD_EVENTS");
  const noGoldClasses = strokeClasses.filter((row) => row.status === "NO_GOLD");
  const bundleOnlyClasses = strokeClasses.filter((row) => row.status === "BUNDLE_LEVEL_ONLY");
  // strict: the registry's own side-view value; mixed: descriptions that say
  // part of the footage is side-view ("mixed: side-view court level + …").
  // "rear_side_elevated" is a rear diagonal, not side-on, and is excluded.
  const strictSide = [...angleRows.values()].filter(
    (row) => row.cameraAngle === "side_court_level",
  );
  const mixedSide = [...angleRows.values()].filter(
    (row) => row.cameraAngle.startsWith("mixed") && /side-view/i.test(row.cameraAngle),
  );
  const strictSideClips = strictSide.flatMap((row) => row.labeledClips);
  const strictSideEvents = strictSide.reduce((sum, row) => sum + row.goldEvents, 0);
  const mixedSideClips = mixedSide.flatMap((row) => row.labeledClips);
  const mixedSideEvents = mixedSide.reduce((sum, row) => sum + row.goldEvents, 0);
  const dossier = "docs/APP_STORE_SUBMISSION.md";

  const claims: ProductClaim[] = [
    {
      claimId: "strokes-covered",
      claimText:
        "Strokes covered: serve, return, forehand and backhand drives, dinks, third-shot drops, volleys, resets, speedups, and overheads.",
      source: { path: dossier, ref: "App Store description, 'Strokes covered' line" },
      requiredGold: "≥1 stroke-gold event resolving exactly to each of the 12 product classes",
      goldSupport: {
        classesWithGoldEvents: goldClasses.map((row) => row.productClass),
        classesBundleLevelOnly: bundleOnlyClasses.map((row) => row.productClass),
        classesWithNoGold: noGoldClasses.map((row) => row.productClass),
      },
      status: noGoldClasses.length === 0 ? "SUPPORTED" : "PARTIAL",
      reason: `${goldClasses.length}/12 product classes have ≥1 exact gold event; ${noGoldClasses.length} have no gold of any kind (${noGoldClasses.map((row) => row.productClass).join(", ")})`,
    },
    ...noGoldClasses.map<ProductClaim>((row) => ({
      claimId: `stroke-class:${row.productClass}`,
      claimText: `Strokes covered: … ${row.displayName.toLowerCase()} …`,
      source: { path: dossier, ref: "App Store description, 'Strokes covered' line" },
      requiredGold: `≥1 committed gold event labeled ${row.productClass}`,
      goldSupport: {
        goldEventsExact: 0,
        goldEventsAmbiguous: row.goldEventsAmbiguous.count,
        bundleLevelClips: 0,
      },
      status: "UNVERIFIED",
      reason:
        "no committed gold event, bundle-level vote, or declared observation names this class",
    })),
    ...bundleOnlyClasses.map<ProductClaim>((row) => ({
      claimId: `stroke-class:${row.productClass}`,
      claimText: `Strokes covered: … ${row.displayName.toLowerCase()} …`,
      source: { path: dossier, ref: "App Store description, 'Strokes covered' line" },
      requiredGold: `≥1 committed gold EVENT labeled ${row.productClass}`,
      goldSupport: {
        goldEventsExact: 0,
        goldEventsAmbiguous: row.goldEventsAmbiguous.count,
        bundleLevelClips: row.bundleLevelClips.count,
        declaredObservations: row.declaredObservations.count,
      },
      status: "PARTIAL",
      reason:
        "only clip-level votes / observations exist; no event-bounded gold to score a classifier against",
    })),
    ...goldClasses.map<ProductClaim>((row) => ({
      claimId: `stroke-class:${row.productClass}`,
      claimText: `Strokes covered: … ${row.displayName.toLowerCase()} …`,
      source: { path: dossier, ref: "App Store description, 'Strokes covered' line" },
      requiredGold: `≥1 committed gold event labeled ${row.productClass}`,
      goldSupport: {
        goldEventsExact: row.goldEventsExact.count,
        target: row.goldEventsExactTarget,
        other: row.goldEventsExactOther,
        clips: row.clipsWithExactEvent,
        sessions: row.sessionsWithExactEvent,
        exactEventsWithCommittedPose: row.exactEventsWithCommittedPose,
      },
      status: row.exactEventsWithCommittedPose > 0 ? "SUPPORTED" : "PARTIAL",
      reason:
        row.exactEventsWithCommittedPose > 0
          ? `${row.goldEventsExact.count} gold event(s), ${row.exactEventsWithCommittedPose} Linux-replayable`
          : `${row.goldEventsExact.count} gold event(s) but none on a clip with committed pose (not replayable on Linux)`,
    })),
    {
      claimId: "capture-side-on-waist-height",
      claimText: "Set the phone. Prop it side-on at waist height.",
      source: { path: dossier, ref: "App Store description, 'How it works' step 1" },
      requiredGold:
        "labeled clips shot side-on at roughly waist height (the instructed capture geometry)",
      goldSupport: {
        strictSideCourtLevelRegistryVideos: strictSide.flatMap((row) => row.registryVideos),
        strictSideCourtLevelLabeledClips: strictSideClips,
        strictSideCourtLevelGoldEvents: strictSideEvents,
        mixedIncludingSideViewRegistryVideos: mixedSide.flatMap((row) => row.registryVideos),
        mixedIncludingSideViewLabeledClips: mixedSideClips,
        mixedIncludingSideViewGoldEvents: mixedSideEvents,
        waistHeightMetadata: "absent (no registry field records camera height)",
        firstPartyPhoneCaptures: 0,
      },
      status: strictSideEvents === 0 ? "UNVERIFIED" : "PARTIAL",
      reason:
        strictSideEvents === 0
          ? "no gold event on a clip whose registry cameraAngle is side_court_level"
          : `${strictSideEvents} gold event(s) on ${strictSideClips.length} side_court_level clip(s) (+${mixedSideEvents} on ${mixedSideClips.length} 'mixed … side-view' clip(s)); camera height is unrecorded and none is a phone capture`,
    },
    {
      claimId: "wherever-you-stand",
      claimText: "Body-pose tracking runs on the phone, catches your stroke wherever you stand",
      source: { path: dossier, ref: "App Store description, 'How it works' step 2" },
      requiredGold: "gold events across multiple camera angles / player positions",
      goldSupport: {
        anglesWithGoldEvents: [...angleRows.values()]
          .filter((row) => row.goldEvents > 0)
          .map((row) => `${row.cameraAngle}×${row.goldEvents}`),
        anglesWithRegistryFootageButNoGoldEvents: [...angleRows.values()]
          .filter((row) => row.goldEvents === 0)
          .map((row) => row.cameraAngle),
      },
      status:
        [...angleRows.values()].filter((row) => row.goldEvents > 0).length >= 2
          ? "PARTIAL"
          : "UNVERIFIED",
      reason:
        "several angles carry gold events, but no angle has more than a handful and none is a phone capture",
    },
    {
      claimId: "stops-the-clip-on-its-own",
      claimText: "stops the clip on its own. No shot picker, no timer.",
      source: { path: dossier, ref: "App Store description, 'How it works' step 2" },
      requiredGold:
        "event-bounded gold (eventStart/contact/eventEnd) with committed pose for replay",
      goldSupport: {
        goldEventsWithCommittedPose: eventsWithPose,
        committedPoseCases: corpus.committedPoseCases,
      },
      status: eventsWithPose > 0 ? "PARTIAL" : "UNVERIFIED",
      reason: `${eventsWithPose} event(s) replayable on Linux; auto-stop on a live phone camera is an Apple-plane behaviour this corpus cannot measure`,
    },
    {
      claimId: "technique-score-out-of-10",
      claimText:
        "A validated analysis returns a technique score out of 10, checkpoint scores from 0 to 100",
      source: { path: dossier, ref: "App Store description, 'How it works' step 3" },
      requiredGold: "expert overallScore / checkpointScores labels or qualified coach reviews",
      goldSupport: {
        overallScoreLabels: overallLabels,
        checkpointScoreLabels: checkpointLabels,
        coachReviews: corpus.coachReviewCount,
        qualifiedCoaches: corpus.coachCount,
      },
      status:
        overallLabels + checkpointLabels + corpus.coachReviewCount > 0 ? "PARTIAL" : "UNVERIFIED",
      reason:
        "no committed human score or coach review exists to validate any technique/checkpoint number",
    },
    {
      claimId: "form-review-key-phases",
      claimText: "It pauses at each key phase and gives you a coaching cue at every stop.",
      source: { path: dossier, ref: "App Store description, feature bullet 'Form Review'" },
      requiredGold: "phase-boundary gold per event",
      goldSupport: { phaseBoundaryValues: phaseValues, phaseBoundaryNulls: phaseNulls },
      status: phaseValues > 0 ? "PARTIAL" : "UNVERIFIED",
      reason: `${phaseValues} phase boundaries with a value across ${phaseProv.length} D2 phase files; coaching-cue correctness has no gold`,
    },
    {
      claimId: "measured-faults",
      claimText: "a priority list of measured faults, the cue that addresses each one",
      source: { path: dossier, ref: "App Store description, feature bullet 'What to fix'" },
      requiredGold: "fault labels (faults[]) or coach fault reviews",
      goldSupport: { faultLabels, coachReviews: corpus.coachReviewCount },
      status: faultLabels + corpus.coachReviewCount > 0 ? "PARTIAL" : "UNVERIFIED",
      reason: "faults[] is empty in every committed annotation and 0 coach reviews exist",
    },
    {
      claimId: "abstains-when-not-enough-seen",
      claimText:
        "Pickle Sensei never invents a score. If the camera did not see enough of the stroke, the app says so",
      source: { path: dossier, ref: "App Store description, closing paragraph" },
      requiredGold:
        "negative / partial-visibility gold: OOD negatives, not-analyzable clips, censored events, occlusion frames",
      goldSupport: {
        oodNegativesReal: corpus.ood.items.length,
        oodNegativesDerived: corpus.ood.derivedItems.items.length,
        notAnalyzableClips: partialVisibility.notAnalyzableClips.count,
        censoredEventRecords: censoredProv.length,
        occludedTargetPaddleFrames: targetPaddle.occluded,
        structuredPartialBodyLabels: 0,
      },
      status: "PARTIAL",
      reason:
        "OOD/negative gold exists for the pre-analysis gate; no gold labels a partially-out-of-frame stroke as 'should abstain'",
    },
    {
      claimId: "import-video",
      claimText: "Import video: analyze a stroke clip you already have on this phone.",
      source: { path: dossier, ref: "App Store description, feature bullet 'Import video'" },
      requiredGold: "gold on imported-format clips (phone-shot, various encodings)",
      goldSupport: {
        firstPartyPhoneCaptures: 0,
        derivedMediaProbes: corpus.ood.derivedItems.items.length,
      },
      status: "UNVERIFIED",
      reason:
        "no committed clip originates from a phone camera roll; derived probes only test the OOD gate",
    },
    {
      claimId: "on-device-pose",
      claimText: "Video and pose tracking are processed on your device.",
      source: { path: dossier, ref: "App Store description, privacy paragraph" },
      requiredGold: "not a CV-accuracy claim; Apple-plane runtime property",
      goldSupport: { poseKeypointGold: 0 },
      status: "UNVERIFIED",
      reason:
        "out of scope for gold coverage: verifiable only from Apple-plane artifacts, never from Linux",
    },
    {
      claimId: "left-handed-players",
      claimText: "(implicit) works for left-handed players",
      source: {
        path: dossier,
        ref: "no explicit sentence; implied by 'Strokes covered' with no handedness caveat",
      },
      requiredGold: "≥1 clip with handedness=left",
      goldSupport: { clipsLeft: handedness.clipsLeft, clipsRight: handedness.clipsRight.length },
      status: handedness.clipsLeft.length > 0 ? "PARTIAL" : "UNVERIFIED",
      reason: `${handedness.clipsLeft.length} left-handed clip(s) labeled`,
    },
    {
      claimId: "low-light",
      claimText: "(implicit) works in indoor / low-light conditions",
      source: { path: dossier, ref: "no explicit sentence; no lighting caveat in the description" },
      requiredGold: "≥1 clip with a lighting label of low-light/night",
      goldSupport: {
        structuredLightingLabels: 0,
        lowLightFreeTextHits: lightingRows.get("low_light_or_night")!.labeledClips,
      },
      status: "UNVERIFIED",
      reason: "no structured lighting field exists and no description mentions low light or night",
    },
  ];

  const unverifiedClaims = claims
    .filter((claim) => claim.status === "UNVERIFIED")
    .map((claim) => claim.claimId);

  // ── cross-checks vs existing reporters (values computed independently here) ──
  const bundleLevelPresent = uniqSorted(
    [...bundleVotes.values()].flatMap((votes) => [...votes.keys()]),
  );
  const goldOnlyClasses = strokeClasses
    .filter((row) => row.goldEventsExact.count > 0 && row.bundleLevelClips.count === 0)
    .map((row) => `${row.productClass} (basis ${JSON.stringify(row.goldEventsExactByBasis)})`);
  if (goldOnlyClasses.length > 0) {
    caveats.push(
      `classes with event-level gold but NO bundle-level vote: ${goldOnlyClasses.join("; ")} — datasetReport/dataGaps list them as MISSING because they only read annotatedStrokeV3`,
    );
  }
  const facts = parseReporterOutputs(options.reporterOutputs ?? {});
  const eventLabelRecords = corpus.canonical.reduce(
    (sum, { annotation }) => sum + (annotation.eventLabels ?? []).length,
    0,
  );
  const bundleLevelPassesByClass: Record<string, number> = {};
  for (const votes of bundleVotes.values()) {
    for (const [leaf, provenance] of votes) inc(bundleLevelPassesByClass, leaf, provenance.length);
  }
  const bundleLevelClipsByClass: Record<string, number> = {};
  for (const row of strokeClasses)
    bundleLevelClipsByClass[row.productClass] = row.bundleLevelClips.count;
  const compare = (
    reporter: string,
    quantity: string,
    reporterValue: number | string | null,
    auditValue: number | string,
    note: string,
  ): CrossCheck => ({
    reporter,
    quantity,
    reporterValue,
    auditValue,
    agrees: reporterValue === null ? null : String(reporterValue) === String(auditValue),
    note,
  });
  const listOrNull = (list: string[] | null): string | null =>
    list === null ? null : uniqSorted(list).join(", ");
  const perClassGaps = facts.dataGaps.perClassLabeled;
  const paddleCurve = corpus.learningCurves?.tasks.find((task) =>
    task.task.startsWith("paddle-detection"),
  );
  const paddleLabeledDevClips = uniqSorted(
    corpus.canonical
      .filter(({ annotation }) => (annotation.paddleFrames ?? []).length > 0)
      .map(({ file }) => file.bundle)
      .filter((bundle) => !heldOutBundles.includes(bundle)),
  );
  const crossChecks: CrossCheck[] = [
    compare(
      "datasetReport.ts",
      "v3 stroke classes present (bundle level)",
      listOrNull(facts.datasetReport.presentV3),
      bundleLevelPresent.join(", "),
      "both read annotatedStrokeV3 from canonical annotation files",
    ),
    compare(
      "datasetReport.ts",
      "v3 stroke classes MISSING (bundle level)",
      listOrNull(facts.datasetReport.missingV3),
      uniqSorted(PRODUCT_STROKE_CLASSES.filter((leaf) => !bundleLevelPresent.includes(leaf))).join(
        ", ",
      ),
      goldOnlyClasses.length > 0
        ? `bundle-level only; stroke-gold.json events additionally resolve ${goldOnlyClasses.join("; ")} which no bundle vote names`
        : "bundle-level only",
    ),
    compare(
      "datasetReport.ts",
      "bundles with a v3 stroke label",
      facts.datasetReport.strokeLabelsV3,
      bundleVotes.size,
      "datasetReport lists one entry per bundle",
    ),
    compare(
      "datasetReport.ts",
      "target paddle frames (visible/occluded)",
      facts.datasetReport.paddleFrames === null
        ? null
        : `${facts.datasetReport.paddleFrames} (${facts.datasetReport.paddleVisible}/${facts.datasetReport.paddleOccluded})`,
      `${targetPaddle.visible + targetPaddle.occluded + targetPaddle.absent} (${targetPaddle.visible}/${targetPaddle.occluded})`,
      "paddleFrames summed over canonical annotation files",
    ),
    compare(
      "datasetReport.ts",
      "ball frames",
      facts.datasetReport.ballFrames,
      ball.visible + ball.occluded + ball.not_visible + ball.uncertain,
      "ballFrames summed over canonical annotation files",
    ),
    compare(
      "datasetReport.ts",
      "EVENT labels",
      facts.datasetReport.eventLabels,
      `${eventLabelRecords} eventLabels records; ${gold.length} stroke-gold events`,
      "datasetReport.ts:116 prints a literal 5 whenever any bundle exists; the live corpus carries more",
    ),
    compare(
      "datasetReport.ts",
      "explicit other-player paddle labels",
      facts.datasetReport.otherPlayerPaddleLabels,
      otherSummed,
      "datasetReport.ts:121 prints a literal 0 '(gap)'; otherPaddleFrames is populated in the live corpus",
    ),
    compare(
      "dataGaps.ts",
      "right-handed 'clips'",
      facts.dataGaps.rightHandedClips,
      handedness.clipsRight.length,
      `dataGaps sums annotation FILES with handedness=right (audit sees ${rightHandedFiles} such canonical files); the audit counts DISTINCT clips with an explicit right vote`,
    ),
    compare(
      "dataGaps.ts",
      "dual-paddle labeled frames (both visible within 20 ms)",
      facts.dataGaps.dualPaddleFrames,
      multiPlayer.otherPaddleFrames.bothPaddlesVisibleWithin20ms,
      `same definition as dataGaps; all otherPaddleFrames: ${otherSummed} summed over files, ${otherPaddleDistinct.size} distinct (bundle,tMs)`,
    ),
    ...PRODUCT_STROKE_CLASSES.map((leaf) =>
      compare(
        "dataGaps.ts",
        `${leaf} 'labeled' (annotation passes)`,
        perClassGaps === null ? null : (perClassGaps[leaf] ?? 0),
        bundleLevelPassesByClass[leaf] ?? 0,
        `passes are annotation FILES naming the class; distinct clips=${bundleLevelClipsByClass[leaf] ?? 0}, event-level gold=${classRow(leaf).goldEventsExact.count}`,
      ),
    ),
    compare(
      "dataGaps.ts",
      "acquisition priority text",
      facts.dataGaps.priorityLines === null
        ? null
        : (facts.dataGaps.priorityLines.find((line) => /serves/i.test(line)) ?? "(no serve line)"),
      `SERVE bundle passes=${bundleLevelPassesByClass.SERVE ?? 0} gold events=${classRow("SERVE").goldEventsExact.count}; RETURN=0`,
      "hard-coded priority text says 'serves + returns (0 labeled)' while the same run's table reports SERVE labels",
    ),
    compare(
      "strokeTaxonomyBench.ts",
      "stroke-gold labels / cases",
      facts.strokeTaxonomyBench.labels === null
        ? null
        : `${facts.strokeTaxonomyBench.labels} labels across ${facts.strokeTaxonomyBench.cases} cases`,
      `${gold.length} labels across ${goldCases.length} cases`,
      "same file, same validator",
    ),
    compare(
      "datasets/releases/pickle-sensei-datasets-v2/manifest.json",
      "annotated cases / gold target events / stroke labels",
      corpus.releaseManifestV2 === null
        ? null
        : `${corpus.releaseManifestV2.statistics.annotatedCases} / ${corpus.releaseManifestV2.statistics.goldTargetEvents} / ${corpus.releaseManifestV2.statistics.goldLabelCounts.strokeLabels ?? "n/a"}`,
      `${corpus.canonical.length > 0 ? new Set(corpus.canonical.map(({ file }) => file.bundle)).size : 0} / ${ownerCounts.target} / ${bundleVotes.size}`,
      "the v2 release is an immutable snapshot; docs/EVALUATION.md §5 quotes it, so its counts lag the live corpus",
    ),
    compare(
      "datasets/corpus/learning-curves.json",
      "paddle-detection dev cases (learningCurve.ts, held-out excluded)",
      paddleCurve === undefined
        ? null
        : `${paddleCurve.cases} cases from ${paddleCurve.source} (generated ${corpus.learningCurves?.generatedAtIso ?? "?"})`,
      `${paddleLabeledDevClips.length} dev clips with committed paddleFrames (${paddleLabeledDevClips.join(", ")})`,
      "learningCurve.ts reads the LATEST committed bench-result file, not the label corpus; its n is bounded by that run and it writes into datasets/, so the audit only reads its committed output",
    ),
  ];

  caveats.push(
    `all counts are per-event / per-clip evidence from a ${bundles.length}-clip corpus; none is a population rate`,
    "Linux read-only inventory: nothing here measures Apple Vision, Swift, or on-device behaviour",
    `claim status SUPPORTED means ≥1 committed gold label can MEASURE the claim, not that the product meets it; the largest per-class exact count is ${Math.max(...strokeClasses.map((row) => row.goldEventsExact.count))} events, so no per-class rate is estimable`,
    `held-out clips (${heldOutBundles.join(", ")}) are counted in clip-level tables but stroke-gold.json excludes them by policy`,
  );

  const byShape: Record<string, number> = {};
  for (const file of corpus.annotationFiles) inc(byShape, file.shape);

  return {
    schema: GOLD_COVERAGE_AUDIT_VERSION,
    generatedAtIso: now.toISOString(),
    gitSha: options.gitSha ?? null,
    evidencePlane: "linux_read_only_label_inventory",
    inputs: corpus.inputs,
    annotationFilesByShape: byShape,
    unknownShapeFiles: corpus.annotationFiles
      .filter((file) => file.shape === "unknown")
      .map((file) => file.path),
    strokeGold: {
      path: corpus.strokeGoldPath,
      labels: gold.length,
      target: ownerCounts.target,
      other: ownerCounts.other,
      cases: goldCases,
      heldOutCasesExcludedByFile: heldOutBundles.filter((bundle) => !goldCases.includes(bundle)),
      annotators,
      l1,
      l2,
      l3,
      l1Unknown: l1.unknown ?? 0,
      l3Unknown: l3.unknown ?? 0,
      resolution: { exact: exactCount, ambiguous: ambiguousCount, unresolvable },
      eventsWithCommittedPose: eventsWithPose,
      committedPoseCases: corpus.committedPoseCases,
    },
    strokeClasses,
    roleClasses,
    cameraAngle: {
      evidenceClass: "registry_metadata",
      rows: [...angleRows.values()].sort((a, b) => a.cameraAngle.localeCompare(b.cameraAngle)),
      unmappedClips,
    },
    lighting: {
      structuredField: null,
      evidenceClass: "free_text_keyword",
      rows: [...lightingRows.values()],
      clipsWithNoLightingText,
      lowLightOrNightLabels: 0,
    },
    multiPlayer,
    partialVisibility,
    handedness,
    otherGold,
    claims,
    unverifiedClaims,
    crossChecks,
    caveats,
  };
}

// ── text rendering ──────────────────────────────────────────────────────────

export function renderCoverageTable(audit: GoldCoverageAudit): string {
  const lines: string[] = [];
  const rule = "═".repeat(78);
  lines.push(
    rule,
    `GOLD COVERAGE AUDIT [${audit.schema}] ${audit.generatedAtIso} git=${audit.gitSha ?? "n/a"}`,
    rule,
  );
  lines.push(
    `stroke-gold: ${audit.strokeGold.labels} events (${audit.strokeGold.target} target / ${audit.strokeGold.other} other) over ${audit.strokeGold.cases.length} clips · exact=${audit.strokeGold.resolution.exact} ambiguous=${audit.strokeGold.resolution.ambiguous} unresolvable=${audit.strokeGold.resolution.unresolvable} · ${audit.strokeGold.eventsWithCommittedPose} with committed pose`,
  );
  lines.push("", "PRODUCT STROKE CLASSES (12 = SELECTABLE_TECHNIQUES_V1)");
  lines.push(
    "class".padEnd(17) +
      "events".padStart(7) +
      "tgt".padStart(5) +
      "oth".padStart(5) +
      "ambig".padStart(7) +
      "clips".padStart(7) +
      "sess".padStart(6) +
      "pose".padStart(6) +
      "bndl".padStart(6) +
      "obs".padStart(5) +
      "  status",
  );
  for (const row of audit.strokeClasses) {
    lines.push(
      row.productClass.padEnd(17) +
        String(row.goldEventsExact.count).padStart(7) +
        String(row.goldEventsExactTarget).padStart(5) +
        String(row.goldEventsExactOther).padStart(5) +
        String(row.goldEventsAmbiguous.count).padStart(7) +
        String(row.clipsWithExactEvent.length).padStart(7) +
        String(row.sessionsWithExactEvent.length).padStart(6) +
        String(row.exactEventsWithCommittedPose).padStart(6) +
        String(row.bundleLevelClips.count).padStart(6) +
        String(row.declaredObservations.count).padStart(5) +
        `  ${row.status}`,
    );
  }
  lines.push(
    "",
    "ROLE CLASSES (forehand/backhand from l2; serve/return/dink/volley/overhead from l1)",
  );
  for (const row of audit.roleClasses) {
    lines.push(
      `  ${row.roleClass.padEnd(9)} events=${row.goldEventsExact} ambiguous=${row.goldEventsAmbiguous} clips=${row.clips.length} sessions=${row.sessions.length} pose=${row.exactEventsWithCommittedPose} bundle-level=${row.bundleLevelClips}  ${row.status}`,
    );
  }
  lines.push("", "CAMERA ANGLE (registry_metadata → clips → gold events)");
  for (const row of audit.cameraAngle.rows) {
    lines.push(
      `  ${row.cameraAngle.padEnd(44)} videos=${row.registryVideos.length} clips=${row.labeledClips.length} events=${row.goldEvents} sessions=${row.sessions.length}`,
    );
  }
  lines.push("", "LIGHTING (free_text_keyword ONLY — no structured field exists anywhere)");
  for (const row of audit.lighting.rows) {
    lines.push(
      `  ${row.keyword.padEnd(22)} videos=${row.registryVideos.length} clips=${row.labeledClips.length} events=${row.goldEvents}`,
    );
  }
  lines.push(
    `  clips with no lighting text at all: ${audit.lighting.clipsWithNoLightingText.join(", ") || "none"}`,
  );
  const mp = audit.multiPlayer;
  lines.push(
    "",
    "MULTI-PLAYER",
    `  gold events target=${mp.goldEventsByOwner.target} other=${mp.goldEventsByOwner.other}; clips with other-owned events=${mp.clipsWithOtherOwnedEvents.length}`,
    `  otherPaddleFrames summed over files=${mp.otherPaddleFrames.filesSummed.count} distinct(bundle,tMs)=${mp.otherPaddleFrames.distinctBundleTimestamps} (visible ${mp.otherPaddleFrames.visible} / occluded ${mp.otherPaddleFrames.occluded} / absent ${mp.otherPaddleFrames.absent})`,
    `  ownership sidecar frames=${mp.ownershipSidecarFrames.count} (≥2 players: ${mp.ownershipSidecarFramesWithTwoOrMorePlayers})`,
    `  ta-bench windows=${mp.taBenchWindows.total} verified multi_player=${mp.taBenchWindows.verifiedMultiPlayer} two_players=${mp.taBenchWindows.verifiedTwoPlayers} solo=${mp.taBenchWindows.verifiedSolo}`,
    `  structured player-count labels: ${mp.structuredPlayerCountLabels.count} (${mp.structuredPlayerCountLabels.evidenceClass})`,
  );
  const pv = audit.partialVisibility;
  lines.push(
    "",
    "PARTIAL VISIBILITY",
    `  not-analyzable clips=${pv.notAnalyzableClips.count}; target paddle frames visible/occluded/absent=${pv.targetPaddleFrames.visible}/${pv.targetPaddleFrames.occluded}/${pv.targetPaddleFrames.absent}`,
    `  ball frames visible/occluded/not_visible/uncertain=${pv.ballFrames.visible}/${pv.ballFrames.occluded}/${pv.ballFrames.not_visible}/${pv.ballFrames.uncertain}`,
    `  censored event records=${pv.censoredEventRecords.count}; ta-bench target_loss windows=${pv.taBenchTargetLossWindows.total} (verified ${pv.taBenchTargetLossWindows.verified}); small_target=${pv.taBenchSmallTargetWindows.total} (verified ${pv.taBenchSmallTargetWindows.verified})`,
    `  structured partial-body labels: ${pv.structuredPartialBodyLabels.count} (${pv.structuredPartialBodyLabels.evidenceClass})`,
  );
  lines.push(
    "",
    `HANDEDNESS right=${audit.handedness.clipsRight.length} left=${audit.handedness.clipsLeft.length} unsure-only=${audit.handedness.clipsUnsureOnly.length} conflicting=${audit.handedness.clipsConflicting.length}`,
  );
  const og = audit.otherGold;
  lines.push(
    "",
    "OTHER GOLD",
    `  phase boundaries (D2) values=${og.phaseBoundaryValuesD2.count} nulls=${og.phaseBoundaryNullsD2}; contactUncertainty records=${og.contactUncertaintyRecords.count}`,
    `  faults=${og.faultLabels.count} checkpointScores=${og.checkpointScoreLabels.count} overallScore=${og.overallScoreLabels.count} coachReviews=${og.coachReviews.count} coaches=${og.qualifiedCoaches}`,
    `  pose keypoint gold=${og.poseKeypointGold.count} bounce labels=${og.bounceLabels.count} OOD real=${og.oodNegativesReal.count} OOD derived=${og.oodNegativesDerived.count} first-party phone captures=${og.firstPartyPhoneCaptures.count}`,
    `  multi-annotator stroke-gold events=${og.multiAnnotatorStrokeGoldEvents}`,
  );
  lines.push("", "PRODUCT CLAIMS");
  for (const claim of audit.claims) {
    lines.push(`  [${claim.status.padEnd(10)}] ${claim.claimId}: ${claim.reason}`);
  }
  lines.push(
    "",
    `UNVERIFIED (${audit.unverifiedClaims.length}): ${audit.unverifiedClaims.join(", ")}`,
  );
  lines.push("", "CROSS-CHECKS");
  for (const check of audit.crossChecks) {
    lines.push(
      `  ${check.agrees === null ? "NO-DATA " : check.agrees ? "agree   " : "DIFFERS "} ${check.reporter} · ${check.quantity}: reporter=${String(check.reporterValue)} audit=${String(check.auditValue)} — ${check.note}`,
    );
  }
  lines.push("", "CAVEATS");
  for (const caveat of audit.caveats) lines.push(`  - ${caveat}`);
  lines.push(rule);
  return lines.join("\n");
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function gitShaOf(repoRoot: string): string | null {
  try {
    const head = readFileSync(join(repoRoot, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const refPath = join(repoRoot, ".git", head.slice(4).trim());
    if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim();
    const packed = join(repoRoot, ".git/packed-refs");
    if (!existsSync(packed)) return null;
    const line = readFileSync(packed, "utf8")
      .split("\n")
      .find((entry) => entry.endsWith(` ${head.slice(4).trim()}`));
    return line ? line.split(" ")[0]! : null;
  } catch {
    return null;
  }
}

const REPORTER_SCRIPTS: Record<keyof ReporterOutputs, string> = {
  datasetReport: "src/datasetReport.ts",
  dataGaps: "src/dataGaps.ts",
  strokeTaxonomyBench: "src/strokeTaxonomyBench.ts",
};

/** Runs each existing reporter with the package-local tsx binary and
 *  returns its stdout (and a per-reporter status line for the log). A reporter
 *  that fails to run yields no output, so its cross-checks read NO-DATA. */
function captureReporterOutputs(
  repoRoot: string,
  outDir: string | undefined,
): { outputs: ReporterOutputs; statuses: string[] } {
  const swingLab = join(repoRoot, "packages/swing-lab");
  const outputs: ReporterOutputs = {};
  const statuses: string[] = [];
  for (const [key, script] of Object.entries(REPORTER_SCRIPTS) as Array<
    [keyof ReporterOutputs, string]
  >) {
    const result = spawnSync(join(swingLab, "node_modules/.bin/tsx"), [script], {
      cwd: swingLab,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    statuses.push(
      `reporter ${script}: exit=${result.status ?? "signal"} stdoutBytes=${stdout.length}`,
    );
    if (result.status === 0) outputs[key] = stdout;
    if (outDir) {
      writeFileSync(join(outDir, `reporter-${key}.stdout.log`), stdout);
      writeFileSync(join(outDir, `reporter-${key}.stderr.log`), stderr);
    }
  }
  return { outputs, statuses };
}

const isMain = process.argv[1]?.endsWith("goldCoverageAudit.ts");
if (isMain) {
  const repoRoot = resolve(argValue("--repo-root") ?? DEFAULT_REPO_ROOT);
  const outDir = argValue("--out-dir");
  const skipReporters = process.argv.includes("--skip-reporters");
  if (outDir) mkdirSync(outDir, { recursive: true });
  const corpus = loadGoldCorpus(repoRoot);
  const { outputs, statuses } = skipReporters
    ? { outputs: {}, statuses: ["reporters skipped (--skip-reporters)"] }
    : captureReporterOutputs(repoRoot, outDir);
  const audit = buildGoldCoverageAudit(corpus, {
    gitSha: gitShaOf(repoRoot),
    reporterOutputs: outputs,
  });
  const table = renderCoverageTable(audit);
  process.stdout.write(`${table}\n`);
  for (const status of statuses) process.stdout.write(`${status}\n`);
  if (outDir) {
    writeFileSync(join(outDir, "gold-coverage-audit.json"), `${JSON.stringify(audit, null, 2)}\n`);
    writeFileSync(join(outDir, "gold-coverage-table.txt"), `${table}\n`);
    process.stdout.write(
      `\nwrote ${join(outDir, "gold-coverage-audit.json")} and gold-coverage-table.txt\n`,
    );
  }
  if (audit.unknownShapeFiles.length > 0) {
    console.error(`unclassified annotation files: ${audit.unknownShapeFiles.join(", ")}`);
    process.exit(2);
  }
}
