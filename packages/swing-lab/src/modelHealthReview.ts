import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { DEFAULT_MODEL_MANIFEST, type ModelManifestEntry } from "@pickle/model-registry";
import { REPO_ROOT } from "./engine/corpus.js";

/**
 * RECURRING MODEL-HEALTH REVIEW — generates the periodic "state of the
 * models" report entirely from artifacts that actually exist in the repo:
 * experiment summaries under datasets/experiments/, the model-registry
 * manifest, coach-review agreement outputs, certification reports, and the
 * bench artifacts (hard slices, latency, envelope).
 *
 * Honesty contract:
 *  - a section with no real evidence is marked NO_DATA (or BLOCKED_EXTERNAL
 *    when the missing evidence can only come from outside this repo — real
 *    coaches, physical devices, production traffic). Sections are never
 *    filled with fabricated or extrapolated numbers;
 *  - "regression"/"increase"/"drift" claims require at least two comparable
 *    measurements of the same instrument over time; a single snapshot is
 *    reported as a snapshot, never as a trend;
 *  - every finding cites the evidence file(s) it was read from.
 */

export const HEALTH_REVIEW_VERSION = "model-health-review-v1" as const;

export type SectionStatus = "OK" | "ATTENTION" | "NO_DATA" | "BLOCKED_EXTERNAL";

export const HEALTH_SECTION_IDS = [
  "what_changed",
  "active_models",
  "drift",
  "new_hard_slices",
  "confidence_anomalies",
  "complaints",
  "coach_model_disagreements",
  "latency_regressions",
  "device_specific_problems",
  "abstention_increases",
  "envelope_regressions",
  "next_wave_recommendations",
] as const;
export type HealthSectionId = (typeof HEALTH_SECTION_IDS)[number];

export interface HealthReviewSection {
  id: HealthSectionId;
  title: string;
  status: SectionStatus;
  /** Honest, human-readable findings; empty only when status is NO_DATA/BLOCKED_EXTERNAL. */
  findings: string[];
  /** Repo-relative POSIX paths of the artifacts the findings were read from. */
  evidence: string[];
}

export interface HealthReview {
  reviewVersion: typeof HEALTH_REVIEW_VERSION;
  generatedAtIso: string;
  repoDescription: string;
  sections: HealthReviewSection[];
}

/* ------------------------------------------------------------------ */
/* Tolerant JSON access helpers (no `any`, no throwing on bad shapes). */
/* ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function listFilesRecursive(root: string): string[] {
  if (!existsSync(root) || !statSync(root).isDirectory()) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

/* --------------------------------------------- */
/* Inputs collected from the real repo artifacts. */
/* --------------------------------------------- */

export interface ExperimentSummaryRef {
  /** Repo-relative POSIX path. */
  path: string;
  /** Wave directory name, or null for root-level experiment files. */
  wave: string | null;
  workstream: string | null;
  gate: string | null;
}

export interface CoachAgreementSnapshot {
  path: string;
  realReviewCount: number | null;
  status: string | null;
  banner: string | null;
}

export interface CalibrationView {
  name: string;
  n: number | null;
  ece10: number | null;
  aurc: number | null;
}

export interface CalibrationCertSnapshot {
  path: string;
  generatedAtIso: string | null;
  calibrationViews: CalibrationView[];
}

export interface FrozenGateSnapshot {
  path: string;
  gate: string | null;
  status: string | null;
  frozenAtIso: string | null;
}

export interface EnvelopeCertSnapshot {
  path: string;
  gate: string | null;
  measuredAt: string | null;
  thresholdsVersion: string | null;
}

export interface ConfidenceRoutingBands {
  task: string;
  nUnits: number | null;
  abstained: number | null;
}

export interface HealthReviewInputs {
  experimentSummaries: ExperimentSummaryRef[];
  modelManifestEntries: ModelManifestEntry[];
  coachAgreement: CoachAgreementSnapshot | null;
  calibrationCert: CalibrationCertSnapshot | null;
  frozenCalibrationGate: FrozenGateSnapshot | null;
  envelopeCert: EnvelopeCertSnapshot | null;
  confidenceRouting: ConfidenceRoutingBands[];
  /** Repo-relative paths of hard-slice bench artifacts, sorted. */
  hardSliceArtifacts: string[];
  /** Repo-relative paths of latency/timing bench artifacts, sorted. */
  latencyArtifacts: string[];
  /** Repo-relative paths of artifacts containing real production/user telemetry trials (none exist yet). */
  productionTelemetryArtifacts: string[];
  /** Repo-relative paths of user-complaint/feedback artifacts (none exist yet). */
  complaintArtifacts: string[];
  /** Repo-relative path of the telemetry-infrastructure summary (h07), when present. */
  telemetryInfraSummaryPath: string | null;
  /** Repo-relative path of the device harness summary, when present. */
  deviceHarnessSummaryPath: string | null;
  /** Verdict string from the device harness summary, when present. */
  deviceHarnessVerdict: string | null;
}

const SUMMARY_FILE_PATTERN = /summary.*\.json$/i;
const HARD_SLICE_PATTERN = /hard-?slice/i;
const LATENCY_PATTERN = /latency|timing/i;
const COMPLAINT_PATTERN = /complaint|user-feedback/i;

export function collectHealthReviewInputs(repoRoot: string): HealthReviewInputs {
  const experimentsRoot = join(repoRoot, "datasets", "experiments");
  const datasetsRoot = join(repoRoot, "datasets");
  const rel = (full: string): string => toPosix(relative(repoRoot, full));

  const experimentFiles = listFilesRecursive(experimentsRoot).sort();
  const experimentSummaries: ExperimentSummaryRef[] = [];
  for (const full of experimentFiles) {
    const name = full.split(sep).at(-1) ?? "";
    if (!SUMMARY_FILE_PATTERN.test(name)) continue;
    const record = asRecord(readJson(full));
    const relPath = rel(full);
    const segments = toPosix(relative(experimentsRoot, full)).split("/");
    experimentSummaries.push({
      path: relPath,
      wave: segments.length > 1 ? segments[0]! : null,
      workstream:
        asString(record?.workstream) ??
        asString(record?.workstreamId) ??
        asString(record?.experiment),
      gate: asString(record?.gate),
    });
  }

  const agreementPath = join(datasetsRoot, "coach-review", "agreement", "agreement-report.json");
  let coachAgreement: CoachAgreementSnapshot | null = null;
  const agreementRecord = asRecord(readJson(agreementPath));
  if (agreementRecord !== null) {
    coachAgreement = {
      path: rel(agreementPath),
      realReviewCount: asNumber(agreementRecord.realReviewCount),
      status: asString(agreementRecord.status),
      banner: asString(agreementRecord.banner),
    };
  }

  const certPath = join(experimentsRoot, "wave-h", "h18-cert-report.json");
  let calibrationCert: CalibrationCertSnapshot | null = null;
  const confidenceRouting: ConfidenceRoutingBands[] = [];
  const certRecord = asRecord(readJson(certPath));
  if (certRecord !== null) {
    const views: CalibrationView[] = [];
    const riskCoverage = asRecord(certRecord.riskCoverageViews);
    const calibrationList = riskCoverage?.calibration;
    if (Array.isArray(calibrationList)) {
      for (const item of calibrationList) {
        const view = asRecord(item);
        const name = asString(view?.name);
        if (view === null || name === null) continue;
        views.push({
          name,
          n: asNumber(view.n),
          ece10: asNumber(view.ece10),
          aurc: asNumber(view.aurc),
        });
      }
    }
    calibrationCert = {
      path: rel(certPath),
      generatedAtIso: asString(certRecord.generatedAtIso),
      calibrationViews: views,
    };
    const routing = asRecord(certRecord.confidenceRouting);
    if (routing !== null) {
      for (const [task, value] of Object.entries(routing)) {
        const taskRecord = asRecord(value);
        if (taskRecord === null) continue;
        const bands = asRecord(taskRecord.bands);
        let abstained: number | null = null;
        if (bands !== null) {
          for (const [band, count] of Object.entries(bands)) {
            if (/abstain/i.test(band)) abstained = (abstained ?? 0) + (asNumber(count) ?? 0);
          }
        }
        confidenceRouting.push({ task, nUnits: asNumber(taskRecord.nUnits), abstained });
      }
    }
  }

  const frozenGatePath = join(experimentsRoot, "wave-h", "h18-frozen-release-gate-g6-v1.json");
  let frozenCalibrationGate: FrozenGateSnapshot | null = null;
  const frozenRecord = asRecord(readJson(frozenGatePath));
  if (frozenRecord !== null) {
    frozenCalibrationGate = {
      path: rel(frozenGatePath),
      gate: asString(frozenRecord.gate),
      status: asString(frozenRecord.status),
      frozenAtIso: asString(frozenRecord.frozenAtIso),
    };
  }

  const envelopePath = join(experimentsRoot, "wave-h", "h17-envelope-cert-summary.json");
  let envelopeCert: EnvelopeCertSnapshot | null = null;
  const envelopeRecord = asRecord(readJson(envelopePath));
  if (envelopeRecord !== null) {
    const versions = asRecord(envelopeRecord.versions);
    envelopeCert = {
      path: rel(envelopePath),
      gate: asString(envelopeRecord.gate),
      measuredAt: asString(envelopeRecord.measuredAt),
      thresholdsVersion: asString(versions?.captureEnvelopeThresholds),
    };
  }

  const allDatasetFiles = listFilesRecursive(datasetsRoot).sort();
  const hardSliceArtifacts = allDatasetFiles.filter((f) => HARD_SLICE_PATTERN.test(f)).map(rel);
  const latencyArtifacts = allDatasetFiles.filter((f) => LATENCY_PATTERN.test(f)).map(rel);
  const complaintArtifacts = allDatasetFiles.filter((f) => COMPLAINT_PATTERN.test(f)).map(rel);
  // Real production/user telemetry trials would land via the evaluation-trial
  // ingest path (h07); no trial data files exist in the repo today.
  const productionTelemetryArtifacts = allDatasetFiles
    .filter((f) => /evaluation-trials?\//i.test(toPosix(f)))
    .map(rel);

  const deviceHarnessPath = join(experimentsRoot, "wave-g2", "h06-device-harness-summary.json");
  const deviceRecord = asRecord(readJson(deviceHarnessPath));

  const telemetryInfraPath = join(
    experimentsRoot,
    "wave-g2",
    "h07-distribution-telemetry-summary.json",
  );
  const telemetryInfraRecord = asRecord(readJson(telemetryInfraPath));

  return {
    experimentSummaries,
    modelManifestEntries: DEFAULT_MODEL_MANIFEST.entries,
    coachAgreement,
    calibrationCert,
    frozenCalibrationGate,
    envelopeCert,
    confidenceRouting,
    hardSliceArtifacts,
    latencyArtifacts,
    productionTelemetryArtifacts,
    complaintArtifacts,
    deviceHarnessSummaryPath: deviceRecord !== null ? rel(deviceHarnessPath) : null,
    deviceHarnessVerdict: asString(deviceRecord?.verdict),
    telemetryInfraSummaryPath: telemetryInfraRecord !== null ? rel(telemetryInfraPath) : null,
  };
}

/* ----------------------- */
/* Section builders (pure) */
/* ----------------------- */

function sortedWaves(summaries: ExperimentSummaryRef[]): string[] {
  return [...new Set(summaries.map((s) => s.wave).filter((w): w is string => w !== null))].sort();
}

function buildWhatChanged(inputs: HealthReviewInputs): HealthReviewSection {
  const summaries = inputs.experimentSummaries;
  if (summaries.length === 0) {
    return {
      id: "what_changed",
      title: "What changed since the last review",
      status: "NO_DATA",
      findings: ["No experiment summary artifacts exist under datasets/experiments/."],
      evidence: [],
    };
  }
  const waves = sortedWaves(summaries);
  const latestWave = waves.at(-1) ?? null;
  const latest = latestWave === null ? [] : summaries.filter((s) => s.wave === latestWave);
  const findings = [
    `${summaries.length} experiment summary artifacts across ${waves.length} waves (${waves.join(", ")}); latest wave is ${latestWave ?? "n/a"} with ${latest.length} workstream summaries.`,
    ...latest.map(
      (s) => `${latestWave}: ${s.workstream ?? s.path}${s.gate !== null ? ` — ${s.gate}` : ""}`,
    ),
  ];
  return {
    id: "what_changed",
    title: "What changed since the last review",
    status: "OK",
    findings,
    evidence: latest.map((s) => s.path),
  };
}

function buildActiveModels(inputs: HealthReviewInputs): HealthReviewSection {
  const entries = inputs.modelManifestEntries;
  if (entries.length === 0) {
    return {
      id: "active_models",
      title: "Active models",
      status: "NO_DATA",
      findings: ["The model-registry manifest has no entries."],
      evidence: ["packages/model-registry/src/defaultManifest.ts"],
    };
  }
  return {
    id: "active_models",
    title: "Active models",
    status: "OK",
    findings: entries.map(
      (e) =>
        `${e.id}@${e.version} — task=${e.task}, status=${e.deploymentStatus}, platforms=${e.supportedPlatforms.join("/")}, training dataset=${e.trainingDatasetVersion ?? "none (no trained artifact)"}`,
    ),
    evidence: ["packages/model-registry/src/defaultManifest.ts"],
  };
}

function buildDrift(inputs: HealthReviewInputs): HealthReviewSection {
  if (inputs.productionTelemetryArtifacts.length === 0) {
    return {
      id: "drift",
      title: "Input/score drift vs. previous period",
      status: "NO_DATA",
      findings: [
        inputs.telemetryInfraSummaryPath !== null
          ? "Drift requires production evaluation-trial telemetry over at least two periods. The consent-gated ingest path exists (h07 evaluation_telemetry), but zero real trials have been uploaded, so no drift measurement is possible and none is claimed."
          : "Drift requires production evaluation-trial telemetry over at least two periods; none exists and no telemetry ingest infrastructure summary was found.",
      ],
      evidence: inputs.telemetryInfraSummaryPath !== null ? [inputs.telemetryInfraSummaryPath] : [],
    };
  }
  return {
    id: "drift",
    title: "Input/score drift vs. previous period",
    status: "ATTENTION",
    findings: [
      `${inputs.productionTelemetryArtifacts.length} evaluation-trial artifacts exist; drift analysis is not yet implemented for them — review manually.`,
    ],
    evidence: inputs.productionTelemetryArtifacts,
  };
}

function buildHardSlices(inputs: HealthReviewInputs): HealthReviewSection {
  if (inputs.hardSliceArtifacts.length === 0) {
    return {
      id: "new_hard_slices",
      title: "New hard slices",
      status: "NO_DATA",
      findings: ["No hard-slice bench artifacts exist under datasets/."],
      evidence: [],
    };
  }
  const byWave = new Map<string, number>();
  for (const path of inputs.hardSliceArtifacts) {
    const wave = path.split("/")[2] ?? "(root)";
    byWave.set(wave, (byWave.get(wave) ?? 0) + 1);
  }
  const latestWave = [...byWave.keys()].sort().at(-1)!;
  return {
    id: "new_hard_slices",
    title: "New hard slices",
    status: "ATTENTION",
    findings: [
      `${inputs.hardSliceArtifacts.length} hard-slice artifacts across ${byWave.size} locations; most recent location is ${latestWave}. Hard slices remain open work: each artifact records slices where the ball/stroke pipeline underperforms the pooled benchmark.`,
    ],
    evidence: inputs.hardSliceArtifacts,
  };
}

function buildConfidenceAnomalies(inputs: HealthReviewInputs): HealthReviewSection {
  const cert = inputs.calibrationCert;
  if (cert === null || cert.calibrationViews.length === 0) {
    return {
      id: "confidence_anomalies",
      title: "Confidence anomalies (calibration)",
      status: "NO_DATA",
      findings: ["No calibration certification report exists."],
      evidence: [],
    };
  }
  const findings = cert.calibrationViews.map(
    (v) =>
      `${v.name}: n=${v.n ?? "?"}, ECE@10=${v.ece10 !== null ? v.ece10.toFixed(4) : "n/a"}, AURC=${v.aurc !== null ? v.aurc.toFixed(4) : "n/a"}`,
  );
  findings.push(
    "Single certified snapshot only — anomaly detection over time requires a second comparable calibration run, which does not exist yet.",
  );
  const evidence = [cert.path];
  const gate = inputs.frozenCalibrationGate;
  if (gate !== null) {
    findings.push(
      `Calibration thresholds are governed by the frozen gate ${gate.gate ?? gate.path} (status ${gate.status ?? "unknown"}, frozen ${gate.frozenAtIso ?? "date unknown"}); this review reports against it and never adjusts it.`,
    );
    evidence.push(gate.path);
  }
  return {
    id: "confidence_anomalies",
    title: "Confidence anomalies (calibration)",
    status: "ATTENTION",
    findings,
    evidence,
  };
}

function buildComplaints(inputs: HealthReviewInputs): HealthReviewSection {
  if (inputs.complaintArtifacts.length === 0) {
    return {
      id: "complaints",
      title: "User complaints / feedback",
      status: "NO_DATA",
      findings: [
        "No user-complaint or user-feedback artifacts exist in the repo. The product has no external users yet; nothing is claimed.",
      ],
      evidence: [],
    };
  }
  return {
    id: "complaints",
    title: "User complaints / feedback",
    status: "ATTENTION",
    findings: [`${inputs.complaintArtifacts.length} complaint/feedback artifacts found — review.`],
    evidence: inputs.complaintArtifacts,
  };
}

function buildCoachDisagreements(inputs: HealthReviewInputs): HealthReviewSection {
  const agreement = inputs.coachAgreement;
  if (agreement === null) {
    return {
      id: "coach_model_disagreements",
      title: "Coach/model disagreements",
      status: "NO_DATA",
      findings: ["No coach agreement report exists."],
      evidence: [],
    };
  }
  const reviewCount = agreement.realReviewCount ?? 0;
  if (reviewCount === 0) {
    return {
      id: "coach_model_disagreements",
      title: "Coach/model disagreements",
      status: "BLOCKED_EXTERNAL",
      findings: [
        `Zero real coach reviews exist (${agreement.status ?? "status unknown"}). Disagreement analysis is blocked on qualified external coaches; no coach labels are fabricated.`,
      ],
      evidence: [agreement.path],
    };
  }
  return {
    id: "coach_model_disagreements",
    title: "Coach/model disagreements",
    status: "ATTENTION",
    findings: [
      `${reviewCount} real coach reviews exist — inspect the agreement report for coach/model disagreement metrics.`,
    ],
    evidence: [agreement.path],
  };
}

function buildLatency(inputs: HealthReviewInputs): HealthReviewSection {
  if (inputs.latencyArtifacts.length === 0) {
    return {
      id: "latency_regressions",
      title: "Latency regressions",
      status: "NO_DATA",
      findings: ["No latency/timing bench artifacts exist under datasets/."],
      evidence: [],
    };
  }
  return {
    id: "latency_regressions",
    title: "Latency regressions",
    status: "NO_DATA",
    findings: [
      `${inputs.latencyArtifacts.length} latency/timing artifacts exist, but each is a single-run measurement of a different instrument/configuration. Regression detection needs >= 2 comparable runs of the same instrument over time; none exist, so no regression (or absence of regression) is claimed.`,
    ],
    evidence: inputs.latencyArtifacts,
  };
}

function buildDevices(inputs: HealthReviewInputs): HealthReviewSection {
  if (inputs.deviceHarnessSummaryPath === null) {
    return {
      id: "device_specific_problems",
      title: "Device-specific problems",
      status: "NO_DATA",
      findings: ["No device harness summary exists."],
      evidence: [],
    };
  }
  return {
    id: "device_specific_problems",
    title: "Device-specific problems",
    status: "BLOCKED_EXTERNAL",
    findings: [
      "No physical-device measurements exist: the iPhone trial harness is built but no devices in the required matrix have been acquired, and this CI box is Linux-only. Device-specific problems cannot be assessed and none are claimed.",
      ...(inputs.deviceHarnessVerdict !== null
        ? [`Harness verdict: ${inputs.deviceHarnessVerdict}`]
        : []),
    ],
    evidence: [inputs.deviceHarnessSummaryPath],
  };
}

function buildAbstention(inputs: HealthReviewInputs): HealthReviewSection {
  if (inputs.confidenceRouting.length === 0) {
    return {
      id: "abstention_increases",
      title: "Abstention increases",
      status: "NO_DATA",
      findings: ["No confidence-routing/abstention measurements exist."],
      evidence: [],
    };
  }
  const findings = inputs.confidenceRouting.map((r) => {
    const rate =
      r.nUnits !== null && r.nUnits > 0 && r.abstained !== null
        ? ` (${((r.abstained / r.nUnits) * 100).toFixed(1)}%)`
        : "";
    return `${r.task}: ${r.abstained ?? 0}/${r.nUnits ?? "?"} units abstained${rate} in the certified snapshot.`;
  });
  findings.push(
    "Single snapshot only — an abstention INCREASE requires a second comparable measurement over time, which does not exist; no trend is claimed.",
  );
  return {
    id: "abstention_increases",
    title: "Abstention increases",
    status: "ATTENTION",
    findings,
    evidence: inputs.calibrationCert !== null ? [inputs.calibrationCert.path] : [],
  };
}

function buildEnvelope(inputs: HealthReviewInputs): HealthReviewSection {
  const cert = inputs.envelopeCert;
  if (cert === null) {
    return {
      id: "envelope_regressions",
      title: "Capture-envelope regressions",
      status: "NO_DATA",
      findings: ["No capture-envelope certification exists."],
      evidence: [],
    };
  }
  return {
    id: "envelope_regressions",
    title: "Capture-envelope regressions",
    status: "ATTENTION",
    findings: [
      `Envelope certified once (${cert.measuredAt ?? "date unknown"}, thresholds ${cert.thresholdsVersion ?? "unknown"}): ${cert.gate ?? "gate unknown"}.`,
      "Single certification only — regression detection requires re-running the same cert against a later revision; no regression (or absence of regression) is claimed.",
    ],
    evidence: [cert.path],
  };
}

function buildRecommendations(sections: HealthReviewSection[]): HealthReviewSection {
  const findings: string[] = [];
  const evidence: string[] = [];
  const byId = new Map(sections.map((s) => [s.id, s]));
  const blockedExternal = sections.filter((s) => s.status === "BLOCKED_EXTERNAL");
  for (const section of blockedExternal) {
    findings.push(
      `Unblock "${section.title}" — this requires external input (coaches, devices, or users) that no engineering workstream can substitute.`,
    );
    evidence.push(...section.evidence);
  }
  const singleSnapshotIds: HealthSectionId[] = [
    "confidence_anomalies",
    "abstention_increases",
    "envelope_regressions",
    "latency_regressions",
  ];
  if (singleSnapshotIds.some((id) => byId.get(id)?.status !== "OK")) {
    findings.push(
      "Schedule recurring re-runs of the calibration, abstention, envelope, and latency instruments against each new revision so the next review can report real trends instead of single snapshots.",
    );
  }
  if (byId.get("new_hard_slices")?.status === "ATTENTION") {
    findings.push(
      "Keep hard-slice mining in the next wave: hard-slice artifacts exist and represent known-underperforming slices.",
    );
  }
  if (byId.get("drift")?.status === "NO_DATA") {
    findings.push(
      "Ship the fresh-user evaluation-telemetry loop to real consenting users so drift and complaint sections stop being NO_DATA.",
    );
  }
  return {
    id: "next_wave_recommendations",
    title: "Next-wave recommendations",
    status: findings.length > 0 ? "ATTENTION" : "OK",
    findings:
      findings.length > 0
        ? findings
        : ["No blocked sections and no open snapshot gaps — no recommendations generated."],
    evidence: [...new Set(evidence)],
  };
}

export function buildHealthReview(
  inputs: HealthReviewInputs,
  generatedAtIso: string,
): HealthReview {
  const sections: HealthReviewSection[] = [
    buildWhatChanged(inputs),
    buildActiveModels(inputs),
    buildDrift(inputs),
    buildHardSlices(inputs),
    buildConfidenceAnomalies(inputs),
    buildComplaints(inputs),
    buildCoachDisagreements(inputs),
    buildLatency(inputs),
    buildDevices(inputs),
    buildAbstention(inputs),
    buildEnvelope(inputs),
  ];
  sections.push(buildRecommendations(sections));
  return {
    reviewVersion: HEALTH_REVIEW_VERSION,
    generatedAtIso,
    repoDescription:
      "Pickle Sensei model-health review, generated from committed telemetry/bench/certification artifacts only. Sections without real evidence are NO_DATA or BLOCKED_EXTERNAL by design.",
    sections,
  };
}

export function renderHealthReviewMarkdown(review: HealthReview): string {
  const lines: string[] = [
    "# Model-Health Review",
    "",
    `- Version: ${review.reviewVersion}`,
    `- Generated: ${review.generatedAtIso}`,
    `- ${review.repoDescription}`,
    "",
    "| Section | Status |",
    "| --- | --- |",
    ...review.sections.map((s) => `| ${s.title} | ${s.status} |`),
    "",
  ];
  for (const section of review.sections) {
    lines.push(`## ${section.title} — ${section.status}`, "");
    for (const finding of section.findings) lines.push(`- ${finding}`);
    if (section.evidence.length > 0) {
      lines.push("", "Evidence:", "");
      for (const path of section.evidence) lines.push(`- \`${path}\``);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`.replace(/\n\n\n+/g, "\n\n");
}

/* --- */
/* CLI */
/* --- */

function main(): void {
  const generatedAtIso = process.env.HEALTH_REVIEW_NOW ?? new Date().toISOString();
  const inputs = collectHealthReviewInputs(REPO_ROOT);
  const review = buildHealthReview(inputs, generatedAtIso);
  const outDir = join(REPO_ROOT, "datasets", "reports", "model-health");
  mkdirSync(outDir, { recursive: true });
  const stamp = generatedAtIso.slice(0, 10);
  const jsonPath = join(outDir, `model-health-review-${stamp}.json`);
  const mdPath = join(outDir, `model-health-review-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`);
  writeFileSync(mdPath, renderHealthReviewMarkdown(review));
  console.warn(`wrote ${jsonPath}`);
  console.warn(`wrote ${mdPath}`);
}

const isMain = process.argv[1]?.endsWith("modelHealthReview.ts");
if (isMain) main();
